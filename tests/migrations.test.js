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

test("fresh PostgreSQL migrates through onboarding, enrollment, and money additions and reverses them in order", { skip: !DATABASE_URL }, async (t) => {
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
    ]) assert.equal(tables.has(table), true, `${table} should exist after up`);

    const legacyColumns = new Set((await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users'",
      [schema],
    )).rows.map((row) => row.column_name));
    for (const column of ["role", "account_type", "org_name", "verification_status", "shop_lat", "shop_lng", "shop_label"]) {
      assert.equal(legacyColumns.has(column), true, `${column} compatibility projection should remain`);
    }

    await runner(migrationOptions(schema, "down", 1, client));
    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal(
      (await client.query("SELECT to_regclass('user_role_memberships') AS table_name")).rows[0].table_name,
      "user_role_memberships",
    );

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
    await runner(migrationOptions(schema, "up", 2, client));
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

    await runner(migrationOptions(schema, "up", 2, client));

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
