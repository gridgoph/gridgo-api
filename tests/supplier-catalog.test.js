import test from "node:test";
import assert from "node:assert/strict";

import {
  appendOrderLineSnapshot,
  effectiveAcceptedFormats,
  publicCatalogItem,
  publicSupplierShop,
  publicSupplierShops,
  selectedCatalogPrice,
  supplierCatalogReadiness,
} from "../src/supplier-catalog.js";

const AT = "2026-08-16T00:00:00.000Z";

function fixture({ approvalStatus = "approved", fileFormatMode = "inherit" } = {}) {
  return {
    taxonomy: {
      categories: [{ code: "marketing_collateral", active: true, structuredFields: [{ code: "paper_size", values: ["A3", "A4"] }] }],
    },
    users: [{ id: "supplier", role: "supplier" }],
    userRoleMemberships: [{ userId: "supplier", role: "supplier" }],
    supplierProfiles: [{
      userId: "supplier", shopName: "Print Shop", contactName: "Supplier",
      shop: { lat: 7.1, lng: 125.6, label: "Davao" }, pickupAvailable: false,
    }],
    supplierPaymentTerms: [{ supplierId: "supplier", pickupFullOnlineEnabled: true, pickupDownpaymentStoreEnabled: false }],
    approvalCases: [{ userId: "supplier", kind: "supplier", status: approvalStatus }],
    acceptedFileFormats: [
      { code: "pdf", displayName: "PDF", inputKind: "file", active: true },
      { code: "png", displayName: "PNG", inputKind: "file", active: true },
      { code: "retired", displayName: "Retired", inputKind: "file", active: false },
    ],
    supplierServices: [{
      id: "service", supplierId: "supplier", categoryCode: "marketing_collateral",
      state: "live", pricingBasis: "per_unit", standardTurnaroundHours: 24,
      rushEnabled: false, version: 1,
    }],
    supplierServiceFileFormats: [
      { supplierServiceId: "service", formatCode: "pdf" },
      { supplierServiceId: "service", formatCode: "retired" },
    ],
    catalogItems: [{
      id: "item", supplierId: "supplier", supplierServiceId: "service",
      name: "Poster", description: "Photo poster", basePriceMinor: 100,
      fileFormatMode, active: true, sortOrder: 0, version: 3, createdAt: AT, updatedAt: AT,
    }],
    catalogItemFileFormats: fileFormatMode === "override"
      ? [{ catalogItemId: "item", formatCode: "png" }]
      : [],
    files: [{
      fileId: "photo", ownerId: "supplier", purpose: "catalog_item_photo",
      detectedContentType: "image/jpeg", size: 10, state: "ready",
      objectKey: "catalog/photo.jpg", createdAt: AT,
    }, {
      fileId: "logo", ownerId: "supplier", purpose: "supplier_shop_image",
      detectedContentType: "image/png", size: 10, state: "ready",
      objectKey: "catalog/logo.png", createdAt: AT,
    }],
    catalogItemPhotos: [{ catalogItemId: "item", fileId: "photo", sortOrder: 0, createdAt: AT }],
    supplierShopMedia: [{ supplierId: "supplier", slot: "logo", fileId: "logo", updatedAt: AT }],
    catalogOptionGroups: [
      { id: "size", catalogItemId: "item", name: "Size", required: true, sortOrder: 0, version: 1 },
      { id: "finish", catalogItemId: "item", name: "Finish", required: false, sortOrder: 1, version: 1 },
    ],
    catalogOptions: [
      { id: "a3", optionGroupId: "size", label: "A3", priceModifierMinor: -150, specBinding: { fieldCode: "paper_size", valueCode: "A3" }, active: true, sortOrder: 0 },
      { id: "a4", optionGroupId: "size", label: "A4", priceModifierMinor: 25, specBinding: { fieldCode: "paper_size", valueCode: "A4" }, active: true, sortOrder: 1 },
      { id: "gloss", optionGroupId: "finish", label: "Gloss", priceModifierMinor: 20, active: true, sortOrder: 0 },
    ],
    orders: [{ id: "order", supplierId: "supplier" }],
    orderLineItems: [],
    orderLineItemOptions: [],
  };
}

