import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';

const DATABASE_URL = process.env.DATABASE_URL;
const expectedIndexes = ['file_references_reference_id_idx', 'notifications_order_type_idx'];

test('production sweep indexes build without blocking a later writer and serve the probe queries', { skip: !DATABASE_URL }, async t => {
  const schema = `sweep_indexes_${process.pid}`;
  const clients = await Promise.all(['holder', 'migration', 'writer'].map(async role => {
    const client = new pg.Client({ connectionString: DATABASE_URL, application_name: `gg307_sweep_index_${role}`, statement_timeout: 15000 });
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
  await writer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await writer.query(`CREATE SCHEMA "${schema}"`);
  for (const client of clients) await client.query(`SET search_path TO "${schema}"`);
  await writer.query(`
    CREATE TABLE notifications (id text PRIMARY KEY, user_id text NOT NULL, type text NOT NULL, order_id text, data jsonb NOT NULL DEFAULT '{}');
    INSERT INTO notifications SELECT 'n' || i, 'supplier', CASE WHEN i % 50 = 0 THEN 'shop_production_inactive' ELSE 'general' END,
      'order_' || (i % 400), '{}' FROM generate_series(1, 20000) i;
    CREATE TABLE file_references (file_id text, reference_type text, reference_id text, field text, PRIMARY KEY (file_id, reference_type, reference_id, field));
    INSERT INTO file_references SELECT 'file_' || i, 'order', 'order_' || i, 'proof' FROM generate_series(1, 20000) i;
    ANALYZE notifications; ANALYZE file_references;
  `);
  const pid = (await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await holder.query('BEGIN');
  await holder.query("UPDATE notifications SET data = data WHERE id = 'n1'");
  pending = runner({ dbClient: migrator, dir: path.resolve('migrations'), file: '1793600000000_production_sweep_reads',
    direction: 'up', schema, migrationsSchema: schema, migrationsTable: 'pgmigrations',
    singleTransaction: true, checkOrder: false, noLock: true, logger: { info() {}, warn() {}, error() {} },
  }).then(result => ({ result }), error => ({ error }));
  const deadline = Date.now() + 5000;
  let waiting = false;
  while (!waiting && Date.now() < deadline) {
    waiting = (await writer.query(`SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND query LIKE '%CREATE INDEX%' AND wait_event_type = 'Lock'`, [pid])).rowCount > 0;
    if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(waiting, 'migration reached the held-writer index build');
  await writer.query("SET statement_timeout = '1500ms'");
  assert.equal((await writer.query("UPDATE notifications SET data = '{\"later\":true}' WHERE id = 'n2'")).rowCount, 1);
  await holder.query('ROLLBACK');
  assert.ifError((await pending).error);
  const indexes = (await writer.query(`SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) ORDER BY c.relname`, [schema, expectedIndexes])).rows;
  assert.deepEqual(indexes.map(row => [row.relname, row.indisvalid]), expectedIndexes.map(name => [name, true]));
  const plan = async (sql, values) => JSON.stringify((await writer.query(`EXPLAIN ${sql}`, values)).rows);
  assert.match(await plan("SELECT id FROM notifications WHERE order_id = ANY($1::text[]) AND type = 'shop_production_inactive'", [['order_50', 'order_100']]), /notifications_order_type_idx/);
  assert.match(await plan('SELECT file_id FROM file_references WHERE reference_id = ANY($1::text[])', [['order_5', 'order_6']]), /file_references_reference_id_idx/);
});
