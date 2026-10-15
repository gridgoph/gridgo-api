import { resetDatabase } from './fixtures/reset-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DATABASE_URL = process.env.DATABASE_URL;
const finance = '/ops/finance/supplier-invoices';
const own = '/me/supplier-invoices';
const details = { fileId: 'scan', number: 'INV-001', date: '2026-10-01', amountMinor: 10000, expectedVersion: 0 };
async function setup(t, startApi = true) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  store.files.push({ fileId: 'scan', ownerId: 'supplier', purpose: 'supplier_invoice', state: 'ready', objectKey: 'private/scan', originalFilename: 'scan.png', detectedContentType: 'image/png', declaredContentType: 'image/png', size: 100, createdAt: AT, references: [] });
  await db.transaction(() => saveStore(db, store));
  const api = startApi ? await apiForTest(t) : null;
  return { db, api };
}
async function ready(api) {
  const result = await api('ops', 'POST', '/orders/order/transition', { state: 'ready_for_dispatch', reasonCode: 'evidence_verified_offline', reason: 'Verified production and packing at the counter' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}
async function attach(api) {
  const result = await api('supplier', 'POST', '/files/scan/attach', { orderId: 'order' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result;
}
const currentMonth = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);

test('Finance counts one obligation at first readiness, scans and paper independently, with private audited retries', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  const month = currentMonth();
  const empty = await api('ops', 'GET', `${finance}?month=${month}`);
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body.totals, { expected: 0, received: 0, missing: 0, collected: 0, toCollect: 0 });
  await ready(api);
  const before = await loadStore(db);
  const pending = await api('supplier', 'GET', `${own}?month=${month}`);
  assert.equal(pending.body.invoices.length, 1);
  assert.match(pending.body.reminder, /invoice/i);
  assert.equal(pending.body.invoices[0].month, month);
  await attach(api);
  assert.equal((await api('ops', 'GET', `${finance}?month=${month}`)).body.totals.received, 0);
  const submitted = await api('supplier', 'PUT', `${own}/order`, details);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.invoice.amountMinor, 10000);
  assert.equal((await api('supplier', 'PUT', `${own}/order`, details)).status, 200);
  const report = await api('admin', 'GET', `${finance}?month=${month}`);
  assert.deepEqual(report.body.totals, { expected: 1, received: 1, missing: 0, collected: 0, toCollect: 1 });
  assert.match(report.headers.get('cache-control'), /no-store/);
  const collected = await Promise.all(['ops', 'admin'].map(actor => api(actor, 'POST', `${finance}/order/collect`, { expectedVersion: 1 })));
  assert.deepEqual(collected.map(r => r.status), [200, 200]);
  assert.deepEqual((await api('ops', 'GET', `${finance}?month=${month}`)).body.totals,
    { expected: 1, received: 1, missing: 0, collected: 1, toCollect: 0 });
  assert.equal((await api('supplier', 'PUT', `${own}/order`, { ...details, number: 'changed', expectedVersion: 2, reason: 'Typo' })).body.error, 'supplier_invoice_collected');
  for (const actor of ['client', 'rider', 'replacement', 'other']) {
    assert.equal((await api(actor, 'GET', `${finance}?month=${month}`)).status, 403);
    assert.equal((await api(actor, 'GET', `${own}/order`)).status, 403);
    assert.equal((await api(actor, 'POST', `${finance}/order/collect`, { expectedVersion: 2 })).status, 403);
  }
  assert.equal((await api(null, 'GET', `${finance}?month=${month}`)).status, 401);
  const saved = await loadStore(db);
  assert.equal(saved.supplierInvoices.length, 1);
  assert.equal(saved.auditLog.filter(a => a.action === 'supplier_invoice.submitted').length, 1);
  assert.equal(saved.auditLog.filter(a => a.action === 'supplier_invoice.collected').length, 1);
  for (const userId of ['ops', 'admin']) assert.ok(saved.notifications.some(n => n.userId === userId && n.type === 'supplier_invoice_collected'));
  assert.deepEqual(saved.orders[0].payoutMilestones, before.orders[0].payoutMilestones);
  assert.equal(saved.orders[0].state, 'ready_for_dispatch');
  assert.equal(JSON.stringify((await api('client', 'GET', '/orders/order')).body).includes('INV-001'), false);
});

