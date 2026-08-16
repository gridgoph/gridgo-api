const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_MINOR = -MAX_SAFE_MINOR;

function compareSortOrder(left, right) {
  return (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.id.localeCompare(right.id);
}

function checkedMinor(value, field) {
  if (!Number.isSafeInteger(value)) {
    throw new CatalogError(400, "invalid_catalog_item", `${field} must be a JavaScript safe integer in minor units.`, { field });
  }
  return BigInt(value);
}

function checkedNumber(value, field) {
  if (value < MIN_SAFE_MINOR || value > MAX_SAFE_MINOR) {
    throw new CatalogError(400, "invalid_catalog_item", `${field} exceeds the supported minor-unit range.`, { field });
  }
  return Number(value);
}

function formatCode(record) {
  return typeof record === "string" ? record : record.formatCode;
}

function itemFormatCodes(store, itemId) {
  return (store.catalogItemFileFormats || [])
    .filter((record) => record.catalogItemId === itemId)
    .map(formatCode);
}

function serviceFormatCodes(store, serviceId) {
  return (store.supplierServiceFileFormats || [])
    .filter((record) => record.supplierServiceId === serviceId)
    .map(formatCode);
}

function activeFormatRegistry(store) {
  return new Map((store.acceptedFileFormats || [])
    .filter((format) => format.active !== false)
    .map((format) => [format.code, format]));
}

function approvalStatus(store, supplierId) {
  return (store.approvalCases || []).find(
    (approvalCase) => approvalCase.userId === supplierId && approvalCase.kind === "supplier",
  )?.status || null;
}

function canonicalCategoryCode(store, code) {
  const direct = (store.taxonomy?.categories || []).find((category) => category.code === code);
  if (direct) return direct.code;
  const alias = (store.taxonomy?.categoryAliases || []).find(
    (candidate) => candidate.active !== false && candidate.code === code,
  );
  return alias?.categoryCode || code;
}

function readyFile(store, fileId) {
  return (store.files || []).find(
    (file) => file.fileId === fileId && file.state === "ready" && file.objectKey,
  ) || null;
}

function mediaProjection(file, extra = {}) {
  return {
    fileId: file.fileId,
    contentType: file.detectedContentType || file.declaredContentType,
    size: file.size,
    // Task F authorizes and serves this opaque public-media route. Keeping the
    // URL server-owned avoids exposing MinIO object keys in catalog responses.
    url: `/catalog/media/${encodeURIComponent(file.fileId)}`,
    ...extra,
  };
}

export class CatalogError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "CatalogError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assertExpectedVersion(req, body, code, currentVersion) {
  let supplied = body?.expectedVersion;
  if (supplied == null && req.headers["if-match"] != null) {
    supplied = String(req.headers["if-match"]).trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  }
  if (supplied == null || supplied === "") {
    throw new CatalogError(400, "expected_version_required", "Send expectedVersion or If-Match before changing this record.");
  }
  const parsed = Number(supplied);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CatalogError(400, "invalid_catalog_item", "expectedVersion must be a positive integer.", {
      field: "expectedVersion",
    });
  }
  if (parsed !== currentVersion) {
    throw new CatalogError(409, code, "This catalog record changed in another session. Refresh it and retry.", {
      expectedVersion: parsed,
      currentVersion,
    });
  }
}

export function advanceSupplierServiceVersion(service, at) {
  const currentVersion = service.version ?? 1;
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
    throw new TypeError("supplier service version must be a positive safe integer");
  }
  service.version = currentVersion + 1;
  service.updatedAt = at;
}

export function effectiveAcceptedFormats(store, item) {
  const registry = activeFormatRegistry(store);
  const selected = item.fileFormatMode === "override"
    ? itemFormatCodes(store, item.id)
    : serviceFormatCodes(store, item.supplierServiceId);
  return [...new Set(selected)]
    .filter((code) => registry.has(code))
    .sort()
    .map((code) => ({ ...registry.get(code) }));
}

export function catalogGroupsForItem(store, itemId, { includeInactiveOptions = true } = {}) {
  return (store.catalogOptionGroups || [])
    .filter((group) => group.catalogItemId === itemId)
    .sort(compareSortOrder)
    .map((group) => ({
      ...group,
      options: (store.catalogOptions || [])
        .filter((option) => option.optionGroupId === group.id)
        .filter((option) => includeInactiveOptions || option.active !== false)
        .sort(compareSortOrder),
    }));
}

