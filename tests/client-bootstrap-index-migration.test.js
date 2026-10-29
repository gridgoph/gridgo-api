import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';

const DATABASE_URL = process.env.DATABASE_URL;
const migration = '1793275200000_client_bootstrap_reads';
let sequence = 0;
const expectedIndexes = ['users_bootstrap_email_idx', 'users_bootstrap_unusual_email_idx',
  'tester_invites_unmatched_idx', 'promotion_invites_pending_idx', 'promotion_invites_client_idx'];

async function setup(t) {
  const schema = `bootstrap_indexes_${process.pid}_${sequence++}`;
  const clients = await Promise.all(['holder', 'migration', 'writer'].map(async role => {
    const client = new pg.Client({ connectionString: DATABASE_URL, application_name: `a307_index_${role}`, statement_timeout: 15000 });
    await client.connect(); return client;
  }));
  const [holder, migrator, writer] = clients;
  let pending;
  t.after(async () => {
    try {
      await holder.query('ROLLBACK');
      if (pending) await pending;
      await writer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally { await Promise.all(clients.map(client => client.end())); }
  });
  await writer.query(`CREATE SCHEMA "${schema}"`);
  for (const client of clients) await client.query(`SET search_path TO "${schema}"`);
  await writer.query(`
    CREATE TABLE users (id text PRIMARY KEY, email text NOT NULL, name text NOT NULL);
    INSERT INTO users VALUES ('client','client@example.invalid','Client'), ('other','other@example.invalid','Other');
    CREATE TABLE tester_invites (id text PRIMARY KEY, client_id text);
    CREATE TABLE promotion_invites (id text PRIMARY KEY, client_id text, status text NOT NULL);
    CREATE TABLE voucher_reservations (id text PRIMARY KEY, voucher_id text NOT NULL, status text NOT NULL);
    CREATE UNIQUE INDEX voucher_one_reservation ON voucher_reservations(voucher_id) WHERE status = 'reserved';
  `);
  const pid = (await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  function migrate() {
    pending = runner({ dbClient: migrator, dir: path.resolve('migrations'), file: migration,
      direction: 'up', schema, migrationsSchema: schema, migrationsTable: 'pgmigrations',
      singleTransaction: true, checkOrder: false, noLock: true,
      logger: { info() {}, warn() {}, error() {} },
    }).then(result => ({ result }), error => ({ error }));
    return pending;
  }
  async function waitingBuild() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const locks = (await writer.query(`SELECT l.mode, l.granted, a.wait_event_type, a.wait_event
        FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.pid = $1 AND l.relation = $2::regclass AND a.query LIKE '%CREATE INDEX%' AND a.wait_event_type = 'Lock'`,
      [pid, `"${schema}".users`])).rows;
      if (locks.length) return locks;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('migration did not reach the held-writer index build');
  }
  async function validIndexes() {
    return (await writer.query(`SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname`, [schema, expectedIndexes])).rows;
  }
  return { schema, holder, migrator, writer, pid, migrate, waitingBuild, validIndexes };
}

test('bootstrap index migration lets a later writer finish while an older writer stays open', { skip: !DATABASE_URL }, async t => {
  const probe = await setup(t), { holder, writer } = probe;
  await holder.query('BEGIN');
  await holder.query("UPDATE users SET name=name WHERE id='client'");
  const migrationResult = probe.migrate();
  const locks = await probe.waitingBuild();
  t.diagnostic(`index build with holder open: ${JSON.stringify(locks)}`);
  await writer.query("SET statement_timeout = '1500ms'");
  const started = performance.now();
  const changed = await writer.query("UPDATE users SET name='Updated' WHERE id='other'");
  assert.equal(changed.rowCount, 1);
  t.diagnostic(`later writer completed ${changed.rowCount} row in ${Math.round(performance.now() - started)}ms before holder rollback`);
  await holder.query('ROLLBACK');
  assert.ifError((await migrationResult).error);
  assert.deepEqual((await probe.validIndexes()).map(row => [row.relname, row.indisvalid]), expectedIndexes.toSorted().map(name => [name, true]));
  assert.equal((await writer.query("SELECT to_regclass('voucher_reservations_active_voucher_idx') AS duplicate")).rows[0].duplicate, null);
});

test('interrupted bootstrap index builds recover without rebuilding completed indexes', { skip: !DATABASE_URL }, async t => {
  const probe = await setup(t), { holder, writer, pid } = probe;
  await writer.query('CREATE INDEX CONCURRENTLY users_bootstrap_email_idx ON users (lower(btrim(email)))');
  const firstOid = (await writer.query("SELECT 'users_bootstrap_email_idx'::regclass::oid AS oid")).rows[0].oid;
  await holder.query('BEGIN');
  await holder.query("UPDATE users SET name=name WHERE id='client'");
  const interrupted = probe.migrate();
  await probe.waitingBuild();
  await writer.query('SELECT pg_cancel_backend($1)', [pid]);
  assert.equal((await interrupted).error?.code, '57014');
  await holder.query('ROLLBACK');
  assert.deepEqual(await probe.validIndexes(), [
    { relname: 'users_bootstrap_email_idx', indisvalid: true },
    { relname: 'users_bootstrap_unusual_email_idx', indisvalid: false },
  ]);
  assert.equal((await writer.query('SELECT count(*)::int AS count FROM pgmigrations')).rows[0].count, 0);
  // The deployment recovery step rebuilds only this migration's invalid indexes,
  // one top-level command at a time. IF NOT EXISTS alone cannot repair them.
  const recovery = (await writer.query(`SELECT format('REINDEX INDEX CONCURRENTLY %I.%I', n.nspname, c.relname) AS command
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND NOT i.indisvalid`, [probe.schema, expectedIndexes])).rows;
  assert.equal(recovery.length, 1);
  for (const { command } of recovery) await writer.query(command);
  assert.ifError((await probe.migrate()).error);
  assert.deepEqual((await probe.validIndexes()).map(row => [row.relname, row.indisvalid]), expectedIndexes.toSorted().map(name => [name, true]));
  assert.equal((await writer.query("SELECT 'users_bootstrap_email_idx'::regclass::oid AS oid")).rows[0].oid, firstOid);
  assert.deepEqual((await writer.query('SELECT name FROM pgmigrations')).rows, [{ name: migration }]);
  await writer.query('SET enable_seqscan = off');
  const plan = (await writer.query("EXPLAIN SELECT id FROM voucher_reservations WHERE voucher_id='voucher' AND status='reserved'")).rows;
  assert.match(JSON.stringify(plan), /voucher_one_reservation/);
});
