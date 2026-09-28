import test from "node:test";
import assert from "node:assert/strict";
import { productionPhotoFiles, publicProgressTimeline, signProductionPhotos } from "../src/production-progress.js";

test("progress history retains a custody change while stripping its internal file and signature note", () => {
  assert.deepEqual(publicProgressTimeline([
    { at: "1", state: "rider_assigned", note: "Rider accepted" },
    { at: "2", state: "picked_up", fileId: "private-signature", note: "Named person signed the handoff" },
    { at: "3", state: "picked_up", note: "delivered milestone ready", milestoneCode: "delivered" },
  ]), [
    { at: "1", state: "rider_assigned", note: "Rider assigned" },
    { at: "2", state: "picked_up", note: "Picked up from the shop" },
  ]);
});

test("photo signing respects file authorization and keeps evidence during signing outages", async () => {
  const photo = (fileId) => ({ fileId, contentType: "image/jpeg", at: "now" });
  const record = { productionProgress: { status: "photos_available", photos: [photo("allowed"), photo("denied"), photo("outage")] } };
  const signed = [];
  await signProductionPhotos(record, {
    findFile: (fileId) => ({ fileId, objectKey: fileId }),
    authorizeRead(file) { if (file.fileId === "denied") throw new Error("forbidden"); },
    async presignGet(key) {
      signed.push(key);
      if (key === "outage") throw new Error("unavailable");
      return { url: "https://private.example/signed", expiresAt: "later" };
    },
  });
  assert.deepEqual(signed, ["allowed", "outage"]);
  assert.deepEqual(record.productionProgress, { status: "photos_available", photos: [
    { ...photo("allowed"), downloadUrl: "https://private.example/signed", downloadUrlExpiresAt: "later" }, photo("outage"),
  ] });
});

test("the packing rule rejects deleted, wrong-order and non-production files", () => {
  const base = { fileId: "photo", ownerId: "shop", state: "ready", purpose: "production_photo", detectedContentType: "image/png", objectKey: "private/key", references: [{ type: "order", id: "order" }] };
  const order = { id: "order", supplierId: "shop" };
  for (const delta of [{ state: "deleted" }, { state: "delete_pending" }, { purpose: "artwork" }, { purpose: "delivery_photo" }, { references: [{ type: "order", id: "elsewhere" }] }, { objectKey: null }]) {
    assert.deepEqual(productionPhotoFiles({ files: [{ ...base, ...delta }] }, order), []);
  }
  assert.equal(productionPhotoFiles({ files: [base] }, order).length, 1);
});
