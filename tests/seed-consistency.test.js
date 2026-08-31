import test from "node:test";
import assert from "node:assert/strict";

import { createDatabase } from "../src/database.js";
import { loadStore, saveStore } from "../src/postgres-store.js";
import { seedReferenceData } from "../src/seed.js";
import { flattenListingStarters } from "../src/reference-data.js";
import { defaultListingStarters } from "../src/listing-starters.js";

const DATABASE_URL = process.env.DATABASE_URL;

test("fresh seed is idempotent platform reference data with no accounts", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, escalations, location_pings, notifications, audit_log,
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
  for (const key of ["users", "supplierServices", "orders", "files", "claims", "issues", "auditLog", "notifications", "locationPings", "escalations", "deviceTokens"]) {
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

test("a starter's multiplying add-on survives the whole way to a board", () => {
  // Lovis prices back-to-back as "x2 the price", which as a flat amount has to
  // be re-entered by hand every time the base price moves. The multiplier was
  // dropped twice on the way -- once flattening a starter into reference rows,
  // once copying a starter onto a shop's listing -- and each time the add-on
  // arrived silently free rather than visibly wrong.
  const { listingStarterOptions } = flattenListingStarters();
  const duplex = listingStarterOptions.find((option) => option.id === "lsto_doc_duplex");
  assert.equal(duplex.priceMultiplierBps, 20_000);
  // An option multiplies or it adds, never both. The database enforces it too.
  assert.equal(duplex.priceModifierMinor, 0);

  for (const option of listingStarterOptions) {
    if (option.priceMultiplierBps != null) assert.equal(option.priceModifierMinor, 0, option.id);
  }
});

test("a printer or a garment choice prices the way the master list quotes it", () => {
  // Each of these is a variant the catalogue could not express until options
  // could carry the difference: two printers at different rates per square
  // foot, four plot sizes, and the two jobs an apparel shop actually sells.
  const starters = defaultListingStarters();
  const groups = flattenListingStarters(starters).listingStarterGroups;
  const options = flattenListingStarters(starters).listingStarterOptions;
  const modifier = (id) => options.find((option) => option.id === id)?.priceModifierMinor;

  // Eco solvent PHP 40.00 a square foot, UV PHP 90.00. Options add to the rate
  // before it multiplies by size, so the difference is per square foot too.
  assert.equal(modifier("lsto_tarp_eco"), 0);
  assert.equal(modifier("lsto_tarp_uv"), 5_000);

  // Stickers: PHP 63.50 and PHP 162.00, and mounted on board PHP 280/PHP 320.
  assert.equal(modifier("lsto_sticker_uv"), 9_850);
  assert.equal(modifier("lsto_sticker_sintra3"), 21_650);
  assert.equal(modifier("lsto_sticker_sintra5"), 25_650);

  // CAD plotting: PHP 65, 80, 150, 180 across the four sheet sizes.
  assert.equal(modifier("lsto_plot_a2"), 0);
  assert.equal(modifier("lsto_plot_a1"), 1_500);
  assert.equal(modifier("lsto_plot_30x40"), 8_500);
  assert.equal(modifier("lsto_plot_a0"), 11_500);

  // A t-shirt is PHP 180 pressed with cloth and PHP 75 printed onto one the
  // client brings. A board offering only the first turns away half the trade.
  assert.equal(modifier("lsto_apparel_print_only"), -10_500);

  // 8oz tarpaulin is deliberately absent: the master list says neither printer
  // can run it, and an option nobody can print is not an option. Matched on a
  // word boundary, because 18oz is a weight the shop does run.
  assert.equal(options.some((option) => /\b8oz\b/.test(option.label)), false);
  assert.equal(options.some((option) => /\b18oz\b/.test(option.label)), true);

  // Every id is unique. A duplicated group silently collided on its ordering
  // and took the whole reference seed down with it.
  const groupIds = groups.map((group) => group.id);
  const optionIds = options.map((option) => option.id);
  assert.equal(new Set(groupIds).size, groupIds.length, "group ids are unique");
  assert.equal(new Set(optionIds).size, optionIds.length, "option ids are unique");
});
