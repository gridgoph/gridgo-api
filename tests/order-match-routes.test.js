import { routeBaskets } from "../src/baskets.js";
import { calculateRefundSettlement } from "../src/refund-policy.js";
import { defaultOperationalSettings, publicOrderFor, moneyReportingForOrder } from "../src/operational-model.js";
import test from "node:test";
import assert from "node:assert/strict";

import { routeOrderMatch, prepareCartArtworkLinks, prepareArtworkCheckout } from "../src/order-match-routes.js";
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
    settings: defaultOperationalSettings(),
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
    { fileId: "file_art", ownerId: client.id, purpose: "artwork", artworkCheck: { status: "passed", checkedAt: AT }, state: "ready", objectKey: "client/art.pdf", references: [] },
    { fileId: "file_mock", ownerId: client.id, purpose: "mockup", state: "ready", objectKey: "client/mock.jpg", references: [] },
    { fileId: "file_qr", ownerId: client.id, purpose: "payment_proof", state: "ready", objectKey: "client/qr.jpg", references: [] },
  );
  return { store, client };
}

function caller(store, user, at = AT) {
  let sequence = 0;
  return async (method, pathname, body) => {
    const req = { method };
    await prepareArtworkCheckout({ req, pathname, store, user, checker: async () => ({ ok: true }) });
    return routeOrderMatch({ req, url: new URL(`http://gridgo.test${pathname}`), store, user,
      readBody: async () => body || {}, id: (prefix) => `${prefix}_${++sequence}`, now: () => at });
  };
}

test("a removed shop is not matched until its account is restored", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  const shop = store.users.find((row) => row.id === "supplier_a");
  const match = () => call("POST", "/me/matches", { subcategoryCode: "flyers" });
  assert.equal((await match()).body.shop.supplierId, "supplier_a");

  shop.accountStatus = "removed";
  const held = await match();
  assert.equal(held.status, 200);
  assert.equal(held.body.shop.supplierId, "supplier_b");
  assert.ok(held.body.listings.every((row) => row.supplierId !== "supplier_a"));

  shop.accountStatus = "active";
  assert.equal((await match()).body.shop.supplierId, "supplier_a");
});

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
      catalogItemId: "item_a", optionIds: [], quantity: 1, artworkFileId: "file_art",
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
    catalogItemId: "item_a", optionIds: [], quantity: 200, artworkFileId: "file_art",
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
        catalogItemId: "item_a", optionIds: [], quantity: 1, artworkFileId: "file_art",
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
    catalogItemId: "item_a2", optionIds: [], quantity: 1, artworkFileId: "file_art",
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
  assert.equal(committed.riderPayoutMinor, 7565);
  assert.equal(committed.platformDeliveryShareMinor, 1335);
  assert.equal(store.orderJobs[0].riderCommissionBps, 8500);
  assert.equal(store.orderJobs[0].riderPayoutMinor, 7565);
  store.settings.riderCommissionBps = 7000;
  assert.equal(committed.riderPayoutMinor, 7565);
  assert.equal(checkedOut.body.order.riderPayoutMinor, undefined);
  assert.equal(checkedOut.body.order.jobs[0].riderPayoutMinor, undefined);

  // Money first: Operations confirms the transfer before anything is checked.
  assert.equal(checkedOut.body.order.state, "initial_payment_review");
  assert.ok(checkedOut.body.order.readyBy, "the client is given a promised date at checkout");
  assert.equal(checkedOut.body.order.itemSubtotalMinor, 30_000);
  assert.equal(checkedOut.body.order.serviceFeeMinor, 3_000);
  assert.equal(checkedOut.body.order.deliveryFeeMinor, 8_900); // one shop, one delivery
  assert.equal(checkedOut.body.order.totalMinor, 41_900);
  // Paid in full up front: one transfer, and no balance left to owe.
  assert.equal(checkedOut.body.order.downpaymentPercent, 100);
  assert.deepEqual(checkedOut.body.order.paymentPlan, {
    method: "qr_manual",
    downpaymentPercent: 100,
    downpaymentMinor: 41_900,
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
    ["initial:supplier_principal:30000", "initial:service_fee:3000", "initial:delivery_pass_through:8900"],
  );
  // The split is the order's own, like the rider share: the setting moving
  // afterwards never changes what this client owes.
  store.settings.downpaymentPercent = 75;
  assert.equal(committed.payments.initial.amountMinor, 41_900);
  delete store.settings.downpaymentPercent;
  assert.equal(checkedOut.body.order.jobs.length, 1);
  assert.deepEqual(checkedOut.body.order.jobs.map((job) => job.deliveryFeeMinor), [8_900]);
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
  assert.equal(invoice.body.invoice.totalMinor, 41_900);
  assert.deepEqual(invoice.body.invoice.paymentPlan, { method: "qr_manual", downpaymentPercent: 100, downpaymentMinor: 41_900, balanceMinor: 0 });
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
  await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_a2", optionIds: [], quantity: 1, artworkFileId: "file_art" });
  const checkedOut = await call("POST", `/me/carts/${cartId}/checkout`, {
    payment: { method: "qr_manual", proofFileId: "file_qr", reference: "QR-123" },
  });
  assert.equal(checkedOut.status, 201);
  assert.deepEqual(checkedOut.body.order.paymentPlan, {
    method: "qr_manual",
    downpaymentPercent: 75,
    downpaymentMinor: 31_425,
    balanceMinor: 10_475,
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
    catalogItemId: "item_a2", optionIds: [], quantity: 1, artworkFileId: "file_art",
  });

  assert.equal(added.status, 201);
  assert.equal(added.body.cart.lines.length, 2);
  assert.deepEqual(added.body.cart.lines[0].listing, {
    id: "item_a",
    distanceZone: null,
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
    catalogItemId: "item_a2", optionIds: [], quantity: 1, artworkFileId: "file_art",
  });
  await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "item_a", optionIds: [], quantity: 1, artworkFileId: "file_art",
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

  const grouped = await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_b", optionIds: [], quantity: 1 });
  assert.deepEqual(grouped.body.cart.groups.map((group) => group.label), ["Shop A", "Shop B"]);
  assert.equal(grouped.body.cart.groups[0].lineIds.length, 3);
  assert.ok(grouped.body.cart.shops.every((shop) => !shop.supplierId && !shop.shop));

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
    catalogItemId: "item_a", optionIds: [], quantity: 1, artworkFileId: "file_art",
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
      catalogItemId: "item_a2", optionIds: [], quantity: 1, artworkFileId: "file_art",
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
    catalogItemId: "item_a", optionIds: [], quantity: 1, artworkFileId: "file_art",
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
      catalogItemId: "item_a", optionIds: [], quantity: 1, artworkFileId: "file_art",
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
    catalogItemId: "item_a", optionIds: [], quantity: 1, artworkFileId: "file_art",
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

const DESIGN_LINKS = [{ formatCode: "canva_link", url: "https://www.canva.com/design/ABC/edit" }];
function enableDesignLinks(store) {
  store.acceptedFileFormats.push({ code: "canva_link", inputKind: "url", active: true }, { code: "other_link", inputKind: "url", active: true });
  store.supplierServiceFileFormats.push({ supplierServiceId: "service_supplier_a", formatCode: "canva_link" });
}

test("cart artwork links survive add, partial patch and checkout into scoped artwork projections", async () => {
  const { store, client } = fixture();
  enableDesignLinks(store);
  const call = caller(store, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  const added = await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_a", optionIds: [], quantity: 1, artworkLinks: DESIGN_LINKS });
  const line = added.body.cart.lines[0];
  assert.deepEqual(line.artworkLinks, DESIGN_LINKS);
  const patched = await call("PATCH", `/me/carts/${cartId}/lines/${line.id}`, { quantity: 2 });
  assert.deepEqual(patched.body.cart.lines[0].artworkLinks, DESIGN_LINKS);
  const checkout = await call("POST", `/me/carts/${cartId}/checkout`, { payment: { method: "qr_manual", proofFileId: "file_qr", reference: "LINK-CHECKOUT" } });
  assert.equal(checkout.status, 201);
  assert.deepEqual(store.orderLineItems[0].artworkLinks, DESIGN_LINKS);
  assert.deepEqual(publicOrderFor(store.orders[0], client, store).productionItems[0].artworkLinks, DESIGN_LINKS);
  assert.deepEqual(store.orderInvoices[0].snapshot.lines[0].artworkLinks, DESIGN_LINKS);
});

test("artwork links enforce effective URL formats, shape and HTTPS on add/patch/checkout", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  const add = (artworkLinks) => call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_a", optionIds: [], quantity: 1, artworkLinks });
  await assert.rejects(add(DESIGN_LINKS), { code: "artwork_link_format_not_accepted" });
  enableDesignLinks(store);
  for (const links of [null, {}, [null], Array(4).fill(DESIGN_LINKS[0]), [{ formatCode: "pdf", url: "https://example.com" }], [{ formatCode: "canva_link", url: "https://canva.com.evil.test/design/a/edit" }], [{ formatCode: "canva_link", url: "http://canva.com/design/a/edit" }], [{ formatCode: "canva_link", url: `https://canva.com/${"a".repeat(2000)}` }], [{ formatCode: "canva_link", url: "https://user:password@canva.com/design/a/edit" }]]) {
    await assert.rejects(add(links), { code: "invalid_artwork_links" });
  }
  const lineId = (await add(DESIGN_LINKS)).body.cart.lines[0].id;
  await assert.rejects(call("PATCH", `/me/carts/${cartId}/lines/${lineId}`, { artworkLinks: [{ formatCode: "other_link", url: "https://example.com/design" }] }), { code: "artwork_link_format_not_accepted" });
  const cleared = await call("PATCH", `/me/carts/${cartId}/lines/${lineId}`, { artworkLinks: [] });
  assert.deepEqual(cleared.body.cart.lines[0].artworkLinks, []);
  await call("PATCH", `/me/carts/${cartId}/lines/${lineId}`, { artworkLinks: DESIGN_LINKS });
  store.supplierServiceFileFormats = store.supplierServiceFileFormats.filter((f) => f.formatCode !== "canva_link");
  await assert.rejects(call("POST", `/me/carts/${cartId}/checkout`, { payment: { method: "qr_manual", proofFileId: "file_qr", reference: "STALE-LINK" } }), { code: "artwork_link_format_not_accepted" });
});

test("listing overrides and inactive formats cannot inherit permission to accept artwork links", async () => {
  const { store, client } = fixture();
  enableDesignLinks(store);
  const call = caller(store, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  const item = store.catalogItems.find((row) => row.id === "item_a");
  item.fileFormatMode = "override";
  store.catalogItemFileFormats.push({ catalogItemId: item.id, formatCode: "pdf" });
  const add = () => call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: item.id, optionIds: [], quantity: 1, artworkLinks: DESIGN_LINKS });
  await assert.rejects(add(), { code: "artwork_link_format_not_accepted" });
  store.catalogItemFileFormats.push({ catalogItemId: item.id, formatCode: "canva_link" });
  assert.equal((await add()).status, 201);
  store.acceptedFileFormats.find((f) => f.code === "canva_link").active = false;
  await assert.rejects(add(), { code: "artwork_link_format_not_accepted" });
});

