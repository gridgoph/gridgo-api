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
    administrator_bootstrap, device_tokens, proofs, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, job_qa_checklist, order_invoices,
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
    );
    store.userRoleMemberships.push(
      { userId: "user_client", role: "client", createdAt: AT },
      { userId: "supplier_a", role: "supplier", createdAt: AT },
      { userId: "supplier_b", role: "supplier", createdAt: AT },
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
    }
    store.files.push(
      { fileId: "file_art", ownerId: "user_client", purpose: "artwork", originalFilename: "art.pdf", declaredContentType: "application/pdf", detectedContentType: "application/pdf", size: 10, state: "ready", objectKey: "client/art.pdf", references: [], createdAt: AT },
      { fileId: "file_mock", ownerId: "user_client", purpose: "mockup", originalFilename: "mock.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", size: 10, state: "ready", objectKey: "client/mock.jpg", references: [], createdAt: AT },
      { fileId: "file_qr", ownerId: "user_client", purpose: "payment_proof", originalFilename: "qr.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", size: 10, state: "ready", objectKey: "client/qr.jpg", references: [], createdAt: AT },
    );
    await saveStore(database, store);
  });
}

test("client order-match routes persist a two-job QR checkout and invoice", { skip: !DATABASE_URL }, async (t) => {
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
    body: { catalogItemId: "item_supplier_b", optionIds: [], quantity: 1 },
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));

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
  assert.equal(checkout.body.order.state, "needs_qa");
  assert.equal(checkout.body.order.totalMinor, 38_000);
  assert.equal(checkout.body.order.jobs.length, 2);

  const invoice = await requestEventually(
    instance.api,
    `/orders/${checkout.body.order.id}/invoice`,
    { subject: "clerk_client" },
    (response) => response.status === 200,
  );
  assert.equal(invoice.status, 200, JSON.stringify(invoice.body));
  assert.equal(invoice.body.invoice.deliveryLines.length, 2);
  const persisted = await loadStore(database);
  assert.equal(persisted.orders.find((row) => row.id === checkout.body.order.id).state, "needs_qa");
  assert.equal(persisted.orderJobs.filter((row) => row.orderId === checkout.body.order.id).length, 2);
  assert.equal(persisted.notifications.length, 0);
});
