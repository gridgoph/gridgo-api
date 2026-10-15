import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { inspectArtwork } from "../src/artwork-inspection.js";
import { DOCX_CONTENT_TYPE } from "../src/docx.js";
import { defaultOperationalSettings, publicOrderFor } from "../src/operational-model.js";
import { routeOrderMatch, prepareArtworkCheckout } from "../src/order-match-routes.js";
import { routeSupplierCatalog } from "../src/catalog-routes.js";
import { publicCatalogItem } from "../src/supplier-catalog.js";
import { defaultTaxonomy } from "../src/taxonomy.js";
import {
  PRINT_LAYOUTS, parsePaperSize, parsePrintLayouts, parseCartPrintLayout, printLayoutCheck,
} from "../src/print-layout.js";
import { docxEntries, zip } from "./helpers/docx.mjs";

const AT = "2026-08-24T01:00:00.000Z";
const A4 = "0 0 595.276 841.89";
const A3 = "0 0 841.89 1190.55";
const A1 = "0 0 1683.78 2383.94";

function fail(status, code, message, details) {
  throw Object.assign(new Error(message), { status, code, details });
}

/** A page tree whose leaves state their own boxes, the way plan sets are exported. */
function pdf(boxes, { rootBox = null } = {}) {
  const kids = boxes.map((_, index) => `${10 + index} 0 R`).join(" ");
  return Buffer.from([
    "%PDF-1.4",
    "1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj",
    `2 0 obj<</Type /Pages /Kids [${kids}] /Count ${boxes.length}${rootBox ? ` /MediaBox [${rootBox}]` : ""}>>endobj`,
    ...boxes.map((box, index) => `${10 + index} 0 obj<</Type /Page /Parent 2 0 R${box ? ` /MediaBox [${box}]` : ""} /Resources << >>>>endobj`),
    "trailer<</Root 1 0 R>>",
    "%%EOF",
  ].join("\n"), "latin1");
}

function wordDocument(body) {
  const entries = docxEntries("3").map(([name, value]) => name === "word/document.xml"
    ? [name, `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`]
    : [name, value]);
  return zip(entries);
}

