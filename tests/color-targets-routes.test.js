import test from "node:test";
import assert from "node:assert/strict";

import { inspectArtwork } from "../src/artwork-inspection.js";
import { readArtworkColors } from "../src/artwork-colors.js";
import { defaultOperationalSettings, publicOrderFor } from "../src/operational-model.js";
import { routeOrderMatch, prepareArtworkCheckout } from "../src/order-match-routes.js";
import { defaultTaxonomy } from "../src/taxonomy.js";

const AT = "2026-10-16T01:00:00.000Z";

/** A flyer whose page sets a spot colour and a CMYK fill. */
const ARTWORK = Buffer.from([
  "%PDF-1.7",
  "1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj",
  "2 0 obj<</Type /Pages /Kids [3 0 R] /Count 1>>endobj",
  "3 0 obj<</Type /Page /Parent 2 0 R /MediaBox [0 0 595.276 841.89] /Resources << /ColorSpace << /CS0 5 0 R >> >> /Contents 4 0 R>>endobj",
  "4 0 obj<</Length 48>>stream\n/CS0 cs 1 scn 0 0 9 9 re f 0 1 0.65 0.34 k 9 9 9 9 re f\nendstream\nendobj",
  "5 0 obj[/Separation /PANTONE#20201#20C /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 0.65 0.34] /N 1 >>]endobj",
  "trailer<</Root 1 0 R>>",
  "%%EOF",
].join("\n"), "latin1");

async function fixture() {
  const client = { id: "user_client", role: "client", email: "client@gridgo.test" };
  const detected = { ...inspectArtwork(ARTWORK, "application/pdf"), colors: await readArtworkColors(ARTWORK, "application/pdf") };
  return {
    client,
    store: {
      settings: { ...defaultOperationalSettings(), hubPickupEnabled: true },
      taxonomy: defaultTaxonomy(),
      users: [client, { id: "supplier_a", role: "supplier", email: "a@gridgo.test" }],
      userRoleMemberships: [{ userId: client.id, role: "client" }, { userId: "supplier_a", role: "supplier" }],
      clientPreferences: [], clientAddresses: [], carts: [], cartLines: [],
      supplierProfiles: [{ userId: "supplier_a", shopName: "Shop A", contactName: "A", shop: { lat: 7.064, lng: 125.6085, label: "Shop A" }, pickupAvailable: true }],
      approvalCases: [{ id: "case_a", userId: "supplier_a", kind: "supplier", status: "approved" }],
      supplierServices: [{
        id: "service_a", supplierId: "supplier_a", categoryCode: "marketing_collateral", state: "live",
        pricingBasis: "per_unit", referenceRateMinor: 1_000, turnaroundHours: 12, standardTurnaroundHours: 12, version: 1,
      }],
      supplierServiceFileFormats: [{ supplierServiceId: "service_a", formatCode: "pdf" }],
      acceptedFileFormats: [{ code: "pdf", displayName: "PDF", inputKind: "file", active: true }],
      catalogItems: [{
        id: "flyers", supplierId: "supplier_a", supplierServiceId: "service_a", subcategoryCode: "flyers",
        name: "Flyers", description: "Flyers", basePriceMinor: 1_000, pricingUnit: "per_unit",
        turnaroundMode: "inherit", fileFormatMode: "inherit", active: true, sortOrder: 0, version: 1,
      }],
      catalogItemFileFormats: [], catalogPrepSteps: [],
      catalogItemPhotos: [{ catalogItemId: "flyers", fileId: "photo_flyers", sortOrder: 0 }],
      catalogOptionGroups: [], catalogOptions: [],
      files: [
        { fileId: "flyer_pdf", ownerId: client.id, purpose: "artwork", detectedContentType: "application/pdf", detected, artworkCheck: { status: "passed", checkedAt: AT }, state: "ready", objectKey: "c/flyer.pdf", references: [] },
        { fileId: "older_pdf", ownerId: client.id, purpose: "artwork", detectedContentType: "application/pdf", detected: inspectArtwork(ARTWORK, "application/pdf"), artworkCheck: { status: "passed", checkedAt: AT }, state: "ready", objectKey: "c/older.pdf", references: [] },
        { fileId: "photo_flyers", ownerId: "supplier_a", purpose: "catalog_item_photo", state: "ready", objectKey: "s/flyers.jpg" },
        { fileId: "proof", ownerId: client.id, purpose: "payment_proof", state: "ready", objectKey: "c/qr.jpg", references: [] },
      ],
      orders: [], orderJobs: [], orderLineItems: [], orderLineItemOptions: [], jobQaChecklist: [], orderInvoices: [],
      notifications: [], auditLog: [],
    },
  };
}

function caller(store, user) {
  let sequence = 0;
  return async (method, pathname, body) => {
    const req = { method };
    await prepareArtworkCheckout({ req, pathname, store, user, checker: async () => ({ ok: true }) });
    return routeOrderMatch({ req, url: new URL(`http://gridgo.test${pathname}`), store, user,
      readBody: async () => body || {}, id: (prefix) => `${prefix}_${++sequence}`, now: () => AT });
  };
}

const TARGETS = [
  { label: "School maroon", pantone: "pms 201c", approximateHex: "#9d2235" },
  { label: "Brand red", cmyk: "C0 M100 Y65 K34" },
  { label: "Logo blue", hex: "1a5fb4" },
];

