import test from "node:test";
import assert from "node:assert/strict";

import { createDatabase } from "../src/database.js";
import { loadStore, saveStore } from "../src/postgres-store.js";
import { seedReferenceData } from "../src/seed.js";

const DATABASE_URL = process.env.DATABASE_URL;

test("fresh seed is idempotent platform reference data with no accounts", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, proofs, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, files,
    payout_milestones, order_payments, order_line_item_options, order_line_items, orders,
    supplier_catalog_prep_steps, supplier_catalog_item_photos, supplier_shop_media, supplier_catalog_item_file_formats,
    supplier_catalog_options, supplier_catalog_option_groups, supplier_catalog_items,
    supplier_service_file_formats, supplier_service_price_tiers, supplier_services,
    listing_starter_options, listing_starter_groups, listing_starters, accepted_file_formats,
    zones, taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
    taxonomy_category_aliases, taxonomy_categories, catalog_products, users,
    platform_settings RESTART IDENTITY CASCADE`);

  await seedReferenceData(database);
  const first = await loadStore(database);
  await seedReferenceData(database);
  const second = await loadStore(database);

  assert.deepEqual(second, first);
  assert.ok(first.catalog.length > 0);
  assert.ok(first.taxonomy.categories.length > 0);
  assert.ok(first.zones.length > 0);
  assert.ok(first.settings.deliveryFeeBands.length > 0);
  for (const key of ["users", "supplierServices", "orders", "files", "claims", "issues", "auditLog", "notifications", "locationPings", "escalations", "proofs", "deviceTokens"]) {
    assert.deepEqual(first[key], [], key);
  }
  assert.deepEqual(first.credits, {});
  assert.equal(Object.hasOwn(first, "sessions"), false);
  assert.equal(Number((await database.query("SELECT count(*) AS count FROM administrator_bootstrap")).rows[0].count), 0);

  await database.transaction(async () => {
    const customized = await loadStore(database);
    customized.version += 1;
    customized.settings.issueWindowHours = 48;
    customized.taxonomy.categories.push({
      id: "taxc_ops",
      code: "ops_special",
      name: "Operations special",
      active: true,
      sortOrder: 99,
    });
    await saveStore(database, customized);
  });
  await seedReferenceData(database);
  const preserved = await loadStore(database);
  assert.equal(preserved.version, first.version + 1);
  assert.equal(preserved.settings.issueWindowHours, 48);
  assert.ok(preserved.taxonomy.categories.some((item) => item.code === "ops_special"));
  await database.close();
});
