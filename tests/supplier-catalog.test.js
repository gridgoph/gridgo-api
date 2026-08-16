import test from "node:test";
import assert from "node:assert/strict";

import {
  appendOrderLineSnapshot,
  effectiveAcceptedFormats,
  publicCatalogItem,
  selectedCatalogPrice,
  supplierCatalogReadiness,
} from "../src/supplier-catalog.js";

const AT = "2026-08-16T00:00:00.000Z";

function fixture({ approvalStatus = "approved", fileFormatMode = "inherit" } = {}) {
  return {
    taxonomy: {
      categories: [{ code: "marketing_collateral", active: true, structuredFields: [{ code: "paper_size", values: ["A3", "A4"] }] }],
    },
    users: [{ id: "supplier" }],
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
    orderLineItems: [],
    orderLineItemOptions: [],
  };
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
  assert.deepEqual(item.acceptedFormats.map((format) => format.code), ["pdf"]);
  assert.equal(item.photos[0].url, "/catalog/media/photo");
  assert.deepEqual(supplierCatalogReadiness(approved, "supplier"), { readyForApproval: true, missing: [] });
});

test("order-line helper writes immutable catalog, option, format, price, and specification snapshots", () => {
  const store = fixture();
  let sequence = 0;
  const snapshot = appendOrderLineSnapshot(store, {
    orderId: "order",
    catalogItemId: "item",
    expectedVersion: 3,
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
