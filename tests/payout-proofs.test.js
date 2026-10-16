import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { AttachmentError, attachFileReference, authorizeFileAttach, createPendingFile, parseMultipartStream, publicFile, resolveFileTarget } from "../src/attachments.js";
import { MAX_PROOFS_PER_MILESTONE, addStageProof, distinctProofIds, sameProofFile } from "../src/payout-proofs.js";
import { createPayoutMilestones, publicOrderFor, recordDeliveryProof } from "../src/operational-model.js";
import { productionProgressFor } from "../src/production-progress.js";

const supplier = { id: "shop", role: "supplier", verificationStatus: "approved" };
const rider = { id: "rider", role: "rider", verificationStatus: "approved" };
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

function proof(fileId, overrides = {}) {
  return { fileId, ownerId: supplier.id, purpose: "fulfilment_proof", originalFilename: "IMG_0001.jpeg",
    detectedContentType: "image/jpeg", size: 2048, state: "ready", objectKey: `fulfilment_proof/${fileId}.jpeg`,
    references: [], contentSha256: sha(fileId), ...overrides };
}

function order(overrides = {}) {
  return { id: "ord", clientId: "client", supplierId: supplier.id, riderId: rider.id, state: "production",
    payoutPlanVersion: 2, timeline: [], fulfilmentProofFileIds: [],
    payoutMilestones: createPayoutMilestones({ supplierPlatformPayoutMinor: 10000 }, { version: 2 }), ...overrides };
}

const stage = (record, code) => record.payoutMilestones.find((item) => item.code === code);