test("production links follow job scope for shops and riders, and all lines for client and Operations", () => {
  const order = { id: "order", clientId: "client" };
  const store = {
    orderJobs: [{ id: "a", orderId: "order", supplierId: "shop_a", riderId: "rider_a" }, { id: "b", orderId: "order", supplierId: "shop_b", riderId: "rider_b" }],
    orderLineItems: [{ id: "line_a", jobId: "a", orderId: "order", artworkLinks: DESIGN_LINKS }, { id: "line_b", jobId: "b", orderId: "order", artworkLinks: [{ formatCode: "other_link", url: "https://example.com/private-b" }] }],
  };
  for (const [role, id, count] of [["client", "client", 2], ["ops_admin", "ops", 2], ["super_admin", "super", 2], ["supplier", "shop_a", 1], ["rider", "rider_a", 1], ["supplier", "unrelated", 0], ["client", "other_client", 0]]) {
    const projected = publicOrderFor(order, { id, role }, store);
    assert.equal(projected.productionItems.length, count);
    if (count === 1) assert.deepEqual(projected.productionItems[0].artworkLinks, DESIGN_LINKS);
    if (count < 2) assert.equal(JSON.stringify(projected).includes("private-b"), false);
  }
});

test('Drive, Dropbox and WeTransfer codes survive cart patch and checkout with listing enforcement', async () => {
  const { store, client } = fixture();
  const links = [
    { formatCode: 'google_drive', url: 'https://drive.google.com/file/d/ABC/view' },
    { formatCode: 'dropbox', url: 'https://www.dropbox.com/s/ABC/file.pdf' },
    { formatCode: 'we_transfer', url: 'https://we.tl/t-ABC' },
  ];
  for (const link of links) {
    store.acceptedFileFormats.push({ code: link.formatCode, inputKind: 'url', active: true });
    store.supplierServiceFileFormats.push({ supplierServiceId: 'service_supplier_a', formatCode: link.formatCode });
  }
  const call = caller(store, client);
  const cartId = (await call('POST', '/me/carts', { fulfillmentMode: 'pickup' })).body.cart.id;
  const added = await call('POST', `/me/carts/${cartId}/lines`, { catalogItemId: 'item_a', optionIds: [], quantity: 1, artworkLinks: links });
  assert.deepEqual(added.body.cart.lines[0].artworkLinks, links);
  const patched = await call('PATCH', `/me/carts/${cartId}/lines/${added.body.cart.lines[0].id}`, { artworkLinks: links });
  assert.deepEqual(patched.body.cart.lines[0].artworkLinks, links);
  const placed = await call('POST', `/me/carts/${cartId}/checkout`, { payment: { method: 'qr_manual', proofFileId: 'file_qr', reference: 'PROVIDER-LINKS' } });
  assert.equal(placed.status, 201);
  assert.deepEqual(store.orderLineItems[0].artworkLinks, links);
  assert.deepEqual(store.orderInvoices[0].snapshot.lines[0].artworkLinks, links);
});

test('short-link preflight resolves only owned client cart writes and route revalidates after it', async () => {
  const { store, client } = fixture();
  enableDesignLinks(store);
  const call = caller(store, client);
  const cartId = (await call('POST', '/me/carts', { fulfillmentMode: 'pickup' })).body.cart.id;
  const body = { catalogItemId: 'item_a', optionIds: [], quantity: 1, artworkLinks: [{ formatCode: 'canva_link', url: 'https://canva.link/demo' }] };
  const pathname = `/me/carts/${cartId}/lines`;
  let checks = 0;
  const checker = async () => { checks++; return { url: 'https://www.canva.com/design/ABC/view', formatCode: 'canva_link' }; };
  const prepare = (user, method = 'POST', path = pathname, value = structuredClone(body)) => prepareCartArtworkLinks({ req: { method }, pathname: path, store, user, body: value, checker });
  await assert.rejects(prepare(null), { code: 'membership_required' });
  await assert.rejects(prepare({ id: 'other', role: 'client' }), { code: 'forbidden' });
  assert.equal(checks, 0);
  const normalized = structuredClone(body);
  await prepare(client, 'POST', pathname, normalized);
  assert.deepEqual(normalized.artworkLinks, [{ formatCode: 'canva_link', url: 'https://www.canva.com/design/ABC/view' }]);
  const added = await call('POST', pathname, normalized);
  assert.deepEqual(added.body.cart.lines[0].artworkLinks, normalized.artworkLinks);
  const patch = { artworkLinks: structuredClone(body.artworkLinks) };
  const linePath = `${pathname}/${added.body.cart.lines[0].id}`;
  await prepare(client, 'PATCH', linePath, patch);
  assert.deepEqual((await call('PATCH', linePath, patch)).body.cart.lines[0].artworkLinks, normalized.artworkLinks);
  store.supplierServiceFileFormats = [];
  await assert.rejects(call('PATCH', linePath, patch), { code: 'artwork_link_format_not_accepted' });
});

