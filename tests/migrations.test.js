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

test("fresh PostgreSQL migrates through onboarding and reverses only the forward addition", { skip: !DATABASE_URL }, async (t) => {
  await withMigrationSchema(t, async ({ schema, client }) => {
    await runner(migrationOptions(schema, "up", undefined, client));

    const tables = new Set((await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
      [schema],
    )).rows.map((row) => row.table_name));
    for (const table of [
      "user_role_memberships", "client_profiles", "supplier_profiles", "rider_profiles",
      "approval_cases", "approval_case_events", "rider_documents",
    ]) assert.equal(tables.has(table), true, `${table} should exist after up`);

    const legacyColumns = new Set((await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users'",
      [schema],
    )).rows.map((row) => row.column_name));
    for (const column of ["role", "account_type", "org_name", "verification_status", "shop_lat", "shop_lng", "shop_label"]) {
      assert.equal(legacyColumns.has(column), true, `${column} compatibility projection should remain`);
    }

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

    await runner(migrationOptions(schema, "up", 1, client));
    assert.equal((await client.query("SELECT to_regclass('rider_documents') AS table_name")).rows[0].table_name, "rider_documents");
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
