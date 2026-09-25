import test from "node:test";
import assert from "node:assert/strict";

import { routeOrderMatch } from "../src/order-match-routes.js";
import { defaultTaxonomy } from "../src/taxonomy.js";

const AT = "2026-08-24T01:00:00.000Z";

function addPublicListing(store, { supplierId, itemId, priceMinor, shop, turnaroundHours = 24, subcategoryCode = "flyers" }) {
  const known = store.users.some((row) => row.id === supplierId);
  if (!known) {
    store.users.push({ id: supplierId, role: "supplier", email: `${supplierId}@gridgo.test` });
    store.userRoleMemberships.push({ userId: supplierId, role: "supplier" });
    store.supplierProfiles.push({ userId: supplierId, shopName: `${supplierId} Shop`, contactName: supplierId, shop, pickupAvailable: true });
    store.approvalCases.push({ id: `case_${supplierId}`, userId: supplierId, kind: "supplier", status: "approved" });
  }
  const serviceId = `service_${supplierId}`;
  if (!known) store.supplierServices.push({
    id: serviceId, supplierId, categoryCode: "marketing_collateral", state: "live",
    pricingBasis: "per_unit", referenceRateMinor: priceMinor, turnaroundHours,
    standardTurnaroundHours: turnaroundHours, version: 1,
  });
  if (!known) store.supplierServiceFileFormats.push({ supplierServiceId: serviceId, formatCode: "pdf" });
  store.catalogItems.push({
    id: itemId, supplierId, supplierServiceId: serviceId, subcategoryCode,
    name: `${supplierId} Flyers`, description: "Full-color flyers", basePriceMinor: priceMinor,
    pricingUnit: "per_unit", turnaroundMode: "inherit", fileFormatMode: "inherit",
    active: true, sortOrder: store.catalogItems.filter((row) => row.supplierId === supplierId).length, version: 1,
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
  // A second listing at the same shop: a basket can hold two lines without
  // spanning two shops, which is now refused.
  addPublicListing(store, {
    supplierId: "supplier_a", itemId: "item_a2", priceMinor: 20_000,
    shop: { lat: 7.064, lng: 125.6085, label: "Shop A" }, turnaroundHours: 12,
    subcategoryCode: "brochures",
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

function caller(store, user, at = AT) {
  let sequence = 0;
  return async (method, pathname, body) => routeOrderMatch({
    req: { method },
    url: new URL(`http://gridgo.test${pathname}`),
    store,
    user,
    readBody: async () => body || {},
    id: (prefix) => `${prefix}_${++sequence}`,
    now: () => at,
  });
}

for (const queued of [false, true]) {
  test(`Friday ready-time agrees across match, cart and checkout (queued=${queued})`, async (t) => {
    const { store, client } = fixture();
    const at = "2026-09-25T08:00:00.000Z"; // Friday 16:00 in Davao.
    const call = caller(store, client, at);
    store.settings.promiseAllowanceMinutes = 60;
    Object.assign(store.supplierServices[0], { turnaroundHours: 3, standardTurnaroundHours: 3 });
    store.supplierProfiles[0].schedule = {
      utcOffsetMinutes: 480,
      week: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensMinute: 480, closesMinute: 1080 })),
      closures: [],
    };
    if (queued) {
      // The listing overrides a slower service; every path must use the listing.
      Object.assign(store.supplierServices[0], { turnaroundHours: 12, standardTurnaroundHours: 12 });
      Object.assign(store.catalogItems[0], { turnaroundMode: "override", turnaroundHours: 3 });
      store.orderJobs.push({ id: "ahead_job", orderId: "ahead_order", supplierId: "supplier_a", state: "production", estimatedHours: 3 });
      store.orders.push(
        { id: "ahead_order", supplierId: "supplier_a", state: "production", estimatedHours: 3 },
        { id: "legacy_order", supplierId: "supplier_a", state: "production", estimatedHours: 1 },
        { id: "finished_order", supplierId: "supplier_a", state: "completed", estimatedHours: 100 },
      );
    }
    const match = await call("POST", "/me/matches", {
      subcategoryCode: "flyers", excludedSupplierIds: ["supplier_b"],
    });
    const expected = queued ? "2026-09-28T06:00:00.000Z" : "2026-09-28T02:00:00.000Z";
    assert.equal(match.body.promiseBy, expected);
    assert.equal(match.body.queue.jobsAhead, queued ? 2 : 0);
    const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
    const added = await call("POST", `/me/carts/${cartId}/lines`, {
      catalogItemId: "item_a", optionIds: [], quantity: 1,
    });
    const cart = (await call("GET", `/me/carts/${cartId}`)).body.cart;
    const checkedOut = await call("POST", `/me/carts/${cartId}/checkout`, {
      payment: { method: "qr_manual", proofFileId: "file_qr", reference: "FRIDAY-READY" },
    });
    await t.test("checkout saves the match promise", () => {
      const order = store.orders.find((row) => row.id === checkedOut.body.order.id);
      assert.equal(order.promiseBy, expected);
      assert.equal(checkedOut.body.order.readyBy, expected);
    });
    await t.test("full and compact cart lines expose the match promise", () => {
      assert.equal(cart.lines[0].promiseBy, expected);
      assert.equal(added.body.cart.lines[0].promiseBy, expected);
    });
  });
}

test("cart promise uses quantity capacity, closures, and the current request time", async () => {
  const { store, client } = fixture();
  const call = caller(store, client, "2026-09-25T08:00:00.000Z");
  store.settings.promiseAllowanceMinutes = 0;
  Object.assign(store.supplierServices[0], { standardTurnaroundHours: 3, capacityDaily: 100 });
  store.supplierProfiles[0].schedule = {
    utcOffsetMinutes: 480,
    week: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensMinute: 480, closesMinute: 1080 })),
    closures: [{ startDay: "2026-09-28", endDay: "2026-09-28" }],
  };
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  const added = await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_a", optionIds: [], quantity: 200,
  });
  const expected = "2026-09-29T10:00:00.000Z"; // End of the second open day.
  assert.equal(added.body.cart.lines[0].promiseBy, expected);
  const checkedOut = await call("POST", `/me/carts/${cartId}/checkout`, {
    payment: { method: "qr_manual", proofFileId: "file_qr", reference: "CAPACITY-READY" },
  });
  assert.equal(store.orders.find((row) => row.id === checkedOut.body.order.id).promiseBy, expected);
  const later = caller(store, client, "2026-09-30T00:00:00.000Z");
  const refreshed = (await later("GET", `/me/carts/${cartId}`)).body.cart.lines[0];
  assert.ok(Date.parse(refreshed.promiseBy) > Date.parse(expected));
  assert.equal(store.orders.find((row) => row.id === checkedOut.body.order.id).promiseBy, expected);
});