export function serviceLineBlockers(store, service, { publicOnly = false } = {}) {
  const blockers = [];
  const pricingBasis = String(service?.pricingBasis || "").trim();
  const turnaround = service && Object.hasOwn(service, "standardTurnaroundHours")
    ? service.standardTurnaroundHours
    : service?.turnaroundHours;
  if (!pricingBasis) blockers.push("pricing_basis");
  if (!Number.isSafeInteger(turnaround) || turnaround <= 0) blockers.push("standard_turnaround");
  if (service?.rushEnabled && (
    !Number.isSafeInteger(service.rushTurnaroundHours)
    || service.rushTurnaroundHours <= 0
    || !Number.isSafeInteger(service.rushPriceMinor)
    || service.rushPriceMinor < 0
  )) blockers.push("rush_terms");
  if (serviceFormatCodes(store, service?.id).filter((code) => activeFormatRegistry(store).has(code)).length === 0) {
    blockers.push("accepted_file_formats");
  }
  if (publicOnly && service?.state !== "live") blockers.push("service_not_live");
  if (!publicOnly && service && !["pending_verification", "live"].includes(service.state)) {
    blockers.push("service_not_review_ready");
  }
  return blockers;
}

export function catalogItemBlockers(store, item, { publicOnly = false } = {}) {
  const blockers = [];
  const service = (store.supplierServices || []).find((candidate) => candidate.id === item?.supplierServiceId);
  if (!item || !service || service.supplierId !== item.supplierId) return ["owning_service"];
  if (!String(item.name || "").trim()) blockers.push("name");
  if (!Number.isSafeInteger(item.basePriceMinor) || item.basePriceMinor < 0) blockers.push("base_price");
  if (serviceLineBlockers(store, service, { publicOnly }).length) blockers.push("service_line");
  if (effectiveAcceptedFormats(store, item).length === 0) blockers.push("accepted_file_formats");
  const photos = (store.catalogItemPhotos || [])
    .filter((photo) => photo.catalogItemId === item.id)
    .filter((photo) => readyFile(store, photo.fileId));
  if (photos.length === 0) blockers.push("photo");
  for (const group of catalogGroupsForItem(store, item.id)) {
    if (!group.options.some((option) => option.active !== false)) blockers.push(`option_group:${group.id}`);
  }
  if (publicOnly) {
    if (item.active === false) blockers.push("item_inactive");
    if (approvalStatus(store, item.supplierId) !== "approved") blockers.push("supplier_not_approved");
  }
  return blockers;
}

export function supplierCatalogReadiness(store, supplierId) {
  if (approvalStatus(store, supplierId) === "approved") {
    return { readyForApproval: true, missing: [] };
  }
  const missing = [];
  const profile = (store.supplierProfiles || []).find((candidate) => candidate.userId === supplierId);
  if (!profile || !String(profile.shopName || "").trim() || !String(profile.contactName || "").trim()
      || !profile.shop || !String(profile.shop.label || "").trim()) {
    missing.push("supplier_profile");
  }

  const terms = (store.supplierPaymentTerms || []).find((candidate) => candidate.supplierId === supplierId);
  if (!terms) {
    // Task H owns this table. Keeping the blocker in the shared projection lets
    // task D consume the settled readiness contract before H integrates it.
    missing.push("supplier_payment_terms");
  } else if (profile?.pickupAvailable && !terms.pickupFullOnlineEnabled && !terms.pickupDownpaymentStoreEnabled) {
    missing.push("pickup_payment_mode");
  }

  const services = (store.supplierServices || []).filter((service) => service.supplierId === supplierId);
  const reviewReady = services.filter((service) => serviceLineBlockers(store, service).length === 0);
  if (reviewReady.length === 0) missing.push("review_ready_service");

  const activeItems = (store.catalogItems || []).filter((item) => item.supplierId === supplierId && item.active !== false);
  const completeItems = activeItems.filter((item) => catalogItemBlockers(store, item).length === 0);
  if (completeItems.length === 0) missing.push("active_catalog_item");
  for (const item of activeItems) {
    for (const blocker of catalogItemBlockers(store, item)) missing.push(`catalog_item:${item.id}:${blocker}`);
  }

  const hasShopMedia = (store.supplierShopMedia || [])
    .some((media) => media.supplierId === supplierId && readyFile(store, media.fileId));
  if (!hasShopMedia) missing.push("shop_identity_media");
  return { readyForApproval: missing.length === 0, missing };
}

