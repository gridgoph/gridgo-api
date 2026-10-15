import test from "node:test";
import assert from "node:assert/strict";

import {
  acceptArtworkWarnings, artworkGuidanceSnapshot, defaultArtworkGuidance, effectiveDpi, evaluateLineArtwork,
  guidanceFor, orderedSizeMilli, physicalSizeMilli, validateArtworkGuidance,
} from "../src/artwork-guidance.js";
import { inspectArtwork } from "../src/artwork-inspection.js";
import { defaultOperationalSettings, publicOrderFor } from "../src/operational-model.js";
import { routeOrderMatch } from "../src/order-match-routes.js";
import { defaultTaxonomy } from "../src/taxonomy.js";
import { routeTaxonomyDelete } from "../src/taxonomy-delete.js";

const AT = "2026-10-16T01:00:00.000Z";
const MM = 1000;
const fail = (status, code, message, details = {}) => { throw Object.assign(new Error(message), { status, code, details }); };

/** A ready, structurally passed raster upload with square pixels. */
function rasterFile(fileId, { pixels, colorMode = "cmyk" }) {
  return { fileId, ownerId: "client", purpose: "artwork", state: "ready", objectKey: `client/${fileId}`,
    detectedContentType: "image/png", artworkCheck: { status: "passed", checkedAt: AT }, references: [],
    detected: { kind: "raster", pageCount: 1, pixelWidth: pixels, pixelHeight: pixels, dpi: 72, colorMode } };
}

const SQUARE_INCHES = 10;

test("every starting product type gets the recommended minimum the issue names", () => {
  const settings = defaultOperationalSettings();
  const expected = {
    document_printing: 300, flyers: 300, brochures: 300, business_cards: 300, booklets: 300,
    posters_standees: 200, custom_apparel: 150,
    tarpaulins_outdoor_banners: 100, business_store_signages: 100, blueprint_cad_plotting: 100,
  };
  for (const [code, minimumDpi] of Object.entries(expected)) {
    assert.equal(guidanceFor(settings, code).minimumDpi, minimumDpi, code);
  }
  assert.equal(guidanceFor(settings, "custom_apparel").acceptsRgb, true);
  assert.equal(guidanceFor(settings, "flyers").expectedColorMode, "cmyk");
  assert.equal(guidanceFor(settings, "three_d_printing_scale_models").minimumDpi, null);
  assert.deepEqual(guidanceFor(settings, "a_product_type_added_later"),
    { subcategoryCode: "a_product_type_added_later", minimumDpi: 300, acceptsRgb: false, expectedColorMode: "cmyk", source: "default" });
  // Every shipped print job is named explicitly, so the dashboard shows each one.
  const shipped = defaultTaxonomy().subcategories.map((row) => row.code).sort();
  assert.deepEqual(Object.keys(defaultArtworkGuidance().subcategories).sort(), shipped);
});

for (const [code, entry] of Object.entries(defaultArtworkGuidance().subcategories)) {
  test(`${code}: a file at the target is clean and one pixel-step below it warns`, () => {
    const settings = defaultOperationalSettings();
    const item = { id: "item", subcategoryCode: code, measureUnit: "in" };
    const line = { measurement: { width: SQUARE_INCHES * MM, height: SQUARE_INCHES * MM } };
    const atTarget = rasterFile("at", { pixels: (entry.minimumDpi ?? 300) * SQUARE_INCHES });
    const below = rasterFile("below", { pixels: ((entry.minimumDpi ?? 300) - 1) * SQUARE_INCHES });
    const store = { settings, files: [atTarget, below], catalogOptions: [] };
    const result = evaluateLineArtwork(store, item, line, ["at", "below"]);
    assert.equal(result.minimumDpi, entry.minimumDpi);
    assert.deepEqual(result.files[0].warnings, []);
    if (entry.minimumDpi == null) {
      assert.deepEqual(result.files[1].warnings, [], "no resolution target, no warning");
    } else {
      assert.deepEqual(result.files[1].warnings, [{ code: "low_resolution", effectiveDpi: entry.minimumDpi - 1, minimumDpi: entry.minimumDpi, acceptedAt: null }]);
    }
  });
}

