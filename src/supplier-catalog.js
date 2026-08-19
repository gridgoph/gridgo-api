import { resolveCategoryCode } from "./taxonomy.js";

const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_MINOR = -MAX_SAFE_MINOR;
const GOVERNED_BINDING_FIELDS = new Set([
  "material", "finish", "size", "paper_size", "item_size", "dimensions", "color_mode",
]);

export class CatalogError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "CatalogError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function compareSortOrder(left, right) {
  return (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || String(left.id || "").localeCompare(String(right.id || ""));
}

function checkedMinor(value, field) {
  if (!Number.isSafeInteger(value)) {
    throw new CatalogError(400, "invalid_money", `${field} must be a JavaScript safe integer in minor units.`, { field });
  }
  return BigInt(value);
}

function checkedNumber(value, field) {
  if (value < MIN_SAFE_MINOR || value > MAX_SAFE_MINOR) {
    throw new CatalogError(400, "invalid_money", `${field} exceeds the supported minor-unit range.`, { field });
  }
  return Number(value);
}

function formatCode(record) {
  return typeof record === "string" ? record : record.formatCode;
}

function appendIndexed(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function activeCategory(store, code) {
  const category = resolveCategoryCode(store.taxonomy, code);
  return category?.active !== false ? category : null;
}

function readyFile(store, fileId) {
  const file = (store.files || []).find((candidate) => candidate.fileId === fileId);
  return file?.state === "ready" && file.objectKey ? file : null;
}

export function assertExpectedVersion(req, body, code, currentVersion) {
  const header = req?.headers?.["if-match"] ?? req?.headers?.["If-Match"];
  const raw = body?.expectedVersion ?? (typeof header === "string" ? header.replace(/^W\//, "").replaceAll('"', "").trim() : header);
  if (raw == null || raw === "") {
    throw new CatalogError(400, "expected_version_required", "Send expectedVersion so GRIDGO can reject a stale edit.");
  }
  const expected = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new CatalogError(400, "invalid_catalog_item", "expectedVersion must be a positive integer.", { field: "expectedVersion" });
  }
  if (expected !== currentVersion) {
    throw new CatalogError(409, code, "This record changed. Refresh it and try again.", {
      expectedVersion: expected,
      currentVersion,
    });
  }
  return expected;
}

export function bumpVersion(record, at) {
  record.version = (record.version || 1) + 1;
  if (at) record.updatedAt = at;
  return record.version;
}

export function effectiveAcceptedFormats(store, item) {
  const registry = new Map((store.acceptedFileFormats || [])
    .filter((format) => format.active !== false)
    .map((format) => [format.code, format]));
  const selected = item.fileFormatMode === "override"
    ? (store.catalogItemFileFormats || [])
      .filter((record) => record.catalogItemId === item.id)
      .map(formatCode)
    : (store.supplierServiceFileFormats || [])
      .filter((record) => record.supplierServiceId === item.supplierServiceId)
      .map(formatCode);
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
      kind: group.kind || "spec",
      options: (store.catalogOptions || [])
        .filter((option) => option.optionGroupId === group.id)
        .filter((option) => includeInactiveOptions || option.active !== false)
        .sort(compareSortOrder),
    }));
}