for (const [meters, key, label, km] of [
  [5000, "nearby", "Nearby"], [5001, "away", "Away"],
  [10000, "away", "Away"], [10001, "long_distance", "Long Distance"],
  [15000, "long_distance", "Long Distance"], [15001, "out_of_zone", "Out of Zone", 15],
  [20550, "out_of_zone", "Out of Zone", 20.6],
]) test(`client match at ${meters}m shows a zone and only Out of Zone listings show km`, async () => {
  const { store, client } = fixture();
  store.supplierProfiles[0].shop = { lat: 0, lng: 0, label: "Shop" };
  const dropoff = { lat: meters / 6371000 * 180 / Math.PI, lng: 0, label: "Drop" };
  const result = await caller(store, client)("POST", "/me/matches", {
    subcategoryCode: "flyers", excludedSupplierIds: ["supplier_b"], dropoff,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.distanceZone, { key, label });
  assert.deepEqual(result.body.listings[0].distanceZone, { key, label });
  assert.equal(result.body.listings[0].distanceKm, km);
  assert.equal(Object.hasOwn(result.body, "distanceKm"), false);
  assert.equal(Object.hasOwn(result.body.listings[0], "distanceKm"), km !== undefined);
  const serialized = JSON.stringify(result.body);
  assert.doesNotMatch(serialized, /distanceMeters|deliveryDistanceMeters|metres|kilometres|\d+ km/);
});

for (const [meters, key, label, feeMinor, km] of [
  [1200, 'nearby', 'Nearby', 8900], [1201, 'away', 'Away', 14900],
  [6500, 'away', 'Away', 14900], [6501, 'long_distance', 'Long Distance', 22900],
  [23000, 'long_distance', 'Long Distance', 22900], [23001, 'out_of_zone', 'Out of Zone', 40000, 23],
]) test(`custom zone limits label Top Pick, alternatives, and carts at ${meters}m`, async () => {
  const { store, client } = fixture();
  [1200, 6500, 23000].forEach((limit, index) => { store.settings.deliveryFeeBands[index].maxDistanceMeters = limit; });
  for (const profile of store.supplierProfiles) profile.shop = { lat: 0, lng: 0, label: 'Shop' };
  const dropoff = { lat: meters / 6371000 * 180 / Math.PI, lng: 0, label: 'Drop' };
  const call = caller(store, client);
  const match = await call('POST', '/me/matches', { subcategoryCode: 'flyers', dropoff, ranking: ['distance', 'cost', 'speed', 'quality'] });
  assert.deepEqual(match.body.distanceZone, { key, label });
  assert.equal(match.body.reasons.find(reason => reason.factor === 'distance').detail, label);
  for (const listing of [...match.body.listings, ...match.body.otherListings]) {
    assert.deepEqual(listing.distanceZone, { key, label });
    assert.equal(listing.distanceKm, km);
  }
  assert.ok(match.body.otherListings.length > 0);
  const cartId = (await call('POST', '/me/carts', { fulfillmentMode: 'delivery', defaultDropoff: dropoff })).body.cart.id;
  await call('POST', `/me/carts/${cartId}/lines`, { catalogItemId: 'item_a', optionIds: [], quantity: 1, artworkFileId: 'file_art' });
  const cart = (await call('GET', `/me/carts/${cartId}`)).body.cart;
  assert.deepEqual(cart.lines[0].listing.distanceZone, { key, label });
  assert.equal(cart.lines[0].listing.distanceKm, km);
  const placed = await call('POST', `/me/carts/${cartId}/checkout`, {
    payment: { method: 'qr_manual', proofFileId: 'file_qr', reference: 'CUSTOM-ZONE-LIMITS' },
  });
  assert.equal(placed.status, 201);
  assert.equal(placed.body.order.deliveryFeeMinor, feeMinor);
  assert.equal(store.orderJobs[0].deliveryFeeMinor, feeMinor);
});

for (const count of [0, 4, 5, 6]) test(`match rating is ${count >= 5 ? "shown" : "omitted"} for ${count} reviews`, async () => {
  const { store, client } = fixture();
  store.shopReviews = Array.from({ length: count }, (_, index) => ({ supplierId: "supplier_a", qualityStars: index === 0 ? 4 : 5 }));
  const result = await caller(store, client)("POST", "/me/matches", { subcategoryCode: "flyers", excludedSupplierIds: ["supplier_b"] });
  for (const card of [result.body, ...result.body.listings]) {
    assert.equal(Object.hasOwn(card, "rating"), count >= 5);
    if (count >= 5) assert.deepEqual(card.rating, { average: 4.8, count });
    assert.equal(card.distanceZone, null, "no pin means no inferred zone");
  }
});

test("Out of Zone stays available, cart listings carry zones and ratings, checkout snapshots the full-distance fee", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  store.supplierProfiles[0].shop = { lat: 0, lng: 0, label: "Shop" };
  store.shopReviews = Array.from({ length: 5 }, () => ({ supplierId: "supplier_a", qualityStars: 5 }));
  const dropoff = { lat: 16001 / 6371000 * 180 / Math.PI, lng: 0, label: "Home" };
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "delivery", defaultDropoff: dropoff })).body.cart.id;
  const added = await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_a", optionIds: [], quantity: 1, artworkFileId: "file_art" });
  const full = await call("GET", `/me/carts/${cartId}`);
  for (const response of [added, full]) {
    const listing = response.body.cart.lines[0].listing;
    assert.deepEqual(listing.distanceZone, { key: "out_of_zone", label: "Out of Zone" });
    assert.equal(listing.distanceKm, 16);
    assert.deepEqual(listing.rating, { average: 5, count: 5 });
    assert.equal(Object.hasOwn(listing, "distanceMeters"), false);
  }
  const placed = await call("POST", `/me/carts/${cartId}/checkout`, {
    payment: { method: "qr_manual", proofFileId: "file_qr", reference: "OUT-OF-ZONE" },
  });
  assert.equal(placed.status, 201);
  assert.equal(placed.body.order.deliveryFeeMinor, 29500);
  const order = store.orders.find((row) => row.id === placed.body.order.id);
  assert.equal(order.riderPayoutMinor, 25075);
  assert.equal(order.platformDeliveryShareMinor, 4425);
  assert.equal(store.orderJobs[0].deliveryDistanceMeters, 16001);
  store.settings.deliveryFeeBands[3].perKmMinor = 2000;
  store.settings.deliveryFeeBands[2].maxDistanceMeters = 23000;
  const refreshedCart = (await call('GET', `/me/carts/${cartId}`)).body.cart;
  assert.deepEqual(refreshedCart.lines[0].listing.distanceZone, { key: 'long_distance', label: 'Long Distance' });
  assert.equal(publicOrderFor(order, client, store).deliveryFeeMinor, 29500);
  assert.equal(store.orderJobs[0].deliveryFeeMinor, 29500);
});

test("anonymous alternatives select the right shop with request-bound tokens and preserve saved preferences", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  await call("PUT", "/me/preferences", { ranking: ["cost", "speed", "quality", "distance"] });
  const ranking = ["quality", "speed", "cost", "distance"];
  const dropoff = { lat: 7.07, lng: 125.61, label: "Home" };
  const deadline = "2026-09-05T00:00:00.000Z";
  const match = (await call("POST", "/me/matches", { subcategoryCode: "flyers", ranking, dropoff, deadline })).body;
  assert.deepEqual(match.ranking, ranking);
  assert.equal((await call("GET", "/me/preferences")).body.preferences.ranking[0], "cost");
  assert.equal((await call("POST", "/me/matches", { subcategoryCode: "flyers" })).body.ranking[0], "cost");
  assert.equal(match.shop.supplierId, "supplier_a");
  assert.ok(match.listings[0].supplierId, "legacy Top Pick fields remain");
  for (const key of ["queue", "reasons", "score", "promiseBy", "alternativesCount"]) assert.ok(Object.hasOwn(match, key));
  assert.equal(match.otherListings.length, 1);
  const other = match.otherListings[0];
  assert.equal(other.id, "item_b");
  const forbidden = /^(supplierId|supplierServiceId|shopName|shop|address|addressLine|contactName|contact|logo|email|phone|objectKey|altText)$/;
  function check(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) { assert.equal(forbidden.test(key), false, key); check(child); }
  }
  check(other);
  assert.match(other.selectToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(store.matchSelections).includes(other.selectToken), false, "only token digests persist");
  const cart = (await call("POST", "/me/carts", { defaultDropoff: dropoff })).body.cart;
  const selection = { selectToken: other.selectToken, matchRequestId: match.matchRequestId, optionIds: [], quantity: 10 };
  await assert.rejects(call("POST", `/me/carts/${cart.id}/lines`, { ...selection, matchRequestId: "another-request" }), (e) => e.code === "select_token_request_mismatch");
  await assert.rejects(call("POST", `/me/carts/${cart.id}/lines`, { ...selection, catalogItemId: "item_a" }), (e) => e.code === "select_token_listing_mismatch");
  await assert.rejects(call("POST", `/me/carts/${cart.id}/lines`, { ...selection, dropoff: { ...dropoff, lat: 8 } }), (e) => e.code === "select_token_dropoff_mismatch");
  const foreign = { id: "foreign", role: "client" };
  const foreignCart = { ...store.carts[0], id: "foreign_cart", clientId: foreign.id };
  store.carts.push(foreignCart);
  await assert.rejects(caller(store, foreign)("POST", "/me/carts/foreign_cart/lines", selection), (e) => e.status === 403 && e.code === "foreign_select_token");
  await assert.rejects(caller(store, client, "2026-08-24T01:15:00.000Z")("POST", `/me/carts/${cart.id}/lines`, selection), (e) => e.status === 410 && e.code === "select_token_expired");
  const added = await call("POST", `/me/carts/${cart.id}/lines`, selection);
  assert.equal(added.status, 201);
  assert.equal(store.cartLines[0].supplierId, "supplier_b");
  assert.deepEqual(store.cartLines[0].dropoff, dropoff);
  assert.equal(store.cartLines[0].matchDeadline, deadline);
  assert.equal(store.cartLines[0].catalogItemId, "item_b");
  assert.equal((await call("POST", `/me/carts/${cart.id}/lines`, { ...selection, selectToken: match.listings[0].selectToken })).status, 201);
});

test("token selection rechecks changed listing availability and deadline", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  const deadline = "2026-08-29T00:00:00.000Z";
  const match = (await call("POST", "/me/matches", { subcategoryCode: "flyers", deadline })).body;
  const cart = (await call("POST", "/me/carts", {})).body.cart;
  const body = { selectToken: match.otherListings[0].selectToken, matchRequestId: match.matchRequestId, quantity: 1, optionIds: [] };
  store.orderJobs.push({ id: "new_queue", supplierId: "supplier_b", state: "production", estimatedHours: 300 });
  await assert.rejects(call("POST", `/me/carts/${cart.id}/lines`, body), (e) => e.code === "deadline_not_met");
  store.catalogItems.find((row) => row.id === "item_b").active = false;
  await assert.rejects(call("POST", `/me/carts/${cart.id}/lines`, body), (e) => e.code === "catalog_item_stale");
});

test("selection rejects malformed/unknown tokens and cart rebinding; labels are not location identity", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  const first = (await call("POST", "/me/carts", {})).body.cart;
  const second = (await call("POST", "/me/carts", {})).body.cart;
  const match = (await call("POST", "/me/matches", { cartId: first.id, subcategoryCode: "flyers", dropoff: { lat: 7.07, lng: 125.61, label: "Home" } })).body;
  const body = { selectToken: match.otherListings[0].selectToken, matchRequestId: match.matchRequestId, quantity: 1, optionIds: [] };
  for (const selectToken of [null, "garbage", "a".repeat(43)]) {
    await assert.rejects(call("POST", `/me/carts/${first.id}/lines`, { ...body, selectToken }), (e) => e.status === 400 && e.code === "invalid_select_token");
  }
  await assert.rejects(call("POST", `/me/carts/${second.id}/lines`, body), (e) => e.code === "select_token_cart_mismatch");
  store.supplierProfiles.find((row) => row.userId === "supplier_b").isClosed = true;
  await assert.rejects(call("POST", `/me/carts/${first.id}/lines`, body), (e) => e.code === "catalog_item_stale");
  store.supplierProfiles.find((row) => row.userId === "supplier_b").isClosed = false;
  assert.equal((await call("POST", `/me/carts/${first.id}/lines`, { ...body, dropoff: { lat: 7.07, lng: 125.61 } })).status, 201);
});

