import test from "node:test";
import assert from "node:assert/strict";

import { defaultOperationalSettings, publicOrderFor } from "../src/operational-model.js";
import { routeOrderMatch, prepareArtworkCheckout } from "../src/order-match-routes.js";
import { publicCatalogItem, privateCatalogItem } from "../src/supplier-catalog.js";
import { defaultTaxonomy } from "../src/taxonomy.js";
import {
  COVER_CHOICES, COVER_SPINE_SUBCATEGORIES, parseCoverSpine, spineSummary,
} from "../src/hardbound-cover.js";

const AT = "2026-10-16T01:00:00.000Z";
const HARDBOUND = { subcategoryCode: "binding_hardbound" };

function fail(status, code, message, details) {
  throw Object.assign(new Error(message), { status, code, details });
}

const spine = { institutionCode: "ABC-CS", title: "Flood Risk Mapping of a River Basin", author: "Sample Author", month: 10, year: 2026 };
const form = (overrides = {}) => ({ cover: "first_page", spine: { ...spine }, ...overrides });

function reason(value, field) {
  return (error) => error.code === "invalid_cover_spine" && error.status === 400
    && error.details.field === field && Boolean(error.details.reason);
}

/** One hardbound listing and one flyer listing at the same shop. */
function store({ coverSpineRequired = false } = {}) {
  const client = { id: "user_client", role: "client", email: "client@gridgo.test" };
  const file = (fileId, ownerId = client.id) => ({
    fileId, ownerId, purpose: "artwork", detectedContentType: "application/pdf", artworkCheck: { status: "passed", checkedAt: AT },
    state: "ready", objectKey: `c/${fileId}.pdf`, references: [],
  });
  return {
    client,
    store: {
      settings: { ...defaultOperationalSettings(), hubPickupEnabled: true, coverSpineRequired },
      taxonomy: defaultTaxonomy(),
      users: [client, { id: "supplier_a", role: "supplier", email: "a@gridgo.test" }],
      userRoleMemberships: [{ userId: client.id, role: "client" }, { userId: "supplier_a", role: "supplier" }],
      clientPreferences: [], clientAddresses: [], carts: [], cartLines: [],
      supplierProfiles: [{ userId: "supplier_a", shopName: "Shop A", contactName: "A", shop: { lat: 7.064, lng: 125.6085, label: "Shop A" }, pickupAvailable: true }],
      approvalCases: [{ id: "case_a", userId: "supplier_a", kind: "supplier", status: "approved" }],
      supplierServices: [{
        id: "service_a", supplierId: "supplier_a", categoryCode: "document_publication", state: "live",
        pricingBasis: "per_unit", referenceRateMinor: 1_000, turnaroundHours: 12, standardTurnaroundHours: 12, version: 1,
      }],
      supplierServiceFileFormats: [{ supplierServiceId: "service_a", formatCode: "pdf" }],
      acceptedFileFormats: [{ code: "pdf", displayName: "PDF", inputKind: "file", active: true }],
      catalogItems: [
        {
          id: "thesis", supplierId: "supplier_a", supplierServiceId: "service_a", subcategoryCode: "binding_hardbound",
          name: "Thesis hardbound", description: "Hardbound", basePriceMinor: 35_000, pricingUnit: "per_unit",
          turnaroundMode: "inherit", fileFormatMode: "inherit", active: true, sortOrder: 0, version: 1,
        },
        {
          id: "copies", supplierId: "supplier_a", supplierServiceId: "service_a", subcategoryCode: "document_printing",
          name: "Copies", description: "Copies", basePriceMinor: 500, pricingUnit: "per_unit",
          turnaroundMode: "inherit", fileFormatMode: "inherit", active: true, sortOrder: 1, version: 1,
        },
      ],
      catalogItemFileFormats: [], catalogPrepSteps: [],
      catalogItemPhotos: [{ catalogItemId: "thesis", fileId: "photo_thesis", sortOrder: 0 }, { catalogItemId: "copies", fileId: "photo_copies", sortOrder: 0 }],
      catalogOptionGroups: [], catalogOptions: [],
      files: [
        file("manuscript"), file("cover_page"), file("someone_elses", "user_other"),
        { fileId: "photo_thesis", ownerId: "supplier_a", purpose: "catalog_item_photo", state: "ready", objectKey: "s/thesis.jpg" },
        { fileId: "photo_copies", ownerId: "supplier_a", purpose: "catalog_item_photo", state: "ready", objectKey: "s/copies.jpg" },
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

const pay = (reference) => ({ payment: { method: "qr_manual", proofFileId: "proof", reference } });
const roles = (client) => [client, { id: "supplier_a", role: "supplier" }, { id: "ops", role: "ops_admin" }, { id: "boss", role: "super_admin" }];

test("only the hardbound and binding product type asks for the form", () => {
  assert.deepEqual(COVER_SPINE_SUBCATEGORIES, ["binding_hardbound"]);
  assert.deepEqual(COVER_CHOICES, ["first_page", "separate_file", "text_only"]);
  assert.throws(() => parseCoverSpine({ subcategoryCode: "document_printing" }, form(), fail),
    (error) => error.code === "cover_spine_not_applicable" && error.status === 409);
  assert.equal(parseCoverSpine({ subcategoryCode: "document_printing" }, null, fail), null);
});

test("the form is normalised: trimmed one-line text, optional institution code", () => {
  assert.deepEqual(parseCoverSpine(HARDBOUND, form({ spine: { ...spine, title: "  Flood   Risk  ", institutionCode: "  " } }), fail), {
    cover: "first_page", coverFileId: null,
    spine: { institutionCode: null, title: "Flood Risk", author: "Sample Author", month: 10, year: 2026 },
  });
  const { institutionCode: _omit, ...withoutCode } = spine;
  assert.equal(parseCoverSpine(HARDBOUND, form({ cover: "text_only", spine: withoutCode }), fail).spine.institutionCode, null);
  assert.deepEqual(parseCoverSpine(HARDBOUND, form({ cover: "separate_file", coverFileId: " cover_page " }), fail).coverFileId, "cover_page");
  assert.equal(parseCoverSpine(HARDBOUND, null, fail), null);
  // Up to the limit counts characters, not bytes.
  assert.equal(parseCoverSpine(HARDBOUND, form({ spine: { ...spine, author: "Ñ".repeat(160) } }), fail).spine.author.length, 160);
});

test("the form refuses each invalid field with its own field and reason", () => {
  const cases = [
    [[], "coverSpine"],
    ["first_page", "coverSpine"],
    [form({ cover: "front" }), "coverSpine.cover"],
    [form({ cover: undefined }), "coverSpine.cover"],
    [form({ extra: true }), "coverSpine.extra"],
    [form({ cover: "separate_file" }), "coverSpine.coverFileId"],
    [form({ cover: "first_page", coverFileId: "cover_page" }), "coverSpine.coverFileId"],
    [form({ spine: undefined }), "coverSpine.spine"],
    [form({ spine: { ...spine, colour: "gold" } }), "coverSpine.spine.colour"],
    [form({ spine: { ...spine, title: "" } }), "coverSpine.spine.title"],
    [form({ spine: { ...spine, title: "T".repeat(201) } }), "coverSpine.spine.title"],
    [form({ spine: { ...spine, title: "Line one\nLine two" } }), "coverSpine.spine.title"],
    [form({ spine: { ...spine, title: 42 } }), "coverSpine.spine.title"],
    [form({ spine: { ...spine, author: null } }), "coverSpine.spine.author"],
    [form({ spine: { ...spine, author: "A".repeat(161) } }), "coverSpine.spine.author"],
    [form({ spine: { ...spine, institutionCode: "I".repeat(25) } }), "coverSpine.spine.institutionCode"],
    [form({ spine: { ...spine, institutionCode: "ABC\tCS" } }), "coverSpine.spine.institutionCode"],
    [form({ spine: { ...spine, month: 0 } }), "coverSpine.spine.month"],
    [form({ spine: { ...spine, month: 13 } }), "coverSpine.spine.month"],
    [form({ spine: { ...spine, month: "10" } }), "coverSpine.spine.month"],
    [form({ spine: { ...spine, month: undefined } }), "coverSpine.spine.month"],
    [form({ spine: { ...spine, year: 26 } }), "coverSpine.spine.year"],
    [form({ spine: { ...spine, year: 2026.5 } }), "coverSpine.spine.year"],
    [form({ spine: { ...spine, year: 2101 } }), "coverSpine.spine.year"],
  ];
  for (const [value, field] of cases) assert.throws(() => parseCoverSpine(HARDBOUND, value, fail), reason(value, field), field);
});

test("the spine summary reads in order and skips a missing institution code", () => {
  assert.equal(spineSummary(spine), "ABC-CS | Flood Risk Mapping of a River Basin | Sample Author | October 2026");
  assert.equal(spineSummary({ ...spine, institutionCode: null, month: 1 }), "Flood Risk Mapping of a River Basin | Sample Author | January 2026");
});

test("listing reads say which products carry the form", () => {
  const { store: fixture } = store();
  assert.equal(publicCatalogItem(fixture, fixture.catalogItems[0]).coverSpineForm, true);
  assert.equal(publicCatalogItem(fixture, fixture.catalogItems[1]).coverSpineForm, false);
  assert.equal(privateCatalogItem(fixture, fixture.catalogItems[0]).coverSpineForm, true);
});

test("cart, checkout and every order read carry the cover and spine the client gave", async () => {
  const { store: fixture, client } = store();
  const call = caller(fixture, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;

  await assert.rejects(call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "thesis", optionIds: [], quantity: 2, artworkFileId: "manuscript", coverSpine: form({ spine: { ...spine, year: 1800 } }),
  }), reason(null, "coverSpine.spine.year"));
  // A separate cover page must be one of the line's own artwork files.
  await assert.rejects(call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "thesis", optionIds: [], quantity: 2, artworkFileId: "manuscript",
    coverSpine: form({ cover: "separate_file", coverFileId: "cover_page" }),
  }), (error) => error.code === "cover_file_not_attached" && error.details.fileId === "cover_page");

  const added = await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "thesis", optionIds: [], quantity: 2,
    artworkAttachments: [{ kind: "file", fileId: "manuscript", label: "Manuscript" }, { kind: "file", fileId: "cover_page", label: "Cover" }],
    coverSpine: form({ cover: "separate_file", coverFileId: "cover_page" }),
  });
  assert.equal(added.status, 201);
  const line = added.body.cart.lines[0];
  assert.equal(line.listing.coverSpineForm, true);
  assert.equal(line.coverSpineRequired, false);
  assert.deepEqual(line.coverSpine, {
    status: "given", cover: "separate_file", coverFileId: "cover_page", spine,
    spineDate: "October 2026", spineSummary: "ABC-CS | Flood Risk Mapping of a River Basin | Sample Author | October 2026",
  });

  // Dropping the cover page from the artwork while it is the cover is refused.
  await assert.rejects(call("PATCH", `/me/carts/${cartId}/lines/${line.id}`, {
    artworkAttachments: [{ kind: "file", fileId: "manuscript" }],
  }), { code: "cover_file_not_attached" });
  assert.equal((await call("GET", `/me/carts/${cartId}`)).body.cart.lines[0].artworkAttachments.length, 2);

  // The client changes their mind: a plain cover, and a corrected author.
  const patched = await call("PATCH", `/me/carts/${cartId}/lines/${line.id}`, {
    coverSpine: form({ cover: "text_only", spine: { ...spine, author: "Sample Author and Second Author" } }),
  });
  assert.equal(patched.body.cart.lines[0].coverSpine.cover, "text_only");
  assert.equal(patched.body.cart.lines[0].coverSpine.coverFileId, null);

  const placed = await call("POST", `/me/carts/${cartId}/checkout`, pay("HARDBOUND"));
  assert.equal(placed.status, 201);
  const agreed = { version: 1, status: "given", cover: "text_only", coverFileId: null, spine: { ...spine, author: "Sample Author and Second Author" } };
  assert.deepEqual(fixture.orderLineItems[0].coverSpine, agreed);
  assert.equal(fixture.orderInvoices[0].snapshot.lines[0].coverSpine.cover, "text_only");

  const order = fixture.orders.find((row) => row.id === fixture.orderLineItems[0].orderId);
  order.fileCheck.status = "passed";
  for (const user of roles(client)) {
    const item = publicOrderFor(order, user, fixture).productionItems[0];
    assert.equal(item.coverSpine.status, "given", user.role);
    assert.equal(item.coverSpine.cover, "text_only", user.role);
    assert.equal(item.coverSpine.spineSummary, "ABC-CS | Flood Risk Mapping of a River Basin | Sample Author and Second Author | October 2026", user.role);
  }
  // Riders carry the parcel, not the spec.
  order.riderId = "rider_a";
  assert.equal(publicOrderFor(order, { id: "rider_a", role: "rider" }, fixture).productionItems[0]?.coverSpine ?? null, null);

  // Later edits elsewhere never rewrite what was agreed.
  fixture.catalogItems[0].subcategoryCode = "document_printing";
  assert.deepEqual(fixture.orderLineItems[0].coverSpine, agreed);
  assert.equal(publicOrderFor(order, client, fixture).productionItems[0].coverSpine.cover, "text_only");
});

