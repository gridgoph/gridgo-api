import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { up as choiceUp } from '../migrations/1792501000000_production_time_choice.js';

async function migrate(db, up) {
  const statements = [];
  await up({ sql: statement => statements.push(statement) });
  for (const statement of statements) await db.query(statement);
}

async function fixture(run) {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query(`BEGIN; CREATE SCHEMA production_review_test; SET LOCAL search_path = production_review_test, public;
      CREATE TABLE supplier_profiles (user_id text, schedule jsonb);
      CREATE TABLE supplier_services (id text, standard_turnaround_days int, turnaround_days int,
        standard_turnaround_hours int, standard_turnaround_minutes int, turnaround_minutes int, turnaround_hours int);
      CREATE TABLE supplier_catalog_items (id text, supplier_id text, supplier_service_id text, turnaround_mode text,
        turnaround_days int, turnaround_minutes int, turnaround_hours int, minimum_turnaround_days int,
        minimum_turnaround_minutes int, minimum_turnaround_hours int, express boolean, created_at timestamptz, version int);
      CREATE TABLE audit_log (action text, data jsonb, entity_type text, entity_id text, at timestamptz);
      CREATE TABLE pgmigrations (name text, run_on timestamptz);
      INSERT INTO pgmigrations VALUES ('1791936000000_production_days','2026-10-07T01:00Z');
      INSERT INTO supplier_profiles VALUES ('shop','{"utcOffsetMinutes":480,"week":[{"weekday":1,"opensMinute":480,"closesMinute":960}]}');`);
    const add = async (id, { mode = 'override', days = null, express = false, prefix = 'turnaround', kind = 'catalogItems',
      standard = true, duration = {} } = {}) => {
      await db.query('INSERT INTO supplier_services VALUES ($1,$2,3,$3,$4,1440,24)',
        [id, standard ? 3 : null, standard ? 24 : null, standard ? 1440 : null]);
      await db.query(`INSERT INTO supplier_catalog_items VALUES ($1,'shop',$1,$2,$3,$4,$5,NULL,NULL,NULL,$6,'2026-10-01',1)`,
        [id, mode, days, mode === 'inherit' ? null : days ? 480 : 120, mode === 'inherit' ? null : days ? 8 : 2, express]);
      await db.query(`INSERT INTO audit_log VALUES ('production_time.correct_39853344',$1,$2,$3,'2026-10-14')`,
        [JSON.stringify({ detail: { duration: { prefix, oldMinutes: 600, correctedMinutes: 120, ...duration } } }), kind, id]);
    };
    await run(db, add);
  } finally { await db.query('ROLLBACK'); await db.end(); }
}

const enabled = { skip: !process.env.DATABASE_URL };
test('initial migration ignores unused service prefixes, including Express conversions', enabled, async () => fixture(async (db, add) => {
  for (const [id, prefix, standard, express] of [
    ['rush', 'rushTurnaround', true, false], ['fallback', 'turnaround', true, false],
    ['unused_standard', 'standardTurnaround', false, false], ['express_rush', 'rushTurnaround', true, true],
  ]) await add(id, { mode: 'inherit', kind: 'supplierServices', prefix, standard, express });
  // Deliberately use today's day length in the irrelevant audit to expose the old predicate.
  await db.query(`UPDATE audit_log SET data = jsonb_set(data, '{detail,duration,oldMinutes}', '480')`);
  await migrate(db, choiceUp);
  const rows = (await db.query('SELECT id, production_time_review_reasons FROM supplier_catalog_items ORDER BY id')).rows;
  assert.ok(rows.every(row => row.production_time_review_reasons.length === 0), JSON.stringify(rows));
}));

test('initial migration uses historical provenance or conservatively flags missing provenance after hours change', enabled, async () => fixture(async (db, add) => {
  await add('unknown_old_day');
  await add('unknown_old_multiple', { duration: { oldMinutes: 1800 } });
  await add('known_one', { duration: { oldDays: 1, productionDayMinutes: 600 } });
  await add('known_multiple', { duration: { oldDays: 3, productionDayMinutes: 600, oldMinutes: 1800 } });
  await add('divisor_one', { duration: { productionDayMinutes: 600 } });
  await add('divisor_multiple', { duration: { productionDayMinutes: 600, oldMinutes: 1200 } });
  await add('used_standard', { mode: 'inherit', kind: 'supplierServices', prefix: 'standardTurnaround' });
  await add('used_fallback', { mode: 'inherit', kind: 'supplierServices', standard: false });
  await migrate(db, choiceUp);
  const flagged = (await db.query(`SELECT id FROM supplier_catalog_items WHERE cardinality(production_time_review_reasons)>0 ORDER BY id`)).rows.map(row => row.id);
  assert.deepEqual(flagged, ['divisor_one', 'known_one', 'unknown_old_day', 'unknown_old_multiple', 'used_fallback', 'used_standard']);
}));

test('forward repair fixes already-applied flags without replaying conversions or undoing confirmations', enabled, async () => fixture(async (db, add) => {
  await add('wrong_rush', { mode: 'inherit', kind: 'supplierServices', prefix: 'rushTurnaround' });
  await add('missed_after_hours_change');
  await add('confirmed_after_release');
  await add('old_one_day', { days: 1 });
  await add('ambiguous_converted_express', { mode: 'inherit', express: true, kind: 'supplierServices', prefix: 'rushTurnaround' });
  await migrate(db, choiceUp);
  // Simulate the already-deployed original migration's output, not its fixed SQL.
  await db.query(`UPDATE supplier_catalog_items SET production_time_review_reasons = CASE
      WHEN id IN ('wrong_rush','old_one_day','ambiguous_converted_express') THEN ARRAY['legacy_one_working_day']
      ELSE '{}'::text[] END;
    INSERT INTO pgmigrations VALUES ('1792501000000_production_time_choice','2026-10-20T01:00Z');
    INSERT INTO audit_log VALUES ('catalog_item.update', '{"detail":{"current":{"productionTimeReviewReasons":[]}}}',
      'supplier_catalog_item','confirmed_after_release','2026-10-20T02:00Z');`);
  const before = (await db.query('SELECT * FROM supplier_catalog_items ORDER BY id')).rows;
  const { up } = await import('../migrations/1792501100000_production_time_review_evidence.js');
  await migrate(db, up);
  const rows = (await db.query('SELECT * FROM supplier_catalog_items ORDER BY id')).rows;
  assert.deepEqual(rows.filter(row => row.production_time_review_reasons.length).map(row => row.id),
    ['ambiguous_converted_express', 'missed_after_hours_change', 'old_one_day']);
  for (const [index, row] of rows.entries()) {
    const { production_time_review_reasons, version, ...rest } = row;
    const { production_time_review_reasons: oldReasons, version: oldVersion, ...oldRest } = before[index];
    assert.deepEqual(rest, oldRest, `${row.id} duration/Express facts unchanged`);
    assert.equal(version, oldVersion + (JSON.stringify(oldReasons) !== JSON.stringify(production_time_review_reasons) ? 1 : 0));
  }
  await migrate(db, up);
  assert.deepEqual((await db.query('SELECT * FROM supplier_catalog_items ORDER BY id')).rows, rows, 'repair is data-idempotent');
}));