test("cart promise is explicitly null when its listing or calendar is unavailable", async (t) => {
  for (const [name, invalidate] of [
    ["missing listing", (store) => { store.catalogItems = []; }],
    ["missing service", (store) => { store.supplierServices = []; }],
    ["closed shop", (store) => { store.supplierProfiles[0].isClosed = true; }],
    ["missing shop", (store) => { store.supplierProfiles = []; }],
    ["invalid calendar", (store) => { store.supplierProfiles[0].schedule = { week: [] }; }],
    ["no opening within a year", (store) => {
      store.supplierProfiles[0].schedule = {
        utcOffsetMinutes: 480,
        week: [{ weekday: 1, opensMinute: 480, closesMinute: 1080 }],
        closures: [{ startDay: "2026-01-01", endDay: "2028-01-01" }],
      };
    }],
  ]) {
    await t.test(name, async () => {
      const { store, client } = fixture();
      const call = caller(store, client);
      const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
      const added = await call("POST", `/me/carts/${cartId}/lines`, {
        catalogItemId: "item_a", optionIds: [], quantity: 1,
      });
      assert.ok(added.body.cart.lines[0].promiseBy);
      invalidate(store);
      assert.equal((await call("GET", `/me/carts/${cartId}`)).body.cart.lines[0].promiseBy, null);
      const lineId = added.body.cart.lines[0].id;
      const patched = await call("PATCH", `/me/carts/${cartId}/lines/${lineId}`, { structuredSpec: {} });
      assert.equal(patched.body.cart.lines[0].promiseBy, null);
    });
  }
});

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
    catalogItemId: "item_a2", optionIds: [], quantity: 1,
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
  const committed = store.orders.find((order) => order.id === checkedOut.body.order.id);
  assert.equal(committed.riderCommissionBps, 8500);
  assert.equal(committed.riderPayoutMinor, 2125);
  assert.equal(committed.platformDeliveryShareMinor, 375);
  assert.equal(store.orderJobs[0].riderCommissionBps, 8500);
  assert.equal(store.orderJobs[0].riderPayoutMinor, 2125);
  store.settings.riderCommissionBps = 7000;
  assert.equal(committed.riderPayoutMinor, 2125);
  assert.equal(checkedOut.body.order.riderPayoutMinor, undefined);
  assert.equal(checkedOut.body.order.jobs[0].riderPayoutMinor, undefined);

  // Money first: Operations confirms the transfer before anything is checked.
  assert.equal(checkedOut.body.order.state, "initial_payment_review");
  assert.ok(checkedOut.body.order.readyBy, "the client is given a promised date at checkout");
  assert.equal(checkedOut.body.order.itemSubtotalMinor, 30_000);
  assert.equal(checkedOut.body.order.serviceFeeMinor, 3_000);
  assert.equal(checkedOut.body.order.deliveryFeeMinor, 2_500); // one shop, one delivery
  assert.equal(checkedOut.body.order.totalMinor, 35_500);
  // Paid in full up front: one transfer, and no balance left to owe.
  assert.equal(checkedOut.body.order.downpaymentPercent, 100);
  assert.deepEqual(checkedOut.body.order.paymentPlan, {
    method: "qr_manual",
    downpaymentPercent: 100,
    downpaymentMinor: 35_500,
    balanceMinor: 0,
    downpaymentStatus: "pending_confirmation",
    balanceStatus: "not_required",
  });
  assert.equal(committed.downpaymentPercent, 100);
  assert.equal(committed.supplierDownpaymentRateBps, 10_000);
  assert.equal(committed.payments.final_online.status, "not_required");
  // Every peso of the shop's price rides on the one payment.
  assert.deepEqual(
    committed.paymentAllocations.map((row) => `${row.paymentCode}:${row.component}:${row.amountMinor}`),
    ["initial:supplier_principal:30000", "initial:service_fee:3000", "initial:delivery_pass_through:2500"],
  );
  // The split is the order's own, like the rider share: the setting moving
  // afterwards never changes what this client owes.
  store.settings.downpaymentPercent = 75;
  assert.equal(committed.payments.initial.amountMinor, 35_500);
  delete store.settings.downpaymentPercent;
  assert.equal(checkedOut.body.order.jobs.length, 1);
  assert.deepEqual(checkedOut.body.order.jobs.map((job) => job.deliveryFeeMinor), [2_500]);
  // A delivered job gives the client no origin pin: the shop's coordinates are
  // GRIDGO's business, and the client watches the rider and their own address.
  assert.deepEqual(checkedOut.body.order.jobs.map((job) => job.pickup), [null]);
  // The jobs themselves still hold the real shop, because that is where the
  // rider collects.
  assert.deepEqual(store.orderJobs.map((job) => job.pickup.label), ["Shop A"]);
  // And the order itself now names the shop. It was null here, which is why no
  // supplier surface ever showed a checkout order: they all read supplierId.
  assert.equal(store.orders[0].supplierId, "supplier_a");
  assert.ok(store.orders[0].readyBy, "the shop's own date is recorded");
  assert.ok(
    Date.parse(store.orders[0].promiseBy) >= Date.parse(store.orders[0].readyBy),
    "the client's promise cannot fall before the shop's own date",
  );
  assert.deepEqual(store.jobQaChecklist, []);
  // No ops/admin memberships in this fixture. The client still gets the
  // acknowledgement that their receipt is ready.
  assert.deepEqual(
    store.notifications.map((row) => `${row.userId}:${row.type}`),
    [`${client.id}:order_receipt_ready`],
  );

  const invoice = await call("GET", `/orders/${checkedOut.body.order.id}/invoice`);
  assert.equal(invoice.status, 200);
  assert.equal(invoice.body.invoice.totalMinor, 35_500);
  assert.deepEqual(invoice.body.invoice.paymentPlan, { method: "qr_manual", downpaymentPercent: 100, downpaymentMinor: 35_500, balanceMinor: 0 });
  assert.equal(invoice.body.invoice.deliveryLines.length, 1);
  assert.equal(invoice.body.invoice.lines.find((line) => line.id === lineId).mockupFileId, "file_mock");
});