/** One document-printing listing: a paper choice bound to sizes, and a colour choice. */
function store({ printLayouts = ["fit_to_paper", "actual_size_centered"] } = {}) {
  const client = { id: "user_client", role: "client", email: "client@gridgo.test" };
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
      catalogItems: [
        {
          id: "plans", supplierId: "supplier_a", supplierServiceId: "service_a", subcategoryCode: "flyers",
          name: "Plan printing", description: "Plans", basePriceMinor: 6_500, pricingUnit: "per_unit",
          turnaroundMode: "inherit", fileFormatMode: "inherit", active: true, sortOrder: 0, version: 1, printLayouts,
        },
        {
          id: "flyers", supplierId: "supplier_a", supplierServiceId: "service_a", subcategoryCode: "flyers",
          name: "Flyers", description: "Flyers", basePriceMinor: 1_000, pricingUnit: "per_unit",
          turnaroundMode: "inherit", fileFormatMode: "inherit", active: true, sortOrder: 1, version: 1,
        },
      ],
      catalogItemFileFormats: [], catalogPrepSteps: [],
      catalogItemPhotos: [{ catalogItemId: "plans", fileId: "photo_plans", sortOrder: 0 }, { catalogItemId: "flyers", fileId: "photo_flyers", sortOrder: 0 }],
      catalogOptionGroups: [
        { id: "paper", catalogItemId: "plans", name: "Paper size", kind: "spec", required: true, sortOrder: 0, version: 1 },
        { id: "colour", catalogItemId: "plans", name: "Colour", kind: "spec", required: false, sortOrder: 1, version: 1 },
      ],
      catalogOptions: [
        { id: "opt_a4", optionGroupId: "paper", label: "A4", priceModifierMinor: 0, specBinding: { fieldCode: "size", value: "A4" }, active: true, sortOrder: 0 },
        { id: "opt_a3", optionGroupId: "paper", label: "A3", priceModifierMinor: 500, specBinding: { fieldCode: "size", value: "A3" }, active: true, sortOrder: 1 },
        { id: "opt_a1", optionGroupId: "paper", label: "24x36 / A1", priceModifierMinor: 1_500, specBinding: { fieldCode: "size", value: "A1" }, active: true, sortOrder: 2 },
        { id: "opt_bw", optionGroupId: "colour", label: "Black and white", priceModifierMinor: 0, specBinding: null, active: true, sortOrder: 0 },
      ],
      files: [
        { fileId: "page_a3", ownerId: client.id, purpose: "artwork", detectedContentType: "application/pdf", detected: inspectArtwork(pdf([A3]), "application/pdf"), artworkCheck: { status: "passed", checkedAt: AT }, state: "ready", objectKey: "c/a3.pdf", references: [] },
        { fileId: "page_a4", ownerId: client.id, purpose: "artwork", detectedContentType: "application/pdf", detected: inspectArtwork(pdf([A4]), "application/pdf"), artworkCheck: { status: "passed", checkedAt: AT }, state: "ready", objectKey: "c/a4.pdf", references: [] },
        { fileId: "photo_plans", ownerId: "supplier_a", purpose: "catalog_item_photo", state: "ready", objectKey: "s/plans.jpg" },
        { fileId: "photo_flyers", ownerId: "supplier_a", purpose: "catalog_item_photo", state: "ready", objectKey: "s/flyers.jpg" },
        { fileId: "proof", ownerId: client.id, purpose: "payment_proof", state: "ready", objectKey: "c/qr.jpg", references: [] },
        { fileId: "someone_elses", ownerId: "user_other", purpose: "artwork", detectedContentType: "application/pdf", detected: inspectArtwork(pdf([A3]), "application/pdf"), state: "ready", objectKey: "o/a3.pdf", references: [] },
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

const check = (fixture, options) => printLayoutCheck(fixture, fixture.catalogItems[0], options);

test("paper sizes are read from names, inches and metric labels", () => {
  assert.deepEqual(parsePaperSize("A4"), { widthMilli: 210_000, heightMilli: 297_000, pageSize: "A4" });
  assert.deepEqual(parsePaperSize("Short (8.5 x 11 in)"), { widthMilli: 215_900, heightMilli: 279_400, pageSize: "Short" });
  assert.deepEqual(parsePaperSize("Long / Folio"), { widthMilli: 215_900, heightMilli: 330_200, pageSize: "Long" });
  assert.deepEqual(parsePaperSize("30x40"), { widthMilli: 762_000, heightMilli: 1_016_000, pageSize: null });
  assert.deepEqual(parsePaperSize("210 x 297 mm"), { widthMilli: 210_000, heightMilli: 297_000, pageSize: "A4" });
  assert.equal(parsePaperSize("Black and white"), null);
  assert.equal(parsePaperSize(""), null);
});

test("shop layouts are canonical, deduplicated and limited to the three codes", () => {
  assert.deepEqual(parsePrintLayouts(["actual_size_original_position", "fit_to_paper", "fit_to_paper"], fail), ["fit_to_paper", "actual_size_original_position"]);
  assert.deepEqual(parsePrintLayouts([], fail), []);
  assert.throws(() => parsePrintLayouts(["shrink"], fail), { code: "invalid_print_layouts" });
  assert.throws(() => parsePrintLayouts("fit_to_paper", fail), { code: "invalid_print_layouts" });
  assert.deepEqual(PRINT_LAYOUTS, ["fit_to_paper", "actual_size_centered", "actual_size_original_position"]);
});

test("a layout the listing does not offer is refused with its supported list", () => {
  const { store: fixture } = store();
  assert.equal(parseCartPrintLayout(fixture.catalogItems[0], "fit_to_paper", fail), "fit_to_paper");
  assert.throws(() => parseCartPrintLayout(fixture.catalogItems[0], "actual_size_original_position", fail),
    (error) => error.code === "print_layout_not_supported" && error.status === 409
      && error.details.supported.join() === "fit_to_paper,actual_size_centered");
  assert.throws(() => parseCartPrintLayout(fixture.catalogItems[1], "fit_to_paper", fail), { code: "print_layout_not_supported" });
  assert.throws(() => parseCartPrintLayout(fixture.catalogItems[0], "centred", fail), { code: "invalid_print_layout" });
});

test("cut-off: an A3 page at actual size on A4 is cut off and A3 is suggested", () => {
  const { store: fixture } = store();
  const result = check(fixture, { optionIds: ["opt_a4", "opt_bw"], fileIds: ["page_a3"], layout: "actual_size_centered" });
  assert.equal(result.exceedsPaper, true);
  assert.equal(result.cutOff, true);
  assert.equal(result.scaleChanges, false);
  assert.deepEqual(result.paper, { optionId: "opt_a4", label: "A4", widthMilli: 210_000, heightMilli: 297_000, pageSize: "A4" });
  assert.deepEqual(result.suggestedPaper, { optionId: "opt_a3", label: "A3", widthMilli: 297_000, heightMilli: 420_000, pageSize: "A3" });
  assert.equal(result.files[0].page.pageSize, "A3");
  assert.deepEqual(result.unknown, []);
});

test("cut-off: fit to paper never cuts off but warns the scale changes", () => {
  const { store: fixture } = store();
  const result = check(fixture, { optionIds: ["opt_a4"], fileIds: ["page_a3"], layout: "fit_to_paper" });
  assert.equal(result.exceedsPaper, true);
  assert.equal(result.cutOff, false);
  assert.equal(result.scaleChanges, true);
  const same = check(fixture, { optionIds: ["opt_a4"], fileIds: ["page_a4"], layout: "fit_to_paper" });
  assert.equal(same.scaleChanges, false);
  assert.equal(same.exceedsPaper, false);
});

test("cut-off: a page that fits, either way round, is not cut off", () => {
  const { store: fixture } = store();
  fixture.files.push({ ...fixture.files[1], fileId: "landscape", detected: inspectArtwork(pdf(["0 0 841.89 595.276"]), "application/pdf") });
  for (const fileId of ["page_a4", "landscape"]) {
    const result = check(fixture, { optionIds: ["opt_a4"], fileIds: [fileId], layout: "actual_size_centered" });
    assert.equal(result.cutOff, false, fileId);
    assert.equal(result.suggestedPaper, null, fileId);
  }
  // A3 paper takes an A3 page with the point-to-millimetre rounding to spare.
  assert.equal(check(fixture, { optionIds: ["opt_a3"], fileIds: ["page_a3"], layout: "actual_size_centered" }).cutOff, false);
});

test("cut-off: the largest page of a mixed plan set decides, not the cover", () => {
  const { store: fixture } = store();
  const detected = inspectArtwork(pdf([A4, A1, A3]), "application/pdf");
  assert.equal(detected.pageSize, "A4");
  assert.equal(detected.pageEnvelope.mixed, true);
  assert.equal(detected.pageEnvelope.longSideMilli, 841_001);
  fixture.files.push({ ...fixture.files[1], fileId: "plan_set", detected });
  const result = check(fixture, { optionIds: ["opt_a3"], fileIds: ["plan_set"], layout: "actual_size_centered" });
  assert.equal(result.cutOff, true);
  assert.equal(result.suggestedPaper.optionId, "opt_a1");
  assert.equal(result.files[0].page.mixedPageSizes, true);
});

test("cut-off: when no offered paper fits, the warning stands with no suggestion", () => {
  const { store: fixture } = store();
  fixture.files.push({ ...fixture.files[1], fileId: "a0", detected: inspectArtwork(pdf(["0 0 2383.94 3370.39"]), "application/pdf") });
  const result = check(fixture, { optionIds: ["opt_a4"], fileIds: ["a0"], layout: "actual_size_original_position" });
  assert.equal(result.cutOff, true);
  assert.equal(result.suggestedPaper, null);
});

test("cut-off: an unreadable page size or paper says unknown instead of guessing", () => {
  const { store: fixture } = store();
  fixture.files.push({ ...fixture.files[1], fileId: "no_dpi", detectedContentType: "image/png", detected: { kind: "raster", pixelWidth: 1200, pixelHeight: 1800, dpi: null, widthMilli: null, heightMilli: null } });
  const unread = check(fixture, { optionIds: ["opt_a4"], fileIds: ["no_dpi"], layout: "actual_size_centered" });
  assert.equal(unread.exceedsPaper, null);
  assert.equal(unread.cutOff, null);
  assert.deepEqual(unread.unknown, [{ code: "page_size_unknown", fileId: "no_dpi" }]);
  // One unreadable file does not hide another file that is too big.
  const mixed = check(fixture, { optionIds: ["opt_a4"], fileIds: ["no_dpi", "page_a3"], layout: "actual_size_centered" });
  assert.equal(mixed.cutOff, true);
  const noPaper = check(fixture, { optionIds: [], fileIds: ["page_a3"], layout: null });
  assert.equal(noPaper.paper, null);
  assert.equal(noPaper.exceedsPaper, null);
  assert.deepEqual(noPaper.unknown, [{ code: "paper_size_unknown" }]);
  assert.equal(check(fixture, { optionIds: ["opt_a4"], fileIds: [] }).unknown[0].code, "no_artwork_file");
});

test("a listing with no layouts has no check at all", () => {
  const { store: fixture } = store();
  assert.equal(printLayoutCheck(fixture, fixture.catalogItems[1], { optionIds: [], fileIds: ["page_a3"] }), null);
});

test("PDF page boxes: a root box every page overrides is not counted as a page", () => {
  const overridden = inspectArtwork(pdf([A4, A4], { rootBox: A1 }), "application/pdf");
  assert.deepEqual(overridden.pageEnvelope, { shortSideMilli: 210_000, longSideMilli: 297_000, mixed: false });
  const inherited = inspectArtwork(pdf([null, A3], { rootBox: A4 }), "application/pdf");
  assert.equal(inherited.pageEnvelope.longSideMilli, 420_000);
  assert.equal(inherited.pageEnvelope.mixed, true);
});

test("PDF page boxes: pages written before their page tree are still leaves", () => {
  const bytes = Buffer.from([
    "%PDF-1.4",
    `10 0 obj<</Type /Page /Parent 2 0 R /MediaBox [${A3}] /Resources << /ProcSet [/PDF] >>>>endobj`,
    `11 0 obj<</Type /Page /Parent 2 0 R /MediaBox [${A4}]>>endobj`,
    `2 0 obj<</Type /Pages /Kids [10 0 R 11 0 R] /Count 2 /MediaBox [${A1}]>>endobj`,
    "1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj",
    "trailer<</Root 1 0 R>>",
    "%%EOF",
  ].join("\n"), "latin1");
  const read = inspectArtwork(bytes, "application/pdf");
  assert.deepEqual(read.pageEnvelope, { shortSideMilli: 297_000, longSideMilli: 420_000, mixed: true });
});

test("PDF page boxes: a two-thousand-page file is read in one pass", () => {
  const boxes = Array.from({ length: 2000 }, (_, index) => index === 1999 ? A1 : A4);
  const started = process.hrtime.bigint();
  const read = inspectArtwork(pdf(boxes), "application/pdf");
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1000, "inspection stays well under a second");
  assert.equal(read.pageCount, 2000);
  assert.equal(read.pageEnvelope.longSideMilli, 841_001);
});

test("PDF page boxes: deeply nested boxes cannot make the inspection quadratic", () => {
  const depth = 2000;
  const nested = "<< /MediaBox [0 0 595 842] ".repeat(depth) + "x".repeat(2 * 1024 * 1024) + " >>".repeat(depth);
  const bytes = Buffer.from(`%PDF-1.4\n1 0 obj${nested}endobj\n2 0 obj<</Type /Pages /Count 1>>endobj\ntrailer<<>>\n%%EOF`, "latin1");
  const started = process.hrtime.bigint();
  const read = inspectArtwork(bytes, "application/pdf");
  // The per-dictionary rescan this replaced took about a second here.
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 400, "inspection stays linear in the file size");
  assert.equal(read.pageEnvelope.longSideMilli, 297_039);
});