function supplierFixture(supplierId) {
  const store = fixture();
  const suffix = supplierId.replace(/^supplier_?/, "") || supplierId;
  const serviceId = `service_${suffix}`;
  const itemId = `item_${suffix}`;
  const photoId = `photo_${suffix}`;
  const logoId = `logo_${suffix}`;
  const groupIds = new Map(store.catalogOptionGroups.map((group) => [group.id, `${group.id}_${suffix}`]));
  store.users[0].id = supplierId;
  store.userRoleMemberships[0].userId = supplierId;
  store.supplierProfiles[0].userId = supplierId;
  store.supplierProfiles[0].shopName = `Shop ${suffix}`;
  store.supplierPaymentTerms[0].supplierId = supplierId;
  store.approvalCases[0].userId = supplierId;
  Object.assign(store.supplierServices[0], { id: serviceId, supplierId });
  store.supplierServiceFileFormats.forEach((format) => { format.supplierServiceId = serviceId; });
  Object.assign(store.catalogItems[0], { id: itemId, supplierId, supplierServiceId: serviceId });
  store.catalogItemFileFormats.forEach((format) => { format.catalogItemId = itemId; });
  Object.assign(store.files[0], { fileId: photoId, ownerId: supplierId });
  Object.assign(store.files[1], { fileId: logoId, ownerId: supplierId });
  Object.assign(store.catalogItemPhotos[0], { catalogItemId: itemId, fileId: photoId });
  Object.assign(store.supplierShopMedia[0], { supplierId, fileId: logoId });
  store.catalogOptionGroups.forEach((group) => {
    group.id = groupIds.get(group.id);
    group.catalogItemId = itemId;
  });
  store.catalogOptions.forEach((option) => {
    option.id = `${option.id}_${suffix}`;
    option.optionGroupId = groupIds.get(option.optionGroupId);
  });
  Object.assign(store.orders[0], { id: `order_${suffix}`, supplierId });
  return store;
}

function mergeSupplierFixtures(...stores) {
  const merged = structuredClone(stores[0]);
  for (const key of Object.keys(merged)) {
    if (Array.isArray(merged[key]) && !["acceptedFileFormats"].includes(key)) merged[key] = [];
  }
  for (const store of stores) {
    for (const [key, value] of Object.entries(store)) {
      if (Array.isArray(value) && key !== "acceptedFileFormats") merged[key].push(...value);
    }
  }
  return merged;
}

test("effective accepted formats inherit service defaults and honor item overrides", () => {
  const inherited = fixture();
  assert.deepEqual(effectiveAcceptedFormats(inherited, inherited.catalogItems[0]).map((format) => format.code), ["pdf"]);

  const overridden = fixture({ fileFormatMode: "override" });
  assert.deepEqual(effectiveAcceptedFormats(overridden, overridden.catalogItems[0]).map((format) => format.code), ["png"]);
});

test("single-select modifiers use integer arithmetic and floor effective price at zero", () => {
  const store = fixture();
  assert.deepEqual(selectedCatalogPrice(store, store.catalogItems[0], ["a3", "gloss"]), {
    effectiveUnitPriceMinor: 0,
    selectedOptions: [store.catalogOptions[0], store.catalogOptions[2]],
  });
  assert.equal(selectedCatalogPrice(store, store.catalogItems[0], ["a4"]).effectiveUnitPriceMinor, 125);
  assert.throws(
    () => selectedCatalogPrice(store, store.catalogItems[0], []),
    (error) => error.code === "invalid_catalog_options" && error.details.fields.size === "choose_exactly_one",
  );
});

test("pending suppliers stay private while approved complete catalog items publish", () => {
  const pending = fixture({ approvalStatus: "pending" });
  assert.equal(publicCatalogItem(pending, pending.catalogItems[0]), null);

  const approved = fixture();
  const item = publicCatalogItem(approved, approved.catalogItems[0], { selectedOptionIds: ["a4"] });
  assert.equal(item.effectivePriceMinor, 125);
  assert.equal(item.serviceVersion, 1);
  assert.deepEqual(item.acceptedFormats.map((format) => format.code), ["pdf"]);
  assert.equal(item.photos[0].url, "/catalog/media/photo");
  assert.deepEqual(supplierCatalogReadiness(approved, "supplier"), { readyForApproval: true, missing: [] });
});