test("while the switch is off, a hardbound line without the form checks out as not given", async () => {
  const { store: fixture, client } = store();
  const call = caller(fixture, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  // Exactly what a released build sends.
  const added = await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "thesis", optionIds: [], quantity: 1, artworkFileId: "manuscript" });
  assert.equal(added.body.cart.lines[0].coverSpine, null);
  assert.equal(added.body.cart.lines[0].coverSpineRequired, false);
  assert.equal((await call("POST", `/me/carts/${cartId}/checkout`, pay("RELEASED"))).status, 201);
  assert.deepEqual(fixture.orderLineItems[0].coverSpine, { version: 1, status: "not_given" });
  const order = fixture.orders[0];
  order.fileCheck.status = "passed";
  for (const user of roles(client)) {
    assert.deepEqual(publicOrderFor(order, user, fixture).productionItems[0].coverSpine, {
      status: "not_given", cover: null, coverFileId: null, spine: null, spineDate: null, spineSummary: null,
    }, user.role);
  }
});

test("with the switch on, checkout requires the form on hardbound lines only", async () => {
  const { store: fixture, client } = store({ coverSpineRequired: true });
  const call = caller(fixture, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  const thesis = (await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "thesis", optionIds: [], quantity: 1, artworkFileId: "manuscript" })).body.cart.lines[0];
  await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "copies", optionIds: [], quantity: 1, artworkFileId: "manuscript" });
  const cart = (await call("GET", `/me/carts/${cartId}`)).body.cart;
  assert.deepEqual(cart.lines.map((line) => line.coverSpineRequired), [true, false]);
  await assert.rejects(call("POST", `/me/carts/${cartId}/checkout`, pay("REQUIRED")),
    (error) => error.code === "cover_spine_required" && error.details.lineId === thesis.id && error.details.field === "coverSpine");
  await call("PATCH", `/me/carts/${cartId}/lines/${thesis.id}`, { coverSpine: form() });
  assert.equal((await call("POST", `/me/carts/${cartId}/checkout`, pay("REQUIRED"))).status, 201);
  const byItem = Object.fromEntries(fixture.orderLineItems.map((line) => [line.sourceCatalogItemId, line]));
  assert.equal(byItem.thesis.coverSpine.status, "given");
  assert.equal(Object.hasOwn(byItem.copies, "coverSpine"), false);
});