test("colour mode warns only where the product type expects CMYK", () => {
  const settings = defaultOperationalSettings();
  const store = { settings, catalogOptions: [], files: ["rgb", "cmyk", "grayscale", "mixed", null].map((mode, index) =>
    rasterFile(`f${index}`, { pixels: 3000, colorMode: mode })) };
  const line = { measurement: { width: SQUARE_INCHES * MM, height: SQUARE_INCHES * MM } };
  const codes = (subcategoryCode) => evaluateLineArtwork(store, { subcategoryCode, measureUnit: "in" }, line, store.files.map((f) => f.fileId))
    .files.map((file) => file.warnings.map((warning) => warning.code).join());
  assert.deepEqual(codes("tarpaulins_outdoor_banners"), ["color_mode", "", "", "color_mode", ""]);
  assert.deepEqual(codes("custom_apparel"), ["", "", "", "", ""], "apparel accepts RGB");
  assert.deepEqual(codes("three_d_printing_scale_models"), ["", "", "", "", ""]);
});

test("resolution is judged at the ordered size, never the density the file declares", () => {
  // 2480 x 3508 px declaring 72 DPI is a sharp A4, not a blurry 875 mm poster.
  const file = { detected: { pixelWidth: 2480, pixelHeight: 3508, dpi: 72 } };
  assert.equal(effectiveDpi(file, physicalSizeMilli("A4")), 300);
  // A landscape file on a portrait size is judged long side to long side.
  assert.equal(effectiveDpi({ detected: { pixelWidth: 3508, pixelHeight: 2480 } }, physicalSizeMilli("A4")), 300);
  assert.equal(effectiveDpi({ detected: { pixelWidth: 1200, pixelHeight: 2400 } }, physicalSizeMilli("3x6 ft")), 33);
  assert.equal(effectiveDpi({ detected: { pixelWidth: null, pixelHeight: null } }, physicalSizeMilli("A4")), null, "a PDF has no pixels");
  assert.equal(effectiveDpi(file, null), null, "no ordered size, no figure");
});

test("the ordered size comes from the measurement, a size option, or the stated spec", () => {
  const store = { catalogOptions: [
    { id: "opt_a5", label: "A5" },
    { id: "opt_bound", label: "Large", specBinding: { fieldCode: "size", value: "24x36 in" } },
    { id: "opt_card", label: "Standard" },
    { id: "opt_paper", label: "Matte" },
  ] };
  assert.deepEqual(orderedSizeMilli(store, { measureUnit: "ft" }, { measurement: { width: 3000, height: 6000 } }),
    { widthMilli: 914400, heightMilli: 1828800 });
  assert.deepEqual(orderedSizeMilli(store, { measureUnit: "mm" }, { measurement: { width: 148000, height: 210000 } }),
    { widthMilli: 148000, heightMilli: 210000 });
  assert.deepEqual(orderedSizeMilli(store, {}, { optionIds: ["opt_paper", "opt_a5"] }), { widthMilli: 148000, heightMilli: 210000 });
  assert.deepEqual(orderedSizeMilli(store, {}, { optionIds: ["opt_bound"] }), { widthMilli: 609600, heightMilli: 914400 });
  assert.deepEqual(orderedSizeMilli(store, { subcategoryCode: "business_cards" }, { optionIds: ["opt_card"] }), { widthMilli: 88900, heightMilli: 50800 });
  assert.deepEqual(orderedSizeMilli(store, {}, { structuredSpec: { size: "90 x 50 mm" } }), { widthMilli: 90000, heightMilli: 50000 });
  assert.equal(orderedSizeMilli(store, {}, { optionIds: ["opt_paper"], structuredSpec: { size: "custom" } }), null);
  // Per-page and per-length lines carry no width and height to read.
  assert.equal(orderedSizeMilli(store, { measureUnit: "m" }, { measurement: { length: 2000 } }), null);
});

