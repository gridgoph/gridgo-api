import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import { createDatabase } from "../src/database.js";
import { loadStore, saveStore } from "../src/postgres-store.js";
import { checklistDigest, createPayoutMilestones } from "../src/operational-model.js";
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
      { id: "user_rider", clerkUserId: "clerk_rider", email: "rider@gridgo.test", name: "Rider", role: "rider", verificationStatus: "approved", createdAt: AT },
    );
    store.userRoleMemberships.push(
      { userId: "user_client", role: "client", createdAt: AT },
      { userId: "supplier_a", role: "supplier", createdAt: AT },
      { userId: "supplier_b", role: "supplier", createdAt: AT },
    { userId: "user_ops", role: "ops_admin", createdAt: AT },
      { userId: "user_rider", role: "rider", createdAt: AT },
    );
    store.riderProfiles.push({ userId: "user_rider", vehicleType: "motorcycle", plateNumber: "ABC 1234", version: 1, updatedAt: AT });
    store.approvalCases.push({ id: "case_rider", userId: "user_rider", kind: "rider", status: "approved", version: 1, applicationRevision: 1, createdAt: AT, updatedAt: AT });
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
      { fileId: "file_drop", ownerId: "user_rider", purpose: "delivery_photo", originalFilename: "drop.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", size: 10, state: "ready", objectKey: "rider/drop.jpg", references: [], createdAt: AT },
      { fileId: "file_sign", ownerId: "user_rider", purpose: "handoff_signature", originalFilename: "pickup-signature.png", declaredContentType: "image/png", detectedContentType: "image/png", size: 10, state: "ready", objectKey: "rider/pickup-signature.png", references: [], createdAt: AT },
    );
    await saveStore(database, store);
  });
}

/**
 * The supplier's signature, already on the order. Written straight into the
 * store the way the delivery photo is: what these tests exercise is the
 * checklist's refusal to move a package without it, not the pad.
 */
async function attachHandoffSignature(database, orderId, fileId = "file_sign") {
  await database.transaction(async () => {
    const store = await loadStore(database);
    const file = store.files.find((candidate) => candidate.fileId === fileId);
    file.references = [{ type: "order", id: orderId, field: "handoffSignatureFileIds" }];
    await saveStore(database, store);
  });
  return { fileId, signerName: "Ana Reyes" };
}

const ALL_SIX = ["quantity_match", "specification_match", "visible_defects", "packaging_integrity", "documentation", "supplier_sign_off"];

/*
 An order placed before the escrow split, as the migration left it: plan 1 and
 its four stages. The plan is part of the commitment and the database refuses
 to change it afterwards, so the fixture lifts that one guard for this write.
*/
async function asFourStageOrder(database, orderId) {
  await database.transaction(async () => {
    await database.query("ALTER TABLE orders DISABLE TRIGGER orders_committed_money_immutable_trigger");
    const store = await loadStore(database);
    const order = store.orders.find((row) => row.id === orderId);
    order.payoutPlanVersion = 1;
    order.payoutMilestones = createPayoutMilestones(order, { version: 1 });
    await saveStore(database, store);
    // Run the deferred checks now: a table with pending trigger events cannot
    // be altered, and the four stages must pass them anyway.
    await database.query("SET CONSTRAINTS ALL IMMEDIATE");
    await database.query("ALTER TABLE orders ENABLE TRIGGER orders_committed_money_immutable_trigger");
  });
}

// A Proof of Fulfilment written straight into the record: what these tests
// exercise is the release policy, not the camera.
async function attachProofDirectly(database, orderId, code) {
  await database.transaction(async () => {
    const store = await loadStore(database);
    const milestone = store.orders.find((row) => row.id === orderId).payoutMilestones.find((row) => row.code === code);
    milestone.pofFileIds = [`file_pof_${code}`];
    milestone.status = "pof_attached";
    await saveStore(database, store);
  });
}

// From a job packed and ready to the client's door: the rider takes it, runs
// the six checks with the shop's signature, and records the drop-off photo.
async function dispatchAndDeliver({ call, database, orderId }) {
  const post = (path, subject, body = {}) => call(path, { method: "POST", subject, body });
  assert.equal((await post(`/dispatch/${orderId}/accept`, "clerk_rider")).status, 200);
  const checks = ALL_SIX.map((code) => ({ code, passed: true }));
  const checked = await post(`/dispatch/${orderId}/pickup-checklist`, "clerk_rider", { checks, signature: await attachHandoffSignature(database, orderId) });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal((await post(`/orders/${orderId}/transition`, "clerk_rider", { state: "out_for_delivery" })).status, 200);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.files.find((file) => file.fileId === "file_drop").references = [{ type: "order", id: orderId, field: "deliveryPhotoFileIds" }];
    await saveStore(database, store);
  });
  const delivered = await post(`/dispatch/${orderId}/delivery`, "clerk_rider", { evidenceType: "photo", evidenceFileId: "file_drop" });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.equal(delivered.body.order.state, "issue_window_open");
  return delivered.body.order;
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
  const inbox = persisted.notifications.map((row) => `${row.userId}:${row.type}`).sort();
  assert.deepEqual(inbox, [
    "supplier_a:shop_job_assigned",
    "user_client:order_receipt_ready",
    "user_client:order_submitted",
    "user_ops:ops_assignment_changed",
    "user_ops:ops_job_needs_qa",
    "user_ops:ops_order_progress",
    "user_ops:ops_payment_submitted",
  ]);
  assert.equal(persisted.notifications.find(n=>n.type==="order_submitted").push,false);
});