test("public catalog and checkout require a current supplier membership", () => {
  const store = fixture();
  store.userRoleMemberships.length = 0;

  assert.equal(publicCatalogItem(store, store.catalogItems[0]), null);
  assert.equal(publicSupplierShop(store, "supplier"), null);
  assert.deepEqual(publicSupplierShops(store).shops, []);
  assert.throws(
    () => appendOrderLineSnapshot(store, {
      orderId: "order",
      catalogItemId: "item",
      expectedVersion: 3,
      expectedServiceVersion: 1,
      optionIds: ["a4"],
      acceptedFormatCode: "pdf",
      quantity: 1,
      structuredSpec: { paper_size: "A4" },
    }),
    (error) => error.status === 409 && error.code === "catalog_item_stale",
  );
  assert.deepEqual(store.orderLineItems, []);
  assert.deepEqual(store.orderLineItemOptions, []);
});

test("public catalog and checkout require an active canonical service category", () => {
  const store = fixture();
  store.taxonomy.categories[0].active = false;

  assert.equal(publicCatalogItem(store, store.catalogItems[0]), null);
  assert.equal(publicSupplierShop(store, "supplier"), null);
  assert.deepEqual(publicSupplierShops(store).shops, []);
  assert.throws(
    () => appendOrderLineSnapshot(store, {
      orderId: "order",
      catalogItemId: "item",
      expectedVersion: 3,
      expectedServiceVersion: 1,
      optionIds: ["a4"],
      acceptedFormatCode: "pdf",
      quantity: 1,
      structuredSpec: { paper_size: "A4" },
    }),
    (error) => error.status === 409 && error.code === "catalog_item_stale",
  );
  assert.equal(store.supplierServices[0].categoryCode, "marketing_collateral");
  assert.deepEqual(store.orderLineItems, []);
  assert.deepEqual(store.orderLineItemOptions, []);
});

