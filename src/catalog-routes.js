import { identityHasMembership } from "./authorization-context.js";
import {
  advanceSupplierServiceVersion,
  assertExpectedVersion,
  assertServiceLineReadinessInvariant,
  CatalogError,
  catalogGroupsForItem,
  catalogItemBlockers,
  effectiveAcceptedFormats,
  publicCatalogItem,
  publicSupplierShop,
  publicSupplierShops,
  serviceLineBlockers,
  supplierCatalogReadiness,
  transitionSupplierServiceToPending,
  validateSpecBinding,
} from "./supplier-catalog.js";

const POSTGRES_INTEGER_MIN = -2147483648;
const POSTGRES_INTEGER_MAX = 2147483647;

function fail(status, code, message, details = {}) {
  throw new CatalogError(status, code, message, details);
}

function integer(value, field, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail(400, "invalid_catalog_item", `${field} must be an integer from ${min} through ${max}.`, { field });
  }
  return parsed;
}

function postgresInteger(value, field, { min = POSTGRES_INTEGER_MIN, max = POSTGRES_INTEGER_MAX } = {}) {
  return integer(value, field, {
    min: Math.max(min, POSTGRES_INTEGER_MIN),
    max: Math.min(max, POSTGRES_INTEGER_MAX),
  });
}

function moneyMinor(value, field, options) {
  return integer(value, field, options);
}

function optionalText(value, field, maxLength) {
  const text = String(value ?? "");
  if (text.length > maxLength) fail(400, "invalid_catalog_item", `${field} is too long.`, { field, maxLength });
  return text;
}

function requiredText(value, field, maxLength = Number.MAX_SAFE_INTEGER) {
  const text = optionalText(value, field, maxLength).trim();
  if (!text) fail(400, "invalid_catalog_item", `${field} is required.`, { field });
  return text;
}

function catalogRecord(value, { code = "invalid_catalog_item", field = "body", message } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, code, message || `${field} must be a JSON object.`, { field });
  }
  return value;
}

function supplierCase(store, userId) {
  return (store.approvalCases || []).find(
    (approvalCase) => approvalCase.userId === userId && approvalCase.kind === "supplier",
  ) || null;
}

function requireSupplier(store, user) {
  if (!user || !identityHasMembership(user, "supplier")) fail(403, "forbidden", "A supplier membership is required.");
  if (supplierCase(store, user.id)?.status === "suspended") {
    fail(403, "supplier_suspended", "This supplier account is suspended and cannot change its catalog.");
  }
}

function ownService(store, user, serviceId) {
  requireSupplier(store, user);
  const service = (store.supplierServices || []).find((candidate) => candidate.id === serviceId);
  if (!service) fail(404, "service_not_found", "That supplier service no longer exists.");
  if (service.supplierId !== user.id) fail(403, "forbidden", "That supplier service belongs to another supplier.");
  return service;
}

function ownItem(store, user, itemId) {
  requireSupplier(store, user);
  const item = (store.catalogItems || []).find((candidate) => candidate.id === itemId);
  if (!item) fail(404, "catalog_item_not_found", "That catalog item no longer exists.");
  if (item.supplierId !== user.id) fail(403, "forbidden", "That catalog item belongs to another supplier.");
  return item;
}

function ownGroup(store, user, groupId) {
  requireSupplier(store, user);
  const group = (store.catalogOptionGroups || []).find((candidate) => candidate.id === groupId);
  if (!group) fail(404, "catalog_group_not_found", "That catalog option group no longer exists.");
  const item = ownItem(store, user, group.catalogItemId);
  return { group, item };
}

function activeFormatCodes(store, codes) {
  if (!Array.isArray(codes)) fail(400, "invalid_file_format", "formatCodes must be an array.");
  const unique = [...new Set(codes.map((code) => String(code).trim()))];
  if (unique.length !== codes.length || unique.some((code) => !code)) {
    fail(400, "invalid_file_format", "Choose each nonblank accepted format once.");
  }
  const active = new Set((store.acceptedFileFormats || []).filter((format) => format.active !== false).map((format) => format.code));
  const invalid = unique.find((code) => !active.has(code));
  if (invalid) fail(400, "invalid_file_format", "That accepted format is not active.", { formatCode: invalid });
  return unique.sort();
}

