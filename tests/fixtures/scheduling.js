import { defaultOperationalSettings } from "../../src/operational-model.js";
import { defaultTaxonomy } from "../../src/taxonomy.js";
import { prepareArtworkCheckout, routeOrderMatch } from "../../src/order-match-routes.js";
// Wednesday 09:00 in Davao. Both shops need three working days (30 hours).
const NOW = "2026-09-23T01:00:00.000Z";
export function addShop(store, supplierId, { express = false, lat = 7.064, lng = 125.6085, schedule = null, closed = false } = {}) {
  store.users.push({ id: supplierId, role: "supplier", email: `${supplierId}@gridgo.test` });
  store.userRoleMemberships.push({ userId: supplierId, role: "supplier" });
  store.approvalCases.push({ id: `case_${supplierId}`, userId: supplierId, kind: "supplier", status: "approved" });
  store.supplierProfiles.push({ userId: supplierId, shopName: `${supplierId} Shop`, contactName: supplierId,
    shop: { lat, lng, label: `${supplierId} Davao` }, pickupAvailable: true, isClosed: closed, ...(schedule ? { schedule } : {}) });
  const serviceId = `service_${supplierId}`;
  store.supplierServices.push({ id: serviceId, supplierId, categoryCode: "marketing_collateral", state: "live",
    pricingBasis: "per_unit", referenceRateMinor: 10_000, turnaroundHours: 30, standardTurnaroundHours: 30, version: 1 });
  store.supplierServiceFileFormats.push({ supplierServiceId: serviceId, formatCode: "pdf" });
  const itemId = `item_${supplierId}`;
  store.catalogItems.push({ id: itemId, supplierId, supplierServiceId: serviceId, subcategoryCode: "flyers",
    name: `${supplierId} Flyers`, description: "Full-color flyers", basePriceMinor: 10_000, pricingUnit: "per_unit",
    turnaroundMode: "inherit", fileFormatMode: "inherit", active: true, sortOrder: 0, version: 1, express });
  store.files.push({ fileId: `photo_${itemId}`, ownerId: supplierId, purpose: "catalog_item_photo", state: "ready", objectKey: `${supplierId}/flyers.jpg` });
  store.catalogItemPhotos.push({ catalogItemId: itemId, fileId: `photo_${itemId}`, sortOrder: 0 });
  return store.catalogItems.at(-1);
}

export function fixture({ express = false } = {}) {
  const client = { id: "user_client", role: "client", email: "client@gridgo.test" };
  const store = {
    settings: { ...defaultOperationalSettings(), hubPickupEnabled: true, promiseAllowanceMinutes: 60 },
    taxonomy: defaultTaxonomy(),
    users: [client], userRoleMemberships: [{ userId: client.id, role: "client" }],
    clientPreferences: [], clientAddresses: [], carts: [], cartLines: [],
    supplierProfiles: [], approvalCases: [], supplierServices: [], supplierServiceFileFormats: [],
    acceptedFileFormats: [{ code: "pdf", displayName: "PDF", inputKind: "file", active: true }],
    catalogItems: [], catalogItemFileFormats: [], catalogItemPhotos: [], catalogOptionGroups: [], catalogOptions: [], catalogPrepSteps: [],
    files: [], orders: [], orderJobs: [], orderLineItems: [], orderLineItemOptions: [], jobQaChecklist: [], orderInvoices: [],
    notifications: [], auditLog: [], shopReviews: [],
  };
  addShop(store, "shop_a", { express });
  addShop(store, "shop_b", { lat: 7.09, lng: 125.63 });
  store.files.push(
    { fileId: "file_art", ownerId: client.id, purpose: "artwork", detectedContentType: "application/pdf", artworkCheck: { status: "passed", checkedAt: NOW }, state: "ready", objectKey: "client/art.pdf", references: [] },
    { fileId: "file_qr", ownerId: client.id, purpose: "payment_proof", state: "ready", objectKey: "client/qr.jpg", references: [] },
  );
  return { store, client };
}

export function caller(store, user, at = NOW) {
  let sequence = 0;
  return async (method, pathname, body) => {
    const req = { method };
    await prepareArtworkCheckout({ req, pathname, store, user, checker: async () => ({ ok: true }) });
    return routeOrderMatch({ req, url: new URL(`http://gridgo.test${pathname}`), store, user,
      readBody: async () => body || {}, id: (prefix) => `${prefix}_${++sequence}`, now: () => at });
  };
}

