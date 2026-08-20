import { identityHasMembership } from "./authorization-context.js";
import { philippineMobileNumber } from "./phone.js";
import { resolveCategoryCode } from "./taxonomy.js";
import {
  CatalogError,
  assertExpectedVersion,
  bumpVersion,
  catalogGroupsForItem,
  copyStarterIntoItem,
  listingStartersFor,
  prepStepsForItem,
  privateCatalogItem,
  publicCatalogItem,
  publicCatalogMediaFile,
  publicSupplierShop,
  publicSupplierShops,
  supplierCatalogReadiness,
  validateSpecBinding,
} from "./supplier-catalog.js";

function fail(status, code, message, details = {}) {
  throw new CatalogError(status, code, message, details);
}

function integer(value, field, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(400, "invalid_catalog_item", `${field} must be an integer from ${min} through ${max}.`, { field });
  }
  return value;
}

function moneyMinor(value, field, { min = 0 } = {}) {
  return integer(value, field, { min, max: Number.MAX_SAFE_INTEGER });
}

function booleanValue(value, field) {
  if (typeof value !== "boolean") fail(400, "invalid_catalog_item", `${field} must be a boolean.`, { field });
  return value;
}

function optionalText(value, field, maxLength) {
  if (value != null && typeof value !== "string") fail(400, "invalid_catalog_item", `${field} must be a string.`, { field });
  const text = String(value ?? "");
  if (text.length > maxLength) fail(400, "invalid_catalog_item", `${field} is too long.`, { field, maxLength });
  return text;
}

function requiredText(value, field, maxLength = 200) {
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

function requireSupplier(user) {
  if (!user || !identityHasMembership(user, "supplier")) fail(403, "forbidden", "A supplier membership is required.");
}

function ownService(store, user, serviceId) {
  requireSupplier(user);
  const service = (store.supplierServices || []).find((candidate) => candidate.id === serviceId);
  if (!service) fail(404, "service_not_found", "That supplier service no longer exists.");
  if (service.supplierId !== user.id) fail(403, "forbidden", "That service belongs to another supplier.");
  return service;
}

function ownItem(store, user, itemId) {
  requireSupplier(user);
  const item = (store.catalogItems || []).find((candidate) => candidate.id === itemId);
  if (!item) fail(404, "catalog_item_not_found", "That catalog item no longer exists.");
  if (item.supplierId !== user.id) fail(403, "forbidden", "That catalog item belongs to another supplier.");
  return item;
}

function ownGroup(store, user, groupId) {
  const group = (store.catalogOptionGroups || []).find((candidate) => candidate.id === groupId);
  if (!group) fail(404, "catalog_group_not_found", "That catalog option group no longer exists.");
  ownItem(store, user, group.catalogItemId);
  return group;
}

function activeFormatCodes(store, codes) {
  if (!Array.isArray(codes)) fail(400, "invalid_catalog_item", "formatCodes must be an array.", { field: "formatCodes" });
  const active = new Set((store.acceptedFileFormats || []).filter((format) => format.active !== false).map((format) => format.code));
  const unique = [...new Set(codes.map((code) => String(code)))];
  for (const code of unique) {
    if (!active.has(code)) fail(400, "invalid_file_format", "Choose an active governed file format.", { formatCode: code });
  }
  return unique;
}

function pathIdentifier(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(400, "invalid_catalog_path", "The catalog identifier encoding is invalid.");
  }
}

function selectedOptionIds(url) {
  const values = url.searchParams.getAll("optionIds").flatMap((value) => String(value).split(",")).filter(Boolean);
  return values.length ? values : undefined;
}

function opaqueCursor(value) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function parseCursor(value) {
  if (value == null || value === "") return null;
  try {
    const decoded = Buffer.from(String(value), "base64url").toString("utf8");
    if (!decoded) fail(400, "invalid_cursor", "The catalog cursor is invalid. Start again without it.");
    return decoded;
  } catch {
    fail(400, "invalid_cursor", "The catalog cursor is invalid. Start again without it.");
  }
}

function auditChange(audit, store, user, action, entityType, entityId, detail) {
  if (typeof audit === "function") audit(store, { actor: user, action, entityType, entityId, detail });
}

function subcategoryForService(store, service, subcategoryCode) {
  const code = requiredText(subcategoryCode, "subcategoryCode", 120);
  const subcategory = (store.taxonomy?.subcategories || []).find((candidate) => candidate.code === code && candidate.active !== false);
  if (!subcategory) fail(400, "invalid_subcategory_code", "Choose an active taxonomy subcategory.", { field: "subcategoryCode" });
  const category = resolveCategoryCode(store.taxonomy, service.categoryCode);
  if (!category || subcategory.categoryCode !== category.code) {
    fail(400, "invalid_subcategory_code", "That subcategory does not belong to this service category.", {
      field: "subcategoryCode",
    });
  }
  return code;
}

function pricingFields(body, current = {}) {
  const pricingUnit = body.pricingUnit == null ? (current.pricingUnit || "per_unit") : requiredText(body.pricingUnit, "pricingUnit", 20);
  if (!["per_unit", "per_package"].includes(pricingUnit)) {
    fail(400, "invalid_catalog_item", "pricingUnit must be per_unit or per_package.", { field: "pricingUnit" });
  }
  let packageQty = current.packageQty ?? null;
  if (Object.hasOwn(body, "packageQty")) packageQty = body.packageQty == null ? null : integer(body.packageQty, "packageQty", { min: 2 });
  if (pricingUnit === "per_unit") packageQty = null;
  else if (!Number.isSafeInteger(packageQty) || packageQty < 2) {
    fail(400, "invalid_catalog_item", "packageQty must be at least 2 for per_package pricing.", { field: "packageQty" });
  }
  const turnaroundMode = body.turnaroundMode == null
    ? (current.turnaroundMode || "inherit")
    : requiredText(body.turnaroundMode, "turnaroundMode", 20);
  if (!["inherit", "override"].includes(turnaroundMode)) {
    fail(400, "invalid_catalog_item", "turnaroundMode must be inherit or override.", { field: "turnaroundMode" });
  }
  let turnaroundHours = current.turnaroundHours ?? null;
  if (Object.hasOwn(body, "turnaroundHours")) {
    turnaroundHours = body.turnaroundHours == null ? null : integer(body.turnaroundHours, "turnaroundHours", { min: 1 });
  }
  if (turnaroundMode === "inherit") turnaroundHours = null;
  else if (!Number.isSafeInteger(turnaroundHours) || turnaroundHours <= 0) {
    fail(400, "invalid_catalog_item", "turnaroundHours is required when overriding ready-in time.", { field: "turnaroundHours" });
  }
  return { pricingUnit, packageQty, turnaroundMode, turnaroundHours };
}