/** Boots the API on a seeded database and returns a placed, paid-pending order. */
async function placedOrder(t, { catalogItemId = "item_supplier_a", fulfillmentMode = null, measurement = null, downpaymentPercent = null } = {}) {
  const database = createDatabase({ DATABASE_URL });
  t.after(() => database.close());
  await fixture(database);
  // New orders are paid in full up front; a test about the balance step asks
  // for the 75/25 split the business can still switch back to.
  if (downpaymentPercent) await database.transaction(async () => {
    const store = await loadStore(database);
    store.settings.downpaymentPercent = downpaymentPercent;
    await saveStore(database, store);
  });
  if (measurement) await database.transaction(async () => {
    const store = await loadStore(database);
    const item = store.catalogItems.find((row) => row.id === catalogItemId);
    item.pricingUnit = "per_area";
    item.measureUnit = "ft";
    await saveStore(database, store);
  });
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
  const added = await call(`/me/carts/${cartId}/lines`, {
    method: "POST", subject: "clerk_client",
    body: { catalogItemId, optionIds: [], quantity: 1, artworkFileId: "file_art", ...(measurement ? { measurement } : {}) },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const withMockup = await call(`/me/carts/${cartId}/lines/${added.body.cart.lines[0].id}/mockup`, {
    method: "PUT", subject: "clerk_client", body: { fileId: "file_mock" },
  });
  assert.equal(withMockup.status, 200, JSON.stringify(withMockup.body));
  const checkout = await call(`/me/carts/${cartId}/checkout`, {
    method: "POST", subject: "clerk_client",
    body: { payment: { method: "qr_manual", proofFileId: "file_qr", reference: "QR-900" } },
  });
  assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
  return { api, call, database, orderId: checkout.body.order.id, address, output: () => instance.output() };
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
  assert.equal(declined.body.order.supplierId, undefined);

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

/**
 * An order placed before the escrow split is paid exactly as it was sold.
 *
 * Four stages, none of which fires on its own: a shop is paid when somebody at
 * GRIDGO has looked at what it produced. A photograph nobody opens is a file,
 * not a check, so the release refuses without one.
 */
test("a legacy four-stage order is paid across its four stages, each on a photograph somebody looked at", async (t) => {
  const { call, database, orderId } = await placedOrder(t, { downpaymentPercent: 75 });
  await asFourStageOrder(database, orderId);
  const ops = (path, body) => call(path, { method: "POST", subject: "clerk_ops", body: body || {} });
  const transition = (state, subject, body = {}) => call(
    `/orders/${orderId}/transition`, { method: "POST", subject, body: { state, ...body } },
  );
  const orderNow = async () => (await call(`/orders/${orderId}`, { subject: "clerk_ops" })).body.order;
  const release = (code) => ops(`/orders/${orderId}/milestones/${code}/release`);

  // The proof, written straight into the record rather than photographed: what
  // is under test is the release policy, not the camera.
  const attachProof = async (code) => {
    await database.transaction(async () => {
      const store = await loadStore(database);
      const order = store.orders.find((row) => row.id === orderId);
      const milestone = order.payoutMilestones.find((row) => row.code === code);
      milestone.pofFileIds = [`file_pof_${code}`];
      milestone.status = "pof_attached";
      await saveStore(database, store);
    });
  };

  const placed = await orderNow();
  assert.equal(placed.payoutPlanVersion, 1);
  assert.deepEqual(
    placed.payoutMilestones.map((row) => row.code),
    ["printing", "packaging_qc", "delivered", "retention"],
  );
  assert.deepEqual(placed.payoutMilestones.map((row) => row.sharePercent), [50, 15, 25, 10]);
  assert.deepEqual(placed.payoutMilestones.map((row) => row.label), ["Printing", "Packaging", "Delivered", "Retention"]);
  assert.equal(
    placed.payoutMilestones.reduce((total, row) => total + row.amountMinor, 0),
    placed.supplierSubtotalMinor,
    "the four stages have to add up to the shop's price, not the client's total",
  );

  await ops(`/orders/${orderId}/payments/initial/confirm`);
  await transition("supplier_assigned", "clerk_ops");
  await transition("payment_authorized", "clerk_supplier_a");
  await transition("production", "clerk_supplier_a");

  // Starting production does not pay anybody. It only makes the first stage
  // releasable, which is a different thing.
  const producing = await orderNow();
  assert.equal(
    producing.payoutMilestones.every((row) => row.status !== "released"),
    true,
    "nothing releases itself",
  );

  const unproven = await release("printing");
  assert.equal(unproven.status, 409, JSON.stringify(unproven.body));
  assert.equal(unproven.body.error, "pof_required");

  await attachProof("printing");
  const printing = await release("printing");
  assert.equal(printing.status, 200, JSON.stringify(printing.body));
  assert.equal(printing.body.milestone.status, "released");

  // The shop is told, in pesos, the moment its money moves.
  const inbox = (await call("/notifications", { subject: "clerk_supplier_a" })).body.notifications;
  const told = inbox.find((row) => row.type === "shop_payout_released");
  assert.ok(told, `${JSON.stringify(inbox.map((row) => row.type))}`);
  assert.match(told.title, /released$/);

  // Packing names work the shop has not finished, so it is refused on the step
  // rather than on the proof.
  await attachProof("packaging_qc");
  const early = await release("packaging_qc");
  assert.equal(early.status, 409, JSON.stringify(early.body));
  assert.equal(early.body.error, "milestone_not_reached");

  await transition("supplier_self_qc", "clerk_supplier_a");
  assert.equal((await release("packaging_qc")).status, 200);

  // Delivered is 25 percent more than the client has paid, so it is refused on
  // the money until the balance clears -- and on the step until the client
  // actually has the job.
  await attachProof("delivered");
  const undelivered = await release("delivered");
  assert.equal(undelivered.status, 409, JSON.stringify(undelivered.body));
  assert.equal(undelivered.body.error, "delivery_required");

  await database.transaction(async () => {
    const store = await loadStore(database);
    const order = store.orders.find((row) => row.id === orderId);
    order.state = "issue_window_open";
    await saveStore(database, store);
  });
  const unpaid = await release("delivered");
  assert.equal(unpaid.status, 409, JSON.stringify(unpaid.body));
  assert.equal(unpaid.body.error, "supplier_principal_not_collected");

  await call(`/orders/${orderId}/payments/final_online/submit`, {
    method: "POST", subject: "clerk_client",
    body: { method: "qr_manual", proofFileId: "file_qr", reference: "QR-910" },
  });
  await ops(`/orders/${orderId}/payments/final_online/confirm`);
  assert.equal((await release("delivered")).status, 200);

  // Retention waits out the window, whatever has been collected.
  await attachProof("retention");
  const held = await release("retention");
  assert.equal(held.status, 409, JSON.stringify(held.body));
  assert.equal(held.body.error, "issue_window_open");

  await database.transaction(async () => {
    const store = await loadStore(database);
    store.orders.find((row) => row.id === orderId).state = "completed";
    await saveStore(database, store);
  });
  assert.equal((await release("retention")).status, 200);

  const settled = await orderNow();
  assert.equal(
    settled.payoutMilestones
      .filter((row) => row.status === "released")
      .reduce((total, row) => total + row.amountMinor, 0),
    settled.supplierSubtotalMinor,
    "the shop ends up with exactly its own price",
  );
});

/**
 * The captain's escrow split (gridgo-api#68, #73): 40 percent of the shop's own
 * cost when production starts, 35 on delivery, 25 once the complaint window
 * has closed. Only Operations or Super Admin release a share; the client's
 * "everything is fine" closes the window and pays nobody (gridgo-web#58).
 */
test("a new order pays the shop 40/35/25 of its own cost, each stage only after its proof", async (t) => {
  const { call, database, orderId } = await placedOrder(t);
  const post = (path, subject, body = {}) => call(path, { method: "POST", subject, body });
  const transition = (state, subject = "clerk_supplier_a") => post(`/orders/${orderId}/transition`, subject, { state });
  const release = (code, subject = "clerk_ops") => post(`/orders/${orderId}/milestones/${code}/release`, subject);
  const orderNow = async (subject = "clerk_ops") => (await call(`/orders/${orderId}`, { subject })).body.order;
  const stageNow = async (code) => (await orderNow()).payoutMilestones.find((row) => row.code === code);
  const refusedWith = async (code, error) => {
    const refused = await release(code);
    assert.equal(refused.status, 409, `${code}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, error, code);
  };

  const placed = await orderNow();
  assert.equal(placed.payoutPlanVersion, 2);
  assert.deepEqual(
    placed.payoutMilestones.map((row) => [row.code, row.label, row.sharePercent, row.releaseRequires]),
    [
      ["production_started", "Start of production", 40, "shop_proof"],
      ["delivered", "Delivered", 35, "delivery_proof"],
      ["issue_window", "Issue window closed", 25, "issue_window_closed"],
    ],
  );
  // Every share is of the shop's own cost, never of what the client paid.
  const cost = placed.supplierPriceMinor;
  assert.ok(placed.totalMinor > cost, "the client's total carries the fee and delivery on top");
  assert.deepEqual(
    placed.payoutMilestones.map((row) => row.amountMinor),
    [(cost * 40) / 100, (cost * 35) / 100, (cost * 25) / 100],
  );
  // The database recomputes the same split: moving a centavo between stages
  // is refused even though the total still matches.
  await assert.rejects(
    database.query(`
      UPDATE payout_milestones
         SET amount_minor = amount_minor + CASE code WHEN 'production_started' THEN 1 WHEN 'issue_window' THEN -1 ELSE 0 END
       WHERE order_id = $1
    `, [orderId]),
    (error) => error.code === "23514" && error.constraint === "payout_milestones_amount_check",
  );
  // The client sees the plan and its stages, never what the shop is paid.
  const clientView = await orderNow("clerk_client");
  assert.equal(clientView.payoutPlanVersion, 2);
  assert.deepEqual(clientView.payoutMilestones.map((row) => row.code), ["production_started", "delivered", "issue_window"]);
  assert.equal(clientView.payoutMilestones.some((row) => "amountMinor" in row), false);

  await post(`/orders/${orderId}/payments/initial/confirm`, "clerk_ops");
  assert.equal((await transition("supplier_assigned", "clerk_ops")).status, 200);
  assert.equal((await transition("payment_authorized")).status, 200);

  // Start of production: nothing to release until the shop's proof exists.
  await refusedWith("production_started", "pof_required");
  assert.equal((await transition("production")).status, 200);
  await refusedWith("production_started", "pof_required");
  await attachProofDirectly(database, orderId, "production_started");
  for (const subject of ["clerk_supplier_a", "clerk_client"]) {
    const denied = await release("production_started", subject);
    assert.equal(denied.status, 403, `${subject}: ${JSON.stringify(denied.body)}`);
  }
  const first = await release("production_started");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.milestone.status, "released");
  assert.equal(first.body.milestone.amountMinor, (cost * 40) / 100);

  // Delivered: no delivery proof exists while the job is still at the shop.
  await refusedWith("delivered", "pof_required");
  for (const state of ["supplier_self_qc", "ready_for_dispatch"]) {
    assert.equal((await transition(state)).status, 200, state);
  }
  await refusedWith("delivered", "pof_required");
  await dispatchAndDeliver({ call, database, orderId });

  // The rider's drop-off photo stands as the delivered proof, and moves no money.
  const proven = await stageNow("delivered");
  assert.equal(proven.status, "pof_attached");
  assert.deepEqual(proven.pofFileIds, ["file_drop"]);

  // The last share waits for the window to close, and never needs a file.
  await refusedWith("issue_window", "issue_window_open");
  const second = await release("delivered");
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.milestone.amountMinor, (cost * 35) / 100);
  await refusedWith("issue_window", "issue_window_open");

  // The client's "everything is fine" closes the window and pays nobody.
  const fine = await post(`/orders/${orderId}/confirm`, "clerk_client");
  assert.equal(fine.status, 200, JSON.stringify(fine.body));
  assert.equal(fine.body.order.state, "completed");
  assert.equal((await stageNow("issue_window")).status, "pending_pof");

  const last = await release("issue_window");
  assert.equal(last.status, 200, JSON.stringify(last.body));
  assert.equal(last.body.milestone.amountMinor, (cost * 25) / 100);

  const settled = await orderNow();
  assert.deepEqual(settled.payoutMilestones.map((row) => row.status), ["released", "released", "released"]);
  assert.equal(settled.payoutMilestones.reduce((total, row) => total + row.amountMinor, 0), cost);
  assert.equal((await transition("payout_released", "clerk_ops")).status, 200);
});

test("a claim holds every remaining share, and the last one waits out the clock", async (t) => {
  const { call, database, orderId } = await placedOrder(t);
  const post = (path, subject, body = {}) => call(path, { method: "POST", subject, body });
  const transition = (state, subject = "clerk_supplier_a") => post(`/orders/${orderId}/transition`, subject, { state });
  const release = (code) => post(`/orders/${orderId}/milestones/${code}/release`, "clerk_ops");
  const orderNow = async () => (await call(`/orders/${orderId}`, { subject: "clerk_ops" })).body.order;
  const refusedWith = async (code, error) => {
    const refused = await release(code);
    assert.equal(refused.status, 409, `${code}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, error, code);
  };
  const raiseClaim = async (reason) => {
    const raised = await post("/claims", "clerk_ops", { orderId, reason });
    assert.equal(raised.status, 201, JSON.stringify(raised.body));
    return raised.body.claim.id;
  };
  const releaseClaim = async (claimId) => {
    const cleared = await post(`/claims/${claimId}/release`, "clerk_ops", { reason: "Reprinted and accepted" });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  };

  await post(`/orders/${orderId}/payments/initial/confirm`, "clerk_ops");
  for (const [state, subject] of [["supplier_assigned", "clerk_ops"], ["payment_authorized"], ["production"]]) {
    assert.equal((await transition(state, subject)).status, 200, state);
  }
  await attachProofDirectly(database, orderId, "production_started");
  assert.equal((await release("production_started")).status, 200);
  for (const state of ["supplier_self_qc", "ready_for_dispatch"]) {
    assert.equal((await transition(state)).status, 200, state);
  }
  await dispatchAndDeliver({ call, database, orderId });

  // A claim during the window holds both shares still owed, and the client
  // cannot call the job clean around it.
  const during = await raiseClaim("Client reports smudged print");
  await refusedWith("delivered", "payout_held");
  await refusedWith("issue_window", "payout_held");
  const fine = await post(`/orders/${orderId}/confirm`, "clerk_client");
  assert.equal(fine.status, 409, JSON.stringify(fine.body));
  await releaseClaim(during);
  assert.equal((await release("delivered")).status, 200);
  await refusedWith("issue_window", "issue_window_open");

  // The clock ends the window, and pays nobody.
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.orders.find((row) => row.id === orderId).issueWindowExpiresAt = "2026-01-01T00:00:00.000Z";
    await saveStore(database, store);
  });
  const expired = await orderNow();
  assert.equal(expired.state, "completed");
  assert.equal(expired.payoutMilestones.find((row) => row.code === "issue_window").status, "pending_pof");

  // A claim after the window still holds the last share.
  const after = await raiseClaim("Client found a miscount after the window");
  await refusedWith("issue_window", "payout_held");
  await releaseClaim(after);
  const last = await release("issue_window");
  assert.equal(last.status, 200, JSON.stringify(last.body));

  const settled = await orderNow();
  assert.equal(settled.payoutMilestones.every((row) => row.status === "released"), true);
  assert.equal(settled.payoutMilestones.reduce((total, row) => total + row.amountMinor, 0), settled.supplierPriceMinor);
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

  // The shop reads what was said about each job, and where it stands — but
  // never who said it. The client was told nobody would see who left it.
  const mine = await call("/me/reviews", { subject: "clerk_supplier_a" });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.summary.count, 1);
  assert.equal(mine.body.summary.quality, 5);
  assert.equal(mine.body.summary.speed, 3);
  assert.equal(mine.body.summary.value, 4);
  assert.equal(mine.body.summary.overall, 4);
  assert.equal(mine.body.summary.reviewsUntilMatching, 4);
  assert.equal(mine.body.ranking.position, 1);
  assert.equal(mine.body.ranking.of, 1);
  assert.equal(mine.body.ranking.byCategory[0].categoryCode, "marketing_collateral");
  assert.equal(mine.body.ranking.byCategory[0].position, 1);
  assert.equal(mine.body.reviews.length, 1);
  assert.equal(mine.body.reviews[0].orderId, orderId);
  assert.equal(mine.body.reviews[0].comment, "Beautiful print, a day late.");
  assert.equal(mine.body.reviews[0].subcategoryCode, "flyers");
  assert.equal(Object.hasOwn(mine.body.reviews[0], "clientId"), false);

  // A shop nobody has rated yet is unranked, not last.
  const theirs = await call("/me/reviews", { subject: "clerk_supplier_b" });
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  assert.equal(theirs.body.summary.count, 0);
  assert.equal(theirs.body.ranking.position, null);
  assert.equal((await call("/me/reviews", { subject: "clerk_client" })).status, 403);

  // Operations reads the league table, overall and within one category, with
  // the cheapest listing price in that category beside the stars.
  assert.equal((await call("/admin/shop-rankings", { subject: "clerk_supplier_a" })).status, 403);
  const table = await call("/admin/shop-rankings?categoryCode=marketing_collateral", { subject: "clerk_ops" });
  assert.equal(table.status, 200, JSON.stringify(table.body));
  assert.equal(table.body.rankedCount, 1);
  assert.equal(table.body.rows[0].supplierId, "supplier_a");
  assert.equal(table.body.rows[0].position, 1);
  assert.equal(table.body.rows[0].fromPriceMinor, 10_000);
  const unranked = table.body.rows.find((row) => row.supplierId === "supplier_b");
  assert.equal(unranked.position, null);
  assert.equal(unranked.count, 0);
  assert.ok(table.body.categories.some((row) => row.code === "marketing_collateral"));
  const bogus = await call("/admin/shop-rankings?categoryCode=nope", { subject: "clerk_ops" });
  assert.equal(bogus.status, 400);
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

/**
 * A collected order has two endings, and only the second one is the client's.
 *
 * The rider reaching GRIDGO Office is not the client receiving the job. Treated
 * as one ending, the rider was held at our own counter against a balance nobody
 * present could pay, and the order could never move again; recorded as a
 * delivery, it would have closed the job and started the complaint window while
 * the package was still on our shelf.
 */
test("a collected order stops on the counter, and only the counter hands it over", { skip: !DATABASE_URL }, async (t) => {
  const { call, database, orderId } = await placedOrder(t, { fulfillmentMode: "pickup", downpaymentPercent: 75 });
  await call(`/orders/${orderId}/payments/initial/confirm`, { method: "POST", subject: "clerk_ops", body: {} });
  await call(`/orders/${orderId}/transition`, { method: "POST", subject: "clerk_ops", body: { state: "supplier_assigned" } });
  for (const state of ["payment_authorized", "production", "supplier_self_qc", "ready_for_dispatch"]) {
    const moved = await call(`/orders/${orderId}/transition`, {
      method: "POST", subject: "clerk_supplier_a", body: { state },
    });
    assert.equal(moved.status, 200, `${state}: ${JSON.stringify(moved.body)}`);
  }

  // The balance is not settled, and it does not stop the carrying. Nothing is
  // being handed to anybody: the job is going onto GRIDGO's own shelf.
  const accepted = await call(`/dispatch/${orderId}/accept`, { method: "POST", subject: "clerk_rider", body: {} });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const checked = await call(`/dispatch/${orderId}/pickup-checklist`, {
    method: "POST", subject: "clerk_rider",
    body: {
      checks: ALL_SIX.map((code) => ({ code, passed: true })),
      signature: await attachHandoffSignature(database, orderId),
    },
  });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  const started = await call(`/orders/${orderId}/transition`, {
    method: "POST", subject: "clerk_rider", body: { state: "out_for_delivery" },
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  // The rider's evidence, bound to this order. Written straight into the store
  // rather than uploaded, because what is under test is the ending, not the
  // camera.
  await database.transaction(async () => {
    const store = await loadStore(database);
    const file = store.files.find((candidate) => candidate.fileId === "file_drop");
    file.references = [{ type: "order", id: orderId, field: "deliveryPhotoFileIds" }];
    await saveStore(database, store);
  });

  const dropped = await call(`/dispatch/${orderId}/delivery`, {
    method: "POST", subject: "clerk_rider",
    body: { evidenceType: "photo", evidenceFileId: "file_drop" },
  });
  assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
  assert.equal(dropped.body.order.state, "awaiting_collection");

  // Nothing has been given to the client yet, so nothing about the job is over.
  assert.equal(dropped.body.order.issueWindowOpenedAt ?? null, null);

  // The counter is where the money is owed, and it refuses without it.
  const early = await call(`/orders/${orderId}/collection`, {
    method: "POST", subject: "clerk_ops", body: { receivedBy: "Ana Cruz" },
  });
  assert.equal(early.status, 409, JSON.stringify(early.body));
  assert.equal(early.body.error, "final_payment_not_confirmed");

  await call(`/orders/${orderId}/payments/final_online/submit`, {
    method: "POST", subject: "clerk_client",
    body: { method: "qr_manual", proofFileId: "file_qr", reference: "QR-901" },
  });
  await call(`/orders/${orderId}/payments/final_online/confirm`, { method: "POST", subject: "clerk_ops", body: {} });

  // A hand-over with no name is a hand-over nobody can check afterwards.
  const nameless = await call(`/orders/${orderId}/collection`, {
    method: "POST", subject: "clerk_ops", body: {},
  });
  assert.equal(nameless.status, 400, JSON.stringify(nameless.body));

  const released = await call(`/orders/${orderId}/collection`, {
    method: "POST", subject: "clerk_ops", body: { receivedBy: "Ana Cruz" },
  });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(released.body.order.state, "issue_window_open");
  assert.ok(released.body.order.issueWindowOpenedAt, "the complaint window starts when the client has it");
  assert.ok(
    released.body.order.timeline.some((entry) => entry.note?.includes("Ana Cruz")),
    "who collected it is written into the record",
  );
});

/**
 * A shop-ready delivery is a rider offer even when the remaining QR balance
 * is still unpaid. That money is owed at the door, not as a condition of
 * leaving the printer — withholding it left packed Business Cards sitting at
 * the shop while Rider showed an empty board.
 */
test("a shop-ready delivery is offered even when the remaining balance is unpaid", { skip: !DATABASE_URL }, async (t) => {
  const { call, orderId } = await placedOrder(t);
  await call(`/orders/${orderId}/payments/initial/confirm`, { method: "POST", subject: "clerk_ops", body: {} });
  await call(`/orders/${orderId}/transition`, { method: "POST", subject: "clerk_ops", body: { state: "supplier_assigned" } });
  for (const state of ["payment_authorized", "production", "supplier_self_qc", "ready_for_dispatch"]) {
    await call(`/orders/${orderId}/transition`, { method: "POST", subject: "clerk_supplier_a", body: { state } });
  }

  const offered = (await call("/dispatch/offers", { subject: "clerk_rider" })).body.offers;
  assert.ok(offered.some((entry) => entry.id === orderId), "a ready delivery is offered before the remaining balance clears");

  const accepted = await call(`/dispatch/${orderId}/accept`, { method: "POST", subject: "clerk_rider", body: {} });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.order.state, "rider_assigned");
});

test("packaging ready offers the job atomically and joint pickup checks still gate transport", { skip: !DATABASE_URL }, async (t) => {
  const { call, database, orderId } = await placedOrder(t);
  // Other outbox tests lease every due row, so retire this fixture's devices
  // and their queued pushes after the API exits, including on assertion failure.
  t.after(async () => {
    const cleanup = createDatabase({ DATABASE_URL });
    try {
      await cleanup.query("DELETE FROM device_tokens WHERE id = ANY($1::text[])", [["device_rider", "device_other", "device_pending", "device_wrong_role"]]);
    } finally {
      await cleanup.close();
    }
  });
  const transition = (state, subject = "clerk_supplier_a") => call(`/orders/${orderId}/transition`, {
    method: "POST", subject, body: { state },
  });
  await call(`/orders/${orderId}/payments/initial/confirm`, { method: "POST", subject: "clerk_ops", body: {} });
  await transition("supplier_assigned", "clerk_ops");
  await transition("payment_authorized");
  await transition("production");

  // A second approved rider gets the same offer; a pending rider and a device
  // signed into another role must not receive it.
  await database.transaction(async () => {
    const store = await loadStore(database);
    for (const [suffix, status] of [["other", "approved"], ["pending", "pending"]]) {
      const userId = `rider_${suffix}`;
      store.users.push({ id: userId, clerkUserId: `clerk_${userId}`, email: `${userId}@gridgo.test`, name: "Rider", role: "rider", verificationStatus: status, createdAt: AT });
      store.userRoleMemberships.push({ userId, role: "rider", createdAt: AT });
      store.approvalCases.push({ id: `case_${userId}`, userId, kind: "rider", status, version: 1, applicationRevision: 1, createdAt: AT, updatedAt: AT });
    }
    for (const [deviceId, userId, appRole] of [
      ["device_rider", "user_rider", "rider"],
      ["device_other", "rider_other", "rider"],
      ["device_pending", "rider_pending", "rider"],
      ["device_wrong_role", "user_rider", "client"],
    ]) {
      store.deviceTokens.push({ id: deviceId, userId, appRole, token: `${deviceId}_token`, platform: "android", createdAt: AT, updatedAt: AT });
    }
    const file = store.files.find((row) => row.fileId === "file_drop");
    file.references = [{ type: "order", id: orderId, field: "deliveryPhotoFileIds" }];
    await saveStore(database, store);
  });

  const before = (await loadStore(database)).orders.find((row) => row.id === orderId);
  const denied = await transition("ready_for_dispatch", "clerk_supplier_b");
  assert.equal(denied.status, 403);
  assert.equal((await loadStore(database)).orders.find((row) => row.id === orderId).state, "production");
  assert.equal((await loadStore(database)).notifications.some((row) => row.orderId === orderId && row.type === "dispatch_available"), false);

  const ready = await transition("ready_for_dispatch");
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.equal(ready.body.order.state, "ready_for_dispatch");
  const stored = await loadStore(database);
  const packed = stored.orders.find((row) => row.id === orderId);
  assert.ok(packed.readyAt);
  assert.equal(packed.timeline.some((row) => row.state === "supplier_self_qc"), false);
  assert.equal(stored.orderJobs.find((row) => row.orderId === orderId).state, "ready_for_dispatch");
  assert.deepEqual(packed.payments, before.payments);
  assert.deepEqual(packed.payoutMilestones, before.payoutMilestones);
  const notices = stored.notifications.filter((row) => row.orderId === orderId && row.type === "dispatch_available");
  assert.deepEqual(notices.map((row) => row.userId).sort(), ["rider_other", "user_rider"]);
  for (const notice of notices) assert.match(notice.body, /check.*supplier/i);
  const outbox = await database.query("SELECT device_id FROM notification_push_outbox WHERE notification_id = ANY($1::text[]) ORDER BY device_id", [notices.map((row) => row.id)]);
  assert.deepEqual(outbox.rows.map((row) => row.device_id), ["device_other", "device_rider"]);
  assert.equal((await call("/dispatch/offers", { subject: "clerk_rider" })).body.offers.some((row) => row.id === orderId), true);
  assert.equal((await call("/dispatch/offers", { subject: "clerk_rider_pending" })).status, 403);

  // A retried readiness action cannot create another offer occurrence.
  assert.equal((await transition("ready_for_dispatch")).status, 409);
  assert.equal((await loadStore(database)).notifications.filter((row) => row.orderId === orderId && row.type === "dispatch_available").length, 2);
  const accepted = await call(`/dispatch/${orderId}/accept`, { method: "POST", subject: "clerk_rider", body: {} });
  assert.equal(accepted.status, 200);
  assert.equal((await call(`/dispatch/${orderId}/accept`, { method: "POST", subject: "clerk_rider_other", body: {} })).status, 409);
  assert.equal((await call("/dispatch/offers", { subject: "clerk_rider_other" })).body.offers.some((row) => row.id === orderId), false);
  assert.equal((await transition("picked_up", "clerk_rider")).status, 409);
  assert.equal((await transition("out_for_delivery", "clerk_rider")).status, 409);

  const checks = ["quantity_match", "specification_match", "visible_defects", "packaging_integrity", "documentation", "supplier_sign_off"].map((code) => ({ code, passed: true }));
  const check = (body, subject = "clerk_rider") => call(`/dispatch/${orderId}/pickup-checklist`, { method: "POST", subject, body });
  assert.equal((await check({ checks }, "clerk_supplier_a")).status, 403);
  assert.equal((await check({ checks }, "clerk_rider_other")).status, 404);
  assert.equal((await check({ checks: checks.slice(1) })).status, 400);
  const failed = await check({
    checks: checks.map((row) => ({ ...row, passed: row.code !== "packaging_integrity" })),
    failureNote: "Supplier and rider found torn packaging", evidenceFileIds: ["file_drop"],
  });
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  assert.equal(failed.body.order.state, "rider_assigned");
  assert.equal(failed.body.order.pickupChecklist.status, "failed_escalated");
  assert.equal((await check({ checks })).body.error, "pickup_escalation_open");
  const resolved = await call(`/escalations/${failed.body.escalation.id}/resolve`, {
    method: "POST", subject: "clerk_ops", body: { resolution: "Supplier repacked; repeat all six checks together" },
  });
  assert.equal(resolved.status, 200);
  assert.equal((await transition("out_for_delivery", "clerk_rider")).status, 409);

  // Six passes move nothing on their own: custody changes hands only once the
  // supplier has signed on the rider's phone. A client that never learned
  // about the signature is refused rather than let through on the checks.
  const unsigned = await check({ checks });
  assert.equal(unsigned.status, 409, JSON.stringify(unsigned.body));
  assert.equal(unsigned.body.error, "handoff_signature_required");
  assert.equal((await call(`/orders/${orderId}`, { subject: "clerk_rider" })).body.order.state, "rider_assigned");
  // The signature has to be a file this rider attached to this order first.
  const unattached = await check({ checks, signature: { fileId: "file_sign", signerName: "Ana Reyes" } });
  assert.equal(unattached.status, 400, JSON.stringify(unattached.body));
  assert.equal(unattached.body.error, "invalid_handoff_signature");
  const signature = await attachHandoffSignature(database, orderId);
  // A signature nobody is named on proves nothing.
  const anonymous = await check({ checks, signature: { fileId: signature.fileId, signerName: " " } });
  assert.equal(anonymous.status, 400, JSON.stringify(anonymous.body));
  assert.equal(anonymous.body.error, "handoff_signer_name_required");
  // The rider's own name is prefilled from the shop profile the API projects.
  const atCounter = (await call(`/orders/${orderId}`, { subject: "clerk_rider" })).body.order;
  assert.deepEqual(atCounter.supplierContact, { shopName: "supplier_a Shop", contactName: "supplier_a" });
  assert.equal(atCounter.pickupChecklist.status, "escalation_resolved");

  const passed = await check({ checks, signature });
  assert.equal(passed.status, 200, JSON.stringify(passed.body));
  assert.equal(passed.body.order.state, "picked_up");
  assert.equal(passed.body.order.pickupChecklist.completedBy, "user_rider");
  const recorded = passed.body.order.pickupChecklist.handoffSignature;
  assert.equal(recorded.fileId, "file_sign");
  assert.equal(recorded.signerName, "Ana Reyes");
  assert.equal(recorded.riderId, "user_rider");
  assert.equal(recorded.signedAt, passed.body.order.pickupChecklist.completedAt);
  assert.equal(recorded.checklistHash, checklistDigest(orderId, checks));
  assert.deepEqual(passed.body.handoffSignature, recorded);
  assert.match(passed.body.order.timeline.at(-1).note, /Ana Reyes signed the handoff/);
  // The shop and Operations read the same record off the order they already
  // fetch; the client is not shown who signed for the shop.
  assert.deepEqual((await call(`/orders/${orderId}`, { subject: "clerk_supplier_a" })).body.order.pickupChecklist.handoffSignature, recorded);
  assert.deepEqual((await call(`/orders/${orderId}`, { subject: "clerk_ops" })).body.order.pickupChecklist.handoffSignature, recorded);
  const clientView = (await call(`/orders/${orderId}`, { subject: "clerk_client" })).body.order;
  assert.equal(clientView.pickupChecklist.status, "passed");
  assert.equal(Object.hasOwn(clientView.pickupChecklist, "handoffSignature"), false);
  assert.equal(Object.hasOwn(clientView, "supplierContact"), false);
  // Signed once. The checklist route is closed behind the package.
  assert.equal((await check({ checks, signature })).body.error, "pickup_checklist_not_available");
  assert.equal((await transition("out_for_delivery", "clerk_rider")).status, 200);
});


test("final QR receipt survives submission and only Operations clears delivery", { skip: !DATABASE_URL }, async (t) => {
  const { call, database, orderId } = await placedOrder(t, { measurement: { width: 2000, height: 3000 }, downpaymentPercent: 75 });
  const post = (path, subject, body = {}) => call(path, { method: "POST", subject, body });
  const transition = (state, subject = "clerk_supplier_a") => post(`/orders/${orderId}/transition`, subject, { state });
  assert.equal((await post(`/orders/${orderId}/payments/initial/confirm`, "clerk_ops")).status, 200);
  assert.equal((await transition("supplier_assigned", "clerk_ops")).status, 200);
  assert.equal((await transition("payment_authorized")).status, 200);
  assert.equal((await transition("production")).status, 200);
  assert.equal((await transition("ready_for_dispatch")).status, 200);
  assert.equal((await post(`/dispatch/${orderId}/accept`, "clerk_rider")).status, 200);
  const checks = ALL_SIX.map((code) => ({ code, passed: true }));
  assert.equal((await post(`/dispatch/${orderId}/pickup-checklist`, "clerk_rider", { checks, signature: await attachHandoffSignature(database, orderId) })).status, 200);
  assert.equal((await transition("out_for_delivery", "clerk_rider")).status, 200);
  const current = () => call(`/orders/${orderId}`, { subject: "clerk_client" });
  const submit = (proofFileId, route = "final_online") => post(`/orders/${orderId}/payments/${route}/submit`, "clerk_client", { method: "qr_manual", reference: "FINAL-123", ...(proofFileId === undefined ? {} : { proofFileId }) });
  const before = (await current()).body.order;
  assert.deepEqual(before.productionItems[0].measurement, { widthMilli: 2000, heightMilli: 3000, unit: "ft" });
  assert.equal(before.productionItems[0].mockupFileId, "file_mock");
  const blocked = await post(`/dispatch/${orderId}/delivery`, "clerk_rider");
  assert.equal(blocked.body.error, "final_payment_not_confirmed");
  await database.transaction(async () => {
    const store = await loadStore(database);
    const original = store.files.find((file) => file.fileId === "file_qr");
    for (const [fileId, ownerId, state] of [["receipt_final", "user_client", "ready"], ["receipt_foreign", "supplier_b", "ready"], ["receipt_pending", "user_client", "pending_upload"]]) {
      store.files.push({ ...original, fileId, ownerId, state, objectKey: `${fileId}.jpg`, references: [] });
    }
    await saveStore(database, store);
  });
  for (const [fileId, status] of [["receipt_foreign", 404], ["file_art", 400], ["receipt_pending", 409], ["missing", 404]]) {
    assert.equal((await submit(fileId)).status, status);
    assert.deepEqual((await current()).body.order.payments, before.payments);
  }
  let response = await submit("receipt_final", "balance");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.order.state, "out_for_delivery");
  assert.equal(response.body.order.payments.final_online.proofFileId, "receipt_final");
  assert.equal(response.body.order.payments.final_online.status, "pending_confirmation");
  assert.equal(response.body.order.payments.final_online.amountMinor, before.payments.final_online.amountMinor);
  assert.equal((await submit("receipt_final")).status, 409);
  for (const subject of ["clerk_supplier_a", "clerk_rider"]) {
    const projected = (await call(`/orders/${orderId}`, { subject })).body.order;
    assert.equal(projected.productionItems.length, 1);
    assert.equal(projected.payments.final_online.proofFileId, undefined);
    assert.equal((await call("/files/receipt_final", { subject })).status, 403);
    assert.equal((await call("/files/receipt_final/download-url", { subject })).status, 403);
    for (const fileId of ["file_art", "file_mock"]) assert.equal((await call(`/files/${fileId}`, { subject })).status, 200);
  }
  for (const subject of ["clerk_client", "clerk_ops"]) assert.equal((await call("/files/receipt_final", { subject })).status, 200);
  const stored = await loadStore(database);
  assert.deepEqual(stored.files.find((file) => file.fileId === "receipt_final").references, [{ type: "order", id: orderId, field: "payment:final_online:proof" }]);
  let inbox = (await call("/notifications", { subject: "clerk_client" })).body.notifications;
  assert.equal(inbox.find((row) => row.type === "order_in_production").eventState, "production");
  assert.equal(inbox.find((row) => row.type === "order_in_production").paymentAction.status, "pending_confirmation");
  assert.equal((await post(`/orders/${orderId}/payments/final_online/confirm`, "clerk_client")).status, 403);
  assert.equal((await post(`/dispatch/${orderId}/delivery`, "clerk_rider")).body.error, "final_payment_not_confirmed");
  assert.equal((await post(`/orders/${orderId}/payments/final_online/reject`, "clerk_ops", { reason: "Reference unreadable" })).status, 200);
  assert.equal((await current()).body.order.payments.final_online.proofFileId, null);
  inbox = (await call("/notifications", { subject: "clerk_client" })).body.notifications;
  assert.equal(inbox.find((row) => row.type === "order_out_for_delivery").paymentAction.status, "due");
  // Reference-only legacy clients retain their route contract; OCR never confirms money.
  assert.equal((await submit(undefined)).status, 200);
  assert.equal((await post(`/orders/${orderId}/payments/final_online/confirm`, "clerk_ops")).status, 200);
  assert.equal((await current()).body.order.payments.final_online.status, "confirmed");
  inbox = (await call("/notifications", { subject: "clerk_client" })).body.notifications;
  assert.equal(inbox.some((row) => row.paymentAction), false);
  assert.equal((await loadStore(database)).notifications.filter((row) => row.orderId === orderId && row.type === "rider_delivery_payment_cleared").length, 1);
});

/**
 * 100 percent upfront checkout (gridgo-api#66).
 *
 * One transfer and one confirmation carry the whole order: nothing is left to
 * owe at the door or the counter, the balance routes refuse because there is
 * no balance, and the shop's three stages are covered by that one payment.
 */
test("a paid-up-front order runs from one confirmation to a fully released payout", { skip: !DATABASE_URL }, async (t) => {
  const { call, database, orderId } = await placedOrder(t);
  const post = (path, subject, body = {}) => call(path, { method: "POST", subject, body });
  const transition = (state, subject = "clerk_supplier_a") => post(`/orders/${orderId}/transition`, subject, { state });
  const orderNow = async (subject = "clerk_ops") => (await call(`/orders/${orderId}`, { subject })).body.order;
  const release = (code) => post(`/orders/${orderId}/milestones/${code}/release`, "clerk_ops");

  const placed = await orderNow("clerk_client");
  assert.equal(placed.downpaymentPercent, 100);
  assert.equal(placed.payments.initial.amountMinor, placed.totalMinor);
  assert.equal(placed.payments.initial.label, "Full payment");
  assert.equal(placed.payments.final_online.amountMinor, 0);
  assert.equal(placed.payments.final_online.status, "not_required");
  const invoice = (await call(`/orders/${orderId}/invoice`, { subject: "clerk_client" })).body.invoice;
  assert.deepEqual(invoice.paymentPlan, { method: "qr_manual", downpaymentPercent: 100, downpaymentMinor: placed.totalMinor, balanceMinor: 0 });

  // Nobody can submit, confirm or reject a balance that does not exist, by
  // either route name.
  for (const route of ["final_online", "balance"]) {
    for (const [action, subject] of [["submit", "clerk_client"], ["confirm", "clerk_ops"], ["reject", "clerk_ops"]]) {
      const refused = await post(`/orders/${orderId}/payments/${route}/${action}`, subject, { method: "qr_manual", reference: "QR-BAL", reason: "x" });
      assert.equal(refused.status, 409, `${route}/${action}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.error, "balance_not_required");
    }
  }

  const confirmed = await post(`/orders/${orderId}/payments/initial/confirm`, "clerk_ops");
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.order.paymentStatus, "paid");
  assert.equal(confirmed.body.order.payments.final_online.status, "not_required");

  for (const [state, subject] of [["supplier_assigned", "clerk_ops"], ["payment_authorized"], ["production"]]) {
    const moved = await transition(state, subject);
    assert.equal(moved.status, 200, `${state}: ${JSON.stringify(moved.body)}`);
  }
  await attachProofDirectly(database, orderId, "production_started");
  assert.equal((await release("production_started")).status, 200);
  for (const state of ["supplier_self_qc", "ready_for_dispatch"]) {
    const moved = await transition(state);
    assert.equal(moved.status, 200, `${state}: ${JSON.stringify(moved.body)}`);
  }

  // The client is never asked for a balance along the way.
  const inbox = (await call("/notifications", { subject: "clerk_client" })).body.notifications;
  assert.equal(inbox.some((row) => row.paymentAction), false);

  // The door does not wait on a balance: it was paid at checkout.
  await dispatchAndDeliver({ call, database, orderId });

  // The collected principal already covers every stage, and the rider's
  // drop-off photo is the delivered proof.
  const deliveredRelease = await release("delivered");
  assert.equal(deliveredRelease.status, 200, JSON.stringify(deliveredRelease.body));
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.orders.find((row) => row.id === orderId).state = "completed";
    await saveStore(database, store);
  });
  assert.equal((await release("issue_window")).status, 200);

  const settled = await orderNow();
  assert.equal(settled.payoutMilestones.every((row) => row.status === "released"), true);
  assert.equal(
    settled.payoutMilestones.reduce((total, row) => total + row.amountMinor, 0),
    settled.supplierSubtotalMinor,
    "the shop ends up with exactly its own price",
  );
});

/**
 * An order placed on 75/25 before the change carries no `downpaymentPercent`.
 * It reads as 75 and keeps its balance step at the door, exactly as before.
 */
test("a legacy 75/25 order still needs its balance before delivery", { skip: !DATABASE_URL }, async (t) => {
  const { call, database, orderId } = await placedOrder(t, { downpaymentPercent: 75 });
  // Back to the business default, and the record back to its pre-snapshot shape.
  await database.transaction(async () => {
    const store = await loadStore(database);
    delete store.settings.downpaymentPercent;
    delete store.orders.find((row) => row.id === orderId).downpaymentPercent;
    await saveStore(database, store);
  });
  const post = (path, subject, body = {}) => call(path, { method: "POST", subject, body });
  const transition = (state, subject = "clerk_supplier_a") => post(`/orders/${orderId}/transition`, subject, { state });

  const placed = (await call(`/orders/${orderId}`, { subject: "clerk_client" })).body.order;
  assert.equal(placed.downpaymentPercent, 75);
  assert.equal(placed.payments.final_online.status, "not_submitted");
  assert.equal(placed.payments.initial.amountMinor + placed.payments.final_online.amountMinor, placed.totalMinor);
  assert.ok(placed.payments.final_online.amountMinor > 0);
  const invoice = (await call(`/orders/${orderId}/invoice`, { subject: "clerk_client" })).body.invoice;
  assert.equal(invoice.paymentPlan.downpaymentPercent, 75);

  const confirmed = await post(`/orders/${orderId}/payments/initial/confirm`, "clerk_ops");
  assert.equal(confirmed.body.order.paymentStatus, "initial_payment_confirmed");
  for (const [state, subject] of [["supplier_assigned", "clerk_ops"], ["payment_authorized"], ["production"], ["ready_for_dispatch"]]) {
    assert.equal((await transition(state, subject)).status, 200, state);
  }
  assert.equal((await post(`/dispatch/${orderId}/accept`, "clerk_rider")).status, 200);
  const checks = ALL_SIX.map((code) => ({ code, passed: true }));
  assert.equal((await post(`/dispatch/${orderId}/pickup-checklist`, "clerk_rider", { checks, signature: await attachHandoffSignature(database, orderId) })).status, 200);
  assert.equal((await transition("out_for_delivery", "clerk_rider")).status, 200);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.files.find((file) => file.fileId === "file_drop").references = [{ type: "order", id: orderId, field: "deliveryPhotoFileIds" }];
    await saveStore(database, store);
  });
  const deliver = () => post(`/dispatch/${orderId}/delivery`, "clerk_rider", { evidenceType: "photo", evidenceFileId: "file_drop" });

  const blocked = await deliver();
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, "final_payment_not_confirmed");
  const submitted = await post(`/orders/${orderId}/payments/balance/submit`, "clerk_client", { method: "qr_manual", reference: "QR-BAL" });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal((await post(`/orders/${orderId}/payments/balance/confirm`, "clerk_ops")).status, 200);
  const delivered = await deliver();
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.equal(delivered.body.order.paymentStatus, "paid");
});

/**
 * The split is an Operations setting on the existing versioned handshake. It
 * decides new checkouts only; every order keeps the split it was placed under.
 */
test("the downpayment setting switches new checkouts between 75 and 100 and validates", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  t.after(() => database.close());
  await fixture(database);
  // A settings row written before the field existed reads as 100.
  await database.transaction(async () => {
    const store = await loadStore(database);
    delete store.settings.downpaymentPercent;
    await saveStore(database, store);
  });
  const instance = await startApi();
  t.after(async () => {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
  });
  const call = (pathname, options = {}) => request(instance.api, pathname, options);
  const patch = (body, subject = "clerk_ops") => call("/settings", { method: "PATCH", subject, body });

  let current = await call("/settings", { subject: "clerk_client" });
  assert.equal(current.status, 200);
  assert.equal(current.body.settings.downpaymentPercent, 100);
  const version = current.body.version;

  assert.equal((await patch({ expectedVersion: version, reason: "Back to 75/25", downpaymentPercent: 75 }, "clerk_client")).status, 403);
  for (const bad of [50, 0, "75", 75.5, null]) {
    const invalid = await patch({ expectedVersion: version, reason: "Try", downpaymentPercent: bad });
    assert.equal(invalid.status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(invalid.body)}`);
    assert.equal(invalid.body.error, "invalid_downpayment_percent");
  }
  const stale = await patch({ expectedVersion: version - 1, reason: "Back to 75/25", downpaymentPercent: 75 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "settings_version_conflict");

  // Another change leaves the split where it is.
  const unrelated = await patch({ expectedVersion: version, reason: "Longer window", issueWindowHours: 48 });
  assert.equal(unrelated.status, 200, JSON.stringify(unrelated.body));
  assert.equal(unrelated.body.settings.downpaymentPercent, 100);

  const toSeventyFive = await patch({ expectedVersion: unrelated.body.version, reason: "Back to 75/25", downpaymentPercent: 75 });
  assert.equal(toSeventyFive.status, 200, JSON.stringify(toSeventyFive.body));
  assert.equal(toSeventyFive.body.settings.downpaymentPercent, 75);
  current = await call("/settings", { subject: "clerk_client" });
  assert.equal(current.body.settings.downpaymentPercent, 75);

  const checkoutOne = async (reference, proofFileId = "file_qr") => {
    const cart = await call("/me/carts", {
      method: "POST", subject: "clerk_client",
      body: { fulfillmentMode: "delivery", defaultDropoff: { lat: 7.0731, lng: 125.6128, label: "Home" } },
    });
    const cartId = cart.body.cart.id;
    const added = await call(`/me/carts/${cartId}/lines`, {
      method: "POST", subject: "clerk_client",
      body: { catalogItemId: "item_supplier_a", optionIds: [], quantity: 1, artworkFileId: "file_art" },
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const checkout = await call(`/me/carts/${cartId}/checkout`, {
      method: "POST", subject: "clerk_client",
      body: { payment: { method: "qr_manual", proofFileId, reference } },
    });
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    return checkout.body.order;
  };

  const seventyFive = await checkoutOne("QR-75");
  assert.equal(seventyFive.downpaymentPercent, 75);
  assert.equal(seventyFive.paymentPlan.balanceStatus, "not_submitted");
  assert.ok(seventyFive.paymentPlan.balanceMinor > 0);

  const toHundred = await patch({ expectedVersion: toSeventyFive.body.version, reason: "Full payment", downpaymentPercent: 100 });
  assert.equal(toHundred.status, 200, JSON.stringify(toHundred.body));
  // Switching back never rewrites the order already placed on 75/25.
  const kept = (await call(`/orders/${seventyFive.id}`, { subject: "clerk_client" })).body.order;
  assert.equal(kept.downpaymentPercent, 75);
  assert.equal(kept.payments.final_online.amountMinor, seventyFive.paymentPlan.balanceMinor);
  assert.equal(kept.payments.final_online.status, "not_submitted");

  // The earlier checkout's proof is bound to that order, so upload another.
  await database.transaction(async () => {
    const store = await loadStore(database);
    const original = store.files.find((file) => file.fileId === "file_qr");
    store.files.push({ ...original, fileId: "file_qr_two", objectKey: "client/qr-two.jpg", references: [] });
    await saveStore(database, store);
  });
  const hundred = await checkoutOne("QR-100", "file_qr_two");
  assert.equal(hundred.downpaymentPercent, 100);
  assert.equal(hundred.paymentPlan.downpaymentMinor, hundred.totalMinor);
  assert.equal(hundred.paymentPlan.balanceMinor, 0);
  assert.equal(hundred.paymentPlan.balanceStatus, "not_required");
});
