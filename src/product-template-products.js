import { bumpVersion, catalogGroupsForItem } from "./supplier-catalog.js";
import { listingSnapshot, startListingReview } from "./catalog-review-state.js";
import { productionTimeFields } from "./production-time.js";
import { shopProductionDayMinutes } from "./production-days.js";
import { resolveCategoryCode } from "./taxonomy.js";
import { manilaDay } from "./shop-availability.js";
import { READY_TIME_CHIPS } from "./product-template-data.js";
import { replacePriceTiers, replaceSpeedTiers } from "./catalog-routes.js";
import {
  fail,
  object,
  positive,
  text,
  templateFor,
  templateNotice,
} from "./product-template-common.js";
export function convertPriceTable(template, prices) {
  if (!Array.isArray(prices) || !prices.length || prices.length > 200)
    fail("template_price_required", "Price one to two hundred options.");
  const seen = new Set();
  const rows = prices.map((row) => {
    object(row);
    const option = template.options.find((o) => o.key === row.optionKey);
    if (!option || seen.has(option.key))
      fail("invalid_template_options", "Choose each available option once.");
    seen.add(option.key);
    return {
      optionKey: option.key,
      label: option.label,
      priceMinor: positive(row.priceMinor),
    };
  });
  const basePriceMinor = Math.min(...rows.map((r) => r.priceMinor));
  return {
    basePriceMinor,
    rows: rows.map((r) => ({
      ...r,
      priceModifierMinor: r.priceMinor - basePriceMinor,
    })),
  };
}
export function templatePriceCheck(template, rows, at) {
  const range = template.priceRange;
  return {
    required: true,
    submittedAt: at,
    targetBy: manilaDay(at),
    flags: rows
      .filter(
        (r) =>
          range &&
          (r.priceMinor < range.minMinor || r.priceMinor > range.maxMinor),
      )
      .map((r) => ({
        optionKey: r.optionKey,
        code: "outside_usual_range",
        priceMinor: r.priceMinor,
        range: structuredClone(range),
      })),
  };
}
export function priceRows(store, item) {
  const group = catalogGroupsForItem(store, item.id).find(
    (g) => g.id === item.templateData?.groupId,
  );
  return (group?.options || [])
    .filter((o) => o.active !== false)
    .map((o) => ({
      optionKey: item.templateData.optionKeys[o.id],
      priceMinor: item.basePriceMinor + o.priceModifierMinor,
    }));
}
export function createProduct(
  store,
  supplierId,
  body,
  args,
  staff,
  item = null,
) {
  object(body);
  const template = templateFor(
    store,
    body.templateId || item?.templateData?.templateId,
  );
  if (
    item &&
    item.templateData.templateId &&
    item.templateData.templateId !== template.id
  )
    fail(
      "template_change_not_allowed",
      "Add a separate product for another template.",
    );
  const service = (store.supplierServices || []).find(
    (s) =>
      s.id === (body.supplierServiceId || item?.supplierServiceId) &&
      s.supplierId === supplierId,
  );
  const subcategory = (store.taxonomy?.subcategories || []).find(
    (s) => s.code === template.subcategoryCode && s.active !== false,
  );
  if (
    !service ||
    !subcategory ||
    resolveCategoryCode(store.taxonomy, service.categoryCode)?.code !==
      subcategory.categoryCode
  )
    fail(
      "template_service_required",
      "Choose your existing service line for this category.",
    );
  const table = convertPriceTable(template, body.prices);
  const chip = READY_TIME_CHIPS.find((c) => c.code === body.readyTime);
  if (!chip) fail("invalid_ready_time", "Choose a ready-time chip.");
  if (
    (body.priceTiers != null && !Array.isArray(body.priceTiers)) ||
    (body.speedTiers != null && !Array.isArray(body.speedTiers))
  )
    fail("invalid_template_request", "Bulk and rush prices must be lists.");
  for (const tier of body.priceTiers || [])
    positive(object(tier).unitPriceMinor);
  for (const tier of body.speedTiers || [])
    if (object(tier).priceMinor != null) positive(tier.priceMinor);
  const at = args.now();
  const before = item ? listingSnapshot(store, item) : null;
  if (!item) {
    if (
      (store.catalogItems || []).some(
        (i) =>
          i.supplierId === supplierId &&
          i.templateData?.templateId === template.id &&
          !i.templateData?.mergedInto,
      )
    )
      fail(
        "template_already_added",
        "This template is already added. Edit its prices.",
        409,
      );
    item = {
      id: args.id("sci"),
      supplierId,
      sortOrder: (store.catalogItems || [])
        .filter((i) => i.supplierId === supplierId)
        .reduce((max, i) => Math.max(max, i.sortOrder + 1), 0),
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    store.catalogItems.push(item);
  }
  if (item.suspendReason || item.suspendedAt)
    fail("listing_suspended", "The GRIDGO team has hidden this product.", 409);
  const width = body.printerMaxWidthFeet ?? item.printerMaxWidthFeet;
  if (
    template.subcategoryCode === "tarpaulins_outdoor_banners" &&
    (!Number.isInteger(width) || width < 1 || width > 20)
  )
    fail("printer_cap_required", "Enter printer width in feet, 1–20.");
  if (
    body.minimumOrderQuantity != null &&
    (!Number.isSafeInteger(body.minimumOrderQuantity) ||
      body.minimumOrderQuantity < 1)
  )
    fail(
      "invalid_template_request",
      "Minimum order must be a positive integer.",
    );
  const formats = template.fileTypes.filter((code) =>
    (store.acceptedFileFormats || []).some(
      (f) => f.code === code && f.active !== false,
    ),
  );
  if (!formats.length)
    fail(
      "template_formats_unavailable",
      "The GRIDGO team needs to enable template file types.",
      409,
    );
  const groupId = item.templateData?.groupId || `${item.id}_template_variants`;
  const oldKeys = item.templateData?.optionKeys || {};
  const previousOptions = store.catalogOptions.filter(
    (o) => o.optionGroupId === groupId,
  );
  Object.assign(item, {
    supplierServiceId: service.id,
    subcategoryCode: template.subcategoryCode,
    name: template.name,
    description: template.description,
    basePriceMinor: table.basePriceMinor,
    pricingUnit:
      template.unit === "page"
        ? "per_page"
        : template.unit === "sq_ft"
          ? "per_area"
          : "per_unit",
    measureUnit: template.unit === "sq_ft" ? "ft" : null,
    packageQty: null,
    printerMaxWidthFeet:
      template.subcategoryCode === "tarpaulins_outdoor_banners" ? width : null,
    minimumOrderQuantity: body.minimumOrderQuantity ?? null,
    fileFormatMode: "override",
    express: template.express === true,
    active: staff ? false : (item.active ?? true),
    ...productionTimeFields(
      chip.productionTime,
      shopProductionDayMinutes(store, supplierId),
    ),
  });
  item.templateData = {
    templateId: template.id,
    templateVersion: template.version,
    managed: true,
    priceOnly: true,
    unit: template.unit,
    readyTime: chip.code,
    stockPhotos: structuredClone(template.stockPhotos),
    clientTips:
      body.clientTips == null
        ? template.clientTips
        : [text(body.clientTips, 2000)],
    groupId,
    optionKeys: {},
    shopConfirmed: !staff,
    confirmedAt: staff ? null : at,
    priceCheck: templatePriceCheck(
      template,
      [
        ...table.rows,
        ...(body.priceTiers || []).map((t, i) => ({
          optionKey: `bulk_${i}`,
          priceMinor: t.unitPriceMinor,
        })),
        ...(body.speedTiers || [])
          .filter((t) => t.priceMinor != null)
          .map((t, i) => ({
            optionKey: `rush_${i}`,
            priceMinor: t.priceMinor,
          })),
      ],
      at,
    ),
  };
  const replacedGroups = new Set(
    store.catalogOptionGroups
      .filter(
        (g) => g.catalogItemId === item.id && (g.kind || "spec") === "spec",
      )
      .map((g) => g.id),
  );
  replacedGroups.add(groupId);
  store.catalogOptionGroups = store.catalogOptionGroups.filter(
    (g) => !replacedGroups.has(g.id),
  );
  store.catalogOptions = store.catalogOptions.filter(
    (o) => !replacedGroups.has(o.optionGroupId),
  );
  store.catalogOptionGroups
    .filter((g) => g.catalogItemId === item.id)
    .forEach((g, i) => (g.sortOrder = i + 1));
  store.catalogOptionGroups.push({
    id: groupId,
    catalogItemId: item.id,
    name: "Option",
    kind: "spec",
    required: true,
    selectionMode: "single",
    sortOrder: 0,
    version: item.version,
    createdAt: at,
    updatedAt: at,
  });
  for (const [i, row] of table.rows.entries()) {
    const optionId =
      previousOptions.find((o) => oldKeys[o.id] === row.optionKey)?.id ||
      args.id("sco");
    item.templateData.optionKeys[optionId] = row.optionKey;
    store.catalogOptions.push({
      id: optionId,
      optionGroupId: groupId,
      label: row.label,
      priceModifierMinor: row.priceModifierMinor,
      specBinding:
        template.options.find((o) => o.key === row.optionKey)?.specBinding ||
        null,
      active: true,
      sortOrder: i,
      createdAt: at,
      updatedAt: at,
    });
  }
  store.catalogItemFileFormats = store.catalogItemFileFormats.filter(
    (f) => f.catalogItemId !== item.id,
  );
  store.catalogItemFileFormats.push(
    ...formats.map((formatCode) => ({ catalogItemId: item.id, formatCode })),
  );
  replacePriceTiers(store, item, body.priceTiers || [], args.now);
  replaceSpeedTiers(store, item, body.speedTiers || [], args.now);
  // Extras and own photographs use the existing governed endpoints and full review.
  if (before) {
    startListingReview(store, item, before);
    bumpVersion(item, at);
  } else {
    item.reviewStatus = "pending";
    item.reviewReason = null;
  }
  args.audit?.(store, {
    actor: args.user,
    action: staff ? "template_product.prepare" : "template_product.save",
    entityType: "supplier_catalog_item",
    entityId: item.id,
    detail: {
      templateId: template.id,
      priceCheck: item.templateData.priceCheck,
    },
  });
  templateNotice(
    store,
    item,
    args,
    staff
      ? "template_product_confirmation_required"
      : "template_product_price_check",
    staff
      ? "Check the prices the GRIDGO team prepared. Confirm before this product can go live."
      : "Your product is queued for a price check today. We will tell you when it is live.",
  );
  return item;
}