export function validateSpecBinding(store, service, specBinding) {
  if (specBinding == null) return null;
  if (!specBinding || typeof specBinding !== "object" || Array.isArray(specBinding)) {
    throw new CatalogError(400, "invalid_spec_binding", "specBinding must be an object.");
  }
  const fieldCode = String(specBinding.fieldCode || "").trim();
  if (!fieldCode) throw new CatalogError(400, "invalid_spec_binding", "specBinding.fieldCode is required.");
  const categoryCode = canonicalCategoryCode(store, service.categoryCode);
  const category = (store.taxonomy?.categories || []).find((candidate) => candidate.code === categoryCode);
  const field = (category?.structuredFields || []).find((candidate) => candidate.code === fieldCode);
  if (!field) {
    throw new CatalogError(400, "invalid_spec_binding", "The bound field is not governed for this service category.", {
      fieldCode,
      categoryCode,
    });
  }
  if (specBinding.valueCode != null) {
    const valueCode = String(specBinding.valueCode);
    const allowed = new Set((field.values || []).map((value) => typeof value === "string" ? value : value.code));
    if (!allowed.has(valueCode)) {
      throw new CatalogError(400, "invalid_spec_binding", "The bound value is not governed for this field.", {
        fieldCode,
        valueCode,
      });
    }
  }
  return structuredClone(specBinding);
}

export function selectedCatalogPrice(store, item, selectedOptionIds = []) {
  const selectedIds = [...new Set(selectedOptionIds.map(String))];
  if (selectedIds.length !== selectedOptionIds.length) {
    throw new CatalogError(400, "invalid_catalog_options", "Choose each catalog option at most once.");
  }
  const groups = catalogGroupsForItem(store, item.id, { includeInactiveOptions: false });
  const groupByOption = new Map();
  for (const group of groups) for (const option of group.options) groupByOption.set(option.id, group);
  const fieldErrors = {};
  for (const optionId of selectedIds) {
    if (!groupByOption.has(optionId)) fieldErrors[optionId] = "option_not_available";
  }
  for (const group of groups) {
    const selected = selectedIds.filter((optionId) => groupByOption.get(optionId)?.id === group.id);
    if (group.required && selected.length !== 1) fieldErrors[group.id] = "choose_exactly_one";
    if (!group.required && selected.length > 1) fieldErrors[group.id] = "choose_at_most_one";
  }
  if (Object.keys(fieldErrors).length) {
    throw new CatalogError(400, "invalid_catalog_options", "Choose one option for every required single-select group.", {
      fields: fieldErrors,
    });
  }
  let total = checkedMinor(item.basePriceMinor, "basePriceMinor");
  const selectedOptions = selectedIds.map((optionId) =>
    (store.catalogOptions || []).find((candidate) => candidate.id === optionId));
  for (const option of selectedOptions) total += checkedMinor(option.priceModifierMinor, "priceModifierMinor");
  if (total < 0n) total = 0n;
  return { effectiveUnitPriceMinor: checkedNumber(total, "effectiveUnitPriceMinor"), selectedOptions };
}

function publicPhotos(store, itemId) {
  return (store.catalogItemPhotos || [])
    .filter((photo) => photo.catalogItemId === itemId)
    .sort(compareSortOrder)
    .flatMap((photo) => {
      const file = readyFile(store, photo.fileId);
      return file ? [mediaProjection(file, { sortOrder: photo.sortOrder, altText: photo.altText ?? null })] : [];
    });
}

function publicShopMedia(store, supplierId) {
  return (store.supplierShopMedia || [])
    .filter((media) => media.supplierId === supplierId)
    .flatMap((media) => {
      const file = readyFile(store, media.fileId);
      return file ? [mediaProjection(file, { slot: media.slot })] : [];
    })
    .sort((left, right) => left.slot.localeCompare(right.slot));
}

