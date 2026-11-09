import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';

const DATABASE_URL = process.env.DATABASE_URL;
const migration = '1794217010000_mixed_list_pages';
let sequence = 0;
const expectedIndexes = [
  'orders_mixed_page_idx',
  'orders_client_id_mixed_page_idx',
  'orders_supplier_id_mixed_page_idx',
  'orders_rider_id_mixed_page_idx',
  'orders_review_data_mixed_page_idx',
  'baskets_mixed_page_idx',
  'baskets_client_id_mixed_page_idx',
  'issues_mixed_page_idx',
  'issues_client_id_mixed_page_idx',
  'issues_order_id_mixed_page_idx',
  'issues_status_mixed_page_idx',
  'credits_mixed_page_idx',
  'credits_user_id_mixed_page_idx',
];

async function setup(t) {
  const schema = `finish_indexes_${process.pid}_${sequence++}`;
  const clients = await Promise.all(
    ['holder', 'migration', 'writer'].map(async (role) => {
      const client = new pg.Client({
        connectionString: DATABASE_URL,
        application_name: `a307_finish_index_${role}`,
        statement_timeout: 15000,
      });
      await client.connect();
      return client;
    })
  );
  const [holder, migrator, writer] = clients;
  let pending;
  t.after(async () => {
    try {
      await holder.query('ROLLBACK');
      if (pending) await pending;
      await writer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });
  await writer.query(`CREATE SCHEMA "${schema}"`);
  for (const client of clients)
    await client.query(`SET search_path TO "${schema}"`);
  await writer.query(`
    CREATE TABLE orders(id text,created_at timestamptz,client_id text,supplier_id text,rider_id text,review_data boolean,data jsonb);
    INSERT INTO orders VALUES('client',now(),'client','supplier','rider',false,'{}'),('other',now(),'other','supplier','rider',false,'{}');
    CREATE TABLE order_baskets(id text,created_at timestamptz,client_id text);
    CREATE TABLE issues(id text,created_at timestamptz,client_id text,order_id text,status text);
    CREATE TABLE credit_ledger(id text,created_at timestamptz,user_id text);
  `);
  const pid = (await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0]
    .pid;
  function migrate() {
    pending = runner({
      dbClient: migrator,
      dir: path.resolve('migrations'),
      file: migration,
      direction: 'up',
      schema,
      migrationsSchema: schema,
      migrationsTable: 'pgmigrations',
      singleTransaction: true,
      checkOrder: false,
      noLock: true,
      logger: { info() {}, warn() {}, error() {} },
    }).then(
      (result) => ({ result }),
      (error) => ({ error })
    );
    return pending;
  }
  async function waitingBuild() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const locks = (
        await writer.query(
          `SELECT l.mode, l.granted, a.wait_event_type, a.wait_event
        FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.pid = $1 AND l.relation = $2::regclass AND a.query LIKE '%CREATE INDEX%' AND a.wait_event_type = 'Lock'`,
          [pid, `"${schema}".orders`]
        )
      ).rows;
      if (locks.length) return locks;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('migration did not reach the held-writer index build');
  }
  async function validIndexes() {
    return (
      await writer.query(
        `SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname`,
        [schema, expectedIndexes]
      )
    ).rows;
  }
  return {
    schema,
    holder,
    migrator,
    writer,
    pid,
    migrate,
    waitingBuild,
    validIndexes,
  };
}

test(
  'mixed-list index migration lets a later writer finish while an older writer stays open',
  { skip: !DATABASE_URL },
  async (t) => {
    const probe = await setup(t),
      { holder, writer } = probe;
    await holder.query('BEGIN');
    await holder.query("UPDATE orders SET data=data WHERE id='client'");
    const migrationResult = probe.migrate();
    const locks = await probe.waitingBuild();
    t.diagnostic(`index build with holder open: ${JSON.stringify(locks)}`);
    await writer.query("SET statement_timeout = '1500ms'");
    const started = performance.now();
    const changed = await writer.query(
      "UPDATE orders SET data='{}' WHERE id='other'"
    );
    assert.equal(changed.rowCount, 1);
    t.diagnostic(
      `later writer completed ${changed.rowCount} row in ${Math.round(performance.now() - started)}ms before holder rollback`
    );
    await holder.query('ROLLBACK');
    assert.ifError((await migrationResult).error);
    assert.deepEqual(
      (await probe.validIndexes()).map((row) => [row.relname, row.indisvalid]),
      expectedIndexes.toSorted().map((name) => [name, true])
    );
  }
);

