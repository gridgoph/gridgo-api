import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import {
  AttachmentError,
  MAX_FILE_SIZE,
  attachFileReference,
  attachRiderDocument,
  authorizeFileAttach,
  authorizeFileRead,
  authorizeFileUpload,
  createPendingFile,
  invalidateRiderDocumentsForFile,
  markFileDeleted,
  markFileDeletePending,
  markFileReady,
  parseMultipartStream,
  publicFile,
  resolveFileTarget,
  validateUpload,
  RIDER_DOCUMENT_TYPES,
  VERIFICATION_DOCUMENT_TYPES,
} from "../src/attachments.js";
import { resolveAuthorizationContext, selectActorRole } from "../src/authorization-context.js";

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
const supplier = { id: "supplier-a", role: "supplier", verificationStatus: "approved" };
const otherSupplier = { id: "supplier-b", role: "supplier" };
const rider = { id: "rider-a", role: "rider", verificationStatus: "approved" };
const ops = { id: "ops-a", role: "ops_admin" };
const superAdmin = { id: "super-a", role: "super_admin" };
const MANILA_YEAR = Number(new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  year: "numeric",
}).format(new Date()));
const LICENSE_EXPIRY = `${MANILA_YEAR + 2}-12-31`;
const REPLACEMENT_LICENSE_EXPIRY = `${MANILA_YEAR + 3}-12-31`;

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
    fulfilmentProofFileIds: [],
    deliveryPhotoFileIds: [],
    payoutMilestones: [
      { code: "printing", status: "pending_pof", pofFileIds: [] },
      { code: "packaging_qc", status: "pending_pof", pofFileIds: [] },
      { code: "delivered", status: "pending_pof", pofFileIds: [] },
      { code: "retention", status: "pending_pof", pofFileIds: [] },
    ],
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
    originalFilename: purpose === "fulfilment_proof" ? "pof.pdf" : "photo.jpg",
    declaredContentType: "application/octet-stream",
    detectedContentType: ["fulfilment_proof", "artwork"].includes(purpose) ? "application/pdf" : "image/jpeg",
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
    ["layout.psd", "", Buffer.from("8BPS"), "image/vnd.adobe.photoshop"],
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
  assert.doesNotThrow(() => authorizeFileUpload(client, "mockup"));
  assert.doesNotThrow(() => authorizeFileUpload(client, "payment_proof"));
  assert.equal(validateUpload({ originalFilename: "mockup.pdf", declaredContentType: "application/pdf", sniffBytes: Buffer.from("%PDF-"), size: 12 }, "mockup"), "application/pdf");
  assert.equal(validateUpload({ originalFilename: "qr.png", declaredContentType: "image/png", sniffBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), size: 12 }, "payment_proof"), "image/png");
  expectError(() => validateUpload({ originalFilename: "qr.pdf", declaredContentType: "application/pdf", sniffBytes: Buffer.from("%PDF-"), size: 12 }, "payment_proof"), 415, "purpose_media_type_not_allowed");
  expectError(() => authorizeFileUpload(supplier, "mockup"), 403, "forbidden");
  assert.doesNotThrow(() => authorizeFileUpload(supplier, "fulfilment_proof"));
  assert.doesNotThrow(() => authorizeFileUpload(rider, "fulfilment_proof"));
  assert.doesNotThrow(() => authorizeFileUpload(rider, "delivery_photo"));
  assert.doesNotThrow(() => authorizeFileUpload(supplier, "service_image"));
  assert.doesNotThrow(() => authorizeFileUpload(ops, "announcement_image"));
  assert.doesNotThrow(() => authorizeFileUpload(ops, "payment_qr"));
  assert.doesNotThrow(() => authorizeFileUpload(superAdmin, "payment_qr"));
  assert.doesNotThrow(() => authorizeFileUpload(supplier, "verification_document"));
  assert.doesNotThrow(() => authorizeFileUpload(rider, "rider_verification_document"));
  expectError(() => authorizeFileUpload(supplier, "announcement_image"), 403, "forbidden");
  expectError(() => authorizeFileUpload(client, "payment_qr"), 403, "forbidden");
  expectError(() => authorizeFileUpload(supplier, "payment_qr"), 403, "forbidden");
  expectError(() => resolveFileTarget({}, "announcement_image", { orderId: "ord_1" }, ops), 400, "announcement_image_not_attachable");
  expectError(() => resolveFileTarget({}, "payment_qr", { orderId: "ord_1" }, ops), 400, "payment_qr_not_attachable");
  assert.doesNotThrow(() => authorizeFileUpload(supplier, "supplier_payout_qr"));
  expectError(() => authorizeFileUpload(ops, "supplier_payout_qr"), 403, "forbidden");
  expectError(() => authorizeFileUpload(client, "supplier_payout_qr"), 403, "forbidden");
  expectError(() => authorizeFileUpload(rider, "supplier_payout_qr"), 403, "forbidden");
  expectError(() => resolveFileTarget({}, "supplier_payout_qr", {}, supplier), 400, "supplier_payout_qr_not_attachable");
  assert.equal(validateUpload({ originalFilename: "gcash.jpg", declaredContentType: "image/jpeg", sniffBytes: Buffer.from([0xff, 0xd8, 0xff]), size: 2 * 1024 * 1024 }, "supplier_payout_qr"), "image/jpeg");
  expectError(() => validateUpload({ originalFilename: "gcash.jpg", declaredContentType: "image/jpeg", sniffBytes: Buffer.from([0xff, 0xd8, 0xff]), size: 5 * 1024 * 1024 + 1 }, "supplier_payout_qr"), 413, "file_too_large");
  expectError(() => validateUpload({ originalFilename: "gcash.pdf", declaredContentType: "application/pdf", sniffBytes: Buffer.from("%PDF-"), size: 12 }, "supplier_payout_qr"), 415, "purpose_media_type_not_allowed");
  expectError(() => authorizeFileUpload(client, "fulfilment_proof"), 403, "forbidden");
  expectError(() => authorizeFileUpload(client, "verification_document"), 403, "forbidden");
  expectError(() => authorizeFileUpload(rider, "verification_document"), 403, "forbidden");
  expectError(() => authorizeFileUpload(supplier, "rider_verification_document"), 403, "forbidden");
  expectError(() => authorizeFileUpload(supplier, "proof"), 400, "invalid_file_purpose");
  expectError(() => validateUpload({ originalFilename: "x.pdf", declaredContentType: "application/pdf", sniffBytes: Buffer.from("%PDF-"), size: 12 }, "delivery_photo"), 415, "purpose_media_type_not_allowed");
  expectError(() => validateUpload({ originalFilename: "x.jpg", declaredContentType: "image/jpeg", sniffBytes: Buffer.from([0xff, 0xd8, 0xff]), size: 20 * 1024 * 1024 + 1 }, "service_image"), 413, "file_too_large");
  expectError(() => validateUpload({ originalFilename: "x.jpg", declaredContentType: "image/jpeg", sniffBytes: Buffer.from([0xff, 0xd8, 0xff]), size: 1024 * 1024 + 1 }, "announcement_image"), 413, "file_too_large");
  assert.equal(validateUpload({ originalFilename: "qr.jpg", declaredContentType: "image/jpeg", sniffBytes: Buffer.from([0xff, 0xd8, 0xff]), size: 2 * 1024 * 1024 }, "payment_qr"), "image/jpeg");
  expectError(() => validateUpload({ originalFilename: "qr.jpg", declaredContentType: "image/jpeg", sniffBytes: Buffer.from([0xff, 0xd8, 0xff]), size: 5 * 1024 * 1024 + 1 }, "payment_qr"), 413, "file_too_large");
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
  const file = readyFile("fulfilment_proof");
  const target = resolveFileTarget(store, file.purpose, { orderId: "order-a", milestoneCode: "printing" });
  expectError(
    () => resolveFileTarget(store, file.purpose, { orderId: "order-a", milestoneCode: "printing", supplierServiceId: "service-a" }),
    400,
    "unexpected_target_field",
  );
  assert.doesNotThrow(() => authorizeFileAttach(supplier, file, target));
  expectError(() => authorizeFileAttach(otherSupplier, file, target), 403, "forbidden");
  expectError(() => authorizeFileAttach(supplier, { ...file, state: "pending_upload" }, target), 409, "file_not_ready");
  expectError(() => authorizeFileAttach(supplier, { ...file, detectedContentType: "text/plain" }, target), 409, "file_metadata_invalid");
  expectError(
    () => authorizeFileAttach(rider, { ...file, ownerId: rider.id }, target),
    403,
    "forbidden",
  );
  assert.equal(attachFileReference(file, target), "fulfilmentProofFileIds");
  assert.deepEqual(target.record.fulfilmentProofFileIds, [file.fileId]);
  assert.deepEqual(target.record.payoutMilestones[0].pofFileIds, [file.fileId]);
  assert.equal(target.record.payoutMilestones[0].status, "pof_attached");
  assert.deepEqual(file.references, [{ type: "order", id: "order-a", field: "fulfilmentProofFileIds", milestoneCode: "printing" }]);
  expectError(() => authorizeFileAttach(supplier, file, target), 409, "file_already_attached");
});

