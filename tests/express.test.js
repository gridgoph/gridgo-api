import test from "node:test";
import assert from "node:assert/strict";

import { createDatabase } from "../src/database.js";
import { listOwnCatalogItems, loadStore, saveStore } from "../src/postgres-store.js";
import { defaultOperationalSettings, publicOrderFor } from "../src/operational-model.js";
import { deadlineDays, MatchError, matchShop } from "../src/order-match.js";
import { prepareArtworkCheckout, routeOrderMatch } from "../src/order-match-routes.js";
import { defaultTaxonomy } from "../src/taxonomy.js";
import { resetDatabase } from "./fixtures/reset-database.js";
import { fixture as persistedFixture } from "./fixtures/reschedule.js";

// Wednesday 09:00 in Davao. Both shops need three working days (30 hours).
const NOW = "2026-09-23T01:00:00.000Z";
// The client's calendar sends 18:00 on the chosen day.
const TODAY_18 = "2026-09-23T10:00:00.000Z";
const END_OF_TODAY = "2026-09-23T15:59:59.999Z";
const RANKING = ["speed", "quality", "cost", "distance"];

function addShop(store, supplierId, { express = false, lat = 7.064, lng = 125.6085, schedule = null, closed = false } = {}) {
  store.users.push({ id: supplierId, role: "supplier", email: `${supplierId}@gridgo.test` });
  store.userRoleMemberships.push({ userId: supplierId, role: "supplier" });
  store.approvalCases.push({ id: `case_${supplierId}`, userId: supplierId, kind: "supplier", status: "approved" });
  store.supplierProfiles.push({ userId: supplierId, shopName: `${supplierId} Shop`, contactName: supplierId,
    shop: { lat, lng, label: `${supplierId} Davao` }, pickupAvailable: true, isClosed: closed, ...(schedule ? { schedule } : {}) });
  const serviceId = `service_${supplierId}`;
  store.supplierServices.push({ id: serviceId, supplierId, categoryCode: "marketing_collateral", state: "live",
    pricingBasis: "per_unit", referenceRateMinor: 10_000, turnaroundHours: 30, standardTurnaroundHours: 30, version: 1 });
  store.supplierServiceFileFormats.push({ supplierServiceId: serviceId, formatCode: "pdf" });
  const itemId = `item_${supplierId}`;
  store.catalogItems.push({ id: itemId, supplierId, supplierServiceId: serviceId, subcategoryCode: "flyers",
    name: `${supplierId} Flyers`, description: "Full-color flyers", basePriceMinor: 10_000, pricingUnit: "per_unit",
    turnaroundMode: "inherit", fileFormatMode: "inherit", active: true, sortOrder: 0, version: 1, express });
  store.files.push({ fileId: `photo_${itemId}`, ownerId: supplierId, purpose: "catalog_item_photo", state: "ready", objectKey: `${supplierId}/flyers.jpg` });
  store.catalogItemPhotos.push({ catalogItemId: itemId, fileId: `photo_${itemId}`, sortOrder: 0 });
  return store.catalogItems.at(-1);
}

function fixture({ express = false } = {}) {
  const client = { id: "user_client", role: "client", email: "client@gridgo.test" };
  const store = {
    settings: { ...defaultOperationalSettings(), hubPickupEnabled: true, promiseAllowanceMinutes: 60 },
    taxonomy: defaultTaxonomy(),
    users: [client], userRoleMemberships: [{ userId: client.id, role: "client" }],
    clientPreferences: [], clientAddresses: [], carts: [], cartLines: [],
    supplierProfiles: [], approvalCases: [], supplierServices: [], supplierServiceFileFormats: [],
    acceptedFileFormats: [{ code: "pdf", displayName: "PDF", inputKind: "file", active: true }],
    catalogItems: [], catalogItemFileFormats: [], catalogItemPhotos: [], catalogOptionGroups: [], catalogOptions: [], catalogPrepSteps: [],
    files: [], orders: [], orderJobs: [], orderLineItems: [], orderLineItemOptions: [], jobQaChecklist: [], orderInvoices: [],
    notifications: [], auditLog: [], shopReviews: [],
  };
  // The review calendar is open all day, so only the shops' own time decides.
  delete store.settings.operatingHours;
  addShop(store, "shop_a", { express });
  addShop(store, "shop_b", { lat: 7.09, lng: 125.63 });
  store.files.push(
    { fileId: "file_art", ownerId: client.id, purpose: "artwork", detectedContentType: "application/pdf", artworkCheck: { status: "passed", checkedAt: NOW }, state: "ready", objectKey: "client/art.pdf", references: [] },
    { fileId: "file_qr", ownerId: client.id, purpose: "payment_proof", state: "ready", objectKey: "client/qr.jpg", references: [] },
  );
  return { store, client };
}