test("PNG, JPEG, PDF, PSD and WebP report the colour mode the bytes declare", () => {
  const png = (colorType) => {
    const bytes = Buffer.alloc(45);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "latin1");
    bytes.writeUInt32BE(100, 16); bytes.writeUInt32BE(50, 20); bytes[24] = 8; bytes[25] = colorType;
    bytes.write("IDAT", 37, "latin1");
    return bytes;
  };
  assert.equal(inspectArtwork(png(2), "image/png").colorMode, "rgb");
  assert.equal(inspectArtwork(png(6), "image/png").colorMode, "rgb");
  assert.equal(inspectArtwork(png(3), "image/png").colorMode, "rgb", "a palette is RGB entries");
  assert.equal(inspectArtwork(png(0), "image/png").colorMode, "grayscale");

  const jpeg = (components) => {
    const sof = Buffer.alloc(11);
    sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(8 + 3 * components, 2); sof[4] = 8;
    sof.writeUInt16BE(40, 5); sof.writeUInt16BE(60, 7); sof[9] = components;
    return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(3 * components), Buffer.from([0xff, 0xd9])]);
  };
  assert.equal(inspectArtwork(jpeg(3), "image/jpeg").colorMode, "rgb");
  assert.equal(inspectArtwork(jpeg(4), "image/jpeg").colorMode, "cmyk");
  assert.equal(inspectArtwork(jpeg(1), "image/jpeg").colorMode, "grayscale");

  const pdf = (resources) => Buffer.from(["%PDF-1.4", "1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj",
    "2 0 obj<</Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842]>>endobj",
    `3 0 obj<</Type /Page /Parent 2 0 R ${resources}>>endobj`, "%%EOF"].join("\n"), "latin1");
  assert.equal(inspectArtwork(pdf("/ColorSpace /DeviceCMYK"), "application/pdf").colorMode, "cmyk");
  assert.equal(inspectArtwork(pdf("/ColorSpace /DeviceRGB"), "application/pdf").colorMode, "rgb");
  assert.equal(inspectArtwork(pdf("/ColorSpace /DeviceCMYK /CS0 /DeviceRGB"), "application/pdf").colorMode, "mixed");
  assert.equal(inspectArtwork(pdf("/CS [/ICCBased 9 0 R]>> 9 0 obj<</N 4 /Alternate /DeviceCMYK"), "application/pdf").colorMode, "cmyk");
  assert.equal(inspectArtwork(pdf("/ColorSpace /DeviceGray"), "application/pdf").colorMode, "grayscale");
  assert.equal(inspectArtwork(pdf(""), "application/pdf").colorMode, null, "a PDF that names no colour space is not guessed");
  assert.equal(inspectArtwork(pdf("/AP <</N 4 0 R>>"), "application/pdf").colorMode, null, "an appearance reference is not an ICC count");

  const psd = (mode) => {
    const bytes = Buffer.alloc(64);
    bytes.write("8BPS", 0, "latin1"); bytes.writeUInt16BE(1, 4); bytes.writeUInt16BE(4, 12);
    bytes.writeUInt32BE(1200, 14); bytes.writeUInt32BE(1800, 18); bytes.writeUInt16BE(8, 22); bytes.writeUInt16BE(mode, 24);
    // Colour mode data (empty), then one ResolutionInfo resource at 300 pixels per inch.
    bytes.writeUInt32BE(0, 26); bytes.writeUInt32BE(28, 30);
    bytes.write("8BIM", 34, "latin1"); bytes.writeUInt16BE(0x03ed, 38); bytes.writeUInt16BE(0, 40);
    bytes.writeUInt32BE(16, 42); bytes.writeUInt32BE(300 * 65536, 46); bytes.writeUInt16BE(1, 50);
    return bytes;
  };
  assert.deepEqual((({ pixelWidth, pixelHeight, dpi, colorMode }) => ({ pixelWidth, pixelHeight, dpi, colorMode }))(
    inspectArtwork(psd(4), "image/vnd.adobe.photoshop")), { pixelWidth: 1800, pixelHeight: 1200, dpi: 300, colorMode: "cmyk" });
  assert.equal(inspectArtwork(psd(3), "image/vnd.adobe.photoshop").colorMode, "rgb");

  const webp = Buffer.alloc(40);
  webp.write("RIFF", 0, "latin1"); webp.writeUInt32LE(32, 4); webp.write("WEBPVP8X", 8, "latin1");
  webp.writeUIntLE(799, 24, 3); webp.writeUIntLE(599, 27, 3);
  assert.deepEqual((({ pixelWidth, pixelHeight, colorMode }) => ({ pixelWidth, pixelHeight, colorMode }))(
    inspectArtwork(webp, "image/webp")), { pixelWidth: 800, pixelHeight: 600, colorMode: "rgb" });
});

