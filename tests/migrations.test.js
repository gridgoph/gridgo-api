import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
let schemaSequence = 0;

function migrationOptions(schema, direction, count, client) {
  return {
    dbClient: client,
    dir: MIGRATIONS_DIR,
    direction,
    count,
    schema,
    migrationsSchema: schema,
    migrationsTable: "pgmigrations",
    noLock: true,
    log: () => {},
  };
}

async function withMigrationSchema(t, fn) {
  const schema = `gridgo_migration_${process.pid}_${schemaSequence++}`;
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });
  await fn({ schema, client });
}

test("fresh PostgreSQL migrates through onboarding, catalog, and money additions and reverses them in order", { skip: !DATABASE_URL }, async (t) => {
  await withMigrationSchema(t, async ({ schema, client }) => {
    await runner(migrationOptions(schema, "up", undefined, client));

    const tables = new Set((await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
      [schema],
    )).rows.map((row) => row.table_name));
    for (const table of [
      "user_role_memberships", "client_profiles", "supplier_profiles", "rider_profiles",
      "approval_cases", "approval_case_events", "rider_documents", "supplier_payment_terms",
      "order_payment_allocations", "platform_revenue_adjustments",
      "accepted_file_formats", "supplier_service_price_tiers", "supplier_service_file_formats",
      "supplier_catalog_items", "supplier_catalog_item_photos", "supplier_shop_media",
      "supplier_catalog_option_groups", "supplier_catalog_options", "supplier_catalog_item_file_formats",
      "order_line_items", "order_line_item_options",
    ]) assert.equal(tables.has(table), true, `${table} should exist after up`);

    const legacyColumns = new Set((await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users'",
      [schema],
    )).rows.map((row) => row.column_name));
    for (const column of ["role", "account_type", "org_name", "verification_status", "shop_lat", "shop_lng", "shop_label"]) {
      assert.equal(legacyColumns.has(column), true, `${column} compatibility projection should remain`);
    }

    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query("SELECT to_regclass('supplier_payment_terms') AS table_name")).rows[0].table_name, null);
    assert.equal((await client.query("SELECT to_regclass('supplier_catalog_items') AS table_name")).rows[0].table_name, "supplier_catalog_items");

    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query("SELECT to_regclass('supplier_catalog_items') AS table_name")).rows[0].table_name, null);
    assert.equal((await client.query("SELECT to_regclass('user_role_memberships') AS table_name")).rows[0].table_name, "user_role_memberships");

    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query("SELECT to_regclass('user_role_memberships') AS table_name")).rows[0].table_name, null);
    assert.equal((await client.query("SELECT to_regclass('users') AS table_name")).rows[0].table_name, "users");

    await client.query(`
      INSERT INTO users
        (id, clerk_user_id, email, name, role, account_type, created_at, position, data)
      VALUES ('down_user', 'clerk_down_user', 'down@test.invalid', 'Down User', 'client', 'individual', now(), 0, '{}');
      INSERT INTO files
        (file_id, owner_id, purpose, original_filename, declared_content_type,
         state, object_key, created_at, position, data)
      VALUES ('down_file', 'down_user', 'test', 'test.jpg', 'image/jpeg', 'ready', 'down/test.jpg', now(), 0, '{}');
    `);
    await assert.rejects(
      client.query(`
        INSERT INTO file_references
          (file_id, reference_type, reference_id, field, position, data)
        VALUES ('down_file', 'rider_document', 'down_document', 'fileId', 0, '{}')
      `),
      (error) => error.code === "23514" && error.constraint === "file_references_reference_type_check",
    );

    await runner(migrationOptions(schema, "up", 3, client));
    assert.equal((await client.query("SELECT to_regclass('rider_documents') AS table_name")).rows[0].table_name, "rider_documents");
  });
});

