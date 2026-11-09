import { apiForTest } from './reschedule-http.js';
import { setupOrders } from './order-reads.js';
import { loadStore, saveStore } from '../../src/postgres-store.js';
import { syncSupplierPerformance } from '../../src/supplier-performance.js';
import { AT } from './reschedule.js';

export const SAVE_AT = Date.parse('2026-11-09T04:00:00.000Z');
export async function setupSaveParity(db) {
  await setupOrders(db);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.carts.push({ id: 'save_cart', clientId: 'client', state: 'draft', version: 1, serviceLevel: 'standard', fulfillmentMode: 'delivery', createdAt: AT, updatedAt: AT });
    store.cartLines.push({ id: 'save_line', cartId: 'save_cart', supplierId: 'supplier', catalogItemId: 'item_supplier', optionIds: [], quantity: 10, sortOrder: 0, structuredSpec: {}, createdAt: AT, updatedAt: AT });
    let sequence = 0;
    syncSupplierPerformance(store, { at: new Date(SAVE_AT).toISOString(), id: prefix => `${prefix}_setup_${++sequence}` });
    await saveStore(db, store);
  });
}

export async function saveParityApi(t, full, { failSql = null, upkeep = false, timing = false, onOutput } = {}) {
  const injected = `async function query(text, values) { if (text.includes(${JSON.stringify(failSql)})) throw new Error("injected_sql_failure");`;
  const hook = `
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    import crypto from 'node:crypto';
    const NativeDate = Date;
    ${timing ? '' : `globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [${SAVE_AT}])); } static now() { return ${SAVE_AT}; } };`}
    let uuid=0;const bytes=new Map();
    crypto.randomUUID = () => '00000000-0000-4000-8000-'+String(++uuid).padStart(12,'0');
    crypto.randomBytes = n => { const out=Buffer.alloc(n); const next=(bytes.get(n)||0)+1;bytes.set(n,next);out.writeUInt32BE(next,n-4); return out; };
    syncBuiltinESMExports();
    registerHooks({ load(url, context, next) {
      const result=next(url,context); let source=String(result.source);
      if(url.endsWith('/src/server.js')) {
        source=source.replace('function kickPushDrain() {','function kickPushDrain() { return;');
        ${full ? `source=source.replace('const clientSave = database.inWriteTransaction() && isClientSavePath(req.method, pathname);', 'const clientSave = false;');` : ''}
        source=source.replaceAll('void runLifecycleWork();','').replaceAll('void runFileRetention();','').replaceAll('await fileRetention.reconcile();','void 0;').replaceAll('void fileRetention.reconcile()', 'void Promise.resolve()');
        source=source.replace(/setInterval\\((runLifecycleWork|sweepCalls|sweepSaveUpkeep|runFileRetention),/g,'setInterval(() => {},');
        ${upkeep ? `source=source.replace('const lifecycleTimer =', 'setTimeout(() => sweepSaveUpkeep(), 100).unref(); const lifecycleTimer =');` : ''}
      }
      ${failSql ? `if(url.endsWith('/src/database.js')) source=source.replace('async function query(text, values) {', ${JSON.stringify(injected)});` : ''}
      return { ...result, source };
    } });`;
  const api = await apiForTest(t, { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(hook)}`, MINIO_PUBLIC_URL: 'https://storage.example.invalid' }, { onOutput });
  return (who, method, pathname, body, opts = {}) => api(who, method, pathname, body, { ...opts,
    claims: { iat: (timing ? Date.now()/1000 : SAVE_AT/1000)-5, nbf: (timing ? Date.now()/1000 : SAVE_AT/1000)-5, exp: (timing ? Date.now()/1000 : SAVE_AT/1000)+3600, ...opts.claims } });
}

export async function saveRows(db) {
  const tables = ['orders','order_jobs','order_line_items','order_line_item_options','order_payments','order_payment_allocations',
    'payout_milestones','order_baskets','order_basket_groups','order_invoices','audit_log','notifications','notification_push_outbox',
    'vouchers','voucher_reservations','voucher_redemptions','voucher_ledger','credit_accounts','credit_ledger',
    'client_carts','client_cart_lines','client_match_selections','files','file_references','tester_invites','promotion_invites',
    'founding_testers','tester_rewards','supplier_performance_events','supplier_invoices','order_surveys','order_calls','store_collection_counts'];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(r => r.row)])));
}