export function validateSpecBinding(store, service, specBinding) {
  if (specBinding == null) return null;
  if (!specBinding || typeof specBinding !== "object" || Array.isArray(specBinding)) {
    throw new CatalogError(400, "invalid_spec_binding", "specBinding must be an object or omitted.", { field: "specBinding" });
  }
  const fieldCode = String(specBinding.fieldCode || "").trim();
  if (!GOVERNED_BINDING_FIELDS.has(fieldCode)) {
    throw new CatalogError(400, "invalid_spec_binding", "Bind only to a governed field, or leave the option as a custom label.", {
      field: "specBinding",
      allowedFields: [...GOVERNED_BINDING_FIELDS],
    });
  }
  const valueCode = specBinding.valueCode == null ? null : String(specBinding.valueCode).trim();
  const category = activeCategory(store, service.categoryCode);
  const categoryCode = category?.code || null;
  if (fieldCode === "material" && valueCode) {
    const material = (store.taxonomy?.materials || []).find((candidate) => candidate.code === valueCode && candidate.active !== false);
    if (!material || (categoryCode && !(material.categoryCodes || []).includes(categoryCode))) {
      throw new CatalogError(400, "invalid_spec_binding", "That material is not governed for this service category.", {
        field: "specBinding",
      });
    }
  }
  if (fieldCode === "finish" && valueCode) {
    const finish = (store.taxonomy?.finishes || []).find((candidate) => candidate.code === valueCode && candidate.active !== false);
    if (!finish || (categoryCode && !(finish.categoryCodes || []).includes(categoryCode))) {
      throw new CatalogError(400, "invalid_spec_binding", "That finish is not governed for this service category.", {
        field: "specBinding",
      });
    }
  }
  return {
    fieldCode,
    ...(valueCode ? { valueCode } : {}),
    ...(specBinding.value != null ? { value: specBinding.value } : {}),
  };
}

export function catalogItemBlockers(store, item, { publicOnly = false } = {}) {
  const blockers = [];
  const service = (store.supplierServices || []).find((candidate) => candidate.id === item?.supplierServiceId);
  if (!item || !service || service.supplierId !== item.supplierId) return ["owning_service"];
  if (!String(item.name || "").trim()) blockers.push("name");
  if (!Number.isSafeInteger(item.basePriceMinor) || item.basePriceMinor < 0) blockers.push("base_price");
  if (!item.subcategoryCode) blockers.push("subcategory");
  if (effectiveAcceptedFormats(store, item).length === 0) blockers.push("accepted_file_formats");
  const photos = (store.catalogItemPhotos || [])
    .filter((photo) => photo.catalogItemId === item.id)
    .filter((photo) => readyFile(store, photo.fileId));
  if (photos.length === 0) blockers.push("photo");
  for (const group of catalogGroupsForItem(store, item.id)) {
    if (group.options.filter((option) => option.active !== false).length === 0) {
      blockers.push(`option_group:${group.id}`);
    }
  }
  if (publicOnly) {
    if (item.active === false) blockers.push("item_inactive");
    if (service.state !== "live") blockers.push("service_not_live");
    const membership = (store.userRoleMemberships || []).some(
      (row) => row.userId === item.supplierId && row.role === "supplier",
    );
    if (!membership) blockers.push("supplier_membership");
    const approval = (store.approvalCases || []).find(
      (candidate) => candidate.userId === item.supplierId && candidate.kind === "supplier",
    );
    if (approval?.status !== "approved") blockers.push("supplier_not_approved");
  }
  return blockers;
}

export function selectedCatalogPrice(store, item, selectedOptionIds = []) {
  const selectedIds = [...new Set(selectedOptionIds.map(String))];
  if (selectedIds.length !== selectedOptionIds.length) {
    throw new CatalogError(400, "invalid_catalog_options", "Choose each catalog option at most once.");
  }
  const groups = catalogGroupsForItem(store, item.id, { includeInactiveOptions: false });
  const groupByOption = new Map();
  for (const group of groups) for (const option of group.options) groupByOption.set(option.id, group);
  const fieldErrors = Object.create(null);
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
  for (const option of selectedOptions) {
    total += checkedMinor(option.priceModifierMinor, "priceModifierMinor");
  }
  if (total < 0n) total = 0n;
  return { effectiveUnitPriceMinor: checkedNumber(total, "effectiveUnitPriceMinor"), selectedOptions };
}

