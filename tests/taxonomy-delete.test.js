import test from "node:test";
import assert from "node:assert/strict";

import { routeTaxonomyDelete, taxonomyEntryUsage, usageBlocksDelete } from "../src/taxonomy-delete.js";
import { resolveAuthorizationContext, selectActorRole } from "../src/authorization-context.js";
import { defaultTaxonomy } from "../src/taxonomy.js";

const AT = "2026-09-19T00:00:00.000Z";

function fixture() {
  const taxonomy = defaultTaxonomy();
  // Two entries the build does not ship: one clean, one that shops file against.
  taxonomy.categories.push(
    { id: "taxc_clean", code: "clean_category", name: "Clean category", bestFor: null, sortOrder: 90, productFamilyIds: [], active: true },
    { id: "taxc_busy", code: "busy_category", name: "Busy category", bestFor: null, sortOrder: 91, productFamilyIds: [], active: true },
  );
  taxonomy.subcategories.push(
    { id: "taxs_clean", code: "clean_job", name: "Clean job", categoryCode: "marketing_collateral", examples: [], sortOrder: 90, active: true },
    { id: "taxs_busy", code: "busy_job", name: "Busy job", categoryCode: "busy_category", examples: [], sortOrder: 91, active: true },
    { id: "taxs_hidden", code: "hidden_job", name: "Hidden job", categoryCode: "busy_category", examples: [], sortOrder: 92, active: false },
  );
  return {
    users: [
      { id: "super", role: "super_admin", email: "super@gridgo.test" },
      { id: "ops", role: "ops_admin", email: "ops@gridgo.test" },
      { id: "shop_a", role: "supplier", email: "a@gridgo.test", supplierName: "Printlab Davao" },
      { id: "shop_b", role: "supplier", email: "b@gridgo.test", supplierName: "Fallback name" },
    ],
    userRoleMemberships: [
      { userId: "super", role: "super_admin" },
      { userId: "ops", role: "ops_admin" },
      { userId: "shop_a", role: "supplier" },
      { userId: "shop_b", role: "supplier" },
    ],
    approvalCases: [
      { id: "case_a", userId: "shop_a", kind: "supplier", status: "approved" },
      { id: "case_b", userId: "shop_b", kind: "supplier", status: "approved" },
    ],
    supplierProfiles: [
      { userId: "shop_b", shopName: "Lovis Printshop", contactName: "Lovis", shop: { lat: 7.1, lng: 125.6, label: "Davao" }, pickupAvailable: false, version: 1, updatedAt: AT },
    ],
    supplierServices: [
      { id: "svc_a", supplierId: "shop_a", categoryCode: "busy_category", state: "live" },
    ],
    catalogItems: [
      { id: "item_a", supplierId: "shop_a", supplierServiceId: "svc_a", subcategoryCode: "busy_job", name: "Busy listing" },
      { id: "item_b", supplierId: "shop_b", supplierServiceId: "svc_b", subcategoryCode: "busy_job", name: "Other listing" },
      { id: "item_c", supplierId: "shop_b", supplierServiceId: "svc_b", subcategoryCode: "busy_job", name: "Third listing" },
    ],
    orderLineItems: [
      { id: "line_1", orderId: "ord_1", sourceCatalogItemId: "item_a" },
      { id: "line_2", orderId: "ord_1", sourceCatalogItemId: "item_b" },
      { id: "line_3", orderId: "ord_2", sourceCatalogItemId: "item_b" },
    ],
    listingStarters: [],
    taxonomy,
    auditLog: [],
  };
}

function actor(store, id) {
  const user = store.users.find((candidate) => candidate.id === id);
  return selectActorRole(store, { ...user, context: resolveAuthorizationContext(store, user) }, user.role);
}

function call(store, pathname, { method = "DELETE", userId = "super", audit } = {}) {
  const entries = [];
  const response = routeTaxonomyDelete({
    req: { method, headers: {} },
    url: new URL(`http://127.0.0.1${pathname}`),
    store,
    user: actor(store, userId),
    readBody: async () => ({}),
    now: () => AT,
    audit: audit ?? ((_store, entry) => { entries.push(entry); }),
  });
  return Object.assign(response, { entries });
}

async function rejects(fn, status, code) {
  let caught;
  await assert.rejects(fn, (error) => {
    caught = error;
    assert.equal(error.status, status, `${error.code}: ${error.message}`);
    assert.equal(error.code, code);
    assert.match(error.message, /[A-Za-z]/);
    return true;
  });
  return caught;
}

test("other methods and other paths are ignored", async () => {
  const store = fixture();
  assert.equal(await call(store, "/taxonomy/categories/clean_category", { method: "PATCH" }), null);
  assert.equal(await call(store, "/taxonomy/materials/paper_80gsm"), null);
  assert.equal(await call(store, "/taxonomy/categories"), null);
});

test("only Super Admin may delete; Operations and shops get 403", async () => {
  const store = fixture();
  await rejects(() => call(store, "/taxonomy/categories/clean_category", { userId: "ops" }), 403, "forbidden");
  await rejects(() => call(store, "/taxonomy/subcategories/clean_job", { userId: "shop_a" }), 403, "forbidden");
  assert.ok(store.taxonomy.categories.some((row) => row.code === "clean_category"));
  assert.ok(store.taxonomy.subcategories.some((row) => row.code === "clean_job"));
});

