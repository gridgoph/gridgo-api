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
      "client_match_preferences", "client_saved_addresses", "client_carts", "client_cart_lines",
      "order_jobs", "order_invoices", "support_admins", "support_tickets",
      "support_chat_threads", "support_chat_messages", "support_chat_reads",
      "supplier_payout_accounts",
    ]) assert.equal(tables.has(table), true, `${table} should exist after up`);

    const legacyColumns = new Set((await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users'",
      [schema],
    )).rows.map((row) => row.column_name));
    for (const column of ["role", "account_type", "org_name", "verification_status", "shop_lat", "shop_lng", "shop_label", "version"]) {
      assert.equal(legacyColumns.has(column), true, `${column} compatibility projection should remain`);
    }

    assert.deepEqual(
      (await client.query("SELECT name FROM pgmigrations ORDER BY id")).rows.map((row) => row.name),
      [
        "1786816800000_initial_schema",
        "1786843800000_role_memberships_and_approvals",
        "1786870800000_service_fee_money_model",
        "1786874400000_enrollment_legacy_supplier_shop",
        "1786878000000_supplier_catalog_listings",
        "1786881600000_catalog_prep_steps_and_link_formats",
        "1786885200000_rider_profile_version",
        "1786888800000_catalog_item_search",
        "1786892400000_accepted_file_formats_webp",
        "1786896000000_client_order_match",
        "1786899600000_order_match_payment_plan",
        "1786903200000_client_account_profile_version",
  "1786906800000_match_deadline_schedule_reviews",
  "1786910400000_order_lifecycle_one_shop",
  "1786914000000_pickup_is_not_part_of_the_commitment",
  "1786917600000_catalogue_pricing_shapes",
    "1786921200000_a_client_can_state_a_measurement",
    "1786924800000_package_qty_belongs_to_one_unit",
    "1786928400000_starters_speak_every_pricing_unit",
    "1786932000000_a_starter_can_offer_a_multiplier",
    "1786935600000_starter_ordering_can_be_reshuffled",
    "1786939200000_retire_the_supplier_proof_loop",
    "1786942800000_an_order_line_remembers_any_unit",
    "1786946400000_line_math_understands_measured_units",
    "1786950000000_a_collected_order_waits_on_our_shelf",
    "1786953600000_a_shop_is_paid_across_four_stages",
    "1786955400000_public_support_tickets",
    "1786957200000_tarpaulin_printer_max_width",
    "1786959000000_notification_push_outbox",
    "1786960800000_a_shop_says_where_it_wants_to_be_paid",
        "1786964400000_authenticated_support_chat",
        "1786968000000_support_chat_history",
        "1786975200000_listing_production_window",
        "1786978800000_rider_delivery_commission",
      ],
    );

    await client.query(`
      INSERT INTO support_tickets (name, email, subject, message)
      VALUES ('Ana', 'ana@example.com', 'Late delivery', 'Still waiting.')
    `);
    await assert.rejects(
      client.query(`
        INSERT INTO support_tickets (name, email, subject, message, status)
        VALUES ('Ana', 'ana@example.com', 'Hi', 'x', 'pending')
      `),
      (error) => error.code === "23514",
    );
    await client.query(`
      INSERT INTO users
        (id, clerk_user_id, email, name, role, account_type,
         shop_lat, shop_lng, shop_label, created_at, position, data)
      VALUES
        ('multi_role_shop', 'clerk_multi_role_shop', 'multi-role-shop@test.invalid',
         'Multi Role Shop', 'client', 'individual', 7.0731, 125.6128,
         'Bajada, Davao City', now(), 0, '{}')
    `);
    await assert.rejects(
      client.query(`
        INSERT INTO users
          (id, clerk_user_id, email, name, role, account_type, org_name,
           created_at, position, data)
        VALUES
          ('blank_org', 'clerk_blank_org', 'blank-org@test.invalid', 'Blank Org',
           'client', 'business', '   ', now(), 1, '{}')
      `),
      (error) => error.code === "23514" && error.constraint === "users_org_name_check",
    );

    const searchColumns = new Set((await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'supplier_catalog_items'",
      [schema],
    )).rows.map((row) => row.column_name));
    assert.equal(searchColumns.has("search_text"), true);
    assert.equal(searchColumns.has("search_tsv"), true);
    assert.equal((await client.query("SELECT code FROM accepted_file_formats WHERE code = 'webp'")).rows.length, 1);

    const supplierProfileColumns = new Set((await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'supplier_profiles'",
      [schema],
    )).rows.map((row) => row.column_name));
    assert.equal(supplierProfileColumns.has("is_closed"), true);
    const orderLineColumns = new Set((await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'order_line_items'",
      [schema],
    )).rows.map((row) => row.column_name));
    for (const column of ["job_id", "artwork_file_id", "mockup_file_id", "dropoff_lat", "dropoff_lng", "dropoff_label"]) {
      assert.equal(orderLineColumns.has(column), true, `${column} should exist on order_line_items`);
    }

    await assert.rejects(
      client.query(`
        INSERT INTO client_match_preferences (client_id, ranking, version, updated_at)
        VALUES ('multi_role_shop', ARRAY['quality','quality','distance'], 1, now())
      `),
      (error) => error.code === "23514" && error.constraint === "client_match_preferences_ranking_check",
    );
  // Cost is the fourth factor now, so the old three-factor ranking is no
  // longer a valid one to save.
  await assert.rejects(
    client.query(`
      INSERT INTO client_match_preferences (client_id, ranking, version, updated_at)
      VALUES ('multi_role_shop', ARRAY['quality','speed','distance'], 1, now())
    `),
    (error) => error.code === "23514" && error.constraint === "client_match_preferences_ranking_check",
  );
  assert.equal(supplierProfileColumns.has("schedule"), true);
  assert.notEqual((await client.query("SELECT to_regclass('shop_reviews') AS t")).rows[0].t, null);
  const orderDateColumns = new Set((await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'orders'",
    [schema],
  )).rows.map((row) => row.column_name));
  for (const column of ["ready_by", "ready_at"]) {
    assert.equal(orderDateColumns.has(column), true, `${column} should exist on orders`);
  }

  // A client can state how big the thing is. Without these a listing priced by
  // the square foot reaches the pricer with no area and refuses the basket.
  const cartLineColumns = new Set((await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'client_cart_lines'",
    [schema],
  )).rows.map((row) => row.column_name));
  for (const column of ["measure_pages", "measure_width_milli", "measure_height_milli", "measure_length_milli"]) {
    assert.equal(cartLineColumns.has(column), true, `${column} should exist on client_cart_lines`);
  }
  // The supplier print-proof loop and the per-job QA checklist belong to the
  // retired order model. Nothing reads or writes either, and carrying them
  // cost every mutation two collections nothing consumed.
  for (const table of ["proofs", "job_qa_checklist"]) {
    assert.equal(
      (await client.query("SELECT to_regclass($1) AS t", [`${schema}.${table}`])).rows[0].t,
      null,
      `${table} should be gone`,
    );
  }

  // A listing priced by the square foot has no package quantity and is not
  // per_unit, which the original two-unit rule refused outright.
  const packageChecks = (await client.query(
    `SELECT c.conname FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND c.conname IN ('supplier_catalog_items_check', 'supplier_catalog_items_package_qty_check')
      ORDER BY c.conname`, [schema],
  )).rows.map((row) => row.conname);
  assert.deepEqual(packageChecks, ["supplier_catalog_items_package_qty_check"]);

  // Width and height are one measurement. A line with a width and no height
  // has no area and would be priced as though it did.
  await assert.rejects(
    client.query(`
      INSERT INTO client_cart_lines
        (id, cart_id, supplier_id, catalog_item_id, option_ids, quantity, structured_spec,
         measure_width_milli, sort_order, created_at, updated_at)
      VALUES ('cline_half', 'cart_x', 'shop_x', 'item_x', ARRAY[]::text[], 1, '{}', 1000, 0, now(), now())
    `),
    (error) => error.code === "23514" || error.code === "23503",
    "a width with no height should be refused",
  );

    await client.query(`
      INSERT INTO orders
        (id, client_id, state, payment_plan, supplier_downpayment_rate_bps,
         money_model_version, payout_hold, created_at, updated_at, position, data)
      VALUES
        ('order_match_plan', 'multi_role_shop', 'needs_qa', 'order_match_qr_75_25', 7500,
         3, false, now(), now(), 0, '{}')
    `);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");

    // The personal-profile rule is never dropped: a pending application lives on
    // its approval case, so nothing needs business fields on a personal row.
    assert.equal((await client.query(
      `SELECT 1 FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = 'client_profiles' AND c.conname = 'client_profiles_check'`,
      [schema],
    )).rowCount, 1);

    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='orders' AND column_name='rider_commission_bps'`, [schema])).rowCount, 0);
    await runner(migrationOptions(schema, "down", 1, client));
    const productionWindowColumns = new Set((await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'supplier_catalog_items'`,
      [schema],
    )).rows.map((row) => row.column_name));
    assert.equal(productionWindowColumns.has("minimum_turnaround_hours"), false);

    await runner(migrationOptions(schema, "down", 1, client));
    assert.ok((await client.query("SELECT to_regclass($1) AS t", [`${schema}.support_chat_threads`])).rows[0].t);
    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query("SELECT to_regclass($1) AS t", [`${schema}.support_chat_threads`])).rows[0].t, null);
    assert.equal((await client.query("SELECT to_regclass($1) AS t", [`${schema}.support_chat_messages`])).rows[0].t, null);
    assert.equal((await client.query("SELECT to_regclass($1) AS t", [`${schema}.support_chat_reads`])).rows[0].t, null);

    // The shop's payout plate goes first, and with it the only file reference
    // type that pointed at it, so the older constraint can be put back.
    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query("SELECT to_regclass($1) AS t", [`${schema}.supplier_payout_accounts`])).rows[0].t, null);
    const referenceTypes = (await client.query(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND c.conname = 'file_references_reference_type_check'`,
      [schema],
    )).rows[0]?.def ?? "";
    assert.equal(referenceTypes.includes("supplier_payout_account"), false);
    assert.equal(referenceTypes.includes("supplier_shop_media"), true);

    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='notification_push_outbox'",[schema])).rowCount,0);
    await runner(migrationOptions(schema, "down", 1, client));
  const printerCapColumns = new Set((await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'supplier_catalog_items'`,
    [schema],
  )).rows.map((row) => row.column_name));
  assert.equal(printerCapColumns.has("printer_max_width_feet"), false);

    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query("SELECT to_regclass($1) AS t", [`${schema}.support_tickets`])).rows[0].t, null);
    assert.equal((await client.query("SELECT to_regclass($1) AS t", [`${schema}.support_admins`])).rows[0].t, null);
    await runner(migrationOptions(schema, "down", 1, client));
  // The four-stage payout has no honest reverse -- two stages cannot say which
  // of four a shop had reached -- so its down leaves the rows alone. What it
  // must not do is leave the database still insisting on the four.
  // Scoped to this run's own schema: the development database carries a
  // function of the same name, and an unfiltered read can answer with either.
  const payoutShape = (await client.query(
    `SELECT prosrc FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = 'validate_order_financial_children'`,
    [schema],
  )).rows[0]?.prosrc ?? "";
  assert.equal(payoutShape.includes("packaging_qc"), true);

    await runner(migrationOptions(schema, "down", 1, client));
  // The counter step goes away, and with it the only place a collected order
  // could wait between the rider leaving and the client arriving.
  const shelfStates = (await client.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND c.conname = 'orders_state_check'`,
    [schema],
  )).rows[0]?.def ?? "";
  assert.equal(shelfStates.includes("awaiting_collection"), false);

    await runner(migrationOptions(schema, "down", 1, client));
  // The line-math check goes back to insisting a subtotal is always a rate
  // times a quantity, which no measured line ever is.
  const lineMath = (await client.query(
    "SELECT prosrc FROM pg_proc WHERE proname = 'check_order_line_item_math'",
  )).rows[0]?.prosrc ?? "";
  assert.equal(lineMath.includes("per_area"), false);

  await runner(migrationOptions(schema, "down", 1, client));
  // An order line goes back to recording only the two original units, which
  // is what made every measured listing unbuyable at the last step.
  const lineUnits = (await client.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND c.conname = 'order_line_items_pricing_unit_snapshot_check'`,
    [schema],
  )).rows[0]?.def ?? "";
  assert.equal(lineUnits.includes("per_area"), false);

  await runner(migrationOptions(schema, "down", 1, client));
  // The retired order model's two tables come back, empty.
  for (const table of ["proofs", "job_qa_checklist"]) {
    assert.notEqual(
      (await client.query("SELECT to_regclass($1) AS t", [`${schema}.${table}`])).rows[0].t,
      null,
      `${table} should be restored`,
    );
  }

  await runner(migrationOptions(schema, "down", 1, client));
  // Template orderings stop being deferrable, so a reshuffle collides again.
  const deferrable = (await client.query(
    `SELECT c.condeferrable FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND c.conname = 'listing_starter_groups_starter_id_sort_order_key'`,
    [schema],
  )).rows[0]?.condeferrable;
  assert.equal(deferrable, false);

  await runner(migrationOptions(schema, "down", 1, client));
  // A starter can no longer carry a multiplying add-on.
  const starterCols = new Set((await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'listing_starter_options'",
    [schema],
  )).rows.map((row) => row.column_name));
  assert.equal(starterCols.has("price_multiplier_bps"), false);

  await runner(migrationOptions(schema, "down", 1, client));
  // Starters go back to offering only the two original units.
  const starterUnits = (await client.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND c.conname = 'listing_starters_default_pricing_unit_check'`,
    [schema],
  )).rows[0]?.def ?? "";
  assert.equal(starterUnits.includes("per_page"), false);

  await runner(migrationOptions(schema, "down", 1, client));
  // The package-quantity rule was written when there were two pricing units
  // and still spelled both out, so it refused every unit added since.
  const packageRule = (await client.query(
    `SELECT c.conname FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND c.conname IN ('supplier_catalog_items_check', 'supplier_catalog_items_package_qty_check')
      ORDER BY c.conname`, [schema],
  )).rows.map((row) => row.conname);
  assert.deepEqual(packageRule, ["supplier_catalog_items_check"], "the two-unit package rule should come back");

  await runner(migrationOptions(schema, "down", 1, client));
  const afterMeasurementDown = new Set((await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'client_cart_lines'",
    [schema],
  )).rows.map((row) => row.column_name));
  assert.equal(afterMeasurementDown.has("measure_width_milli"), false);
  assert.equal(afterMeasurementDown.has("measure_pages"), false);

  await runner(migrationOptions(schema, "down", 1, client));
  assert.equal((await client.query("SELECT to_regclass('supplier_catalog_price_tiers') AS t")).rows[0].t, null);
  assert.equal((await client.query("SELECT to_regclass('supplier_catalog_speed_tiers') AS t")).rows[0].t, null);

  await runner(migrationOptions(schema, "down", 1, client));

  await runner(migrationOptions(schema, "down", 1, client));
  await assert.rejects(
    client.query("UPDATE orders SET state = 'cancelled' WHERE id = 'order_match_plan'"),
    (error) => error.code === "23514",
    "cancelled should stop being an order state once this migration is reversed",
  );

  await runner(migrationOptions(schema, "down", 1, client));
  assert.equal((await client.query("SELECT to_regclass('shop_reviews') AS t")).rows[0].t, null);
  assert.equal((await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'supplier_profiles' AND column_name = 'schedule'",
    [schema],
  )).rows.length, 0);

  await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'version'",
      [schema],
    )).rows.length, 0);

    await runner(migrationOptions(schema, "down", 1, client));
    await assert.rejects(
      client.query(`
        INSERT INTO orders
          (id, client_id, state, payment_plan, supplier_downpayment_rate_bps,
           money_model_version, payout_hold, created_at, updated_at, position, data)
        VALUES
          ('order_match_plan_after_down', 'multi_role_shop', 'needs_qa', 'order_match_qr_75_25', 7500,
           3, false, now(), now(), 1, '{}')
      `),
      (error) => error.code === "23514",
    );

    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query("SELECT to_regclass('client_carts') AS table_name")).rows[0].table_name, null);
    assert.equal((await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'supplier_profiles' AND column_name = 'is_closed'",
      [schema],
    )).rows.length, 0);

    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query("SELECT code FROM accepted_file_formats WHERE code = 'webp'")).rows.length, 0);

    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'supplier_catalog_items' AND column_name = 'search_text'",
      [schema],
    )).rows.length, 0);

    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'rider_profiles' AND column_name = 'version'",
      [schema],
    )).rows.length, 0);
    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query("SELECT to_regclass('supplier_catalog_prep_steps') AS table_name")).rows[0].table_name, null);
    await runner(migrationOptions(schema, "down", 1, client));
    assert.equal((await client.query("SELECT to_regclass('supplier_catalog_items') AS table_name")).rows[0].table_name, null);
    await runner(migrationOptions(schema, "down", 1, client));
    await assert.rejects(
      client.query("UPDATE users SET shop_label = 'Updated shop' WHERE id = 'multi_role_shop'"),
      (error) => error.code === "23514" && error.constraint === "users_legacy_supplier_shop_shape_check",
    );
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

test("rider split migration preserves old delivery fees and SQL computes exact new shares", { skip: !DATABASE_URL }, async (t) => {
  await withMigrationSchema(t, async ({ schema, client }) => {
    await runner(migrationOptions(schema, "up", undefined, client));
    await runner(migrationOptions(schema, "down", 1, client));
    await client.query(`
      INSERT INTO platform_settings (singleton, version, settings) VALUES (true, 7, '{"serviceFeeRateBps":750}');
      INSERT INTO users (id, clerk_user_id, email, name, role, account_type, created_at, position)
        VALUES ('client', 'clerk_client', 'client@test.invalid', 'Client', 'client', 'individual', now(), 0);
      INSERT INTO users (id, clerk_user_id, email, name, role, verification_status, created_at, position)
        VALUES ('shop', 'clerk_shop', 'shop@test.invalid', 'Shop', 'supplier', 'approved', now(), 1);
      INSERT INTO orders (id, client_id, state, delivery_fee_minor, created_at, updated_at, position)
        VALUES ('old_order', 'client', 'draft', 2500, now(), now(), 0);
      INSERT INTO order_jobs (id, order_id, supplier_id, state, fulfillment_mode,
        pickup_lat, pickup_lng, pickup_label, dropoff_lat, dropoff_lng, dropoff_label,
        supplier_subtotal_minor, delivery_fee_minor, estimated_hours, created_at, updated_at)
        VALUES ('old_job', 'old_order', 'shop', 'needs_qa', 'delivery',
          7, 125, 'Shop', 7, 125, 'Home', 10000, 2500, 24, now(), now());
    `);
    await runner(migrationOptions(schema, "up", 1, client));
    assert.deepEqual((await client.query("SELECT version, settings FROM platform_settings")).rows[0], {
      version: 7, settings: { serviceFeeRateBps: 750, riderCommissionBps: 8500 },
    });
    for (const table of ["orders", "order_jobs"]) {
      const row = (await client.query(`SELECT rider_commission_bps, rider_payout_minor::text,
        platform_delivery_share_minor::text FROM ${table}`)).rows[0];
      assert.deepEqual(row, { rider_commission_bps: 10000, rider_payout_minor: "2500", platform_delivery_share_minor: "0" });
    }
    await assert.rejects(client.query("UPDATE order_jobs SET rider_commission_bps = 8500"),
      (error) => error.constraint === "order_jobs_delivery_snapshot_immutable");
    await assert.rejects(client.query("UPDATE order_jobs SET delivery_fee_minor = 3000"),
      (error) => error.constraint === "order_jobs_delivery_snapshot_immutable");
    for (const [fee, rate, rider, platform] of [
      [10, 8500, '9', '1'], [3, 8500, '3', '0'], [0, 8500, '0', '0'],
      [99, 0, '0', '99'], [99, 10000, '99', '0'],
      [9007199254740991, 8500, '7656119366529842', '1351079888211149'],
    ]) {
      await client.query("UPDATE orders SET delivery_fee_minor=$1, rider_commission_bps=$2", [fee, rate]);
      assert.deepEqual((await client.query(`SELECT rider_payout_minor::text, platform_delivery_share_minor::text,
        (rider_payout_minor + platform_delivery_share_minor = delivery_fee_minor) AS conserved FROM orders`)).rows[0],
        { rider_payout_minor: rider, platform_delivery_share_minor: platform, conserved: true });
    }
    await assert.rejects(client.query("UPDATE orders SET rider_commission_bps = 10001"), (error) => error.code === "23514");
    await assert.rejects(client.query("UPDATE orders SET rider_commission_bps = NULL"), (error) => error.code === "23502");
    await assert.rejects(client.query("UPDATE orders SET rider_payout_minor = 123"), (error) => error.code === "428C9");
  });
});