test('metadata validation, version conflicts and scan ownership never mark an invoice received', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  await ready(api);
  assert.equal((await api('supplier', 'PUT', `${own}/order`, details)).body.error, 'supplier_invoice_scan_required');
  await attach(api);
  for (const patch of [{ amountMinor: 1.5 }, { amountMinor: Number.MAX_SAFE_INTEGER + 1 }, { amountMinor: -1 }, { date: '2026-02-30' }, { number: '' }, { number: 'x\nsecret' }]) {
    assert.equal((await api('supplier', 'PUT', `${own}/order`, { ...details, ...patch })).status, 400);
  }
  assert.equal((await api('ops', 'POST', `${finance}/order/collect`, { expectedVersion: 0 })).body.error, 'supplier_invoice_scan_required');
  assert.equal((await api('replacement', 'PUT', `${own}/order`, details)).status, 403);
  assert.equal((await api('supplier', 'PUT', `${own}/order`, { ...details, fileId: 'photo_supplier' })).body.error, 'supplier_invoice_scan_required');
  assert.equal((await api('supplier', 'PUT', `${own}/order`, details)).status, 200);
  const signed = await api('supplier', 'GET', '/files/scan/download-url');
  assert.equal(signed.status, 200);
  assert.match(signed.headers.get('cache-control'), /private.*no-store/);
  assert.match((await api('supplier', 'GET', '/files/scan')).headers.get('cache-control'), /private.*no-store/);
  assert.equal((await api('supplier', 'PUT', `${own}/order`, { ...details, amountMinor: 20000 })).body.error, 'supplier_invoice_version_conflict');
  assert.equal((await api('supplier', 'PUT', `${own}/order`, { ...details, amountMinor: 20000, expectedVersion: 1 })).body.error, 'reason_required');
  const correction = await api('supplier', 'PUT', `${own}/order`, { ...details, amountMinor: 20000, expectedVersion: 1, reason: 'Corrected transcription' });
  assert.equal(correction.status, 200, JSON.stringify(correction.body));
  const saved = await loadStore(db);
  assert.equal(saved.supplierInvoices[0].amountMinor, 20000);
  const audit = saved.auditLog.find(a => a.action === 'supplier_invoice.corrected');
  assert.equal(audit.detail.previous.amountMinor, 10000);
  assert.equal(audit.detail.current.amountMinor, 20000);
  assert.equal((await api('ops', 'GET', `${finance}?month=2026-99`)).status, 400);
  assert.equal((await api('ops', 'GET', finance)).status, 400);
});

test('readiness month uses the event timestamp; immutable obligation survives reassignment and repeated readiness', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  const { syncSupplierInvoiceExpectations } = await import('../src/supplier-invoices.js');
  const { id, audit } = await import('./fixtures/reschedule.js');
  await db.transaction(async () => {
    const store = await loadStore(db), previous = structuredClone(store);
    store.orders[0].state = 'ready_for_dispatch';
    store.orders[0].timeline.push({ at: '2026-09-30T15:59:59.999Z', state: 'ready_for_dispatch', by: 'supplier' });
    syncSupplierInvoiceExpectations(store, previous, { at: '2026-09-30T16:00:00.001Z', id, audit });
    await saveStore(db, store);
  });
  assert.equal((await api('ops', 'GET', `${finance}?month=2026-09`)).body.totals.expected, 1);
  await db.transaction(async () => {
    const store = await loadStore(db);
    Object.assign(store.orders[0], { state: 'cancelled', cancelledAt: AT, cancelledBy: 'ops', cancellationReason: 'Cancelled after readiness', supplierId: 'replacement' });
    await saveStore(db, store);
  });
  const attachment = await attach(api);
  assert.equal(attachment.body.order, undefined, 'Former shop must not receive the replacement shop order');
  assert.equal((await api('supplier', 'PUT', `${own}/order`, details)).status, 200);
  const original = (await loadStore(db)).supplierInvoices[0];
  assert.equal(original.supplierId, 'supplier');
  assert.equal(original.month, '2026-09');
  assert.equal((await api('replacement', 'GET', `${own}/order`)).status, 403);
  assert.equal((await api('ops', 'GET', `${finance}?month=2026-09&supplierId=replacement`)).body.totals.expected, 0);
  await assert.rejects(db.query("UPDATE supplier_invoices SET month='2026-10' WHERE order_id='order'"), /immutable/);
  await assert.rejects(db.query("DELETE FROM supplier_invoices WHERE order_id='order'"), /immutable/);
  await db.transaction(async () => {
    const store = await loadStore(db), previous = structuredClone(store);
    store.orders[0].state = 'ready_for_dispatch';
    delete store.orders[0].cancelledAt;
    store.orders[0].timeline.push({ at: '2026-10-01T00:00:00Z', state: 'ready_for_dispatch', by: 'replacement' });
    syncSupplierInvoiceExpectations(store, previous, { at: '2026-10-01T00:00:00Z', id, audit });
    await saveStore(db, store);
  });
  assert.deepEqual((await loadStore(db)).supplierInvoices, [original]);
  assert.ok((await loadStore(db)).auditLog.some(a => a.action === 'supplier_invoice.scan_attached'));
});