function caller(store, user, at = NOW) {
  let sequence = 0;
  return async (method, pathname, body) => {
    const req = { method };
    await prepareArtworkCheckout({ req, pathname, store, user, checker: async () => ({ ok: true }) });
    return routeOrderMatch({ req, url: new URL(`http://gridgo.test${pathname}`), store, user,
      readBody: async () => body || {}, id: (prefix) => `${prefix}_${++sequence}`, now: () => at });
  };
}

const states = (answer) => answer.days.map((day) => day.state);
const notMet = (error) => error instanceof MatchError && error.code === "deadline_not_met";

test("without Express, production time crosses out today and makes the first possible days tight", () => {
  const { store } = fixture();
  const answer = deadlineDays(store, { subcategoryCode: "flyers", now: NOW, days: 8 });
  assert.equal(answer.days[0].state, "cannot");
  assert.equal(answer.days[0].reason, "review_production_delivery_exceeds_deadline");
  assert.ok(states(answer).includes("tight"));
  assert.equal(answer.expressAvailable, false);
  assert.throws(() => matchShop(store, { subcategoryCode: "flyers", ranking: RANKING, deadline: TODAY_18, now: NOW }), notMet);
});

test("one Express listing makes today and every later day open, never tight", () => {
  const { store } = fixture({ express: true });
  const answer = deadlineDays(store, { subcategoryCode: "flyers", now: NOW, days: 8 });
  assert.deepEqual(states(answer), Array(8).fill("open"));
  assert.ok(answer.days.every((day) => day.reason === null));
  assert.equal(answer.days[0].day, "2026-09-23");
  assert.equal(answer.earliest, END_OF_TODAY);
  assert.equal(answer.expressAvailable, true);
  // Still never a count.
  for (const day of answer.days) assert.deepEqual(Object.keys(day).sort(), ["day", "reason", "state"]);
});

test("a same-day deadline matches the Express listing, ready by the requested deadline, at the same price", () => {
  const { store } = fixture({ express: true });
  const plain = matchShop(store, { subcategoryCode: "flyers", ranking: RANKING, now: NOW });
  const match = matchShop(store, { subcategoryCode: "flyers", ranking: RANKING, deadline: TODAY_18, now: NOW });
  assert.equal(match.shop.supplierId, "shop_a");
  assert.equal(match.promiseBy, TODAY_18);
  assert.equal(match.shopReadyBy, TODAY_18);
  assert.equal(match.expressPromise, true);
  assert.equal(match.listings[0].express, true);
  assert.equal(match.listings[0].expressPromise, true);
  assert.equal(match.listings[0].readyBy, TODAY_18);
  // The ordinary shop cannot make today, so it is not offered.
  assert.equal(match.otherListings.length, 0);
  // No extra charge.
  const sameListing = [...plain.listings, ...plain.otherListings].find((listing) => listing.id === "item_shop_a");
  assert.equal(match.listings[0].clientFromPriceMinor, sameListing.clientFromPriceMinor);
  assert.equal(match.listings[0].fromPriceMinor, sameListing.fromPriceMinor);
});

