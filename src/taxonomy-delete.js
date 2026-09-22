/**
 * Safe delete for the two taxonomy entries the Super Admin dashboard edits: a
 * category and a print job (subcategory).
 *
 * "Safe" here is a hard rule, not a soft warning. PostgreSQL restricts every
 * foreign key that points at these rows, and the seed re-appends anything the
 * build ships. So a delete is only allowed when nothing else stands on the
 * entry and the build did not ship it. Everything else answers 409 with the
 * reason spelled out, so the dashboard can show who is standing on it and
 * offer to hide the entry from new listings instead (`active: false`, which
 * the existing PATCH already owns).
 *
 * Nothing is ever cascaded: a shop's listings, its accreditation, and every
 * order stay exactly as they are.
 */
import { identityHasMembership } from "./authorization-context.js";
import { CatalogError } from "./supplier-catalog.js";
import { defaultTaxonomy } from "./taxonomy.js";

const KINDS = {
  categories: {
    kind: "category",
    collection: "categories",
    notFound: "category_not_found",
    action: "taxonomy.category_delete",
    entityType: "taxonomy_category",
  },
  subcategories: {
    kind: "subcategory",
    collection: "subcategories",
    notFound: "subcategory_not_found",
    action: "taxonomy.subcategory_delete",
    entityType: "taxonomy_subcategory",
  },
};

const ROUTE = /^\/taxonomy\/(categories|subcategories)\/([^/]+)$/;

function fail(status, code, message, details = {}) {
  throw new CatalogError(status, code, message, details);
}

/** Codes this build seeds. The seed appends any of them that is missing, so a delete would not stick. */
export function shippedTaxonomyCodes(collection) {
  return new Set((defaultTaxonomy()[collection] || []).map((entry) => entry.code));
}

function shopFor(store, supplierId) {
  const profile = (store.supplierProfiles || []).find((row) => row.userId === supplierId);
  const user = (store.users || []).find((row) => row.id === supplierId);
  return {
    supplierId,
    shopName: profile?.shopName || user?.supplierName || user?.name || supplierId,
  };
}

function ordersOnListings(store, listingIds) {
  const orderIds = new Set();
  for (const line of store.orderLineItems || []) {
    if (listingIds.has(line.sourceCatalogItemId)) orderIds.add(line.orderId);
  }
  return orderIds.size;
}

function subcategoryUsage(store, codes) {
  const listings = (store.catalogItems || []).filter((item) => codes.has(item.subcategoryCode));
  const listingIds = new Set(listings.map((item) => item.id));
  const shopIds = [...new Set(listings.map((item) => item.supplierId))];
  return {
    listings: listings.length,
    shops: shopIds.map((supplierId) => shopFor(store, supplierId)),
    orders: ordersOnListings(store, listingIds),
    starters: (store.listingStarters || []).filter((starter) => codes.has(starter.subcategoryCode)).length,
  };
}

/**
 * Everything that would stop this entry from leaving, counted so the dashboard
 * can say who. Each figure mirrors a database restriction or a live reference:
 * listings and starters point at a print job; print jobs, aliases and shop
 * accreditations (services) point at a category. Orders are counted through
 * the listings they were placed against so the breakdown can say so.
 */
export function taxonomyEntryUsage(store, collection, entry) {
  if (collection === "subcategories") {
    return subcategoryUsage(store, new Set([entry.code]));
  }
  const printJobs = (store.taxonomy?.subcategories || []).filter((sub) => sub.categoryCode === entry.code);
  const services = (store.supplierServices || []).filter((service) => service.categoryCode === entry.code);
  const under = subcategoryUsage(store, new Set(printJobs.map((sub) => sub.code)));
  const shopIds = [...new Set([...services.map((service) => service.supplierId), ...under.shops.map((shop) => shop.supplierId)])];
  return {
    printJobs: printJobs.length,
    services: services.length,
    aliases: (store.taxonomy?.categoryAliases || []).filter((alias) => alias.categoryCode === entry.code).length,
    listings: under.listings,
    shops: shopIds.map((supplierId) => shopFor(store, supplierId)),
    orders: under.orders,
    starters: under.starters,
  };
}

export function usageBlocksDelete(usage) {
  return Object.entries(usage).some(([key, value]) => key !== "shops" && Number(value) > 0);
}

export function isTaxonomyDeleteRoute(method, pathname) {
  return method === "DELETE" && ROUTE.test(pathname);
}

export async function routeTaxonomyDelete({ req, url, store, user, audit }) {
  const match = req.method === "DELETE" ? ROUTE.exec(url.pathname) : null;
  if (!match) return null;
  if (!user || !identityHasMembership(user, "super_admin")) {
    fail(403, "forbidden", "Only Super Admin can delete a catalogue entry.");
  }
  const spec = KINDS[match[1]];
  const identifier = decodeURIComponent(match[2]);
  const list = store.taxonomy?.[spec.collection] || [];
  const entry = list.find((row) => row.id === identifier || row.code === identifier);
  if (!entry) fail(404, spec.notFound, "That entry is not on the chart.");

  const canRetire = entry.active !== false;
  if (shippedTaxonomyCodes(spec.collection).has(entry.code)) {
    fail(409, "catalog_entry_shipped", "This entry ships with GRIDGO and would come back at the next seed. Hide it instead.", {
      kind: spec.kind, code: entry.code, canRetire,
    });
  }
  const usage = taxonomyEntryUsage(store, spec.collection, entry);
  if (usageBlocksDelete(usage)) {
    fail(409, "catalog_entry_in_use", "Shops or orders already stand on this entry. Hide it instead.", {
      kind: spec.kind, code: entry.code, usage, canRetire,
    });
  }

  store.taxonomy[spec.collection] = list.filter((row) => row !== entry);
  if (typeof audit === "function") {
    audit(store, {
      actor: user,
      action: spec.action,
      entityType: spec.entityType,
      entityId: entry.id,
      detail: { deleted: entry, usage },
    });
  }
  return {
    status: 200,
    body: { ok: true, deleted: { kind: spec.kind, id: entry.id, code: entry.code, name: entry.name } },
    mutated: true,
  };
}
