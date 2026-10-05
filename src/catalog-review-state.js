/** Approved composite snapshots isolate supplier drafts from every client price path. */
export const CATALOG_REVIEW_TABLES = [
  "catalogItems", "catalogOptionGroups", "catalogOptions", "catalogItemPhotos",
  "catalogPriceTiers", "catalogSpeedTiers", "catalogItemFileFormats",
];
const LIVE_FIELDS = ["name", "description", "active", "sortOrder", "suspendedAt", "suspendReason", "suspendedBy", "turnaroundMode", "turnaroundHours", "minimumTurnaroundHours"];

export function listingSnapshot(store, item) {
  const { approvedSnapshot, reviewStatus, reviewReason, reviewedAt, reviewedBy, ...record } = item;
  const snapshot = { item: structuredClone(record) };
  const groups = (store.catalogOptionGroups || []).filter(row => row.catalogItemId === item.id);
  for (const key of CATALOG_REVIEW_TABLES.slice(1)) {
    snapshot[key] = structuredClone((store[key] || []).filter(row => key === "catalogOptions"
      ? groups.some(group => group.id === row.optionGroupId) : row.catalogItemId === item.id));
  }
  return snapshot;
}

export function sensitiveSnapshot(snapshot) {
  const value = structuredClone(snapshot);
  // Normalize optional defaults so a released client's text-only PATCH cannot
  // open a review merely by materializing null pricing fields on an old row.
  const fields = ["supplierServiceId", "subcategoryCode", "basePriceMinor", "pricingUnit", "packageQty", "measureUnit",
    "minimumWidthMilli", "minimumHeightMilli", "minimumLengthMilli", "minimumOrderQuantity", "printerMaxWidthFeet", "fileFormatMode"];
  value.item = Object.fromEntries(fields.map(key => [key, snapshot.item[key] ??
    (key === "pricingUnit" ? "per_unit" : key === "fileFormatMode" ? "inherit" : null)]));
  function stable(record) {
    if (Array.isArray(record)) return record.map(stable);
    if (record && typeof record === "object") return Object.fromEntries(Object.keys(record).sort()
      .filter(key => !["version", "createdAt", "updatedAt"].includes(key)).map(key => [key, stable(record[key])]));
    return record;
  }
  return JSON.stringify(stable(value));
}

export function startListingReview(store, item, previous = listingSnapshot(store, item)) {
  if ((item.reviewStatus || "approved") === "approved") item.approvedSnapshot = previous;
  item.reviewStatus = "pending";
  item.reviewReason = null;
  item.reviewedAt = null;
  item.reviewedBy = null;
  retainApprovedPhotos(store, item);
}

export function retainApprovedPhotos(store, item) {
  const photos = [...(item.approvedSnapshot?.catalogItemPhotos || []), ...(store.catalogItemPhotos || []).filter(row => row.catalogItemId === item.id)];
  const fileIds = new Set(photos.map(row => row.fileId));
  for (const file of store.files || []) {
    if (!fileIds.has(file.fileId)) file.references = (file.references || []).filter(row => !(row.type === "supplier_catalog_item" && row.id === item.id));
  }
  for (const photo of photos) {
    const file = (store.files || []).find(row => row.fileId === photo.fileId);
    if (!file) continue;
    file.references ||= [];
    if (!file.references.some(row => row.type === "supplier_catalog_item" && row.id === item.id)) {
      file.references.push({ type: "supplier_catalog_item", id: item.id, field: "photos" });
    }
  }
}

const APPROVED_VIEW = Symbol("approvedCatalogView");
export function approvedCatalogView(store) {
  if (store[APPROVED_VIEW]) return store;
  const revisions = (store.catalogItems || []).filter(item => item.approvedSnapshot);
  if (!revisions.length) return store;
  const view = { ...store, [APPROVED_VIEW]: true };
  for (const key of CATALOG_REVIEW_TABLES) view[key] = [...(store[key] || [])];
  for (const draft of revisions) {
    const snapshot = draft.approvedSnapshot;
    const item = { ...snapshot.item, reviewStatus: "approved" };
    for (const key of LIVE_FIELDS) {
      if (Object.hasOwn(draft, key)) item[key] = draft[key];
    }
    view.catalogItems = view.catalogItems.map(row => row.id === draft.id ? item : row);
    const groupIds = new Set((store.catalogOptionGroups || []).filter(row => row.catalogItemId === draft.id).map(row => row.id));
    for (const key of CATALOG_REVIEW_TABLES.slice(1)) {
      view[key] = view[key].filter(row => key === "catalogOptions" ? !groupIds.has(row.optionGroupId) : row.catalogItemId !== draft.id);
      view[key].push(...(snapshot[key] || []).map(row => {
        if (key === "catalogOptions") return { ...row, sourceOptionId: (store.catalogOptions || []).some(option => option.id === row.id) ? row.id : null };
        if (key === "catalogOptionGroups") return { ...row, sourceOptionGroupId: (store.catalogOptionGroups || []).some(group => group.id === row.id) ? row.id : null };
        return row;
      }));
    }
  }
  return view;
}
