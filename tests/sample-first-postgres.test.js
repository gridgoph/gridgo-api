// Sample First (gridgo-api#222) through real HTTP and PostgreSQL: a paid sample
// is its own order, its intended batch is held at the shop's old price list
// (bulk tiers included) for the hold after delivery, and the batch is a normal
// order linked and tagged to its sample. Contract: docs/SAMPLE_FIRST_API.md.
import { resetDatabase } from './fixtures/reset-database.js';
import { alwaysOpenOperatingHours } from "./helpers/operating-hours.mjs";
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
const DAY = 24 * 60 * 60 * 1000;
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_KEY = publicKey.export({ type: "spki", format: "pem" });
const ITEM = "item_supplier_a";
const DROPOFF = { lat: 7.07, lng: 125.61, label: "Client office" };
const PAYMENT = (reference) => ({ payment: { method: "qr_manual", proofFileId: "file_qr", reference } });

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
      ...process.env, DATABASE_URL,
      CLERK_SECRET_KEY: "test-only-placeholder", CLERK_ISSUER: ISSUER,
      CLERK_AUTHORIZED_PARTIES: AUTHORIZED_PARTY, CLERK_JWT_KEY: JWT_KEY,
      HOST: "127.0.0.1", PORT: String(port), GRIDGO_BUILD_SHA: "sample-first-test", GRIDGO_BUILD_TIME: AT,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; if (process.env.SAMPLE_DEBUG) process.stderr.write(chunk); });
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