test("after the deadline's clock time has passed today, Express still answers with the end of today", () => {
  const { store } = fixture({ express: true });
  const evening = "2026-09-23T11:30:00.000Z"; // 19:30 in Davao, after the 18:00 the app sends.
  const answer = deadlineDays(store, { subcategoryCode: "flyers", now: evening, days: 2 });
  assert.deepEqual(states(answer), ["open", "open"]);
  const match = matchShop(store, { subcategoryCode: "flyers", ranking: RANKING, deadline: TODAY_18, now: evening });
  assert.equal(match.promiseBy, END_OF_TODAY);
  assert.equal(match.expressPromise, true);
});

test("Express never replaces an ordinary promise that already meets the deadline, or work with no deadline", () => {
  const { store } = fixture({ express: true });
  const later = matchShop(store, { subcategoryCode: "flyers", ranking: RANKING, deadline: "2026-10-10T10:00:00.000Z", now: NOW });
  const plain = matchShop(store, { subcategoryCode: "flyers", ranking: RANKING, now: NOW });
  const express = later.listings.concat(later.otherListings).find((listing) => listing.id === "item_shop_a");
  assert.equal(express.expressPromise, false);
  assert.equal(express.readyBy, plain.listings.concat(plain.otherListings).find((listing) => listing.id === "item_shop_a").readyBy);
  assert.ok(Date.parse(express.readyBy) > Date.parse(END_OF_TODAY));
  assert.equal(plain.expressPromise, false);
});

test("a deadline before today is not an Express deadline", () => {
  const { store } = fixture({ express: true });
  assert.throws(() => matchShop(store, { subcategoryCode: "flyers", ranking: RANKING, deadline: "2026-09-22T10:00:00.000Z", now: NOW }), notMet);
});

test("dated closures still hold an Express shop back; a temporary closure removes it", () => {
  const { store } = fixture({ express: true });
  const shop = store.supplierProfiles.find((row) => row.userId === "shop_a");
  shop.schedule = { utcOffsetMinutes: 480,
    week: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensMinute: 480, closesMinute: 1080 })),
    closures: [{ startDay: "2026-09-23", endDay: "2026-09-23" }] };
  const answer = deadlineDays(store, { subcategoryCode: "flyers", now: NOW, days: 3 });
  assert.equal(answer.days[0].state, "cannot");
  assert.deepEqual(states(answer).slice(1), ["open", "open"]);
  assert.throws(() => matchShop(store, { subcategoryCode: "flyers", ranking: RANKING, deadline: TODAY_18, now: NOW }), notMet);
  const tomorrow = matchShop(store, { subcategoryCode: "flyers", ranking: RANKING, deadline: "2026-09-24T10:00:00.000Z", now: NOW });
  assert.equal(tomorrow.expressPromise, true);

  shop.schedule.closures = [];
  shop.isClosed = true;
  const closed = deadlineDays(store, { subcategoryCode: "flyers", now: NOW, days: 3 });
  assert.equal(closed.expressAvailable, false);
  assert.equal(closed.days[0].state, "cannot");
});

test("opening hours and the queue do not hold an Express listing back", () => {
  const { store } = fixture({ express: true });
  // A Sunday, when the default schedule is shut, with a full queue ahead.
  const sunday = "2026-09-27T01:00:00.000Z";
  store.orderJobs.push({ id: "ahead", orderId: "ahead_order", supplierId: "shop_a", state: "production", estimatedHours: 200 });
  const match = matchShop(store, { subcategoryCode: "flyers", ranking: RANKING, deadline: "2026-09-27T10:00:00.000Z", now: sunday });
  assert.equal(match.promiseBy, "2026-09-27T10:00:00.000Z");
  assert.equal(match.expressPromise, true);
});