test("shop pagination resumes after a removed cursor without reprojecting off-page items", () => {
  const supplierA = supplierFixture("supplier_a");
  const supplierB = supplierFixture("supplier_b");
  const supplierC = supplierFixture("supplier_c");
  const store = mergeSupplierFixtures(supplierA, supplierB, supplierC);
  const first = publicSupplierShops(store, { limit: 2 });
  assert.deepEqual(first.shops.map((shop) => shop.supplierId), ["supplier_a", "supplier_b"]);
  assert.equal(first.nextCursor, "supplier_b");

  store.userRoleMemberships = store.userRoleMemberships.filter((membership) => membership.userId !== "supplier_b");
  const second = publicSupplierShops(store, { cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second.shops.map((shop) => shop.supplierId), ["supplier_c"]);

  const bounded = mergeSupplierFixtures(supplierFixture("supplier_a"), supplierFixture("supplier_b"));
  Object.defineProperty(bounded.catalogItems.find((item) => item.supplierId === "supplier_b"), "description", {
    get() { throw new Error("off-page item was fully projected"); },
  });
  assert.deepEqual(publicSupplierShops(bounded, { limit: 1 }).shops.map((shop) => shop.supplierId), ["supplier_a"]);
});

test("approved suppliers remain grandfathered ready until approval is reopened", () => {
  const approved = fixture();
  approved.supplierProfiles.length = 0;
  approved.supplierServiceFileFormats.length = 0;
  approved.catalogItems.length = 0;
  approved.supplierShopMedia.length = 0;
  assert.deepEqual(supplierCatalogReadiness(approved, "supplier"), { readyForApproval: true, missing: [] });

  approved.approvalCases[0].status = "suspended";
  const reopened = supplierCatalogReadiness(approved, "supplier");
  assert.equal(reopened.readyForApproval, false);
  assert.ok(reopened.missing.includes("supplier_profile"));
  assert.ok(reopened.missing.includes("review_ready_service"));
});

test("order-line helper writes immutable catalog, option, format, price, and specification snapshots", () => {
  const store = fixture();
  let sequence = 0;
  const snapshot = appendOrderLineSnapshot(store, {
    orderId: "order",
    catalogItemId: "item",
    expectedVersion: 3,
    expectedServiceVersion: 1,
    optionIds: ["a4", "gloss"],
    acceptedFormatCode: "pdf",
    quantity: 2,
    structuredSpec: { paper_size: "A4", quantity: 2 },
    createdAt: AT,
  }, (prefix) => `${prefix}_${++sequence}`);

  assert.equal(snapshot.lineItem.effectiveUnitPriceMinor, 145);
  assert.equal(snapshot.lineItem.lineSubtotalMinor, 290);
  assert.deepEqual(snapshot.lineItem.acceptedFormatCodesSnapshot, ["pdf"]);
  assert.deepEqual(snapshot.options.map((option) => option.optionLabelSnapshot), ["A4", "Gloss"]);

  store.catalogItems[0].name = "Renamed later";
  store.catalogOptions.find((option) => option.id === "a4").priceModifierMinor = 999;
  store.supplierServiceFileFormats.length = 0;
  assert.equal(store.orderLineItems[0].itemNameSnapshot, "Poster");
  assert.equal(store.orderLineItems[0].effectiveUnitPriceMinor, 145);
  assert.deepEqual(store.orderLineItems[0].acceptedFormatCodesSnapshot, ["pdf"]);
});

test("order-line helper requires the selected catalog and service versions", () => {
  const store = fixture();
  assert.throws(
    () => appendOrderLineSnapshot(store, {
      orderId: "order",
      catalogItemId: "item",
      optionIds: ["a4"],
      acceptedFormatCode: "pdf",
      quantity: 1,
      structuredSpec: { paper_size: "A4" },
    }),
    (error) => error.status === 400 && error.code === "expected_version_required",
  );
  assert.deepEqual(store.orderLineItems, []);

  assert.throws(
    () => appendOrderLineSnapshot(store, {
      orderId: "order",
      catalogItemId: "item",
      expectedVersion: 3,
      optionIds: ["a4"],
      acceptedFormatCode: "pdf",
      quantity: 1,
      structuredSpec: { paper_size: "A4" },
    }),
    (error) => error.status === 400 && error.code === "expected_service_version_required",
  );
  assert.deepEqual(store.orderLineItems, []);
});

test("order-line helper rejects a missing order before appending snapshots", () => {
  const store = fixture();
  assert.throws(
    () => appendOrderLineSnapshot(store, {
      orderId: "missing_order",
      catalogItemId: "item",
      expectedVersion: 3,
      expectedServiceVersion: 1,
      optionIds: ["a4"],
      acceptedFormatCode: "pdf",
      quantity: 1,
      structuredSpec: { paper_size: "A4" },
    }),
    (error) => error.status === 404 && error.code === "order_not_found",
  );
  assert.deepEqual(store.orderLineItems, []);
  assert.deepEqual(store.orderLineItemOptions, []);
});

test("order-line helper rejects a stale service-derived projection", () => {
  const store = fixture();
  const selected = publicCatalogItem(store, store.catalogItems[0], { selectedOptionIds: ["a4"] });
  store.supplierServices[0].pricingBasis = "per_piece";
  store.supplierServices[0].version = 2;

  assert.throws(
    () => appendOrderLineSnapshot(store, {
      orderId: "order",
      catalogItemId: "item",
      expectedVersion: selected.version,
      expectedServiceVersion: selected.serviceVersion,
      optionIds: ["a4"],
      acceptedFormatCode: "pdf",
      quantity: 1,
      structuredSpec: { paper_size: "A4" },
    }),
    (error) => error.status === 409
      && error.code === "supplier_service_stale"
      && error.details.currentVersion === 2,
  );
  assert.deepEqual(store.orderLineItems, []);
});

test("order-line helper rejects values outside PostgreSQL integer columns", () => {
  const store = fixture();
  const selection = {
    orderId: "order",
    catalogItemId: "item",
    expectedVersion: 3,
    expectedServiceVersion: 1,
    optionIds: ["a4"],
    acceptedFormatCode: "pdf",
    quantity: 1,
    structuredSpec: { paper_size: "A4" },
  };

  assert.throws(
    () => appendOrderLineSnapshot(store, { ...selection, quantity: 3000000000 }),
    (error) => error.status === 400
      && error.code === "invalid_catalog_item"
      && error.details.field === "quantity",
  );
  assert.throws(
    () => appendOrderLineSnapshot(store, { ...selection, sortOrder: 3000000000 }),
    (error) => error.status === 400
      && error.code === "invalid_catalog_item"
      && error.details.field === "sortOrder",
  );
  assert.deepEqual(store.orderLineItems, []);
  assert.deepEqual(store.orderLineItemOptions, []);
});