export function publicCatalogItem(store, item, { selectedOptionIds } = {}) {
  if (catalogItemBlockers(store, item, { publicOnly: true }).length) return null;
  const service = store.supplierServices.find((candidate) => candidate.id === item.supplierServiceId);
  const groups = catalogGroupsForItem(store, item.id, { includeInactiveOptions: false }).map((group) => ({
    id: group.id,
    name: group.name,
    required: group.required,
    selectionMode: "single",
    sortOrder: group.sortOrder,
    version: group.version,
    options: group.options.map((option) => ({
      id: option.id,
      label: option.label,
      priceModifierMinor: option.priceModifierMinor,
      specBinding: option.specBinding ?? null,
      sortOrder: option.sortOrder,
    })),
  }));
  let effectivePriceMinor = groups.length === 0 ? item.basePriceMinor : null;
  if (selectedOptionIds) effectivePriceMinor = selectedCatalogPrice(store, item, selectedOptionIds).effectiveUnitPriceMinor;
  return {
    id: item.id,
    supplierId: item.supplierId,
    supplierServiceId: item.supplierServiceId,
    categoryCode: canonicalCategoryCode(store, service.categoryCode),
    name: item.name,
    description: item.description,
    basePriceMinor: item.basePriceMinor,
    effectivePriceMinor,
    pricingBasis: service.pricingBasis,
    turnaroundHours: Object.hasOwn(service, "standardTurnaroundHours")
      ? service.standardTurnaroundHours
      : service.turnaroundHours,
    rush: service.rushEnabled ? {
      turnaroundHours: service.rushTurnaroundHours,
      priceMinor: service.rushPriceMinor,
    } : null,
    acceptedFormats: effectiveAcceptedFormats(store, item),
    photos: publicPhotos(store, item.id),
    optionGroups: groups,
    version: item.version,
  };
}

export function publicSupplierShop(store, supplierId) {
  if (approvalStatus(store, supplierId) !== "approved") return null;
  const profile = (store.supplierProfiles || []).find((candidate) => candidate.userId === supplierId);
  if (!profile) return null;
  const services = (store.supplierServices || [])
    .filter((service) => service.supplierId === supplierId && service.state === "live")
    .sort(compareSortOrder)
    .map((service) => {
      const items = (store.catalogItems || [])
        .filter((item) => item.supplierServiceId === service.id)
        .sort(compareSortOrder)
        .map((item) => publicCatalogItem(store, item))
        .filter(Boolean);
      return items.length ? {
        id: service.id,
        categoryCode: canonicalCategoryCode(store, service.categoryCode),
        pricingBasis: service.pricingBasis,
        turnaroundHours: Object.hasOwn(service, "standardTurnaroundHours")
          ? service.standardTurnaroundHours
          : service.turnaroundHours,
        acceptedFormats: serviceFormatCodes(store, service.id)
          .filter((code) => activeFormatRegistry(store).has(code)).sort(),
        items,
      } : null;
    })
    .filter(Boolean);
  if (services.length === 0) return null;
  return {
    supplierId,
    shopName: profile.shopName,
    shop: profile.shop,
    media: publicShopMedia(store, supplierId),
    categories: [...new Set(services.map((service) => service.categoryCode))],
    services,
  };
}

export function publicSupplierShops(store, { categoryCode, cursor, limit = 20 } = {}) {
  const shops = (store.supplierProfiles || [])
    .map((profile) => publicSupplierShop(store, profile.userId))
    .filter(Boolean)
    .filter((shop) => !categoryCode || shop.categories.includes(categoryCode))
    .sort((left, right) => left.supplierId.localeCompare(right.supplierId));
  const start = cursor ? shops.findIndex((shop) => shop.supplierId === cursor) + 1 : 0;
  const page = shops.slice(Math.max(0, start), Math.max(0, start) + limit);
  return {
    shops: page.map((shop) => ({
      supplierId: shop.supplierId,
      shopName: shop.shopName,
      shop: shop.shop,
      media: shop.media,
      categories: shop.categories,
      itemCount: shop.services.reduce((count, service) => count + service.items.length, 0),
    })),
    nextCursor: start + page.length < shops.length ? page.at(-1).supplierId : null,
  };
}