test("service-fee migration backfills legacy money, payments, allocations, and settings", { skip: !DATABASE_URL }, async (t) => {
  await withMigrationSchema(t, async ({ schema, client }) => {
    await runner(migrationOptions(schema, "up", 3, client));
    await client.query(`
      INSERT INTO platform_settings (singleton, version, settings)
      VALUES (true, 7, '{"issueWindowHours":48,"serviceFeeRateBps":750}');
      INSERT INTO users
        (id, clerk_user_id, email, name, role, account_type, verification_status,
         shop_lat, shop_lng, shop_label, created_at, position, data)
      VALUES
        ('money_client', 'clerk_money_client', 'money-client@test.invalid', 'Money Client',
         'client', 'individual', NULL, NULL, NULL, NULL, TIMESTAMPTZ '2026-08-16T00:00:00.000Z', 0, '{}'),
        ('money_supplier', 'clerk_money_supplier', 'money-supplier@test.invalid', 'Money Supplier',
         'supplier', NULL, 'approved', 7.064, 125.6085, 'Davao Shop', TIMESTAMPTZ '2026-08-16T00:00:00.000Z', 1,
         '{"supplierName":"Money Shop","pickupAvailable":true}');
      INSERT INTO user_role_memberships (user_id, role, created_at)
      VALUES ('money_client', 'client', TIMESTAMPTZ '2026-08-16T00:00:00.000Z'), ('money_supplier', 'supplier', TIMESTAMPTZ '2026-08-16T00:00:00.000Z');
      INSERT INTO supplier_profiles
        (user_id, shop_name, contact_name, shop_lat, shop_lng, shop_label, pickup_available, updated_at)
      VALUES ('money_supplier', 'Money Shop', 'Money Supplier', 7.064, 125.6085, 'Davao Shop', true, TIMESTAMPTZ '2026-08-16T00:00:00.000Z');
      INSERT INTO orders
        (id, client_id, supplier_id, state, supplier_price_minor, commission_minor,
         subtotal_minor, delivery_fee_minor, total_minor, downpayment_minor, balance_minor,
         pickup_lat, pickup_lng, pickup_label, dropoff_lat, dropoff_lng, dropoff_label,
         payout_hold, created_at, updated_at, position, data)
      VALUES
        ('legacy_money', 'money_client', 'money_supplier', 'awaiting_downpayment',
         100000, 10000, 110000, 2500, 112500, 84375, 28125,
         7.064, 125.6085, 'Davao Shop', 7.08, 125.62, 'Client', false,
         TIMESTAMPTZ '2026-08-16T00:00:00.000Z', TIMESTAMPTZ '2026-08-16T00:00:00.000Z', 0, '{}');
      INSERT INTO order_payments
        (order_id, code, amount_minor, method, status, position, data)
      VALUES
        ('legacy_money', 'downpayment', 84375, 'qr_manual', 'confirmed', 0, '{}'),
        ('legacy_money', 'balance', 28125, 'qr_manual', 'not_submitted', 1, '{}');
    `);

    await runner(migrationOptions(schema, "up", 1, client));

    assert.deepEqual((await client.query("SELECT version, settings FROM platform_settings")).rows[0], {
      version: 7,
      settings: { issueWindowHours: 48, serviceFeeRateBps: 750 },
    });
    const columns = new Set((await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'orders'",
      [schema],
    )).rows.map((row) => row.column_name));
    assert.equal(columns.has("supplier_subtotal_minor"), true);
    assert.equal(columns.has("service_fee_minor"), true);
    assert.equal(columns.has("supplier_price_minor"), false);
    assert.equal(columns.has("commission_minor"), false);

    assert.deepEqual((await client.query(`
      SELECT supplier_subtotal_minor, subtotal_minor, service_fee_rate_bps,
             service_fee_minor, fulfillment_mode, payment_plan, quote_version,
             online_due_minor, direct_store_due_minor, supplier_platform_payout_minor,
             money_model_version
        FROM orders WHERE id = 'legacy_money'
    `)).rows[0], {
      supplier_subtotal_minor: "100000",
      subtotal_minor: "100000",
      service_fee_rate_bps: 1000,
      service_fee_minor: "10000",
      fulfillment_mode: "delivery",
      payment_plan: "delivery_online",
      quote_version: 1,
      online_due_minor: "112500",
      direct_store_due_minor: "0",
      supplier_platform_payout_minor: "100000",
      money_model_version: 1,
    });
    assert.deepEqual((await client.query(
      "SELECT code, amount_minor FROM order_payments WHERE order_id = 'legacy_money' ORDER BY position",
    )).rows, [
      { code: "initial", amount_minor: "84375" },
      { code: "final_online", amount_minor: "28125" },
    ]);
    assert.deepEqual((await client.query(`
      SELECT payment_code, component, amount_minor
        FROM order_payment_allocations
       WHERE order_id = 'legacy_money'
       ORDER BY payment_code, component
    `)).rows, [
      { payment_code: "final_online", component: "delivery_pass_through", amount_minor: "2500" },
      { payment_code: "final_online", component: "supplier_principal", amount_minor: "25625" },
      { payment_code: "initial", component: "delivery_pass_through", amount_minor: "0" },
      { payment_code: "initial", component: "service_fee", amount_minor: "10000" },
      { payment_code: "initial", component: "supplier_principal", amount_minor: "74375" },
    ]);
    assert.deepEqual((await client.query(
      "SELECT delivery_downpayment_rate_bps, pickup_full_online_enabled, pickup_downpayment_store_enabled FROM supplier_payment_terms WHERE supplier_id = 'money_supplier'",
    )).rows[0], {
      delivery_downpayment_rate_bps: 0,
      pickup_full_online_enabled: true,
      pickup_downpayment_store_enabled: false,
    });
    await client.query("BEGIN");
    await client.query("DELETE FROM supplier_payment_terms WHERE supplier_id = 'money_supplier'");
    await assert.rejects(
      client.query("COMMIT"),
      (error) => error.code === "23514" && error.constraint === "supplier_payment_terms_pickup_mode_check",
    );
    await client.query("ROLLBACK");

    await client.query(`
      INSERT INTO platform_revenue_adjustments
        (id, order_id, kind, amount_minor, reason, created_by, created_at)
      VALUES
        ('revenue_refund', 'legacy_money', 'refund', -1000, 'Partial refund', 'money_supplier', now())
    `);
    await assert.rejects(
      client.query("UPDATE platform_revenue_adjustments SET amount_minor = -500 WHERE id = 'revenue_refund'"),
      (error) => error.code === "42501" && /append-only/.test(error.message),
    );

    await runner(migrationOptions(schema, "down", 1, client));
    const reversedColumns = new Set((await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'orders'",
      [schema],
    )).rows.map((row) => row.column_name));
    assert.equal(reversedColumns.has("supplier_price_minor"), true);
    assert.equal(reversedColumns.has("commission_minor"), true);
    assert.equal((await client.query("SELECT code FROM order_payments WHERE order_id = 'legacy_money' ORDER BY position")).rows[0].code, "downpayment");
    assert.equal((await client.query("SELECT settings->>'serviceFeeRateBps' AS rate FROM platform_settings")).rows[0].rate, "750");
  });
});

