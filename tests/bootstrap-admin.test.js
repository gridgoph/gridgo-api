import test from "node:test";
import assert from "node:assert/strict";

import { bootstrapAdministrator } from "../src/bootstrap-admin.js";
import { createDatabase } from "../src/database.js";
import { emptyStore, loadStore, saveStore } from "../src/postgres-store.js";

const DATABASE_URL = process.env.DATABASE_URL;

test("administrator bootstrap succeeds once and closes permanently", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, proofs, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, files,
    payout_milestones, order_payments, order_line_item_options, order_line_items, orders,
    supplier_catalog_item_photos, supplier_shop_media, supplier_catalog_item_file_formats,
    supplier_catalog_options, supplier_catalog_option_groups, supplier_catalog_items,
    supplier_service_file_formats, supplier_service_price_tiers, supplier_services,
    listing_starter_options, listing_starter_groups, listing_starters, accepted_file_formats,
    zones, taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
    taxonomy_category_aliases, taxonomy_categories, catalog_products, users,
    platform_settings RESTART IDENTITY CASCADE`);
  await database.transaction(() => saveStore(database, emptyStore()));

  const clerkBackend = { users: { getUser: async (id) => ({
    id,
    firstName: "First",
    lastName: "Administrator",
    primaryEmailAddress: { emailAddress: "admin@gridgo.test" },
    primaryPhoneNumber: { phoneNumber: "+639001234567" },
  }) } };
  const first = await bootstrapAdministrator({
    database, clerkBackend, clerkUserId: "clerk_first_admin",
    createId: () => "user_first_admin", now: () => "2026-08-16T00:00:00.000Z",
  });
  assert.equal(first.role, "super_admin");
  assert.equal(first.clerkUserId, "clerk_first_admin");

  await assert.rejects(
    bootstrapAdministrator({ database, clerkBackend, clerkUserId: "clerk_second_admin" }),
    /already completed.*permanently closed/i,
  );

  const store = await loadStore(database);
  assert.equal(store.users.length, 1);
  assert.deepEqual(store.userRoleMemberships, [{
    userId: "user_first_admin",
    role: "super_admin",
    createdAt: "2026-08-16T00:00:00.000Z",
    createdBy: "user_first_admin",
  }]);
  assert.equal(store.auditLog.length, 1);
  assert.equal(store.auditLog[0].action, "administrator.bootstrap");
  await database.close();
});

test("administrator bootstrap detects existing privilege from memberships", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, proofs, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, files,
    payout_milestones, order_payments, order_line_item_options, order_line_items, orders,
    supplier_catalog_item_photos, supplier_shop_media, supplier_catalog_item_file_formats,
    supplier_catalog_options, supplier_catalog_option_groups, supplier_catalog_items,
    supplier_service_file_formats, supplier_service_price_tiers, supplier_services,
    listing_starter_options, listing_starter_groups, listing_starters, accepted_file_formats,
    zones, taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
    taxonomy_category_aliases, taxonomy_categories, catalog_products, users,
    platform_settings RESTART IDENTITY CASCADE`);
  const store = emptyStore();
  store.users.push({
    id: "user_existing_ops", clerkUserId: "clerk_existing_ops",
    email: "existing-ops@gridgo.test", name: "Existing Ops",
    role: "client", accountType: "individual", createdAt: "2026-08-15T00:00:00.000Z",
  });
  store.userRoleMemberships.push({
    userId: "user_existing_ops", role: "ops_admin", createdAt: "2026-08-15T00:00:00.000Z",
  });
  await database.transaction(() => saveStore(database, store));

  const clerkBackend = { users: { getUser: async () => ({
    primaryEmailAddress: { emailAddress: "new-admin@gridgo.test" },
    firstName: "New",
    lastName: "Administrator",
  }) } };
  await assert.rejects(
    bootstrapAdministrator({ database, clerkBackend, clerkUserId: "clerk_new_admin" }),
    /privileged.*already exists.*permanently closed/i,
  );
  assert.equal(
    Number((await database.query("SELECT count(*) AS count FROM administrator_bootstrap")).rows[0].count),
    0,
  );
  await database.close();
});