test("with the setting at 75, checkout snapshots a 75/25 split and a balance to pay", async () => {
  const { store, client } = fixture();
  store.settings.downpaymentPercent = 75;
  const call = caller(store, client);
  const created = await call("POST", "/me/carts", {
    fulfillmentMode: "delivery",
    defaultDropoff: { lat: 7.0731, lng: 125.6128, label: "Home" },
  });
  const cartId = created.body.cart.id;
  await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_a", optionIds: [], quantity: 1, artworkFileId: "file_art" });
  await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_a2", optionIds: [], quantity: 1 });
  const checkedOut = await call("POST", `/me/carts/${cartId}/checkout`, {
    payment: { method: "qr_manual", proofFileId: "file_qr", reference: "QR-123" },
  });
  assert.equal(checkedOut.status, 201);
  assert.deepEqual(checkedOut.body.order.paymentPlan, {
    method: "qr_manual",
    downpaymentPercent: 75,
    downpaymentMinor: 26_625,
    balanceMinor: 8_875,
    downpaymentStatus: "pending_confirmation",
    balanceStatus: "not_submitted",
  });
  const committed = store.orders.find((order) => order.id === checkedOut.body.order.id);
  assert.equal(committed.supplierDownpaymentRateBps, 7_500);
  assert.equal(committed.payments.initial.label, "75% downpayment");
  assert.equal(committed.payments.final_online.label, "25% balance");
  assert.equal(
    committed.paymentAllocations.filter((row) => row.component === "supplier_principal")
      .reduce((total, row) => total + row.amountMinor, 0),
    30_000,
  );
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
    catalogItemId: "item_a2", optionIds: [], quantity: 1, artworkFileId: "file_art",
  });

  const checkedOut = await call("POST", `/me/carts/${cartId}/checkout`, {
    payment: { method: "qr_manual", proofFileId: "file_qr", reference: "QR-123" },
  });

  assert.equal(checkedOut.body.order.jobs.length, 1);
  for (const job of checkedOut.body.order.jobs) {
    assert.deepEqual(job.pickup, {
      lat: 7.092287234449552,
      lng: 125.61651084538697,
      label: "GRIDGO Office",
    });
  }
  // Production is untouched — the rider still goes to the press.
  assert.deepEqual(store.orderJobs.map((job) => job.pickup.label), ["Shop A"]);
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
    catalogItemId: "item_a2", optionIds: [], quantity: 1,
  });

  assert.equal(added.status, 201);
  assert.equal(added.body.cart.lines.length, 2);
  assert.deepEqual(added.body.cart.lines[0].listing, {
    id: "item_a",
    name: "supplier_a Flyers",
    supplierId: "supplier_a",
    fromPriceMinor: 12_500,
    effectivePriceMinor: 12_500,
    clientFromPriceMinor: 13_750,
    clientEffectivePriceMinor: 13_750,
    printerMaxWidthFeet: null,
    selectedOptions: [{ id: "option_item_a_matte", label: "Matte" }],
  });
  assert.equal(added.body.cart.lines[0].lineSubtotalMinor, 25_000);
  assert.equal(added.body.cart.lines[0].clientLineSubtotalMinor, 27_500);
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
    catalogItemId: "item_a2", optionIds: [], quantity: 1,
  });
  await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_a", optionIds: [], quantity: 1,
  });
  await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_a2", optionIds: [], quantity: 2,
  });

  const cart = (await call("GET", `/me/carts/${cartId}`)).body.cart;
  // One shop per basket, so one counter.
  assert.deepEqual(cart.shops, [
    {
      supplierId: "supplier_a",
      shopName: "supplier_a Shop",
      shop: { lat: 7.064, lng: 125.6085, label: "Shop A" },
    },
  ]);

  // And a listing from a second shop is refused rather than quietly splitting
  // the order in two.
  await assert.rejects(
    call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_b", optionIds: [], quantity: 1 }),
    (error) => error.code === "cart_belongs_to_another_shop",
  );
});