test("all five purposes map to ID-only parent fields", () => {
  const cases = [
    [readyFile("artwork"), client, { type: "order", record: order() }, "artworkFileIds"],
    [readyFile("fulfilment_proof"), supplier, { type: "order", record: order(), milestoneCode: "packaging_qc" }, "fulfilmentProofFileIds"],
    [readyFile("delivery_photo"), rider, { type: "order", record: order({ state: "rider_assigned" }) }, "deliveryPhotoFileIds"],
    [readyFile("service_image"), supplier, { type: "supplier_service", record: service() }, "imageFileIds"],
    [
      readyFile("verification_document"),
      supplier,
      { type: "user", record: { ...supplier, verificationDocumentFileIds: [] }, documentType: "business_permit", replacedFiles: [] },
      "verificationDocumentFileIds",
    ],
  ];
  for (const [file, user, target, field] of cases) {
    authorizeFileAttach(user, file, target);
    assert.equal(attachFileReference(file, target), field);
    assert.deepEqual(target.record[field], [file.fileId]);
  }
});

test("supplier membership can attach verification documents and service images", () => {
  const member = { ...client, id: "client-supplier", verificationDocumentFileIds: [] };
  const verificationDocument = readyFile("verification_document", {
    fileId: "member-verification",
    ownerId: member.id,
  });
  const serviceImage = readyFile("service_image", {
    fileId: "member-service-image",
    ownerId: member.id,
  });
  const supplierService = service({ id: "member-service", supplierId: member.id });
  const store = {
    users: [member],
    userRoleMemberships: [
      { userId: member.id, role: "client", createdAt: "2026-08-09T00:00:00Z" },
      { userId: member.id, role: "supplier", createdAt: "2026-08-09T00:00:00Z" },
    ],
    files: [verificationDocument, serviceImage],
    supplierServices: [supplierService],
    orders: [],
  };
  resolveAuthorizationContext(store, member);

  assert.doesNotThrow(() => authorizeFileUpload(member, verificationDocument.purpose));
  const verificationTarget = resolveFileTarget(
    store,
    verificationDocument.purpose,
    { documentType: "business_permit" },
    member,
  );
  assert.doesNotThrow(() => authorizeFileAttach(member, verificationDocument, verificationTarget));
  assert.equal(attachFileReference(verificationDocument, verificationTarget), "verificationDocumentFileIds");
  assert.deepEqual(member.verificationDocumentFileIds, [verificationDocument.fileId]);

  assert.doesNotThrow(() => authorizeFileUpload(member, serviceImage.purpose));
  const serviceTarget = resolveFileTarget(
    store,
    serviceImage.purpose,
    { supplierServiceId: supplierService.id },
    member,
  );
  assert.doesNotThrow(() => authorizeFileAttach(member, serviceImage, serviceTarget));
  assert.equal(attachFileReference(serviceImage, serviceTarget), "imageFileIds");
  assert.deepEqual(supplierService.imageFileIds, [serviceImage.fileId]);
});

