import { identityHasMembership } from './authorization-context.js';
import { approvedCatalogView } from './catalog-review-state.js';
import { CatalogError, publicCatalogItem } from './supplier-catalog.js';
import { supplierMatchBlockersFor } from './supplier-eligibility.js';
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';

const MAX_ITEMS = 20;
const configuration = store => store.settings?.featuredPrints ?? { version: 1, catalogItemIds: [] };

// Home is an anonymous product card, never a shop or order projection. Keep
// this allowlist narrow, including nested photos (no owner, filename or alt).
function featuredItem(store, item, shopBlockers) {
  if (!item) return null;
  const profile = (store.supplierProfiles || []).find(row => row.userId === item.supplierId);
  if (shopBlockers(item.supplierId, profile).length) return null;
  const listing = publicCatalogItem(store, item);
  if (!listing || !Number.isSafeInteger(listing.clientFromPriceMinor)) return null;
  return {
    id: listing.id,
    name: listing.name,
    categoryCode: listing.categoryCode,
    subcategoryCode: listing.subcategoryCode,
    clientFromPriceMinor: listing.clientFromPriceMinor,
    pricingUnit: listing.pricingUnit,
    packageQty: listing.packageQty,
    measureUnit: listing.measureUnit,
    minimumOrderQuantity: listing.minimumOrderQuantity,
    photos: listing.photos.slice(0, 1).map(({ fileId, sortOrder, url }) => ({ fileId, sortOrder, url })),
  };
}

function selectedItems(store, ids) {
  const view = approvedCatalogView(store);
  const byId = new Map((view.catalogItems || []).map(item => [item.id, item]));
  const shopBlockers = supplierMatchBlockersFor(view);
  return ids.map(catalogItemId => {
    const item = featuredItem(view, byId.get(catalogItemId), shopBlockers);
    return { catalogItemId, available: Boolean(item), item };
  });
}

export function publicFeaturedPrints(store) {
  const items = selectedItems(store, configuration(store).catalogItemIds).flatMap(row => row.item ? [row.item] : []);
  return {
    title: 'FEATURED PRINTS',
    items,
    emptyState: items.length ? null : { action: 'browse_catalog', message: 'Explore print products to start your first print.' },
  };
}

export async function routeFeaturedPrints({ req, url, store, user, readBody, audit, id, now }) {
  if (url.pathname !== '/admin/featured-prints' || !['GET', 'PUT'].includes(req.method)) return null;
  if (!user) throw new CatalogError(401, 'unauthorized', 'Sign in to GRIDGO.');
  if (!['ops_admin', 'super_admin'].some(role => identityHasMembership(user, role))) {
    throw new CatalogError(403, 'forbidden', 'Only Operations and Super Admin can curate Featured Prints.');
  }
  const previous = configuration(store);
  if (req.method === 'GET') {
    return { status: 200, body: { ...previous, items: selectedItems(store, previous.catalogItemIds) } };
  }
  const body = await readBody(req);
  if (!body || Array.isArray(body) || typeof body !== 'object'
      || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
    throw new CatalogError(400, 'featured_prints_version_required', 'Send the version read from Featured Prints as expectedVersion.');
  }
  if (body.expectedVersion !== previous.version) {
    throw new CatalogError(409, 'featured_prints_version_conflict', 'Reload Featured Prints before saving.', { version: previous.version });
  }
  const ids = body.catalogItemIds;
  if (!Array.isArray(ids) || ids.length > MAX_ITEMS || ids.some(value => typeof value !== 'string' || !value.trim() || value.length > 200)
      || new Set(ids).size !== ids.length) {
    throw new CatalogError(400, 'invalid_featured_prints', 'Choose at most 20 distinct catalogue item IDs in display order.');
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > 2000) throw new CatalogError(400, 'featured_prints_reason_required', 'Provide a reason of 1–2000 characters.');
  const items = selectedItems(store, ids);
  const unavailable = items.filter(row => !row.available).map(row => row.catalogItemId);
  if (unavailable.length) throw new CatalogError(409, 'featured_prints_item_unavailable', 'Choose approved, available products with sample photos.', { catalogItemIds: unavailable });
  const current = { version: previous.version + 1, catalogItemIds: [...ids] };
  store.settings = { ...store.settings, featuredPrints: current };
  audit(store, { actor: user, action: 'catalog.featured_prints_update', entityType: 'settings', entityId: 'featured_prints', reason,
    detail: { previous: structuredClone(previous), current: structuredClone(current) } });
  const at = now();
  for (const membership of privilegedAdminMemberships(store)) {
    store.notifications.push({ id: id('ntf'), userId: membership.userId, appRole: membership.role,
      type: 'featured_prints_updated', title: 'Featured Prints updated', body: 'GRIDGO’s curated Home products were updated.', at, read: false, push: false });
  }
  queueInvalidate(store, { resource: 'catalog' });
  queueInvalidate(store, { resource: 'notifications', userIds: privilegedAdminMemberships(store).map(row => row.userId) });
  return { status: 200, body: { ...current, items }, mutated: true };
}