test("a tarpaulin priced by the square foot can actually be ordered", async () => {
  // The whole chain this exists to close. `src/pricing.js` could bill by area
  // from the day it landed and the catalogue could store the shape; a cart
  // line had nowhere to put a width, so every one of these listings refused
  // the basket it was added to.
  const { store, client } = fixture();
  const tarpaulin = store.catalogItems.find((row) => row.id === "item_a");
  tarpaulin.name = "supplier_a Tarpaulin";
  tarpaulin.pricingUnit = "per_area";
  tarpaulin.measureUnit = "ft";
  tarpaulin.basePriceMinor = 2_500;
  // Polymedia bills a small banner at the 2x4 rate: the sheet is wasted either
  // way, and a shop that cannot say so is underpaid on every small order.
  tarpaulin.minimumWidthMilli = 2_000;
  tarpaulin.minimumHeightMilli = 4_000;

  const call = caller(store, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;

  // Sent with no measurement, the client is told which numbers to give rather
  // than seeing a pricing error they cannot act on.
  await assert.rejects(
    call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_a", optionIds: [], quantity: 1 }),
    (error) => error.code === "measurement_required" && error.details.measurementKind === "area",
  );

  // 3ft x 5ft, in thousandths, is 15 square feet at PHP 25.
  const added = await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_a", optionIds: [], quantity: 1,
    measurement: { width: 3_000, height: 5_000 },
  });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.cart.lines[0].measurement, { width: 3_000, height: 5_000 });
  assert.equal(added.body.cart.lines[0].lineSubtotalMinor, 37_500);

  // Under the shop's minimum, the minimum is what is billed: 8 square feet.
  const lineId = added.body.cart.lines[0].id;
  const small = await call("PATCH", `/me/carts/${cartId}/lines/${lineId}`, {
    measurement: { width: 1_000, height: 4_000 },
  });
  assert.equal(small.status, 200);
  assert.equal(small.body.cart.lines[0].lineSubtotalMinor, 20_000);

  // A listing not priced by size is not quietly given one: a measurement that
  // is silently dropped bills the client for something they did not fill in.
  await assert.rejects(
    call("POST", `/me/carts/${cartId}/lines`, {
      catalogItemId: "item_a2", optionIds: [], quantity: 1,
      measurement: { width: 3_000, height: 5_000 },
    }),
    (error) => error.code === "measurement_not_accepted",
  );
});