test("verification documents attach only to the uploader and support typed replacement", () => {
  const first = readyFile("verification_document", { fileId: "permit-old" });
  const store = {
    users: [
      { ...supplier, verificationDocumentFileIds: [] },
      { ...otherSupplier, verificationDocumentFileIds: [] },
    ],
    files: [first],
    orders: [],
    supplierServices: [],
  };
  const target = resolveFileTarget(store, first.purpose, { documentType: "business_permit" }, supplier);
  assert.doesNotThrow(() => authorizeFileAttach(supplier, first, target));
  assert.equal(attachFileReference(first, target), "verificationDocumentFileIds");
  assert.deepEqual(target.record.verificationDocumentFileIds, [first.fileId]);
  assert.equal(first.verificationDocumentType, "business_permit");

  expectError(
    () => resolveFileTarget(
      store,
      first.purpose,
      { documentType: "business_permit", userId: otherSupplier.id },
      supplier,
    ),
    400,
    "unexpected_target_field",
  );
  const otherTarget = resolveFileTarget(store, first.purpose, { documentType: "business_permit" }, otherSupplier);
  expectError(() => authorizeFileAttach(otherSupplier, first, otherTarget), 403, "forbidden");
  expectError(
    () => resolveFileTarget(store, first.purpose, { documentType: "tax_clearance" }, supplier),
    400,
    "invalid_verification_document_type",
  );
  assert.deepEqual(VERIFICATION_DOCUMENT_TYPES, ["business_permit", "valid_id", "sample_work"]);

  const replacement = readyFile("verification_document", { fileId: "permit-new" });
  store.files.push(replacement);
  const replacementTarget = resolveFileTarget(
    store,
    replacement.purpose,
    { documentType: "business_permit" },
    supplier,
  );
  assert.deepEqual(replacementTarget.replacedFiles.map(({ fileId }) => fileId), [first.fileId]);
  authorizeFileAttach(supplier, replacement, replacementTarget);
  attachFileReference(replacement, replacementTarget);
  assert.deepEqual(replacementTarget.record.verificationDocumentFileIds, [replacement.fileId]);
  assert.deepEqual(first.references, []);
  assert.deepEqual(replacement.references, [
    {
      type: "user",
      id: supplier.id,
      field: "verificationDocumentFileIds",
      documentType: "business_permit",
    },
  ]);
  expectError(() => markFileDeletePending(first, ops, "2026-08-09T00:00:00Z"), 403, "forbidden");
  assert.doesNotThrow(() => markFileDeletePending(first, supplier, "2026-08-09T00:00:00Z"));
});

