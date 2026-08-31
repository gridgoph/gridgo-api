import test from "node:test";
import assert from "node:assert/strict";

import { routeOrderMatch } from "../src/order-match-routes.js";
import { defaultTaxonomy } from "../src/taxonomy.js";

const AT = "2026-08-24T01:00:00.000Z";

function addPublicListing(store, { supplierId, itemId, priceMinor, shop, turnaroundHours = 24 }) {
  store.users.push({ id: supplierId, role: "supplier", email: `${supplierId}@gridgo.test` });
  store.userRoleMemberships.push({ userId: supplierId, role: "supplier" });
  store.supplierProfiles.push({ userId: supplierId, shopName: `${supplierId} Shop`, contactName: supplierId, shop, pickupAvailable: true });
  store.approvalCases.push({ id: `case_${supplierId}`, userId: supplierId, kind: "supplier", status: "approved" });
  const serviceId = `service_${supplierId}`;
  store.supplierServices.push({
    id: serviceId, supplierId, categoryCode: "marketing_collateral", state: "live",
    pricingBasis: "per_unit", referenceRateMinor: priceMinor, turnaroundHours,
    standardTurnaroundHours: turnaroundHours, version: 1,
  });
  store.supplierServiceFileFormats.push({ supplierServiceId: serviceId, formatCode: "pdf" });
  store.catalogItems.push({
    id: itemId, supplierId, supplierServiceId: serviceId, subcategoryCode: "flyers",
    name: `${supplierId} Flyers`, description: "Full-color flyers", basePriceMinor: priceMinor,
    pricingUnit: "per_unit", turnaroundMode: "inherit", fileFormatMode: "inherit",
    active: true, sortOrder: 0, version: 1,
  });
  const fileId = `photo_${itemId}`;
  store.files.push({ fileId, ownerId: supplierId, purpose: "catalog_item_photo", state: "ready", objectKey: `${supplierId}/flyers.jpg` });
  store.catalogItemPhotos.push({ catalogItemId: itemId, fileId, sortOrder: 0 });
}

function fixture() {
  const client = { id: "user_client", role: "client", email: "client@gridgo.test" };
  const store = {
    settings: {
      serviceFeeRateBps: 1000,
      issueWindowHours: 24,
      deliveryFeeBands: [{ maxDistanceMeters: null, feeMinor: 2500 }],
    },
    taxonomy: defaultTaxonomy(),
    users: [client],
    userRoleMemberships: [{ userId: client.id, role: "client" }],
    clientPreferences: [], clientAddresses: [], carts: [], cartLines: [],
    supplierProfiles: [], approvalCases: [], supplierServices: [], supplierServiceFileFormats: [],
    acceptedFileFormats: [{ code: "pdf", displayName: "PDF", inputKind: "file", active: true }],
    catalogItems: [], catalogItemFileFormats: [], catalogItemPhotos: [], catalogOptionGroups: [], catalogOptions: [], catalogPrepSteps: [],
    files: [], orders: [], orderJobs: [], orderLineItems: [], orderLineItemOptions: [], jobQaChecklist: [], orderInvoices: [],
    notifications: [], auditLog: [],
  };
  addPublicListing(store, {
    supplierId: "supplier_a", itemId: "item_a", priceMinor: 10_000,
    shop: { lat: 7.064, lng: 125.6085, label: "Shop A" }, turnaroundHours: 12,
  });
  addPublicListing(store, {
    supplierId: "supplier_b", itemId: "item_b", priceMinor: 20_000,
    shop: { lat: 7.09, lng: 125.63, label: "Shop B" }, turnaroundHours: 24,
  });
  store.files.push(
    { fileId: "file_art", ownerId: client.id, purpose: "artwork", state: "ready", objectKey: "client/art.pdf", references: [] },
    { fileId: "file_mock", ownerId: client.id, purpose: "mockup", state: "ready", objectKey: "client/mock.jpg", references: [] },
    { fileId: "file_qr", ownerId: client.id, purpose: "payment_proof", state: "ready", objectKey: "client/qr.jpg", references: [] },
  );
  return { store, client };
}

function caller(store, user) {
  let sequence = 0;
  return async (method, pathname, body) => routeOrderMatch({
    req: { method },
    url: new URL(`http://gridgo.test${pathname}`),
    store,
    user,
    readBody: async () => body || {},
    id: (prefix) => `${prefix}_${++sequence}`,
    now: () => AT,
  });
}