function shopPoint(value) {
  if (!value || typeof value !== "object") fail(400, "invalid_catalog_item", "shop must include lat, lng, and label.", { field: "shop" });
  const lat = value.lat;
  const lng = value.lng;
  const label = requiredText(value.label, "shop.label", 240);
  if (typeof lat !== "number" || typeof lng !== "number" || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    fail(400, "invalid_catalog_item", "shop coordinates must be valid latitude and longitude.", { field: "shop" });
  }
  return { lat, lng, label };
}

function optionInput(value, service, store) {
  const option = catalogRecord(value, { code: "invalid_catalog_options", field: "option" });
  const label = requiredText(option.label, "label", 100);
  const priceModifierMinor = option.priceModifierMinor == null ? 0 : integer(option.priceModifierMinor, "priceModifierMinor");
  const sortOrder = integer(option.sortOrder ?? 0, "sortOrder", { min: 0, max: 19 });
  const active = option.active == null ? true : booleanValue(option.active, "active");
  const specBinding = option.specBinding === undefined ? undefined : validateSpecBinding(store, service, option.specBinding);
  return { label, priceModifierMinor, sortOrder, active, specBinding };
}

function ensureGroupBounds(store, itemId, extra = 0) {
  const count = (store.catalogOptionGroups || []).filter((group) => group.catalogItemId === itemId).length + extra;
  if (count > 6) fail(400, "invalid_catalog_options", "A listing can have at most six option groups.");
}

function ensureOptionBounds(store, groupId, extra = 0) {
  const count = (store.catalogOptions || []).filter((option) => option.optionGroupId === groupId).length + extra;
  if (count > 20) fail(400, "invalid_catalog_options", "An option group can have at most twenty options.");
}

function itemReferenced(store, itemId) {
  return (store.orderLineItems || []).some((line) => line.sourceCatalogItemId === itemId);
}

// Phone and email live on the account, not the shop record, but the app shows
// them on one details screen, so both reads answer with the joined view.
function privateSupplierProfile(store, profile, owner) {
  return {
    ...profile,
    phone: owner?.phone ?? null,
    email: owner?.email ?? null,
    media: (store.supplierShopMedia || []).filter((media) => media.supplierId === profile.userId),
  };
}

function privateService(store, service) {
  return {
    id: service.id,
    supplierId: service.supplierId,
    categoryCode: service.categoryCode,
    state: service.state,
    pricingBasis: service.pricingBasis ?? null,
    referenceRateMinor: service.referenceRateMinor,
    turnaroundHours: service.turnaroundHours,
    standardTurnaroundHours: service.standardTurnaroundHours ?? service.turnaroundHours,
    rushEnabled: Boolean(service.rushEnabled),
    rushTurnaroundHours: service.rushTurnaroundHours ?? null,
    rushPriceMinor: service.rushPriceMinor ?? null,
    version: service.version || 1,
    acceptedFormats: (store.supplierServiceFileFormats || [])
      .filter((record) => record.supplierServiceId === service.id)
      .map((record) => record.formatCode)
      .sort(),
    priceTiers: (store.supplierServicePriceTiers || [])
      .filter((tier) => tier.supplierServiceId === service.id)
      .sort((left, right) => left.sortOrder - right.sortOrder),
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
  };
}

export function isPublicSupplierCatalogRoute(method, pathname) {
  return method === "GET" && (
    pathname === "/catalog/shops"
    || /^\/catalog\/shops\/[^/]+$/.test(pathname)
    || /^\/catalog\/items\/[^/]+$/.test(pathname)
    || /^\/catalog\/media\/[^/]+$/.test(pathname)
  );
}

