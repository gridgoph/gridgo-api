import test from "node:test";
import assert from "node:assert/strict";

import {
  MATCH_FACTORS,
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
  priceMinor = 10_000,
  capacityDaily = null,
  schedule = null,
  reviews = [],
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
    ...(schedule ? { schedule } : {}),
  });
  for (const [index, qualityStars] of reviews.entries()) {
    store.shopReviews.push({ id: `rev_${id}_${index}`, supplierId: id, qualityStars, createdAt: AT });
  }
  const serviceId = `service_${id}`;
  store.supplierServices.push({
    id: serviceId,
    supplierId: id,
    categoryCode: "marketing_collateral",
    state: "live",
    pricingBasis: "per_unit",
    standardTurnaroundHours: turnaroundHours,
    turnaroundHours,
    ...(capacityDaily ? { capacityDaily } : {}),
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
      basePriceMinor: priceMinor + index,
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
    orders: [],
    shopReviews: [],
    settings: { promiseAllowanceMinutes: 0 },
  };
}

test("preference ranking accepts only a complete quality-speed-cost-distance permutation", () => {
  assert.deepEqual(validatePreferenceRanking(["distance", "quality", "cost", "speed"]), ["distance", "quality", "cost", "speed"]);
  for (const value of [
    ["quality", "speed"],
    ["quality", "speed", "distance"],
    ["quality", "quality", "cost", "distance"],
    ["quality", "speed", "cost", "price"],
    "quality,speed,cost,distance",
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

/**
 * Four shops identical but for one factor each. Ranking a factor first has to
 * decide the winner when the others are level -- which is the only claim the
 * ranking screen makes, and the only one the weights can honestly support.
 */
function fourWayStore() {
  const store = fixture();
  const far = { lat: 7.30, lng: 125.90 };
  addShop(store, { id: "shop_quality", ...far, turnaroundHours: 24, priceMinor: 90_000, prepSteps: 3 });
  addShop(store, { id: "shop_speed", ...far, turnaroundHours: 24, priceMinor: 90_000, description: "", prepSteps: 0 });
  addShop(store, { id: "shop_cost", ...far, turnaroundHours: 24, priceMinor: 90_000, description: "", prepSteps: 0 });
  addShop(store, { id: "shop_distance", ...far, turnaroundHours: 24, priceMinor: 90_000, description: "", prepSteps: 0 });
  return store;
}

const DROPOFF = { lat: 7.07, lng: 125.61, label: "Client" };

test("the first-ranked factor decides when the others are level", () => {
  for (const [winner, mutate] of [
    ["shop_quality", () => {}],
    ["shop_speed", (store) => {
      const service = store.supplierServices.find((row) => row.supplierId === "shop_speed");
      service.turnaroundHours = 2;
      service.standardTurnaroundHours = 2; // what an inheriting listing actually reads
    }],
    ["shop_cost", (store) => {
      store.catalogItems.find((row) => row.supplierId === "shop_cost").basePriceMinor = 1_000;
    }],
    ["shop_distance", (store) => {
      store.supplierProfiles.find((row) => row.userId === "shop_distance").shop = { lat: 7.0701, lng: 125.6101, label: "near" };
    }],
  ]) {
    const factor = winner.replace("shop_", "");
    const store = fourWayStore();
    mutate(store);
    const ranking = [factor, ...MATCH_FACTORS.filter((entry) => entry !== factor)];
    const result = matchShop(store, { now: AT, subcategoryCode: "flyers", ranking, dropoff: DROPOFF });
    assert.equal(result.shop.supplierId, winner, `${factor} ranked first should pick ${winner}`);
    assert.equal(result.score.weights[factor], 0.4);
    assert.ok(result.reasons.some((reason) => reason.factor === factor && reason.rank === 1));
  }
});

test("matching applies 40/30/20/10 ranked weights and reports queue and alternatives", () => {
  const store = fixture();
  addShop(store, { id: "supplier_quality", lat: 7.08, lng: 125.62, turnaroundHours: 36, prepSteps: 3 });
  addShop(store, { id: "supplier_speed", lat: 7.15, lng: 125.65, turnaroundHours: 6, openJobs: 2, description: "", prepSteps: 0 });
  addShop(store, { id: "supplier_distance", lat: 7.12, lng: 125.66, turnaroundHours: 24, description: "", prepSteps: 0 });
  addShop(store, { id: "supplier_closed", lat: 7.0701, lng: 125.6101, turnaroundHours: 1, prepSteps: 4, closed: true });

  const result = matchShop(store, {
    now: AT,
    subcategoryCode: "flyers",
    ranking: ["quality", "speed", "cost", "distance"],
    dropoff: DROPOFF,
  });

  assert.equal(result.alternativesCount, 2); // the closed shop is not a candidate
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].subcategoryCode, "flyers");
  assert.equal(result.queue.jobsAhead, 2); // the winner's own queue, not the fleet's
  assert.ok(result.queue.estimatedHours > 0);
  assert.equal(result.score.weights.quality, 0.4);
  assert.equal(result.score.weights.speed, 0.3);
  assert.equal(result.score.weights.cost, 0.2);
  assert.equal(result.score.weights.distance, 0.1);
  // Ranking a factor first weights it most; it does not make it a veto. A shop
  // six times faster still beats a small edge in listing completeness.
  assert.equal(result.shop.supplierId, "supplier_speed");
});

test("distance-first matching requires a drop-off and ties break on shop id", () => {
  const store = fixture();
  addShop(store, { id: "supplier_b", lat: 7.08, lng: 125.62, turnaroundHours: 12 });
  addShop(store, { id: "supplier_a", lat: 7.08, lng: 125.62, turnaroundHours: 12 });

  assert.throws(
    () => matchShop(store, { now: AT, subcategoryCode: "flyers", ranking: ["distance", "quality", "cost", "speed"] }),
    (error) => error instanceof MatchError && error.code === "dropoff_required",
  );
  const result = matchShop(store, {
    now: AT,
    subcategoryCode: "flyers",
    ranking: ["distance", "quality", "cost", "speed"],
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
    now: AT,
    subcategoryCode: "flyers",
    ranking: ["speed", "quality", "cost", "distance"],
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
    now: AT,
    subcategoryCode: "flyers",
    ranking: ["speed", "quality", "cost", "distance"],
    dropoff: { lat: 7.07, lng: 125.61, label: "Client" },
    preferredSupplierId: "supplier_existing",
  });

  assert.equal(result.shop.supplierId, "supplier_existing");
  assert.ok(result.reasons.some((reason) => reason.code === "same_shop_bundle"));
  assert.equal(result.alternativesCount, 1);
});

/**
 * The deadline. Filter first, then rank -- because "can you make Friday?" is
 * not a preference, and scoring it as one hands a client the best shop that
 * happens to miss their date and only admits it at checkout.
 */

const MONDAY_8AM = "2026-08-24T00:00:00.000Z"; // Davao local Monday 08:00

test("a shop that cannot make the date is not offered, rather than ranked lower", () => {
  const store = fixture();
  // Two hours of work: comfortably done Monday morning.
  addShop(store, { id: "shop_fast", lat: 7.0701, lng: 125.6101, turnaroundHours: 2, prepSteps: 3 });
  // A fortnight of work: cannot be done by Tuesday whatever the client ranks.
  addShop(store, { id: "shop_slow", lat: 7.0701, lng: 125.6101, turnaroundHours: 300, prepSteps: 3 });

  const open = matchShop(store, {
    now: MONDAY_8AM, subcategoryCode: "flyers",
    ranking: ["quality", "speed", "cost", "distance"], dropoff: DROPOFF,
  });
  assert.equal(open.alternativesCount, 1, "both shops compete when no date is given");

  const bound = matchShop(store, {
    now: MONDAY_8AM, subcategoryCode: "flyers",
    ranking: ["quality", "speed", "cost", "distance"], dropoff: DROPOFF,
    deadline: "2026-08-25T00:00:00.000Z", // Tuesday
  });
  assert.equal(bound.shop.supplierId, "shop_fast");
  assert.equal(bound.alternativesCount, 0, "the slow shop is absent, not last");
});

test("nobody making the date is a different answer from nobody printing it", () => {
  const store = fixture();
  addShop(store, { id: "shop_slow", lat: 7.0701, lng: 125.6101, turnaroundHours: 300 });

  assert.throws(
    () => matchShop(store, {
      now: MONDAY_8AM, subcategoryCode: "flyers",
      ranking: ["quality", "speed", "cost", "distance"], dropoff: DROPOFF,
      deadline: "2026-08-25T00:00:00.000Z",
    }),
    (error) => {
      assert.equal(error instanceof MatchError, true);
      assert.equal(error.code, "deadline_not_met");
      // The earliest anyone could actually do it, so the client can be offered
      // a date instead of a dead end.
      assert.ok(Date.parse(error.details.earliestAvailable) > Date.parse("2026-08-25T00:00:00.000Z"));
      assert.equal(error.details.shopsConsidered, 1);
      return true;
    },
  );

  const empty = fixture();
  assert.throws(
    () => matchShop(empty, {
      now: MONDAY_8AM, subcategoryCode: "flyers",
      ranking: ["quality", "speed", "cost", "distance"], dropoff: DROPOFF,
    }),
    (error) => error instanceof MatchError && error.code === "match_not_found",
  );
});

test("no deadline filters nobody out", () => {
  const store = fixture();
  addShop(store, { id: "shop_slow", lat: 7.0701, lng: 125.6101, turnaroundHours: 300 });
  const result = matchShop(store, {
    now: MONDAY_8AM, subcategoryCode: "flyers",
    ranking: ["quality", "speed", "cost", "distance"], dropoff: DROPOFF, deadline: null,
  });
  assert.equal(result.shop.supplierId, "shop_slow");
});

test("the client is told the padded date and the shop is held to its own", () => {
  const store = fixture();
  store.settings.promiseAllowanceMinutes = 600; // one working day
  addShop(store, { id: "shop_only", lat: 7.0701, lng: 125.6101, turnaroundHours: 2 });

  const result = matchShop(store, {
    now: MONDAY_8AM, subcategoryCode: "flyers",
    ranking: ["quality", "speed", "cost", "distance"], dropoff: DROPOFF,
  });
  assert.ok(
    Date.parse(result.promiseBy) > Date.parse(result.shopReadyBy),
    "the promise has to sit later than the date the shop agreed to",
  );

  // And the allowance is not spent before the work starts: a deadline the shop
  // could technically hit, but only by eating the whole allowance, is refused.
  assert.throws(
    () => matchShop(store, {
      now: MONDAY_8AM, subcategoryCode: "flyers",
      ranking: ["quality", "speed", "cost", "distance"], dropoff: DROPOFF,
      deadline: result.shopReadyBy,
    }),
    (error) => error instanceof MatchError && error.code === "deadline_not_met",
  );
});

test("a shop shut on the day cannot make a deadline that falls on it", () => {
  const store = fixture();
  const sundayOnly = {
    utcOffsetMinutes: 480,
    week: [{ weekday: 0, opensMinute: 480, closesMinute: 1080 }],
    closures: [],
  };
  addShop(store, { id: "shop_weekday", lat: 7.0701, lng: 125.6101, turnaroundHours: 2 });
  addShop(store, { id: "shop_sunday", lat: 7.0701, lng: 125.6101, turnaroundHours: 2, schedule: sundayOnly });

  const result = matchShop(store, {
    now: MONDAY_8AM, subcategoryCode: "flyers",
    ranking: ["speed", "quality", "cost", "distance"], dropoff: DROPOFF,
    deadline: "2026-08-25T00:00:00.000Z", // Tuesday: the Sunday shop cannot start, let alone finish
  });
  assert.equal(result.shop.supplierId, "shop_weekday");
  assert.equal(result.alternativesCount, 0);
});

test("quality comes from stars once a shop has enough of them, and from the listing before that", () => {
  const store = fixture();
  // A sparse listing with excellent reviews should beat a full listing with none.
  addShop(store, {
    id: "shop_reviewed", lat: 7.0701, lng: 125.6101, turnaroundHours: 24,
    description: "", prepSteps: 0, reviews: [5, 5, 5, 5, 5],
  });
  addShop(store, { id: "shop_complete", lat: 7.0701, lng: 125.6101, turnaroundHours: 24, prepSteps: 3 });

  const rated = matchShop(store, {
    now: MONDAY_8AM, subcategoryCode: "flyers",
    ranking: ["quality", "speed", "cost", "distance"], dropoff: DROPOFF,
  });
  assert.equal(rated.shop.supplierId, "shop_reviewed");

  // Four reviews is under the threshold, so the same shop falls back to its
  // listing -- which is sparse, and loses.
  const sparse = fixture();
  addShop(sparse, {
    id: "shop_reviewed", lat: 7.0701, lng: 125.6101, turnaroundHours: 24,
    description: "", prepSteps: 0, reviews: [5, 5, 5, 5],
  });
  addShop(sparse, { id: "shop_complete", lat: 7.0701, lng: 125.6101, turnaroundHours: 24, prepSteps: 3 });
  const unrated = matchShop(sparse, {
    now: MONDAY_8AM, subcategoryCode: "flyers",
    ranking: ["quality", "speed", "cost", "distance"], dropoff: DROPOFF,
  });
  assert.equal(unrated.shop.supplierId, "shop_complete");
});