test("an unknown entry is 404 by its own name", async () => {
  const store = fixture();
  await rejects(() => call(store, "/taxonomy/categories/nope"), 404, "category_not_found");
  await rejects(() => call(store, "/taxonomy/subcategories/nope"), 404, "subcategory_not_found");
});

test("a clean print job leaves with an audit row; nothing else moves", async () => {
  const store = fixture();
  const before = store.catalogItems.length;
  const promise = call(store, "/taxonomy/subcategories/clean_job");
  const response = await promise;
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true,
    deleted: { kind: "subcategory", id: "taxs_clean", code: "clean_job", name: "Clean job" },
  });
  assert.equal(response.mutated, true);
  assert.ok(!store.taxonomy.subcategories.some((row) => row.code === "clean_job"));
  assert.equal(store.catalogItems.length, before);
  assert.equal(promise.entries.length, 1);
  assert.equal(promise.entries[0].action, "taxonomy.subcategory_delete");
  assert.equal(promise.entries[0].entityType, "taxonomy_subcategory");
  assert.equal(promise.entries[0].entityId, "taxs_clean");
  assert.equal(promise.entries[0].detail.deleted.code, "clean_job");
});

test("a clean category leaves by id as well as by code", async () => {
  const store = fixture();
  const promise = call(store, "/taxonomy/categories/taxc_clean");
  const response = await promise;
  assert.equal(response.status, 200);
  assert.equal(response.body.deleted.code, "clean_category");
  assert.ok(!store.taxonomy.categories.some((row) => row.code === "clean_category"));
  assert.equal(promise.entries[0].action, "taxonomy.category_delete");
});

test("a print job shops file against is refused with the shops named", async () => {
  const store = fixture();
  const error = await rejects(() => call(store, "/taxonomy/subcategories/busy_job"), 409, "catalog_entry_in_use");
  assert.equal(error.details.kind, "subcategory");
  assert.equal(error.details.code, "busy_job");
  assert.equal(error.details.canRetire, true);
  assert.deepEqual(error.details.usage, {
    listings: 3,
    shops: [
      { supplierId: "shop_a", shopName: "Printlab Davao" },
      { supplierId: "shop_b", shopName: "Lovis Printshop" },
    ],
    orders: 2,
    starters: 0,
  });
  assert.ok(store.taxonomy.subcategories.some((row) => row.code === "busy_job"));
  assert.equal(store.catalogItems.length, 3, "listings are never cascaded");
});

test("a hidden print job in use reports it can no longer be retired", async () => {
  const store = fixture();
  store.catalogItems.push({ id: "item_h", supplierId: "shop_a", supplierServiceId: "svc_a", subcategoryCode: "hidden_job", name: "Old" });
  const error = await rejects(() => call(store, "/taxonomy/subcategories/hidden_job"), 409, "catalog_entry_in_use");
  assert.equal(error.details.canRetire, false);
});

test("a category is refused while print jobs, accreditations, or listings stand under it", async () => {
  const store = fixture();
  const error = await rejects(() => call(store, "/taxonomy/categories/busy_category"), 409, "catalog_entry_in_use");
  assert.deepEqual(error.details.usage, {
    printJobs: 2,
    services: 1,
    aliases: 0,
    listings: 3,
    shops: [
      { supplierId: "shop_a", shopName: "Printlab Davao" },
      { supplierId: "shop_b", shopName: "Lovis Printshop" },
    ],
    orders: 2,
    starters: 0,
  });
  assert.equal(store.supplierServices.length, 1, "accreditations are never cascaded");

  // Print jobs alone are enough to block, even with no shop anywhere near.
  store.supplierServices = [];
  store.catalogItems = [];
  store.orderLineItems = [];
  const bare = await rejects(() => call(store, "/taxonomy/categories/busy_category"), 409, "catalog_entry_in_use");
  assert.equal(bare.details.usage.printJobs, 2);
  assert.equal(bare.details.usage.listings, 0);
});

test("an entry the build ships is refused before usage is even counted", async () => {
  const store = fixture();
  const category = await rejects(() => call(store, "/taxonomy/categories/marketing_collateral"), 409, "catalog_entry_shipped");
  assert.deepEqual(category.details, { kind: "category", code: "marketing_collateral", canRetire: true });
  const job = await rejects(() => call(store, "/taxonomy/subcategories/flyers"), 409, "catalog_entry_shipped");
  assert.equal(job.details.kind, "subcategory");
  assert.equal(store.taxonomy.categories.length, defaultTaxonomy().categories.length + 2);
});

test("usage counts starters and legacy aliases as blockers because the database does", () => {
  const store = fixture();
  store.listingStarters.push({ id: "starter_x", subcategoryCode: "clean_job", name: "Starter" });
  const job = store.taxonomy.subcategories.find((row) => row.code === "clean_job");
  const usage = taxonomyEntryUsage(store, "subcategories", job);
  assert.deepEqual(usage, { listings: 0, shops: [], orders: 0, starters: 1 });
  assert.equal(usageBlocksDelete(usage), true);

  store.taxonomy.categoryAliases.push({ code: "old_clean", categoryCode: "clean_category" });
  const category = store.taxonomy.categories.find((row) => row.code === "clean_category");
  const categoryUsage = taxonomyEntryUsage(store, "categories", category);
  assert.equal(categoryUsage.aliases, 1);
  assert.equal(usageBlocksDelete(categoryUsage), true);
  assert.equal(usageBlocksDelete({ listings: 0, shops: [], orders: 0, starters: 0 }), false);
});