function client(api) {
  return async (subject, method, pathname, body) => {
    const response = await fetch(`${api}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token(subject)}`, ...(body == null ? {} : { "Content-Type": "application/json" }) },
      ...(body == null ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
}

async function fixture(database) {
  await resetDatabase(database, `TRUNCATE
    administrator_bootstrap, device_tokens, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, order_invoices,
    client_cart_lines, sample_batch_drafts, client_carts, client_saved_addresses, client_match_preferences,
    payout_milestones, order_payments, order_line_item_options, order_line_items, order_jobs, orders,
    supplier_catalog_prep_steps, supplier_catalog_item_photos, supplier_shop_media, supplier_catalog_item_file_formats,
    supplier_catalog_price_tiers, supplier_catalog_options, supplier_catalog_option_groups, supplier_catalog_items,
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
    // Flat 10% service fee keeps the arithmetic below readable.
    delete store.settings.serviceFeeSchedule;
    store.settings.serviceFeeRateBps = 1_000;
    store.settings.operatingHours = alwaysOpenOperatingHours();
    store.users.push(
      { id: "user_client", clerkUserId: "clerk_client", email: "client@gridgo.test", name: "Client", role: "client", accountType: "individual", createdAt: AT },
      { id: "user_other", clerkUserId: "clerk_other", email: "other@gridgo.test", name: "Other", role: "client", accountType: "individual", createdAt: AT },
      { id: "supplier_a", clerkUserId: "clerk_supplier_a", email: "a@gridgo.test", name: "A", role: "supplier", verificationStatus: "approved", createdAt: AT },
      { id: "user_ops", clerkUserId: "clerk_ops", email: "ops@gridgo.test", name: "Ops", role: "ops_admin", createdAt: AT },
      { id: "user_super", clerkUserId: "clerk_super", email: "super@gridgo.test", name: "Super", role: "super_admin", createdAt: AT },
    );
    store.userRoleMemberships.push(
      { userId: "user_client", role: "client", createdAt: AT },
      { userId: "user_other", role: "client", createdAt: AT },
      { userId: "supplier_a", role: "supplier", createdAt: AT },
      { userId: "user_ops", role: "ops_admin", createdAt: AT },
      { userId: "user_super", role: "super_admin", createdAt: AT },
    );
    const shop = { lat: 7.064, lng: 125.6085, label: "Shop A" };
    store.supplierProfiles.push({ userId: "supplier_a", shopName: "Shop A", contactName: "A", shop, pickupAvailable: true, version: 1, updatedAt: AT });
    store.approvalCases.push({ id: "case_supplier_a", userId: "supplier_a", kind: "supplier", status: "approved", version: 1, applicationRevision: 1, createdAt: AT, updatedAt: AT });
    store.supplierServices.push({ id: "service_supplier_a", supplierId: "supplier_a", categoryCode: "marketing_collateral", state: "live", pricingBasis: "per_unit", referenceRateMinor: 1_000, turnaroundHours: 12, standardTurnaroundHours: 12, version: 1, createdAt: AT, updatedAt: AT });
    store.supplierServiceFileFormats.push({ supplierServiceId: "service_supplier_a", formatCode: "pdf" });
    for (const [index, [id, subcategoryCode]] of [[ITEM, "flyers"], [`${ITEM}_brochures`, "brochures"]].entries()) {
      store.catalogItems.push({ id, supplierId: "supplier_a", supplierServiceId: "service_supplier_a", subcategoryCode, name: `Shop A ${subcategoryCode}`, description: "Full-color", basePriceMinor: 1_000, pricingUnit: "per_unit", turnaroundMode: "inherit", fileFormatMode: "inherit", active: true, sortOrder: index, version: 1, createdAt: AT, updatedAt: AT });
      store.files.push({ fileId: `photo_${id}`, ownerId: "supplier_a", purpose: "catalog_item_photo", originalFilename: "p.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", size: 10, state: "ready", objectKey: `supplier_a/${id}.jpg`, createdAt: AT });
      store.catalogItemPhotos.push({ catalogItemId: id, fileId: `photo_${id}`, sortOrder: 0, createdAt: AT });
    }
    // Bulk tier on the sampled listing: PHP 8.00 a piece from 200.
    store.catalogPriceTiers.push({ id: "tier_200", catalogItemId: ITEM, minQuantity: 200, unitPriceMinor: 800, createdAt: AT, updatedAt: AT });
    for (const [fileId, purpose, type] of [["file_art", "artwork", "application/pdf"], ["file_qr", "payment_proof", "image/jpeg"],
      ["file_sample_photo", "approval_sample_photo", "image/jpeg"], ["file_sample_photo_2", "approval_sample_photo", "image/jpeg"]]) {
      store.files.push({ fileId, ownerId: "user_client", purpose, ...(purpose === "artwork" ? { artworkCheck: { status: "passed", checkedAt: AT } } : {}),
        originalFilename: fileId, declaredContentType: type, detectedContentType: type, size: 10, state: "ready", objectKey: `client/${fileId}`, references: [], createdAt: AT });
    }
    store.files.push({ fileId: "file_other_photo", ownerId: "user_other", purpose: "approval_sample_photo", originalFilename: "o.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", size: 10, state: "ready", objectKey: "other/o.jpg", references: [], createdAt: AT });
    await saveStore(database, store);
  });
}

async function mutate(database, change) {
  await database.transaction(async () => {
    const store = await loadStore(database);
    await change(store);
    await saveStore(database, store);
  });
}

/** The sample reached the client `ago` milliseconds before now. */
async function deliverSample(database, orderId, ago) {
  const at = new Date(Date.now() - ago).toISOString();
  await mutate(database, (store) => {
    const order = store.orders.find(row => row.id === orderId);
    order.state = "delivered";
    order.timeline.push({ at, state: "delivered", by: "user_rider", note: "Delivered" });
    order.updatedAt = at;
  });
  return at;
}

async function offerSample(call, priceMinor = 5_000) {
  const item = (await call("clerk_supplier_a", "GET", `/me/catalog-items/${ITEM}`)).body.item;
  const result = await call("clerk_supplier_a", "PATCH", `/me/catalog-items/${ITEM}`, { expectedVersion: item.version, sampleAvailable: true, samplePriceMinor: priceMinor });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.item;
}

async function orderSample(call, { quantity = 100, replacesSampleBatchId, reference = "SAMPLE" } = {}) {
  const cart = (await call("clerk_client", "POST", "/me/carts", { fulfillmentMode: "delivery", defaultDropoff: DROPOFF })).body.cart;
  const added = await call("clerk_client", "POST", `/me/carts/${cart.id}/lines`, {
    catalogItemId: ITEM, optionIds: [], quantity, artworkFileId: "file_art", specialInstructions: "Matte, please", sample: true,
    ...(replacesSampleBatchId ? { replacesSampleBatchId } : {}),
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const checkout = await call("clerk_client", "POST", `/me/carts/${cart.id}/checkout`, PAYMENT(reference));
  assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
  return { cart, added: added.body.cart, order: checkout.body.order, invoice: checkout.body.invoice };
}

test("a sample is its own order and its batch is ordered at the held price after the listing price rises", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  t.after(() => database.close());
  await fixture(database);
  const { api, child } = await startApi();
  t.after(() => child.kill("SIGTERM"));
  const call = client(api);

  // The shop offers a sample; the listing stays approved and the change is audited.
  const offered = await offerSample(call);
  assert.equal(offered.sampleAvailable, true);
  assert.equal(offered.samplePriceMinor, 5_000);
  assert.equal(offered.reviewStatus, "approved");
  const listing = (await call("clerk_client", "GET", `/catalog/items/${ITEM}`)).body;
  const publicItem = listing.item || listing;
  assert.equal(publicItem.sampleAvailable, true);
  assert.equal(publicItem.clientSamplePriceMinor, 5_500);

  // Match cards carry the sample offer beside the ordinary order.
  const match = await call("clerk_client", "POST", "/me/matches", { subcategoryCode: "flyers", dropoff: DROPOFF, units: 100, ranking: ["cost", "quality", "speed", "distance"] });
  assert.equal(match.status, 200, JSON.stringify(match.body));
  const offeredCard = match.body.listings.find(row => row.id === ITEM);
  assert.equal(offeredCard.sampleAvailable, true);
  assert.equal(offeredCard.clientSamplePriceMinor, 5_500);

  const { cart, added, order: sampleOrder, invoice } = await orderSample(call);
  const sampleLine = added.lines[0];
  assert.equal(sampleLine.quantity, 1);
  assert.deepEqual(sampleLine.sample, { batchQuantity: 100, replacesSampleBatchId: null });
  assert.equal(sampleLine.lineSubtotalMinor, 5_000);
  // The sample is a single-line cart: nothing else rides along.
  assert.equal(invoice.itemSubtotalMinor, 5_000);
  assert.equal(invoice.lines[0].quantity, 1);
  assert.equal(invoice.serviceFeeMinor, 500);
  assert.ok(invoice.deliveryFeeMinor > 0);

  const extraCart = (await call("clerk_client", "POST", "/me/carts", { fulfillmentMode: "delivery", defaultDropoff: DROPOFF })).body.cart;
  await call("clerk_client", "POST", `/me/carts/${extraCart.id}/lines`, { catalogItemId: ITEM, optionIds: [], quantity: 10, artworkFileId: "file_art" });
  const mixed = await call("clerk_client", "POST", `/me/carts/${extraCart.id}/lines`, { catalogItemId: ITEM, optionIds: [], quantity: 10, artworkFileId: "file_art", sample: true });
  assert.equal(mixed.status, 409);
  assert.equal(mixed.body.error, "sample_cart_exclusive");

  const sampleRead = await call("clerk_client", "GET", `/orders/${sampleOrder.id}`);
  assert.equal(sampleRead.status, 200, JSON.stringify(sampleRead.body));
  assert.deepEqual(sampleRead.body.order.orderTags, ["sample"]);
  const draftId = sampleRead.body.order.sampleBatchDraftId;
  assert.match(draftId, /^sbd_/);

  let draft = (await call("clerk_client", "GET", `/me/sample-batches/${draftId}`)).body.sampleBatch;
  assert.equal(draft.status, "awaiting_sample");
  assert.equal(draft.sampleOrderId, sampleOrder.id);
  assert.equal(draft.batch.quantity, 100);
  assert.equal(draft.batch.artworkFileId, "file_art");
  assert.equal(draft.batch.specialInstructions, "Matte, please");
  assert.equal(draft.holdDays, 14);
  assert.equal(draft.heldUntil, null);
  assert.deepEqual(draft.heldPrice, { quantity: 100, clientItemMinor: 110_000 });
  assert.equal(draft.heldPricing, undefined, "held rules stay private to staff");
  assert.equal(draft.canOrderAtHeldPrice, false);

  // Decisions wait for the sample to arrive.
  const early = await call("clerk_client", "POST", `/me/sample-batches/${draftId}/approve`, { accepted: true, method: "tick", samplePhotoFileId: "file_sample_photo" });
  assert.equal(early.status, 409);
  assert.equal(early.body.error, "sample_not_delivered");
  const earlyCart = await call("clerk_client", "POST", `/me/sample-batches/${draftId}/cart`, {});
  assert.equal(earlyCart.body.error, "sample_batch_not_approved");

  // The shop's prices rise (approved) while the client waits: PHP 20 a piece and PHP 15 from 200.
  await mutate(database, (store) => {
    const item = store.catalogItems.find(row => row.id === ITEM);
    item.basePriceMinor = 2_000;
    item.version += 1;
    store.catalogPriceTiers.find(row => row.id === "tier_200").unitPriceMinor = 1_500;
  });
  const deliveredAt = await deliverSample(database, sampleOrder.id, DAY);

  const otherPhoto = await call("clerk_client", "POST", `/me/sample-batches/${draftId}/approve`, { accepted: true, method: "tick", samplePhotoFileId: "file_other_photo" });
  assert.equal(otherPhoto.status, 400);
  assert.equal(otherPhoto.body.error, "invalid_approval_file");
  const noTick = await call("clerk_client", "POST", `/me/sample-batches/${draftId}/approve`, { accepted: false, samplePhotoFileId: "file_sample_photo" });
  assert.equal(noTick.body.error, "invalid_sample_approval");
  const foreign = await call("clerk_other", "POST", `/me/sample-batches/${draftId}/approve`, { accepted: true, samplePhotoFileId: "file_other_photo" });
  assert.equal(foreign.status, 403);

  const approved = await call("clerk_client", "POST", `/me/sample-batches/${draftId}/approve`, { accepted: true, method: "tick", samplePhotoFileId: "file_sample_photo", note: "Colours match" });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  draft = approved.body.sampleBatch;
  assert.equal(draft.status, "approved");
  assert.equal(draft.sampleDeliveredAt, deliveredAt);
  assert.equal(draft.heldUntil, new Date(Date.parse(deliveredAt) + 14 * DAY).toISOString());
  assert.equal(draft.approval.method, "tick");
  assert.equal(draft.approval.samplePhotoFileId, "file_sample_photo");
  assert.equal(draft.canOrderAtHeldPrice, true);
  const twice = await call("clerk_client", "POST", `/me/sample-batches/${draftId}/approve`, { accepted: true, samplePhotoFileId: "file_sample_photo" });
  assert.equal(twice.body.error, "sample_batch_decided");

  // Held: the old price list, bulk tier included, applied to the new quantity.
  const preview = (await call("clerk_client", "GET", `/me/sample-batches/${draftId}?quantity=200`)).body.sampleBatch;
  assert.deepEqual(preview.heldPrice, { quantity: 200, clientItemMinor: 176_000 });
  assert.deepEqual(preview.currentPrice, { quantity: 200, clientItemMinor: 330_000 });

  const batchCart = await call("clerk_client", "POST", `/me/sample-batches/${draftId}/cart`, { quantity: 200 });
  assert.equal(batchCart.status, 201, JSON.stringify(batchCart.body));
  let line = batchCart.body.cart.lines[0];
  assert.equal(line.quantity, 200);
  assert.equal(line.lineSubtotalMinor, 160_000);
  assert.deepEqual(line.sampleBatch, { draftId, pricing: "held", sampleOrderId: sampleOrder.id, heldUntil: draft.heldUntil });
  assert.equal(line.artworkFileId, "file_art");
  assert.equal(line.specialInstructions, "Matte, please");
  assert.deepEqual(batchCart.body.cart.defaultDropoff, DROPOFF);
  const cartId = batchCart.body.cart.id;

  const locked = await call("clerk_client", "PATCH", `/me/carts/${cartId}/lines/${line.id}`, { optionIds: [] });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error, "sample_batch_specs_locked");
  // Below the bulk tier the held base rate applies; the targeted cart read agrees.
  line = (await call("clerk_client", "PATCH", `/me/carts/${cartId}/lines/${line.id}`, { quantity: 150 })).body.cart.lines[0];
  assert.equal((await call("clerk_client", "GET", `/me/carts/${cartId}`)).body.cart.lines[0].lineSubtotalMinor, 150_000);
  line = (await call("clerk_client", "PATCH", `/me/carts/${cartId}/lines/${line.id}`, { quantity: 250 })).body.cart.lines[0];
  const read = (await call("clerk_client", "GET", `/me/carts/${cartId}`)).body.cart;
  assert.equal(read.lines[0].lineSubtotalMinor, 200_000);
  assert.equal(read.clientQuote.clientItemSubtotalMinor, 220_000);

  const batchCheckout = await call("clerk_client", "POST", `/me/carts/${cartId}/checkout`, PAYMENT("BATCH"));
  assert.equal(batchCheckout.status, 201, JSON.stringify(batchCheckout.body));
  const batchOrderId = batchCheckout.body.order.id;
  assert.equal(batchCheckout.body.invoice.itemSubtotalMinor, 200_000);
  assert.equal(batchCheckout.body.invoice.lines[0].unitPriceMinor, 800);
  assert.equal(batchCheckout.body.invoice.serviceFeeMinor, 20_000);

  const batchRead = (await call("clerk_client", "GET", `/orders/${batchOrderId}`)).body.order;
  assert.deepEqual(batchRead.orderTags, ["batch_from_sample"]);
  assert.equal(batchRead.sampleOrderId, sampleOrder.id);
  assert.equal(batchRead.sampleBatchDraftId, draftId);
  assert.equal(batchRead.sampleBatchPricing.pricing, "held");
  assert.equal(batchRead.sampleDecision.decision, "approved");
  assert.equal(batchRead.sampleDecision.samplePhotoFileId, "file_sample_photo");
  assert.equal((await call("clerk_client", "GET", `/orders/${sampleOrder.id}`)).body.order.batchOrderId, batchOrderId);
  // Once Operations releases the work, the shop sees both tags, the link and
  // the approved standard; the rider never receives the client's decision.
  await mutate(database, (store) => {
    for (const order of store.orders) {
      order.fileCheck = { ...order.fileCheck, status: "passed" };
      order.state = order.id === batchOrderId ? "production" : order.state;
    }
  });
  const shopSample = (await call("clerk_supplier_a", "GET", `/orders/${sampleOrder.id}`)).body.order;
  assert.deepEqual(shopSample.orderTags, ["sample"]);
  assert.equal(shopSample.batchOrderId, batchOrderId);
  const shopBatch = (await call("clerk_supplier_a", "GET", `/orders/${batchOrderId}`)).body.order;
  assert.deepEqual(shopBatch.orderTags, ["batch_from_sample"]);
  assert.equal(shopBatch.sampleOrderId, sampleOrder.id);
  assert.equal(shopBatch.sampleDecision.decision, "approved");
  const opsBatch = (await call("clerk_ops", "GET", `/orders/${batchOrderId}`)).body.order;
  assert.deepEqual(opsBatch.orderTags, ["batch_from_sample"]);
  assert.equal(opsBatch.sampleDecision.note, "Colours match");

  draft = (await call("clerk_client", "GET", `/me/sample-batches/${draftId}`)).body.sampleBatch;
  assert.equal(draft.status, "ordered");
  assert.equal(draft.batchOrderId, batchOrderId);
  const again = await call("clerk_client", "POST", `/me/sample-batches/${draftId}/cart`, {});
  assert.equal(again.body.error, "sample_batch_ordered");

  // Persisted links, immutable held rules and the audit trail.
  const rows = (await database.query("SELECT * FROM sample_batch_drafts WHERE id = $1", [draftId])).rows;
  assert.equal(rows[0].status, "ordered");
  assert.equal(rows[0].batch_order_id, batchOrderId);
  assert.equal(Number(rows[0].held_pricing.basePriceMinor), 1_000);
  assert.deepEqual(rows[0].held_pricing.volumeTiers, [{ minQuantity: 200, unitPriceMinor: 800 }]);
  await assert.rejects(database.query("UPDATE sample_batch_drafts SET held_pricing = held_pricing || '{\"basePriceMinor\":1}' WHERE id = $1", [draftId]),
    /keep their held pricing/);
  const lineRow = (await database.query("SELECT quantity, effective_unit_price_minor, line_subtotal_minor FROM order_line_items WHERE order_id = $1", [batchOrderId])).rows[0];
  assert.deepEqual([lineRow.quantity, Number(lineRow.effective_unit_price_minor), Number(lineRow.line_subtotal_minor)], [250, 800, 200_000]);
  const actions = (await database.query("SELECT action FROM audit_log WHERE entity_id = ANY($1::text[]) ORDER BY position", [[draftId, ITEM]])).rows.map(row => row.action);
  for (const action of ["catalog_item.update", "sample_batch.create", "sample_batch.approve", "sample_batch.cart_created", "sample_batch.batch_ordered"]) {
    assert.ok(actions.includes(action), `${action} audited`);
  }
  const inbox = (await database.query("SELECT user_id, type FROM notifications WHERE type IN ('sample_approved','shop_sample_approved','sample_batch_ordered')")).rows;
  assert.ok(inbox.some(row => row.user_id === "supplier_a" && row.type === "shop_sample_approved"));
  for (const userId of ["user_ops", "user_super"]) {
    assert.ok(inbox.some(row => row.user_id === userId && row.type === "sample_approved"));
    assert.ok(inbox.some(row => row.user_id === userId && row.type === "sample_batch_ordered"));
  }

  // Operations reads the approval and the held rules; other parties cannot.
  const ops = await call("clerk_ops", "GET", `/ops/sample-batches?status=ordered`);
  assert.equal(ops.status, 200);
  assert.equal(ops.body.sampleBatches[0].id, draftId);
  assert.equal(ops.body.sampleBatches[0].heldPricing.basePriceMinor, 1_000);
  assert.equal(ops.body.sampleBatches[0].approval.note, "Colours match");
  assert.equal((await call("clerk_supplier_a", "GET", "/ops/sample-batches")).status, 403);
  assert.equal((await call("clerk_client", "GET", `/ops/sample-batches/${draftId}`)).status, 403);
  assert.equal((await call("clerk_other", "GET", `/me/sample-batches/${draftId}`)).status, 403);
  assert.deepEqual((await call("clerk_other", "GET", "/me/sample-batches")).body.sampleBatches, []);
  assert.equal(cart.id !== cartId, true);
});

test("an expired hold refuses the held price, before and at checkout, and the batch can still be ordered at today's price", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  t.after(() => database.close());
  await fixture(database);
  const { api, child } = await startApi();
  t.after(() => child.kill("SIGTERM"));
  const call = client(api);
  await offerSample(call);

  // Delivered fifteen days ago: the 14-day hold is over before the client decides.
  const { order: lateSample } = await orderSample(call, { quantity: 200 });
  const lateDraftId = (await call("clerk_client", "GET", `/orders/${lateSample.id}`)).body.order.sampleBatchDraftId;
  await mutate(database, (store) => { store.catalogItems.find(row => row.id === ITEM).basePriceMinor = 2_000; store.catalogItems.find(row => row.id === ITEM).version += 1; });
  await deliverSample(database, lateSample.id, 15 * DAY);
  const approved = (await call("clerk_client", "POST", `/me/sample-batches/${lateDraftId}/approve`, { accepted: true, samplePhotoFileId: "file_sample_photo" })).body.sampleBatch;
  assert.equal(approved.holdExpired, true);
  assert.equal(approved.canOrderAtHeldPrice, false);
  assert.equal(approved.heldPriceBlocker, "sample_hold_expired");
  assert.equal(approved.canOrderAtCurrentPrice, true);
  const refused = await call("clerk_client", "POST", `/me/sample-batches/${lateDraftId}/cart`, { pricing: "held" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "sample_hold_expired");
  assert.equal(refused.body.heldUntil, approved.heldUntil);
  const current = await call("clerk_client", "POST", `/me/sample-batches/${lateDraftId}/cart`, { pricing: "current" });
  assert.equal(current.status, 201, JSON.stringify(current.body));
  assert.equal(current.body.cart.lines[0].sampleBatch.pricing, "current");
  assert.equal(current.body.cart.lines[0].lineSubtotalMinor, 200 * 800, "the current price list still has its own bulk tier");
  const currentOrder = await call("clerk_client", "POST", `/me/carts/${current.body.cart.id}/checkout`, PAYMENT("CURRENT"));
  assert.equal(currentOrder.status, 201, JSON.stringify(currentOrder.body));
  const currentRead = (await call("clerk_client", "GET", `/orders/${currentOrder.body.order.id}`)).body.order;
  assert.deepEqual(currentRead.orderTags, ["batch_from_sample"]);
  assert.equal(currentRead.sampleBatchPricing.pricing, "current");

  // A hold that ends between building the cart and paying is refused at checkout.
  const { order: edgeSample } = await orderSample(call, { quantity: 100, reference: "EDGE" });
  const edgeDraftId = (await call("clerk_client", "GET", `/orders/${edgeSample.id}`)).body.order.sampleBatchDraftId;
  await deliverSample(database, edgeSample.id, 14 * DAY - 6_000);
  const edge = (await call("clerk_client", "POST", `/me/sample-batches/${edgeDraftId}/approve`, { accepted: true, samplePhotoFileId: "file_sample_photo_2" })).body.sampleBatch;
  assert.equal(edge.canOrderAtHeldPrice, true);
  const edgeCart = await call("clerk_client", "POST", `/me/sample-batches/${edgeDraftId}/cart`, {});
  assert.equal(edgeCart.status, 201, JSON.stringify(edgeCart.body));
  // Sampled after the rise, so this sample holds the PHP 20 list it was ordered under.
  assert.equal(edgeCart.body.cart.lines[0].lineSubtotalMinor, 200_000);
  while (Date.now() <= Date.parse(edge.heldUntil) + 50) await new Promise(resolve => setTimeout(resolve, 100));
  const late = await call("clerk_client", "POST", `/me/carts/${edgeCart.body.cart.id}/checkout`, PAYMENT("EDGE-BATCH"));
  assert.equal(late.status, 409);
  assert.equal(late.body.error, "sample_hold_expired");
  assert.equal((await database.query("SELECT status FROM sample_batch_drafts WHERE id = $1", [edgeDraftId])).rows[0].status, "approved");
});

test("a rejected sample can be sampled again with changed specs or its draft cancelled", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  t.after(() => database.close());
  await fixture(database);
  const { api, child } = await startApi();
  t.after(() => child.kill("SIGTERM"));
  const call = client(api);
  await offerSample(call);

  const { order: first } = await orderSample(call, { quantity: 100 });
  const firstDraft = (await call("clerk_client", "GET", `/orders/${first.id}`)).body.order.sampleBatchDraftId;
  await deliverSample(database, first.id, DAY);
  assert.equal((await call("clerk_client", "POST", `/me/sample-batches/${firstDraft}/reject`, { next: "resample" })).body.error, "reason_required");
  assert.equal((await call("clerk_client", "POST", `/me/sample-batches/${firstDraft}/reject`, { reason: "Too dark", next: "later" })).body.error, "invalid_sample_rejection");
  const rejected = await call("clerk_client", "POST", `/me/sample-batches/${firstDraft}/reject`, { reason: "Too dark", next: "resample" });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.sampleBatch.status, "rejected");
  assert.equal(rejected.body.sampleBatch.rejection.reason, "Too dark");
  assert.equal((await call("clerk_client", "GET", `/orders/${first.id}`)).body.order.sampleDecision.decision, "rejected");
  assert.equal((await call("clerk_client", "POST", `/me/sample-batches/${firstDraft}/cart`, { pricing: "current" })).body.error, "sample_batch_not_approved");

  // Another sample with changed specs replaces it; the held rules are taken afresh.
  const { order: second } = await orderSample(call, { quantity: 300, replacesSampleBatchId: firstDraft, reference: "RESAMPLE" });
  const secondDraft = (await call("clerk_client", "GET", `/orders/${second.id}`)).body.order.sampleBatchDraftId;
  const replacement = (await call("clerk_client", "GET", `/me/sample-batches/${secondDraft}`)).body.sampleBatch;
  assert.equal(replacement.previousDraftId, firstDraft);
  assert.equal(replacement.batch.quantity, 300);
  assert.equal((await call("clerk_client", "GET", `/me/sample-batches/${firstDraft}`)).body.sampleBatch.replacedByDraftId, secondDraft);
  const cart = (await call("clerk_client", "POST", "/me/carts", { fulfillmentMode: "delivery", defaultDropoff: DROPOFF })).body.cart;
  const duplicate = await call("clerk_client", "POST", `/me/carts/${cart.id}/lines`, { catalogItemId: ITEM, optionIds: [], quantity: 100, artworkFileId: "file_art", sample: true, replacesSampleBatchId: firstDraft });
  assert.equal(duplicate.body.error, "sample_batch_already_resampled");

  // Cancel straight from the rejection, or after approving.
  await deliverSample(database, second.id, DAY);
  const cancelled = await call("clerk_client", "POST", `/me/sample-batches/${secondDraft}/reject`, { reason: "Changed our minds", next: "cancel" });
  assert.equal(cancelled.body.sampleBatch.status, "cancelled");
  const { order: third } = await orderSample(call, { reference: "THIRD" });
  const thirdDraft = (await call("clerk_client", "GET", `/orders/${third.id}`)).body.order.sampleBatchDraftId;
  await deliverSample(database, third.id, DAY);
  await call("clerk_client", "POST", `/me/sample-batches/${thirdDraft}/approve`, { accepted: true, samplePhotoFileId: "file_sample_photo" });
  const heldCart = (await call("clerk_client", "POST", `/me/sample-batches/${thirdDraft}/cart`, {})).body.cart;
  const dropped = await call("clerk_client", "POST", `/me/sample-batches/${thirdDraft}/cancel`, { reason: "Budget" });
  assert.equal(dropped.body.sampleBatch.status, "cancelled");
  assert.equal((await call("clerk_client", "POST", `/me/carts/${heldCart.id}/checkout`, PAYMENT("CANCELLED"))).body.error, "sample_batch_not_approved");
  assert.equal((await call("clerk_client", "POST", `/me/sample-batches/${thirdDraft}/cancel`, {})).body.error, "sample_batch_decided");
  const inbox = (await database.query("SELECT user_id FROM notifications WHERE type IN ('sample_rejected', 'shop_sample_rejected')")).rows.map(row => row.user_id);
  assert.ok(inbox.includes("supplier_a") && inbox.includes("user_ops") && inbox.includes("user_super"));
});

test("listing sample fields and the hold setting are validated, role-gated and snapshotted per sample", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  t.after(() => database.close());
  await fixture(database);
  const { api, child } = await startApi();
  t.after(() => child.kill("SIGTERM"));
  const call = client(api);

  const brochure = (await call("clerk_supplier_a", "GET", `/me/catalog-items/${ITEM}_brochures`)).body.item;
  assert.equal(brochure.sampleAvailable, false);
  assert.equal(brochure.samplePriceMinor, null);
  const noPrice = await call("clerk_supplier_a", "PATCH", `/me/catalog-items/${ITEM}_brochures`, { expectedVersion: brochure.version, sampleAvailable: true });
  assert.equal(noPrice.status, 400);
  assert.equal(noPrice.body.error, "sample_price_required");
  const badPrice = await call("clerk_supplier_a", "PATCH", `/me/catalog-items/${ITEM}_brochures`, { expectedVersion: brochure.version, sampleAvailable: true, samplePriceMinor: -1 });
  assert.equal(badPrice.body.error, "invalid_catalog_item");
  const cart = (await call("clerk_client", "POST", "/me/carts", { fulfillmentMode: "delivery", defaultDropoff: DROPOFF })).body.cart;
  const none = await call("clerk_client", "POST", `/me/carts/${cart.id}/lines`, { catalogItemId: `${ITEM}_brochures`, optionIds: [], quantity: 10, artworkFileId: "file_art", sample: true });
  assert.equal(none.status, 409);
  assert.equal(none.body.error, "sample_unavailable");

  const settings = (await call("clerk_super", "GET", "/settings")).body;
  assert.equal(settings.settings.sampleBatchHoldDays, 14);
  const opsWrite = await call("clerk_ops", "PATCH", "/settings", { expectedVersion: settings.version, reason: "Pilot", sampleBatchHoldDays: 7 });
  assert.equal(opsWrite.status, 403);
  const invalid = await call("clerk_super", "PATCH", "/settings", { expectedVersion: settings.version, reason: "Pilot", sampleBatchHoldDays: 0 });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, "invalid_sample_batch_hold_days");
  const saved = await call("clerk_super", "PATCH", "/settings", { expectedVersion: settings.version, reason: "Pilot", sampleBatchHoldDays: 7 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.settings.sampleBatchHoldDays, 7);

  await offerSample(call, 7_500);
  const { order } = await orderSample(call, { quantity: 50 });
  const draftId = (await call("clerk_client", "GET", `/orders/${order.id}`)).body.order.sampleBatchDraftId;
  // A later setting change never shortens a hold already promised.
  const later = (await call("clerk_super", "GET", "/settings")).body;
  await call("clerk_super", "PATCH", "/settings", { expectedVersion: later.version, reason: "Back to default", sampleBatchHoldDays: 14 });
  const deliveredAt = await deliverSample(database, order.id, DAY);
  const draft = (await call("clerk_client", "GET", `/me/sample-batches/${draftId}`)).body.sampleBatch;
  assert.equal(draft.holdDays, 7);
  assert.equal(draft.heldUntil, new Date(Date.parse(deliveredAt) + 7 * DAY).toISOString());
  // Turning the offer off stops new samples but leaves the ordered sample and its draft alone.
  const item = (await call("clerk_supplier_a", "GET", `/me/catalog-items/${ITEM}`)).body.item;
  const off = await call("clerk_supplier_a", "PATCH", `/me/catalog-items/${ITEM}`, { expectedVersion: item.version, sampleAvailable: false });
  assert.equal(off.body.item.sampleAvailable, false);
  assert.equal(off.body.item.samplePriceMinor, 7_500);
  assert.equal((await call("clerk_client", "GET", `/me/sample-batches/${draftId}`)).body.sampleBatch.status, "awaiting_sample");
});

test("the shop's paged listing list carries the stored sample offer and pricing shape, like the single read", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  t.after(() => database.close());
  await fixture(database);
  // A measured listing with minimums: the paged row must not fall back to defaults.
  await mutate(database, (store) => {
    const item = store.catalogItems.find(row => row.id === `${ITEM}_brochures`);
    Object.assign(item, { pricingUnit: "per_area", measureUnit: "ft", minimumWidthMilli: 2_000, minimumHeightMilli: 3_000, minimumOrderQuantity: 5 });
  });
  const { api, child } = await startApi();
  t.after(() => child.kill("SIGTERM"));
  const call = client(api);
  await offerSample(call, 6_500);

  for (const query of ["", "?q=flyers", "?sort=name&limit=1"]) {
    const listed = await call("clerk_supplier_a", "GET", `/me/catalog-items${query}`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const flyers = listed.body.items.find(row => row.id === ITEM);
    if (query !== "?sort=name&limit=1") {
      assert.equal(flyers.sampleAvailable, true, query);
      assert.equal(flyers.samplePriceMinor, 6_500, query);
    }
    for (const row of listed.body.items) {
      const single = (await call("clerk_supplier_a", "GET", `/me/catalog-items/${row.id}`)).body.item;
      // Photo URLs are signed per response; everything else must match.
      const unsigned = (item) => ({ ...item, photos: item.photos.map(({ downloadUrl, downloadUrlExpiresAt, ...photo }) => photo) });
      assert.deepEqual(unsigned(row), unsigned(single), `${query} ${row.id}`);
    }
  }
  const brochures = (await call("clerk_supplier_a", "GET", "/me/catalog-items?subcategoryCode=brochures")).body.items[0];
  assert.equal(brochures.sampleAvailable, false);
  assert.equal(brochures.samplePriceMinor, null);
  assert.equal(brochures.measureUnit, "ft");
  assert.equal(brochures.minimumWidthMilli, 2_000);
  assert.equal(brochures.minimumHeightMilli, 3_000);
  assert.equal(brochures.minimumOrderQuantity, 5);
});