function formatsForService(store, serviceId) {
  const registry = new Map((store.acceptedFileFormats || []).map((format) => [format.code, format]));
  return (store.supplierServiceFileFormats || [])
    .filter((format) => format.supplierServiceId === serviceId)
    .map((format) => registry.get(format.formatCode))
    .filter(Boolean)
    .sort((left, right) => left.code.localeCompare(right.code));
}

function canonicalCategoryCode(store, code) {
  const category = (store.taxonomy?.categories || []).find(
    (candidate) => candidate.active !== false && candidate.code === code,
  );
  if (category) return category.code;
  const alias = (store.taxonomy?.categoryAliases || []).find(
    (candidate) => candidate.active !== false && candidate.code === code,
  );
  if (!alias) return null;
  return (store.taxonomy?.categories || []).find(
    (candidate) => candidate.active !== false && candidate.code === alias.categoryCode,
  )?.code || null;
}

function categoryInput(store, value) {
  const categoryCode = String(value ?? "").trim();
  const canonicalCode = canonicalCategoryCode(store, categoryCode);
  if (!categoryCode || categoryCode.length > 120 || !canonicalCode) {
    fail(400, "invalid_category_code", "Choose an active governed category.", { categoryCode });
  }
  return canonicalCode;
}

function privateService(store, service) {
  return {
    id: service.id,
    supplierId: service.supplierId,
    categoryCode: service.categoryCode,
    state: service.state,
    pricingBasis: service.pricingBasis,
    standardTurnaroundHours: service.standardTurnaroundHours,
    rushEnabled: service.rushEnabled,
    rushTurnaroundHours: service.rushTurnaroundHours,
    rushPriceMinor: service.rushPriceMinor,
    acceptedFormats: formatsForService(store, service.id),
    pricing: (store.supplierServicePriceTiers || [])
      .filter((tier) => tier.supplierServiceId === service.id)
      .sort((left, right) => left.sortOrder - right.sortOrder),
    reviewReady: serviceLineBlockers(store, service).length === 0,
    blockers: serviceLineBlockers(store, service),
    version: service.version,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
  };
}

function privateItem(store, item) {
  return {
    ...item,
    acceptedFormats: effectiveAcceptedFormats(store, item),
    photos: (store.catalogItemPhotos || [])
      .filter((photo) => photo.catalogItemId === item.id)
      .sort((left, right) => left.sortOrder - right.sortOrder),
    optionGroups: catalogGroupsForItem(store, item.id),
    complete: catalogItemBlockers(store, item).length === 0,
    blockers: catalogItemBlockers(store, item),
  };
}

function opaqueCursor(value) {
  return value ? Buffer.from(JSON.stringify({ after: value })).toString("base64url") : null;
}

function parseCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return typeof parsed.after === "string" && parsed.after ? parsed.after : null;
  } catch {
    fail(400, "invalid_cursor", "The catalog cursor is invalid. Start again without it.");
  }
}

