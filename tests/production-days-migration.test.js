import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { up } from '../migrations/1791936000000_production_days.js';

// Exercise the actual forward SQL on the old table shape in an isolated schema.
test('forward migration rounds every production source up and preserves colliding tier prices and approved snapshots', { skip: !process.env.DATABASE_URL }, async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('CREATE SCHEMA production_days_migration_test');
    await db.query('SET LOCAL search_path = production_days_migration_test, public');
    await db.query(`
      CREATE TABLE supplier_profiles (user_id text, schedule jsonb);
      CREATE TABLE supplier_services (id text, supplier_id text, turnaround_hours integer, standard_turnaround_hours integer, rush_turnaround_hours integer);
      CREATE TABLE supplier_catalog_items (id text, supplier_id text, turnaround_hours integer, minimum_turnaround_hours integer, approved_snapshot jsonb);
      CREATE TABLE supplier_catalog_speed_tiers (id text, catalog_item_id text, turnaround_hours integer, price_minor integer, UNIQUE (catalog_item_id, turnaround_hours));
      CREATE TABLE order_jobs (id text);
      CREATE TABLE order_line_items (id text, snapshot_finalized boolean, turnaround_hours_snapshot integer);
      INSERT INTO order_line_items VALUES ('historic', true, 3);
      CREATE TABLE listing_starters (id text, default_turnaround_hours integer);
      INSERT INTO supplier_profiles VALUES ('default', null), ('custom', '{"utcOffsetMinutes":480,"week":[{"weekday":1,"opensMinute":480,"closesMinute":990}]}');
      INSERT INTO supplier_services VALUES ('service', 'default', 48, 24, 3), ('custom_service', 'custom', 24, 24, null);
      INSERT INTO supplier_catalog_items VALUES ('item', 'default', 48, 12, '{"item":{"turnaroundHours":48,"minimumTurnaroundHours":12},"catalogSpeedTiers":[{"id":"approved-tier","turnaroundHours":3,"priceMinor":100}]}'), ('custom_item', 'custom', 24, null, null), ('inherited', 'default', null, null, null);
      INSERT INTO supplier_catalog_speed_tiers VALUES ('slow', 'item', 5, 100), ('fast', 'item', 3, 200);
      INSERT INTO listing_starters VALUES ('starter', 4), ('unset', null);
    `);
    let sql;
    await up({ sql: value => { sql = value; } });
    await db.query(sql);
    const service = (await db.query("SELECT * FROM supplier_services WHERE id='service'")).rows[0];
    assert.equal(service.turnaround_days, 5);
    assert.equal(service.standard_turnaround_days, 3);
    assert.equal(service.rush_turnaround_days, 1);
    assert.equal(service.turnaround_hours, 50);
    const item = (await db.query("SELECT * FROM supplier_catalog_items WHERE id='item'")).rows[0];
    assert.equal(item.turnaround_days, 5);
    assert.equal(item.minimum_turnaround_days, 2);
    assert.equal(item.approved_snapshot.item.turnaroundDays, 5);
    assert.equal(item.approved_snapshot.catalogSpeedTiers[0].turnaroundDays, 1);
    assert.equal(item.approved_snapshot.catalogSpeedTiers[0].id, 'approved-tier');
    const tiers = (await db.query('SELECT turnaround_days, turnaround_hours, price_minor FROM supplier_catalog_speed_tiers ORDER BY price_minor')).rows;
    assert.deepEqual(tiers, [{ turnaround_days: 1, turnaround_hours: 10, price_minor: 100 }, { turnaround_days: 1, turnaround_hours: 10, price_minor: 200 }]);
    assert.equal((await db.query("SELECT turnaround_days FROM supplier_catalog_items WHERE id='custom_item'")).rows[0].turnaround_days, 3);
    assert.equal((await db.query("SELECT turnaround_days FROM supplier_catalog_items WHERE id='inherited'")).rows[0].turnaround_days, null);
    assert.equal((await db.query("SELECT default_turnaround_days FROM listing_starters WHERE id='starter'")).rows[0].default_turnaround_days, 1);
    assert.equal((await db.query("SELECT default_turnaround_days FROM listing_starters WHERE id='unset'")).rows[0].default_turnaround_days, null);
    assert.equal((await db.query("SELECT turnaround_hours_snapshot FROM order_line_items WHERE id='historic'")).rows[0].turnaround_hours_snapshot, 3);
    await db.query('SAVEPOINT immutable_snapshot');
    await assert.rejects(db.query("UPDATE order_line_items SET turnaround_days_snapshot=1 WHERE id='historic'"), /immutable/);
    await db.query('ROLLBACK TO SAVEPOINT immutable_snapshot');
    await assert.rejects(db.query(`SELECT production_day_minutes('{"week":[]}'::jsonb)`), /production_day_length_unavailable/);
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
});
