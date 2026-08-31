import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import { createDatabase } from "../src/database.js";
import { loadStore, saveStore } from "../src/postgres-store.js";
import { seedReferenceData } from "../src/seed.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ISSUER = "https://casual-crab-9.clerk.accounts.dev";
const AUTHORIZED_PARTY = "http://localhost:19006";
const AT = "2026-08-24T01:00:00.000Z";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_KEY = publicKey.export({ type: "spki", format: "pem" });

function token(subject) {
  const current = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "gridgo-test-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER, sub: subject, sid: `sess_${subject}`, azp: AUTHORIZED_PARTY,
    iat: current - 5, nbf: current - 5, exp: current + 300,
  })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startApi() {
  const port = await freePort();
  const api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      DATABASE_URL,
      CLERK_SECRET_KEY: "test-only-placeholder",
      CLERK_ISSUER: ISSUER,
      CLERK_AUTHORIZED_PARTIES: AUTHORIZED_PARTY,
      CLERK_JWT_KEY: JWT_KEY,
      HOST: "127.0.0.1",
      PORT: String(port),
      GRIDGO_BUILD_SHA: "order-match-api-test",
      GRIDGO_BUILD_TIME: AT,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`API exited before health:\n${output}`);
    try {
      if ((await fetch(`${api}/health`)).ok) return { api, child, output: () => output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGTERM");
  throw new Error(`API did not become healthy:\n${output}`);
}

async function request(api, pathname, { method = "GET", subject, body } = {}) {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: {
      ...(subject ? { Authorization: `Bearer ${token(subject)}` } : {}),
      ...(body == null ? {} : { "Content-Type": "application/json" }),
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function requestEventually(api, pathname, options, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(api, pathname, options);
    if (predicate(response)) return response;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${pathname}`);
}

async function fixture(database) {
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, order_invoices,
    client_cart_lines, client_carts, client_saved_addresses, client_match_preferences,
    payout_milestones, order_payments, order_line_item_options, order_line_items, order_jobs, orders,
    supplier_catalog_prep_steps, supplier_catalog_item_photos, supplier_shop_media, supplier_catalog_item_file_formats,
    supplier_catalog_options, supplier_catalog_option_groups, supplier_catalog_items,
    supplier_service_file_formats, supplier_service_price_tiers, supplier_services,
    listing_starter_options, listing_starter_groups, listing_starters, accepted_file_formats,
    supplier_payment_terms, supplier_profiles, rider_profiles, client_profiles,
    approval_case_events, approval_cases, user_role_memberships,
    zones, taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
    taxonomy_category_aliases, taxonomy_categories, catalog_products, users,
    platform_settings RESTART IDENTITY CASCADE`);
  await seedReferenceData(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users.push(
      { id: "user_client", clerkUserId: "clerk_client", email: "client@gridgo.test", name: "Client", role: "client", accountType: "individual", createdAt: AT },
      { id: "supplier_a", clerkUserId: "clerk_supplier_a", email: "a@gridgo.test", name: "A", role: "supplier", verificationStatus: "approved", shop: { lat: 7.064, lng: 125.6085, label: "Shop A" }, createdAt: AT },
      { id: "supplier_b", clerkUserId: "clerk_supplier_b", email: "b@gridgo.test", name: "B", role: "supplier", verificationStatus: "approved", shop: { lat: 7.09, lng: 125.63, label: "Shop B" }, createdAt: AT },
    { id: "user_ops", clerkUserId: "clerk_ops", email: "ops@gridgo.test", name: "Ops", role: "ops_admin", createdAt: AT },
    );
    store.userRoleMemberships.push(
      { userId: "user_client", role: "client", createdAt: AT },
      { userId: "supplier_a", role: "supplier", createdAt: AT },
      { userId: "supplier_b", role: "supplier", createdAt: AT },
    { userId: "user_ops", role: "ops_admin", createdAt: AT },
    );
    for (const [index, supplierId] of ["supplier_a", "supplier_b"].entries()) {
      const shop = index === 0
        ? { lat: 7.064, lng: 125.6085, label: "Shop A" }
        : { lat: 7.09, lng: 125.63, label: "Shop B" };
      const serviceId = `service_${supplierId}`;
      const itemId = `item_${supplierId}`;
      const photoId = `photo_${supplierId}`;
      store.supplierProfiles.push({ userId: supplierId, shopName: `${supplierId} Shop`, contactName: supplierId, shop, pickupAvailable: true, version: 1, updatedAt: AT });
      store.approvalCases.push({ id: `case_${supplierId}`, userId: supplierId, kind: "supplier", status: "approved", version: 1, applicationRevision: 1, createdAt: AT, updatedAt: AT });
      store.supplierServices.push({ id: serviceId, supplierId, categoryCode: "marketing_collateral", state: "live", pricingBasis: "per_unit", referenceRateMinor: (index + 1) * 10_000, turnaroundHours: 12 + index * 12, standardTurnaroundHours: 12 + index * 12, version: 1, createdAt: AT, updatedAt: AT });
      store.supplierServiceFileFormats.push({ supplierServiceId: serviceId, formatCode: "pdf" });
      store.catalogItems.push({ id: itemId, supplierId, supplierServiceId: serviceId, subcategoryCode: "flyers", name: `${supplierId} Flyers`, description: "Full-color flyers", basePriceMinor: (index + 1) * 10_000, pricingUnit: "per_unit", turnaroundMode: "inherit", fileFormatMode: "inherit", active: true, sortOrder: 0, version: 1, createdAt: AT, updatedAt: AT });
      store.files.push({ fileId: photoId, ownerId: supplierId, purpose: "catalog_item_photo", originalFilename: "flyers.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", size: 10, state: "ready", objectKey: `${supplierId}/flyers.jpg`, createdAt: AT });
      store.catalogItemPhotos.push({ catalogItemId: itemId, fileId: photoId, sortOrder: 0, createdAt: AT });
    // A second listing at the same shop, so a basket can hold two lines without
    // spanning two shops. Its own photo file: a file attaches to exactly one
    // listing, so sharing one leaves the second without a sample and off the board.
    store.catalogItems.push({ id: `${itemId}_brochures`, supplierId, supplierServiceId: serviceId, subcategoryCode: "brochures", name: `${supplierId} Brochures`, description: "Tri-fold brochures", basePriceMinor: (index + 1) * 20_000, pricingUnit: "per_unit", turnaroundMode: "inherit", fileFormatMode: "inherit", active: true, sortOrder: 1, version: 1, createdAt: AT, updatedAt: AT });
    store.files.push({ fileId: `${photoId}_brochures`, ownerId: supplierId, purpose: "catalog_item_photo", originalFilename: "brochures.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", size: 10, state: "ready", objectKey: `${supplierId}/brochures.jpg`, createdAt: AT });
    store.catalogItemPhotos.push({ catalogItemId: `${itemId}_brochures`, fileId: `${photoId}_brochures`, sortOrder: 0, createdAt: AT });
    }
    store.files.push(
      { fileId: "file_art", ownerId: "user_client", purpose: "artwork", originalFilename: "art.pdf", declaredContentType: "application/pdf", detectedContentType: "application/pdf", size: 10, state: "ready", objectKey: "client/art.pdf", references: [], createdAt: AT },
      { fileId: "file_mock", ownerId: "user_client", purpose: "mockup", originalFilename: "mock.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", size: 10, state: "ready", objectKey: "client/mock.jpg", references: [], createdAt: AT },
      { fileId: "file_qr", ownerId: "user_client", purpose: "payment_proof", originalFilename: "qr.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", size: 10, state: "ready", objectKey: "client/qr.jpg", references: [], createdAt: AT },
    );
    await saveStore(database, store);
  });
}

test("client order-match routes persist a single-shop QR checkout and invoice", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  t.after(() => database.close());
  await fixture(database);
  const instance = await startApi();
  t.after(async () => {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
  });

  assert.equal((await request(instance.api, "/me/preferences")).status, 401);
  const preferences = await request(instance.api, "/me/preferences", {
    method: "PUT", subject: "clerk_client", body: { ranking: ["quality", "speed", "cost", "distance"] },
  });
  assert.equal(preferences.status, 200, JSON.stringify(preferences.body));

  const address = await request(instance.api, "/me/addresses", {
    method: "POST", subject: "clerk_client",
    body: { label: "Home", addressLine: "Bajada, Davao City", point: { lat: 7.0731, lng: 125.6128 }, isDefault: true },
  });
  assert.equal(address.status, 201, JSON.stringify(address.body));
  const match = await request(instance.api, "/me/matches", {
    method: "POST", subject: "clerk_client", body: { subcategoryCode: "flyers", addressId: address.body.address.id },
  });
  assert.equal(match.status, 200, JSON.stringify(match.body));

  const created = await request(instance.api, "/me/carts", {
    method: "POST", subject: "clerk_client",
    body: { fulfillmentMode: "delivery", defaultDropoff: { lat: 7.0731, lng: 125.6128, label: "Home" } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const cartId = created.body.cart.id;
  const first = await request(instance.api, `/me/carts/${cartId}/lines`, {
    method: "POST", subject: "clerk_client",
      body: { catalogItemId: "item_supplier_a", optionIds: [], quantity: 1, artworkFileId: "file_art" },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const lineId = first.body.cart.lines[0].id;
  const mockup = await request(instance.api, `/me/carts/${cartId}/lines/${lineId}/mockup`, {
    method: "PUT", subject: "clerk_client", body: { fileId: "file_mock" },
  });
  assert.equal(mockup.status, 200, JSON.stringify(mockup.body));
  const second = await request(instance.api, `/me/carts/${cartId}/lines`, {
    method: "POST", subject: "clerk_client",
    body: { catalogItemId: "item_supplier_a_brochures", optionIds: [], quantity: 1 },
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));

  // A basket belongs to one shop. Adding another shop's listing is refused
  // rather than quietly splitting the order in two.
  const otherShop = await request(instance.api, `/me/carts/${cartId}/lines`, {
    method: "POST", subject: "clerk_client",
    body: { catalogItemId: "item_supplier_b", optionIds: [], quantity: 1 },
  });
  assert.equal(otherShop.status, 409, JSON.stringify(otherShop.body));
  assert.equal(otherShop.body.error, "cart_belongs_to_another_shop");

  const rejected = await request(instance.api, `/me/carts/${cartId}/checkout`, {
    method: "POST", subject: "clerk_client",
    body: { payment: { method: "cash", proofFileId: "file_qr", reference: "QR-123" } },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, "payment_method_not_allowed");
  const checkout = await request(instance.api, `/me/carts/${cartId}/checkout`, {
    method: "POST", subject: "clerk_client",
    body: { payment: { method: "qr_manual", proofFileId: "file_qr", reference: "QR-123" } },
  });
  assert.equal(checkout.status, 201, `${JSON.stringify(checkout.body)}\n${instance.output()}`);
  assert.equal(checkout.body.order.state, "initial_payment_review");
  assert.equal(checkout.body.order.totalMinor, 35_500);
  assert.equal(checkout.body.order.jobs.length, 1);
  assert.ok(checkout.body.order.readyBy, "the client is given a promised date");

  const invoice = await requestEventually(
    instance.api,
    `/orders/${checkout.body.order.id}/invoice`,
    { subject: "clerk_client" },
    (response) => response.status === 200,
  );
  assert.equal(invoice.status, 200, JSON.stringify(invoice.body));
  assert.equal(invoice.body.invoice.deliveryLines.length, 1);
  const persisted = await loadStore(database);
  const placed = persisted.orders.find((row) => row.id === checkout.body.order.id);
  assert.equal(placed.state, "initial_payment_review");
  // The order names its shop and carries both dates through the database.
  assert.equal(placed.supplierId, "supplier_a");
  assert.ok(placed.readyBy && placed.promiseBy);
  assert.equal(persisted.orderJobs.filter((row) => row.orderId === checkout.body.order.id).length, 1);
  assert.equal(persisted.notifications.length, 0);
});


/** Boots the API on a seeded database and returns a placed, paid-pending order. */
async function placedOrder(t, { catalogItemId = "item_supplier_a", fulfillmentMode = null } = {}) {
  const database = createDatabase({ DATABASE_URL });
  t.after(() => database.close());
  await fixture(database);
  const instance = await startApi();
  t.after(async () => {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
  });
  const api = instance.api;
  const call = (path, options = {}) => request(api, path, options);

  await call("/me/preferences", { method: "PUT", subject: "clerk_client", body: { ranking: ["quality", "speed", "cost", "distance"] } });
  const address = await call("/me/addresses", {
    method: "POST", subject: "clerk_client",
    body: { label: "Home", addressLine: "Bajada, Davao City", point: { lat: 7.0731, lng: 125.6128 }, isDefault: true },
  });
  const cart = await call("/me/carts", {
    method: "POST", subject: "clerk_client",
    body: fulfillmentMode ? { fulfillmentMode } : {},
  });
  const cartId = cart.body.cart.id;
  await call(`/me/carts/${cartId}/dropoffs`, {
    method: "PUT", subject: "clerk_client",
    body: { defaultDropoff: { lat: 7.0731, lng: 125.6128, label: "Home" } },
  });
  await call(`/me/carts/${cartId}/lines`, {
    method: "POST", subject: "clerk_client",
    body: { catalogItemId, optionIds: [], quantity: 1, artworkFileId: "file_art" },
  });
  const checkout = await call(`/me/carts/${cartId}/checkout`, {
    method: "POST", subject: "clerk_client",
    body: { payment: { method: "qr_manual", proofFileId: "file_qr", reference: "QR-900" } },
  });
  assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
  return { api, call, orderId: checkout.body.order.id, address, output: () => instance.output() };
}

/**
 * The order lifecycle, end to end and in order: money, then artwork, then the
 * shop. Every step here used to be unreachable -- a checkout order landed at
 * needs_qa with no shop on it, and no supplier surface reads anything but
 * order.supplierId.
 */
test("a paid order clears money, then quality, and only then reaches the shop", { skip: !DATABASE_URL }, async (t) => {
  {
    const { call, orderId } = await placedOrder(t);
    const transition = (state, subject, body = {}) => call(
      `/orders/${orderId}/transition`, { method: "POST", subject, body: { state, ...body } },
    );
    const stateOf = async () => (await call(`/orders/${orderId}`, { subject: "clerk_ops" })).body.order.state;

    // The shop cannot see it, let alone act on it, before Operations has.
    const early = await transition("payment_authorized", "clerk_supplier_a");
    assert.equal(early.status, 409, JSON.stringify(early.body));

    // Step one: the transfer. Confirming it hands the order to quality control,
    // not to the shop -- the artwork has not been looked at yet.
    const confirmed = await call(`/orders/${orderId}/payments/initial/confirm`, {
      method: "POST", subject: "clerk_ops", body: { note: "QR received" },
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(await stateOf(), "needs_qa");

    // Step two: the artwork. A failed check goes back to the client and the
    // money stays where it is.
    const failed = await transition("client_correction", "clerk_ops", { note: "Artwork is 72dpi" });
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    assert.equal(await stateOf(), "client_correction");
    const held = await call(`/orders/${orderId}`, { subject: "clerk_ops" });
    assert.equal(held.body.order.payments.initial.status, "confirmed", "a correction must not undo a confirmed payment");

    // The client fixes it and it returns to the same check, rather than starting
    // the order again.
    const resubmitted = await transition("needs_qa", "clerk_client");
    assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));

    // Passing quality control hands it to the shop that was matched before the
    // client paid. No supplier id is sent: there is nothing left to assign.
    const approved = await transition("supplier_assigned", "clerk_ops", { note: "Artwork approved" });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.order.supplierId, "supplier_a");

    // The shop sees it for the first time here, already priced and already dated.
    const jobs = await call("/jobs", { subject: "clerk_supplier_a" });
    assert.equal(jobs.status, 200, JSON.stringify(jobs.body));
    assert.equal(jobs.body.jobs.length, 1);
    assert.equal(jobs.body.jobs[0].id, orderId);

    // Another shop's job is still not its business.
    const nosy = await call("/jobs", { subject: "clerk_supplier_b" });
    assert.equal(nosy.body.jobs.length, 0);

    // Accepting is only confirming it can run the work: no price, no date.
    const accepted = await transition("payment_authorized", "clerk_supplier_a");
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const started = await transition("production", "clerk_supplier_a");
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(await stateOf(), "production");
  }
});

test("cancelling an order records who ended it and why, and refuses to do so silently", { skip: !DATABASE_URL }, async (t) => {
  {
    const { call, orderId } = await placedOrder(t);
    const cancel = (body) => call(
      `/orders/${orderId}/transition`, { method: "POST", subject: "clerk_ops", body: { state: "cancelled", ...body } },
    );

    const bare = await cancel({});
    assert.equal(bare.status, 400, JSON.stringify(bare.body));
    assert.equal(bare.body.error, "cancellation_reason_required");

    const done = await cancel({ reason: "Client cannot supply print-ready artwork" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.order.state, "cancelled");
    assert.equal(done.body.order.cancellationReason, "Client cannot supply print-ready artwork");
    assert.equal(done.body.order.cancelledBy, "user_ops");
    assert.ok(done.body.order.cancelledAt);
  }
});

test("a shop that cannot take the work hands it on rather than stopping it", async (t) => {
  const { call, orderId, output } = await placedOrder(t);
  const transition = (state, subject, body = {}) => call(
    `/orders/${orderId}/transition`, { method: "POST", subject, body: { state, ...body } },
  );

  await call(`/orders/${orderId}/payments/initial/confirm`, { method: "POST", subject: "clerk_ops", body: {} });
  await transition("supplier_assigned", "clerk_ops");

  // Only the shop holding the job can decline it.
  const wrongShop = await call(`/orders/${orderId}/decline`, {
    method: "POST", subject: "clerk_supplier_b", body: { reason: "not mine" },
  });
  assert.equal(wrongShop.status, 403, JSON.stringify(wrongShop.body));

  const declined = await call(`/orders/${orderId}/decline`, {
    method: "POST", subject: "clerk_supplier_a", body: { reason: "Press is down until Thursday" },
  });
  assert.equal(declined.status, 200, `${JSON.stringify(declined.body)}\n${output()}`);

  // Supplier B is dearer than the job was sold for, so it is not a candidate.
  // The order lands on Operations rather than costing the client more.
  assert.equal(declined.body.replaced, false);
  assert.equal(declined.body.order.state, "approved_for_matching");
  assert.equal(declined.body.order.supplierId, null);

  // And the shop that declined no longer sees it.
  const inbox = await call("/jobs", { subject: "clerk_supplier_a" });
  assert.equal(inbox.body.jobs.length, 0);

  // Declining twice is not a way to loop.
  const again = await call(`/orders/${orderId}/decline`, {
    method: "POST", subject: "clerk_supplier_a", body: { reason: "still down" },
  });
  assert.equal(again.status, 403, JSON.stringify(again.body));
});

test("a declined job moves to a shop that can still make the date, at no more cost", async (t) => {
  // Placed with the dearer, slower shop, so a cheaper and faster one exists to
  // take it on.
  const { call, orderId, output } = await placedOrder(t, { catalogItemId: "item_supplier_b" });
  await call(`/orders/${orderId}/payments/initial/confirm`, { method: "POST", subject: "clerk_ops", body: {} });
  await call(`/orders/${orderId}/transition`, {
    method: "POST", subject: "clerk_ops", body: { state: "supplier_assigned" },
  });

  const before = (await call(`/orders/${orderId}`, { subject: "clerk_ops" })).body.order;
  assert.equal(before.supplierId, "supplier_b");

  const declined = await call(`/orders/${orderId}/decline`, {
    method: "POST", subject: "clerk_supplier_b", body: { reason: "Fully booked" },
  });
  assert.equal(declined.status, 200, `${JSON.stringify(declined.body)}\n${output()}`);
  assert.equal(declined.body.replaced, true);

  const after = (await call(`/orders/${orderId}`, { subject: "clerk_ops" })).body.order;
  assert.equal(after.supplierId, "supplier_a", "the job moved to the shop that can take it");
  assert.equal(after.state, "supplier_assigned", "and it is waiting on that shop, not on Operations");

  // The client pays exactly what they agreed to. A shop dropping out is not a
  // reason to reprice an order somebody already paid for.
  assert.equal(after.totalMinor, before.totalMinor);
  assert.equal(after.supplierSubtotalMinor, before.supplierSubtotalMinor);

  // And the new shop is not promised later than the client already was.
  assert.ok(Date.parse(after.promiseBy) <= Date.parse(before.promiseBy));

  // The new shop sees it; the one that declined does not.
  assert.equal((await call("/jobs", { subject: "clerk_supplier_a" })).body.jobs.length, 1);
  assert.equal((await call("/jobs", { subject: "clerk_supplier_b" })).body.jobs.length, 0);
});

test("the shop is paid in two stages, and never ahead of the money the client sent", async (t) => {
  const { call, orderId, output } = await placedOrder(t);
  const ops = (path, body) => call(path, { method: "POST", subject: "clerk_ops", body: body || {} });
  const transition = (state, subject, body = {}) => call(
    `/orders/${orderId}/transition`, { method: "POST", subject, body: { state, ...body } },
  );
  const orderNow = async () => (await call(`/orders/${orderId}`, { subject: "clerk_ops" })).body.order;

  // Two milestones of the shop's own price, both pending, nothing released.
  const placed = await orderNow();
  assert.deepEqual(placed.payoutMilestones.map((row) => row.code), ["initial", "completion"]);
  assert.equal(placed.payoutMilestones.every((row) => row.status === "pending"), true);
  assert.equal(
    placed.payoutMilestones.reduce((total, row) => total + row.amountMinor, 0),
    placed.supplierSubtotalMinor,
    "the two stages have to add up to the shop's price, not the client's total",
  );

  await ops(`/orders/${orderId}/payments/initial/confirm`);
  await transition("supplier_assigned", "clerk_ops");
  await transition("payment_authorized", "clerk_supplier_a");

  // Starting production releases the first stage. It is capped by the supplier
  // principal actually collected, so the platform never pays out money it has
  // not received.
  await transition("production", "clerk_supplier_a");
  const producing = await orderNow();
  const released = producing.payoutMilestones.filter((row) => row.status === "released");
  assert.equal(released.length, 1, `${JSON.stringify(producing.payoutMilestones)}\n${output()}`);
  assert.equal(released[0].code, "initial");
  assert.equal(
    producing.payoutMilestones.find((row) => row.code === "completion").status,
    "pending",
    "the rest waits for delivery, and for the balance",
  );
});

test("a client rates a finished order once, and only quality reaches matching", async (t) => {
  const { call, orderId } = await placedOrder(t);
  const rate = (body, subject = "clerk_client") => call(
    `/orders/${orderId}/review`, { method: "POST", subject, body },
  );

  // Not while the order is still running: a rating must never be a bargaining
  // chip in an open job.
  const early = await rate({ qualityStars: 5, speedStars: 5, valueStars: 5 });
  assert.equal(early.status, 409, JSON.stringify(early.body));
  assert.equal(early.body.error, "order_not_complete");

  // Walk it to finished.
  await call(`/orders/${orderId}/payments/initial/confirm`, { method: "POST", subject: "clerk_ops", body: {} });
  for (const [state, subject] of [
    ["supplier_assigned", "clerk_ops"],
    ["payment_authorized", "clerk_supplier_a"],
    ["production", "clerk_supplier_a"],
    ["supplier_self_qc", "clerk_supplier_a"],
    ["ready_for_dispatch", "clerk_supplier_a"],
  ]) {
    const moved = await call(`/orders/${orderId}/transition`, { method: "POST", subject, body: { state } });
    assert.equal(moved.status, 200, `${state}: ${JSON.stringify(moved.body)}`);
  }

  // Finishing the work stamps when the shop was actually done, so its on-time
  // record can be measured against the date its own board promised.
  const ready = (await call(`/orders/${orderId}`, { subject: "clerk_ops" })).body.order;
  assert.ok(ready.readyAt, "the shop's finish time is recorded");
  assert.ok(ready.readyBy, "and the date it was held to");

  const store = await (async () => {
    const { createDatabase } = await import("../src/database.js");
    const db = createDatabase({ DATABASE_URL });
    t.after(() => db.close());
    return db.transaction(async () => {
      const loaded = await loadStore(db);
      const row = loaded.orders.find((order) => order.id === orderId);
      row.state = "completed";
      await saveStore(db, loaded);
      return loaded;
    });
  })();
  assert.equal(store.orders.find((order) => order.id === orderId).state, "completed");

  const bad = await rate({ qualityStars: 6, speedStars: 5, valueStars: 5 });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.equal(bad.body.field, "qualityStars");

  // The order says whether it has been rated, so the app asks once. Without
  // it a client learns the screen was wrong to ask by being refused.
  const unrated = (await call(`/orders/${orderId}`, { subject: "clerk_client" })).body.order;
  assert.equal(unrated.rated, false);

  const rated = await rate({ qualityStars: 5, speedStars: 3, valueStars: 4, comment: "Beautiful print, a day late." });
  assert.equal(rated.status, 201, JSON.stringify(rated.body));
  assert.equal(rated.body.review.supplierId, "supplier_a");
  assert.equal(rated.body.review.speedStars, 3);

  const afterwards = (await call(`/orders/${orderId}`, { subject: "clerk_client" })).body.order;
  assert.equal(afterwards.rated, true);

  // What was said about the shop is not handed back through the order: any of
  // several roles can read one, and a rating is not theirs to read.
  assert.equal(Object.hasOwn(afterwards, "review"), false);

  // Once.
  const twice = await rate({ qualityStars: 1, speedStars: 1, valueStars: 1 });
  assert.equal(twice.status, 409, JSON.stringify(twice.body));
  assert.equal(twice.body.error, "already_rated");

  // And somebody else's order is not theirs to rate.
  const stranger = await rate({ qualityStars: 5, speedStars: 5, valueStars: 5 }, "clerk_supplier_b");
  assert.equal(stranger.status, 403, JSON.stringify(stranger.body));
});

test("each side of an order sees its own price and its own date, and neither sees the other's", async (t) => {
  // Two figures the platform keeps apart on purpose, and a shop opening an
  // assigned job was seeing neither its price nor a date it could work to.
  const { call, orderId } = await placedOrder(t);
  await call(`/orders/${orderId}/payments/initial/confirm`, { method: "POST", subject: "clerk_ops", body: {} });
  await call(`/orders/${orderId}/transition`, { method: "POST", subject: "clerk_ops", body: { state: "supplier_assigned" } });

  const shop = (await call(`/orders/${orderId}`, { subject: "clerk_supplier_a" })).body.order;
  const client = (await call(`/orders/${orderId}`, { subject: "clerk_client" })).body.order;

  // The shop is told what it earns, under the name its own app asks for, and
  // the date it is actually held to.
  assert.ok(shop.supplierPriceMinor > 0, "the shop is told its price");
  assert.equal(shop.supplierPriceMinor, shop.supplierSubtotalMinor);
  assert.ok(shop.readyBy, "the shop is given its own finish date");

  // It is not told the padded date. A shop shown that works to it, and the
  // allowance is spent before the job starts.
  assert.equal(Object.hasOwn(shop, "promiseBy"), false);

  // The client is told the date it agreed to and never the shop's price.
  assert.ok(client.promiseBy, "the client keeps the date it was promised");
  assert.equal(Object.hasOwn(client, "supplierPriceMinor"), false);
  assert.equal(Object.hasOwn(client, "supplierSubtotalMinor"), false);
  // Nor the shop's earlier internal date, which would have it expecting the
  // job days before the one it agreed to.
  assert.equal(Object.hasOwn(client, "readyBy"), false);
});

test("a collected order runs the whole journey, because a rider takes it to the office", async (t) => {
  // Two different things have been called pickup. The one that was never
  // finished is the client collecting from the shop's own counter; the one
  // that shipped is collecting at GRIDGO Office, which a rider delivers to.
  // Held apart by fulfilment mode alone, the second was refused the moment its
  // shop pressed start — and the shop was told GRIDGO was unreachable.
  const { call, orderId } = await placedOrder(t, { fulfillmentMode: "pickup" });
  await call(`/orders/${orderId}/payments/initial/confirm`, { method: "POST", subject: "clerk_ops", body: {} });
  await call(`/orders/${orderId}/transition`, { method: "POST", subject: "clerk_ops", body: { state: "supplier_assigned" } });

  const collected = (await call(`/orders/${orderId}`, { subject: "clerk_ops" })).body.order;
  assert.equal(collected.fulfillmentMode, "pickup");
  assert.equal(collected.paymentPlan, "order_match_qr_75_25");

  // Accepting is a confirmation; there is nothing to quote.
  const accepted = await call(`/orders/${orderId}/transition`, {
    method: "POST", subject: "clerk_supplier_a", body: { state: "payment_authorized" },
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

  // And it starts, which is the whole of the captain's report.
  const started = await call(`/orders/${orderId}/transition`, {
    method: "POST", subject: "clerk_supplier_a", body: { state: "production" },
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.order.state, "production");

  // Through to staged for a rider.
  for (const state of ["supplier_self_qc", "ready_for_dispatch"]) {
    const moved = await call(`/orders/${orderId}/transition`, {
      method: "POST", subject: "clerk_supplier_a", body: { state },
    });
    assert.equal(moved.status, 200, `${state}: ${JSON.stringify(moved.body)}`);
  }

  // A rider is offered it. Collecting does not mean the job stays at the shop:
  // somebody carries it to the counter the client will collect from, and
  // without the offer it was packed, staged, and left sitting there.
  // Read as Operations, who see the same board a rider does. This fixture has
  // no rider account, and the question here is whether the order is offerable
  // at all rather than who is looking.
  const offers = (await call("/dispatch/offers", { subject: "clerk_ops" })).body.offers;
  const offered = offers.find((entry) => entry.id === orderId);
  assert.ok(offered, "a collected order is offered to a rider");

  // From the shop, to GRIDGO Office. Both ends, or the rider is driving to
  // somewhere nobody named.
  assert.ok(offered.pickup?.label, "the rider is told which shop to collect from");
  assert.equal(offered.dropoff?.label, "GRIDGO Office");

  // The client collects there, and is never given the shop's address.
  const clientView = (await call(`/orders/${orderId}`, { subject: "clerk_client" })).body.order;
  assert.equal(clientView.pickup?.label, "GRIDGO Office");
});