test("PDF page boxes inside a compressed object stream are read", () => {
  const hidden = zlib.deflateSync(Buffer.from("<</Type /Pages /Count 2 /Kids [5 0 R 6 0 R]>> <</Type /Page /MediaBox [" + A4 + "]>> <</Type /Page /MediaBox [" + A3 + "]>>", "latin1"));
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.5\n4 0 obj<</Type /ObjStm /Filter/FlateDecode/Length 99>>stream\n", "latin1"),
    hidden,
    Buffer.from("\nendstream endobj\ntrailer<<>>\n%%EOF", "latin1"),
  ]);
  const read = inspectArtwork(bytes, "application/pdf");
  assert.equal(read.pageCount, 2);
  assert.equal(read.pageSize, "A4");
  assert.equal(read.pageEnvelope.longSideMilli, 420_000);
});

test("a Word file's section page size is read, landscape included", () => {
  const letter = inspectArtwork(wordDocument('<w:p/><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>'), DOCX_CONTENT_TYPE);
  assert.equal(letter.kind, "document");
  assert.equal(letter.pageCount, 3);
  assert.equal(letter.widthMilli, 215_900);
  assert.equal(letter.heightMilli, 279_400);
  assert.equal(letter.pageSize, "Letter");
  const sections = inspectArtwork(wordDocument(
    '<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr></w:p>'
    + '<w:sectPr><w:pgSz w:w="23811" w:h="16838" w:orient="landscape"/></w:sectPr>'), DOCX_CONTENT_TYPE);
  assert.equal(sections.pageSize, "A4");
  assert.equal(sections.orientation, "portrait");
  assert.equal(sections.pageEnvelope.mixed, true);
  assert.equal(sections.pageEnvelope.longSideMilli, 420_000);
  const undeclared = inspectArtwork(wordDocument("<w:p/>"), DOCX_CONTENT_TYPE);
  assert.equal(undeclared.widthMilli, null);
  assert.equal(undeclared.pageEnvelope, null);
});

