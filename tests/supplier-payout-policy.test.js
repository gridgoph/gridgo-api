import test from 'node:test';
import assert from 'node:assert/strict';
import { routePayoutAccount } from '../src/payout-account.js';
import { assertSupplierPayoutAllowed, supplierPayoutStatus } from '../src/supplier-payout-policy.js';
import { PAYOUT_CONSENT_WORDING } from '../src/supplier-signup.js';
import { releaseMilestone, expireIssueWindows } from '../src/operational-model.js';
const AT='2026-11-22T01:00:00.000Z';
function setup() {
  const user={id:'shop',role:'supplier'};
  const store={users:[user,{id:'ops',role:'ops_admin'}],userRoleMemberships:[{userId:'shop',role:'supplier'},{userId:'ops',role:'ops_admin'}],
    shopMemberships:[{shopId:'shop',userId:'shop',role:'owner',status:'active'}],supplierProfiles:[{userId:'shop'}],
    supplierPayoutAccounts:[],files:['first','second'].map(fileId=>({fileId,ownerId:'shop',purpose:'supplier_payout_qr',state:'ready',objectKey:fileId,references:[]})),notifications:[],orders:[]};
  const call=(method,body,at=AT,actor=user)=>routePayoutAccount({req:{method,headers:method==='DELETE'?{'if-match':String(body.expectedVersion)}:{}},url:new URL('http://test/me/payout-account'),store,user:actor,readBody:async()=>body,now:()=>at,id:p=>`${p}_${store.notifications.length}`,audit:()=>{}});
  return {store,user,call};
}
const consent={accepted:true,wording:PAYOUT_CONSENT_WORDING};
test('QR requires consent and holder; changing it pauses every payout for exactly 24 hours and notifies owners and staff',async()=>{
  const {store,call}=setup();
  await assert.rejects(call('PATCH',{provider:'other',accountName:'Recipient',qrFileId:'first'}),e=>e.code==='payout_consent_required');
  await call('PATCH',{provider:'other',accountName:'Recipient',qrFileId:'first',holder:'family',consent});
  assert.equal(store.supplierPayoutPolicies[0].consent.at,AT);
  assert.equal(store.supplierPayoutPolicies[0].consent.wording,PAYOUT_CONSENT_WORDING);
  assert.equal(supplierPayoutStatus(store,'shop',AT).held,false);
  const change=await call('PATCH',{expectedVersion:1,qrFileId:'second',holder:'family',consent},'2026-11-22T02:00:00.000Z');
  assert.equal(change.body.payoutAccount.payoutStatus.pausedUntil,'2026-11-23T02:00:00.000Z');
  assert.throws(()=>assertSupplierPayoutAllowed(store,'shop','2026-11-23T01:59:59.999Z'),e=>e.code==='supplier_payout_paused');
  const order={supplierId:'shop',payoutMilestones:[{code:'printing',status:'locked'}]};
  assert.throws(()=>releaseMilestone(order,'printing',{id:'ops',role:'ops_admin'},'2026-11-23T01:59:59.999Z',store),e=>e.code==='supplier_payout_paused');
  assert.equal(order.payoutMilestones[0].status,'locked');
  assert.doesNotThrow(()=>assertSupplierPayoutAllowed(store,'shop','2026-11-23T02:00:00.000Z'));
  assert.ok(store.notifications.some(n=>n.userId==='shop'&&n.type==='supplier_payout_account_changed'));
  assert.ok(store.notifications.some(n=>n.userId==='ops'&&n.type==='supplier_payout_account_changed'));
});
test('a destination pause never breaks legacy issue-window completion or releases retention',()=>{
  const {store}=setup();store.supplierPayoutPolicies=[{supplierId:'shop',pausedUntil:'2026-11-23T01:00:00.000Z'}];
  const order={id:'legacy',supplierId:'shop',payoutPlanVersion:1,state:'issue_window_open',issueWindowExpiresAt:AT,
    payoutMilestones:[{code:'retention',status:'locked',pofFileIds:['proof'],amountMinor:100}]};
  store.orders=[order];
  assert.equal(expireIssueWindows(store,AT),true);
  assert.equal(order.state,'completed');assert.equal(order.payoutMilestones[0].status,'locked');
});
test('manager cannot set or change a QR; deleting and recreating the account never clears its pause',async()=>{
  const {store,user,call}=setup();
  await assert.rejects(call('PATCH',{provider:'other',accountName:'Recipient',qrFileId:'first',holder:'mine',consent},AT,{...user,shopRole:'manager'}),e=>e.code==='shop_owner_required');
  await call('PATCH',{provider:'other',accountName:'Recipient',qrFileId:'first',holder:'mine',consent});
  await call('DELETE',{expectedVersion:1});
  await call('PATCH',{provider:'other',accountName:'Recipient',qrFileId:'second',holder:'mine',consent});
  assert.equal(supplierPayoutStatus(store,'shop',AT).pausedUntil,'2026-11-23T01:00:00.000Z');
  store.supplierSignups=[{supplierId:'shop',steps:{eligibility:{registrantRole:'manager'}}}];
  store.shopMemberships[0].role='staff';
  assert.equal(supplierPayoutStatus(store,'shop',AT).reason,'shop_owner_claim_required');
});