test("preferences, addresses, matching, cart checkout, invoice, and mockup use the client contract", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);

  const defaults = await call("GET", "/me/preferences");
  assert.deepEqual(defaults.body.preferences.ranking, ["quality", "speed", "cost", "distance"]);
  const saved = await call("PUT", "/me/preferences", { ranking: ["distance", "quality", "cost", "speed"] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.preferences.ranking, ["distance", "quality", "cost", "speed"]);
  await assert.rejects(
    call("PUT", "/me/preferences", { ranking: ["quality", "quality", "cost", "speed"] }),
    (error) => error.code === "invalid_preference_ranking",
  );

  const address = await call("POST", "/me/addresses", {
    label: "Home", addressLine: "Bajada, Davao City",
    point: { lat: 7.0731, lng: 125.6128 }, isDefault: true,
  });
  assert.equal(address.status, 201);
  assert.equal((await call("GET", "/me/addresses")).body.addresses.length, 1);

  const match = await call("POST", "/me/matches", {
    subcategoryCode: "flyers", addressId: address.body.address.id,
  });
  assert.equal(match.status, 200);
  assert.equal(match.body.listings[0].subcategoryCode, "flyers");
  const next = await call("POST", "/me/matches/next", {
    subcategoryCode: "flyers", addressId: address.body.address.id,
    excludedSupplierIds: [match.body.shop.supplierId],
  });
  assert.notEqual(next.body.shop.supplierId, match.body.shop.supplierId);

  const created = await call("POST", "/me/carts", {
    fulfillmentMode: "delivery",
    defaultDropoff: { lat: 7.0731, lng: 125.6128, label: "Home" },
  });
  const cartId = created.body.cart.id;
  const firstLine = await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_a", optionIds: [], quantity: 1, artworkFileId: "file_art",
  });
  const lineId = firstLine.body.cart.lines[0].id;
  await call("PUT", `/me/carts/${cartId}/lines/${lineId}/mockup`, { fileId: "file_mock" });
  await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_b", optionIds: [], quantity: 1,
  });
  const cart = (await call("GET", `/me/carts/${cartId}`)).body.cart;
  assert.equal(cart.lines.length, 2);
  assert.equal(cart.lines.find((line) => line.id === lineId).mockupFileId, "file_mock");

  await assert.rejects(
    call("POST", `/me/carts/${cartId}/checkout`, {
      payment: { method: "cash", proofFileId: "file_qr", reference: "QR-123" },
    }),
    (error) => error.code === "payment_method_not_allowed",
  );
  const checkedOut = await call("POST", `/me/carts/${cartId}/checkout`, {
    payment: { method: "qr_manual", proofFileId: "file_qr", reference: "QR-123" },
  });

  assert.equal(checkedOut.status, 201);
  assert.equal(checkedOut.body.order.state, "needs_qa");
  assert.equal(checkedOut.body.order.itemSubtotalMinor, 30_000);
  assert.equal(checkedOut.body.order.serviceFeeMinor, 3_000);
  assert.equal(checkedOut.body.order.deliveryFeeMinor, 5_000);
  assert.equal(checkedOut.body.order.totalMinor, 38_000);
  assert.deepEqual(checkedOut.body.order.paymentPlan, {
    method: "qr_manual",
    downpaymentMinor: 28_500,
    balanceMinor: 9_500,
    downpaymentStatus: "pending_confirmation",
  });
  assert.equal(checkedOut.body.order.jobs.length, 2);
  assert.deepEqual(checkedOut.body.order.jobs.map((job) => job.deliveryFeeMinor), [2_500, 2_500]);
  // A delivered job gives the client no origin pin: the shop's coordinates are
  // GRIDGO's business, and the client watches the rider and their own address.
  assert.deepEqual(checkedOut.body.order.jobs.map((job) => job.pickup), [null, null]);
  // The jobs themselves still hold the real shop, because that is where the
  // rider collects.
  assert.deepEqual(
    store.orderJobs.map((job) => job.pickup.label).sort(),
    ["Shop A", "Shop B"],
  );
  assert.deepEqual(store.jobQaChecklist, []);
  assert.deepEqual(store.notifications, []);

  const invoice = await call("GET", `/orders/${checkedOut.body.order.id}/invoice`);
  assert.equal(invoice.status, 200);
  assert.equal(invoice.body.invoice.totalMinor, 38_000);
  assert.equal(invoice.body.invoice.deliveryLines.length, 2);
  assert.equal(invoice.body.invoice.lines.find((line) => line.id === lineId).mockupFileId, "file_mock");
});