function minimumCatalogPrice(store, item) {
  const groups = catalogGroupsForItem(store, item.id, { includeInactiveOptions: false });
  let total = checkedMinor(item.basePriceMinor, "basePriceMinor");
  for (const group of groups) {
    const modifiers = group.options.map((option) => checkedMinor(option.priceModifierMinor, "priceModifierMinor"));
    if (group.required) {
      if (modifiers.length === 0) return null;
      total += modifiers.reduce((lowest, value) => value < lowest ? value : lowest);
    } else if (modifiers.length) {
      const cheapest = modifiers.reduce((lowest, value) => value < lowest ? value : lowest);
      if (cheapest < 0n) total += cheapest;
    }
  }
  if (total < 0n) total = 0n;
  return checkedNumber(total, "fromPriceMinor");
}

function publicPhotos(store, itemId) {
  return (store.catalogItemPhotos || [])
    .filter((photo) => photo.catalogItemId === itemId && readyFile(store, photo.fileId))
    .sort(compareSortOrder)
    .map((photo) => ({
      fileId: photo.fileId,
      sortOrder: photo.sortOrder,
      altText: photo.altText ?? null,
      url: `/catalog/media/${photo.fileId}`,
    }));
}

function publicShopMedia(store, supplierId) {
  return (store.supplierShopMedia || [])
    .filter((media) => media.supplierId === supplierId && readyFile(store, media.fileId))
    .map((media) => ({
      slot: media.slot,
      fileId: media.fileId,
      url: `/catalog/media/${media.fileId}`,
    }));
}

export function itemTurnaroundHours(item, service) {
  if (item.turnaroundMode === "override") return item.turnaroundHours;
  return Object.hasOwn(service, "standardTurnaroundHours")
    ? service.standardTurnaroundHours
    : service.turnaroundHours;
}