test(
  'interrupted mixed-list index builds recover without rebuilding completed indexes',
  { skip: !DATABASE_URL },
  async (t) => {
    const probe = await setup(t),
      { holder, writer, pid } = probe;
    await writer.query(
      "CREATE INDEX CONCURRENTLY orders_mixed_page_idx ON orders ((date_trunc('milliseconds',created_at AT TIME ZONE 'UTC')) DESC,id COLLATE \"C\" DESC)"
    );
    const firstOid = (
      await writer.query("SELECT 'orders_mixed_page_idx'::regclass::oid AS oid")
    ).rows[0].oid;
    await holder.query('BEGIN');
    await holder.query("UPDATE orders SET data=data WHERE id='client'");
    const interrupted = probe.migrate();
    await probe.waitingBuild();
    await writer.query('SELECT pg_cancel_backend($1)', [pid]);
    assert.equal((await interrupted).error?.code, '57014');
    await holder.query('ROLLBACK');
    assert.deepEqual(await probe.validIndexes(), [
      { relname: 'orders_client_id_mixed_page_idx', indisvalid: false },
      { relname: 'orders_mixed_page_idx', indisvalid: true },
    ]);
    assert.equal(
      (await writer.query('SELECT count(*)::int AS count FROM pgmigrations'))
        .rows[0].count,
      0
    );
    // The deployment recovery step rebuilds only this migration's invalid indexes,
    // one top-level command at a time. IF NOT EXISTS alone cannot repair them.
    const recovery = (
      await writer.query(
        `SELECT format('REINDEX INDEX CONCURRENTLY %I.%I', n.nspname, c.relname) AS command
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND NOT i.indisvalid`,
        [probe.schema, expectedIndexes]
      )
    ).rows;
    assert.equal(recovery.length, 1);
    for (const { command } of recovery) await writer.query(command);
    assert.ifError((await probe.migrate()).error);
    assert.deepEqual(
      (await probe.validIndexes()).map((row) => [row.relname, row.indisvalid]),
      expectedIndexes.toSorted().map((name) => [name, true])
    );
    assert.equal(
      (
        await writer.query(
          "SELECT 'orders_mixed_page_idx'::regclass::oid AS oid"
        )
      ).rows[0].oid,
      firstOid
    );
    assert.deepEqual(
      (await writer.query('SELECT name FROM pgmigrations')).rows,
      [{ name: migration }]
    );
  }
);

test(
  'basket page indexes preserve native legacy enumeration under selective index plans',
  { skip: !DATABASE_URL },
  async (t) => {
    const probe = await setup(t),
      { writer } = probe;
    await writer.query(`CREATE INDEX legacy_basket_client_idx ON order_baskets(client_id,created_at);
    INSERT INTO order_baskets SELECT 'basket_'||i, '2000-01-01'::timestamptz + ((i*37)%20000)*interval '1 hour',
      CASE WHEN i%20=0 THEN 'client' ELSE 'other' END FROM generate_series(1,20000)i;
    ANALYZE order_baskets; SET enable_seqscan=off; SET enable_bitmapscan=off;`);
    const sql = 'SELECT id FROM order_baskets WHERE client_id=$1';
    const before = (await writer.query(sql, ['client'])).rows;
    assert.ifError((await probe.migrate()).error);
    assert.deepEqual((await writer.query(sql, ['client'])).rows, before);
    const plan = (await writer.query(`EXPLAIN ${sql}`, ['client'])).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    assert.match(plan, /Index Scan using legacy_basket_client_idx/);
    const pagePlan = (
      await writer.query(
        `EXPLAIN SELECT id FROM order_baskets WHERE client_id=$1 AND length(id)>=0
    ORDER BY date_trunc('milliseconds',created_at AT TIME ZONE 'UTC') DESC,id COLLATE "C" DESC LIMIT 20`,
        ['client']
      )
    ).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    assert.match(pagePlan, /Index Scan using baskets_client_id_mixed_page_idx/);
    t.diagnostic(
      '20,000 baskets: native pre/post-index enumeration identical; opt-in page uses its partial index'
    );
  }
);