test("a collected order is collected at GRIDGO's office, whoever printed it", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  const created = await call("POST", "/me/carts", { fulfillmentMode: "pickup" });
  const cartId = created.body.cart.id;

  // Two presses in one basket, so two jobs — and still one place to go.
  await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_a", optionIds: [], quantity: 1, artworkFileId: "file_art",
  });
  await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_b", optionIds: [], quantity: 1, artworkFileId: "file_art",
  });

  const checkedOut = await call("POST", `/me/carts/${cartId}/checkout`, {
    payment: { method: "qr_manual", proofFileId: "file_qr", reference: "QR-123" },
  });

  assert.equal(checkedOut.body.order.jobs.length, 2);
  for (const job of checkedOut.body.order.jobs) {
    assert.deepEqual(job.pickup, { lat: 7.13267, lng: 125.611265, label: "GRIDGO Office" });
  }
  // Production is untouched — the rider still goes to the press.
  assert.deepEqual(store.orderJobs.map((job) => job.pickup.label).sort(), ["Shop A", "Shop B"]);
});

test("adding a cart line returns cheap listing stubs without photos", async () => {
  const { store, client } = fixture();
  store.catalogOptionGroups.push({
    id: "group_item_a_paper", catalogItemId: "item_a", name: "Paper", kind: "spec",
    required: true, helpText: null, sortOrder: 0, version: 1,
  });
  store.catalogOptions.push({
    id: "option_item_a_matte", optionGroupId: "group_item_a_paper", label: "Matte",
    priceModifierMinor: 2_500, specBinding: null, active: true, sortOrder: 0,
  });
  const call = caller(store, client);
  const created = await call("POST", "/me/carts", { fulfillmentMode: "pickup" });
  const cartId = created.body.cart.id;

  await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_a", optionIds: ["option_item_a_matte"], quantity: 2,
  });
  const added = await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_b", optionIds: [], quantity: 1,
  });

  assert.equal(added.status, 201);
  assert.equal(added.body.cart.lines.length, 2);
  assert.deepEqual(added.body.cart.lines[0].listing, {
    id: "item_a",
    name: "supplier_a Flyers",
    supplierId: "supplier_a",
    fromPriceMinor: 12_500,
    effectivePriceMinor: 12_500,
    selectedOptions: [{ id: "option_item_a_matte", label: "Matte" }],
  });
  assert.equal(added.body.cart.lines[0].lineSubtotalMinor, 25_000);
  assert.equal(Object.hasOwn(added.body.cart.lines[1].listing, "photos"), false);

  const canonical = (await call("GET", `/me/carts/${cartId}`)).body.cart;
  assert.equal(canonical.lines[0].listing.photos.length, 1);

  const patched = await call("PATCH", `/me/carts/${cartId}/lines/${added.body.cart.lines[1].id}`, {
    quantity: 3,
  });
  assert.equal(patched.status, 200);
  assert.equal(Object.hasOwn(patched.body.cart.lines[1].listing, "photos"), false);
  assert.equal(patched.body.cart.lines[1].quantity, 3);

  const removed = await call("DELETE", `/me/carts/${cartId}/lines/${added.body.cart.lines[0].id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.cart.lines.length, 1);
  assert.equal(Object.hasOwn(removed.body.cart.lines[0].listing, "photos"), false);
});

test("cart payloads include one shop counter per selected supplier", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  const created = await call("POST", "/me/carts", { fulfillmentMode: "pickup" });
  const cartId = created.body.cart.id;

  await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_b", optionIds: [], quantity: 1,
  });
  await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_a", optionIds: [], quantity: 1,
  });
  await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_b", optionIds: [], quantity: 2,
  });

  const cart = (await call("GET", `/me/carts/${cartId}`)).body.cart;
  assert.deepEqual(cart.shops, [
    {
      supplierId: "supplier_b",
      shopName: "supplier_b Shop",
      shop: { lat: 7.09, lng: 125.63, label: "Shop B" },
    },
    {
      supplierId: "supplier_a",
      shopName: "supplier_a Shop",
      shop: { lat: 7.064, lng: 125.6085, label: "Shop A" },
    },
  ]);
});