for (const [count, mode] of [[2, "delivery"], [3, "delivery"], [2, "pickup"]]) {
  test(`multi-shop ${mode} checkout creates ${count} independent ledgers with one anonymous receipt`, async () => {
    const { store, client } = fixture();
    if (count === 3) addPublicListing(store, { supplierId: 'supplier_c', itemId: 'item_c', priceMinor: 10_005,
      shop: { lat: 7.07, lng: 125.62, label: 'Private counter' }, turnaroundHours: 12 });
    store.settings.downpaymentPercent = 75;
    for (const item of store.catalogItems) item.name = "Flyers";
    const call = caller(store, client);
    const deadline = '2026-09-10T00:00:00.000Z';
    const cart = (await call('POST', '/me/carts', { deadline, fulfillmentMode: mode,
      defaultDropoff: { lat: 7.08, lng: 125.62, label: 'Destination' } })).body.cart;
    for (const item of ['item_a', 'item_b', 'item_c'].slice(0, count)) {
      await call('POST', `/me/carts/${cart.id}/lines`, { catalogItemId: item, artworkFileId: 'file_art', optionIds: [], quantity: 1, artworkFileId: 'file_art' });
    }
    const preview = (await call('GET', `/me/carts/${cart.id}`)).body.cart;
    const placed = (await call('POST', `/me/carts/${cart.id}/checkout`, { payment: {
      method: 'qr_manual', reference: 'COMBINED', proofFileId: 'file_qr',
    } })).body;
    assert.equal(store.orders.length, count);
    assert.equal(store.orderJobs.length, count);
    assert.equal(store.orderInvoices.length, 1);
    assert.equal(store.notifications.filter((row) => row.type === 'order_receipt_ready').length, 1);
    assert.equal(placed.basket.totalMinor, preview.groups.reduce((sum, group) => sum + group.totalMinor, 0));
    assert.equal(placed.invoice.totalMinor, placed.basket.totalMinor);
    assert.deepEqual(placed.invoice.groups.map((group) => group.label), ['Shop A', 'Shop B', 'Shop C'].slice(0, count));
    assert.ok(!JSON.stringify(placed).includes('supplier_a'));
    assert.ok(!JSON.stringify(preview).includes('supplier_b'));
    for (const order of store.orders) {
      assert.equal(order.downpaymentPercent, 100);
      assert.equal(order.payments.final_online.status, 'not_required');
      assert.equal(order.payments.initial.amountMinor, order.totalMinor);
      assert.equal(order.payoutMilestones.reduce((sum, stage) => sum + stage.amountMinor, 0), order.supplierSubtotalMinor);
      assert.equal(order.riderPayoutMinor + order.platformDeliveryShareMinor, order.deliveryFeeMinor);
      assert.equal(order.riderCommissionBps, 8500);
      assert.equal((await call('GET', `/orders/${order.id}/invoice`)).body.invoice.invoiceNumber, placed.invoice.invoiceNumber);
    }
  });
}

test('route checkout cannot trust a client verdict or omit its server preflight', async () => {
  const { store, client } = fixture();
  enableDesignLinks(store);
  const call = caller(store, client);
  const cartId = (await call('POST', '/me/carts', { fulfillmentMode: 'pickup' })).body.cart.id;
  await call('POST', `/me/carts/${cartId}/lines`, { catalogItemId: 'item_a', optionIds: [], quantity: 1, artworkLinks: DESIGN_LINKS });
  await assert.rejects(routeOrderMatch({ req: { method: 'POST' }, url: new URL(`http://gridgo.test/me/carts/${cartId}/checkout`), store, user: client,
    readBody: async () => ({ artworkCheck: { ok: true }, payment: { method: 'qr_manual', proofFileId: 'file_qr', reference: 'UNTRUSTED-CHECK' } }),
    id: prefix => `${prefix}_untrusted`, now: () => AT }), { code: 'artwork_check_required' });
});

for (const fulfillmentMode of ["delivery", "pickup"]) {
  test(`pre-match ${fulfillmentMode} carries the destination and charge through read-only checkout`, async () => {
    const { store, client } = fixture();
    const call = caller(store, client);
    const dropoff = { lat: 7.28, lng: 125.62, label: "Recipient" };
    store.settings.hubPickup = { schedule: { utcOffsetMinutes: 480, week: [{ weekday: 1, opensMinute: 540, closesMinute: 1020 }], closures: [] }, feeMinor: 2500 };
    const match = await call("POST", "/me/matches", { subcategoryCode: "flyers", fulfillmentMode, dropoff, deadline: "2026-09-01T00:00:00Z" });
    const selected = match.body.listings[0];
    const choice = match.body.requestFulfillment;
    assert.equal(choice.fulfillmentMode, fulfillmentMode);
    assert.deepEqual(choice.dropoff, fulfillmentMode === "delivery" ? dropoff : {
      lat: 7.092287234449552, lng: 125.61651084538697, label: "GRIDGO Office",
    });
    assert.equal(selected.distanceZone.key, fulfillmentMode === "delivery" ? "out_of_zone" : "nearby");
    const created = await call("POST", "/me/carts", {});
    const cartId = created.body.cart.id;
    const added = await call("POST", `/me/carts/${cartId}/lines`, {
      selectToken: selected.selectToken, matchRequestId: match.body.matchRequestId,
      optionIds: [], quantity: 1, artworkFileId: "file_art",
    });
    assert.deepEqual(added.body.cart.requestFulfillment, choice);
    assert.equal(added.body.cart.fulfillmentMode, fulfillmentMode);
    const quote = (await call("GET", `/me/carts/${cartId}/quote`)).body.quote;
    assert.equal(quote.deliveryFeeMinor, selected.deliveryFeeMinor);
    assert.equal(quote.totalMinor, quote.clientItemSubtotalMinor + quote.deliveryFeeMinor);
    assert.equal(added.body.cart.clientQuote.totalMinor, quote.totalMinor);
    for (const field of ["supplierSubtotalMinor", "shop", "shopName", "pickup", "unitRateMinor"]) {
      assert.equal(Object.hasOwn(quote, field), false, field);
    }
    const lineId = added.body.cart.lines[0].id;
    for (const [method, path, body] of [
      ["PATCH", `/me/carts/${cartId}`, { fulfillmentMode: fulfillmentMode === "delivery" ? "pickup" : "delivery" }],
      ["PUT", `/me/carts/${cartId}/fulfillment`, { fulfillmentMode: fulfillmentMode === "delivery" ? "pickup" : "delivery" }],
      ["PUT", `/me/carts/${cartId}/dropoffs`, { defaultDropoff: { ...dropoff, lat: 7.4 } }],
      ["PUT", `/me/carts/${cartId}/dropoffs`, { lines: [{ lineId, dropoff: { ...dropoff, lat: 7.4 } }] }],
      ["PATCH", `/me/carts/${cartId}/lines/${lineId}`, { dropoff: { ...dropoff, lat: 7.4 } }],
      ["POST", `/me/carts/${cartId}/checkout`, { fulfillmentMode: fulfillmentMode === "delivery" ? "pickup" : "delivery" }],
      ["POST", `/me/carts/${cartId}/quote`, { fulfillmentMode: fulfillmentMode === "delivery" ? "pickup" : "delivery" }],
      ["POST", `/me/carts/${cartId}/quote`, { lines: [{ lineId, dropoff: { ...dropoff, lat: 7.4 } }] }],
    ]) {
      await assert.rejects(call(method, path, body), (error) => error.code === "request_fulfillment_locked");
    }
    const checked = await call("POST", `/me/carts/${cartId}/checkout`, {
      payment: { method: "qr_manual", proofFileId: "file_qr", reference: "TEST-123" },
    });
    const order = checked.body.order;
    assert.deepEqual(order.requestFulfillment, choice);
    assert.equal(order.deliveryFeeMinor, selected.deliveryFeeMinor);
    assert.equal(order.totalMinor, quote.totalMinor);
    assert.equal(checked.body.invoice.clientItemSubtotalMinor, quote.clientItemSubtotalMinor);
    assert.equal(order.totalMinor, order.itemSubtotalMinor + order.serviceFeeMinor + order.deliveryFeeMinor);
    if (fulfillmentMode === "pickup") {
      assert.equal(order.pickupFeeMinor, 2500);
      assert.deepEqual(order.hubPickup, match.body.hubPickup);
      assert.equal(store.orders[0].riderPayoutMinor, 0);
      assert.equal(store.orders[0].platformDeliveryShareMinor, 2500);
      const storedOrder = store.orders[0];
      storedOrder.payments.initial.status = "confirmed";
      assert.equal(moneyReportingForOrder(storedOrder).platformRevenue.collectedMinor, order.serviceFeeMinor + 2500);
      const refund = calculateRefundSettlement(storedOrder, {
        beforeProduction: true, shopEntitlementMinor: 0, riderEntitlementMinor: 0,
      });
      assert.equal(refund.totalMinor, order.totalMinor);
      assert.equal(refund.deliveryMinor, 2500);
      store.settings.hubPickup.feeMinor = 9999;
      assert.equal(order.pickupFeeMinor, 2500);
      assert.equal(checked.body.invoice.pickupFeeMinor, 2500);
    }
  });
}

