import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadHotReadStore, saveStore, isHotReadPath } from '../src/postgres-store.js';
import { hasRole } from '../src/notifications.js';
import { AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { setupOrders, project, instrument } from './fixtures/order-reads.js';

const skip = !process.env.DATABASE_URL;

test('order read graphs preserve full-store projections, history, actor and review scopes', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  const full = await setupOrders(database);
  const scopes = ['client', 'supplier', 'rider', 'ops', 'admin', 'test_ops', 'review_client', 'review_supplier', 'review_rider', 'dual']
    .flatMap(id => [{ id }, ...(id === 'dual' ? ['client', 'supplier', 'ops_admin'].map(role => ({ id, role })) : [])]);
  for (const { id, role } of scopes) for (const includeReviewData of [false, true]) {
    const options = { role, includeReviewData };
    for (const path of ['/orders', '/jobs', ...full.orders.map(order => `/orders/${order.id}`)]) {
      if (path === '/jobs' && !hasRole(full, id, 'supplier')) continue;
      const scoped = await loadHotReadStore(database, `clerk_${id}`, path, options);
      const actual = await project(database, scoped, id, path, options);
      const expected = await project(database, full, id, path, options);
      assert.deepEqual(actual, expected, `${id}/${role || 'default'} ${path} review=${includeReviewData}`);
      assert.equal(JSON.stringify(actual), JSON.stringify(expected), 'serialized key and array order');
    }
  }
  const scoped = await loadHotReadStore(database, 'clerk_client', '/orders');
  await assert.rejects(database.transaction(() => saveStore(database, scoped)), /read-only/);
  assert.ok(isHotReadPath('/orders/order'));
  assert.equal(isHotReadPath('/orders/order/issues'), false);
  assert.deepEqual((await project(database, full, 'supplier', '/orders')).orders.map(row => row.id),
    ['order', 'z_history', 'a_active', 'm_offer', 'held_offer', 'pickup_offer', 'multi', 'legacy']);
});

test('order graph row counts stay bounded when unrelated history grows', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setupOrders(database);
  const sample = async () => {
    const { db, queries } = instrument(database);
    await loadHotReadStore(db, 'clerk_client', '/orders');
    assert.ok(!queries.some(q => /FROM (audit_log|notifications|location_pings|notification_push_outbox)\b/.test(q.sql)));
    assert.ok(queries.filter(q => /FROM (orders|files|order_jobs|order_payments)\b/.test(q.sql)).every(q => /WHERE/.test(q.sql)));
    return queries.map(({ sql, rows }) => ({ sql, rows }));
  };
  const before = await sample();
  await database.query(`INSERT INTO orders (id, client_id, state, created_at, updated_at, position)
    SELECT 'growth_'||i, 'other', 'draft', $1, $1, 1000+i FROM generate_series(1,1000) i`, [AT]);
  assert.deepEqual(await sample(), before);
});

test('targeted HTTP order reads retain forbidden/not-found and role guards', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setupOrders(database);
  const api = await apiForTest(t);
  for (const [who, path, status, error] of [[null, '/orders', 401, 'unauthorized'], ['other', '/orders/a_active', 403, 'forbidden'],
    ['client', '/orders/missing', 404, 'order_not_found'], ['test_ops', '/orders/a_active', 404, 'order_not_found'],
    ['suspended', '/orders', 403, 'forbidden'], ['rider', '/jobs', 403, 'forbidden']]) {
    const result = await api(who, 'GET', path);
    assert.equal(result.status, status, `${who} ${path}`);
    assert.equal(result.body.error, error);
  }
  const jobs = await api('dual', 'GET', '/jobs');
  assert.equal(jobs.status, 200);
  assert.deepEqual(jobs.body.jobs.map(row => row.id), ['dual_order']);
  const selected = await api('dual', 'GET', '/orders', null, { headers: { 'x-gridgo-role': 'client' } });
  assert.equal(selected.status, 200);
  assert.deepEqual(selected.body.orders.map(row => row.id), ['dual_order']);
  assert.equal((await api('client', 'GET', '/orders', null, { headers: { 'x-gridgo-role': 'ops_admin' } })).status, 403);
  await database.query("DELETE FROM user_role_memberships WHERE user_id = 'rider'");
  assert.equal((await api('rider', 'GET', '/orders')).status, 403, 'a stale primary role never causes a read-graph error');
});

test('HTTP order bodies including signed galleries equal the original full-store route', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setupOrders(database);
  // Freeze only these two test children so signed URL timestamps are comparable.
  // The baseline bypasses the hot-read dispatcher; all authentication, route,
  // policy, compatibility decoding and real MinIO signing code still executes.
  const at = Date.now() + 120_000;
  const hook = full => `
    import { registerHooks } from 'node:module';
    const NativeDate = Date;
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [${at}])); }
      static now() { return ${at}; }
    };
    ${full ? `registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (url.endsWith('/src/postgres-store.js')) {
        const source = String(result.source).replace(/export function isHotReadPath\\(pathname\\) \\{[^}]+\\}/,
          'export function isHotReadPath() { return false; }');
        if (source === String(result.source)) throw new Error('Full-store baseline was not installed');
        return { ...result, source };
      }
      if (url.endsWith('/src/server.js')) {
        const source = String(result.source).replace(
          'return mapConcurrent(orders, 4, order => publicOrder(order, user, orderStore, unreadCounts, 4));',
          'return Promise.all(orders.map(order => publicOrder(order, user, orderStore, unreadCounts)));');
        if (source === String(result.source)) throw new Error('Serial signing baseline was not installed');
        return { ...result, source };
      }
      return result;
    } });` : ''}`;
  const env = full => ({ NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(hook(full))}`,
    MINIO_PUBLIC_URL: 'https://storage.example.invalid' });
  const baseline = await apiForTest(t, env(true));
  const targeted = await apiForTest(t, env(false));
  for (const who of ['client', 'supplier', 'rider', 'ops', 'admin', 'test_ops', 'review_client', 'review_supplier', 'review_rider', 'dual']) {
    for (const path of ['/orders', '/jobs', '/orders/a_active', '/orders/review', '/orders/multi', '/orders/unrelated', '/orders/missing']) {
      for (const options of [{}, { headers: { 'x-gridgo-role': who === 'dual' ? 'supplier' : 'client' } }]) {
        const old = await baseline(who, 'GET', path, null, { ...options, raw: true });
        const current = await targeted(who, 'GET', path, null, { ...options, raw: true });
        assert.equal(current.status, old.status, `${who} ${path}`);
        assert.deepEqual(JSON.parse(current.body), JSON.parse(old.body), `${who} ${path}`);
        assert.equal(current.body, old.body, 'byte-for-byte serialized HTTP body');
      }
    }
  }
});
