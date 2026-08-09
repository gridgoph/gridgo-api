import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import {
  AttachmentError,
  MAX_FILE_SIZE,
  applyProofDecision,
  attachFileReference,
  authorizeFileAttach,
  authorizeFileRead,
  authorizeFileUpload,
  authorizeProofPaymentTransition,
  backfillFiles,
  createPendingFile,
  markFileDeleted,
  markFileDeletePending,
  markFileReady,
  parseMultipartStream,
  publicFile,
  recordProofUpload,
  resolveFileTarget,
  validateUpload,
} from "../src/attachments.js";

function expectError(fn, status, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof AttachmentError, true);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.match(error.message, /[A-Za-z]/);
    return true;
  });
}

async function expectErrorAsync(fn, status, code) {
  await assert.rejects(fn, (error) => {
    assert.equal(error instanceof AttachmentError, true);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

function multipart(parts, boundary = "expo-boundary-123") {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename != null) {
      const type = part.contentType == null ? "" : `Content-Type: ${part.contentType}\r\n`;
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n${type}\r\n`));
      chunks.push(part.data, Buffer.from("\r\n"));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const client = { id: "client-a", role: "client" };
const otherClient = { id: "client-b", role: "client" };
const supplier = { id: "supplier-a", role: "supplier" };
const otherSupplier = { id: "supplier-b", role: "supplier" };
const rider = { id: "rider-a", role: "rider" };
const ops = { id: "ops-a", role: "ops_admin" };

function order(overrides = {}) {
  return {
    id: "order-a",
    clientId: client.id,
    supplierId: supplier.id,
    riderId: rider.id,
    state: "supplier_accepted",
    timeline: [],
    artworkFileIds: [],
    proofFileIds: [],
    deliveryPhotoFileIds: [],
    ...overrides,
  };
}

function service(overrides = {}) {
  return { id: "service-a", supplierId: supplier.id, state: "live", imageFileIds: [], ...overrides };
}

function readyFile(purpose, overrides = {}) {
  return {
    fileId: `file-${purpose}`,
    ownerId: purpose === "artwork" ? client.id : purpose === "delivery_photo" ? rider.id : supplier.id,
    purpose,
    originalFilename: purpose === "proof" ? "proof.pdf" : "photo.jpg",
    declaredContentType: "application/octet-stream",
    detectedContentType: purpose === "proof" || purpose === "artwork" ? "application/pdf" : "image/jpeg",
    size: 123,
    state: "ready",
    objectKey: `${purpose}/2026/08/09/private-key`,
    references: [],
    ...overrides,
  };
}

test("streams Expo multipart to disk without retaining the file body", async () => {
  const binary = Buffer.from("%PDF-1.7\nstreamed");
  const request = multipart([
    { name: "purpose", value: "artwork" },
    { name: "file", filename: "layout.pdf", contentType: "application/octet-stream", data: binary },
  ]);
  const tempDir = path.join(process.cwd(), ".tmp", `stream-test-${process.pid}-${Date.now()}`);
  const chunks = [];
  for (let offset = 0; offset < request.body.length; offset += 7) chunks.push(request.body.subarray(offset, offset + 7));
  const parsed = await parseMultipartStream(Readable.from(chunks), request.contentType, { tempDir });
  assert.deepEqual(parsed.fields, { purpose: "artwork" });
  assert.equal(parsed.file.declaredContentType, "application/octet-stream");
  assert.equal(parsed.file.size, binary.length);
  assert.equal("data" in parsed.file, false);
  assert.deepEqual(await fs.readFile(parsed.file.tempPath), binary);
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("accepts an omitted iOS part MIME when extension and magic agree", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const request = multipart([{ name: "file", filename: "camera.jpg", contentType: null, data: bytes }]);
  const parsed = await parseMultipartStream(Readable.from([request.body]), request.contentType);
  assert.equal(parsed.file.declaredContentType, "");
  assert.equal(validateUpload(parsed.file, "artwork"), "image/jpeg");
  await fs.unlink(parsed.file.tempPath);
});

test("rejects non-multipart and missing file with specific errors", async () => {
  await expectErrorAsync(() => parseMultipartStream(Readable.from([Buffer.from("{}")]), "application/json"), 415, "multipart_required");
  const request = multipart([{ name: "purpose", value: "artwork" }]);
  await expectErrorAsync(() => parseMultipartStream(Readable.from([request.body]), request.contentType), 400, "file_required");
  const duplicate = multipart([
    { name: "purpose", value: "artwork" },
    { name: "purpose", value: "proof" },
    { name: "file", filename: "x.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-") },
  ]);
  await expectErrorAsync(() => parseMultipartStream(Readable.from([duplicate.body]), duplicate.contentType), 400, "invalid_multipart");
  const unexpected = multipart([
    { name: "purpose", value: "artwork" },
    { name: "orderId", value: "must-not-be-uploaded-here" },
    { name: "file", filename: "x.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-") },
  ]);
  await expectErrorAsync(
    () => parseMultipartStream(Readable.from([unexpected.body]), unexpected.contentType),
    400,
    "unexpected_form_field",
  );
});

test("sniffs supported signatures and tolerates only empty/generic declared MIME", () => {
  const cases = [
    ["photo.jpg", "", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    ["photo.png", "application/octet-stream", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    ["photo.webp", "", Buffer.from("RIFFxxxxWEBP"), "image/webp"],
    ["artwork.pdf", "application/pdf", Buffer.from("%PDF-1.7"), "application/pdf"],
  ];
  for (const [originalFilename, declaredContentType, sniffBytes, expected] of cases) {
    assert.equal(validateUpload({ originalFilename, declaredContentType, sniffBytes, size: 12 }, "artwork"), expected);
  }
});

test("rejects declared type, signature mismatch, HEIC, empty, and oversize specifically", () => {
  expectError(() => validateUpload({ originalFilename: "x.pdf", declaredContentType: "text/plain", sniffBytes: Buffer.from("%PDF-"), size: 12 }), 415, "content_type_not_allowed");
  expectError(() => validateUpload({ originalFilename: "x.jpg", declaredContentType: "image/jpeg", sniffBytes: Buffer.from("%PDF-"), size: 12 }), 415, "file_type_mismatch");
  const heic = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic"), Buffer.alloc(8)]);
  expectError(() => validateUpload({ originalFilename: "x.heic", declaredContentType: "image/heic", sniffBytes: heic, size: 20 }), 415, "heic_not_supported");
  expectError(() => validateUpload({ originalFilename: "x.pdf", declaredContentType: "application/pdf", sniffBytes: Buffer.alloc(0), size: 0 }), 400, "file_empty");
  expectError(() => validateUpload({ originalFilename: "x.pdf", declaredContentType: "application/pdf", sniffBytes: Buffer.from("%PDF-"), size: MAX_FILE_SIZE + 1 }), 413, "file_too_large");
});

test("purpose policies gate role, media family, and the 20 MiB image limit", () => {
  assert.doesNotThrow(() => authorizeFileUpload(client, "artwork"));
  assert.doesNotThrow(() => authorizeFileUpload(supplier, "proof"));
  assert.doesNotThrow(() => authorizeFileUpload(rider, "delivery_photo"));
  assert.doesNotThrow(() => authorizeFileUpload(supplier, "service_image"));
  expectError(() => authorizeFileUpload(client, "proof"), 403, "forbidden");
  expectError(() => validateUpload({ originalFilename: "x.pdf", declaredContentType: "application/pdf", sniffBytes: Buffer.from("%PDF-"), size: 12 }, "delivery_photo"), 415, "purpose_media_type_not_allowed");
  expectError(() => validateUpload({ originalFilename: "x.jpg", declaredContentType: "image/jpeg", sniffBytes: Buffer.from([0xff, 0xd8, 0xff]), size: 20 * 1024 * 1024 + 1 }, "service_image"), 413, "file_too_large");
});

test("file registry backfill is additive and byte-idempotent", () => {
  const store = { orders: [{ id: "order-a", artworkName: "legacy.pdf" }], supplierServices: [{ id: "service-a" }], claims: [{ id: "untouched" }] };
  assert.equal(backfillFiles(store), true);
  assert.deepEqual(store.files, []);
  assert.deepEqual(store.orders[0].artworkFileIds, []);
  assert.deepEqual(store.orders[0].proofFileIds, []);
  assert.deepEqual(store.orders[0].deliveryPhotoFileIds, []);
  assert.equal(store.orders[0].artworkName, "legacy.pdf");
  assert.deepEqual(store.supplierServices[0].imageFileIds, []);
  assert.deepEqual(store.claims, [{ id: "untouched" }]);
  const once = JSON.stringify(store);
  assert.equal(backfillFiles(store), false);
  assert.equal(JSON.stringify(store), once);
});

test("pending -> ready -> delete_pending -> deleted never exposes objectKey", () => {
  const file = createPendingFile({ fileId: "file-a", objectKey: "artwork/private", user: client, purpose: "artwork", file: { originalFilename: "layout.pdf", declaredContentType: "application/octet-stream", size: 42 }, detectedContentType: "application/pdf", at: "2026-08-09T00:00:00Z" });
  assert.equal(file.state, "pending_upload");
  assert.equal("objectKey" in publicFile(file), false);
  markFileReady(file, "2026-08-09T00:01:00Z");
  markFileDeletePending(file, client, "2026-08-09T00:02:00Z");
  markFileDeleted(file, "2026-08-09T00:03:00Z");
  assert.equal(file.state, "deleted");
  assert.equal(file.objectKey, null);
});

test("resolve and attach revalidate owner, ready state, media, target ownership, and state", () => {
  const store = { orders: [order()], supplierServices: [service()] };
  const file = readyFile("proof");
  const target = resolveFileTarget(store, file.purpose, { orderId: "order-a" });
  expectError(
    () => resolveFileTarget(store, file.purpose, { orderId: "order-a", supplierServiceId: "service-a" }),
    400,
    "unexpected_target_field",
  );
  assert.doesNotThrow(() => authorizeFileAttach(supplier, file, target));
  expectError(() => authorizeFileAttach(otherSupplier, file, target), 403, "forbidden");
  expectError(() => authorizeFileAttach(supplier, { ...file, state: "pending_upload" }, target), 409, "file_not_ready");
  expectError(() => authorizeFileAttach(supplier, { ...file, detectedContentType: "text/plain" }, target), 409, "file_metadata_invalid");
  expectError(() => authorizeFileAttach(supplier, file, { type: "order", record: order({ state: "production" }) }), 409, "proof_upload_not_allowed");
  assert.equal(attachFileReference(file, target), "proofFileIds");
  assert.deepEqual(target.record.proofFileIds, [file.fileId]);
  assert.deepEqual(file.references, [{ type: "order", id: "order-a", field: "proofFileIds" }]);
  expectError(() => authorizeFileAttach(supplier, file, target), 409, "file_already_attached");
});

test("all four purposes map to ID-only parent fields", () => {
  const cases = [
    [readyFile("artwork"), client, { type: "order", record: order() }, "artworkFileIds"],
    [readyFile("proof"), supplier, { type: "order", record: order() }, "proofFileIds"],
    [readyFile("delivery_photo"), rider, { type: "order", record: order({ state: "rider_assigned" }) }, "deliveryPhotoFileIds"],
    [readyFile("service_image"), supplier, { type: "supplier_service", record: service() }, "imageFileIds"],
  ];
  for (const [file, user, target, field] of cases) {
    authorizeFileAttach(user, file, target);
    assert.equal(attachFileReference(file, target), field);
    assert.deepEqual(target.record[field], [file.fileId]);
  }
});

test("reads require owner, operations, domain relationship, or live service visibility", () => {
  const store = { orders: [order()], supplierServices: [service()] };
  const file = readyFile("artwork", { references: [{ type: "order", id: "order-a", field: "artworkFileIds" }] });
  assert.doesNotThrow(() => authorizeFileRead(client, store, file));
  assert.doesNotThrow(() => authorizeFileRead(supplier, store, file));
  assert.doesNotThrow(() => authorizeFileRead(ops, store, file));
  expectError(() => authorizeFileRead(otherClient, store, file), 403, "forbidden");
  const image = readyFile("service_image", { references: [{ type: "supplier_service", id: "service-a", field: "imageFileIds" }] });
  assert.doesNotThrow(() => authorizeFileRead(otherClient, store, image));
});

test("referenced evidence cannot be deleted", () => {
  expectError(() => markFileDeletePending(readyFile("artwork", { references: [{ type: "order", id: "order-a" }] }), client, "2026-08-09T00:00:00Z"), 409, "file_in_use");
});

test("supplier proof submit, changes, correction, and approval append timeline", () => {
  const target = order();
  recordProofUpload(target, supplier, readyFile("proof", { fileId: "file-v1", originalFilename: "proof-v1.pdf" }), "2026-08-09T01:00:00Z");
  assert.equal(target.state, "supplier_proof_review");
  assert.equal(target.timeline.at(-1).fileId, "file-v1");
  applyProofDecision(target, client, { state: "supplier_proof_changes_requested", reason: "Fix crop marks" }, "2026-08-09T01:01:00Z");
  assert.equal(target.state, "supplier_proof_changes_requested");
  recordProofUpload(target, supplier, readyFile("proof", { fileId: "file-v2", originalFilename: "proof-v2.pdf" }), "2026-08-09T01:02:00Z");
  assert.match(target.timeline.at(-1).note, /corrected proof/);
  applyProofDecision(target, client, { state: "supplier_proof_approved" }, "2026-08-09T01:03:00Z");
  assert.equal(target.state, "supplier_proof_approved");
  assert.equal(target.timeline.length, 4);
});

test("proof decisions require owning client, reason, and assigned supplier continuation", () => {
  const review = order({ state: "supplier_proof_review" });
  expectError(() => applyProofDecision(review, otherClient, { state: "supplier_proof_approved" }, "now"), 403, "forbidden");
  expectError(() => applyProofDecision(review, client, { state: "supplier_proof_changes_requested" }, "now"), 400, "reason_required");
  assert.doesNotThrow(() => authorizeProofPaymentTransition(order({ state: "supplier_proof_approved" }), supplier));
  assert.doesNotThrow(() => authorizeProofPaymentTransition(order({ state: "supplier_proof_approved" }), ops));
  expectError(() => authorizeProofPaymentTransition(order({ state: "supplier_proof_approved" }), otherSupplier), 403, "forbidden");
});