export async function routeSupplierCatalog({ req, url, store, user, readBody, id, now, audit }) {
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/catalog/shops") {
    const rawCategory = url.searchParams.has("categoryCode") ? String(url.searchParams.get("categoryCode") || "").trim() : null;
    const result = publicSupplierShops(store, {
      categoryCode: rawCategory || undefined,
      cursor: parseCursor(url.searchParams.get("cursor")),
    });
    return {
      status: 200,
      body: {
        shops: result.shops,
        nextCursor: result.nextCursor ? opaqueCursor(result.nextCursor) : null,
      },
    };
  }

  if (req.method === "GET" && /^\/catalog\/shops\/[^/]+$/.test(pathname)) {
    const shop = publicSupplierShop(store, pathIdentifier(pathname.split("/")[3]));
    return shop
      ? { status: 200, body: { shop } }
      : { status: 404, body: { error: "catalog_shop_not_found" } };
  }

  if (req.method === "GET" && /^\/catalog\/items\/[^/]+$/.test(pathname)) {
    const item = (store.catalogItems || []).find((candidate) => candidate.id === pathIdentifier(pathname.split("/")[3]));
    const projected = item ? publicCatalogItem(store, item, { selectedOptionIds: selectedOptionIds(url) }) : null;
    return projected
      ? { status: 200, body: { item: projected } }
      : { status: 404, body: { error: "catalog_item_not_found" } };
  }

  if (req.method === "GET" && /^\/catalog\/media\/[^/]+$/.test(pathname)) {
    const file = publicCatalogMediaFile(store, pathIdentifier(pathname.split("/")[3]));
    if (!file) return { status: 404, body: { error: "catalog_media_not_found" } };
    return { status: 200, body: { fileId: file.fileId, purpose: file.purpose, contentType: file.detectedContentType } };
  }

  if (req.method === "GET" && pathname === "/listing-starters") {
    requireSupplier(user);
    const subcategoryCode = url.searchParams.get("subcategoryCode");
    if (!subcategoryCode) fail(400, "invalid_subcategory_code", "Send subcategoryCode to load GRIDGO starters.", { field: "subcategoryCode" });
    const subcategory = (store.taxonomy?.subcategories || []).find(
      (candidate) => candidate.code === subcategoryCode && candidate.active !== false,
    );
    if (!subcategory) fail(400, "invalid_subcategory_code", "Choose an active taxonomy subcategory.", { field: "subcategoryCode" });
    return { status: 200, body: { starters: listingStartersFor(store, subcategoryCode) } };
  }

  if (req.method === "GET" && pathname === "/me/supplier-readiness") {
    requireSupplier(user);
    return { status: 200, body: supplierCatalogReadiness(store, user.id) };
  }

  if (["GET", "PATCH"].includes(req.method) && pathname === "/me/supplier-profile") {
    requireSupplier(user);
    const profile = (store.supplierProfiles || []).find((candidate) => candidate.userId === user.id);
    if (!profile) fail(404, "supplier_profile_not_found", "Complete supplier enrollment first.");
    const owner = (store.users || []).find((candidate) => candidate.id === user.id);
    if (req.method === "GET") {
      return { status: 200, body: { profile: privateSupplierProfile(store, profile, owner) } };
    }
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "supplier_profile_stale", profile.version || 1);
    if (Object.hasOwn(body, "email")) {
      fail(400, "email_not_editable", "Your email comes from your GRIDGO sign-in. Change it there and it will update here.", { field: "email" });
    }
    // Read the number before anything moves so a mistyped phone cannot leave a
    // half-applied edit behind.
    const phone = Object.hasOwn(body, "phone") ? philippineMobileNumber(body.phone) : null;
    if (body.shopName != null) {
      profile.shopName = requiredText(body.shopName, "shopName", 120);
      if (owner) owner.supplierName = profile.shopName;
    }
    if (body.contactName != null) profile.contactName = requiredText(body.contactName, "contactName", 120);
    if (body.shop != null) profile.shop = shopPoint(body.shop);
    if (body.pickupAvailable != null) profile.pickupAvailable = booleanValue(body.pickupAvailable, "pickupAvailable");
    const at = now();
    bumpVersion(profile, at);
    if (owner) owner.shop = profile.shop;
    if (owner && phone) owner.phone = phone;
    auditChange(audit, store, user, "supplier_profile.update", "supplier_profile", user.id);
    return { status: 200, body: { profile: privateSupplierProfile(store, profile, owner) }, mutated: true };
  }

  if (["GET", "PATCH"].includes(req.method) && pathname === "/me/supplier-payment-terms") {
    requireSupplier(user);
    let terms = (store.supplierPaymentTerms || []).find((candidate) => candidate.supplierId === user.id);
    if (!terms) {
      terms = {
        supplierId: user.id, deliveryDownpaymentRateBps: 0, pickupFullOnlineEnabled: true,
        pickupDownpaymentStoreEnabled: false, pickupDownpaymentRateBps: null, version: 1, updatedAt: now(),
      };
      if (!Array.isArray(store.supplierPaymentTerms)) store.supplierPaymentTerms = [];
      store.supplierPaymentTerms.push(terms);
    }
    if (req.method === "GET") return { status: 200, body: { terms } };
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "supplier_payment_terms_stale", terms.version || 1);
    if (body.deliveryDownpaymentRateBps != null) {
      const rate = integer(body.deliveryDownpaymentRateBps, "deliveryDownpaymentRateBps");
      if (![0, 2500, 5000].includes(rate)) fail(400, "invalid_catalog_item", "Delivery downpayment must be 0, 2500, or 5000 bps.", { field: "deliveryDownpaymentRateBps" });
      terms.deliveryDownpaymentRateBps = rate;
    }
    if (body.pickupFullOnlineEnabled != null) terms.pickupFullOnlineEnabled = booleanValue(body.pickupFullOnlineEnabled, "pickupFullOnlineEnabled");
    if (body.pickupDownpaymentStoreEnabled != null) {
      terms.pickupDownpaymentStoreEnabled = booleanValue(body.pickupDownpaymentStoreEnabled, "pickupDownpaymentStoreEnabled");
    }
    if (Object.hasOwn(body, "pickupDownpaymentRateBps")) {
      terms.pickupDownpaymentRateBps = body.pickupDownpaymentRateBps == null
        ? null
        : integer(body.pickupDownpaymentRateBps, "pickupDownpaymentRateBps");
      if (terms.pickupDownpaymentRateBps != null && ![2500, 5000].includes(terms.pickupDownpaymentRateBps)) {
        fail(400, "invalid_catalog_item", "Pickup store downpayment must be 2500 or 5000 bps.", { field: "pickupDownpaymentRateBps" });
      }
    }
    if (terms.pickupDownpaymentStoreEnabled !== Boolean(terms.pickupDownpaymentRateBps)) {
      fail(400, "invalid_catalog_item", "Pickup store downpayment requires a 25% or 50% rate.");
    }
    bumpVersion(terms, now());
    auditChange(audit, store, user, "supplier_payment_terms.update", "supplier_payment_terms", user.id);
    return { status: 200, body: { terms }, mutated: true };
  }

  if (req.method === "GET" && pathname === "/me/supplier-services") {
    requireSupplier(user);
    return {
      status: 200,
      body: { services: (store.supplierServices || []).filter((service) => service.supplierId === user.id).map((service) => privateService(store, service)) },
    };
  }

  if (req.method === "POST" && pathname === "/me/supplier-services") {
    requireSupplier(user);
    const body = catalogRecord(await readBody(req));
    const category = resolveCategoryCode(store.taxonomy, requiredText(body.categoryCode, "categoryCode", 120));
    if (!category || category.active === false) fail(400, "invalid_category_code", "Choose an active governed category.");
    const at = now();
    const service = {
      id: id("svc"),
      supplierId: user.id,
      categoryCode: String(body.categoryCode).trim(),
      state: "draft",
      pricingBasis: body.pricingBasis ? requiredText(body.pricingBasis, "pricingBasis", 40) : "per_unit",
      referenceRateMinor: body.referenceRateMinor == null ? 0 : moneyMinor(body.referenceRateMinor, "referenceRateMinor"),
      turnaroundHours: body.turnaroundHours == null ? 24 : integer(body.turnaroundHours, "turnaroundHours", { min: 1 }),
      standardTurnaroundHours: body.turnaroundHours == null ? 24 : integer(body.turnaroundHours, "turnaroundHours", { min: 1 }),
      rushEnabled: false,
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    if (!Array.isArray(store.supplierServices)) store.supplierServices = [];
    store.supplierServices.push(service);
    auditChange(audit, store, user, "supplier_service.create", "supplier_service", service.id);
    return { status: 201, body: { service: privateService(store, service) }, mutated: true };
  }

  if (/^\/me\/supplier-services\/[^/]+$/.test(pathname)) {
    const service = ownService(store, user, pathIdentifier(pathname.split("/")[3]));
    if (req.method === "GET") return { status: 200, body: { service: privateService(store, service) } };
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "supplier_service_stale", service.version || 1);
    if (req.method === "DELETE") {
      if ((store.catalogItems || []).some((item) => item.supplierServiceId === service.id)) {
        fail(409, "supplier_service_in_use", "Archive or move listings before deleting this service line.");
      }
      store.supplierServices = store.supplierServices.filter((candidate) => candidate.id !== service.id);
      store.supplierServiceFileFormats = (store.supplierServiceFileFormats || []).filter((record) => record.supplierServiceId !== service.id);
      store.supplierServicePriceTiers = (store.supplierServicePriceTiers || []).filter((tier) => tier.supplierServiceId !== service.id);
      auditChange(audit, store, user, "supplier_service.delete", "supplier_service", service.id);
      return { status: 200, body: { ok: true }, mutated: true };
    }
    if (req.method !== "PATCH") return null;
    if (body.pricingBasis != null) service.pricingBasis = requiredText(body.pricingBasis, "pricingBasis", 40);
    if (body.referenceRateMinor != null) service.referenceRateMinor = moneyMinor(body.referenceRateMinor, "referenceRateMinor");
    if (body.turnaroundHours != null) {
      service.turnaroundHours = integer(body.turnaroundHours, "turnaroundHours", { min: 1 });
      service.standardTurnaroundHours = service.turnaroundHours;
    }
    if (body.rushEnabled != null) {
      service.rushEnabled = booleanValue(body.rushEnabled, "rushEnabled");
      if (!service.rushEnabled) {
        service.rushTurnaroundHours = null;
        service.rushPriceMinor = null;
      }
    }
    if (service.rushEnabled) {
      if (body.rushTurnaroundHours != null) service.rushTurnaroundHours = integer(body.rushTurnaroundHours, "rushTurnaroundHours", { min: 1 });
      if (body.rushPriceMinor != null) service.rushPriceMinor = moneyMinor(body.rushPriceMinor, "rushPriceMinor");
      if (!service.rushTurnaroundHours || service.rushPriceMinor == null) {
        fail(400, "invalid_catalog_item", "Rush turnaround and price are required when rush is enabled.");
      }
    }
    bumpVersion(service, now());
    auditChange(audit, store, user, "supplier_service.update", "supplier_service", service.id);
    return { status: 200, body: { service: privateService(store, service) }, mutated: true };
  }

  if (/^\/me\/supplier-services\/[^/]+\/file-formats$/.test(pathname)) {
    const service = ownService(store, user, pathIdentifier(pathname.split("/")[3]));
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "supplier_service_stale", service.version || 1);
    const codes = activeFormatCodes(store, body.formatCodes);
    store.supplierServiceFileFormats = (store.supplierServiceFileFormats || []).filter((record) => record.supplierServiceId !== service.id);
    store.supplierServiceFileFormats.push(...codes.map((formatCode) => ({ supplierServiceId: service.id, formatCode })));
    bumpVersion(service, now());
    auditChange(audit, store, user, "supplier_service.formats_update", "supplier_service", service.id, { formatCodes: codes });
    return { status: 200, body: { service: privateService(store, service) }, mutated: true };
  }

  if (/^\/me\/supplier-services\/[^/]+\/pricing$/.test(pathname)) {
    const service = ownService(store, user, pathIdentifier(pathname.split("/")[3]));
    if (req.method === "GET") return { status: 200, body: { service: privateService(store, service) } };
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "supplier_service_stale", service.version || 1);
    const tiers = Array.isArray(body.priceTiers) ? body.priceTiers : [];
    store.supplierServicePriceTiers = (store.supplierServicePriceTiers || []).filter((tier) => tier.supplierServiceId !== service.id);
    store.supplierServicePriceTiers.push(...tiers.map((candidate, index) => {
      const tier = catalogRecord(candidate, { field: "priceTiers" });
      return {
        id: id("spt"),
        supplierServiceId: service.id,
        tierCode: requiredText(tier.tierCode, "tierCode", 40),
        colorTier: tier.colorTier ?? null,
        minQuantity: integer(tier.minQuantity ?? 1, "minQuantity", { min: 1 }),
        maxQuantity: tier.maxQuantity == null ? null : integer(tier.maxQuantity, "maxQuantity", { min: 1 }),
        unitPriceMinor: moneyMinor(tier.unitPriceMinor, "unitPriceMinor"),
        sortOrder: integer(tier.sortOrder ?? index, "sortOrder", { min: 0 }),
      };
    }));
    bumpVersion(service, now());
    return { status: 200, body: { service: privateService(store, service) }, mutated: true };
  }

  if (req.method === "GET" && pathname === "/me/catalog-items") {
    requireSupplier(user);
    let items = (store.catalogItems || []).filter((item) => item.supplierId === user.id);
    const subcategoryCode = url.searchParams.get("subcategoryCode");
    if (subcategoryCode) items = items.filter((item) => item.subcategoryCode === subcategoryCode);
    if (url.searchParams.has("active")) {
      const active = url.searchParams.get("active");
      if (!["true", "false"].includes(active)) fail(400, "invalid_catalog_item", "active must be true or false.");
      items = items.filter((item) => (item.active !== false) === (active === "true"));
    }
    return { status: 200, body: { items: items.map((item) => privateCatalogItem(store, item)) } };
  }

  if (req.method === "POST" && pathname === "/me/catalog-items") {
    requireSupplier(user);
    const body = catalogRecord(await readBody(req));
    const service = ownService(store, user, requiredText(body.supplierServiceId, "supplierServiceId", 80));
    const starter = body.starterId
      ? (store.listingStarters || []).find((candidate) => candidate.id === body.starterId)
      : null;
    if (body.starterId && !starter) fail(404, "listing_starter_not_found", "That GRIDGO starter no longer exists.");
    const subcategoryCode = subcategoryForService(
      store,
      service,
      body.subcategoryCode || starter?.subcategoryCode,
    );
    if (starter && starter.subcategoryCode !== subcategoryCode) {
      fail(400, "invalid_subcategory_code", "That starter belongs to a different subcategory.");
    }
    const pricing = pricingFields({
      pricingUnit: body.pricingUnit ?? starter?.defaultPricingUnit,
      packageQty: Object.hasOwn(body, "packageQty") ? body.packageQty : starter?.defaultPackageQty,
      turnaroundMode: body.turnaroundMode ?? (starter?.defaultTurnaroundHours ? "override" : "inherit"),
      turnaroundHours: Object.hasOwn(body, "turnaroundHours") ? body.turnaroundHours : starter?.defaultTurnaroundHours,
    });
    const at = now();
    const existing = (store.catalogItems || []).filter((item) => item.supplierId === user.id);
    const item = {
      id: id("sci"),
      supplierId: user.id,
      supplierServiceId: service.id,
      subcategoryCode,
      name: requiredText(body.name, "name", 120),
      description: optionalText(body.description, "description", 4000),
      basePriceMinor: moneyMinor(body.basePriceMinor ?? 0, "basePriceMinor"),
      ...pricing,
      fileFormatMode: "inherit",
      active: body.active == null ? true : booleanValue(body.active, "active"),
      sortOrder: integer(body.sortOrder ?? existing.length, "sortOrder", { min: 0 }),
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    if (!Array.isArray(store.catalogItems)) store.catalogItems = [];
    if (!Array.isArray(store.catalogOptionGroups)) store.catalogOptionGroups = [];
    if (!Array.isArray(store.catalogOptions)) store.catalogOptions = [];
    if (!Array.isArray(store.catalogItemFileFormats)) store.catalogItemFileFormats = [];
    store.catalogItems.push(item);
    if (starter) copyStarterIntoItem(store, starter, item, id, at);
    auditChange(audit, store, user, "catalog_item.create", "supplier_catalog_item", item.id, { serviceId: service.id });
    return { status: 201, body: { item: privateCatalogItem(store, item) }, mutated: true };
  }

  if (/^\/me\/catalog-items\/[^/]+$/.test(pathname)) {
    const item = ownItem(store, user, pathIdentifier(pathname.split("/")[3]));
    if (req.method === "GET") {
      const projected = privateCatalogItem(store, item);
      if (!projected?.id) fail(500, "catalog_item_projection_failed", "That listing could not be loaded. Refresh and try again.");
      return { status: 200, body: { item: projected } };
    }
    const parsed = await readBody(req);
    const body = req.method === "DELETE"
      ? (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {})
      : catalogRecord(parsed);
    assertExpectedVersion(req, body, "catalog_item_stale", item.version, url);
    if (req.method === "DELETE") {
      if (itemReferenced(store, item.id)) {
        item.active = false;
        bumpVersion(item, now());
        auditChange(audit, store, user, "catalog_item.delete", "supplier_catalog_item", item.id, { archived: true });
        return { status: 200, body: { item: privateCatalogItem(store, item) }, mutated: true };
      }
      store.catalogItems = store.catalogItems.filter((candidate) => candidate.id !== item.id);
      store.catalogItemPhotos = (store.catalogItemPhotos || []).filter((photo) => photo.catalogItemId !== item.id);
      const groupIds = new Set((store.catalogOptionGroups || []).filter((group) => group.catalogItemId === item.id).map((group) => group.id));
      store.catalogOptionGroups = (store.catalogOptionGroups || []).filter((group) => group.catalogItemId !== item.id);
      store.catalogOptions = (store.catalogOptions || []).filter((option) => !groupIds.has(option.optionGroupId));
      store.catalogItemFileFormats = (store.catalogItemFileFormats || []).filter((format) => format.catalogItemId !== item.id);
      store.catalogPrepSteps = (store.catalogPrepSteps || []).filter((step) => step.catalogItemId !== item.id);
      auditChange(audit, store, user, "catalog_item.delete", "supplier_catalog_item", item.id, { archived: false });
      return { status: 200, body: { ok: true }, mutated: true };
    }
    if (req.method !== "PATCH") return null;
    const service = ownService(store, user, item.supplierServiceId);
    if (body.name != null) item.name = requiredText(body.name, "name", 120);
    if (body.description != null) item.description = optionalText(body.description, "description", 4000);
    if (body.basePriceMinor != null) item.basePriceMinor = moneyMinor(body.basePriceMinor, "basePriceMinor");
    if (body.subcategoryCode != null) item.subcategoryCode = subcategoryForService(store, service, body.subcategoryCode);
    Object.assign(item, pricingFields(body, item));
    if (body.active != null) item.active = booleanValue(body.active, "active");
    if (body.sortOrder != null) item.sortOrder = integer(body.sortOrder, "sortOrder", { min: 0 });
    bumpVersion(item, now());
    auditChange(audit, store, user, "catalog_item.update", "supplier_catalog_item", item.id);
    return { status: 200, body: { item: privateCatalogItem(store, item) }, mutated: true };
  }

  if (/^\/me\/catalog-items\/[^/]+\/file-formats$/.test(pathname)) {
    const item = ownItem(store, user, pathIdentifier(pathname.split("/")[3]));
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "catalog_item_stale", item.version, url);
    const mode = requiredText(body.mode || body.fileFormatMode, "mode", 20);
    if (!["inherit", "override"].includes(mode)) fail(400, "invalid_catalog_item", "mode must be inherit or override.", { field: "mode" });
    const codes = mode === "override" ? activeFormatCodes(store, body.formatCodes) : [];
    if (mode === "override" && codes.length === 0) fail(400, "invalid_file_format", "Override mode requires at least one active format.");
    item.fileFormatMode = mode;
    store.catalogItemFileFormats = (store.catalogItemFileFormats || []).filter((format) => format.catalogItemId !== item.id);
    store.catalogItemFileFormats.push(...codes.map((formatCode) => ({ catalogItemId: item.id, formatCode })));
    bumpVersion(item, now());
    auditChange(audit, store, user, "catalog_item.formats_update", "supplier_catalog_item", item.id, { mode, formatCodes: codes });
    return { status: 200, body: { item: privateCatalogItem(store, item) }, mutated: true };
  }

  if (/^\/me\/catalog-items\/[^/]+\/photos\/reorder$/.test(pathname)) {
    const item = ownItem(store, user, pathIdentifier(pathname.split("/")[3]));
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "catalog_item_stale", item.version, url);
    const fileIds = Array.isArray(body.fileIds) ? body.fileIds.map(String) : null;
    if (!fileIds) fail(400, "invalid_catalog_item", "fileIds must list every current photo.", { field: "fileIds" });
    const current = (store.catalogItemPhotos || []).filter((photo) => photo.catalogItemId === item.id);
    if (fileIds.length !== current.length || new Set(fileIds).size !== fileIds.length
        || current.some((photo) => !fileIds.includes(photo.fileId))) {
      fail(409, "catalog_item_stale", "The photo set changed. Refresh it before reordering.");
    }
    for (const [sortOrder, fileId] of fileIds.entries()) {
      const photo = current.find((candidate) => candidate.fileId === fileId);
      photo.sortOrder = sortOrder;
    }
    bumpVersion(item, now());
    auditChange(audit, store, user, "catalog_item.photos_reorder", "supplier_catalog_item", item.id);
    return { status: 200, body: { item: privateCatalogItem(store, item) }, mutated: true };
  }

  if (/^\/me\/catalog-items\/[^/]+\/prep-steps\/reorder$/.test(pathname)) {
    const item = ownItem(store, user, pathIdentifier(pathname.split("/")[3]));
    const body = catalogRecord(await readBody(req));
    assertExpectedVersion(req, body, "catalog_item_stale", item.version, url);
    const stepIds = Array.isArray(body.stepIds) ? body.stepIds.map(String) : null;
    if (!stepIds) fail(400, "invalid_catalog_item", "stepIds must list every current prep step.", { field: "stepIds" });
    const current = (store.catalogPrepSteps || []).filter((step) => step.catalogItemId === item.id);
    if (stepIds.length !== current.length || new Set(stepIds).size !== stepIds.length
        || current.some((step) => !stepIds.includes(step.id))) {
      fail(409, "catalog_item_stale", "The prep-step set changed. Refresh it before reordering.");
    }
    for (const [sortOrder, stepId] of stepIds.entries()) {
      current.find((step) => step.id === stepId).sortOrder = sortOrder;
    }
    bumpVersion(item, now());
    auditChange(audit, store, user, "catalog_item.prep_steps_reorder", "supplier_catalog_item", item.id);
    return { status: 200, body: { item: privateCatalogItem(store, item) }, mutated: true };
  }

  if (/^\/me\/catalog-items\/[^/]+\/prep-steps(?:\/[^/]+)?$/.test(pathname)) {
    const parts = pathname.split("/");
    const item = ownItem(store, user, pathIdentifier(parts[3]));
    const stepId = parts[5] ? pathIdentifier(parts[5]) : null;
    if (req.method === "GET" && !stepId) {
      return { status: 200, body: { prepSteps: prepStepsForItem(store, item.id), itemVersion: item.version } };
    }
    const parsedStep = await readBody(req);
    const body = req.method === "DELETE"
      ? (parsedStep && typeof parsedStep === "object" && !Array.isArray(parsedStep) ? parsedStep : {})
      : catalogRecord(parsedStep);
    assertExpectedVersion(req, body, "catalog_item_stale", item.version, url);
    if (!Array.isArray(store.catalogPrepSteps)) store.catalogPrepSteps = [];
    if (req.method === "POST" && !stepId) {
      const existing = store.catalogPrepSteps.filter((step) => step.catalogItemId === item.id);
      if (existing.length >= 8) fail(400, "invalid_catalog_item", "A listing can have at most eight prep steps.");
      const at = now();
      const step = {
        id: id("cps"),
        catalogItemId: item.id,
        title: requiredText(body.title, "title", 80),
        body: optionalText(body.body, "body", 1000),
        sortOrder: integer(body.sortOrder ?? existing.length, "sortOrder", { min: 0, max: 7 }),
        createdAt: at,
        updatedAt: at,
      };
      if (existing.some((candidate) => candidate.sortOrder === step.sortOrder)) {
        fail(409, "catalog_prep_step_exists", "That prep-step sort position is already used.");
      }
      store.catalogPrepSteps.push(step);
      bumpVersion(item, at);
      auditChange(audit, store, user, "catalog_prep_step.create", "supplier_catalog_prep_step", step.id);
      return { status: 201, body: { prepStep: prepStepsForItem(store, item.id).find((candidate) => candidate.id === step.id), itemVersion: item.version }, mutated: true };
    }
    const step = store.catalogPrepSteps.find((candidate) => candidate.id === stepId && candidate.catalogItemId === item.id);
    if (!step) fail(404, "catalog_prep_step_not_found", "That prep step no longer exists.");
    if (req.method === "DELETE") {
      store.catalogPrepSteps = store.catalogPrepSteps.filter((candidate) => candidate.id !== step.id);
      bumpVersion(item, now());
      auditChange(audit, store, user, "catalog_prep_step.delete", "supplier_catalog_prep_step", step.id);
      return { status: 200, body: { itemVersion: item.version }, mutated: true };
    }
    if (req.method !== "PATCH") return null;
    if (body.title != null) step.title = requiredText(body.title, "title", 80);
    if (body.body != null) step.body = optionalText(body.body, "body", 1000);
    if (body.sortOrder != null) {
      const sortOrder = integer(body.sortOrder, "sortOrder", { min: 0, max: 7 });
      if (store.catalogPrepSteps.some((candidate) => candidate.catalogItemId === item.id && candidate.id !== step.id && candidate.sortOrder === sortOrder)) {
        fail(409, "catalog_prep_step_exists", "That prep-step sort position is already used.");
      }
      step.sortOrder = sortOrder;
    }
    step.updatedAt = now();
    bumpVersion(item, step.updatedAt);
    auditChange(audit, store, user, "catalog_prep_step.update", "supplier_catalog_prep_step", step.id);
    return { status: 200, body: { prepStep: prepStepsForItem(store, item.id).find((candidate) => candidate.id === step.id), itemVersion: item.version }, mutated: true };
  }

  if (/^\/me\/catalog-items\/[^/]+\/option-groups(?:\/[^/]+)?$/.test(pathname)) {
    const parts = pathname.split("/");
    const item = ownItem(store, user, pathIdentifier(parts[3]));
    const groupId = parts[5] ? pathIdentifier(parts[5]) : null;
    const service = ownService(store, user, item.supplierServiceId);
    if (req.method === "POST" && !groupId) {
      const body = catalogRecord(await readBody(req));
      assertExpectedVersion(req, body, "catalog_item_stale", item.version, url);
      ensureGroupBounds(store, item.id, 1);
      const name = requiredText(body.name, "name", 80);
      const kind = body.kind == null ? "spec" : requiredText(body.kind, "kind", 10);
      if (!["spec", "addon"].includes(kind)) fail(400, "invalid_catalog_options", "kind must be spec or addon.", { field: "kind" });
      const required = kind === "addon" ? false : (body.required == null ? true : booleanValue(body.required, "required"));
      if (kind === "addon" && required) fail(400, "invalid_catalog_options", "Add-on groups are optional.");
      const sortOrder = integer(body.sortOrder ?? (store.catalogOptionGroups || []).filter((group) => group.catalogItemId === item.id).length, "sortOrder", { min: 0, max: 5 });
      if ((store.catalogOptionGroups || []).some((group) => group.catalogItemId === item.id && group.sortOrder === sortOrder)) {
        fail(409, "catalog_group_exists", "That option-group sort position is already used.");
      }
      if ((store.catalogOptionGroups || []).some((group) => group.catalogItemId === item.id && group.name.toLowerCase() === name.toLowerCase())) {
        fail(409, "catalog_group_exists", "That option-group name is already used.");
      }
      const optionValues = Array.isArray(body.options) ? body.options : [];
      if (optionValues.length > 20) fail(400, "invalid_catalog_options", "An option group can have at most twenty options.");
      const at = now();
      const group = {
        id: id("cog"), catalogItemId: item.id, name, kind,
        helpText: body.helpText == null ? null : optionalText(body.helpText, "helpText", 240) || null,
        required, selectionMode: "single", sortOrder, version: 1, createdAt: at, updatedAt: at,
      };
      const labels = new Set();
      const positions = new Set();
      const options = optionValues.map((value) => {
        const option = optionInput(value, service, store);
        if (labels.has(option.label.toLowerCase()) || positions.has(option.sortOrder)) {
          fail(400, "invalid_catalog_options", "Option labels and sort orders must be unique within a group.");
        }
        labels.add(option.label.toLowerCase());
        positions.add(option.sortOrder);
        return { id: id("cop"), optionGroupId: group.id, ...option, specBinding: option.specBinding ?? null, createdAt: at, updatedAt: at };
      });
      store.catalogOptionGroups.push(group);
      store.catalogOptions.push(...options);
      bumpVersion(item, at);
      auditChange(audit, store, user, "catalog_group.create", "supplier_catalog_option_group", group.id);
      return { status: 201, body: { group: catalogGroupsForItem(store, item.id).find((candidate) => candidate.id === group.id), itemVersion: item.version }, mutated: true };
    }
    const group = (store.catalogOptionGroups || []).find((candidate) => candidate.id === groupId && candidate.catalogItemId === item.id);
    if (!group) fail(404, "catalog_group_not_found", "That option group no longer exists.");
    const parsedGroup = await readBody(req);
    const body = req.method === "DELETE"
      ? (parsedGroup && typeof parsedGroup === "object" && !Array.isArray(parsedGroup) ? parsedGroup : {})
      : catalogRecord(parsedGroup);
    assertExpectedVersion(req, body, "catalog_group_stale", group.version, url);
    if (req.method === "DELETE") {
      store.catalogOptionGroups = store.catalogOptionGroups.filter((candidate) => candidate.id !== group.id);
      store.catalogOptions = (store.catalogOptions || []).filter((option) => option.optionGroupId !== group.id);
      bumpVersion(item, now());
      auditChange(audit, store, user, "catalog_group.delete", "supplier_catalog_option_group", group.id);
      return { status: 200, body: { itemVersion: item.version }, mutated: true };
    }
    if (req.method !== "PATCH") return null;
    if (body.name != null) {
      const name = requiredText(body.name, "name", 80);
      if ((store.catalogOptionGroups || []).some((candidate) => candidate.catalogItemId === item.id && candidate.id !== group.id && candidate.name.toLowerCase() === name.toLowerCase())) {
        fail(409, "catalog_group_exists", "That option-group name is already used.");
      }
      group.name = name;
    }
    if (body.kind != null) {
      const kind = requiredText(body.kind, "kind", 10);
      if (!["spec", "addon"].includes(kind)) fail(400, "invalid_catalog_options", "kind must be spec or addon.", { field: "kind" });
      group.kind = kind;
      if (kind === "addon") group.required = false;
    }
    if (body.required != null) {
      group.required = booleanValue(body.required, "required");
      if (group.kind === "addon" && group.required) fail(400, "invalid_catalog_options", "Add-on groups are optional.");
    }
    if (body.helpText !== undefined) group.helpText = body.helpText == null ? null : optionalText(body.helpText, "helpText", 240) || null;
    if (body.sortOrder != null) {
      const sortOrder = integer(body.sortOrder, "sortOrder", { min: 0, max: 5 });
      if ((store.catalogOptionGroups || []).some((candidate) => candidate.catalogItemId === item.id && candidate.id !== group.id && candidate.sortOrder === sortOrder)) {
        fail(409, "catalog_group_exists", "That option-group sort position is already used.");
      }
      group.sortOrder = sortOrder;
    }
    const at = now();
    bumpVersion(group, at);
    bumpVersion(item, at);
    auditChange(audit, store, user, "catalog_group.update", "supplier_catalog_option_group", group.id);
    return { status: 200, body: { group: catalogGroupsForItem(store, item.id).find((candidate) => candidate.id === group.id), itemVersion: item.version }, mutated: true };
  }

  if (/^\/me\/catalog-option-groups\/[^/]+\/options(?:\/[^/]+)?$/.test(pathname)) {
    const parts = pathname.split("/");
    const group = ownGroup(store, user, pathIdentifier(parts[3]));
    const item = ownItem(store, user, group.catalogItemId);
    const service = ownService(store, user, item.supplierServiceId);
    const optionId = parts[5] ? pathIdentifier(parts[5]) : null;
    const parsedOption = await readBody(req);
    const body = req.method === "DELETE"
      ? (parsedOption && typeof parsedOption === "object" && !Array.isArray(parsedOption) ? parsedOption : {})
      : catalogRecord(parsedOption);
    assertExpectedVersion(req, body, "catalog_group_stale", group.version, url);
    if (req.method === "POST" && !optionId) {
      ensureOptionBounds(store, group.id, 1);
      const option = optionInput(body, service, store);
      if ((store.catalogOptions || []).some((candidate) => candidate.optionGroupId === group.id && candidate.sortOrder === option.sortOrder)) {
        fail(409, "catalog_option_exists", "That option sort position is already used.");
      }
      if ((store.catalogOptions || []).some((candidate) => candidate.optionGroupId === group.id && candidate.label.toLowerCase() === option.label.toLowerCase())) {
        fail(409, "catalog_option_exists", "That option label is already used.");
      }
      const at = now();
      const record = { id: id("cop"), optionGroupId: group.id, ...option, specBinding: option.specBinding ?? null, createdAt: at, updatedAt: at };
      store.catalogOptions.push(record);
      bumpVersion(group, at);
      bumpVersion(item, at);
      auditChange(audit, store, user, "catalog_option.create", "supplier_catalog_option", record.id);
      return { status: 201, body: { option: record, itemVersion: item.version, groupVersion: group.version }, mutated: true };
    }
    const option = (store.catalogOptions || []).find((candidate) => candidate.id === optionId && candidate.optionGroupId === group.id);
    if (!option) fail(404, "catalog_option_not_found", "That catalog option no longer exists.");
    if (req.method === "DELETE") {
      store.catalogOptions = store.catalogOptions.filter((candidate) => candidate.id !== option.id);
    } else if (req.method === "PATCH") {
      if (body.label != null) {
        const label = requiredText(body.label, "label", 100);
        if ((store.catalogOptions || []).some((candidate) => candidate.optionGroupId === group.id && candidate.id !== option.id && candidate.label.toLowerCase() === label.toLowerCase())) {
          fail(409, "catalog_option_exists", "That option label is already used.");
        }
        option.label = label;
      }
      if (body.priceModifierMinor != null) option.priceModifierMinor = integer(body.priceModifierMinor, "priceModifierMinor");
      if (body.specBinding !== undefined) option.specBinding = validateSpecBinding(store, service, body.specBinding);
      if (body.active != null) option.active = booleanValue(body.active, "active");
      if (body.sortOrder != null) {
        const sortOrder = integer(body.sortOrder, "sortOrder", { min: 0, max: 19 });
        if ((store.catalogOptions || []).some((candidate) => candidate.optionGroupId === group.id && candidate.id !== option.id && candidate.sortOrder === sortOrder)) {
          fail(409, "catalog_option_exists", "That option sort position is already used.");
        }
        option.sortOrder = sortOrder;
      }
      option.updatedAt = now();
    } else {
      return null;
    }
    const at = now();
    bumpVersion(group, at);
    bumpVersion(item, at);
    auditChange(audit, store, user, `catalog_option.${req.method === "DELETE" ? "delete" : "update"}`, "supplier_catalog_option", option.id);
    return { status: 200, body: { itemVersion: item.version, groupVersion: group.version, ...(req.method === "PATCH" ? { option } : {}) }, mutated: true };
  }

  return null;
}