test("cutover-shaped users backfill memberships, profiles, cases, events, and constraints", { skip: !DATABASE_URL }, async (t) => {
  await withMigrationSchema(t, async ({ schema, client }) => {
    await runner(migrationOptions(schema, "up", 1, client));
    const at = "2026-08-16T00:00:00.000Z";

    await client.query(`
      INSERT INTO users
        (id, clerk_user_id, email, name, role, account_type, org_name,
         verification_status, shop_lat, shop_lng, shop_label, created_at, position, data)
      VALUES
        ('personal', 'clerk_personal', 'personal@test.invalid', 'Personal', 'client', 'individual', NULL, NULL, NULL, NULL, NULL, $1, 0, '{}'),
        ('business', 'clerk_business', 'business@test.invalid', 'Business', 'client', 'business', 'Legacy Co', NULL, NULL, NULL, NULL, $1, 1, '{}'),
        ('organization', 'clerk_organization', 'organization@test.invalid', 'Organization', 'client', 'organization', 'Community Org', NULL, NULL, NULL, NULL, $1, 2, '{"businessNature":"Community services"}'),
        ('supplier', 'clerk_supplier', 'supplier@test.invalid', 'Supplier Contact', 'supplier', NULL, NULL, 'rejected', 7.064, 125.6085, 'Davao shop', $1, 3,
          '{"supplierName":"PrintRight", "contactName":"Ben Supplier", "pickupAvailable":true, "rejectionReason":"Incomplete catalogue"}'),
        ('rider_pending', 'clerk_rider_pending', 'rider-pending@test.invalid', 'Pending Rider', 'rider', NULL, NULL, 'unverified', NULL, NULL, NULL, $1, 4,
          '{"vehicleType":"bicycle", "plateNumber":"BIKE-1", "licenseNumber":"LIC-1"}'),
        ('rider_approved', 'clerk_rider_approved', 'rider-approved@test.invalid', 'Approved Rider', 'rider', NULL, NULL, 'approved', NULL, NULL, NULL, $1, 5, '{}'),
        ('ops', 'clerk_ops', 'ops@test.invalid', 'Ops', 'ops_admin', NULL, NULL, NULL, NULL, NULL, NULL, $1, 6, '{}'),
        ('super', 'clerk_super', 'super@test.invalid', 'Super', 'super_admin', NULL, NULL, NULL, NULL, NULL, NULL, $1, 7, '{}')
    `, [at]);

    await runner(migrationOptions(schema, "up", 1, client));

    const memberships = (await client.query("SELECT user_id, role FROM user_role_memberships ORDER BY user_id")).rows;
    assert.equal(memberships.length, 8);
    assert.deepEqual(memberships.find((row) => row.user_id === "super"), { user_id: "super", role: "super_admin" });

    const clients = (await client.query("SELECT user_id, client_kind, business_name, business_nature FROM client_profiles ORDER BY user_id")).rows;
    assert.deepEqual(clients, [
      { user_id: "business", client_kind: "business", business_name: "Legacy Co", business_nature: null },
      { user_id: "organization", client_kind: "business", business_name: "Community Org", business_nature: "Community services" },
      { user_id: "personal", client_kind: "personal", business_name: null, business_nature: null },
    ]);

    assert.deepEqual((await client.query("SELECT shop_name, contact_name, pickup_available FROM supplier_profiles WHERE user_id = 'supplier'")).rows[0], {
      shop_name: "PrintRight",
      contact_name: "Ben Supplier",
      pickup_available: true,
    });
    assert.deepEqual((await client.query("SELECT vehicle_type, plate_number, license_number FROM rider_profiles WHERE user_id = 'rider_pending'")).rows[0], {
      vehicle_type: "bicycle",
      plate_number: "BIKE-1",
      license_number: "LIC-1",
    });
    assert.deepEqual((await client.query("SELECT vehicle_type, plate_number FROM rider_profiles WHERE user_id = 'rider_approved'")).rows[0], {
      vehicle_type: "motorcycle",
      plate_number: "PROFILE-COMPLETION-REQUIRED",
    });

    const cases = (await client.query("SELECT user_id, kind, status, submitted_at, decided_at, rejection_reason FROM approval_cases ORDER BY user_id")).rows;
    assert.equal(cases.length, 5);
    assert.equal(cases.some((row) => row.user_id === "personal"), false);
    assert.deepEqual(cases.find((row) => row.user_id === "business"), {
      user_id: "business", kind: "business_client", status: "approved",
      submitted_at: new Date(at), decided_at: new Date(at), rejection_reason: null,
    });
    assert.equal(cases.find((row) => row.user_id === "rider_pending").submitted_at, null);
    assert.equal(cases.find((row) => row.user_id === "supplier").rejection_reason, "Incomplete catalogue");

    const events = (await client.query("SELECT actor_kind, actor_user_id, from_status, request_id FROM approval_case_events ORDER BY request_id")).rows;
    assert.equal(events.length, cases.length);
    assert.equal(events.every((event) => event.actor_kind === "system" && event.actor_user_id === null && event.from_status === null), true);
    assert.equal(new Set(events.map((event) => event.request_id)).size, events.length);

    await assert.rejects(
      client.query("UPDATE approval_case_events SET reason = 'rewritten'"),
      (error) => error.code === "42501" && /append-only/.test(error.message),
    );
    await assert.rejects(
      client.query("DELETE FROM approval_case_events"),
      (error) => error.code === "42501" && /append-only/.test(error.message),
    );

    await assert.rejects(
      client.query("INSERT INTO client_profiles (user_id, client_kind, business_name, business_nature, updated_at) VALUES ('ops', 'business', 'New Business', NULL, now())"),
      (error) => error.code === "23514" && error.constraint === "client_profiles_business_fields_check",
    );

    await client.query("BEGIN");
    await client.query(`
      INSERT INTO approval_cases
        (id, user_id, kind, status, submitted_at, created_at, updated_at)
      VALUES ('case_wrong_membership', 'personal', 'supplier', 'pending', now(), now(), now())
    `);
    await assert.rejects(
      client.query("COMMIT"),
      (error) => error.code === "23514" && error.constraint === "approval_cases_matching_membership_check",
    );
    await client.query("ROLLBACK");

    await client.query(`
      INSERT INTO files
        (file_id, owner_id, purpose, original_filename, declared_content_type,
         detected_content_type, size_bytes, state, object_key, created_at, position, data)
      VALUES
        ('license_one', 'rider_approved', 'rider_verification_document', 'license.jpg', 'image/jpeg', 'image/jpeg', 10, 'ready', 'riders/license-one', $1, 0, '{}'),
        ('license_two', 'rider_approved', 'rider_verification_document', 'license2.jpg', 'image/jpeg', 'image/jpeg', 10, 'ready', 'riders/license-two', $1, 1, '{}')
    `, [at]);
    await client.query(`
      INSERT INTO rider_documents
        (id, rider_id, kind, file_id, expires_on, uploaded_at)
      VALUES ('document_one', 'rider_approved', 'drivers_license', 'license_one', '2027-08-16', $1)
    `, [at]);
    await assert.rejects(
      client.query(`
        INSERT INTO rider_documents
          (id, rider_id, kind, file_id, expires_on, uploaded_at)
        VALUES ('document_two', 'rider_approved', 'drivers_license', 'license_two', '2027-08-16', $1)
      `, [at]),
      (error) => error.code === "23505" && error.constraint === "rider_documents_one_current_kind_idx",
    );
    await client.query(`
      INSERT INTO file_references
        (file_id, reference_type, reference_id, field, position, data)
      VALUES
        ('license_one', 'rider_document', 'document_one', 'fileId', 0, '{}'),
        ('license_two', 'user', 'rider_approved', 'fileId', 1, '{}')
    `);

    const indexNames = new Set((await client.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = $1",
      [schema],
    )).rows.map((row) => row.indexname));
    for (const index of [
      "user_role_memberships_role_idx", "approval_cases_queue_idx",
      "rider_documents_one_current_kind_idx", "rider_documents_expiry_idx",
    ]) assert.equal(indexNames.has(index), true, `${index} should exist`);

    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query("SELECT to_regclass('rider_documents') AS table_name")).rows[0].table_name, null);
    assert.deepEqual((await client.query("SELECT file_id, reference_type FROM file_references ORDER BY file_id")).rows, [
      { file_id: "license_two", reference_type: "user" },
    ]);
    await assert.rejects(
      client.query(`
        INSERT INTO file_references
          (file_id, reference_type, reference_id, field, position, data)
        VALUES ('license_one', 'rider_document', 'document_one', 'fileId', 0, '{}')
      `),
      (error) => error.code === "23514" && error.constraint === "file_references_reference_type_check",
    );
  });
});

