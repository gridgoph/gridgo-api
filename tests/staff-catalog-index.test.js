import test from "node:test";
import assert from "node:assert/strict";

import { routeSupplierCatalog } from "../src/catalog-routes.js";

const AT = "2026-10-02T00:00:00.000Z";

function store() {
  return {
    taxonomy: {
      subcategories: [{ code: "stickers", name: "Stickers", active: true, categoryCode: "labels" }],
    },
    users: [
      { id: "metre", role: "supplier" },
      { id: "other", role: "supplier" },
      { id: "quiet", role: "supplier" },
    ],
    userRoleMemberships: [
      { userId: "metre", role: "supplier" },
      { userId: "other", role: "supplier" },
      { userId: "quiet", role: "supplier" },
    ],
    approvalCases: [
      { id: "case_metre", userId: "metre", kind: "supplier", status: "approved" },
      { id: "case_other", userId: "other", kind: "supplier", status: "approved" },
      { id: "case_quiet", userId: "quiet", kind: "supplier", status: "pending" },
    ],
    supplierProfiles: [
      { userId: "metre", shopName: "Metre Press" },
      { userId: "other", shopName: "Other Press" },
      { userId: "quiet", shopName: "Quiet Shop" },
    ],
    supplierServices: [
      { id: "svc_metre", supplierId: "metre", categoryCode: "labels", state: "live", version: 1 },
      { id: "svc_other", supplierId: "other", categoryCode: "labels", state: "live", version: 1 },
      { id: "svc_quiet", supplierId: "quiet", categoryCode: "labels", state: "live", version: 1 },
    ],
    catalogItems: [
      {
        id: "sticker",
        supplierId: "metre",
        supplierServiceId: "svc_metre",
        subcategoryCode: "stickers",
        name: "Die-cut sticker",
        description: "Vinyl cut to length",
        basePriceMinor: 2500,
        pricingUnit: "per_length",
        measureUnit: "m",
        packageQty: null,
        turnaroundMode: "inherit",
        fileFormatMode: "inherit",
        active: true,
        sortOrder: 0,
        version: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: AT,
      },
      {
        id: "flyer",
        supplierId: "other",
        supplierServiceId: "svc_other",
        subcategoryCode: "flyers",
        name: "Flyer",
        description: "A5 colour",
        basePriceMinor: 10000,
        pricingUnit: "per_unit",
        packageQty: null,
        turnaroundMode: "inherit",
        fileFormatMode: "inherit",
        active: false,
        sortOrder: 0,
        version: 1,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "banner",
        supplierId: "quiet",
        supplierServiceId: "svc_quiet",
        subcategoryCode: "banners",
        name: "Banner",
        description: "Still in review as a shop",
        basePriceMinor: 50000,
        pricingUnit: "per_unit",
        packageQty: null,
        turnaroundMode: "inherit",
        fileFormatMode: "inherit",
        active: true,
        sortOrder: 0,
        version: 1,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    catalogOptionGroups: [
      {
        id: "finish",
        catalogItemId: "sticker",
        name: "Finish",
        kind: "spec",
        required: false,
        sortOrder: 0,
        version: 1,
      },
    ],
    catalogOptions: [
      {
        id: "gloss",
        optionGroupId: "finish",
        label: "Gloss",
        priceModifierMinor: 0,
        active: true,
        sortOrder: 0,
      },
    ],
    catalogItemPhotos: [
      { catalogItemId: "sticker", fileId: "photo_sticker", sortOrder: 0, altText: "Sticker roll", createdAt: AT },
    ],
  };
}

function user(role, id = role) {
  return role ? { id, role } : null;
}

async function call(actor, pathname, search = "") {
  const url = new URL(`http://gridgo.test${pathname}${search}`);
  try {
    return await routeSupplierCatalog({
      req: { method: pathname.endsWith("?method=post") ? "POST" : "GET", headers: {} },
      url,
      store: store(),
      user: actor,
      readBody: async () => ({}),
      id: () => "id",
      now: () => AT,
      audit: () => {},
    });
  } catch (error) {
    return { status: error.status, body: { error: error.code, message: error.message } };
  }
}

async function callMethod(actor, method, pathname) {
  const url = new URL(`http://gridgo.test${pathname}`);
  try {
    return await routeSupplierCatalog({
      req: { method, headers: {} },
      url,
      store: store(),
      user: actor,
      readBody: async () => ({}),
      id: () => "id",
      now: () => AT,
      audit: () => {},
    });
  } catch (error) {
    return { status: error.status, body: { error: error.code, message: error.message } };
  }
}

test("staff catalog index is limited to Operations and Super Admin", async () => {
  const anonymous = await call(null, "/ops/catalog-items");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error, "unauthorized");

  const supplier = await call(user("supplier", "metre"), "/ops/catalog-items");
  assert.equal(supplier.status, 403);
  assert.equal(supplier.body.error, "forbidden");

  const client = await call(user("client"), "/ops/catalog-items");
  assert.equal(client.status, 403);

  const ops = await call(user("ops_admin"), "/ops/catalog-items");
  assert.equal(ops.status, 200);
  assert.equal(ops.body.total, 3);

  const admin = await call(user("super_admin"), "/ops/catalog-items");
  assert.equal(admin.status, 200);
  assert.equal(admin.body.total, 3);
});

test("a sticker priced per metre carries its shop on the index and the detail", async () => {
  const index = await call(user("super_admin"), "/ops/catalog-items");
  const sticker = index.body.items.find((row) => row.item.id === "sticker");
  assert.equal(sticker.shop.shopName, "Metre Press");
  assert.equal(sticker.shop.supplierId, "metre");
  assert.equal(sticker.item.pricingUnit, "per_length");
  assert.equal(sticker.item.measureUnit, "m");
  assert.equal(sticker.item.basePriceMinor, 2500);
  assert.equal(sticker.item.active, true);
  assert.equal(sticker.item.optionGroups[0].name, "Finish");
  assert.equal(sticker.item.photos[0].fileId, "photo_sticker");
  assert.equal(sticker.item.updatedAt, AT);
  assert.equal("approvalStatus" in sticker.item, false);
  assert.equal(sticker.item.reviewStatus, "approved");
  assert.equal(sticker.item.hasApprovedVersion, true);
  assert.equal("suspensionReason" in sticker.item, false);

  const detail = await call(user("super_admin"), "/ops/catalog-items/sticker");
  assert.equal(detail.status, 200);
  assert.equal(detail.body.shop.shopName, "Metre Press");
  assert.equal(detail.body.item.id, "sticker");
  assert.equal(detail.body.item.pricingUnit, "per_length");
  assert.equal(detail.body.item.measureUnit, "m");
});

test("staff index lists every shop, including a hidden listing and a shop that is not approved", async () => {
  const index = await call(user("ops_admin"), "/ops/catalog-items");
  const names = index.body.items.map((row) => `${row.shop.shopName}:${row.item.id}:${row.item.active}`);
  assert.deepEqual(names, [
    "Metre Press:sticker:true",
    "Other Press:flyer:false",
    "Quiet Shop:banner:true",
  ]);
  assert.deepEqual(
    index.body.shops.map((shop) => shop.shopName),
    ["Metre Press", "Other Press", "Quiet Shop"],
  );
});

test("staff index filters by product type, shop, price, and search", async () => {
  const actor = user("super_admin");
  const byType = await call(actor, "/ops/catalog-items", "?subcategoryCode=stickers");
  assert.deepEqual(byType.body.items.map((row) => row.item.id), ["sticker"]);

  const byShop = await call(actor, "/ops/catalog-items", "?supplierId=other");
  assert.deepEqual(byShop.body.items.map((row) => row.item.id), ["flyer"]);
  assert.equal(byShop.body.items[0].shop.shopName, "Other Press");

  const byPrice = await call(actor, "/ops/catalog-items", "?minPriceMinor=2000&maxPriceMinor=3000");
  assert.deepEqual(byPrice.body.items.map((row) => row.item.id), ["sticker"]);

  const bySearch = await call(actor, "/ops/catalog-items", "?q=Metre%20Press");
  assert.deepEqual(bySearch.body.items.map((row) => row.item.id), ["sticker"]);

  const empty = await call(actor, "/ops/catalog-items", "?minPriceMinor=1&maxPriceMinor=10");
  assert.equal(empty.body.total, 0);
  assert.equal(empty.body.shops.length, 3);
});

test("staff catalog reads reject a reversed price range and do not take a listing down", async () => {
  const reversed = await call(user("super_admin"), "/ops/catalog-items", "?minPriceMinor=50&maxPriceMinor=10");
  assert.equal(reversed.status, 400);
  assert.equal(reversed.body.error, "invalid_catalog_query");

  const missing = await call(user("super_admin"), "/ops/catalog-items/missing");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "catalog_item_not_found");

  const post = await callMethod(user("super_admin"), "POST", "/ops/catalog-items/sticker");
  assert.equal(post.status, 405);
  assert.equal(post.body.error, "method_not_allowed");

  const supplierPost = await callMethod(user("supplier", "metre"), "POST", "/ops/catalog-items/sticker");
  assert.equal(supplierPost.status, 403);
});