test("Super Admin guidance is validated against the taxonomy", () => {
  const taxonomy = defaultTaxonomy();
  const valid = { version: 1, default: { minimumDpi: 300, acceptsRgb: false },
    subcategories: { posters_standees: { minimumDpi: 180, acceptsRgb: false }, three_d_printing_scale_models: { minimumDpi: null, acceptsRgb: true } } };
  assert.deepEqual(validateArtworkGuidance(valid, taxonomy, fail), valid);
  for (const [value, code] of [
    [null, "invalid_artwork_guidance"],
    [{ ...valid, version: 2 }, "invalid_artwork_guidance"],
    [{ ...valid, default: { minimumDpi: 49, acceptsRgb: false } }, "invalid_artwork_guidance"],
    [{ ...valid, default: { minimumDpi: 300 } }, "invalid_artwork_guidance"],
    [{ ...valid, subcategories: { flyers: { minimumDpi: 300.5, acceptsRgb: false } } }, "invalid_artwork_guidance"],
    [{ ...valid, subcategories: { flyers: { minimumDpi: 300, acceptsRgb: false, note: "x" } } }, "invalid_artwork_guidance"],
    [{ ...valid, subcategories: { not_a_print_job: { minimumDpi: 300, acceptsRgb: false } } }, "unknown_artwork_guidance_subcategory"],
  ]) {
    assert.throws(() => validateArtworkGuidance(value, taxonomy, fail), { code });
  }
});

test("a print job named by a resolution target is not deleted out from under it", async () => {
  const store = { settings: { artworkGuidance: { version: 1, default: { minimumDpi: 300, acceptsRgb: false },
    subcategories: { custom_signs: { minimumDpi: 120, acceptsRgb: false } } } },
  taxonomy: { ...defaultTaxonomy(), subcategories: [...defaultTaxonomy().subcategories,
    { id: "taxs_custom_signs", code: "custom_signs", name: "Custom signs", categoryCode: "recognition_awards_signage", active: true }] } };
  await assert.rejects(routeTaxonomyDelete({ req: { method: "DELETE" }, url: new URL("http://api.test/taxonomy/subcategories/custom_signs"),
    store, user: { id: "admin", role: "super_admin", memberships: ["super_admin"] } }),
  (error) => error.code === "catalog_entry_in_use" && error.details.usage.artworkGuidance === 1);
});