test("a shop group answers with Express only when every product already in it is Express", () => {
  const { store } = fixture({ express: true });
  const ordinary = addShop(store, "shop_c");
  store.catalogItems.push({ ...ordinary, id: "item_a_plain", supplierId: "shop_a", supplierServiceId: "service_shop_a", express: false });
  store.files.push({ fileId: "photo_item_a_plain", ownerId: "shop_a", purpose: "catalog_item_photo", state: "ready", objectKey: "shop_a/plain.jpg" });
  store.catalogItemPhotos.push({ catalogItemId: "item_a_plain", fileId: "photo_item_a_plain", sortOrder: 0 });
  const cartLines = [{ id: "line_plain", supplierId: "shop_a", catalogItemId: "item_a_plain", quantity: 1, deadline: TODAY_18 }];
  assert.throws(() => matchShop(store, { subcategoryCode: "flyers", ranking: RANKING, deadline: TODAY_18, now: NOW, cartLines }), notMet);
});

test("match, cart and checkout carry the Express promise, and the order is tagged for every party", async () => {
  const { store, client } = fixture({ express: true });
  const call = caller(store, client);
  const match = await call("POST", "/me/matches", { subcategoryCode: "flyers", ranking: RANKING, fulfillmentMode: "pickup", deadline: TODAY_18 });
  assert.equal(match.status, 200);
  assert.equal(match.body.listings[0].expressPromise, true);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  const added = await call("POST", `/me/carts/${cartId}/lines`, { matchRequestId: match.body.matchRequestId,
    selectToken: match.body.listings[0].selectToken, optionIds: [], quantity: 50, artworkFileId: "file_art" });
  assert.equal(added.status, 201);
  assert.equal(added.body.cart.lines[0].listing.express, true);
  assert.equal(added.body.cart.lines[0].promiseBy, TODAY_18);
  const cart = (await call("GET", `/me/carts/${cartId}`)).body.cart;
  assert.equal(cart.lines[0].listing.express, true);
  assert.equal(cart.groups[0].readyBy, TODAY_18);
  assert.equal(cart.groups[0].expressPromise, true);

  const checkedOut = await call("POST", `/me/carts/${cartId}/checkout`, {
    payment: { method: "qr_manual", proofFileId: "file_qr", reference: "EXPRESS-1" },
  });
  assert.equal(checkedOut.status, 201);
  assert.equal(checkedOut.body.order.express, true);
  assert.equal(checkedOut.body.order.readyBy, TODAY_18);
  const order = store.orders.find((row) => row.id === checkedOut.body.order.id);
  assert.equal(order.express, true);
  assert.equal(order.readyBy, TODAY_18);
  assert.equal(order.promiseBy, TODAY_18);
  for (const role of ["ops_admin", "super_admin"]) {
    assert.equal(publicOrderFor(order, { id: role, role }, store).express, true, role);
  }
  assert.equal(publicOrderFor(order, { id: "shop_a", role: "supplier" }, store).express, true);
});

test("an order on an ordinary promise is tagged not Express", async () => {
  const { store, client } = fixture({ express: true });
  const call = caller(store, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_shop_b", optionIds: [], quantity: 1, artworkFileId: "file_art" });
  const checkedOut = await call("POST", `/me/carts/${cartId}/checkout`, {
    payment: { method: "qr_manual", proofFileId: "file_qr", reference: "PLAIN-1" },
  });
  assert.equal(checkedOut.status, 201);
  assert.equal(checkedOut.body.order.express, false);
  assert.equal(store.orders.find((row) => row.id === checkedOut.body.order.id).express, false);
});

test("the Express switch persists per listing and defaults to off", { skip: !process.env.DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL: process.env.DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, "TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE");
  const store = persistedFixture();
  store.catalogItems.find((row) => row.id === "item_supplier").express = true;
  await db.transaction(() => saveStore(db, store));
  const loaded = await db.transaction(() => loadStore(db));
  assert.equal(loaded.catalogItems.find((row) => row.id === "item_supplier").express, true);
  assert.equal(loaded.catalogItems.find((row) => row.id === "item_replacement").express, false);
  // The shop's own board list reads its rows straight from SQL.
  const page = await listOwnCatalogItems(db, { supplierId: "supplier", q: null, subcategoryCode: null, active: null, sort: "board", limit: 20, cursor: null });
  assert.equal(page.items.find((row) => row.id === "item_supplier").express, true);
});