test("a tarpaulin cart line is refused when requested width exceeds the printer cap", async () => {
  const { store, client } = fixture();
  const tarpaulin = store.catalogItems.find((row) => row.id === "item_a");
  tarpaulin.subcategoryCode = "tarpaulins_outdoor_banners";
  tarpaulin.pricingUnit = "per_area";
  tarpaulin.measureUnit = "ft";
  tarpaulin.basePriceMinor = 4_000;
  tarpaulin.printerMaxWidthFeet = 5;

  const call = caller(store, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;

  const fits = await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_a", optionIds: [], quantity: 1,
    measurement: { width: 5_000, height: 8_000 },
  });
  assert.equal(fits.status, 201);
  assert.equal(fits.body.cart.lines[0].listing.printerMaxWidthFeet, 5);

  await assert.rejects(
    call("PATCH", `/me/carts/${cartId}/lines/${fits.body.cart.lines[0].id}`, {
      measurement: { width: 6_000, height: 8_000 },
    }),
    (error) => error.status === 409 && error.code === "printer_cap_exceeded" && error.details.field === "printerMaxWidthFeet",
  );

  const cartId2 = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  await assert.rejects(
    call("POST", `/me/carts/${cartId2}/lines`, {
      catalogItemId: "item_a", optionIds: [], quantity: 1,
      measurement: { width: 6_000, height: 8_000 },
    }),
    (error) => error.status === 409 && error.code === "printer_cap_exceeded",
  );
});

test("a document priced by the page bills pages times copies", async () => {
  const { store, client } = fixture();
  const booklet = store.catalogItems.find((row) => row.id === "item_a");
  booklet.name = "supplier_a Booklet";
  booklet.pricingUnit = "per_page";
  booklet.basePriceMinor = 300;

  const call = caller(store, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;

  // Pages and copies are two different numbers, and conflating them is how a
  // client orders a tenth of their own document. Ten pages, three copies.
  const added = await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_a", optionIds: [], quantity: 3,
    measurement: { pages: 10 },
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.cart.lines[0].quantity, 3);
  assert.deepEqual(added.body.cart.lines[0].measurement, { pages: 10 });
  assert.equal(added.body.cart.lines[0].lineSubtotalMinor, 9_000);
});