function cartFixture() {
  const client = { id: "client", role: "client", email: "client@example.invalid" };
  const store = {
    settings: { ...defaultOperationalSettings(), hubPickupEnabled: true },
    taxonomy: defaultTaxonomy(),
    users: [client, { id: "shop", role: "supplier", email: "shop@example.invalid" }],
    userRoleMemberships: [{ userId: "client", role: "client" }, { userId: "shop", role: "supplier" }],
    clientPreferences: [], clientAddresses: [], carts: [], cartLines: [],
    supplierProfiles: [{ userId: "shop", shopName: "Shop", contactName: "Printer", shop: { lat: 7.064, lng: 125.6085, label: "Shop" }, pickupAvailable: true }],
    approvalCases: [{ id: "case_shop", userId: "shop", kind: "supplier", status: "approved" }],
    supplierServices: [{ id: "service", supplierId: "shop", categoryCode: "marketing_collateral", state: "live",
      pricingBasis: "per_unit", referenceRateMinor: 1000, turnaroundHours: 12, standardTurnaroundHours: 12, version: 1 }],
    supplierServiceFileFormats: [{ supplierServiceId: "service", formatCode: "png" }],
    acceptedFileFormats: [{ code: "png", displayName: "PNG", inputKind: "file", mimeTypes: ["image/png"], extensions: ["png"], active: true }],
    catalogItems: [{ id: "item_tarp", supplierId: "shop", supplierServiceId: "service", subcategoryCode: "tarpaulins_outdoor_banners",
      name: "Tarpaulin", description: "Outdoor tarpaulin", basePriceMinor: 1000, pricingUnit: "per_area", measureUnit: "ft", printerMaxWidthFeet: 10,
      turnaroundMode: "inherit", fileFormatMode: "inherit", active: true, sortOrder: 0, version: 1 }],
    catalogItemFileFormats: [], catalogItemPhotos: [{ catalogItemId: "item_tarp", fileId: "photo", sortOrder: 0 }],
    catalogOptionGroups: [], catalogOptions: [], catalogPrepSteps: [],
    files: [
      { fileId: "photo", ownerId: "shop", purpose: "catalog_item_photo", state: "ready", objectKey: "shop/photo.jpg" },
      { ...rasterFile("art", { pixels: 0, colorMode: "rgb" }), detected: { kind: "raster", pageCount: 1, pixelWidth: 1200, pixelHeight: 2400, dpi: 72, colorMode: "rgb" } },
      { fileId: "qr", ownerId: "client", purpose: "payment_proof", state: "ready", objectKey: "client/qr.jpg", references: [] },
    ],
    orders: [], orderJobs: [], orderLineItems: [], orderLineItemOptions: [], jobQaChecklist: [], orderInvoices: [],
    notifications: [], auditLog: [],
  };
  let sequence = 0;
  const call = async (method, pathname, body, at = AT) => routeOrderMatch({ req: { method }, url: new URL(`http://api.test${pathname}`), store, user: client,
    readBody: async () => body || {}, id: (prefix) => `${prefix}_${++sequence}`, now: () => at });
  return { store, call };
}

