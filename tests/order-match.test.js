import test from "node:test";
import assert from "node:assert/strict";

import {
  MatchError,
  matchShop,
  multiplyMinor,
  validatePreferenceRanking,
} from "../src/order-match.js";

const AT = "2026-08-24T00:00:00.000Z";

function addShop(store, {
  id,
  lat,
  lng,
  turnaroundHours,
  description = "Complete listing description",
  prepSteps = 1,
  openJobs = 0,
  closed = false,
  subcategories = ["flyers"],
}) {
  store.users.push({ id, role: "supplier", email: `${id}@gridgo.test` });
  store.userRoleMemberships.push({ userId: id, role: "supplier" });
  store.approvalCases.push({ id: `case_${id}`, userId: id, kind: "supplier", status: "approved" });
  store.supplierProfiles.push({
    userId: id,
    shopName: `${id} Printshop`,
    contactName: id,
    shop: { lat, lng, label: `${id} Davao` },
    pickupAvailable: true,
    isClosed: closed,
  });
  const serviceId = `service_${id}`;
  store.supplierServices.push({
    id: serviceId,
    supplierId: id,
    categoryCode: "marketing_collateral",
    state: "live",
    pricingBasis: "per_unit",
    standardTurnaroundHours: turnaroundHours,
    turnaroundHours,
    version: 1,
  });
  store.supplierServiceFileFormats.push({ supplierServiceId: serviceId, formatCode: "pdf" });
  for (const [index, subcategoryCode] of subcategories.entries()) {
    const itemId = `item_${id}_${subcategoryCode}`;
    store.catalogItems.push({
      id: itemId,
      supplierId: id,
      supplierServiceId: serviceId,
      subcategoryCode,
      name: `${id} ${subcategoryCode}`,
      description,
      basePriceMinor: 10_000 + index,
      pricingUnit: "per_unit",
      turnaroundMode: "inherit",
      fileFormatMode: "inherit",
      active: true,
      sortOrder: index,
      version: 1,
    });
    const fileId = `photo_${itemId}`;
    store.files.push({ fileId, ownerId: id, purpose: "catalog_item_photo", state: "ready", objectKey: `${id}/${itemId}.jpg` });
    store.catalogItemPhotos.push({ catalogItemId: itemId, fileId, sortOrder: 0 });
    for (let step = 0; step < prepSteps; step += 1) {
      store.catalogPrepSteps.push({ id: `step_${itemId}_${step}`, catalogItemId: itemId, sortOrder: step, title: `Step ${step}`, body: "Prepare artwork" });
    }
  }
  for (let index = 0; index < openJobs; index += 1) {
    store.orderJobs.push({
      id: `job_${id}_${index}`,
      supplierId: id,
      state: "production",
      estimatedHours: turnaroundHours,
      createdAt: AT,
    });
  }
}

function fixture() {
  return {
    taxonomy: {
      categories: [{ code: "marketing_collateral", active: true }],
      categoryAliases: [],
      subcategories: [{ code: "flyers", categoryCode: "marketing_collateral", active: true }],
    },
    users: [],
    userRoleMemberships: [],
    approvalCases: [],
    supplierProfiles: [],
    supplierServices: [],
    supplierServiceFileFormats: [],
    acceptedFileFormats: [{ code: "pdf", displayName: "PDF", inputKind: "file", active: true }],
    catalogItems: [],
    catalogItemFileFormats: [],
    catalogItemPhotos: [],
    catalogOptionGroups: [],
    catalogOptions: [],
    catalogPrepSteps: [],
    files: [],
    orderJobs: [],
  };
}

test("preference ranking accepts only a complete quality-speed-distance permutation", () => {
  assert.deepEqual(validatePreferenceRanking(["distance", "quality", "speed"]), ["distance", "quality", "speed"]);
  for (const value of [
    ["quality", "speed"],
    ["quality", "quality", "distance"],
    ["quality", "speed", "price"],
    "quality,speed,distance",
  ]) {
    assert.throws(
      () => validatePreferenceRanking(value),
      (error) => error instanceof MatchError && error.code === "invalid_preference_ranking",
    );
  }
});

test("minor-unit multiplication stays integer-safe without materializing quantity-sized arrays", () => {
  assert.equal(multiplyMinor(12_500, 400, "lineSubtotalMinor"), 5_000_000);
  assert.throws(
    () => multiplyMinor(Number.MAX_SAFE_INTEGER, 2, "lineSubtotalMinor"),
    (error) => error instanceof MatchError && error.code === "invalid_money",
  );
});

