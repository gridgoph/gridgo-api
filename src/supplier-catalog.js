const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_MINOR = -MAX_SAFE_MINOR;

const POSTGRES_INTEGER_MAX = 2147483647;

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

function orderLineSortOrder(value) {
  const sortOrder = Number(value);
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > POSTGRES_INTEGER_MAX) {
    throw new CatalogError(400, "invalid_catalog_item", "sortOrder must be a non-negative PostgreSQL integer.", { field: "sortOrder" });
  }
  return sortOrder;
}

function formatCode(record) {
  return typeof record === "string" ? record : record.formatCode;
}

function appendIndexed(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function buildCatalogIndex(store) {
  const index = {
    activeFormats: new Map((store.acceptedFileFormats || [])
      .filter((format) => format.active !== false)
      .map((format) => [format.code, format])),
    approvals: new Map(),
    catalogGroupsByItem: new Map(),
    catalogItemsByService: new Map(),
    catalogOptionsByGroup: new Map(),
    itemFormats: new Map(),
    photosByItem: new Map(),
    readyFiles: new Map(),
    serviceFormats: new Map(),
    servicesById: new Map(),
    servicesBySupplier: new Map(),
    shopMediaBySupplier: new Map(),
    supplierMemberships: new Set(),
  };
  for (const approvalCase of store.approvalCases || []) {
    if (approvalCase.kind === "supplier" && !index.approvals.has(approvalCase.userId)) {
      index.approvals.set(approvalCase.userId, approvalCase.status);
    }
  }
  for (const membership of store.userRoleMemberships || []) {
    if (membership.role === "supplier") index.supplierMemberships.add(membership.userId);
  }
  for (const file of store.files || []) {
    if (file.state === "ready" && file.objectKey) index.readyFiles.set(file.fileId, file);
  }
  for (const service of store.supplierServices || []) {
    index.servicesById.set(service.id, service);
    appendIndexed(index.servicesBySupplier, service.supplierId, service);
  }
  for (const item of store.catalogItems || []) appendIndexed(index.catalogItemsByService, item.supplierServiceId, item);
  for (const record of store.supplierServiceFileFormats || []) {
    appendIndexed(index.serviceFormats, record.supplierServiceId, formatCode(record));
  }
  for (const record of store.catalogItemFileFormats || []) {
    appendIndexed(index.itemFormats, record.catalogItemId, formatCode(record));
  }
  for (const photo of store.catalogItemPhotos || []) appendIndexed(index.photosByItem, photo.catalogItemId, photo);
  for (const group of store.catalogOptionGroups || []) appendIndexed(index.catalogGroupsByItem, group.catalogItemId, group);
  for (const option of store.catalogOptions || []) appendIndexed(index.catalogOptionsByGroup, option.optionGroupId, option);
  for (const media of store.supplierShopMedia || []) appendIndexed(index.shopMediaBySupplier, media.supplierId, media);
  return index;
}

function itemFormatCodes(store, itemId, index) {
  if (index) return index.itemFormats.get(itemId) || [];
  return (store.catalogItemFileFormats || []).filter((record) => record.catalogItemId === itemId).map(formatCode);
}

function serviceFormatCodes(store, serviceId, index) {
  if (index) return index.serviceFormats.get(serviceId) || [];
  return (store.supplierServiceFileFormats || []).filter((record) => record.supplierServiceId === serviceId).map(formatCode);
}

function activeFormatRegistry(store, index) {
  if (index) return index.activeFormats;
  return new Map((store.acceptedFileFormats || [])
    .filter((format) => format.active !== false)
    .map((format) => [format.code, format]));
}

function approvalStatus(store, supplierId, index) {
  if (index) return index.approvals.get(supplierId) || null;
  return (store.approvalCases || []).find(
    (approvalCase) => approvalCase.userId === supplierId && approvalCase.kind === "supplier",
  )?.status || null;
}

function hasSupplierMembership(store, supplierId, index) {
  if (index) return index.supplierMemberships.has(supplierId);
  return (store.userRoleMemberships || []).some(
    (membership) => membership.userId === supplierId && membership.role === "supplier",
  );
}

function canonicalCategoryCode(store, code) {
  const direct = (store.taxonomy?.categories || []).find((category) => category.code === code);
  if (direct) return direct.code;
  const alias = (store.taxonomy?.categoryAliases || []).find(
    (candidate) => candidate.active !== false && candidate.code === code,
  );
  return alias?.categoryCode || code;
}

function activeCanonicalCategoryCode(store, code) {
  const direct = (store.taxonomy?.categories || []).find(
    (category) => category.active !== false && category.code === code,
  );
  if (direct) return direct.code;
  const alias = (store.taxonomy?.categoryAliases || []).find(
    (candidate) => candidate.active !== false && candidate.code === code,
  );
  if (!alias) return null;
  return (store.taxonomy?.categories || []).find(
    (category) => category.active !== false && category.code === alias.categoryCode,
  )?.code || null;
}

function activeCategory(store, code) {
  const canonicalCode = activeCanonicalCategoryCode(store, code);
  if (!canonicalCode) return null;
  return (store.taxonomy?.categories || []).find(
    (category) => category.active !== false && category.code === canonicalCode,
  ) || null;
}

function governedCodeBlockers(values, prefix, allowed, { requireComplete }) {
  if (!Array.isArray(values)) return [`${prefix}_type`];
  const normalized = values.map((value) => String(value).trim());
  const blockers = [];
  if (normalized.some((value) => !value)) blockers.push(`${prefix}_blank`);
  if (new Set(normalized).size !== normalized.length) blockers.push(`${prefix}_duplicate`);
  if (requireComplete && normalized.length === 0) blockers.push(prefix);
  for (const code of normalized) {
    if (code && !allowed.has(code)) blockers.push(`${prefix}:${code}`);
  }
  return [...new Set(blockers)];
}

export function supplierServiceCapabilityBlockers(store, service, { requireComplete = true } = {}) {
  const category = activeCategory(store, service?.categoryCode);
  if (!category) return ["service_category"];
  const categoryCode = category.code;
  const activeMaterials = new Set((store.taxonomy?.materials || [])
    .filter((record) => record.active !== false && (record.categoryCodes || []).includes(categoryCode))
    .map((record) => record.code));
  const activeFinishes = new Set((store.taxonomy?.finishes || [])
    .filter((record) => record.active !== false && (record.categoryCodes || []).includes(categoryCode))
    .map((record) => record.code));
  const activeZones = new Set((store.zones || [])
    .filter((record) => record.active !== false)
    .map((record) => record.code));
  const blockers = [
    ...governedCodeBlockers(
      service?.productFamilyIds,
      "product_families",
      new Set(category.productFamilyIds || []),
      { requireComplete },
    ),
    ...governedCodeBlockers(service?.materialCodes, "materials", activeMaterials, { requireComplete }),
    ...governedCodeBlockers(service?.finishCodes, "finishes", activeFinishes, { requireComplete }),
    ...governedCodeBlockers(service?.zones, "zones", activeZones, { requireComplete }),
  ];
  const positiveIntegerFields = ["qtyMin", "qtyMax", "capacityDaily", "capacityWeekly"];
  for (const field of positiveIntegerFields) {
    if (service?.[field] != null && (
      !Number.isSafeInteger(service[field])
      || service[field] < 1
      || service[field] > POSTGRES_INTEGER_MAX
    )) blockers.push(field);
  }
  if (Number.isSafeInteger(service?.qtyMin) && Number.isSafeInteger(service?.qtyMax)
      && service.qtyMax < service.qtyMin) blockers.push("quantity_range");
  if (Number.isSafeInteger(service?.capacityDaily) && Number.isSafeInteger(service?.capacityWeekly)
      && service.capacityWeekly < service.capacityDaily) blockers.push("capacity_range");
  if ((service?.sizeMin == null) !== (service?.sizeMax == null)) blockers.push("size_range");
  return blockers;
}

function readyFile(store, fileId, index) {
  if (index) return index.readyFiles.get(fileId) || null;
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

export function assertSupplierServiceLifecycleMutationAllowed(store, service) {
  const approvalCase = (store.approvalCases || []).find(
    (candidate) => candidate.userId === service?.supplierId && candidate.kind === "supplier",
  );
  if (approvalCase?.status === "suspended") {
    throw new CatalogError(
      409,
      "service_account_suspended",
      "Operations must restore the suspended supplier account before service lifecycle changes.",
      { approvalCaseId: approvalCase.id },
    );
  }
}

function clearSupplierServiceLifecycleMetadata(service) {
  service.verifiedAt = null;
  service.verifiedBy = null;
  service.suspendedAt = null;
  service.suspendedBy = null;
  service.suspendReason = null;
  service.withdrawnAt = null;
}

export function transitionSupplierServiceToDraft(service) {
  clearSupplierServiceLifecycleMetadata(service);
  service.state = "draft";
}

export function transitionSupplierServiceToPending(service) {
  clearSupplierServiceLifecycleMetadata(service);
  service.state = "pending_verification";
}

export function transitionSupplierServiceToWithdrawn(service, at) {
  clearSupplierServiceLifecycleMetadata(service);
  service.state = "withdrawn";
  service.withdrawnAt = at;
}

export function transitionSupplierServiceToLive(service, at, verifiedBy) {
  clearSupplierServiceLifecycleMetadata(service);
  service.catalogManaged = true;
  service.state = "live";
  service.verifiedAt = at;
  service.verifiedBy = verifiedBy;
}

export function effectiveAcceptedFormats(store, item, { index } = {}) {
  const registry = activeFormatRegistry(store, index);
  const selected = item.fileFormatMode === "override"
    ? itemFormatCodes(store, item.id, index)
    : serviceFormatCodes(store, item.supplierServiceId, index);
  return [...new Set(selected)]
    .filter((code) => registry.has(code))
    .sort()
    .map((code) => ({ ...registry.get(code) }));
}

export function catalogGroupsForItem(store, itemId, { includeInactiveOptions = true, index } = {}) {
  const groups = index ? index.catalogGroupsByItem.get(itemId) || [] : (store.catalogOptionGroups || [])
    .filter((group) => group.catalogItemId === itemId);
  return groups
    .sort(compareSortOrder)
    .map((group) => ({
      ...group,
      options: (index ? index.catalogOptionsByGroup.get(group.id) || [] : (store.catalogOptions || [])
        .filter((option) => option.optionGroupId === group.id))
        .filter((option) => includeInactiveOptions || option.active !== false)
        .sort(compareSortOrder),
    }));
}

export function serviceLineBlockers(store, service, {
  publicOnly = false,
  formatCodes,
  index,
  allowedStates = ["pending_verification", "live"],
  requireActiveCategory = false,
} = {}) {
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
  const acceptedFormatCodes = formatCodes ?? serviceFormatCodes(store, service?.id, index);
  if (acceptedFormatCodes.filter((code) => activeFormatRegistry(store, index).has(code)).length === 0) {
    blockers.push("accepted_file_formats");
  }
  if (publicOnly || requireActiveCategory) {
    if (!activeCanonicalCategoryCode(store, service?.categoryCode)) blockers.push("service_category");
  }
  if (!publicOnly || service?.catalogManaged === true) {
    blockers.push(...supplierServiceCapabilityBlockers(store, service));
  }
  if (publicOnly) {
    if (service?.state !== "live") blockers.push("service_not_live");
  }
  if (!publicOnly && service && !allowedStates.includes(service.state)) {
    blockers.push("service_not_review_ready");
  }
  return [...new Set(blockers)];
}

export function assertServiceLineReviewReady(store, service, options) {
  const blockers = serviceLineBlockers(store, { ...service, state: "pending_verification" }, options);
  if (blockers.length) {
    throw new CatalogError(
      409,
      "service_not_review_ready",
      "Complete the service before submitting it for review.",
      { blockers },
    );
  }
}

export function assertSupplierServicePendingVerification(service) {
  if (service?.state !== "pending_verification") {
    throw new CatalogError(
      409,
      "invalid_service_state",
      "Submit the service for verification before publishing it.",
      { currentState: service?.state ?? null, requiredState: "pending_verification" },
    );
  }
}

export function assertServiceLineReadinessInvariant(store, service, options) {
  if (["draft", "withdrawn"].includes(service.state)) return;
  assertServiceLineReviewReady(store, service, options);
}

export function catalogItemBlockers(store, item, {
  publicOnly = false,
  index,
  allowedServiceStates,
  requireActiveCategory = false,
} = {}) {
  const blockers = [];
  const service = index
    ? index.servicesById.get(item?.supplierServiceId)
    : (store.supplierServices || []).find((candidate) => candidate.id === item?.supplierServiceId);
  if (!item || !service || service.supplierId !== item.supplierId) return ["owning_service"];
  if (!String(item.name || "").trim()) blockers.push("name");
  if (!Number.isSafeInteger(item.basePriceMinor) || item.basePriceMinor < 0) blockers.push("base_price");
  if (serviceLineBlockers(store, service, {
    publicOnly,
    index,
    allowedStates: allowedServiceStates,
    requireActiveCategory,
  }).length) blockers.push("service_line");
  if (effectiveAcceptedFormats(store, item, { index }).length === 0) blockers.push("accepted_file_formats");
  const photos = (index ? index.photosByItem.get(item.id) || [] : (store.catalogItemPhotos || [])
    .filter((photo) => photo.catalogItemId === item.id))
    .filter((photo) => readyFile(store, photo.fileId, index));
  if (photos.length === 0) blockers.push("photo");
  for (const group of catalogGroupsForItem(store, item.id, { index })) {
    if (!group.options.some((option) => option.active !== false)) blockers.push(`option_group:${group.id}`);
    for (const option of group.options.filter((candidate) => candidate.active !== false)) {
      try {
        validateSpecBinding(store, service, option.specBinding);
      } catch (error) {
        if (!(error instanceof CatalogError) || error.code !== "invalid_spec_binding") throw error;
        blockers.push(`option_spec_binding:${option.id}`);
      }
    }
  }
  if (publicOnly) {
    if (item.active === false) blockers.push("item_inactive");
    if (!hasSupplierMembership(store, item.supplierId, index)) blockers.push("supplier_membership");
    if (approvalStatus(store, item.supplierId, index) !== "approved") blockers.push("supplier_not_approved");
  }
  return blockers;
}

export function supplierCatalogTransitionReadiness(store, supplierId, { restoring }) {
  const approvalCase = (store.approvalCases || []).find(
    (candidate) => candidate.userId === supplierId && candidate.kind === "supplier",
  );
  const missing = [];
  const profile = (store.supplierProfiles || []).find((candidate) => candidate.userId === supplierId);
  if (!profile || !String(profile.shopName || "").trim() || !String(profile.contactName || "").trim()
      || !profile.shop || !String(profile.shop.label || "").trim()
      || !Number.isFinite(profile.shop.lat) || profile.shop.lat < -90 || profile.shop.lat > 90
      || !Number.isFinite(profile.shop.lng) || profile.shop.lng < -180 || profile.shop.lng > 180) {
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

  const allowedServiceStates = restoring
    ? ["suspended", "pending_verification"]
    : ["pending_verification"];
  const services = (store.supplierServices || []).filter((service) => service.supplierId === supplierId);
  const candidates = services.filter((service) => restoring
    ? (service.state === "suspended" && service.approvalSuspensionCaseId === approvalCase?.id)
      || service.state === "pending_verification"
    : service.state === "pending_verification");
  const candidateIds = new Set(candidates.map((service) => service.id));
  const reviewReady = candidates.filter((service) => serviceLineBlockers(store, service, {
    allowedStates: allowedServiceStates,
    requireActiveCategory: true,
  }).length === 0);

  const activeItems = (store.catalogItems || []).filter(
    (item) => item.supplierId === supplierId && item.active !== false && candidateIds.has(item.supplierServiceId),
  );
  const blockersForItem = (item) => {
    return catalogItemBlockers(store, item, {
      allowedServiceStates,
      requireActiveCategory: true,
    });
  };
  const completeItems = activeItems.filter((item) => blockersForItem(item).length === 0);
  const completeServiceIds = new Set(completeItems.map((item) => item.supplierServiceId));
  const publishableServiceIds = reviewReady
    .filter((service) => completeServiceIds.has(service.id))
    .map((service) => service.id);
  if (publishableServiceIds.length === 0) {
    if (reviewReady.length === 0) missing.push("review_ready_service");
    if (completeItems.length === 0) missing.push("active_catalog_item");
    for (const item of activeItems) {
      for (const blocker of blockersForItem(item)) missing.push(`catalog_item:${item.id}:${blocker}`);
    }
  }

  const hasShopMedia = (store.supplierShopMedia || [])
    .some((media) => media.supplierId === supplierId && readyFile(store, media.fileId));
  if (!hasShopMedia) missing.push("shop_identity_media");
  return { readyForApproval: missing.length === 0, missing, publishableServiceIds };
}

export function supplierCatalogPublicationReadiness(store, supplierId) {
  return supplierCatalogTransitionReadiness(store, supplierId, { restoring: false });
}

export function supplierCatalogReadiness(store, supplierId) {
  const approvalCase = (store.approvalCases || []).find(
    (candidate) => candidate.userId === supplierId && candidate.kind === "supplier",
  );
  if (approvalCase?.status === "approved") {
    return { readyForApproval: true, missing: [], publishableServiceIds: [] };
  }
  return supplierCatalogTransitionReadiness(store, supplierId, {
    restoring: approvalCase?.status === "suspended",
  });
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

function publicPhotos(store, itemId, index) {
  const photos = index ? index.photosByItem.get(itemId) || [] : (store.catalogItemPhotos || [])
    .filter((photo) => photo.catalogItemId === itemId);
  return photos
    .sort(compareSortOrder)
    .flatMap((photo) => {
      const file = readyFile(store, photo.fileId, index);
      return file ? [mediaProjection(file, { sortOrder: photo.sortOrder, altText: photo.altText ?? null })] : [];
    });
}

function publicShopMedia(store, supplierId, index) {
  const mediaRecords = index ? index.shopMediaBySupplier.get(supplierId) || [] : (store.supplierShopMedia || [])
    .filter((media) => media.supplierId === supplierId);
  return mediaRecords
    .flatMap((media) => {
      const file = readyFile(store, media.fileId, index);
      return file ? [mediaProjection(file, { slot: media.slot })] : [];
    })
    .sort((left, right) => left.slot.localeCompare(right.slot));
}

export function publicCatalogItem(store, item, { selectedOptionIds, index } = {}) {
  if (catalogItemBlockers(store, item, { publicOnly: true, index }).length) return null;
  const service = index
    ? index.servicesById.get(item.supplierServiceId)
    : store.supplierServices.find((candidate) => candidate.id === item.supplierServiceId);
  const groups = catalogGroupsForItem(store, item.id, { includeInactiveOptions: false, index }).map((group) => ({
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
    categoryCode: activeCanonicalCategoryCode(store, service.categoryCode),
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
    acceptedFormats: effectiveAcceptedFormats(store, item, { index }),
    photos: publicPhotos(store, item.id, index),
    optionGroups: groups,
    version: item.version,
    serviceVersion: service.version,
  };
}

export function publicSupplierShop(store, supplierId) {
  const index = buildCatalogIndex(store);
  if (!hasSupplierMembership(store, supplierId, index) || approvalStatus(store, supplierId, index) !== "approved") return null;
  const profile = (store.supplierProfiles || []).find((candidate) => candidate.userId === supplierId);
  if (!profile) return null;
  const services = (index.servicesBySupplier.get(supplierId) || [])
    .filter((service) => service.state === "live")
    .sort(compareSortOrder)
    .map((service) => {
      const items = (index.catalogItemsByService.get(service.id) || [])
        .sort(compareSortOrder)
        .map((item) => publicCatalogItem(store, item, { index }))
        .filter(Boolean);
      return items.length ? {
        id: service.id,
        version: service.version,
        categoryCode: activeCanonicalCategoryCode(store, service.categoryCode),
        pricingBasis: service.pricingBasis,
        turnaroundHours: Object.hasOwn(service, "standardTurnaroundHours")
          ? service.standardTurnaroundHours
          : service.turnaroundHours,
        acceptedFormats: serviceFormatCodes(store, service.id, index)
          .filter((code) => activeFormatRegistry(store, index).has(code)).sort(),
        items,
      } : null;
    })
    .filter(Boolean);
  if (services.length === 0) return null;
  return {
    supplierId,
    shopName: profile.shopName,
    shop: profile.shop,
    media: publicShopMedia(store, supplierId, index),
    categories: [...new Set(services.map((service) => service.categoryCode))],
    services,
  };
}

export function publicSupplierShops(store, { categoryCode, cursor, limit = 20 } = {}) {
  const index = buildCatalogIndex(store);
  const shops = (store.supplierProfiles || []).flatMap((profile) => {
    if (!hasSupplierMembership(store, profile.userId, index)
        || approvalStatus(store, profile.userId, index) !== "approved") return [];
    const categories = new Set();
    let itemCount = 0;
    const services = [...(index.servicesBySupplier.get(profile.userId) || [])].sort(compareSortOrder);
    for (const service of services) {
      for (const item of index.catalogItemsByService.get(service.id) || []) {
        if (catalogItemBlockers(store, item, { publicOnly: true, index }).length) continue;
        itemCount += 1;
        categories.add(activeCanonicalCategoryCode(store, service.categoryCode));
      }
    }
    const categoryList = [...categories];
    if (itemCount === 0 || (categoryCode && !categoryList.includes(categoryCode))) return [];
    return [{
      supplierId: profile.userId,
      shopName: profile.shopName,
      shop: profile.shop,
      categories: categoryList,
      itemCount,
    }];
  }).sort((left, right) => left.supplierId.localeCompare(right.supplierId));
  const remaining = cursor ? shops.filter((shop) => shop.supplierId.localeCompare(cursor) > 0) : shops;
  const pageLimit = Math.max(0, limit);
  const page = remaining.slice(0, pageLimit);
  return {
    shops: page.map((shop) => ({ ...shop, media: publicShopMedia(store, shop.supplierId, index) })),
    nextCursor: page.length > 0 && page.length < remaining.length ? page.at(-1).supplierId : null,
  };
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
  if (selection.lineItemId != null) {
    if (typeof selection.lineItemId !== "string" || !selection.lineItemId.trim()) {
      throw new CatalogError(400, "invalid_catalog_item", "lineItemId must be a nonblank identifier.", {
        field: "lineItemId",
      });
    }
    normalized.lineItemId = selection.lineItemId.trim();
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
    throw new CatalogError(
      400,
      "expected_service_version_required",
      "expectedServiceVersion is required before checkout.",
    );
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
  if (selection.expectedServiceVersion !== service.version) {
    throw new CatalogError(409, "supplier_service_stale", "The supplier service changed. Refresh it before checkout.", {
      expectedVersion: selection.expectedServiceVersion,
      currentVersion: service.version,
    });
  }
  const order = (store.orders || []).find((candidate) => candidate.id === selection.orderId);
  if (!order) {
    throw new CatalogError(404, "order_not_found", "That order no longer exists. Refresh orders and try again.");
  }
  if (order.supplierId !== item.supplierId) {
    throw new CatalogError(409, "catalog_item_stale", "The catalog item does not belong to the order's assigned supplier.");
  }
  const { effectiveUnitPriceMinor, selectedOptions } = selectedCatalogPrice(store, item, selection.optionIds || []);
  const quantity = Number(selection.quantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > POSTGRES_INTEGER_MAX) {
    throw new CatalogError(400, "invalid_catalog_item", "quantity must be a positive PostgreSQL integer.", { field: "quantity" });
  }
  const sortOrder = orderLineSortOrder(selection.sortOrder ?? 0);
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
  if (typeof lineItemId !== "string" || !lineItemId.trim()) {
    throw new CatalogError(400, "invalid_catalog_item", "lineItemId or createId is required.", { field: "lineItemId" });
  }
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
    : orderLineSortOrder(selection.sortOrder);
  if (sortOrder > POSTGRES_INTEGER_MAX || orderLines.some((line) => line.sortOrder === sortOrder)) {
    throw new CatalogError(409, "order_line_position_conflict", "That order line position is no longer available.", {
      sortOrder,
    });
  }
  const snapshot = createOrderLineSnapshot(store, { ...selection, sortOrder }, createId);
  if (lineItems.some((line) => line.id === snapshot.lineItem.id)) {
    throw new CatalogError(409, "order_line_id_conflict", "That order line identifier is already in use.", {
      lineItemId: snapshot.lineItem.id,
    });
  }
  if (!Array.isArray(store.orderLineItems)) store.orderLineItems = lineItems;
  if (!Array.isArray(store.orderLineItemOptions)) store.orderLineItemOptions = lineOptions;
  lineItems.push(snapshot.lineItem);
  lineOptions.push(...snapshot.options);
  return structuredClone(snapshot);
}
