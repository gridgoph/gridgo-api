import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture } from './fixtures/reschedule.js';
import { saveStore } from '../src/postgres-store.js';
import { postCash, cashWallet, reconcileCash, reserveCash, releaseCash } from '../src/cash-ledger.js';

test('cash journal is balanced, immutable, idempotent and wallet reservations cannot overdraw concurrently', { skip: !process.env.DATABASE_URL }, async () => {
  const db = createDatabase(process.env);
  try {
    await resetDatabase(db, 'TRUNCATE users, platform_settings RESTART IDENTITY CASCADE');
    const store = fixture();
    store.orders.push({ ...structuredClone(store.orders[0]), id: 'other-order' });
    await db.transaction(() => saveStore(db, store));
    const pendingId=await db.transaction(()=>postCash(db,{key:'topup:pending',kind:'topup_pending',riderId:'rider',actorId:'rider',
      entries:[['pending_bank:rider',20000],['pending_topup:rider',-20000]],evidence:{reference:'BANK-1',amountMinor:20000}}));
    const topup = { key: 'topup:one', kind: 'topup_confirmed', riderId: 'rider', actorId: 'ops',
      entries: [['pending_bank:rider',-20000],['pending_topup:rider',20000],['gridgo_bank', 20000], ['wallet:rider', -20000]],
      evidence: { reference: 'BANK-1',amountMinor:20000,topupId:pendingId } };
    await db.transaction(() => postCash(db, topup));
    await db.transaction(() => postCash(db, topup));
    assert.equal((await cashWallet(db, 'rider')).balanceMinor, 20000);
    await assert.rejects(db.transaction(() => postCash(db, { ...topup, entries: [['gridgo_bank', 50000], ['wallet:rider', -50000]] })), { code: 'cash_idempotency_conflict' });
    await assert.rejects(db.transaction(() => postCash(db, { ...topup, key: 'unbalanced', entries: [['gridgo_bank', 10]] })), /cash_unbalanced/);
    const claims = await Promise.allSettled([db.transaction(() => reserveCash(db, 'order', 'rider', 19000)), db.transaction(() => reserveCash(db, 'other-order', 'rider', 19000))]);
    assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
    const held = (await db.query('SELECT order_id FROM cash_reservations WHERE released_at IS NULL')).rows[0].order_id;
    assert.equal((await cashWallet(db,'rider')).lowBalance,true);
    await db.transaction(() => releaseCash(db, held));
    await assert.rejects(db.transaction(() => postCash(db, { ...topup, kind:'gridgo_share_debited', key: 'overdraw', entries: [['gridgo_revenue', -20001], ['wallet:rider', 20001]] })), /cash_wallet|check constraint/);
    const reconciliation = await reconcileCash(db);
    assert.equal(reconciliation.ok, true);
    for (const sql of ['UPDATE cash_entries SET amount_minor=amount_minor+1', 'DELETE FROM cash_journals', 'UPDATE cash_accounts SET balance_minor=1 WHERE id=\'wallet:rider\'']) {
      await assert.rejects(db.transaction(() => db.query(sql)), /immutable|derived/);
    }
    const journal=(await db.query("SELECT id FROM cash_journals WHERE event_key='topup:one'")).rows[0].id;
    await assert.rejects(db.transaction(()=>db.query("INSERT INTO cash_entries(journal_id,position,account_id,amount_minor) VALUES($1,99,'gridgo_bank',1)",[journal])),/immutable/);
    await assert.rejects(db.transaction(()=>db.query('TRUNCATE cash_journals CASCADE')),/immutable/);
    assert.equal((await cashWallet(db, 'rider')).balanceMinor, 20000);
  } finally { await db.close(); }
});