test('a later shop missing the basket deadline rejects checkout, and matching uses the basket deadline', async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  const deadline = '2026-08-29T00:00:00.000Z';
  const cart = (await call('POST', '/me/carts', { fulfillmentMode: 'pickup', deadline })).body.cart;
  for (const item of ['item_a', 'item_b']) await call('POST', `/me/carts/${cart.id}/lines`, { catalogItemId: item, artworkFileId: 'file_art', optionIds: [], quantity: 1 });
  for (const service of store.supplierServices.filter((service) => service.supplierId === 'supplier_b')) {
    service.turnaroundHours = 500; service.standardTurnaroundHours = 500;
  }
  const match = (await call('POST', '/me/matches', { cartId: cart.id, subcategoryCode: 'flyers' })).body;
  assert.ok([...match.listings, ...match.otherListings].every((item) => item.id !== 'item_b'));
  assert.equal((await call('POST', '/me/matches', { cartId: cart.id, subcategoryCode: 'flyers', deadline: '2026-09-20T00:00:00Z' })).status, 200);
  await assert.rejects(call('POST', `/me/carts/${cart.id}/checkout`, { payment: { method: 'qr_manual', proofFileId: 'file_qr', reference: 'LATE' } }), { code: 'deadline_not_met' });
});

test('add-more matching uses an opaque cart group and preserves one delivery charge', async () => {
  const { store, client } = fixture();
  for (const item of store.catalogItems) item.name = 'Flyers';
  const call = caller(store, client);
  const cart = (await call('POST', '/me/carts', { fulfillmentMode: 'delivery', deadline: '2026-09-10T00:00:00Z',
    defaultDropoff: { lat: 7.08, lng: 125.62, label: 'Destination' } })).body.cart;
  for (const item of ['item_a', 'item_b']) await call('POST', `/me/carts/${cart.id}/lines`, { catalogItemId: item, artworkFileId: 'file_art', quantity: 1, optionIds: [] });
  const before = (await call('GET', `/me/carts/${cart.id}`)).body.cart;
  const match = (await call('POST', '/me/matches', { cartId: cart.id, groupId: before.groups[0].id, subcategoryCode: 'brochures' })).body;
  assert.equal(match.listings[0].id, 'item_a2');
  assert.equal(match.shop.label, 'Shop A');
  assert.equal(match.shop.supplierId, undefined);
  assert.equal(match.listings[0].supplierId, undefined);
  const after = (await call('POST', `/me/carts/${cart.id}/lines`, { selectToken: match.listings[0].selectToken,
    matchRequestId: match.matchRequestId, optionIds: [], quantity: 1 })).body.cart;
  assert.equal(after.groups.length, 2);
  assert.equal(after.groups[0].lineIds.length, 2);
  assert.equal(after.groups[0].deliveryFeeMinor, before.groups[0].deliveryFeeMinor);
  await assert.rejects(call('POST', '/me/matches', { cartId: cart.id, groupId: 'foreign', subcategoryCode: 'flyers' }), { code: 'cart_group_not_found' });
});

test('basket payment reconciliation never restarts a cancelled group', async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  const cart = (await call('POST', '/me/carts', { fulfillmentMode: 'pickup', deadline: '2026-09-10T00:00:00Z' })).body.cart;
  for (const item of ['item_a', 'item_b']) await call('POST', `/me/carts/${cart.id}/lines`, { catalogItemId: item, artworkFileId: 'file_art', quantity: 1, optionIds: [] });
  const placed = (await call('POST', `/me/carts/${cart.id}/checkout`, { payment: { method: 'qr_manual', reference: 'RECONCILE', proofFileId: 'file_qr' } })).body;
  store.orders[1].state = 'cancelled';
  let seq = 0;
  const result = await routeBaskets({ req: { method: 'POST' }, url: new URL(`http://gridgo.test/baskets/${placed.basket.id}/payment/confirm`),
    store, user: { id: 'ops', role: 'ops_admin' }, readBody: async () => ({}), id: () => `audit_reconcile_${++seq}`, now: () => AT });
  assert.equal(result.status, 200);
  assert.deepEqual(store.orders.map((order) => order.state), ['needs_qa', 'cancelled']);
  assert.ok(store.orders.every((order) => order.payments.initial.status === 'confirmed'));
});

test('add-more matching filters capacity already consumed by the same draft group', async () => {
  const { store, client } = fixture();
  store.settings.promiseAllowanceMinutes = 0;
  const service = store.supplierServices.find((row) => row.supplierId === 'supplier_a');
  Object.assign(service, { capacityDaily: 10, turnaroundHours: 1, standardTurnaroundHours: 1 });
  const call = caller(store, client);
  const deadline = '2026-08-24T10:00:00.000Z';
  const created = await call('POST', '/me/carts', { fulfillmentMode: 'pickup', deadline });
  const cartId = created.body.cart.id;
  const added = await call('POST', `/me/carts/${cartId}/lines`, { catalogItemId: 'item_a', quantity: 10, optionIds: [] });
  await assert.rejects(call('POST', '/me/matches', { cartId, groupId: added.body.cart.groups[0].id,
    subcategoryCode: 'flyers', units: 1 }), (error) => error.code === 'deadline_not_met' || error.code === 'match_not_found');
});

test("explicit delivery needs a destination even without distance-first ranking; legacy matches remain accepted", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  await assert.rejects(call("POST", "/me/matches", { subcategoryCode: "flyers", fulfillmentMode: "delivery" }), (error) => error.code === "dropoff_required");
  await assert.rejects(call("POST", "/me/matches", { subcategoryCode: "flyers", fulfillmentMode: "invalid" }), (error) => error.code === "invalid_fulfillment_mode");
  assert.equal((await call("POST", "/me/matches", { subcategoryCode: "flyers" })).status, 200);
  const pickup = await call("POST", "/me/matches/next", { subcategoryCode: "flyers", fulfillmentMode: "pickup", excludedSupplierIds: ["supplier_b"] });
  assert.equal(pickup.body.hubPickup.feeMinor, 0);
  assert.equal(pickup.body.hubPickup.schedule, null);
  assert.equal(pickup.body.listings[0].deliveryFeeMinor, 0);
});


test("legacy pickup carts remain free and editable after Super Admin sets a hub fee", async () => {
  const { store, client } = fixture();
  store.settings.hubPickup.feeMinor = 2500;
  const call = caller(store, client);
  const created = await call("POST", "/me/carts", { fulfillmentMode: "pickup" });
  const cartId = created.body.cart.id;
  await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_a", quantity: 1, optionIds: [], artworkFileId: "file_art" });
  await call("PUT", `/me/carts/${cartId}/fulfillment`, { fulfillmentMode: "delivery" });
  await call("PUT", `/me/carts/${cartId}/fulfillment`, { fulfillmentMode: "pickup" });
  const checked = await call("POST", `/me/carts/${cartId}/checkout`, {
    payment: { method: "qr_manual", proofFileId: "file_qr", reference: "TEST-123" },
  });
  assert.equal(checked.body.order.deliveryFeeMinor, 0);
  assert.equal(checked.body.order.pickupFeeMinor, undefined);
  assert.equal(checked.body.order.requestFulfillment, undefined);
});

test("listing quotes price measured selections on the server without supplier figures", async () => {
  const { store, client } = fixture();
  const item = store.catalogItems[0];
  Object.assign(item, { pricingUnit: "per_area", measureUnit: "ft", basePriceMinor: 105 });
  const call = caller(store, client);
  const response = await call("POST", "/me/catalog-quotes", {
    catalogItemId: item.id, quantity: 3, measurement: { width: 1500, height: 1000 },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.quote, {
    catalogItemId: item.id, version: 1, serviceVersion: 1, quantity: 3,
    clientUnitRateMinor: 116, clientLineSubtotalMinor: 520,
    billableMilliUnits: 4500, minimumMeasurementApplied: false,
  });
  assert.equal(response.mutated, false);
  await assert.rejects(() => call("POST", "/me/catalog-quotes", {
    catalogItemId: item.id, quantity: 3,
  }), (error) => error.status === 400);
});

test("basket quotes use the farthest dropoff, agree with checkout, and never expose the origin", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  const cart = (await call("POST", "/me/carts", { defaultDropoff: { lat: 7.064, lng: 125.6085, label: "Destination" } })).body.cart;
  await call("POST", `/me/carts/${cart.id}/lines`, { catalogItemId: "item_a", quantity: 1, optionIds: [], artworkFileId: "file_art" });
  await call("POST", `/me/carts/${cart.id}/lines`, { catalogItemId: "item_a2", quantity: 1, optionIds: [], artworkFileId: "file_art", dropoff: { lat: 7.14, lng: 125.6085, label: "Destination" } });
  const quoted = await call("GET", `/me/carts/${cart.id}/quote`);
  assert.equal(quoted.status, 200);
  const quote = quoted.body.quote;
  assert.equal(quote.clientItemSubtotalMinor, 33000);
  assert.equal(quote.deliveryLines.length, 1);
  assert.equal(quote.deliveryLines[0].lineIds.length, 2);
  assert.deepEqual(quote.deliveryLines[0].distanceZone, { key: "away", label: "Away" });
  assert.equal(quote.deliveryFeeMinor, 14900);
  for (const field of ["shop", "shopName", "pickup", "supplierSubtotalMinor", "basePriceMinor", "distanceMeters", "distanceKm"]) {
    assert.equal(JSON.stringify(quote).includes(`"${field}"`), false, field);
  }
  const checked = await call("POST", `/me/carts/${cart.id}/checkout`, {
    payment: { method: "qr_manual", proofFileId: "file_qr", reference: "QUOTE-PARITY" },
  });
  assert.equal(quote.totalMinor, checked.body.order.totalMinor);
  assert.equal(quote.deliveryFeeMinor, checked.body.order.deliveryFeeMinor);
  assert.equal(quote.downpaymentMinor, checked.body.invoice.paymentPlan.downpaymentMinor);
});