test("products without the form keep the released flow and refuse it", async () => {
  const { store: fixture, client } = store({ coverSpineRequired: true });
  const call = caller(fixture, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  await assert.rejects(call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "copies", optionIds: [], quantity: 1, artworkFileId: "manuscript", coverSpine: form(),
  }), { code: "cover_spine_not_applicable" });
  const added = await call("POST", `/me/carts/${cartId}/lines`, { catalogItemId: "copies", optionIds: [], quantity: 1, artworkFileId: "manuscript" });
  assert.equal(added.body.cart.lines[0].coverSpine, null);
  assert.equal(added.body.cart.lines[0].listing.coverSpineForm, false);
  assert.equal((await call("POST", `/me/carts/${cartId}/checkout`, pay("COPIES"))).status, 201);
  assert.equal(Object.hasOwn(fixture.orderLineItems[0], "coverSpine"), false);
  assert.equal(publicOrderFor(fixture.orders[0], client, fixture).productionItems[0].coverSpine, null);
});

test("a listing that stops being hardbound refuses a stale form at checkout until it is cleared", async () => {
  const { store: fixture, client } = store();
  const call = caller(fixture, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  const line = (await call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "thesis", optionIds: [], quantity: 1, artworkFileId: "manuscript", coverSpine: form(),
  })).body.cart.lines[0];
  fixture.catalogItems[0].subcategoryCode = "document_printing";
  await assert.rejects(call("POST", `/me/carts/${cartId}/checkout`, pay("MOVED")),
    (error) => error.code === "cover_spine_not_applicable" && error.details.lineId === line.id);
  await call("PATCH", `/me/carts/${cartId}/lines/${line.id}`, { coverSpine: null });
  assert.equal((await call("POST", `/me/carts/${cartId}/checkout`, pay("MOVED"))).status, 201);
});

test("the form follows the approved listing, not a pending product-type change", async () => {
  const { store: fixture, client } = store();
  const item = fixture.catalogItems[1];
  // The approved version is plain copies; the shop's pending draft moves it to hardbound.
  item.approvedSnapshot = { item: structuredClone(item), catalogOptionGroups: [], catalogOptions: [],
    catalogItemPhotos: structuredClone(fixture.catalogItemPhotos.filter((row) => row.catalogItemId === item.id)),
    catalogPriceTiers: [], catalogSpeedTiers: [], catalogItemFileFormats: [] };
  Object.assign(item, { reviewStatus: "pending", subcategoryCode: "binding_hardbound" });
  const call = caller(fixture, client);
  const cartId = (await call("POST", "/me/carts", { fulfillmentMode: "pickup" })).body.cart.id;
  await assert.rejects(call("POST", `/me/carts/${cartId}/lines`, {
    catalogItemId: "copies", optionIds: [], quantity: 1, artworkFileId: "manuscript", coverSpine: form(),
  }), { code: "cover_spine_not_applicable" });
});