export function createOrderLineSnapshot(store, selection, createId) {
  if (selection.expectedVersion == null) {
    throw new CatalogError(400, "expected_version_required", "expectedVersion is required before checkout.");
  }
  if (!Number.isSafeInteger(selection.expectedVersion) || selection.expectedVersion < 1) {
    throw new CatalogError(400, "invalid_catalog_item", "expectedVersion must be a positive integer.", {
      field: "expectedVersion",
    });
  }
  const item = (store.catalogItems || []).find((candidate) => candidate.id === selection.catalogItemId);
  if (!item || catalogItemBlockers(store, item, { publicOnly: true }).length) {
    throw new CatalogError(409, "catalog_item_stale", "The catalog item changed or is no longer available.");
  }
  if (selection.expectedVersion !== item.version) {
    throw new CatalogError(409, "catalog_item_stale", "The catalog item changed. Refresh it before checkout.", {
      expectedVersion: selection.expectedVersion,
      currentVersion: item.version,
    });
  }
  const service = store.supplierServices.find((candidate) => candidate.id === item.supplierServiceId);
  const order = (store.orders || []).find((candidate) => candidate.id === selection.orderId);
  if (order && order.supplierId !== item.supplierId) {
    throw new CatalogError(409, "catalog_item_stale", "The catalog item does not belong to the order's assigned supplier.");
  }
  const { effectiveUnitPriceMinor, selectedOptions } = selectedCatalogPrice(store, item, selection.optionIds || []);
  const quantity = Number(selection.quantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new CatalogError(400, "invalid_catalog_item", "quantity must be a positive integer.", { field: "quantity" });
  }
  const formats = effectiveAcceptedFormats(store, item).map((format) => format.code);
  if (!formats.includes(selection.acceptedFormatCode)) {
    throw new CatalogError(400, "invalid_file_format", "Choose one accepted format for this catalog item.", {
      allowed: formats,
    });
  }
  const structuredSpec = selection.structuredSpec;
  if (!structuredSpec || typeof structuredSpec !== "object" || Array.isArray(structuredSpec)) {
    throw new CatalogError(400, "invalid_structured_spec", "structuredSpec must be an object.");
  }
  const groups = new Map(catalogGroupsForItem(store, item.id).map((group) => [group.id, group]));
  for (const option of selectedOptions) {
    if (!option.specBinding) continue;
    const fieldCode = option.specBinding.fieldCode;
    const boundValue = option.specBinding.valueCode ?? option.specBinding.value;
    if (boundValue != null && structuredSpec[fieldCode] !== boundValue) {
      throw new CatalogError(400, "invalid_catalog_options", "An option conflicts with the structured specification.", {
        fields: { [fieldCode]: "option_spec_conflict" },
      });
    }
  }
  const subtotal = checkedNumber(
    checkedMinor(effectiveUnitPriceMinor, "effectiveUnitPriceMinor") * BigInt(quantity),
    "lineSubtotalMinor",
  );
  const lineItemId = selection.lineItemId || createId?.("oli");
  if (!lineItemId) throw new TypeError("lineItemId or createId is required");
  const createdAt = selection.createdAt || new Date().toISOString();
  const options = selectedOptions
    .sort((left, right) => compareSortOrder(groups.get(left.optionGroupId), groups.get(right.optionGroupId)))
    .map((option, sortOrder) => {
      const group = groups.get(option.optionGroupId);
      return {
        id: createId?.("olo") || `${lineItemId}_option_${sortOrder}`,
        orderLineItemId: lineItemId,
        sourceOptionGroupId: group.id,
        sourceOptionId: option.id,
        groupNameSnapshot: group.name,
        optionLabelSnapshot: option.label,
        priceModifierMinor: option.priceModifierMinor,
        sortOrder,
      };
    });
  return {
    lineItem: {
      id: lineItemId,
      orderId: selection.orderId,
      sourceCatalogItemId: item.id,
      sourceSupplierServiceId: service.id,
      itemNameSnapshot: item.name,
      descriptionSnapshot: item.description,
      pricingBasisSnapshot: service.pricingBasis,
      baseUnitPriceMinor: item.basePriceMinor,
      effectiveUnitPriceMinor,
      quantity,
      lineSubtotalMinor: subtotal,
      acceptedFormatCodesSnapshot: formats,
      structuredSpecSnapshot: structuredClone(structuredSpec),
      sortOrder: selection.sortOrder ?? 0,
      createdAt,
    },
    options,
  };
}

export function appendOrderLineSnapshot(store, selection, createId) {
  const snapshot = createOrderLineSnapshot(store, selection, createId);
  if (!Array.isArray(store.orderLineItems)) store.orderLineItems = [];
  if (!Array.isArray(store.orderLineItemOptions)) store.orderLineItemOptions = [];
  store.orderLineItems.push(snapshot.lineItem);
  store.orderLineItemOptions.push(...snapshot.options);
  return structuredClone(snapshot);
}