test("basket quote preview does not save dropoffs and missing destinations stay unpriced", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  const cart = (await call("POST", "/me/carts", {})).body.cart;
  await call("POST", `/me/carts/${cart.id}/lines`, { catalogItemId: "item_a", quantity: 1, optionIds: [] });
  const before = structuredClone(store);
  const missing = (await call("GET", `/me/carts/${cart.id}/quote`)).body.quote;
  assert.equal(missing.deliveryFeeMinor, null);
  assert.equal(missing.totalMinor, null);
  const preview = await call("POST", `/me/carts/${cart.id}/quote`, { defaultDropoff: { lat: 8, lng: 125.6, label: "Destination" } });
  assert.equal(preview.body.quote.deliveryLines[0].distanceZone.key, "out_of_zone");
  assert.ok(preview.body.quote.deliveryLines[0].distanceKm > 20);
  const pickup = await call("POST", `/me/carts/${cart.id}/quote`, { fulfillmentMode: "pickup" });
  assert.equal(pickup.body.quote.deliveryFeeMinor, 0);
  assert.equal(pickup.body.quote.totalMinor, 11000);
  assert.deepEqual(store, before);
  await assert.rejects(() => caller(store, { id: "another", role: "client" })("GET", `/me/carts/${cart.id}/quote`), (e) => e.status === 403);
});

test("basket quote rounds the aggregate once, preserves 75 percent installments and refuses unavailable lines", async () => {
  const { store, client } = fixture();
  store.settings.downpaymentPercent = 75;
  store.catalogItems[0].basePriceMinor = 5;
  store.catalogItems[1].basePriceMinor = 5;
  const call = caller(store, client);
  const cart = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart;
  await call("POST", `/me/carts/${cart.id}/lines`, { catalogItemId: "item_a", quantity: 1, optionIds: [], artworkFileId: "file_art" });
  const added = await call("POST", `/me/carts/${cart.id}/lines`, { catalogItemId: "item_a2", quantity: 1, optionIds: [], artworkFileId: "file_art" });
  assert.deepEqual(added.body.cart.lines.map((line) => line.clientLineSubtotalMinor), [6, 6]);
  assert.equal(added.body.cart.clientQuote.clientItemSubtotalMinor, 11);
  assert.equal(added.body.cart.clientQuote.downpaymentMinor, 8);
  assert.equal(added.body.cart.clientQuote.balanceMinor, 3);
  store.catalogItems[0].active = false;
  const stale = (await call("GET", `/me/carts/${cart.id}/quote`)).body.quote;
  assert.equal(stale.totalMinor, null);
  assert.equal(stale.clientItemSubtotalMinor, null);
  assert.equal(stale.reasons[0].code, "catalog_item_stale");
  store.catalogItems[0].active = true;
  const checkout = await call("POST", `/me/carts/${cart.id}/checkout`, {
    payment: { method: "qr_manual", proofFileId: "file_qr", reference: "ROUNDING-PARITY" },
  });
  assert.equal(checkout.body.order.totalMinor, 11);
  assert.equal(checkout.body.invoice.paymentPlan.downpaymentMinor, 8);
});

test("listing quotes enforce options, quantity tiers, multipliers, minimums and current listing eligibility", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  const item = store.catalogItems[0];
  item.minimumOrderQuantity = 10;
  store.catalogPriceTiers = [{ catalogItemId: item.id, minQuantity: 10, unitPriceMinor: 105 }];
  store.catalogOptionGroups.push({ id: "finish", catalogItemId: item.id, required: true, kind: "spec" });
  store.catalogOptions.push({ id: "double", optionGroupId: "finish", priceModifierMinor: 0, priceMultiplierBps: 20000 });
  const input = { catalogItemId: item.id, quantity: 10, optionIds: ["double"] };
  assert.equal((await call("POST", "/me/catalog-quotes", input)).body.quote.clientLineSubtotalMinor, 2310);
  for (const [patch, code] of [
    [{ quantity: 9 }, "below_minimum_quantity"],
    [{ optionIds: [] }, "invalid_catalog_options"],
    [{ optionIds: ["unknown"] }, "invalid_catalog_options"],
    [{ speedTierId: "arbitrary" }, "invalid_service_level"],
  ]) {
    await assert.rejects(() => call("POST", "/me/catalog-quotes", { ...input, ...patch }), (error) => error.code === code);
  }
  item.active = false;
  await assert.rejects(() => call("POST", "/me/catalog-quotes", input), (error) => error.status === 404);
});

test("invoice client amounts use immutable invoice pricing after the live fee changes", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  const cart = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart;
  await call("POST", `/me/carts/${cart.id}/lines`, { catalogItemId: "item_a", quantity: 2, optionIds: [], artworkFileId: "file_art" });
  const checked = await call("POST", `/me/carts/${cart.id}/checkout`, {
    payment: { method: "qr_manual", proofFileId: "file_qr", reference: "INVOICE-QUOTE" },
  });
  assert.equal(checked.body.invoice.clientItemSubtotalMinor, 22000);
  assert.equal(checked.body.invoice.lines[0].clientAmountMinor, 22000);
  assert.equal(checked.body.invoice.lines[0].clientUnitPriceMinor, 11000);
  const saved = structuredClone(store.orderInvoices);
  store.settings.serviceFeeRateBps = 4500;
  const invoice = (await call("GET", `/orders/${checked.body.order.id}/invoice`)).body.invoice;
  assert.equal(invoice.clientItemSubtotalMinor, 22000);
  assert.equal(invoice.lines[0].clientAmountMinor, 22000);
  assert.equal(invoice.lines[0].clientUnitPriceMinor, 11000);
  assert.equal(invoice.lines[0].amountMinor, 20000);
  assert.deepEqual(store.orderInvoices, saved);
  assert.equal((await call("GET", `/me/carts/${cart.id}`)).body.cart.clientQuote, null);
  await assert.rejects(() => call("GET", `/me/carts/${cart.id}/quote`), (error) => error.code === "cart_checked_out");
});

test("listing review: carts and checkout use approved prices while preserving the supplier draft", async () => {
  const { routeSupplierCatalog } = await import("../src/catalog-routes.js");
  const { store, client } = fixture();
  const call = caller(store, client);
  await routeSupplierCatalog({ req: { method: "PATCH" }, url: new URL("http://localhost/me/catalog-items/item_a"), store,
    user: store.users.find(row => row.id === "supplier_a"), readBody: async () => ({ expectedVersion: 1, basePriceMinor: 99000 }),
    id: prefix => `${prefix}_review`, now: () => AT, audit: () => {} });
  await routeSupplierCatalog({ req: { method: "PATCH" }, url: new URL("http://localhost/me/catalog-items/item_b"), store,
    user: store.users.find(row => row.id === "supplier_b"), readBody: async () => ({ expectedVersion: 1, basePriceMinor: 88000 }),
    id: prefix => `${prefix}_review_b`, now: () => AT, audit: () => {} });
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup", deadline: "2026-09-10T00:00:00Z" })).body.cart.id;
  await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_a", optionIds: [], quantity: 1, artworkFileId: "file_art" });
  await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_b", optionIds: [], quantity: 1, artworkFileId: "file_art" });
  const cart = (await call("GET", `/me/carts/${cartId}`)).body.cart;
  assert.equal(cart.lines[0].listing.basePriceMinor, 10000);
  const result = await call("POST", `/me/carts/${cartId}/checkout`, { payment: { method: "qr_manual", proofFileId: "file_qr", reference: "APPROVED" } });
  assert.equal(result.status, 201);
  assert.deepEqual(store.orderLineItems.map(row => row.baseUnitPriceMinor), [10000, 20000]);
  assert.equal(store.orders.length, 2);
  assert.equal(store.catalogItems[0].basePriceMinor, 99000);
  assert.equal(store.catalogItems[0].reviewStatus, "pending");
});

test("listing review: a direct cart add cannot bypass pending approval", async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  store.catalogItems[0].reviewStatus = "pending";
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  await assert.rejects(call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_a", optionIds: [], quantity: 1 }), error => error.status === 409);
  assert.equal(store.cartLines.length, 0);
});
test('multi-shop client quotes and receipt sections use per-group rounding and full upfront payment', async () => {
  const { store, client } = fixture();
  store.settings.downpaymentPercent = 75;
  for (const item of store.catalogItems) item.basePriceMinor = 5;
  const call = caller(store, client);
  const cart = (await call('POST', '/me/carts', { fulfillmentMode: 'pickup', deadline: '2026-09-10T00:00:00Z' })).body.cart;
  for (const item of ['item_a', 'item_b']) await call('POST', `/me/carts/${cart.id}/lines`, { catalogItemId: item, artworkFileId: 'file_art', quantity: 1, optionIds: [] });
  const quoted = (await call('GET', `/me/carts/${cart.id}/quote`)).body.quote;
  assert.equal(quoted.totalMinor, 12);
  assert.equal(quoted.clientItemSubtotalMinor, 12);
  assert.equal(quoted.downpaymentPercent, 100);
  assert.equal(quoted.balanceMinor, 0);
  const placed = (await call('POST', `/me/carts/${cart.id}/checkout`, { payment: { method: 'qr_manual', proofFileId: 'file_qr', reference: 'ROUNDING' } })).body;
  assert.equal(placed.invoice.totalMinor, quoted.totalMinor);
  assert.equal(placed.invoice.clientItemSubtotalMinor, 12);
  assert.deepEqual(placed.invoice.groups.map((group) => group.clientItemSubtotalMinor), [6, 6]);
  assert.equal(placed.invoice.serviceFeeMinor, undefined);
  assert.equal(placed.invoice.groups[0].itemSubtotalMinor, undefined);
  assert.equal(placed.invoice.lines[0].amountMinor, undefined);
  assert.equal(placed.invoice.lines[0].clientAmountMinor, 6);
  assert.equal(placed.invoice.groups[0].lines[0].clientAmountMinor, 6);
  assert.equal(store.orderInvoices[0].snapshot.serviceFeeMinor, 2);
});