test("a raster page has an actual size only when it declares a density", () => {
  const png = Buffer.alloc(64);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.writeUInt32BE(13, 8); png.write("IHDR", 12, "latin1");
  png.writeUInt32BE(2480, 16); png.writeUInt32BE(3508, 20);
  png.writeUInt32BE(9, 33); png.write("pHYs", 37, "latin1");
  png.writeUInt32BE(11811, 41); png.writeUInt32BE(11811, 45); png[49] = 1;
  const read = inspectArtwork(png, "image/png");
  assert.equal(read.pageSize, "A4");
  assert.deepEqual(read.pageEnvelope, { shortSideMilli: read.widthMilli, longSideMilli: read.heightMilli, mixed: false });
});

test("cart, checkout and every order read carry the layout and the fit the client saw", async () => {
  const { store: fixture, client } = store();
  const call = caller(fixture, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;

  // Listing reads say which layouts to offer; a product with none says so.
  assert.deepEqual(publicCatalogItem(fixture, fixture.catalogItems[0]).printLayouts, ["fit_to_paper", "actual_size_centered"]);
  assert.deepEqual(publicCatalogItem(fixture, fixture.catalogItems[1]).printLayouts, []);

  // Before the line exists the app asks for the same check.
  const probe = await call("GET", `/me/print-layout-check?catalogItemId=plans&optionIds=opt_a4,opt_bw&fileIds=page_a3&layout=actual_size_centered`);
  assert.equal(probe.status, 200);
  assert.equal(probe.body.check.cutOff, true);
  assert.equal(probe.body.check.suggestedPaper.optionId, "opt_a3");
  await assert.rejects(call("GET", `/me/print-layout-check?catalogItemId=plans&fileIds=someone_elses`), { code: "file_not_ready" });
  await assert.rejects(call("GET", `/me/print-layout-check?catalogItemId=plans&layout=actual_size_original_position`), { code: "print_layout_not_supported" });
  assert.equal((await call("GET", `/me/print-layout-check?catalogItemId=flyers`)).body.check, null);

  await assert.rejects(call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "plans", optionIds: ["opt_a4"], quantity: 1, artworkFileId: "page_a3", printLayout: "actual_size_original_position",
  }), { code: "print_layout_not_supported" });
  const added = await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "plans", optionIds: ["opt_a4"], quantity: 1, artworkFileId: "page_a3" });
  const line = added.body.cart.lines[0];
  assert.equal(line.printLayout, null);
  assert.deepEqual(line.listing.printLayouts, ["fit_to_paper", "actual_size_centered"]);
  assert.equal(line.printLayoutCheck.layout, null);
  assert.equal(line.printLayoutCheck.exceedsPaper, true);

  // Nothing is preselected, so checkout waits for a choice.
  const pay = { payment: { method: "qr_manual", proofFileId: "proof", reference: "LAYOUT" } };
  await assert.rejects(call("POST", `/me/carts/${cartId}/checkout`, pay),
    (error) => error.code === "print_layout_required" && error.details.lineId === line.id);

  const chosen = await call("PATCH", `/me/carts/${cartId}/lines/${line.id}`, { printLayout: "actual_size_centered" });
  assert.equal(chosen.body.cart.lines[0].printLayout, "actual_size_centered");
  assert.equal(chosen.body.cart.lines[0].printLayoutCheck.cutOff, true);
  const full = (await call("GET", `/me/carts/${cartId}`)).body.cart.lines[0];
  assert.equal(full.printLayoutCheck.suggestedPaper.optionId, "opt_a3");

  // The warning never blocks: the client may keep A4 at actual size.
  const placed = await call("POST", `/me/carts/${cartId}/checkout`, pay);
  assert.equal(placed.status, 201);
  const snapshot = fixture.orderLineItems[0].printLayout;
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.code, "actual_size_centered");
  assert.equal(snapshot.check.cutOff, true);
  assert.equal(fixture.orderInvoices[0].snapshot.lines[0].printLayout, "actual_size_centered");

  // The refused attempt above left its unsaved order in this in-memory store;
  // a real request rolls that back with its transaction.
  const order = fixture.orders.find((row) => row.id === fixture.orderLineItems[0].orderId);
  order.fileCheck.status = "passed";
  for (const user of [client, { id: "supplier_a", role: "supplier" }, { id: "ops", role: "ops_admin" }]) {
    const item = publicOrderFor(order, user, fixture).productionItems[0];
    assert.equal(item.printLayout, "actual_size_centered", user.role);
    assert.equal(item.printLayoutCheck.cutOff, true, user.role);
  }
  // A shop changing its layouts later does not rewrite the agreed order.
  fixture.catalogItems[0].printLayouts = [];
  assert.equal(publicOrderFor(order, client, fixture).productionItems[0].printLayout, "actual_size_centered");
});

