import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from '../src/database.js';
import {loadStore,saveStore} from '../src/postgres-store.js';
import {setupVerification} from './fixtures/supplier-verification.js';
import {prepareVerificationPayout} from '../src/supplier-verification.js';
import {id} from './fixtures/reschedule.js';
const skip=!process.env.DATABASE_URL;
async function setup(t,enabled=true) {
 const db=createDatabase(process.env);t.after(()=>db.close());
 await setupVerification(db,s=>{
  s.settings.supplierOnboarding={autoApproveDocuments:enabled,unverifiedShopsEnabled:enabled};
  s.supplierSignups=[{clerkUserId:'clerk_supplier',supplierId:'supplier',version:5,updatedAt:new Date().toISOString(),
   steps:{eligibility:{registrantRole:'owner'},prints:{documents:{pricesMinor:{a4:{bw:200,light:400,full:600}}}},finish:{at:new Date().toISOString()}}}];
 });return db;
}
async function reserve(db,key,amountMinor) {
 await db.transaction(async()=>{
  const s=await loadStore(db),o=s.orders[0];
  const payout=prepareVerificationPayout(s,o,{key,amountMinor,at:new Date().toISOString(),actor:s.users.find(u=>u.id==='ops'),id});
  assert.equal(payout.status,'ready');await saveStore(db,s);
 });
}
test('persisted onboarding reservation consumes the same cap across payout types and rejects legacy ledger writers',{skip},async t=>{
 const db=await setup(t);await reserve(db,'stage:order:production_started',4000);
 const s=await loadStore(db);
 const held=prepareVerificationPayout(s,s.orders[0],{key:'bonus:order:supplier',amountMinor:100,at:new Date().toISOString(),actor:s.users.find(u=>u.id==='ops'),id});
 assert.equal(held.status,'held');assert.equal(held.reason,'verification_payout_cap');
 await assert.rejects(db.transaction(()=>db.query(`INSERT INTO supplier_verification_ledger
  (id,supplier_id,order_id,payout_key,kind,amount_minor,net_amount_minor,recovery_minor,created_at,position,data)
  VALUES('over-cap','supplier','order','bonus:order:supplier','reserved',100,100,0,now(),99,'{"netAmountMinor":100,"recoveryMinor":0}')`)),/verification_payout_cap/);
 assert.equal((await loadStore(db)).supplierVerificationLedger.filter(e=>e.kind==='reserved').length,1);
});
test('production-off onboarding blocks direct database preparation as well as application payout preparation',{skip},async t=>{
 const db=await setup(t,false);const s=await loadStore(db);
 const payout=prepareVerificationPayout(s,s.orders[0],{key:'stage:order:production_started',amountMinor:100,at:new Date().toISOString(),actor:s.users.find(u=>u.id==='ops'),id});
 assert.equal(payout.reason,'supplier_verification_required');
 await assert.rejects(db.transaction(()=>db.query(`INSERT INTO supplier_verification_ledger
  (id,supplier_id,order_id,payout_key,kind,amount_minor,net_amount_minor,recovery_minor,created_at,position,data)
  VALUES('disabled','supplier','order','stage:order:production_started','reserved',100,100,0,now(),0,'{"netAmountMinor":100,"recoveryMinor":0}')`)),/supplier_verification_required/);
});