export function publicCatalogItem(store, item, { selectedOptionIds } = {}) {
  if (catalogItemBlockers(store, item, { publicOnly: true }).length) return null;
  const service = store.supplierServices.find((candidate) => candidate.id === item.supplierServiceId);
  const groups = catalogGroupsForItem(store, item.id, { includeInactiveOptions: false }).map((group) => ({
    id: group.id,
    name: group.name,
    kind: group.kind || "spec",
    helpText: group.helpText ?? null,
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
  let effectivePriceMinor = null;
  if (selectedOptionIds !== undefined || !groups.some((group) => group.required)) {
    effectivePriceMinor = selectedCatalogPrice(store, item, selectedOptionIds ?? []).effectiveUnitPriceMinor;
  }
  return {
    id: item.id,
    supplierId: item.supplierId,
    supplierServiceId: item.supplierServiceId,
    categoryCode: activeCategory(store, service.categoryCode)?.code || service.categoryCode,
    subcategoryCode: item.subcategoryCode,
    name: item.name,
    description: item.description,
    basePriceMinor: item.basePriceMinor,
    fromPriceMinor: minimumCatalogPrice(store, item),
    effectivePriceMinor,
    pricingUnit: item.pricingUnit || "per_unit",
    packageQty: item.packageQty ?? null,
    pricingBasis: service.pricingBasis,
    turnaroundMode: item.turnaroundMode || "inherit",
    turnaroundHours: itemTurnaroundHours(item, service),
    rush: service.rushEnabled ? {
      turnaroundHours: service.rushTurnaroundHours,
      priceMinor: service.rushPriceMinor,
    } : null,
    acceptedFormats: effectiveAcceptedFormats(store, item),
    photos: publicPhotos(store, item.id),
    optionGroups: groups,
    version: item.version,
    serviceVersion: service.version || 1,
  };
}

export function publicSupplierShop(store, supplierId) {
  const membership = (store.userRoleMemberships || []).some(
    (row) => row.userId === supplierId && row.role === "supplier",
  );
  const approval = (store.approvalCases || []).find(
    (candidate) => candidate.userId === supplierId && candidate.kind === "supplier",
  );
  if (!membership || approval?.status !== "approved") return null;
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
        version: service.version || 1,
        categoryCode: activeCategory(store, service.categoryCode)?.code || service.categoryCode,
        pricingBasis: service.pricingBasis,
        turnaroundHours: Object.hasOwn(service, "standardTurnaroundHours")
          ? service.standardTurnaroundHours
          : service.turnaroundHours,
        acceptedFormats: (store.supplierServiceFileFormats || [])
          .filter((record) => record.supplierServiceId === service.id)
          .map(formatCode)
          .filter((code) => (store.acceptedFileFormats || []).some((format) => format.code === code && format.active !== false))
          .sort(),
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
  const resolved = categoryCode ? activeCategory(store, categoryCode)?.code : null;
  if (categoryCode && !resolved) {
    throw new CatalogError(400, "invalid_category_code", "Choose an active governed category.", { categoryCode });
  }
  const profiles = (store.supplierProfiles || [])
    .filter((profile) => !cursor || profile.userId.localeCompare(cursor) > 0)
    .sort((left, right) => left.userId.localeCompare(right.userId));
  const shops = [];
  for (const profile of profiles) {
    const shop = publicSupplierShop(store, profile.userId);
    if (!shop) continue;
    if (resolved && !shop.categories.includes(resolved)) continue;
    shops.push({
      supplierId: shop.supplierId,
      shopName: shop.shopName,
      shop: shop.shop,
      media: shop.media,
      categories: shop.categories,
      itemCount: shop.services.reduce((count, service) => count + service.items.length, 0),
    });
    if (shops.length > limit) break;
  }
  const hasMore = shops.length > limit;
  const page = shops.slice(0, limit);
  return { shops: page, nextCursor: hasMore ? page.at(-1).supplierId : null };
}

export function listingStartersFor(store, subcategoryCode) {
  return (store.listingStarters || [])
    .filter((starter) => !subcategoryCode || starter.subcategoryCode === subcategoryCode)
    .map((starter) => ({
      id: starter.id,
      subcategoryCode: starter.subcategoryCode,
      name: starter.name,
      defaultPricingUnit: starter.defaultPricingUnit,
      defaultPackageQty: starter.defaultPackageQty ?? null,
      defaultTurnaroundHours: starter.defaultTurnaroundHours ?? null,
      defaultFormatCodes: [...(starter.defaultFormatCodes || [])],
      groups: (store.listingStarterGroups || [])
        .filter((group) => group.starterId === starter.id)
        .sort(compareSortOrder)
        .map((group) => ({
          id: group.id,
          name: group.name,
          kind: group.kind,
          helpText: group.helpText ?? null,
          required: group.required,
          sortOrder: group.sortOrder,
          options: (store.listingStarterOptions || [])
            .filter((option) => option.starterGroupId === group.id)
            .sort(compareSortOrder)
            .map((option) => ({
              id: option.id,
              label: option.label,
              priceModifierMinor: option.priceModifierMinor,
              specBinding: option.specBinding ?? null,
              sortOrder: option.sortOrder,
            })),
        })),
    }));
}

export function copyStarterIntoItem(store, starter, item, createId, at) {
  for (const group of (store.listingStarterGroups || []).filter((candidate) => candidate.starterId === starter.id).sort(compareSortOrder)) {
    const groupId = createId("cog");
    store.catalogOptionGroups.push({
      id: groupId,
      catalogItemId: item.id,
      name: group.name,
      kind: group.kind,
      helpText: group.helpText ?? null,
      required: group.required,
      selectionMode: "single",
      sortOrder: group.sortOrder,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    for (const option of (store.listingStarterOptions || []).filter((candidate) => candidate.starterGroupId === group.id).sort(compareSortOrder)) {
      store.catalogOptions.push({
        id: createId("cop"),
        optionGroupId: groupId,
        label: option.label,
        priceModifierMinor: option.priceModifierMinor,
        specBinding: option.specBinding ?? null,
        active: true,
        sortOrder: option.sortOrder,
        createdAt: at,
        updatedAt: at,
      });
    }
  }
  if (starter.defaultFormatCodes?.length) {
    item.fileFormatMode = "override";
    store.catalogItemFileFormats = (store.catalogItemFileFormats || [])
      .filter((record) => record.catalogItemId !== item.id);
    store.catalogItemFileFormats.push(
      ...starter.defaultFormatCodes.map((code) => ({ catalogItemId: item.id, formatCode: code })),
    );
  }
}

export function supplierCatalogReadiness(store, supplierId) {
  const missing = [];
  const profile = (store.supplierProfiles || []).find((candidate) => candidate.userId === supplierId);
  if (!profile || !String(profile.shopName || "").trim() || !String(profile.contactName || "").trim()
      || !profile.shop || !String(profile.shop.label || "").trim()) {
    missing.push("supplier_profile");
  }
  const terms = (store.supplierPaymentTerms || []).find((candidate) => candidate.supplierId === supplierId);
  if (profile?.pickupAvailable && terms && !terms.pickupFullOnlineEnabled && !terms.pickupDownpaymentStoreEnabled) {
    missing.push("pickup_payment_terms");
  }
  const services = (store.supplierServices || []).filter((service) => service.supplierId === supplierId);
  const reviewReady = services.filter((service) =>
    ["pending_verification", "live"].includes(service.state)
    && String(service.pricingBasis || "").trim()
    && Number.isSafeInteger(service.turnaroundHours || service.standardTurnaroundHours)
    && (service.turnaroundHours || service.standardTurnaroundHours) > 0
    && (store.supplierServiceFileFormats || []).some((record) => record.supplierServiceId === service.id));
  if (reviewReady.length === 0) missing.push("review_ready_service_line");
  const completeItems = (store.catalogItems || []).filter((item) =>
    item.supplierId === supplierId
    && item.active !== false
    && catalogItemBlockers(store, item).length === 0);
  if (completeItems.length === 0) missing.push("complete_catalog_item");
  const shopMedia = (store.supplierShopMedia || []).some((media) => media.supplierId === supplierId && readyFile(store, media.fileId));
  if (!shopMedia) missing.push("shop_identity_image");
  return {
    readyForApproval: missing.length === 0,
    missing,
    publishableServiceIds: reviewReady
      .filter((service) => completeItems.some((item) => item.supplierServiceId === service.id))
      .map((service) => service.id),
  };
}

function publicCatalogMediaEligible(store, file) {
  if (!file || file.state !== "ready" || !file.objectKey) return false;
  if (file.purpose === "catalog_item_photo") {
    const photo = (store.catalogItemPhotos || []).find((candidate) => candidate.fileId === file.fileId);
    const item = photo && (store.catalogItems || []).find((candidate) => candidate.id === photo.catalogItemId);
    return Boolean(item && publicCatalogItem(store, item));
  }
  if (file.purpose === "supplier_shop_image") {
    const media = (store.supplierShopMedia || []).find((candidate) => candidate.fileId === file.fileId);
    return Boolean(media && publicSupplierShop(store, media.supplierId));
  }
  return false;
}

export function publicCatalogMediaFile(store, fileId) {
  const file = (store.files || []).find((candidate) => candidate.fileId === fileId);
  return publicCatalogMediaEligible(store, file) ? file : null;
}

function normalizedSnapshotSelection(selection) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw new CatalogError(400, "invalid_catalog_item", "selection must be a JSON object.", { field: "selection" });
  }
  if (!Array.isArray(selection.optionIds)) {
    throw new CatalogError(400, "invalid_catalog_options", "optionIds must be an array.", { field: "optionIds" });
  }
  const normalized = { ...selection };
  for (const field of ["orderId", "catalogItemId"]) {
    if (typeof selection[field] !== "string" || !selection[field].trim()) {
      throw new CatalogError(400, "invalid_catalog_item", `${field} must be a nonblank identifier.`, { field });
    }
    normalized[field] = selection[field].trim();
  }
  normalized.optionIds = selection.optionIds.map((optionId, index) => {
    if (typeof optionId !== "string" || !optionId.trim()) {
      throw new CatalogError(400, "invalid_catalog_options", "Each optionId must be a nonblank identifier.", {
        fields: { [index]: "invalid_option_id" },
      });
    }
    return optionId.trim();
  });
  return normalized;
}

export function createOrderLineSnapshot(store, selection, createId) {
  selection = normalizedSnapshotSelection(selection);
  if (selection.expectedVersion == null) {
    throw new CatalogError(400, "expected_version_required", "expectedVersion is required before checkout.");
  }
  if (!Number.isSafeInteger(selection.expectedVersion) || selection.expectedVersion < 1) {
    throw new CatalogError(400, "invalid_catalog_item", "expectedVersion must be a positive integer.", {
      field: "expectedVersion",
    });
  }
  if (selection.expectedServiceVersion == null) {
    throw new CatalogError(400, "expected_service_version_required", "expectedServiceVersion is required before checkout.");
  }
  if (!Number.isSafeInteger(selection.expectedServiceVersion) || selection.expectedServiceVersion < 1) {
    throw new CatalogError(400, "invalid_catalog_item", "expectedServiceVersion must be a positive integer.", {
      field: "expectedServiceVersion",
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
  if (selection.expectedServiceVersion !== (service.version || 1)) {
    throw new CatalogError(409, "supplier_service_stale", "The supplier service changed. Refresh it before checkout.", {
      expectedVersion: selection.expectedServiceVersion,
      currentVersion: service.version || 1,
    });
  }
  const order = (store.orders || []).find((candidate) => candidate.id === selection.orderId);
  if (!order) {
    throw new CatalogError(404, "order_not_found", "That order no longer exists. Refresh orders and try again.");
  }
  if (order.supplierId && order.supplierId !== item.supplierId) {
    throw new CatalogError(409, "catalog_item_stale", "The catalog item does not belong to the order's assigned supplier.");
  }
  const { effectiveUnitPriceMinor, selectedOptions } = selectedCatalogPrice(store, item, selection.optionIds || []);
  const quantity = selection.quantity;
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new CatalogError(400, "invalid_catalog_item", "quantity must be a positive integer.", { field: "quantity" });
  }
  const formats = effectiveAcceptedFormats(store, item).map((format) => format.code);
  if (selection.acceptedFormatCode && !formats.includes(selection.acceptedFormatCode)) {
    throw new CatalogError(400, "invalid_file_format", "Choose one accepted format for this catalog item.", {
      allowed: formats,
    });
  }
  const structuredSpec = selection.structuredSpec && typeof selection.structuredSpec === "object" && !Array.isArray(selection.structuredSpec)
    ? structuredClone(selection.structuredSpec)
    : {};
  const groups = new Map(catalogGroupsForItem(store, item.id).map((group) => [group.id, group]));
  const subtotal = checkedNumber(
    checkedMinor(effectiveUnitPriceMinor, "effectiveUnitPriceMinor") * BigInt(quantity),
    "lineSubtotalMinor",
  );
  const lineItemId = selection.lineItemId || createId?.("oli");
  const createdAt = selection.createdAt || new Date().toISOString();
  const sortOrder = Number.isSafeInteger(selection.sortOrder) ? selection.sortOrder : 0;
  const options = selectedOptions
    .sort((left, right) => compareSortOrder(groups.get(left.optionGroupId), groups.get(right.optionGroupId)))
    .map((option, optionOrder) => {
      const group = groups.get(option.optionGroupId);
      return {
        id: createId?.("olo") || `${lineItemId}_option_${optionOrder}`,
        orderLineItemId: lineItemId,
        sourceOptionGroupId: group.id,
        sourceOptionId: option.id,
        groupNameSnapshot: group.name,
        groupKindSnapshot: group.kind || "spec",
        optionLabelSnapshot: option.label,
        priceModifierMinor: option.priceModifierMinor,
        sortOrder: optionOrder,
      };
    });
  return {
    lineItem: {
      id: lineItemId,
      orderId: selection.orderId,
      sourceCatalogItemId: item.id,
      sourceSupplierServiceId: service.id,
      itemNameSnapshot: item.name,
      descriptionSnapshot: item.description || "",
      pricingBasisSnapshot: service.pricingBasis || item.pricingUnit || "per_unit",
      pricingUnitSnapshot: item.pricingUnit || "per_unit",
      packageQtySnapshot: item.packageQty ?? null,
      turnaroundHoursSnapshot: itemTurnaroundHours(item, service),
      baseUnitPriceMinor: item.basePriceMinor,
      effectiveUnitPriceMinor,
      quantity,
      lineSubtotalMinor: subtotal,
      acceptedFormatCodesSnapshot: formats,
      structuredSpecSnapshot: structuredSpec,
      sortOrder,
      snapshotFinalized: true,
      createdAt,
    },
    options,
  };
}

export function appendOrderLineSnapshot(store, selection, createId) {
  selection = normalizedSnapshotSelection(selection);
  const lineItems = Array.isArray(store.orderLineItems) ? store.orderLineItems : [];
  const lineOptions = Array.isArray(store.orderLineItemOptions) ? store.orderLineItemOptions : [];
  const orderLines = lineItems.filter((line) => line.orderId === selection.orderId);
  const sortOrder = selection.sortOrder == null
    ? orderLines.reduce((maximum, line) => Math.max(maximum, line.sortOrder), -1) + 1
    : selection.sortOrder;
  if (orderLines.some((line) => line.sortOrder === sortOrder)) {
    throw new CatalogError(409, "order_line_position_conflict", "That order line position is no longer available.", {
      sortOrder,
    });
  }
  const snapshot = createOrderLineSnapshot(store, { ...selection, sortOrder }, createId);
  if (!Array.isArray(store.orderLineItems)) store.orderLineItems = lineItems;
  if (!Array.isArray(store.orderLineItemOptions)) store.orderLineItemOptions = lineOptions;
  lineItems.push(snapshot.lineItem);
  lineOptions.push(...snapshot.options);
  return snapshot;
}

export function privateCatalogItem(store, item) {
  const groups = catalogGroupsForItem(store, item.id);
  return {
    id: item.id,
    supplierId: item.supplierId,
    supplierServiceId: item.supplierServiceId,
    subcategoryCode: item.subcategoryCode,
    name: item.name,
    description: item.description,
    basePriceMinor: item.basePriceMinor,
    pricingUnit: item.pricingUnit || "per_unit",
    packageQty: item.packageQty ?? null,
    turnaroundMode: item.turnaroundMode || "inherit",
    turnaroundHours: item.turnaroundHours ?? null,
    fileFormatMode: item.fileFormatMode || "inherit",
    acceptedFormats: effectiveAcceptedFormats(store, item),
    active: item.active !== false,
    sortOrder: item.sortOrder,
    version: item.version,
    photos: (store.catalogItemPhotos || [])
      .filter((photo) => photo.catalogItemId === item.id)
      .sort(compareSortOrder)
      .map((photo) => ({
        fileId: photo.fileId,
        sortOrder: photo.sortOrder,
        altText: photo.altText ?? null,
      })),
    optionGroups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      kind: group.kind || "spec",
      helpText: group.helpText ?? null,
      required: group.required,
      selectionMode: "single",
      sortOrder: group.sortOrder,
      version: group.version,
      options: group.options.map((option) => ({
        id: option.id,
        label: option.label,
        priceModifierMinor: option.priceModifierMinor,
        specBinding: option.specBinding ?? null,
        active: option.active !== false,
        sortOrder: option.sortOrder,
      })),
    })),
    complete: catalogItemBlockers(store, item).length === 0,
    blockers: catalogItemBlockers(store, item),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