test("products without layouts keep the released cart flow unchanged", async () => {
  const { store: fixture, client } = store();
  const call = caller(fixture, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  const added = await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "flyers", optionIds: [], quantity: 1, artworkFileId: "page_a4" });
  assert.equal(added.body.cart.lines[0].printLayout, null);
  assert.equal(added.body.cart.lines[0].printLayoutCheck, null);
  await assert.rejects(call("PATCH", `/me/carts/${cartId}/lines/${added.body.cart.lines[0].id}`, { printLayout: "fit_to_paper" }),
    { code: "print_layout_not_supported" });
  const placed = await call("POST", `/me/carts/${cartId}/checkout`, { payment: { method: "qr_manual", proofFileId: "proof", reference: "NO-LAYOUT" } });
  assert.equal(placed.status, 201);
  assert.equal(Object.hasOwn(fixture.orderLineItems[0], "printLayout"), false);
  assert.equal(publicOrderFor(fixture.orders[0], client, fixture).productionItems[0].printLayout, null);
});

test("a layout the shop stops offering is refused at checkout until the client chooses again", async () => {
  const { store: fixture, client } = store();
  const call = caller(fixture, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  const added = await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "plans", optionIds: ["opt_a4"], quantity: 1, artworkFileId: "page_a4", printLayout: "actual_size_centered",
  });
  fixture.catalogItems[0].printLayouts = ["fit_to_paper"];
  const pay = { payment: { method: "qr_manual", proofFileId: "proof", reference: "DROPPED" } };
  await assert.rejects(call("POST", `/me/carts/${cartId}/checkout`, pay), { code: "print_layout_not_supported" });
  await call("PATCH", `/me/carts/${cartId}/lines/${added.body.cart.lines[0].id}`, { printLayout: "fit_to_paper" });
  assert.equal((await call("POST", `/me/carts/${cartId}/checkout`, pay)).status, 201);
});

