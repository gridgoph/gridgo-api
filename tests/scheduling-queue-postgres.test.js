import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture } from './fixtures/reschedule.js';
import { projectShopFinish } from '../src/order-match.js';
import { up } from '../migrations/1792502000000_order_job_queue_backfill.js';
import { up as withdrawnUp } from '../migrations/1792503000000_withdrawn_production_queue_backfill.js';

test('backfill repairs stale basket jobs, is repeatable and preserves every order and money snapshot', { skip: !process.env.DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL: process.env.DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const initial = fixture();
  const template = structuredClone(initial.orders[0]), job = structuredClone(initial.orderJobs[0]);
  initial.orders = []; initial.orderJobs = []; initial.orderLineItems = [];
  for (const state of ['picked_up', 'out_for_delivery', 'delivered', 'issue_window_open', 'completed', 'cancelled']) {
    initial.orders.push({ ...structuredClone(template), id: state, state, basketId: 'basket', ...(state === 'cancelled' ? { cancelledAt: template.updatedAt, cancellationReason: 'Fixture cancellation' } : {}) });
    initial.orderJobs.push({ ...job, id: `job_${state}`, orderId: state, state: 'rider_assigned' });
  }
  await db.transaction(() => saveStore(db, initial));
  const ordersBefore = (await db.query('SELECT * FROM orders ORDER BY id')).rows;
  const jobsBefore = (await db.query('SELECT * FROM order_jobs ORDER BY id')).rows;
  const input = { supplierId: 'supplier', turnaroundHours: 1, now: '2026-10-19T01:00:00Z' };
  assert.equal(projectShopFinish(await loadStore(db), input).queue.jobsAhead, 0);
  const statements = []; up({ sql: sql => statements.push(sql) });
  for (const sql of statements) await db.query(sql);
  const after = (await db.query('SELECT * FROM order_jobs ORDER BY id')).rows;
  for (let i = 0; i < after.length; i++) {
    assert.equal(after[i].state, after[i].order_id);
    assert.deepEqual({ ...after[i], state: jobsBefore[i].state, updated_at: jobsBefore[i].updated_at }, jobsBefore[i]);
  }
  for (const sql of statements) assert.equal((await db.query(sql)).rowCount, 0);
  assert.deepEqual((await db.query('SELECT * FROM orders ORDER BY id')).rows, ordersBefore);
});

test('withdrawn-work forward backfill closes original shop jobs and preserves accepted replacements and every order snapshot', { skip: !process.env.DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL: process.env.DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const initial = fixture(), template = structuredClone(initial.orders[0]), job = structuredClone(initial.orderJobs[0]);
  initial.orders = []; initial.orderJobs = []; initial.orderLineItems = [];
  for (const status of ['awaiting_client', 'ops_review', 'refund_requested', 'accepted']) {
    initial.orders.push({ ...structuredClone(template), id: status, supplierId: status === 'accepted' ? 'replacement' : 'supplier',
      shopRecovery: { id: `recovery_${status}`, status, originalSupplierId: 'supplier' } });
    initial.orderJobs.push({ ...job, id: `old_${status}`, orderId: status });
    if (status === 'accepted') initial.orderJobs.push({ ...job, id: 'replacement_job', orderId: status, supplierId: 'replacement' });
  }
  initial.orders.push({ ...structuredClone(template), id: 'released', state: 'payout_released' });
  initial.orderJobs.push({ ...job, id: 'released_job', orderId: 'released' });
  await db.transaction(() => saveStore(db, initial));
  const before = (await db.query('SELECT * FROM orders ORDER BY id')).rows;
  const jobsBefore = (await db.query('SELECT * FROM order_jobs ORDER BY id')).rows;
  const statements = []; withdrawnUp({ sql: sql => statements.push(sql) });
  for (const sql of statements) await db.query(sql);
  const after = (await db.query('SELECT * FROM order_jobs ORDER BY id')).rows;
  for (let i = 0; i < after.length; i++) {
    assert.equal(after[i].state, after[i].id === 'replacement_job' ? 'production' : after[i].id === 'released_job' ? 'completed' : 'cancelled');
    assert.deepEqual({ ...after[i], state: jobsBefore[i].state, updated_at: jobsBefore[i].updated_at }, jobsBefore[i]);
  }
  for (const sql of statements) assert.equal((await db.query(sql)).rowCount, 0);
  assert.deepEqual((await db.query('SELECT * FROM orders ORDER BY id')).rows, before);
  const store = await loadStore(db);
  assert.equal(projectShopFinish(store, { supplierId: 'supplier', turnaroundHours: 1, now: template.createdAt }).queue.jobsAhead, 0);
  assert.equal(projectShopFinish(store, { supplierId: 'replacement', turnaroundHours: 1, now: template.createdAt }).queue.jobsAhead, 1);
});
