import test from "node:test";
import assert from "node:assert/strict";

import {
  appendOrderLineSnapshot,
  assertSupplierServiceLifecycleMutationAllowed,
  assertSupplierServicePendingVerification,
  createOrderLineSnapshot,
  effectiveAcceptedFormats,
  publicCatalogItem,
  publicSupplierShop,
  publicSupplierShops,
  selectedCatalogPrice,
  supplierCatalogPublicationReadiness,
  supplierCatalogReadiness,
  transitionSupplierServiceToDraft,
} from "../src/supplier-catalog.js";

const AT = "2026-08-16T00:00:00.000Z";

function fixture({ approvalStatus = "approved", fileFormatMode = "inherit" } = {}) {
  return {
    taxonomy: {
      categories: [{
        code: "marketing_collateral", active: true, productFamilyIds: ["banner"],
        structuredFields: [{ code: "paper_size", values: ["A3", "A4"] }],
      }],
      materials: [{
        code: "tarpaulin_13oz", name: "13oz tarpaulin",
        categoryCodes: ["marketing_collateral"], active: true,
      }],
      finishes: [{ code: "none", name: "None", categoryCodes: ["marketing_collateral"], active: true }],
    },
    zones: [{ code: "davao_central", active: true }],
    users: [{ id: "supplier", role: "supplier" }],
    userRoleMemberships: [{ userId: "supplier", role: "supplier" }],
    supplierProfiles: [{
      userId: "supplier", shopName: "Print Shop", contactName: "Supplier",
      shop: { lat: 7.1, lng: 125.6, label: "Davao" }, pickupAvailable: false,
    }],
    supplierPaymentTerms: [{ supplierId: "supplier", pickupFullOnlineEnabled: true, pickupDownpaymentStoreEnabled: false }],
    approvalCases: [{ id: "case_supplier", userId: "supplier", kind: "supplier", status: approvalStatus }],
    acceptedFileFormats: [
      { code: "pdf", displayName: "PDF", inputKind: "file", active: true },
      { code: "png", displayName: "PNG", inputKind: "file", active: true },
      { code: "retired", displayName: "Retired", inputKind: "file", active: false },
    ],
    supplierServices: [{
      id: "service", supplierId: "supplier", categoryCode: "marketing_collateral",
      state: "live", pricingBasis: "per_unit", standardTurnaroundHours: 24,
      materialCodes: ["tarpaulin_13oz"], finishCodes: ["none"],
      productFamilyIds: ["banner"], zones: ["davao_central"],
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
  assert.deepEqual(supplierCatalogReadiness(approved, "supplier"), {
    readyForApproval: true,
    missing: [],
    publishableServiceIds: [],
  });
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

test("shop detail indexes unrelated catalog items once", () => {
  const store = fixture();
  store.supplierServices.push({
    ...store.supplierServices[0],
    id: "service_without_items",
    sortOrder: 1,
  });
  store.supplierServiceFileFormats.push({ supplierServiceId: "service_without_items", formatCode: "pdf" });
  let serviceReads = 0;
  const unrelatedItem = {
    id: "unrelated_item",
    supplierId: "other_supplier",
  };
  Object.defineProperty(unrelatedItem, "supplierServiceId", {
    enumerable: true,
    get() {
      serviceReads += 1;
      return "unrelated_service";
    },
  });
  store.catalogItems.push(unrelatedItem);

  const shop = publicSupplierShop(store, "supplier");
  assert.equal(shop.services.length, 1);
  assert.equal(shop.services[0].id, "service");
  assert.equal(serviceReads, 1);
});

test("approved suppliers remain grandfathered ready until approval is reopened", () => {
  const approved = fixture();
  approved.supplierProfiles.length = 0;
  approved.supplierServiceFileFormats.length = 0;
  approved.catalogItems.length = 0;
  approved.supplierShopMedia.length = 0;
  assert.deepEqual(supplierCatalogReadiness(approved, "supplier"), {
    readyForApproval: true,
    missing: [],
    publishableServiceIds: [],
  });

  approved.approvalCases[0].status = "suspended";
  const reopened = supplierCatalogReadiness(approved, "supplier");
  assert.equal(reopened.readyForApproval, false);
  assert.ok(reopened.missing.includes("supplier_profile"));
  assert.ok(reopened.missing.includes("review_ready_service"));
});

test("account suspension retains approver ownership of service lifecycle", () => {
  const store = fixture({ approvalStatus: "suspended" });
  const service = store.supplierServices[0];
  service.state = "suspended";
  service.approvalSuspensionCaseId = "case_supplier";
  assert.throws(
    () => assertSupplierServiceLifecycleMutationAllowed(store, service),
    (error) => error.status === 409
      && error.code === "service_account_suspended"
      && error.details.approvalCaseId === "case_supplier",
  );

  delete service.approvalSuspensionCaseId;
  assert.throws(
    () => assertSupplierServiceLifecycleMutationAllowed(store, service),
    (error) => error.status === 409 && error.code === "service_account_suspended",
  );
  store.approvalCases[0].status = "approved";
  assert.doesNotThrow(() => assertSupplierServiceLifecycleMutationAllowed(store, service));
});

test("catalog readiness exposes only complete eligible service lines", () => {
  const pending = fixture({ approvalStatus: "pending" });
  pending.supplierServices[0].state = "pending_verification";
  pending.supplierServices.push(
    { ...pending.supplierServices[0], id: "service_live", state: "live" },
    { ...pending.supplierServices[0], id: "service_draft", state: "draft" },
    { ...pending.supplierServices[0], id: "service_incomplete", pricingBasis: "" },
  );
  pending.supplierServiceFileFormats.push(
    { supplierServiceId: "service_live", formatCode: "pdf" },
    { supplierServiceId: "service_draft", formatCode: "pdf" },
    { supplierServiceId: "service_incomplete", formatCode: "pdf" },
  );
  pending.catalogItems.push(
    { ...pending.catalogItems[0], id: "item_live", supplierServiceId: "service_live" },
    { ...pending.catalogItems[0], id: "item_draft", supplierServiceId: "service_draft" },
    { ...pending.catalogItems[0], id: "item_incomplete", supplierServiceId: "service_incomplete" },
  );
  assert.deepEqual(supplierCatalogReadiness(pending, "supplier"), {
    readyForApproval: true,
    missing: [],
    publishableServiceIds: ["service"],
  });

  pending.approvalCases[0].status = "approved";
  assert.deepEqual(supplierCatalogPublicationReadiness(pending, "supplier"), {
    readyForApproval: true,
    missing: [],
    publishableServiceIds: ["service"],
  });
  pending.approvalCases[0].status = "pending";

  pending.catalogItemPhotos.length = 0;
  const incomplete = supplierCatalogReadiness(pending, "supplier");
  assert.equal(incomplete.readyForApproval, false);
  assert.deepEqual(incomplete.publishableServiceIds, []);
  assert.ok(incomplete.missing.includes("active_catalog_item"));

  const restoring = fixture({ approvalStatus: "suspended" });
  restoring.supplierServices[0].state = "suspended";
  restoring.supplierServices[0].approvalSuspensionCaseId = "case_supplier";
  assert.deepEqual(supplierCatalogReadiness(restoring, "supplier"), {
    readyForApproval: true,
    missing: [],
    publishableServiceIds: ["service"],
  });

  delete restoring.supplierServices[0].approvalSuspensionCaseId;
  const independentlySuspended = supplierCatalogReadiness(restoring, "supplier");
  assert.equal(independentlySuspended.readyForApproval, false);
  assert.deepEqual(independentlySuspended.publishableServiceIds, []);

  const pendingRestore = { ...restoring.supplierServices[0], id: "service_pending", state: "pending_verification" };
  restoring.supplierServices.push(pendingRestore);
  restoring.supplierServiceFileFormats.push({ supplierServiceId: "service_pending", formatCode: "pdf" });
  restoring.catalogItems.push({
    ...restoring.catalogItems[0],
    id: "item_pending",
    supplierServiceId: "service_pending",
  });
  restoring.catalogItemPhotos.push({
    ...restoring.catalogItemPhotos[0],
    catalogItemId: "item_pending",
  });
  assert.deepEqual(supplierCatalogReadiness(restoring, "supplier"), {
    readyForApproval: true,
    missing: [],
    publishableServiceIds: ["service_pending"],
  });
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
  assert.equal(snapshot.lineItem.snapshotFinalized, true);
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

test("order-line helper rejects malformed selection records with domain errors", () => {
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
    () => createOrderLineSnapshot(store, null),
    (error) => error.status === 400 && error.code === "invalid_catalog_item" && error.details.field === "selection",
  );
  assert.throws(
    () => appendOrderLineSnapshot(store, { ...selection, optionIds: "a4" }),
    (error) => error.status === 400 && error.code === "invalid_catalog_options" && error.details.field === "optionIds",
  );
  assert.throws(
    () => createOrderLineSnapshot(store, { ...selection, optionIds: [null] }, () => "generated"),
    (error) => error.status === 400
      && error.code === "invalid_catalog_options"
      && error.details.fields[0] === "invalid_option_id",
  );
  assert.throws(
    () => createOrderLineSnapshot(store, selection),
    (error) => error.status === 400 && error.code === "invalid_catalog_item" && error.details.field === "lineItemId",
  );
  assert.deepEqual(store.orderLineItems, []);
  assert.deepEqual(store.orderLineItemOptions, []);
});

test("draft transition clears incompatible lifecycle metadata", () => {
  const service = {
    state: "withdrawn",
    verifiedAt: AT,
    verifiedBy: "ops",
    suspendedAt: AT,
    suspendedBy: "ops",
    suspendReason: "Review",
    withdrawnAt: AT,
  };

  transitionSupplierServiceToDraft(service);
  assert.deepEqual(service, {
    state: "draft",
    verifiedAt: null,
    verifiedBy: null,
    suspendedAt: null,
    suspendedBy: null,
    suspendReason: null,
    withdrawnAt: null,
  });
});

test("service verification requires the pending verification state", () => {
  for (const state of ["draft", "suspended", "withdrawn", "live"]) {
    assert.throws(
      () => assertSupplierServicePendingVerification({ state }),
      (error) => error.status === 409
        && error.code === "invalid_service_state"
        && error.details.currentState === state
        && error.details.requiredState === "pending_verification",
    );
  }

  assert.doesNotThrow(() => assertSupplierServicePendingVerification({ state: "pending_verification" }));
});

test("order-line helper assigns append positions and rejects occupied positions", () => {
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

  const first = appendOrderLineSnapshot(store, { ...selection, lineItemId: "line_one" });
  const second = appendOrderLineSnapshot(store, { ...selection, lineItemId: "line_two" });
  assert.equal(first.lineItem.sortOrder, 0);
  assert.equal(second.lineItem.sortOrder, 1);

  assert.throws(
    () => appendOrderLineSnapshot(store, { ...selection, lineItemId: "line_three", sortOrder: 1 }),
    (error) => error.status === 409
      && error.code === "order_line_position_conflict"
      && error.details.sortOrder === 1,
  );
  assert.deepEqual(store.orderLineItems.map((line) => line.id), ["line_one", "line_two"]);
  assert.equal(store.orderLineItemOptions.length, 2);

  assert.throws(
    () => appendOrderLineSnapshot(store, { ...selection, lineItemId: "line_one", sortOrder: 2 }),
    (error) => error.status === 409
      && error.code === "order_line_id_conflict"
      && error.details.lineItemId === "line_one",
  );
  assert.deepEqual(store.orderLineItems.map((line) => line.id), ["line_one", "line_two"]);
  assert.equal(store.orderLineItemOptions.length, 2);
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

test("public catalog and checkout reject bindings from a previous service category", () => {
  const store = fixture();
  store.taxonomy.categories.push({
    code: "packaging",
    active: true,
    structuredFields: [{ code: "box_size", values: ["small", "large"] }],
  });
  store.supplierServices[0].categoryCode = "packaging";
  store.supplierServices[0].version = 2;

  assert.equal(publicCatalogItem(store, store.catalogItems[0]), null);
  assert.throws(
    () => appendOrderLineSnapshot(store, {
      orderId: "order",
      catalogItemId: "item",
      expectedVersion: 3,
      expectedServiceVersion: 2,
      optionIds: ["a4"],
      acceptedFormatCode: "pdf",
      quantity: 1,
      structuredSpec: { box_size: "small" },
    }),
    (error) => error.status === 409 && error.code === "catalog_item_stale",
  );
  assert.deepEqual(store.orderLineItems, []);
  assert.deepEqual(store.orderLineItemOptions, []);
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