function selectedOptionIds(url) {
  if (!url.searchParams.has("optionIds")) return undefined;
  return url.searchParams.getAll("optionIds")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function auditChange(audit, store, user, action, entityType, entityId, detail) {
  audit(store, { actor: user, action, entityType, entityId, detail });
}

export async function routeSupplierCatalog({ req, url, store, user, readBody, id, now, audit }) {
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/catalog/shops") {
    const categoryCode = url.searchParams.has("categoryCode")
      ? categoryInput(store, url.searchParams.get("categoryCode"))
      : undefined;
    const page = publicSupplierShops(store, {
      categoryCode,
      cursor: parseCursor(url.searchParams.get("cursor")),
    });
    return { status: 200, body: { ...page, nextCursor: opaqueCursor(page.nextCursor) } };
  }
  if (req.method === "GET" && /^\/catalog\/shops\/[^/]+$/.test(pathname)) {
    const shop = publicSupplierShop(store, decodeURIComponent(pathname.split("/")[3]));
    return shop
      ? { status: 200, body: { shop } }
      : { status: 404, body: { error: "shop_not_found" } };
  }
  if (req.method === "GET" && /^\/catalog\/items\/[^/]+$/.test(pathname)) {
    const item = (store.catalogItems || []).find((candidate) => candidate.id === decodeURIComponent(pathname.split("/")[3]));
    const projected = item ? publicCatalogItem(store, item, { selectedOptionIds: selectedOptionIds(url) }) : null;
    return projected
      ? { status: 200, body: { item: projected } }
      : { status: 404, body: { error: "catalog_item_not_found" } };
  }

  if (req.method === "GET" && pathname === "/me/supplier-readiness") {
    requireSupplier(store, user);
    return { status: 200, body: { readiness: supplierCatalogReadiness(store, user.id) } };
  }

  if (req.method === "GET" && pathname === "/me/supplier-services") {
    requireSupplier(store, user);
    return {
      status: 200,
      body: { services: (store.supplierServices || []).filter((service) => service.supplierId === user.id).map((service) => privateService(store, service)) },
    };
  }
  if (req.method === "POST" && pathname === "/me/supplier-services") {
    requireSupplier(store, user);
    const body = catalogRecord(await readBody(req));
    const canonicalCode = categoryInput(store, body.categoryCode);
    const ts = now();
    const standardTurnaroundHours = body.standardTurnaroundHours == null
      ? 48 : postgresInteger(body.standardTurnaroundHours, "standardTurnaroundHours", { min: 1 });
    const service = {
      id: id("svc"), supplierId: user.id, categoryCode: canonicalCode, state: "draft",
      referenceRateMinor: 0, turnaroundHours: standardTurnaroundHours,
      pricingBasis: body.pricingBasis == null ? null : requiredText(body.pricingBasis, "pricingBasis", 80),
      standardTurnaroundHours,
      rushEnabled: Boolean(body.rushEnabled),
      rushTurnaroundHours: body.rushEnabled
        ? postgresInteger(body.rushTurnaroundHours, "rushTurnaroundHours", { min: 1 }) : null,
      rushPriceMinor: body.rushEnabled
        ? moneyMinor(body.rushPriceMinor, "rushPriceMinor", { min: 0 }) : null,
      version: 1, createdAt: ts, updatedAt: ts,
    };
    store.supplierServices.push(service);
    const codes = activeFormatCodes(store, body.formatCodes || []);
    store.supplierServiceFileFormats.push(...codes.map((formatCode) => ({ supplierServiceId: service.id, formatCode })));
    auditChange(audit, store, user, "supplier_service.create", "supplier_service", service.id, { categoryCode: canonicalCode });
    return { status: 201, body: { service: privateService(store, service) }, mutated: true };
  }
  if (/^\/me\/supplier-services\/[^/]+$/.test(pathname)) {
    const serviceId = decodeURIComponent(pathname.split("/")[3]);
    const service = ownService(store, user, serviceId);
    if (req.method === "GET") return { status: 200, body: { service: privateService(store, service) } };
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "supplier_service_stale", service.version);
    if (req.method === "DELETE") {
      service.state = "withdrawn";
      advanceSupplierServiceVersion(service, now());
      auditChange(audit, store, user, "supplier_service.withdraw", "supplier_service", service.id);
      return { status: 200, body: { service: privateService(store, service) }, mutated: true };
    }
    if (req.method === "PATCH") {
      const priorCategory = service.categoryCode;
      if (body.categoryCode != null) {
        service.categoryCode = categoryInput(store, body.categoryCode);
      }
      if (body.pricingBasis != null) service.pricingBasis = requiredText(body.pricingBasis, "pricingBasis", 80);
      if (body.standardTurnaroundHours != null) {
        service.standardTurnaroundHours = postgresInteger(body.standardTurnaroundHours, "standardTurnaroundHours", { min: 1 });
        service.turnaroundHours = service.standardTurnaroundHours;
      }
      if (body.rushEnabled != null) service.rushEnabled = Boolean(body.rushEnabled);
      if (service.rushEnabled) {
        if (body.rushTurnaroundHours != null) service.rushTurnaroundHours = postgresInteger(body.rushTurnaroundHours, "rushTurnaroundHours", { min: 1 });
        if (body.rushPriceMinor != null) service.rushPriceMinor = moneyMinor(body.rushPriceMinor, "rushPriceMinor", { min: 0 });
        if (!Number.isSafeInteger(service.rushTurnaroundHours) || !Number.isSafeInteger(service.rushPriceMinor)) {
          fail(400, "invalid_catalog_item", "Rush turnaround and price are required when rush is enabled.");
        }
      } else {
        service.rushTurnaroundHours = null;
        service.rushPriceMinor = null;
      }
      if (body.state != null) {
        if (!['draft', 'pending_verification'].includes(body.state)) {
          fail(400, "invalid_service_state", "Suppliers may set a service only to draft or pending_verification.");
        }
        if (body.state === "pending_verification") transitionSupplierServiceToPending(service);
        else service.state = body.state;
      }
      if (service.state === "live" && service.categoryCode !== priorCategory) {
        transitionSupplierServiceToPending(service);
      }
      assertServiceLineReadinessInvariant(store, service);
      advanceSupplierServiceVersion(service, now());
      auditChange(audit, store, user, "supplier_service.update", "supplier_service", service.id, { state: service.state });
      return { status: 200, body: { service: privateService(store, service) }, mutated: true };
    }
  }

  if (/^\/me\/supplier-services\/[^/]+\/file-formats$/.test(pathname)) {
    const service = ownService(store, user, decodeURIComponent(pathname.split("/")[3]));
    if (req.method !== "PUT") return null;
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "supplier_service_stale", service.version);
    const codes = activeFormatCodes(store, body.formatCodes);
    const previous = new Set((store.supplierServiceFileFormats || [])
      .filter((record) => record.supplierServiceId === service.id).map((record) => record.formatCode));
    assertServiceLineReadinessInvariant(store, service, { formatCodes: codes });
    store.supplierServiceFileFormats = (store.supplierServiceFileFormats || [])
      .filter((record) => record.supplierServiceId !== service.id);
    store.supplierServiceFileFormats.push(...codes.map((formatCode) => ({ supplierServiceId: service.id, formatCode })));
    if (service.state === "live" && codes.some((code) => !previous.has(code))) {
      transitionSupplierServiceToPending(service);
    }
    advanceSupplierServiceVersion(service, now());
    auditChange(audit, store, user, "supplier_service.formats_update", "supplier_service", service.id, { formatCodes: codes });
    return { status: 200, body: { service: privateService(store, service) }, mutated: true };
  }

  if (/^\/me\/supplier-services\/[^/]+\/pricing$/.test(pathname)) {
    const service = ownService(store, user, decodeURIComponent(pathname.split("/")[3]));
    if (req.method === "GET") return { status: 200, body: { pricing: privateService(store, service).pricing, version: service.version } };
    if (req.method !== "PUT") return null;
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "supplier_service_stale", service.version);
    if (!Array.isArray(body.tiers)) fail(400, "invalid_service_pricing", "tiers must be an array.");
    const codes = new Set();
    const positions = new Set();
    const tiers = body.tiers.map((candidate) => {
      const tier = catalogRecord(candidate, {
        code: "invalid_service_pricing",
        field: "tiers",
        message: "Every tier must be a JSON object.",
      });
      const tierCode = requiredText(tier.tierCode, "tierCode", 80);
      const sortOrder = postgresInteger(tier.sortOrder, "sortOrder", { min: 0 });
      if (codes.has(tierCode) || positions.has(sortOrder)) fail(400, "invalid_service_pricing", "Tier codes and sort orders must be unique.");
      codes.add(tierCode); positions.add(sortOrder);
      const minQuantity = postgresInteger(tier.minQuantity ?? 1, "minQuantity", { min: 1 });
      const maxQuantity = tier.maxQuantity == null ? null : postgresInteger(tier.maxQuantity, "maxQuantity", { min: minQuantity });
      const colorTier = tier.colorTier == null ? null : String(tier.colorTier);
      if (colorTier != null && !["greyscale", "color"].includes(colorTier)) fail(400, "invalid_service_pricing", "colorTier must be greyscale or color.");
      return {
        id: id("spt"), supplierServiceId: service.id, tierCode, colorTier,
        minQuantity, maxQuantity, unitPriceMinor: moneyMinor(tier.unitPriceMinor, "unitPriceMinor", { min: 0 }), sortOrder,
      };
    });
    store.supplierServicePriceTiers = (store.supplierServicePriceTiers || []).filter((tier) => tier.supplierServiceId !== service.id);
    store.supplierServicePriceTiers.push(...tiers);
    advanceSupplierServiceVersion(service, now());
    auditChange(audit, store, user, "supplier_service.pricing_update", "supplier_service", service.id, { tierCount: tiers.length });
    return { status: 200, body: { pricing: tiers, version: service.version }, mutated: true };
  }

  if (req.method === "GET" && pathname === "/me/catalog-items") {
    requireSupplier(store, user);
    return { status: 200, body: { items: (store.catalogItems || []).filter((item) => item.supplierId === user.id).map((item) => privateItem(store, item)) } };
  }
  if (req.method === "POST" && pathname === "/me/catalog-items") {
    requireSupplier(store, user);
    const body = catalogRecord(await readBody(req));
    const service = ownService(store, user, body.supplierServiceId);
    if (service.state === "withdrawn") fail(409, "service_withdrawn", "Choose an active supplier service.");
    const fileFormatMode = body.fileFormatMode || "inherit";
    if (!["inherit", "override"].includes(fileFormatMode)) fail(400, "invalid_file_format_mode", "Choose inherit or override.");
    const formatCodes = activeFormatCodes(store, body.formatCodes || []);
    if (fileFormatMode === "inherit" && formatCodes.length) fail(400, "invalid_file_format_mode", "Inherited items cannot store item format rows.");
    if (fileFormatMode === "override" && formatCodes.length === 0) fail(400, "invalid_file_format", "Override mode requires at least one active accepted format.");
    const ts = now();
    const item = {
      id: id("cat"), supplierId: user.id, supplierServiceId: service.id,
      name: requiredText(body.name, "name"), description: optionalText(body.description, "description", 4000),
      basePriceMinor: moneyMinor(body.basePriceMinor, "basePriceMinor", { min: 0 }),
      fileFormatMode, active: body.active !== false,
      sortOrder: postgresInteger(body.sortOrder ?? 0, "sortOrder", { min: 0 }),
      version: 1, createdAt: ts, updatedAt: ts,
    };
    store.catalogItems.push(item);
    store.catalogItemFileFormats.push(...formatCodes.map((formatCode) => ({ catalogItemId: item.id, formatCode })));
    auditChange(audit, store, user, "catalog_item.create", "supplier_catalog_item", item.id, { serviceId: service.id });
    return { status: 201, body: { item: privateItem(store, item) }, mutated: true };
  }
  if (/^\/me\/catalog-items\/[^/]+$/.test(pathname)) {
    const item = ownItem(store, user, decodeURIComponent(pathname.split("/")[3]));
    if (req.method === "GET") return { status: 200, body: { item: privateItem(store, item) } };
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "catalog_item_stale", item.version);
    if (req.method === "DELETE") {
      const referenced = (store.orderLineItems || []).some((line) => line.sourceCatalogItemId === item.id);
      if (referenced) {
        item.active = false;
        item.version += 1;
        item.updatedAt = now();
      } else {
        store.catalogItems = store.catalogItems.filter((candidate) => candidate.id !== item.id);
        store.catalogItemPhotos = store.catalogItemPhotos.filter((photo) => photo.catalogItemId !== item.id);
        const groupIds = new Set(store.catalogOptionGroups.filter((group) => group.catalogItemId === item.id).map((group) => group.id));
        store.catalogOptionGroups = store.catalogOptionGroups.filter((group) => group.catalogItemId !== item.id);
        store.catalogOptions = store.catalogOptions.filter((option) => !groupIds.has(option.optionGroupId));
        store.catalogItemFileFormats = store.catalogItemFileFormats.filter((format) => format.catalogItemId !== item.id);
      }
      auditChange(audit, store, user, "catalog_item.delete", "supplier_catalog_item", item.id, { archived: referenced });
      return { status: 200, body: { ok: true, archived: referenced }, mutated: true };
    }
    if (req.method === "PATCH") {
      if (body.name != null) item.name = requiredText(body.name, "name");
      if (body.description != null) item.description = optionalText(body.description, "description", 4000);
      if (body.basePriceMinor != null) item.basePriceMinor = moneyMinor(body.basePriceMinor, "basePriceMinor", { min: 0 });
      if (body.active != null) item.active = Boolean(body.active);
      if (body.sortOrder != null) item.sortOrder = postgresInteger(body.sortOrder, "sortOrder", { min: 0 });
      if (body.fileFormatMode != null && body.fileFormatMode !== item.fileFormatMode) {
        fail(400, "invalid_file_format_mode", "Use the item file-formats endpoint to change inheritance mode atomically.");
      }
      item.version += 1;
      item.updatedAt = now();
      auditChange(audit, store, user, "catalog_item.update", "supplier_catalog_item", item.id);
      return { status: 200, body: { item: privateItem(store, item) }, mutated: true };
    }
  }

  if (/^\/me\/catalog-items\/[^/]+\/file-formats$/.test(pathname)) {
    if (req.method !== "PUT") return null;
    const item = ownItem(store, user, decodeURIComponent(pathname.split("/")[3]));
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "catalog_item_stale", item.version);
    const mode = String(body.mode || "");
    if (!["inherit", "override"].includes(mode)) fail(400, "invalid_file_format_mode", "Choose inherit or override.");
    const codes = activeFormatCodes(store, body.formatCodes || []);
    if (mode === "inherit" && codes.length) fail(400, "invalid_file_format_mode", "Inherited items cannot store item format rows.");
    if (mode === "override" && codes.length === 0) fail(400, "invalid_file_format", "Override mode requires at least one active accepted format.");
    store.catalogItemFileFormats = store.catalogItemFileFormats.filter((format) => format.catalogItemId !== item.id);
    store.catalogItemFileFormats.push(...codes.map((formatCode) => ({ catalogItemId: item.id, formatCode })));
    item.fileFormatMode = mode;
    item.version += 1;
    item.updatedAt = now();
    auditChange(audit, store, user, "catalog_item.formats_update", "supplier_catalog_item", item.id, { mode, formatCodes: codes });
    return { status: 200, body: { item: privateItem(store, item) }, mutated: true };
  }

  if (/^\/me\/catalog-items\/[^/]+\/photos\/reorder$/.test(pathname)) {
    if (req.method !== "POST") return null;
    const item = ownItem(store, user, decodeURIComponent(pathname.split("/")[3]));
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "catalog_item_stale", item.version);
    if (!Array.isArray(body.fileIds)) fail(400, "invalid_photo_order", "fileIds must be an array.");
    const current = store.catalogItemPhotos.filter((photo) => photo.catalogItemId === item.id);
    if (body.fileIds.length !== current.length || new Set(body.fileIds).size !== current.length
        || body.fileIds.some((fileId) => !current.some((photo) => photo.fileId === fileId))) {
      fail(409, "catalog_item_stale", "The photo set changed. Refresh it before reordering.");
    }
    body.fileIds.forEach((fileId, sortOrder) => {
      current.find((photo) => photo.fileId === fileId).sortOrder = sortOrder;
    });
    item.version += 1;
    item.updatedAt = now();
    auditChange(audit, store, user, "catalog_item.photos_reorder", "supplier_catalog_item", item.id);
    return { status: 200, body: { item: privateItem(store, item) }, mutated: true };
  }

  if (/^\/me\/catalog-items\/[^/]+\/option-groups(?:\/[^/]+)?$/.test(pathname)) {
    const parts = pathname.split("/");
    const item = ownItem(store, user, decodeURIComponent(parts[3]));
    const groupId = parts[5] ? decodeURIComponent(parts[5]) : null;
    if (req.method === "POST" && !groupId) {
      const body = catalogRecord(await readBody(req));
      assertExpectedVersion(req, body, "catalog_item_stale", item.version);
      if (!Array.isArray(body.options) || body.options.length === 0) {
        fail(400, "invalid_catalog_options", "Create an option group with at least one active option.");
      }
      const sortOrder = postgresInteger(body.sortOrder, "sortOrder", { min: 0, max: 5 });
      const name = requiredText(body.name, "name", 80);
      if (store.catalogOptionGroups.some((group) => group.catalogItemId === item.id && group.sortOrder === sortOrder)) {
        fail(409, "catalog_group_exists", "That option-group sort position is already used.");
      }
      if (store.catalogOptionGroups.some((group) => group.catalogItemId === item.id && group.name.toLowerCase() === name.toLowerCase())) {
        fail(409, "catalog_group_exists", "That option-group name is already used.");
      }
      const ts = now();
      const group = {
        id: id("cog"), catalogItemId: item.id, name,
        required: body.required !== false, selectionMode: "single", sortOrder,
        version: 1, createdAt: ts, updatedAt: ts,
      };
      const labels = new Set();
      const positions = new Set();
      const options = body.options.map((value) => {
        const candidate = catalogRecord(value, {
          code: "invalid_catalog_options",
          field: "options",
          message: "Every option must be a JSON object.",
        });
        const label = requiredText(candidate.label, "label", 100);
        const position = postgresInteger(candidate.sortOrder, "sortOrder", { min: 0, max: 19 });
        if (labels.has(label.toLowerCase()) || positions.has(position)) fail(400, "invalid_catalog_options", "Option labels and sort orders must be unique within a group.");
        labels.add(label.toLowerCase()); positions.add(position);
        return {
          id: id("cop"), optionGroupId: group.id, label,
          priceModifierMinor: moneyMinor(candidate.priceModifierMinor ?? 0, "priceModifierMinor"),
          specBinding: validateSpecBinding(store, store.supplierServices.find((service) => service.id === item.supplierServiceId), candidate.specBinding),
          active: candidate.active !== false, sortOrder: position, createdAt: ts, updatedAt: ts,
        };
      });
      if (!options.some((option) => option.active)) fail(400, "invalid_catalog_options", "An option group requires an active option.");
      store.catalogOptionGroups.push(group);
      store.catalogOptions.push(...options);
      item.version += 1;
      item.updatedAt = ts;
      auditChange(audit, store, user, "catalog_group.create", "supplier_catalog_option_group", group.id);
      return { status: 201, body: { group: catalogGroupsForItem(store, item.id).find((candidate) => candidate.id === group.id), itemVersion: item.version }, mutated: true };
    }
    if (groupId) {
      const group = store.catalogOptionGroups.find((candidate) => candidate.id === groupId && candidate.catalogItemId === item.id);
      if (!group) fail(404, "catalog_group_not_found", "That option group no longer exists.");
      const body = catalogRecord(await readBody(req));
      assertExpectedVersion(req, body, "catalog_group_stale", group.version);
      if (req.method === "DELETE") {
        store.catalogOptionGroups = store.catalogOptionGroups.filter((candidate) => candidate.id !== group.id);
        store.catalogOptions = store.catalogOptions.filter((option) => option.optionGroupId !== group.id);
        item.version += 1;
        item.updatedAt = now();
        auditChange(audit, store, user, "catalog_group.delete", "supplier_catalog_option_group", group.id);
        return { status: 200, body: { ok: true, itemVersion: item.version }, mutated: true };
      }
      if (req.method === "PATCH") {
        if (body.name != null) {
          const name = requiredText(body.name, "name", 80);
          if (store.catalogOptionGroups.some((candidate) => candidate.catalogItemId === item.id && candidate.id !== group.id && candidate.name.toLowerCase() === name.toLowerCase())) {
            fail(409, "catalog_group_exists", "That option-group name is already used.");
          }
          group.name = name;
        }
        if (body.required != null) group.required = Boolean(body.required);
        if (body.sortOrder != null) {
          const sortOrder = postgresInteger(body.sortOrder, "sortOrder", { min: 0, max: 5 });
          if (store.catalogOptionGroups.some((candidate) => candidate.catalogItemId === item.id && candidate.id !== group.id && candidate.sortOrder === sortOrder)) {
            fail(409, "catalog_group_exists", "That option-group sort position is already used.");
          }
          group.sortOrder = sortOrder;
        }
        group.version += 1;
        group.updatedAt = now();
        item.version += 1;
        item.updatedAt = group.updatedAt;
        auditChange(audit, store, user, "catalog_group.update", "supplier_catalog_option_group", group.id);
        return { status: 200, body: { group: catalogGroupsForItem(store, item.id).find((candidate) => candidate.id === group.id), itemVersion: item.version }, mutated: true };
      }
    }
  }

  if (/^\/me\/catalog-option-groups\/[^/]+\/options(?:\/[^/]+)?$/.test(pathname)) {
    const parts = pathname.split("/");
    const { group, item } = ownGroup(store, user, decodeURIComponent(parts[3]));
    const optionId = parts[5] ? decodeURIComponent(parts[5]) : null;
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "catalog_group_stale", group.version);
    if (req.method === "POST" && !optionId) {
      const sortOrder = postgresInteger(body.sortOrder, "sortOrder", { min: 0, max: 19 });
      const label = requiredText(body.label, "label", 100);
      if (store.catalogOptions.some((option) => option.optionGroupId === group.id && option.sortOrder === sortOrder)) {
        fail(409, "catalog_option_exists", "That option sort position is already used.");
      }
      if (store.catalogOptions.some((option) => option.optionGroupId === group.id && option.label.toLowerCase() === label.toLowerCase())) {
        fail(409, "catalog_option_exists", "That option label is already used.");
      }
      const service = store.supplierServices.find((candidate) => candidate.id === item.supplierServiceId);
      const ts = now();
      const option = {
        id: id("cop"), optionGroupId: group.id, label,
        priceModifierMinor: moneyMinor(body.priceModifierMinor ?? 0, "priceModifierMinor"),
        specBinding: validateSpecBinding(store, service, body.specBinding),
        active: body.active !== false, sortOrder, createdAt: ts, updatedAt: ts,
      };
      store.catalogOptions.push(option);
      group.version += 1; group.updatedAt = ts; item.version += 1; item.updatedAt = ts;
      auditChange(audit, store, user, "catalog_option.create", "supplier_catalog_option", option.id);
      return { status: 201, body: { option, groupVersion: group.version, itemVersion: item.version }, mutated: true };
    }
    if (optionId) {
      const option = store.catalogOptions.find((candidate) => candidate.id === optionId && candidate.optionGroupId === group.id);
      if (!option) fail(404, "catalog_option_not_found", "That catalog option no longer exists.");
      if (req.method === "DELETE") {
        const remainingActive = store.catalogOptions.filter((candidate) => candidate.optionGroupId === group.id && candidate.id !== option.id && candidate.active !== false);
        if (remainingActive.length === 0) fail(409, "catalog_group_requires_option", "An option group must keep at least one active option.");
        store.catalogOptions = store.catalogOptions.filter((candidate) => candidate.id !== option.id);
      } else if (req.method === "PATCH") {
        if (body.label != null) {
          const label = requiredText(body.label, "label", 100);
          if (store.catalogOptions.some((candidate) => candidate.optionGroupId === group.id && candidate.id !== option.id && candidate.label.toLowerCase() === label.toLowerCase())) {
            fail(409, "catalog_option_exists", "That option label is already used.");
          }
          option.label = label;
        }
        if (body.priceModifierMinor != null) option.priceModifierMinor = moneyMinor(body.priceModifierMinor, "priceModifierMinor");
        if (body.specBinding !== undefined) {
          const service = store.supplierServices.find((candidate) => candidate.id === item.supplierServiceId);
          option.specBinding = validateSpecBinding(store, service, body.specBinding);
        }
        if (body.active != null) {
          if (!body.active && store.catalogOptions.filter((candidate) => candidate.optionGroupId === group.id && candidate.id !== option.id && candidate.active !== false).length === 0) {
            fail(409, "catalog_group_requires_option", "An option group must keep at least one active option.");
          }
          option.active = Boolean(body.active);
        }
        if (body.sortOrder != null) {
          const sortOrder = postgresInteger(body.sortOrder, "sortOrder", { min: 0, max: 19 });
          if (store.catalogOptions.some((candidate) => candidate.optionGroupId === group.id && candidate.id !== option.id && candidate.sortOrder === sortOrder)) {
            fail(409, "catalog_option_exists", "That option sort position is already used.");
          }
          option.sortOrder = sortOrder;
        }
        option.updatedAt = now();
      } else return null;
      group.version += 1; group.updatedAt = now(); item.version += 1; item.updatedAt = group.updatedAt;
      auditChange(audit, store, user, `catalog_option.${req.method === "DELETE" ? "delete" : "update"}`, "supplier_catalog_option", option.id);
      return { status: 200, body: { ...(req.method === "DELETE" ? { ok: true } : { option }), groupVersion: group.version, itemVersion: item.version }, mutated: true };
    }
  }

  return null;
}