for (const [count, fee, expected] of [[2, 2501, [1251, 1250]], [3, 2501, [834, 834, 833]], [3, 1, [1, 0, 0]], [2, 0, [0, 0]]]) {
  test(`one hub fee of ${fee} is allocated across ${count} groups and refunded independently`, async () => {
    const { store, client } = fixture();
    if (count === 3) addPublicListing(store, { supplierId: 'supplier_c', itemId: 'item_c', priceMinor: 10005,
      shop: { lat: 7.07, lng: 125.62, label: 'Private counter' }, turnaroundHours: 12 });
    store.settings.hubPickup.feeMinor = fee;
    const call = caller(store, client);
    const cart = (await call('POST', '/me/carts', { deadline: '2026-09-10T00:00:00Z' })).body.cart;
    const match = (await call('POST', '/me/matches', { subcategoryCode: 'flyers', cartId: cart.id, fulfillmentMode: 'pickup' })).body;
    const first = match.listings[0];
    await call('POST', `/me/carts/${cart.id}/lines`, { selectToken: first.selectToken, matchRequestId: match.matchRequestId,
      artworkFileId: 'file_art', optionIds: [], quantity: 1 });
    for (const item of ['item_a', 'item_b', 'item_c'].slice(0, count).filter(id => id !== first.id)) {
      await call('POST', `/me/carts/${cart.id}/lines`, { catalogItemId: item, artworkFileId: 'file_art', optionIds: [], quantity: 1 });
    }
    const preview = (await call('GET', `/me/carts/${cart.id}`)).body.cart;
    assert.deepEqual(preview.groups.map(group => group.pickupFeeMinor), expected);
    assert.equal(preview.clientQuote.pickupFeeMinor, fee);
    assert.equal(preview.clientQuote.totalMinor, preview.groups.reduce((sum, group) => sum + group.totalMinor, 0));
    const placed = (await call('POST', `/me/carts/${cart.id}/checkout`, {
      payment: { method: 'qr_manual', reference: 'ONE-HUB-FEE', proofFileId: 'file_qr' },
    })).body;
    assert.equal(placed.basket.totalMinor, preview.clientQuote.totalMinor);
    assert.equal(placed.basket.hubPickup.feeMinor, fee);
    assert.equal(placed.invoice.pickupFeeMinor, fee);
    assert.equal(placed.invoice.deliveryFeeMinor, fee);
    assert.deepEqual(placed.invoice.groups.map(group => group.pickupFeeMinor), expected);
    assert.deepEqual(store.orders.map(order => order.pickupFeeMinor), expected);
    for (const [index, order] of store.orders.entries()) {
      assert.equal(order.hubPickup.feeMinor, expected[index]);
      assert.equal(order.riderPayoutMinor, 0);
      assert.equal(order.platformDeliveryShareMinor, expected[index]);
      order.payments.initial.status = 'confirmed';
      const refund = calculateRefundSettlement(order, { beforeProduction: true, shopEntitlementMinor: 0, riderEntitlementMinor: 0 });
      assert.equal(refund.deliveryMinor, expected[index]);
      assert.equal(refund.totalMinor, order.totalMinor);
    }
    assert.ok(store.orderJobs.every(job => job.deliveryFeeMinor === 0));
    store.settings.hubPickup.feeMinor = fee + 100;
    assert.deepEqual((await call('GET', `/orders/${store.orders[0].id}/invoice`)).body.invoice, placed.invoice);
  });
}

test('checkout and invoice preserve the order-time officer across later handovers', async () => {
  const { store, client } = fixture();
  const original = { id: 'officer_old', fullName: 'Officer One', verifiedAt: AT };
  store.organizationAccounts = [{ userId: client.id, currentOfficer: { ...original } }];
  const call = caller(store, client);
  const cartId = (await call('POST', '/me/carts', { fulfillmentMode: 'pickup' })).body.cart.id;
  await call('POST', `/me/carts/${cartId}/lines`, { catalogItemId: 'item_a', optionIds: [], quantity: 1, artworkFileId: 'file_art' });
  const result = await call('POST', `/me/carts/${cartId}/checkout`, {
    payment: { method: 'qr_manual', proofFileId: 'file_qr', reference: 'OFFICER-SNAPSHOT' },
  });
  assert.deepEqual(result.body.order.organizationOfficer, original);
  store.organizationAccounts[0].currentOfficer = { id: 'officer_new', fullName: 'Officer Two', verifiedAt: AT };
  const invoice = await call('GET', `/orders/${result.body.order.id}/invoice`);
  assert.deepEqual(invoice.body.invoice.organizationOfficer, original);
  const order = store.orders.find((row) => row.id === result.body.order.id);
  assert.deepEqual(publicOrderFor(order, client, store).organizationOfficer, original);
  assert.equal(publicOrderFor(order, { id: 'supplier_a', role: 'supplier' }, store).organizationOfficer, undefined);
});

for (const count of [1, 2]) {
  test(`approved organization discount funds ${count} shop group(s) without reducing payouts`, async () => {
    const { store, client } = fixture();
    client.accountType = 'organization';
    store.approvalCases.push({ id: 'org_case', userId: client.id, kind: 'business_client', status: 'approved' });
    const call = caller(store, client);
    const cart = (await call('POST', '/me/carts', { fulfillmentMode: 'delivery', deadline: '2026-09-10T00:00:00.000Z',
      defaultDropoff: { lat: 7.08, lng: 125.62, label: 'Destination' } })).body.cart;
    for (const catalogItemId of ['item_a', 'item_b'].slice(0, count)) await call('POST', `/me/carts/${cart.id}/lines`, {
      catalogItemId, quantity: 1, optionIds: [], artworkFileId: 'file_art',
    });
    const preview = (await call('GET', `/me/carts/${cart.id}`)).body.cart;
    assert.equal(preview.clientQuote.organizationDiscountMinor, count === 1 ? 500 : 1500);
    const placed = (await call('POST', `/me/carts/${cart.id}/checkout`, { payment: {
      method: 'qr_manual', reference: 'ORG', proofFileId: 'file_qr',
    } })).body;
    assert.equal(placed.invoice.organizationDiscountMinor, count === 1 ? 500 : 1500);
    assert.equal(placed.invoice.totalMinor, preview.clientQuote.totalMinor);
    assert.ok(!JSON.stringify(placed).includes('serviceFeeMinor'));
    for (const [index, order] of store.orders.entries()) {
      assert.equal(order.organizationDiscountMinor, index === 0 ? 500 : 1000);
      assert.equal(order.serviceFeeMinor, index === 0 ? 500 : 1000);
      assert.equal(order.grossServiceFeeMinor, index === 0 ? 1000 : 2000);
      assert.equal(order.totalMinor, order.supplierSubtotalMinor + order.serviceFeeMinor + order.deliveryFeeMinor);
      assert.equal(order.payoutMilestones.reduce((sum, row) => sum + row.amountMinor, 0), index === 0 ? 10000 : 20000);
      assert.equal(order.riderPayoutMinor, Math.round(order.deliveryFeeMinor * .85));
      order.payments.initial.status = 'confirmed';
      const revenue = moneyReportingForOrder(order).platformRevenue;
      assert.equal(revenue.organizationDiscountMinor, index === 0 ? 500 : 1000);
      assert.equal(revenue.billedMinor, order.serviceFeeMinor + order.platformDeliveryShareMinor);
      assert.equal(revenue.collectedMinor, revenue.billedMinor);
      const projected = publicOrderFor(order, client, store);
      assert.equal(projected.serviceFeeMinor, undefined);
      assert.equal(projected.grossServiceFeeMinor, undefined);
      const receipt = (await call('GET', `/orders/${order.id}/invoice`)).body.invoice;
      assert.equal(receipt.serviceFeeMinor, undefined);
    }
  });
}

test('organization group rounding is snapshotted and fee visibility does not hide the discount', async () => {
  const { store, client } = fixture();
  client.accountType = 'organization';
  store.approvalCases.push({ id: 'org_case', userId: client.id, kind: 'business_client', status: 'approved' });
  store.settings.serviceFeeVisibleToClient = false;
  for (const item of store.catalogItems) item.basePriceMinor = 10;
  const call = caller(store, client);
  const cart = (await call('POST', '/me/carts', { fulfillmentMode: 'pickup', deadline: '2026-09-10T00:00:00.000Z' })).body.cart;
  for (const catalogItemId of ['item_a', 'item_b']) await call('POST', `/me/carts/${cart.id}/lines`, {
    catalogItemId, quantity: 1, optionIds: [], artworkFileId: 'file_art',
  });
  const preview = (await call('GET', `/me/carts/${cart.id}`)).body.cart;
  assert.equal(preview.clientQuote.organizationDiscountMinor, 2);
  assert.equal(preview.clientQuote.totalMinor, 20);
  const placed = (await call('POST', `/me/carts/${cart.id}/checkout`, { payment: {
    method: 'qr_manual', reference: 'ROUNDING', proofFileId: 'file_qr',
  } })).body;
  assert.equal(placed.invoice.organizationDiscountMinor, 2);
  assert.equal(placed.invoice.totalMinor, 20);
  assert.deepEqual(placed.invoice.groups.map(row => row.organizationDiscountMinor), [1, 1]);
  store.settings.organizationDiscountRateBps = 1000;
  store.settings.serviceFeeRateBps = 1500;
  store.approvalCases.find(row => row.id === 'org_case').status = 'suspended';
  const receipt = (await call('GET', `/orders/${store.orders[0].id}/invoice`)).body.invoice;
  assert.equal(receipt.organizationDiscountMinor, 2);
  assert.equal(receipt.totalMinor, 20);
});