test("the client's acceptance is stored with the figures shown and travels into the order", async () => {
  const { store, call } = cartFixture();
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  const added = await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_tarp", optionIds: [], quantity: 1,
    measurement: { width: 3000, height: 6000 }, artworkFileId: "art" });
  const lineId = added.body.cart.lines[0].id;
  assert.deepEqual(added.body.cart.lines[0].artworkGuidance.files[0].warnings, [
    { code: "low_resolution", effectiveDpi: 33, minimumDpi: 100, acceptedAt: null },
    { code: "color_mode", colorMode: "rgb", expectedColorMode: "cmyk", acceptedAt: null },
  ]);
  assert.equal(added.body.cart.lines[0].artworkGuidance.openWarningCount, 2);

  const warnings = `/me/carts/${cartId}/lines/${lineId}/artwork-warnings`;
  await assert.rejects(call("PUT", warnings, { accept: [{ fileId: "art", code: "bleed" }] }), { code: "invalid_artwork_warning_acceptance" });
  await assert.rejects(call("PUT", warnings, { accept: "yes" }), { code: "invalid_artwork_warning_acceptance" });
  await assert.rejects(call("PUT", warnings, { accept: [{ fileId: "other", code: "low_resolution" }] }), { code: "artwork_warning_not_found" });

  const accepted = await call("PUT", warnings, { accept: [{ fileId: "art", code: "low_resolution" }, { fileId: "art", code: "color_mode" }] });
  assert.equal(accepted.body.cart.lines[0].artworkGuidance.openWarningCount, 0);
  assert.deepEqual(store.cartLines[0].artworkWarningAcceptances, [
    { fileId: "art", code: "low_resolution", effectiveDpi: 33, minimumDpi: 100, acceptedAt: AT },
    { fileId: "art", code: "color_mode", colorMode: "rgb", expectedColorMode: "cmyk", acceptedAt: AT },
  ]);
  // Re-sending keeps the first acceptance time.
  await call("PUT", warnings, { accept: [{ fileId: "art", code: "low_resolution" }, { fileId: "art", code: "color_mode" }] }, "2026-10-16T02:00:00.000Z");
  assert.equal(store.cartLines[0].artworkWarningAcceptances[0].acceptedAt, AT);

  // A bigger banner prints softer than what was accepted, so the resolution warning reopens.
  const resized = await call("PATCH", `/me/carts/${cartId}/lines/${lineId}`, { measurement: { width: 4000, height: 8000 } });
  const reopened = resized.body.cart.lines[0].artworkGuidance.files[0].warnings;
  assert.deepEqual(reopened.map((w) => [w.code, w.acceptedAt]), [["low_resolution", null], ["color_mode", AT]]);
  assert.equal(reopened[0].effectiveDpi, 25);

  // Checkout is never blocked by a warning, accepted or not.
  const placed = await call("POST", `/me/carts/${cartId}/checkout`, { payment: { method: "qr_manual", proofFileId: "qr", reference: "GUIDANCE-1" } });
  assert.equal(placed.status, 201);
  const lineItem = store.orderLineItems[0];
  assert.equal(lineItem.artworkGuidance.version, 1);
  assert.equal(lineItem.artworkGuidance.evaluatedAt, AT);
  assert.equal(lineItem.artworkGuidance.openWarningCount, 1);
  assert.deepEqual(lineItem.artworkGuidance.files[0].warnings, [
    { code: "low_resolution", effectiveDpi: 25, minimumDpi: 100, acceptedAt: null },
    { code: "color_mode", colorMode: "rgb", expectedColorMode: "cmyk", acceptedAt: AT },
  ]);

  // The GRIDGO Team check, the client's proof screen and the released shop all read it; riders do not.
  const order = store.orders[0];
  order.fileCheck = { status: "passed" };
  order.state = "production";
  store.orderJobs[0].riderId = "rider";
  for (const user of [{ id: "ops", role: "ops_admin" }, { id: "admin", role: "super_admin" }, { id: "client", role: "client" }, { id: "shop", role: "supplier" }]) {
    assert.deepEqual(publicOrderFor(order, user, store).productionItems[0].artworkGuidance, lineItem.artworkGuidance, user.role);
  }
  assert.equal(publicOrderFor(order, { id: "rider", role: "rider" }, store).productionItems[0]?.artworkGuidance ?? null, null);

  // Later settings changes never rewrite the record.
  store.settings.artworkGuidance = { version: 1, default: { minimumDpi: 50, acceptsRgb: true }, subcategories: {} };
  assert.equal(publicOrderFor(order, { id: "ops", role: "ops_admin" }, store).productionItems[0].artworkGuidance.minimumDpi, 100);
});

test("a corrupt file stays blocked while a warned file goes through", async () => {
  const { store, call } = cartFixture();
  store.files.find((file) => file.fileId === "art").artworkCheck = { status: "failed", reason: "artwork_file_unreadable", message: "The artwork is incomplete." };
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "item_tarp", optionIds: [], quantity: 1, measurement: { width: 3000, height: 6000 }, artworkFileId: "art" });
  await assert.rejects(call("POST", `/me/carts/${cartId}/checkout`, { payment: { method: "qr_manual", proofFileId: "qr", reference: "BLOCKED" } }),
    { code: "artwork_file_check_failed" });
});

test("a line with only design links has nothing to judge and no record", () => {
  assert.equal(artworkGuidanceSnapshot({ settings: defaultOperationalSettings() }, { subcategoryCode: "flyers" }, {}, [], AT), null);
});

test("an acceptance never covers warnings the line does not have", () => {
  const store = { settings: defaultOperationalSettings(), files: [rasterFile("sharp", { pixels: 3000, colorMode: "cmyk" })], catalogOptions: [] };
  const line = { measurement: { width: SQUARE_INCHES * MM, height: SQUARE_INCHES * MM } };
  assert.throws(() => acceptArtworkWarnings(store, { subcategoryCode: "flyers", measureUnit: "in" }, line, ["sharp"],
    { accept: [{ fileId: "sharp", code: "low_resolution" }] }, AT, fail), { code: "artwork_warning_not_found" });
  assert.deepEqual(acceptArtworkWarnings(store, { subcategoryCode: "flyers", measureUnit: "in" }, line, ["sharp"], { accept: [] }, AT, fail), []);
});
