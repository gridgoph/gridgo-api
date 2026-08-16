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
    payout_milestones, order_payments, orders, supplier_services, zones,
    taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
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
  assert.equal(store.auditLog.length, 1);
  assert.equal(store.auditLog[0].action, "administrator.bootstrap");
  await database.close();
});