test('pending organization gets no discount and a client cannot supply its own discount', async () => {
  const { store, client } = fixture();
  client.accountType = 'organization';
  store.approvalCases.push({ id: 'org_case', userId: client.id, kind: 'business_client', status: 'pending' });
  const call = caller(store, client);
  const cart = (await call('POST', '/me/carts', { fulfillmentMode: 'pickup' })).body.cart;
  await call('POST', `/me/carts/${cart.id}/lines`, { catalogItemId: 'item_a', quantity: 1, optionIds: [], artworkFileId: 'file_art' });
  const placed = (await call('POST', `/me/carts/${cart.id}/checkout`, { organizationDiscountMinor: 1000, organizationDiscountRateBps: 1000,
    payment: { method: 'qr_manual', reference: 'PENDING', proofFileId: 'file_qr' } })).body;
  assert.equal(placed.invoice.organizationDiscountMinor, 0);
  assert.equal(placed.invoice.totalMinor, 11000);
});

for (const acrossShops of [false, true]) {
  test(`per-line deadlines group by shop and date (${acrossShops ? 'across shops' : 'same shop'})`, async () => {
    const { store, client } = fixture();
    store.settings.downpaymentPercent = 75;
    const call = caller(store, client);
    const dates = ['2026-09-10T00:00:00.000Z', '2026-09-12T00:00:00.000Z'];
    const cart = (await call('POST', '/me/carts', { fulfillmentMode: 'delivery',
      defaultDropoff: { lat: 7.08, lng: 125.62, label: 'Destination' } })).body.cart;
    for (const [item, deadline] of [['item_a', dates[0]], [acrossShops ? 'item_b' : 'item_a2', dates[1]], ['item_a', dates[0]]]) {
      await call('POST', `/me/carts/${cart.id}/lines`, { catalogItemId: item, deadline, quantity: 1, optionIds: [], artworkFileId: 'file_art' });
    }
    const preview = (await call('GET', `/me/carts/${cart.id}`)).body.cart;
    assert.deepEqual(preview.lines.map(line => line.deadline), [dates[0], dates[1], dates[0]]);
    assert.equal(preview.deadline, null);
    assert.equal(preview.groupCount, 2);
    assert.equal(preview.shopCount, acrossShops ? 2 : 1);
    assert.equal(preview.isMultiGroup, true);
    assert.deepEqual(preview.groups.map(group => group.deadline), dates);
    assert.deepEqual(preview.groups.map(group => group.label), ['Shop A', acrossShops ? 'Shop B' : 'Shop A']);
    assert.deepEqual(preview.groups.map(group => group.lineIds.length), [2, 1]);
    assert.ok(preview.groups.every(group => group.deliveryFeeMinor > 0));
    assert.equal(preview.clientQuote.deliveryFeeMinor, preview.groups.reduce((sum, group) => sum + group.deliveryFeeMinor, 0));
    assert.equal(preview.clientQuote.downpaymentPercent, 100);
    assert.equal(preview.clientQuote.upfrontReason, 'multiple_fulfillment_groups');
    const { basket, invoice } = (await call('POST', `/me/carts/${cart.id}/checkout`, {
      payment: { method: 'qr_manual', reference: 'DATES', proofFileId: 'file_qr' },
    })).body;
    assert.deepEqual(basket.groups.map(group => group.deadline), dates);
    assert.deepEqual(invoice.groups.map(group => group.deadline), dates);
    assert.deepEqual(invoice.deliveryLines.map(line => line.deadline), dates);
    assert.equal(basket.deadline, null);
    assert.equal(basket.totalMinor, preview.clientQuote.totalMinor);
    assert.equal(store.orderJobs.length, 2);
    assert.equal(store.orderInvoices.length, 1);
    assert.equal(basket.upfrontReason, 'multiple_fulfillment_groups');
    for (const [index, group] of basket.groups.entries()) {
      const order = store.orders.find(row => row.id === group.orderId);
      assert.equal(order.deadline, dates[index]);
      assert.equal(store.orderJobs.find(job => job.orderId === order.id).deadline, dates[index]);
      for (const role of ['client', 'supplier', 'rider', 'ops_admin']) {
        assert.equal(publicOrderFor(order, { id: client.id, role }, store).deadline, dates[index]);
      }
      assert.equal(order.downpaymentPercent, 100);
      assert.equal(order.payments.final_online.status, 'not_required');
      assert.equal(order.payoutMilestones.reduce((sum, stage) => sum + stage.amountMinor, 0), order.supplierSubtotalMinor);
      order.payments.initial.status = 'confirmed';
      const siblings = structuredClone(store.orders.filter(row => row.id !== order.id));
      const refund = calculateRefundSettlement(order, { beforeProduction: true, shopEntitlementMinor: 0, riderEntitlementMinor: 0 });
      assert.equal(refund.totalMinor, order.totalMinor);
      assert.equal(refund.deliveryMinor, group.deliveryFeeMinor);
      assert.deepEqual(store.orders.filter(row => row.id !== order.id), siblings);
    }
  });
}

test('selection tokens retain their own date and line edits recheck only that product', async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  const original = '2026-09-10T00:00:00.000Z';
  const later = '2026-09-12T00:00:00.000Z';
  const cart = (await call('POST', '/me/carts', { fulfillmentMode: 'pickup', deadline: original })).body.cart;
  for (const deadline of [original, later]) {
    const match = (await call('POST', '/me/matches', { cartId: cart.id, subcategoryCode: 'flyers', deadline })).body;
    const listing = [...match.listings, ...match.otherListings].find(row => row.id === 'item_a');
    const input = { selectToken: listing.selectToken, matchRequestId: match.matchRequestId, quantity: 1, optionIds: [], artworkFileId: 'file_art' };
    await assert.rejects(call('POST', `/me/carts/${cart.id}/lines`, { ...input, deadline: '2026-10-01T00:00:00Z' }), { code: 'select_token_deadline_mismatch' });
    await call('POST', `/me/carts/${cart.id}/lines`, input);
  }
  const preview = (await call('GET', `/me/carts/${cart.id}`)).body.cart;
  assert.deepEqual(preview.groups.map(group => group.deadline), [original, later]);
  const match = (await call('POST', '/me/matches', { cartId: cart.id, groupId: preview.groups[1].id, subcategoryCode: 'brochures' })).body;
  const selected = store.matchSelections.find(row => row.requestId === match.matchRequestId);
  assert.equal(selected.selection.deadline, later);
  const edited = (await call('PATCH', `/me/carts/${cart.id}/lines/${preview.lines[1].id}`, { deadline: original })).body.cart;
  assert.equal(edited.groups.length, 1);
  assert.equal(edited.deadline, original);
  await assert.rejects(call('PATCH', `/me/carts/${cart.id}/lines/${preview.lines[1].id}`, { deadline: AT }), { code: 'deadline_not_met' });
});

test('legacy single-date cart keeps one sub-order and its configured installment plan', async () => {
  const { store, client } = fixture();
  store.settings.downpaymentPercent = 75;
  const call = caller(store, client);
  const deadline = '2026-09-10T00:00:00.000Z';
  const cart = (await call('POST', '/me/carts', { fulfillmentMode: 'pickup', deadline })).body.cart;
  for (const item of ['item_a', 'item_a2']) await call('POST', `/me/carts/${cart.id}/lines`, { catalogItemId: item, quantity: 1, optionIds: [], artworkFileId: 'file_art' });
  const preview = (await call('GET', `/me/carts/${cart.id}`)).body.cart;
  assert.equal(preview.isMultiGroup, false);
  assert.equal(preview.clientQuote.downpaymentPercent, 75);
  assert.equal(preview.clientQuote.upfrontReason, 'platform_setting');
  const placed = (await call('POST', `/me/carts/${cart.id}/checkout`, { payment: { method: 'qr_manual', reference: 'LEGACY-DATE', proofFileId: 'file_qr' } })).body;
  assert.equal(placed.basket, undefined);
  assert.equal(placed.order.deadline, deadline);
  assert.equal(placed.order.downpaymentPercent, 75);
  assert.equal(store.orders.length, 1);
});

test('a later-date slow product does not force the earlier product to miss its own match', async () => {
  const { store, client } = fixture();
  const call = caller(store, client);
  const item = store.catalogItems.find(row => row.id === 'item_a2');
  item.turnaroundMode = 'override'; item.turnaroundHours = 240;
  const cart = (await call('POST', '/me/carts', { fulfillmentMode: 'pickup' })).body.cart;
  await call('POST', `/me/carts/${cart.id}/lines`, { catalogItemId: item.id, deadline: '2026-10-10T00:00:00Z', quantity: 1, optionIds: [], artworkFileId: 'file_art' });
  const match = (await call('POST', '/me/matches', { cartId: cart.id, subcategoryCode: 'flyers', deadline: '2026-08-28T00:00:00Z' })).body;
  assert.ok([...match.listings, ...match.otherListings].some(row => row.id === 'item_a'));
  await call('POST', `/me/carts/${cart.id}/lines`, { catalogItemId: 'item_a', deadline: '2026-08-28T00:00:00Z', quantity: 1, optionIds: [], artworkFileId: 'file_art' });
  const placed = (await call('POST', `/me/carts/${cart.id}/checkout`, { payment: { method: 'qr_manual', reference: 'EARLIEST-FIRST', proofFileId: 'file_qr' } })).body;
  assert.deepEqual(placed.basket.groups.map(group => group.deadline), ['2026-10-10T00:00:00.000Z', '2026-08-28T00:00:00.000Z']);
});