test("the shop marks layouts on its listing, and the change goes to listing review", async () => {
  const { store: fixture } = store();
  const shop = fixture.users[1];
  const write = (body) => routeSupplierCatalog({
    req: { method: "PATCH", headers: {} }, url: new URL("http://gridgo.test/me/catalog-items/flyers"), store: fixture, user: shop,
    readBody: async () => body, id: (prefix) => `${prefix}_1`, now: () => AT, audit: () => {},
  });
  await assert.rejects(write({ expectedVersion: 1, printLayouts: ["upside_down"] }), { code: "invalid_print_layouts" });
  const saved = await write({ expectedVersion: 1, printLayouts: ["actual_size_original_position", "fit_to_paper"] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.item.printLayouts, ["fit_to_paper", "actual_size_original_position"]);
  assert.equal(saved.body.reviewStatus, "pending");
  // Clients keep the approved listing, without layouts, until review passes.
  assert.deepEqual(publicCatalogItem(fixture, fixture.catalogItems[1]).printLayouts, []);
  // A text-only edit of an older row with no layouts field does not open a review.
  delete fixture.catalogItems[0].printLayouts;
  const renamed = await routeSupplierCatalog({
    req: { method: "PATCH", headers: {} }, url: new URL("http://gridgo.test/me/catalog-items/plans"), store: fixture, user: shop,
    readBody: async () => ({ expectedVersion: 1, name: "Plan printing, A-series" }), id: (prefix) => `${prefix}_2`, now: () => AT, audit: () => {},
  });
  assert.equal(renamed.body.item.reviewStatus, "approved");
});

test("layouts on an unapproved listing draft cannot be chosen through the cart routes", async () => {
  const { store: fixture, client } = store({ printLayouts: [] });
  const item = fixture.catalogItems[0];
  // The approved version offers no layout; the shop's pending draft adds one.
  item.approvedSnapshot = { item: structuredClone(item), catalogOptionGroups: structuredClone(fixture.catalogOptionGroups),
    catalogOptions: structuredClone(fixture.catalogOptions), catalogItemPhotos: structuredClone(fixture.catalogItemPhotos),
    catalogPriceTiers: [], catalogSpeedTiers: [], catalogItemFileFormats: [] };
  Object.assign(item, { reviewStatus: "pending", printLayouts: ["fit_to_paper"] });
  const call = caller(fixture, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  await assert.rejects(call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "plans", optionIds: ["opt_a4"], quantity: 1, artworkFileId: "page_a4", printLayout: "fit_to_paper",
  }), { code: "print_layout_not_supported" });
  await assert.rejects(call("GET", "/me/print-layout-check?catalogItemId=plans&layout=fit_to_paper"), { code: "print_layout_not_supported" });
  const added = await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "plans", optionIds: ["opt_a4"], quantity: 1, artworkFileId: "page_a4" });
  assert.equal(added.body.cart.lines[0].printLayoutCheck, null);
  assert.deepEqual(added.body.cart.lines[0].listing.printLayouts, []);
  // Checkout follows the approved version too: no layout is required yet.
  const placed = await call("POST", `/me/carts/${cartId}/checkout`, { payment: { method: "qr_manual", proofFileId: "proof", reference: "DRAFT" } });
  assert.equal(placed.status, 201);
});