test("cart, checkout and every production read carry the exact colours and the file's own colours", async () => {
  const { store, client } = await fixture();
  const call = caller(store, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;

  await assert.rejects(call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "flyers", optionIds: [], quantity: 1, artworkFileId: "flyer_pdf", colorTargets: [{ label: "Red", cmyk: "0 100 65" }],
  }), (error) => error.code === "invalid_color_targets" && error.details.field === "colorTargets[0].cmyk");
  assert.equal(store.cartLines.length, 0);

  const added = await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "flyers", optionIds: [], quantity: 1, artworkFileId: "flyer_pdf", colorTargets: TARGETS,
  });
  const line = added.body.cart.lines[0];
  assert.deepEqual(line.colorTargets.map(({ label, format, value, swatchHex, swatchApproximate }) => ({ label, format, value, swatchHex, swatchApproximate })), [
    { label: "School maroon", format: "pantone", value: "PANTONE 201 C", swatchHex: "#9D2235", swatchApproximate: true },
    { label: "Brand red", format: "cmyk", value: "C0 M100 Y65 K34", swatchHex: "#A8003B", swatchApproximate: true },
    { label: "Logo blue", format: "hex", value: "#1A5FB4", swatchHex: "#1A5FB4", swatchApproximate: false },
  ]);
  // The file's own colours, beside the targets: the spot it names and the CMYK it sets.
  assert.equal(line.artworkColors.length, 1);
  assert.equal(line.artworkColors[0].fileId, "flyer_pdf");
  assert.equal(line.artworkColors[0].colors.status, "read");
  assert.deepEqual(line.artworkColors[0].colors.colors.map(({ kind, name, cmyk }) => ({ kind, name, cmyk })), [
    { kind: "spot", name: "PANTONE 201 C", cmyk: { c: 0, m: 100, y: 65, k: 34 } },
    { kind: "process", name: null, cmyk: { c: 0, m: 100, y: 65, k: 34 } },
  ]);
  assert.deepEqual((await call("GET", `/me/carts/${cartId}`)).body.cart.lines[0].colorTargets, line.colorTargets);

  // PATCH replaces the list; leaving the field out keeps it.
  const kept = await call("PATCH", `/me/carts/${cartId}/lines/${line.id}`, { quantity: 2 });
  assert.equal(kept.body.cart.lines[0].colorTargets.length, 3);
  const cleared = await call("PATCH", `/me/carts/${cartId}/lines/${line.id}`, { colorTargets: [] });
  assert.deepEqual(cleared.body.cart.lines[0].colorTargets, []);
  await assert.rejects(call("PATCH", `/me/carts/${cartId}/lines/${line.id}`, { colorTargets: [{ label: "x", hex: "#12" }] }), { code: "invalid_color_targets" });
  assert.deepEqual(store.cartLines[0].colorTargets, null);
  await call("PATCH", `/me/carts/${cartId}/lines/${line.id}`, { colorTargets: TARGETS.slice(0, 2) });

  const placed = await call("POST", `/me/carts/${cartId}/checkout`, { payment: { method: "qr_manual", proofFileId: "proof", reference: "COLOURS" } });
  assert.equal(placed.status, 201);
  const snapshot = store.orderLineItems[0].colorTargets;
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.targets.map((target) => target.value), ["PANTONE 201 C", "C0 M100 Y65 K34"]);

  const order = store.orders[0];
  order.fileCheck.status = "passed";
  for (const user of [client, { id: "supplier_a", role: "supplier" }, { id: "ops", role: "ops_admin" }, { id: "admin", role: "super_admin" }]) {
    const item = publicOrderFor(order, user, store).productionItems[0];
    assert.deepEqual(item.colorTargets, snapshot.targets, user.role);
    assert.equal(item.artworkColors[0].colors.colors[0].name, "PANTONE 201 C", user.role);
  }
  // Riders carry the parcel, not the colour brief.
  store.orderJobs[0].riderId = "rider";
  const rider = publicOrderFor({ ...order, riderId: "rider" }, { id: "rider", role: "rider" }, store).productionItems[0];
  assert.equal(rider.id, store.orderLineItems[0].id);
  assert.deepEqual(rider.colorTargets, []);
  assert.deepEqual(rider.artworkColors, []);
  // A later edit to the cart cannot reach the agreed order.
  store.cartLines[0].colorTargets = [];
  assert.equal(publicOrderFor(order, client, store).productionItems[0].colorTargets.length, 2);
});

test("lines without colours, and released builds that never send them, are unchanged", async () => {
  const { store, client } = await fixture();
  const call = caller(store, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  const added = await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "flyers", optionIds: [], quantity: 1, artworkFileId: "older_pdf" });
  const line = added.body.cart.lines[0];
  assert.deepEqual(line.colorTargets, []);
  // Uploaded before colours were read: unknown, never re-guessed.
  assert.deepEqual(line.artworkColors, [{ fileId: "older_pdf", colors: { version: 1, status: "unknown", reasons: ["not_read_at_upload"], colors: [] } }]);
  assert.equal(Object.hasOwn(store.cartLines[0], "colorTargets"), false);
  const placed = await call("POST", `/me/carts/${cartId}/checkout`, { payment: { method: "qr_manual", proofFileId: "proof", reference: "PLAIN" } });
  assert.equal(placed.status, 201);
  assert.equal(Object.hasOwn(store.orderLineItems[0], "colorTargets"), false);
  assert.deepEqual(publicOrderFor(store.orders[0], client, store).productionItems[0].colorTargets, []);
});