test("attaching a detected page count then changing copies prices pages times copies", async () => {
  const { store, client } = fixture();
  const booklet = store.catalogItems.find((row) => row.id === "item_a");
  booklet.name = "supplier_a Booklet";
  booklet.pricingUnit = "per_page";
  booklet.basePriceMinor = 300;

  const call = caller(store, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;

  // The listing screen's default: one page, two copies, ₱3 each — ₱6, which
  // is the invoice a 30-page PDF used to produce until the file's own count
  // was written onto the line.
  const added = await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_a", optionIds: [], quantity: 2,
    measurement: { pages: 1 },
  });
  assert.equal(added.body.cart.lines[0].lineSubtotalMinor, 600);
  const lineId = added.body.cart.lines[0].id;

  const attached = await call("PATCH", `/me/carts/${cartId}/lines/${lineId}`, {
    artworkFileId: "file_art",
    measurement: { pages: 30 },
  });
  assert.equal(attached.status, 200);
  assert.equal(attached.body.cart.lines[0].artworkFileId, "file_art");
  assert.equal(attached.body.cart.lines[0].quantity, 2);
  assert.deepEqual(attached.body.cart.lines[0].measurement, { pages: 30 });
  assert.equal(attached.body.cart.lines[0].lineSubtotalMinor, 18_000);

  const edited = await call("PATCH", `/me/carts/${cartId}/lines/${lineId}`, {
    measurement: { pages: 10 },
  });
  assert.deepEqual(edited.body.cart.lines[0].measurement, { pages: 10 });
  assert.equal(edited.body.cart.lines[0].quantity, 2);
  assert.equal(edited.body.cart.lines[0].lineSubtotalMinor, 6_000);

  await call("PATCH", `/me/carts/${cartId}/lines/${lineId}`, {
    measurement: { pages: 30 },
  });

  // Checkout's stepper is copies. A quantity-only PATCH must not replace or
  // drop the page count the file already put on the line.
  const copies = await call("PATCH", `/me/carts/${cartId}/lines/${lineId}`, {
    quantity: 3,
  });
  assert.equal(copies.body.cart.lines[0].quantity, 3);
  assert.deepEqual(copies.body.cart.lines[0].measurement, { pages: 30 });
  assert.equal(copies.body.cart.lines[0].lineSubtotalMinor, 27_000);
});

test("checkout writes ops needs-QA, payment-submitted, and the client receipt-ready row", async () => {
  const { store, client } = fixture();
  store.users.push(
    { id: "user_ops", role: "ops_admin", email: "ops@gridgo.test" },
    { id: "user_admin", role: "client", email: "admin@gridgo.test" },
  );
  store.userRoleMemberships.push(
    { userId: "user_ops", role: "ops_admin" },
    { userId: "user_admin", role: "super_admin" },
  );
  const call = caller(store, client);
  const created = await call("POST", "/me/carts", {
    fulfillmentMode: "delivery",
    defaultDropoff: { lat: 7.0731, lng: 125.6128, label: "Home" },
  });
  const cartId = created.body.cart.id;
  await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_a", optionIds: [], quantity: 1, artworkFileId: "file_art",
  });
  const checkedOut = await call("POST", `/me/carts/${cartId}/checkout`, {
    payment: { method: "qr_manual", proofFileId: "file_qr", reference: "QR-123" },
  });
  assert.equal(checkedOut.status, 201);
  assert.deepEqual(
    store.notifications.map((row) => `${row.userId}:${row.type}`).sort(),
    [
      "user_admin:ops_job_needs_qa",
      "user_admin:ops_payment_submitted",
      "user_client:order_receipt_ready",
      "user_ops:ops_job_needs_qa",
      "user_ops:ops_payment_submitted",
    ],
  );
  assert.equal(store.notifications.some((row) => row.userId === "supplier_a"), false);
});

