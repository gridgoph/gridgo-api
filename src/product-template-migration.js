import {
  catalogGroupsForItem,
  minimumCatalogPrice,
} from "./supplier-catalog.js";
import { fail, object } from "./product-template-common.js";
function openOrderItem(store, item) {
  const terminal = ["completed", "cancelled", "closed"];
  if (
    (store.orderJobs || []).some(
      (j) =>
        j.supplierId === item.supplierId &&
        !terminal.includes(j.state) &&
        !(store.orderLineItems || []).some(
          (l) => l.jobId === j.id && l.sourceCatalogItemId,
        ),
    )
  )
    return true;
  if (
    (store.orders || []).some(
      (o) =>
        o.supplierId === item.supplierId &&
        !terminal.includes(o.state) &&
        !(store.orderLineItems || []).some(
          (l) => l.orderId === o.id && l.sourceCatalogItemId,
        ),
    )
  )
    return true;
  const lines = (store.orderLineItems || []).filter(
    (l) => l.sourceCatalogItemId === item.id,
  );
  return (
    lines.some((l) => {
      const order = (store.orders || []).find((o) => o.id === l.orderId);
      return (
        !order || !["completed", "cancelled", "closed"].includes(order.state)
      );
    }) ||
    (store.orders || []).some(
      (o) =>
        o.supplierId === item.supplierId &&
        !["completed", "cancelled", "closed"].includes(o.state) &&
        (o.catalogItemId === item.id ||
          o.items?.some?.((l) => l.catalogItemId === item.id)),
    )
  );
}
function signature(store, item, ignoreCopy = false) {
  // Compare the entire operational shape, including future pricing fields.
  // Identity, display copy and source timestamps do not affect a price.
  const omit = (row, keys) =>
    Object.fromEntries(
      Object.entries(row).filter(([key]) => !keys.includes(key)),
    );
  const child = (row) =>
    omit(row, [
      "id",
      "catalogItemId",
      "optionGroupId",
      "createdAt",
      "updatedAt",
      "version",
    ]);
  const groups = catalogGroupsForItem(store, item.id);
  const stable = (value) =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, stable(value[key])]),
          )
        : value;
  return JSON.stringify(
    stable({
      item: omit(item, [
        "id",
        ...(ignoreCopy ? ["name", "description"] : []),
        "sortOrder",
        "version",
        "createdAt",
        "updatedAt",
        "reviewStatus",
        "reviewReason",
        "reviewedAt",
        "reviewedBy",
      ]),
      groups: groups.map((g) => ({
        ...child(omit(g, ["options"])),
        options: g.options.map(child),
      })),
      tiers: (store.catalogPriceTiers || [])
        .filter((t) => t.catalogItemId === item.id)
        .map(child),
      speeds: (store.catalogSpeedTiers || [])
        .filter((t) => t.catalogItemId === item.id)
        .map(child),
      prep: (store.catalogPrepSteps || [])
        .filter((t) => t.catalogItemId === item.id)
        .map(child),
      formats: (store.catalogItemFileFormats || [])
        .filter((f) => f.catalogItemId === item.id)
        .map((f) => f.formatCode)
        .sort(),
    }),
  );
}
export function migrationPlan(store, supplierId, choices = {}) {
  const actions = [],
    manual = [],
    keepers = new Map();
  const items = (store.catalogItems || [])
    .filter((i) => i.supplierId === supplierId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  const selected = new Set();
  if (
    choices.mergeGroups != null &&
    (!Array.isArray(choices.mergeGroups) || choices.mergeGroups.length > 100)
  )
    fail("invalid_template_merge", "Use at most 100 merge groups.");
  for (const group of choices.mergeGroups || []) {
    object(group);
    if (
      !Array.isArray(group.sourceIds) ||
      !group.sourceIds.length ||
      group.sourceIds.length > 199
    )
      fail("invalid_template_merge", "Choose source products.");
    const ids = [group.keepId, ...group.sourceIds];
    if (
      new Set(ids).size !== ids.length ||
      ids.some((key) => selected.has(key))
    )
      fail(
        "invalid_template_merge",
        "A product can appear in only one merge group.",
      );
    ids.forEach((key) => selected.add(key));
    const rows = ids.map((key) => items.find((i) => i.id === key));
    if (rows.some((row) => !row))
      fail("catalog_item_not_found", "Merge only this shop products.", 404);
    if (rows.some((row) => openOrderItem(store, row))) {
      manual.push(
        ...rows.map((row) => ({
          itemId: row.id,
          reason: "merge_has_open_orders",
        })),
      );
      continue;
    }
    const candidate =
      (store.productTemplates || []).find(
        (t) =>
          t.id === choices.templateMatches?.[group.keepId] &&
          t.active !== false &&
          t.subcategoryCode === rows[0].subcategoryCode,
      ) ||
      (store.productTemplates || [])
        .filter(
          (t) =>
            t.active !== false && t.subcategoryCode === rows[0].subcategoryCode,
        )
        .find((t, i, all) => all.length === 1);
    const stableShape = (row) =>
      signature(store, { ...row, basePriceMinor: 1 }, true);
    if (
      !candidate ||
      rows.some(
        (row) =>
          row.templateData ||
          row.approvedSnapshot ||
          row.suspendReason ||
          row.suspendedAt ||
          row.active === false ||
          (row.reviewStatus && row.reviewStatus !== "approved") ||
          row.basePriceMinor <= 0 ||
          row.pricedByColour ||
          (store.catalogPriceTiers || []).some(
            (tier) => tier.catalogItemId === row.id,
          ) ||
          (store.catalogSpeedTiers || []).some(
            (tier) => tier.catalogItemId === row.id,
          ) ||
          catalogGroupsForItem(store, row.id).length ||
          stableShape(row) !== stableShape(rows[0]),
      )
    ) {
      manual.push(
        ...rows.map((row) => ({
          itemId: row.id,
          reason: "merge_requires_manual_configuration",
        })),
      );
      continue;
    }
    const labels = rows.map((row) => group.labels?.[row.id] || row.name);
    if (
      labels.some(
        (label) =>
          typeof label !== "string" || !label.trim() || label.length > 100,
      ) ||
      new Set(labels.map((l) => l.trim().toLowerCase())).size !== rows.length
    ) {
      manual.push(
        ...rows.map((row) => ({
          itemId: row.id,
          reason: "merge_variant_labels_required",
        })),
      );
      continue;
    }
    actions.push({
      action: "merge_variants",
      itemId: rows[0].id,
      templateId: candidate.id,
      expectedVersion: rows[0].version,
      variants: rows.map((row, i) => ({
        itemId: row.id,
        label: labels[i].trim(),
        priceMinor: row.basePriceMinor,
        expectedVersion: row.version,
      })),
    });
  }
  for (const item of items) {
    if (selected.has(item.id)) continue;
    if (openOrderItem(store, item)) {
      manual.push({ itemId: item.id, reason: "open_orders" });
      continue;
    }
    if (item.templateData) {
      manual.push({ itemId: item.id, reason: "already_matched" });
      continue;
    }
    if (
      item.quoteRequestId ||
      item.suspendReason ||
      item.suspendedAt ||
      item.approvedSnapshot ||
      (item.reviewStatus && item.reviewStatus !== "approved")
    ) {
      manual.push({ itemId: item.id, reason: "review_or_hold" });
      continue;
    }
    if (minimumCatalogPrice(store, item) <= 0) {
      actions.push({
        itemId: item.id,
        expectedVersion: item.version,
        action: "hide_unpriced",
      });
      continue;
    }
    const chosen = choices.templateMatches?.[item.id];
    const candidates = (store.productTemplates || []).filter(
      (t) =>
        t.active !== false &&
        t.subcategoryCode === item.subcategoryCode &&
        (!chosen || t.id === chosen),
    );
    if (candidates.length !== 1) {
      manual.push({
        itemId: item.id,
        reason: "ambiguous_template",
        templateIds: candidates.map((t) => t.id),
      });
      continue;
    }
    const key = signature(store, item),
      keeper = keepers.get(key);
    actions.push({
      itemId: item.id,
      expectedVersion: item.version,
      action: keeper ? "merge_duplicate" : "match",
      templateId: candidates[0].id,
      ...(keeper ? { mergedInto: keeper.id } : {}),
    });
    if (!keeper) keepers.set(key, item);
  }
  return { supplierId, actions, manual };
}