test("matching applies 50/30/20 ranked weights and reports queue and alternatives", () => {
  const store = fixture();
  addShop(store, { id: "supplier_quality", lat: 7.08, lng: 125.62, turnaroundHours: 36, prepSteps: 3 });
  addShop(store, { id: "supplier_speed", lat: 7.15, lng: 125.65, turnaroundHours: 6, openJobs: 2, description: "", prepSteps: 0 });
  addShop(store, { id: "supplier_distance", lat: 7.12, lng: 125.66, turnaroundHours: 24, description: "", prepSteps: 0 });
  addShop(store, { id: "supplier_closed", lat: 7.0701, lng: 125.6101, turnaroundHours: 1, prepSteps: 4, closed: true });

  const result = matchShop(store, {
    subcategoryCode: "flyers",
    ranking: ["quality", "speed", "distance"],
    dropoff: { lat: 7.07, lng: 125.61, label: "Client" },
  });

  assert.equal(result.shop.supplierId, "supplier_quality");
  assert.equal(result.alternativesCount, 2);
  assert.deepEqual(result.queue, { jobsAhead: 0, estimatedHours: 36 });
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].subcategoryCode, "flyers");
  assert.ok(result.reasons.some((reason) => reason.factor === "quality" && reason.rank === 1));
  assert.equal(result.score.weights.quality, 0.5);
  assert.equal(result.score.weights.speed, 0.3);
  assert.equal(result.score.weights.distance, 0.2);
});

test("distance-first matching requires a drop-off and ties break on shop id", () => {
  const store = fixture();
  addShop(store, { id: "supplier_b", lat: 7.08, lng: 125.62, turnaroundHours: 12 });
  addShop(store, { id: "supplier_a", lat: 7.08, lng: 125.62, turnaroundHours: 12 });

  assert.throws(
    () => matchShop(store, { subcategoryCode: "flyers", ranking: ["distance", "quality", "speed"] }),
    (error) => error instanceof MatchError && error.code === "dropoff_required",
  );
  const result = matchShop(store, {
    subcategoryCode: "flyers",
    ranking: ["distance", "quality", "speed"],
    dropoff: { lat: 7.07, lng: 125.61, label: "Client" },
  });
  assert.equal(result.shop.supplierId, "supplier_a");
});

test("matching scores only the requested subcategory and skips shops with no public listing for it", () => {
  const store = fixture();
  addShop(store, { id: "supplier_other", lat: 7.08, lng: 125.62, turnaroundHours: 4, subcategories: ["brochures"] });
  addShop(store, { id: "supplier_flyers", lat: 7.12, lng: 125.66, turnaroundHours: 24, subcategories: ["flyers"] });
  for (let index = 0; index < 24; index += 1) {
    addShop(store, {
      id: `supplier_extra_${String(index).padStart(2, "0")}`,
      lat: 7.2 + index * 0.01,
      lng: 125.7,
      turnaroundHours: 48,
      description: "",
      prepSteps: 0,
      subcategories: ["stickers"],
    });
  }

  const result = matchShop(store, {
    subcategoryCode: "flyers",
    ranking: ["speed", "quality", "distance"],
    dropoff: { lat: 7.07, lng: 125.61, label: "Client" },
  });

  assert.equal(result.shop.supplierId, "supplier_flyers");
  assert.equal(result.alternativesCount, 0);
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].subcategoryCode, "flyers");
  assert.deepEqual(result.shop.services, []);
});

test("same-shop bundling wins when the cart shop has a public listing in the requested subcategory", () => {
  const store = fixture();
  addShop(store, { id: "supplier_existing", lat: 7.20, lng: 125.70, turnaroundHours: 72, description: "", prepSteps: 0 });
  addShop(store, { id: "supplier_best", lat: 7.071, lng: 125.611, turnaroundHours: 4, prepSteps: 3 });

  const result = matchShop(store, {
    subcategoryCode: "flyers",
    ranking: ["speed", "quality", "distance"],
    dropoff: { lat: 7.07, lng: 125.61, label: "Client" },
    preferredSupplierId: "supplier_existing",
  });

  assert.equal(result.shop.supplierId, "supplier_existing");
  assert.ok(result.reasons.some((reason) => reason.code === "same_shop_bundle"));
  assert.equal(result.alternativesCount, 1);
});