test("uploads are hashed as they stream, and the hash never leaves the server", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const boundary = "proof-boundary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nfulfilment_proof\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="IMG_0001.jpeg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const tempDir = path.join(process.cwd(), ".tmp", `proof-hash-${process.pid}-${Date.now()}`);
  const chunks = [];
  for (let offset = 0; offset < body.length; offset += 5) chunks.push(body.subarray(offset, offset + 5));
  const parsed = await parseMultipartStream(Readable.from(chunks), `multipart/form-data; boundary=${boundary}`, { tempDir });
  try {
    assert.equal(parsed.file.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
    const pending = createPendingFile({ fileId: "file_a", objectKey: "k", user: supplier, purpose: "fulfilment_proof",
      file: parsed.file, detectedContentType: "image/jpeg", at: "2026-10-16T00:00:00.000Z" });
    assert.equal(pending.contentSha256, parsed.file.sha256);
    assert.equal("contentSha256" in publicFile(pending, supplier), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("the same picture is the same proof; a different picture never is, whatever its name", () => {
  // Hashed: only the bytes decide.
  assert.equal(sameProofFile(proof("a"), proof("b", { contentSha256: sha("a") })), true);
  assert.equal(sameProofFile(proof("a"), proof("b")), false, "same name and size, different bytes");
  assert.equal(sameProofFile(proof("a"), proof("b", { contentSha256: sha("a"), ownerId: rider.id })), true, "anyone's copy of the picture");
  // Stored before hashing: the uploader's own name, size and type.
  const old = (fileId, overrides) => proof(fileId, { contentSha256: undefined, ...overrides });
  assert.equal(sameProofFile(old("a"), old("b")), true);
  assert.equal(sameProofFile(old("a"), proof("b")), true, "one side unhashed falls back to what was sent");
  assert.equal(sameProofFile(old("a"), old("b", { size: 2049 })), false);
  assert.equal(sameProofFile(old("a"), old("b", { originalFilename: "IMG_0002.jpeg" })), false);
  assert.equal(sameProofFile(old("a"), old("b", { ownerId: rider.id })), false);
  assert.equal(sameProofFile(old("a"), old("b", { detectedContentType: "image/png" })), false);
  assert.equal(sameProofFile(old("a", { originalFilename: "" }), old("b", { originalFilename: "" })), false);
  assert.equal(sameProofFile(proof("a"), null), false);
});

test("a stage's ids keep their order, one per picture, and unknown ids by id alone", () => {
  const files = [proof("a"), proof("b"), proof("c", { contentSha256: sha("a") }), proof("d")];
  assert.deepEqual(distinctProofIds(["a", "b", "c", "a", "d", "gone", "gone"], files), ["a", "b", "d", "gone"]);
  assert.deepEqual(distinctProofIds(["c", "a"], files), ["c"], "the first upload represents the picture");
  assert.deepEqual(distinctProofIds(["a"], []), ["a"]);
  assert.deepEqual(distinctProofIds(undefined, files), []);

  const milestone = { pofFileIds: [] };
  assert.equal(addStageProof(milestone, "a", files), true);
  assert.equal(addStageProof(milestone, "a", files), false);
  assert.equal(addStageProof(milestone, "c", files), false);
  assert.equal(addStageProof(milestone, "b", files), true);
  assert.equal(addStageProof(milestone, "gone", files), true);
  assert.deepEqual(milestone.pofFileIds, ["a", "b", "gone"]);
});

test("a deleted copy never stands in for a copy of the same picture still stored", () => {
  const files = [proof("a", { state: "deleted", objectKey: null }), proof("b"), proof("a_again", { contentSha256: sha("a") })];
  // The picture keeps its first place in the list, shown by the copy a screen can open.
  assert.deepEqual(distinctProofIds(["a", "b", "a_again"], files), ["a_again", "b"]);
  const milestone = { pofFileIds: ["a", "b"] };
  assert.equal(addStageProof(milestone, "a_again", files), true);
  assert.deepEqual(milestone.pofFileIds, ["a", "b", "a_again"]);
  assert.equal(addStageProof(milestone, "a_again", files), false);
});

test("the rider's delivery photo is the delivered proof only when it is a different picture", () => {
  const capture = { ...proof("rider_proof", { ownerId: rider.id }), contentSha256: sha("door") };
  const photo = { ...capture, fileId: "rider_photo", purpose: "delivery_photo" };
  const files = [capture, photo];
  const record = order({ state: "out_for_delivery" });
  stage(record, "delivered").pofFileIds = ["rider_proof"];
  recordDeliveryProof(record, "rider_photo", files);
  assert.deepEqual(stage(record, "delivered").pofFileIds, ["rider_proof"]);

  const another = { ...photo, fileId: "rider_other", contentSha256: sha("another") };
  recordDeliveryProof(record, "rider_other", [...files, another]);
  assert.deepEqual(stage(record, "delivered").pofFileIds, ["rider_proof", "rider_other"]);

  // Delivery alone is still the proof, as before.
  const alone = order({ state: "out_for_delivery" });
  recordDeliveryProof(alone, "rider_photo", files);
  assert.deepEqual(stage(alone, "delivered").pofFileIds, ["rider_photo"]);
  assert.equal(stage(alone, "delivered").status, "pof_attached");
});

test(`a shop files up to ${MAX_PROOFS_PER_MILESTONE} pictures per stage; a repeat never counts and never lists twice`, () => {
  const record = order();
  const store = { orders: [record], files: [] };
  const attach = (file) => {
    store.files.push(file);
    const target = resolveFileTarget(store, file.purpose, { orderId: "ord", milestoneCode: "production_started" });
    authorizeFileAttach(supplier, file, target, store);
    attachFileReference(file, target, store);
  };
  for (let n = 0; n < MAX_PROOFS_PER_MILESTONE; n += 1) attach(proof(`shop_${n}`));
  assert.equal(stage(record, "production_started").pofFileIds.length, MAX_PROOFS_PER_MILESTONE);
  assert.equal(stage(record, "production_started").status, "pof_attached");

  // A retried upload of a picture already filed is still accepted at the limit.
  const retry = proof("shop_retry", { contentSha256: sha("shop_7") });
  assert.doesNotThrow(() => attach(retry));
  assert.equal(stage(record, "production_started").pofFileIds.length, MAX_PROOFS_PER_MILESTONE);
  assert.equal(record.fulfilmentProofFileIds.includes("shop_retry"), true, "the upload is still the order's file");

  assert.throws(() => attach(proof("shop_over")), (error) => {
    assert.equal(error instanceof AttachmentError, true);
    assert.equal(error.status, 409);
    assert.equal(error.code, "proof_limit_reached");
    assert.deepEqual(error.details, { milestoneCode: "production_started", maxProofs: MAX_PROOFS_PER_MILESTONE });
    return true;
  });
  assert.equal(stage(record, "production_started").pofFileIds.includes("shop_over"), false);
});

test("every role that sees payout stages sees each picture once; the client gallery shows each once", () => {
  const files = [
    proof("shop_a", { references: [{ type: "order", id: "ord", milestoneCode: "production_started" }] }),
    proof("shop_b", { references: [{ type: "order", id: "ord", milestoneCode: "production_started" }] }),
    proof("shop_a_again", { contentSha256: sha("shop_a"), references: [{ type: "order", id: "ord", milestoneCode: "production_started" }] }),
  ];
  const record = order();
  stage(record, "production_started").pofFileIds = ["shop_a", "shop_b", "shop_a_again"];
  const store = { orders: [record], files, users: [] };
  for (const user of [supplier, { id: "ops", role: "ops_admin" }, { id: "super", role: "super_admin" }]) {
    assert.deepEqual(stage(publicOrderFor(record, user, store), "production_started").pofFileIds, ["shop_a", "shop_b"], user.role);
  }
  for (const user of [{ id: "client", role: "client" }, rider]) {
    assert.equal(publicOrderFor(record, user, store).payoutMilestones, undefined, user.role);
  }
  assert.deepEqual(productionProgressFor(store, record).photos.map((photo) => photo.fileId), ["shop_a", "shop_b"]);
});