test("match and cart client projections include GRIDGO amounts beside shop amounts", async () => {
  const { store, client } = fixture();
  store.settings.serviceFeeRateBps = 4_500;
  store.catalogItems.find((row) => row.id === "item_a").basePriceMinor = 1_200;
  const call = caller(store, client);

  const address = await call("POST", "/me/addresses", {
    label: "Home", addressLine: "Bajada, Davao City",
    point: { lat: 7.0731, lng: 125.6128 },
  });
  const match = await call("POST", "/me/matches", {
    subcategoryCode: "flyers", addressId: address.body.address.id,
  });
  const listing = match.body.listings.find((row) => row.id === "item_a");
  assert.equal(listing.fromPriceMinor, 1_200);
  assert.equal(listing.clientFromPriceMinor, 1_740);

  store.settings.serviceFeeRateBps = 1_000;
  const cheaper = await call("POST", "/me/matches", {
    subcategoryCode: "flyers", addressId: address.body.address.id,
  });
  assert.equal(cheaper.body.listings.find((row) => row.id === "item_a").clientFromPriceMinor, 1_320);

  store.settings.serviceFeeRateBps = 4_500;
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  const added = await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_a", optionIds: [], quantity: 1,
  });
  assert.equal(added.body.cart.lines[0].lineSubtotalMinor, 1_200);
  assert.equal(added.body.cart.lines[0].clientLineSubtotalMinor, 1_740);
  assert.equal(added.body.cart.lines[0].listing.fromPriceMinor, 1_200);
  assert.equal(added.body.cart.lines[0].listing.clientFromPriceMinor, 1_740);

  const full = (await call("GET", `/me/carts/${cartId}`)).body.cart;
  assert.equal(full.lines[0].lineSubtotalMinor, 1_200);
  assert.equal(full.lines[0].clientLineSubtotalMinor, 1_740);
  assert.equal(full.lines[0].listing.fromPriceMinor, 1_200);
  assert.equal(full.lines[0].listing.clientFromPriceMinor, 1_740);
});

test("a basket refuses a quantity under the listing's minimum instead of holding a line it cannot price", async () => {
  // PrintZone's lanyard as the deployed board published it on 2026-09-19:
  // PHP 50.00 each, and the shop does not run fewer than ten. A client added
  // one, and the basket showed the line at "—" and Items at PHP 0.00 because
  // the pricer's refusal was swallowed into a null subtotal.
  const { store, client } = fixture();
  const lanyard = store.catalogItems.find((row) => row.id === "item_a");
  lanyard.basePriceMinor = 5_000;
  lanyard.minimumOrderQuantity = 10;
  const call = caller(store, client);
  const created = await call("POST", "/me/carts", { fulfillmentMode: "pickup" });
  const cartId = created.body.cart.id;

  await assert.rejects(
    call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_a", optionIds: [], quantity: 1 }),
    (error) => error.status === 409 && error.code === "below_minimum_quantity"
      && error.details.minimumOrderQuantity === 10,
  );
  assert.equal((await call("GET", `/me/carts/${cartId}`)).body.cart.lines.length, 0);

  const added = await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_a", optionIds: [], quantity: 10 });
  assert.equal(added.status, 201);
  assert.equal(added.body.cart.lines[0].lineSubtotalMinor, 50_000);
  const lineId = added.body.cart.lines[0].id;

  await assert.rejects(
    call("PATCH", `/me/carts/${cartId}/lines/${lineId}`, { quantity: 9 }),
    (error) => error.status === 409 && error.code === "below_minimum_quantity",
  );
  assert.equal((await call("GET", `/me/carts/${cartId}`)).body.cart.lines[0].quantity, 10);

  // Raising the minimum after the fact leaves the line unpriced, and that is
  // still reported as null rather than invented. Artwork can still be attached
  // to it; only the pricing inputs are held to the minimum.
  lanyard.minimumOrderQuantity = 20;
  const stale = await call("GET", `/me/carts/${cartId}`);
  assert.equal(stale.body.cart.lines[0].lineSubtotalMinor, null);
  const withArt = await call("PATCH", `/me/carts/${cartId}/lines/${lineId}`, { artworkFileId: "file_art" });
  assert.equal(withArt.status, 200);
  assert.equal(withArt.body.cart.lines[0].artworkFileId, "file_art");
  const raised = await call("PATCH", `/me/carts/${cartId}/lines/${lineId}`, { quantity: 20 });
  assert.equal(raised.body.cart.lines[0].lineSubtotalMinor, 100_000);
});