test("rider licence attachment preserves evidence without submitting enrollment", () => {
  const first = readyFile("rider_verification_document", {
    fileId: "rider-license-old",
    ownerId: rider.id,
  });
  const approvalCase = {
    id: "case-rider",
    userId: rider.id,
    kind: "rider",
    status: "pending",
    version: 1,
    applicationRevision: 1,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
  const store = {
    users: [rider],
    files: [first],
    riderDocuments: [],
    approvalCases: [approvalCase],
  };
  const target = resolveFileTarget(
    store,
    first.purpose,
    { riderDocumentType: "drivers_license", expiresOn: LICENSE_EXPIRY },
    rider,
  );
  assert.doesNotThrow(() => authorizeFileAttach(rider, first, target));
  const attached = attachRiderDocument(store, first, target, {
    documentId: "rider-document-old",
    at: "2026-08-16T01:00:00.000Z",
  });
  assert.equal(attached.approvalCase.submittedAt, undefined);
  assert.equal(attached.document.expiresOn, LICENSE_EXPIRY);
  assert.deepEqual(first.references, [{
    type: "rider_document",
    id: "rider-document-old",
    field: "fileId",
  }]);
  assert.deepEqual(RIDER_DOCUMENT_TYPES, ["drivers_license", "or_cr", "selfie"]);

  const replacement = readyFile("rider_verification_document", {
    fileId: "rider-license-new",
    ownerId: rider.id,
  });
  store.files.push(replacement);
  const replacementTarget = resolveFileTarget(
    store,
    replacement.purpose,
    { riderDocumentType: "drivers_license", expiresOn: REPLACEMENT_LICENSE_EXPIRY },
    rider,
  );
  assert.deepEqual(replacementTarget.replacedDocuments.map(({ id }) => id), ["rider-document-old"]);
  const replaced = attachRiderDocument(store, replacement, replacementTarget, {
    documentId: "rider-document-new",
    at: "2027-08-16T01:00:00.000Z",
  });
  assert.equal(attached.document.isCurrent, false);
  assert.equal(attached.document.replacedAt, "2027-08-16T01:00:00.000Z");
  assert.equal(replaced.document.isCurrent, true);
  assert.equal(store.riderDocuments.length, 2);

  expectError(
    () => resolveFileTarget(
      store,
      replacement.purpose,
      { riderDocumentType: "drivers_license", expiresOn: "2020-01-01" },
      rider,
    ),
    409,
    "document_expired",
  );
  expectError(
    () => resolveFileTarget(
      store,
      replacement.purpose,
      { riderDocumentType: "passport", expiresOn: LICENSE_EXPIRY },
      rider,
    ),
    400,
    "invalid_rider_document_type",
  );
});

test("deleting rider licence evidence reverts a pending submission to intake", () => {
  const license = readyFile("rider_verification_document", { fileId: "rider-license-live", ownerId: rider.id });
  const approvalCase = {
    id: "case-rider-delete",
    userId: rider.id,
    kind: "rider",
    status: "pending",
    version: 1,
    applicationRevision: 1,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
  const store = { users: [rider], files: [license], riderDocuments: [], approvalCases: [approvalCase] };
  const target = resolveFileTarget(
    store,
    license.purpose,
    { riderDocumentType: "drivers_license", expiresOn: LICENSE_EXPIRY },
    rider,
  );
  attachRiderDocument(store, license, target, { documentId: "rider-document-live", at: "2026-08-16T01:00:00.000Z" });
  assert.equal(approvalCase.submittedAt, undefined);
  approvalCase.submittedAt = "2026-08-16T01:30:00.000Z";
  approvalCase.updatedAt = "2026-08-16T01:30:00.000Z";

  assert.doesNotThrow(() => markFileDeletePending(license, rider, "2026-08-16T02:00:00.000Z"));
  const invalidated = invalidateRiderDocumentsForFile(store, license, "2026-08-16T02:00:00.000Z");
  assert.deepEqual(invalidated.map(({ id }) => id), ["rider-document-live"]);
  assert.equal(store.riderDocuments.length, 1);
  assert.equal(store.riderDocuments[0].isCurrent, false);
  assert.equal(store.riderDocuments[0].replacedAt, "2026-08-16T02:00:00.000Z");
  assert.equal(approvalCase.submittedAt, null);

  const replacement = readyFile("rider_verification_document", { fileId: "rider-license-next", ownerId: rider.id });
  store.files.push(replacement);
  const replacementTarget = resolveFileTarget(
    store,
    replacement.purpose,
    { riderDocumentType: "drivers_license", expiresOn: REPLACEMENT_LICENSE_EXPIRY },
    rider,
  );
  attachRiderDocument(store, replacement, replacementTarget, {
    documentId: "rider-document-next",
    at: "2026-08-16T03:00:00.000Z",
  });
  assert.equal(approvalCase.submittedAt, null);

  const selfie = readyFile("rider_verification_document", { fileId: "rider-selfie", ownerId: rider.id });
  store.files.push(selfie);
  const selfieTarget = resolveFileTarget(store, selfie.purpose, { riderDocumentType: "selfie" }, rider);
  attachRiderDocument(store, selfie, selfieTarget, {
    documentId: "rider-document-selfie",
    at: "2026-08-16T04:00:00.000Z",
  });
  assert.doesNotThrow(() => markFileDeletePending(selfie, rider, "2026-08-16T05:00:00.000Z"));
  invalidateRiderDocumentsForFile(store, selfie, "2026-08-16T05:00:00.000Z");
  assert.equal(store.riderDocuments.find(({ id }) => id === "rider-document-selfie").isCurrent, false);
  assert.equal(store.riderDocuments.find(({ id }) => id === "rider-document-next").isCurrent, true);
  assert.equal(approvalCase.submittedAt, null);
});

test("verification document reads never inherit order, service, or another supplier visibility", () => {
  const file = readyFile("verification_document", {
    references: [
      { type: "user", id: supplier.id, field: "verificationDocumentFileIds", documentType: "valid_id" },
      { type: "supplier_service", id: "service-a", field: "imageFileIds" },
    ],
  });
  const store = { users: [supplier], orders: [order()], supplierServices: [service()] };
  assert.doesNotThrow(() => authorizeFileRead(supplier, store, file));
  assert.doesNotThrow(() => authorizeFileRead(ops, store, file));
  assert.doesNotThrow(() => authorizeFileRead(superAdmin, store, file));
  expectError(() => authorizeFileRead(otherSupplier, store, file), 403, "forbidden");
  expectError(() => authorizeFileRead(client, store, file), 403, "forbidden");
  expectError(() => authorizeFileRead(rider, store, file), 403, "forbidden");
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

test("a matched job shop can read the client's attached mockup", () => {
  const matchedOrder = order({ id: "order-match", supplierId: null, riderId: null });
  const store = {
    orders: [matchedOrder],
    orderJobs: [{ id: "job-match", orderId: matchedOrder.id, supplierId: supplier.id, riderId: null }],
    supplierServices: [],
  };
  const file = readyFile("mockup", {
    ownerId: client.id,
    references: [{ type: "order", id: matchedOrder.id, field: "line:one:mockup" }],
  });
  assert.doesNotThrow(() => authorizeFileRead(supplier, store, file));
  expectError(() => authorizeFileRead(otherSupplier, store, file), 403, "forbidden");
});

test("referenced evidence cannot be deleted", () => {
  expectError(() => markFileDeletePending(readyFile("artwork", { references: [{ type: "order", id: "order-a" }] }), client, "2026-08-09T00:00:00Z"), 409, "file_in_use");
});

test("order files require approved work membership while verification evidence stays accessible", () => {
  for (const role of ["supplier", "rider"]) {
    for (const status of ["approved", "suspended", "pending", "rejected", null]) {
      const member = { id: `${role}-member`, role: "client" };
      const assignedOrder = order({ supplierId: member.id, riderId: member.id, state: "out_for_delivery" });
      const store = {
        users: [member], orders: [assignedOrder],
        userRoleMemberships: ["client", role].map((membershipRole) => ({ userId: member.id, role: membershipRole })),
        approvalCases: status ? [{ userId: member.id, kind: role, status }] : [],
      };
      const actor = selectActorRole(store, member, role, { restrictMemberships: true });
      const artwork = readyFile("artwork", {
        references: [{ type: "order", id: assignedOrder.id, field: "artworkFileIds" }],
      });
      const proof = readyFile("fulfilment_proof", { ownerId: member.id });
      const target = { type: "order", record: assignedOrder, milestoneCode: role === "supplier" ? "printing" : "delivered" };
      const ownAttachedProof = { ...proof, references: [{ type: "order", id: assignedOrder.id, field: "fulfilmentProofFileIds" }] };
      const workOperations = [
        () => authorizeFileRead(actor, store, artwork),
        () => authorizeFileRead(actor, store, ownAttachedProof),
        () => authorizeFileAttach(actor, proof, target),
      ];
      if (role === "rider") workOperations.push(() => authorizeFileAttach(actor,
        readyFile("delivery_photo", { ownerId: member.id }), { type: "order", record: assignedOrder }));
      for (const operation of workOperations) {
        if (status === "approved") assert.doesNotThrow(operation);
        else expectError(operation, 403, "forbidden");
      }
      assignedOrder.supplierId = null;
      assignedOrder.riderId = null;
      store.orderJobs = [{ id: "job", orderId: assignedOrder.id, supplierId: member.id, riderId: member.id }];
      if (status === "approved") assert.doesNotThrow(() => authorizeFileRead(actor, store, artwork));
      else expectError(() => authorizeFileRead(actor, store, artwork), 403, "forbidden");

      const verification = readyFile(role === "supplier" ? "verification_document" : "rider_verification_document", { ownerId: member.id });
      const verificationTarget = role === "supplier"
        ? { type: "user", record: member, documentType: "valid_id" }
        : { type: "rider_document", record: member, kind: "selfie" };
      assert.doesNotThrow(() => authorizeFileRead(actor, store, verification));
      assert.doesNotThrow(() => authorizeFileAttach(actor, verification, verificationTarget));
      const clientActor = selectActorRole(store, member, "client", { restrictMemberships: true });
      expectError(() => authorizeFileRead(clientActor, store, verification), 403, "forbidden");
    }
  }
});

test("approval cases override legacy approval when authorizing order files", () => {
  const member = { ...supplier };
  const store = {
    users: [member], orders: [order()],
    userRoleMemberships: [{ userId: member.id, role: "supplier" }],
    approvalCases: [{ userId: member.id, kind: "supplier", status: "suspended" }],
  };
  resolveAuthorizationContext(store, member);
  expectError(() => authorizeFileRead(member, store, readyFile("artwork", {
    references: [{ type: "order", id: "order-a", field: "artworkFileIds" }],
  })), 403, "forbidden");
  expectError(() => authorizeFileAttach(member, readyFile("fulfilment_proof"), {
    type: "order", record: store.orders[0], milestoneCode: "printing",
  }), 403, "forbidden");
});

test("delivered POF belongs to the rider and also gates retention", () => {
  const store = { orders: [order({ state: "out_for_delivery" })], supplierServices: [] };
  const file = readyFile("fulfilment_proof", { ownerId: rider.id, fileId: "file-delivered" });
  const target = resolveFileTarget(store, file.purpose, { orderId: "order-a", milestoneCode: "delivered" });
  assert.doesNotThrow(() => authorizeFileAttach(rider, file, target));
  expectError(() => authorizeFileAttach(supplier, { ...file, ownerId: supplier.id }, target), 403, "forbidden");
  attachFileReference(file, target);
  assert.deepEqual(target.record.payoutMilestones.find((item) => item.code === "delivered").pofFileIds, [file.fileId]);
  assert.deepEqual(target.record.payoutMilestones.find((item) => item.code === "retention").pofFileIds, [file.fileId]);
});


test("payment receipts stay private to their owner and Operations after order binding", () => {
  const store = { orders: [order()] };
  const receipt = readyFile("payment_proof", { ownerId: client.id, references: [{ type: "order", id: "order-a", field: "payment:final_online:proof" }] });
  for (const user of [client, ops, superAdmin]) assert.doesNotThrow(() => authorizeFileRead(user, store, receipt));
  for (const user of [supplier, rider, otherClient]) expectError(() => authorizeFileRead(user, store, receipt), 403, "forbidden");
  for (const purpose of ["artwork", "mockup"]) {
    const file = readyFile(purpose, { ownerId: client.id, references: [{ type: "order", id: "order-a", field: "line:one:artwork" }] });
    for (const user of [supplier, rider]) assert.doesNotThrow(() => authorizeFileRead(user, store, file));
  }
});
