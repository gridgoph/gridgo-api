import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadHotReadStore, isHotReadPath } from '../src/postgres-store.js';
import { setupOrders, instrument } from './fixtures/order-reads.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { readParityEnv } from './fixtures/read-parity.js';
import { AT } from './fixtures/reschedule.js';
const skip = !process.env.DATABASE_URL;

test('matching calendar and layout read responses equal full-store bytes across actors', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setupOrders(database);
  const at = Date.now() + 120000;
  const baseline = await apiForTest(t, readParityEnv(true, at));
  const targeted = await apiForTest(t, readParityEnv(false, at));
  const paths = ['/me/deadline-days?subcategoryCode=flyers&days=7', '/me/deadline-days?subcategoryCode=missing',
    '/me/deadline-days', '/me/print-layout-check?catalogItemId=item_supplier&fileIds=art_a_active',
    '/me/print-layout-check?catalogItemId=item_supplier&fileIds=art_unrelated', '/me/print-layout-check?catalogItemId=missing',
    '/me/print-layout-check?catalogItemId=item_supplier&fileIds=' + Array.from({length:11},(_,i) => `f${i}`).join(',')];
  for (const who of [null,'client','other','supplier','rider','ops','admin','test_ops','review_client','dual']) for (const path of paths) {
    const old = await baseline(who,'GET',path,null,{raw:true});
    const current = await targeted(who,'GET',path,null,{raw:true});
    assert.equal(current.status,old.status,`${who} ${path}`);
    assert.deepEqual(JSON.parse(current.body),JSON.parse(old.body),`${who} ${path}`);
    assert.equal(current.body,old.body,`${who} ${path}: bytes`);
  }
  assert.equal((await targeted('client','GET',paths[0])).status,200);
  assert.equal((await targeted('client','GET',paths[3])).status,200);
});

test('matching read graphs have fixed query budgets without unrelated history', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setupOrders(database);
  assert.ok(isHotReadPath('/me/deadline-days'));
  assert.equal(isHotReadPath('/me/matches'), false, 'token writes retain their full mutation graph');
  const sample = async () => {
    const out = [];
    for (const path of ['/me/deadline-days?subcategoryCode=flyers','/me/print-layout-check?catalogItemId=item_supplier&fileIds=art_a_active']) {
      const url = new URL(path,'http://localhost');
      const {db,queries} = instrument(database);
      await loadHotReadStore(db,'clerk_client',url.pathname,{ searchParams:url.searchParams });
      assert.ok(queries.length <= 36,`queries=${queries.length}`);
      assert.ok(!queries.some(q => /FROM (audit_log|notifications|location_pings|notification_push_outbox|order_payments)\b/.test(q.sql)));
      out.push(queries);
    }
    return out;
  };
  const before = await sample();
  await database.query(`INSERT INTO orders(id,client_id,state,created_at,updated_at,position)
    SELECT 'growth_'||i,'other','draft',$1,$1,1000+i FROM generate_series(1,1000) i`,[AT]);
  assert.deepEqual(await sample(),before);
});