test("catalog migration enforces bounds, deferred completeness, snapshot math, and immutability", { skip: !DATABASE_URL }, async (t) => {
  await withMigrationSchema(t, async ({ schema, client }) => {
    await runner(migrationOptions(schema, "up", undefined, client));
    const at = "2026-08-16T00:00:00.000Z";
    await client.query(`
      INSERT INTO taxonomy_categories (id, code, name, active, sort_order, position, data)
      VALUES ('cat_marketing', 'marketing_collateral', 'Marketing', true, 1, 0, '{}');
      INSERT INTO users
        (id, clerk_user_id, email, name, role, account_type, verification_status,
         shop_lat, shop_lng, shop_label, created_at, position, data)
      VALUES
        ('supplier', 'clerk_supplier', 'supplier@catalog.test', 'Supplier', 'supplier', NULL, 'approved',
         7.1, 125.6, 'Shop', '${at}', 0, '{}'),
        ('client', 'clerk_client', 'client@catalog.test', 'Client', 'client', 'individual', NULL,
         NULL, NULL, NULL, '${at}', 1, '{}');
      INSERT INTO user_role_memberships (user_id, role, created_at)
      VALUES ('supplier', 'supplier', '${at}'), ('client', 'client', '${at}');
      INSERT INTO supplier_profiles
        (user_id, shop_name, contact_name, shop_lat, shop_lng, shop_label, updated_at)
      VALUES ('supplier', 'Catalog Shop', 'Supplier', 7.1, 125.6, 'Shop', '${at}');
      INSERT INTO supplier_services
        (id, supplier_id, category_code, state, reference_rate_minor, turnaround_hours,
         pricing_basis, standard_turnaround_hours, created_at, updated_at, position, data)
      VALUES ('service', 'supplier', 'marketing_collateral', 'live', 0, 24,
        'per_unit', 24, '${at}', '${at}', 0, '{}');
      INSERT INTO supplier_service_file_formats (supplier_service_id, format_code)
      VALUES ('service', 'pdf');
      INSERT INTO files
        (file_id, owner_id, purpose, original_filename, declared_content_type,
         detected_content_type, size_bytes, state, object_key, created_at, position, data)
      VALUES
        ('photo', 'supplier', 'catalog_item_photo', 'photo.jpg', 'image/jpeg',
         'image/jpeg', 10, 'ready', 'catalog/photo.jpg', '${at}', 0, '{}'),
        ('overflow_photo', 'supplier', 'catalog_item_photo', 'overflow.jpg', 'image/jpeg',
         'image/jpeg', 10, 'ready', 'catalog/overflow.jpg', '${at}', 1, '{}');
      INSERT INTO supplier_catalog_items
        (id, supplier_id, supplier_service_id, name, base_price_minor,
         file_format_mode, sort_order, created_at, updated_at)
      VALUES
        ('item', 'supplier', 'service', 'Poster', 100, 'inherit', 0, '${at}', '${at}'),
        ('item_two', 'supplier', 'service', 'Flyer', 100, 'inherit', 1, '${at}', '${at}');
      INSERT INTO supplier_catalog_item_photos
        (catalog_item_id, file_id, sort_order, created_at)
      VALUES ('item', 'photo', 0, '${at}');
    `);

    await assert.rejects(
      client.query(`
        INSERT INTO supplier_catalog_item_photos
          (catalog_item_id, file_id, sort_order, created_at)
        VALUES ('item', 'overflow_photo', 8, $1)
      `, [at]),
      (error) => error.code === "23514" && /sort_order/.test(error.constraint),
    );
    await assert.rejects(
      client.query("UPDATE supplier_services SET rush_enabled = true WHERE id = 'service'"),
      (error) => error.code === "23514" && error.constraint === "supplier_services_rush_check",
    );
    await client.query(`
      INSERT INTO supplier_catalog_item_photos
        (catalog_item_id, file_id, sort_order, created_at)
      VALUES ('item', 'overflow_photo', 1, $1)
    `, [at]);
    await client.query("BEGIN");
    await client.query("UPDATE supplier_catalog_item_photos SET sort_order = 1 WHERE file_id = 'photo'");
    await client.query("UPDATE supplier_catalog_item_photos SET sort_order = 0 WHERE file_id = 'overflow_photo'");
    await client.query("COMMIT");
    assert.deepEqual((await client.query(`
      SELECT file_id, sort_order FROM supplier_catalog_item_photos
       WHERE catalog_item_id = 'item' ORDER BY sort_order
    `)).rows, [
      { file_id: "overflow_photo", sort_order: 0 },
      { file_id: "photo", sort_order: 1 },
    ]);
    await assert.rejects(
      client.query(`
        INSERT INTO supplier_catalog_option_groups
          (id, catalog_item_id, name, sort_order, created_at, updated_at)
        VALUES ('group_overflow', 'item', 'Overflow', 6, $1, $1)
      `, [at]),
      (error) => error.code === "23514" && /sort_order/.test(error.constraint),
    );

    await client.query("BEGIN");
    await client.query(`
      INSERT INTO supplier_catalog_option_groups
        (id, catalog_item_id, name, sort_order, created_at, updated_at)
      VALUES ('group', 'item', 'Paper size', 0, $1, $1)
    `, [at]);
    await client.query(`
      INSERT INTO supplier_catalog_options
        (id, option_group_id, label, price_modifier_minor, sort_order, created_at, updated_at)
      VALUES
        ('option', 'group', 'A3', -150, 0, $1, $1),
        ('option_two', 'group', 'A4', 0, 1, $1, $1)
    `, [at]);
    await client.query("COMMIT");

    await assert.rejects(
      client.query(`
        INSERT INTO supplier_catalog_options
          (id, option_group_id, label, sort_order, created_at, updated_at)
        VALUES ('option_overflow', 'group', 'Overflow', 20, $1, $1)
      `, [at]),
      (error) => error.code === "23514" && /sort_order/.test(error.constraint),
    );

    await client.query("BEGIN");
    await client.query(`
      INSERT INTO supplier_catalog_option_groups
        (id, catalog_item_id, name, sort_order, created_at, updated_at)
      VALUES ('group_two', 'item_two', 'Finish', 0, $1, $1)
    `, [at]);
    await client.query(`
      INSERT INTO supplier_catalog_options
        (id, option_group_id, label, price_modifier_minor, sort_order, created_at, updated_at)
      VALUES ('option_three', 'group_two', 'Matte', 0, 0, $1, $1)
    `, [at]);
    await client.query("COMMIT");
    await assert.rejects(
      client.query("UPDATE supplier_catalog_options SET option_group_id = 'group_two' WHERE id = 'option'"),
      (error) => error.code === "23514" && error.constraint === "supplier_catalog_option_parent_immutable",
    );
    assert.equal((await client.query(
      "SELECT option_group_id FROM supplier_catalog_options WHERE id = 'option'",
    )).rows[0].option_group_id, "group");

    await client.query("BEGIN");
    await client.query(`
      INSERT INTO supplier_catalog_items
        (id, supplier_id, supplier_service_id, name, base_price_minor,
         file_format_mode, sort_order, created_at, updated_at)
      VALUES
        ('override_one', 'supplier', 'service', 'Override one', 100, 'override', 2, $1, $1),
        ('override_two', 'supplier', 'service', 'Override two', 100, 'override', 3, $1, $1)
    `, [at]);
    await client.query(`
      INSERT INTO supplier_catalog_item_file_formats (catalog_item_id, format_code)
      VALUES ('override_one', 'pdf'), ('override_two', 'png')
    `);
    await client.query("COMMIT");
    await assert.rejects(
      client.query(`
        UPDATE supplier_catalog_item_file_formats
           SET catalog_item_id = 'override_two'
         WHERE catalog_item_id = 'override_one' AND format_code = 'pdf'
      `),
      (error) => error.code === "23514" && error.constraint === "supplier_catalog_item_format_parent_immutable",
    );
    assert.equal((await client.query(`
      SELECT catalog_item_id FROM supplier_catalog_item_file_formats
       WHERE format_code = 'pdf' AND catalog_item_id LIKE 'override_%'
    `)).rows[0].catalog_item_id, "override_one");

    await client.query("BEGIN");
    await client.query(`
      INSERT INTO supplier_catalog_items
        (id, supplier_id, supplier_service_id, name, base_price_minor,
         file_format_mode, sort_order, created_at, updated_at)
      VALUES ('bad_override', 'supplier', 'service', 'Bad override', 100, 'override', 1, $1, $1)
    `, [at]);
    await assert.rejects(
      client.query("COMMIT"),
      (error) => error.code === "23514" && error.constraint === "supplier_catalog_item_format_mode_check",
    );
    await client.query("ROLLBACK");

    await client.query(`
      INSERT INTO orders
        (id, client_id, supplier_id, state, payout_hold,
         dropoff_lat, dropoff_lng, dropoff_label, created_at, updated_at, position, data)
      VALUES
        ('order', 'client', 'supplier', 'draft', false,
          7.2, 125.7, 'Dropoff', $1, $1, 0, '{}'),
        ('order_two', 'client', 'supplier', 'draft', false,
          7.2, 125.7, 'Dropoff two', $1, $1, 1, '{}')
    `, [at]);
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO order_line_items
        (id, order_id, source_catalog_item_id, source_supplier_service_id,
         item_name_snapshot, pricing_basis_snapshot, base_unit_price_minor,
         effective_unit_price_minor, quantity, line_subtotal_minor,
         accepted_format_codes_snapshot, structured_spec_snapshot, sort_order, created_at)
      VALUES ('line', 'order', 'item', 'service', 'Poster', 'per_unit', 100,
        0, 2, 0, ARRAY['pdf'], '{"paper_size":"A3"}', 0, $1)
    `, [at]);
    await client.query(`
      INSERT INTO order_line_item_options
        (id, order_line_item_id, source_option_group_id, source_option_id,
         group_name_snapshot, option_label_snapshot, price_modifier_minor, sort_order)
      VALUES ('line_option', 'line', 'group', 'option', 'Paper size', 'A3', -150, 0)
    `);
    await client.query("UPDATE order_line_items SET snapshot_finalized = true WHERE id = 'line'");
    await client.query("COMMIT");
    await assert.rejects(
      client.query(`
        INSERT INTO order_line_item_options
          (id, order_line_item_id, source_option_group_id, source_option_id,
           group_name_snapshot, option_label_snapshot, price_modifier_minor, sort_order)
        VALUES ('line_option_late', 'line', 'group', 'option_two', 'Paper size', 'A4', 0, 1)
      `),
      (error) => error.code === "23514" && error.constraint === "order_line_item_options_immutable_check",
    );
    await client.query(`
      INSERT INTO order_line_items
        (id, order_id, source_catalog_item_id, source_supplier_service_id,
         item_name_snapshot, pricing_basis_snapshot, base_unit_price_minor,
         effective_unit_price_minor, quantity, line_subtotal_minor,
         accepted_format_codes_snapshot, structured_spec_snapshot, sort_order,
         snapshot_finalized, created_at)
      VALUES ('line_two', 'order_two', 'item_two', 'service', 'Flyer', 'per_unit', 100,
        100, 1, 100, ARRAY['pdf'], '{}', 1, true, $1)
    `, [at]);
    await assert.rejects(
      client.query("UPDATE order_line_items SET id = 'line_two_rewritten' WHERE id = 'line_two'"),
      (error) => error.code === "23514" && error.constraint === "order_line_items_immutable_check",
    );
    await assert.rejects(
      client.query("UPDATE order_line_item_options SET id = 'line_option_rewritten' WHERE id = 'line_option'"),
      (error) => error.code === "23514" && error.constraint === "order_line_item_options_immutable_check",
    );

    await client.query("BEGIN");
    await client.query(`
      INSERT INTO order_line_items
        (id, order_id, source_catalog_item_id, source_supplier_service_id,
         item_name_snapshot, pricing_basis_snapshot, base_unit_price_minor,
         effective_unit_price_minor, quantity, line_subtotal_minor,
         accepted_format_codes_snapshot, structured_spec_snapshot, sort_order, created_at)
      VALUES ('line_unfinalized', 'order', 'item', 'service', 'Draft line', 'per_unit', 100,
        100, 1, 100, ARRAY['pdf'], '{}', 2, $1)
    `, [at]);
    await assert.rejects(
      client.query("COMMIT"),
      (error) => error.code === "23514" && error.constraint === "order_line_items_snapshot_finalized_check",
    );
    await client.query("ROLLBACK");

    await client.query("UPDATE supplier_catalog_items SET name = 'Renamed', base_price_minor = 999 WHERE id = 'item'");
    assert.deepEqual((await client.query(`
      SELECT item_name_snapshot, base_unit_price_minor, effective_unit_price_minor, line_subtotal_minor
        FROM order_line_items WHERE id = 'line'
    `)).rows[0], {
      item_name_snapshot: "Poster",
      base_unit_price_minor: "100",
      effective_unit_price_minor: "0",
      line_subtotal_minor: "0",
    });
    await assert.rejects(
      client.query("UPDATE order_line_items SET item_name_snapshot = 'Rewritten' WHERE id = 'line'"),
      (error) => error.code === "23514" && error.constraint === "order_line_items_immutable_check",
    );
    await assert.rejects(
      client.query("UPDATE order_line_items SET order_id = 'order_two' WHERE id = 'line'"),
      (error) => error.code === "23514" && error.constraint === "order_line_items_immutable_check",
    );
    await assert.rejects(
      client.query("UPDATE order_line_items SET source_catalog_item_id = 'item_two' WHERE id = 'line'"),
      (error) => error.code === "23514" && error.constraint === "order_line_items_immutable_check",
    );
    await assert.rejects(
      client.query("UPDATE order_line_item_options SET order_line_item_id = 'line_two' WHERE id = 'line_option'"),
      (error) => error.code === "23514" && error.constraint === "order_line_item_options_immutable_check",
    );
    await assert.rejects(
      client.query("UPDATE order_line_item_options SET source_option_id = 'option_two' WHERE id = 'line_option'"),
      (error) => error.code === "23514" && error.constraint === "order_line_item_options_immutable_check",
    );
    await assert.rejects(
      client.query(`
        UPDATE order_line_items
           SET source_catalog_item_id = NULL, source_supplier_service_id = NULL
         WHERE id = 'line'
      `),
      (error) => error.code === "23514" && error.constraint === "order_line_items_immutable_check",
    );
    await assert.rejects(
      client.query(`
        UPDATE order_line_item_options
           SET source_option_group_id = NULL, source_option_id = NULL
         WHERE id = 'line_option'
      `),
      (error) => error.code === "23514" && error.constraint === "order_line_item_options_immutable_check",
    );
    await client.query("DELETE FROM supplier_catalog_options WHERE id = 'option'");
    assert.deepEqual((await client.query(`
      SELECT source_option_group_id, source_option_id, group_name_snapshot,
             option_label_snapshot, price_modifier_minor
        FROM order_line_item_options WHERE id = 'line_option'
    `)).rows[0], {
      source_option_group_id: "group",
      source_option_id: null,
      group_name_snapshot: "Paper size",
      option_label_snapshot: "A3",
      price_modifier_minor: "-150",
    });
    await client.query("DELETE FROM supplier_catalog_option_groups WHERE id = 'group'");
    assert.equal((await client.query(`
      SELECT source_option_group_id FROM order_line_item_options WHERE id = 'line_option'
    `)).rows[0].source_option_group_id, null);
    await client.query("DELETE FROM supplier_catalog_items WHERE id = 'item'");
    assert.deepEqual((await client.query(`
      SELECT source_catalog_item_id, source_supplier_service_id, item_name_snapshot,
             pricing_basis_snapshot, base_unit_price_minor, effective_unit_price_minor
        FROM order_line_items WHERE id = 'line'
    `)).rows[0], {
      source_catalog_item_id: null,
      source_supplier_service_id: "service",
      item_name_snapshot: "Poster",
      pricing_basis_snapshot: "per_unit",
      base_unit_price_minor: "100",
      effective_unit_price_minor: "0",
    });
    await client.query("DELETE FROM supplier_catalog_items");
    await client.query("DELETE FROM supplier_service_file_formats WHERE supplier_service_id = 'service'");
    await client.query("DELETE FROM supplier_services WHERE id = 'service'");
    assert.equal((await client.query(`
      SELECT source_supplier_service_id FROM order_line_items WHERE id = 'line'
    `)).rows[0].source_supplier_service_id, null);
    await assert.rejects(
      client.query("DELETE FROM order_line_item_options WHERE id = 'line_option'"),
      (error) => error.code === "23514" && error.constraint === "order_line_item_options_immutable_check",
    );
    await assert.rejects(
      client.query("DELETE FROM order_line_items WHERE id = 'line'"),
      (error) => error.code === "23514" && error.constraint === "order_line_items_immutable_check",
    );
    await client.query("DELETE FROM orders WHERE id IN ('order', 'order_two')");
    assert.equal((await client.query("SELECT count(*)::integer AS count FROM order_line_items")).rows[0].count, 0);
  });
});

test("catalog category foreign key preserves retired-code service rows without weakening new writes", { skip: !DATABASE_URL }, async (t) => {
  await withMigrationSchema(t, async ({ schema, client }) => {
    await runner(migrationOptions(schema, "up", 2, client));
    const at = "2026-08-16T00:00:00.000Z";
    await client.query(`
      INSERT INTO taxonomy_categories (id, code, name, active, sort_order, position, data)
      VALUES ('category', 'marketing_collateral', 'Marketing', true, 1, 0, '{}');
      INSERT INTO taxonomy_category_aliases (code, category_code, position, data)
      VALUES ('large_format', 'marketing_collateral', 0, '{"active":true}');
      INSERT INTO users
        (id, clerk_user_id, email, name, role, verification_status,
         shop_lat, shop_lng, shop_label, created_at, position, data)
      VALUES ('supplier', 'clerk_supplier_alias', 'supplier-alias@test.invalid', 'Supplier',
        'supplier', 'approved', 7.1, 125.6, 'Shop', '${at}', 0, '{}');
      INSERT INTO supplier_services
        (id, supplier_id, category_code, state, reference_rate_minor,
         turnaround_hours, created_at, updated_at, position, data)
      VALUES ('legacy_service', 'supplier', 'large_format', 'live', 100, 24, '${at}', '${at}', 0, '{}')
    `);

    await runner(migrationOptions(schema, "up", 1, client));
    assert.equal((await client.query(
      "SELECT category_code FROM supplier_services WHERE id = 'legacy_service'",
    )).rows[0].category_code, "large_format");
    assert.equal((await client.query(`
      SELECT convalidated FROM pg_constraint
       WHERE conname = 'supplier_services_category_fk'
         AND conrelid = 'supplier_services'::regclass
    `)).rows[0].convalidated, false);

    await assert.rejects(
      client.query(`
        INSERT INTO supplier_services
          (id, supplier_id, category_code, state, reference_rate_minor,
           turnaround_hours, pricing_basis, standard_turnaround_hours,
           created_at, updated_at, position, data)
        VALUES ('new_alias_service', 'supplier', 'large_format', 'draft', 0, 24,
          'per_unit', 24, $1, $1, 1, '{}')
      `, [at]),
      (error) => error.code === "23503" && error.constraint === "supplier_services_category_fk",
    );
  });
});