test('monthly pagination keeps complete totals and cannot expand a supplier scope', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  await ready(api);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.orders.push({ ...structuredClone(store.orders[0]), id: 'order2', supplierId: 'replacement' });
    store.supplierInvoices.push({ ...structuredClone(store.supplierInvoices[0]), orderId: 'order2', supplierId: 'replacement' });
    await saveStore(db, store);
  });
  const first = await api('ops', 'GET', `${finance}?month=${currentMonth()}&limit=1`);
  assert.equal(first.body.totals.expected, 2);
  assert.equal(first.body.shops.length, 2);
  assert.equal(first.body.invoices.length, 1);
  const second = await api('ops', 'GET', `${finance}?month=${currentMonth()}&limit=1&after=${first.body.nextCursor}`);
  assert.equal(second.body.invoices[0].orderId, 'order2');
  assert.equal(second.body.nextCursor, null);
  assert.equal(second.body.totals.expected, 2);
  const mine = await api('supplier', 'GET', `${own}?month=${currentMonth()}&supplierId=replacement`);
  assert.equal(mine.body.invoices[0].supplierId, 'supplier');
  assert.equal(mine.body.totals.expected, 1);
});

test('migration backfills first readiness evidence in Manila month and resolves historical recovery shop', { skip: !DATABASE_URL }, async t => {
  const { db } = await setup(t, false);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.orders.push({ ...structuredClone(store.orders[0]), id: 'no_readiness' });
    await saveStore(db, store);
  });
  const { up } = await import('../migrations/1792000500000_supplier_invoices.js');
  const rollback = new Error('rollback test schema');
  await assert.rejects(db.transaction(async () => {
    await db.query('DROP TABLE supplier_invoices; DROP FUNCTION guard_supplier_invoice()');
    const history = { timeline: [
      { state: 'ready_for_dispatch', at: '2026-09-30T16:00:00.000Z', by: 'ops' },
      { state: 'ready_for_dispatch', at: '2026-11-01T00:00:00.000Z', by: 'replacement' },
    ], shopFailureEvents: [{ supplierId: 'supplier', at: '2026-10-05T00:00:00.000Z' }] };
    await db.query("UPDATE orders SET supplier_id='replacement', state='cancelled', cancelled_at='2026-10-06T00:00:00Z', cancellation_reason='Cancelled after readiness', data=data || $1::jsonb WHERE id='order'", [JSON.stringify(history)]);
    const sql = []; await up({ sql: value => sql.push(value) });
    for (const statement of sql) await db.query(statement);
    const rows = (await db.query('SELECT order_id,supplier_id,month,expected_at,version FROM supplier_invoices')).rows;
    assert.deepEqual(rows, [{ order_id: 'order', supplier_id: 'supplier', month: '2026-10', expected_at: '2026-09-30T16:00:00.000Z', version: 0 }]);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM audit_log WHERE action='supplier_invoice.expected'")).rows[0].count, 1);
    throw rollback;
  }), error => error === rollback);
});

test('database membership and approval govern Finance and shop intake, ignoring token role claims', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  await ready(api);
  assert.equal((await api('client', 'GET', `${finance}?month=${currentMonth()}`, null, { claims: { role: 'super_admin' } })).status, 403);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.userRoleMemberships.push({ userId: 'supplier', role: 'client', createdAt: AT });
    store.clientProfiles.push({ userId: 'supplier', clientKind: 'personal', updatedAt: AT });
    await saveStore(db, store);
  });
  assert.equal((await api('supplier', 'GET', `${own}/order`, null, { headers: { 'X-GRIDGO-Role': 'client' } })).status, 403);
  assert.equal((await api('supplier', 'GET', `${own}/order`, null, { headers: { 'X-GRIDGO-Role': 'supplier' } })).status, 200);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.approvalCases.find(row => row.userId === 'supplier').status = 'pending';
    await saveStore(db, store);
  });
  assert.equal((await api('supplier', 'GET', `${own}/order`)).status, 403);
  assert.equal((await api('supplier', 'PUT', `${own}/order`, details)).status, 403);
});

test('a failed database write rolls back invoice details, audit and administrator notifications together', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  await ready(api); await attach(api);
  // Fail the final audit insertion after the invoice row has been written.
  await db.query(`CREATE FUNCTION gg62_reject_invoice_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='supplier_invoice.submitted' THEN RAISE EXCEPTION 'test audit rejection'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER gg62_invoice_audit_test BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION gg62_reject_invoice_audit()`);
  try {
    const before = await loadStore(db);
    assert.equal((await api('supplier', 'PUT', `${own}/order`, details)).status, 500);
    const after = await loadStore(db);
    assert.deepEqual(after.supplierInvoices, before.supplierInvoices);
    assert.deepEqual(after.auditLog, before.auditLog);
    assert.deepEqual(after.notifications, before.notifications);
  } finally {
    await db.query('DROP TRIGGER gg62_invoice_audit_test ON audit_log; DROP FUNCTION gg62_reject_invoice_audit()');
  }
});
