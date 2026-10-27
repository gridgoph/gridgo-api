import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { checkoutFixture, AT } from './helpers/promotion-checkout.mjs';
import { collectedSupplierPrincipalMinor } from '../src/operational-model.js';
import { claimFounding, inviteFriend } from '../src/promotions.js';
import { id, audit } from './fixtures/reschedule.js';
import { requestDeliveryPin } from '../src/delivery-pin.js';
const DB = process.env.DATABASE_URL;
async function setup(t, options) {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, voucher_campaigns, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const s = checkoutFixture(options);
  for (const [fileId, purpose, ownerId] of [['refundQr','refund_qr','client'], ['refundReceipt','refund_receipt','ops'], ['pinProof','payment_proof','client'], ['finalProof','payment_proof','client']]) s.files.push({ fileId, purpose, ownerId, state: 'ready', objectKey: `private/${fileId}`, originalFilename: `${fileId}.png`, size: 100, declaredContentType: 'image/png', detectedContentType: 'image/png', createdAt: AT, references: [] });
  if (options?.riderRate !== undefined) s.settings.riderCommissionBps=options.riderRate;
  if (options?.far) s.orders[0].dropoff = {lat:7.06+8/111.195,lng:125.6,label:'Original far pin'};
  if (options?.tinyFirstShop) s.catalogItems.find(i => i.id === 'item_supplier').basePriceMinor = 1;
  await db.transaction(() => saveStore(db, s));
  return { db, s, api: await apiForTest(t) };
}
async function mutate(db, action) { return db.transaction(async () => { const s = await loadStore(db); await action(s); await saveStore(db, s); }); }
async function ok(api, user, method, path, body, expected=200, opts) {
  const r = await api(user, method, path, body, opts); assert.equal(r.status, expected, `${path}: ${JSON.stringify(r.body)}`); return r.body;
}
async function cart(api, s, quantities=[1]) {
  const made = await ok(api,'client','POST','/me/carts',{fulfillmentMode:'delivery',defaultDropoff:s.orders[0].dropoff},201);
  const path = `/me/carts/${made.cart.id}`;
  for (const [n,quantity] of quantities.entries()) await ok(api,'client','POST',`${path}/lines`,{catalogItemId:`item_${n?'replacement':'supplier'}`,quantity,optionIds:[],artworkFileId:'artwork',deadline:'2026-10-30T10:00:00.000Z'},201);
  return path;
}
async function remedy(api, orderId, {clientCaused=false,totalMinor=0,shopEntitlementMinor=0,cashDestination=false}={}) {
  let {refund} = await ok(api,'client','POST',`/orders/${orderId}/refund-requests`,{kind:'cancellation',reason:'Order cannot continue',...(cashDestination?{destination:{provider:'gcash',accountName:'Client',qrFileId:'refundQr',ownershipConfirmed:true}}:{})},201);
  ({refund} = await ok(api,'ops','POST',`/refund-requests/${refund.id}/review`,{expectedVersion:refund.version,reason:'Reviewed the order and obligations',...(cashDestination?{destinationVerified:true}:{})}));
  const body={expectedVersion:refund.version,reason:'Agreed cancellation remedy',workStopped:true,clientCaused,shopAgreement:'Shop work and obligation reconciled',deliveryEvidence:'No delivery performed',shopEntitlementMinor,riderEntitlementMinor:0,totalMinor};
  const key=id('remedy'); const settled=await ok(api,'ops','POST',`/refund-requests/${refund.id}/settle`,body,200,{key});
  const replay=await ok(api,'ops','POST',`/refund-requests/${refund.id}/settle`,body,200,{key}); assert.deepEqual(replay,settled);
  return settled.refund;
}
for (const [amount, quantities, zeroCash] of [[20000,[1],true],[20000,[10],false],[50000,[1,1],true],[35000,[10,10],false]]) {
  test(`HTTP checkout voucher privacy matches order and invoice (${quantities.length} shops, zero cash=${zeroCash})`,{skip:!DB},async t=>{
    const {db,s,api}=await setup(t,{amount}); const path=await cart(api,s,quantities);
    const placed=await ok(api,'client','POST',`${path}/checkout`,zeroCash?{}:{payment:{method:'qr_manual',reference:'PRIVATE-FUNDING',proofFileId:'receipt'}},201);
    assert.equal((placed.basket?.totalMinor??placed.order.totalMinor)===0,zeroCash);
    const privateFields=['supplierMinor','gridgoSupplierTopupMinor','gridgoRiderTopupMinor'];
    const assertPrivate=voucher=>{
      assert.ok(voucher); assert.ok(voucher.amountMinor>0); assert.equal(voucher.fundedBy,'GRIDGO');
      for(const field of privateFields) assert.equal(Object.hasOwn(voucher,field),false,`${field} must be staff-only`);
    };
    assertPrivate(placed.order.voucher);
    const groupOrders=placed.basket?placed.basket.groups.map(g=>g.order):[placed.order];
    const stored=await loadStore(db);
    for(const checkoutOrder of groupOrders){
      assertPrivate(checkoutOrder.voucher);
      const normal=(await ok(api,'client','GET',`/orders/${checkoutOrder.id}`)).order;
      assert.deepEqual(checkoutOrder.voucher,normal.voucher);
      const staff=(await ok(api,'ops','GET',`/orders/${checkoutOrder.id}`)).order;
      const internal=stored.orders.find(o=>o.id===checkoutOrder.id);
      for(const field of privateFields) assert.equal(staff.voucher[field],internal.voucher[field]);
    }
    const receipt=(await ok(api,'client','GET',`/orders/${placed.order.id}/invoice`)).invoice;
    assertPrivate(placed.invoice.voucher); assertPrivate(receipt.voucher);
    for(const section of [...(placed.invoice.groups||[]),...(receipt.groups||[])]) assertPrivate(section.voucher);
    assert.deepEqual(placed.order.voucher,groupOrders[0].voucher);
  });
}
for(const [percent,finalPaid,pin] of [[100,true,false],[75,false,false],[75,true,false],[100,true,true],[75,false,true],[75,true,true]]) {
  test(`HTTP/SQL cash refund uses funded delivery collection (${percent}%, final paid=${finalPaid}, pin=${pin})`,{skip:!DB},async t=>{
    const {db,s,api}=await setup(t,{percent,amount:6000,riderRate:pin?8001:8500}); const path=await cart(api,s,[10]);
    const placed=await ok(api,'client','POST',`${path}/checkout`,{payment:{method:'qr_manual',reference:'REFUND-FUNDING',proofFileId:'receipt'}},201);
    const orderId=placed.order.id;
    await ok(api,'ops','POST',`/orders/${orderId}/payments/initial/confirm`,{});
    if(percent===75&&finalPaid){
      await ok(api,'client','POST',`/orders/${orderId}/payments/final_online/submit`,{method:'qr_manual',reference:'REFUND-FINAL',proofFileId:'finalProof'});
      await ok(api,'ops','POST',`/orders/${orderId}/payments/final_online/confirm`,{});
    }
    if(pin){
      await mutate(db,s=>{const o=s.orders.find(o=>o.id===orderId);o.state='production';requestDeliveryPin(s,o,{at:AT,id,audit,user:s.users.find(u=>u.id==='supplier')});});
      const point={lat:7.06+8/111.195,lng:125.6,label:'Paid surcharge pin'};
      const current=(await ok(api,'client','GET',`/orders/${orderId}/delivery-pin`)).deliveryPin;
      const {preview}=await ok(api,'client','POST',`/orders/${orderId}/delivery-pin/preview`,{point});
      let changed=(await ok(api,'client','POST',`/orders/${orderId}/delivery-pin/change`,{expectedVersion:current.version,point,feeDifferenceMinor:preview.feeDifferenceMinor,acknowledgeOneChange:true})).deliveryPin;
      changed=(await ok(api,'client','POST',`/orders/${orderId}/delivery-pin/payment`,{expectedVersion:changed.version,proofFileId:'pinProof',reference:'REFUND-PIN'})).deliveryPin;
      await ok(api,'ops','POST',`/orders/${orderId}/delivery-pin/payment/confirm`,{expectedVersion:changed.version,amountMinor:preview.feeDifferenceMinor,reason:'Pin transfer verified'});
    }
    const before=(await ok(api,'ops','GET',`/orders/${orderId}`)).order, delivery=before.deliverySettlement;
    if(!pin) assert.equal(delivery.platformCollectedMinor,0);
    assert.equal(delivery.collectedMinor+delivery.fundedRiderMinor,delivery.riderCollectedMinor+delivery.platformCollectedMinor);
    const storedBefore=await loadStore(db), original=storedBefore.orders.find(o=>o.id===orderId);
    const cash=Object.values(original.payments).filter(p=>p.status==='confirmed').reduce((sum,p)=>sum+p.amountMinor,0)+(original.deliveryPin?.change?.payment?.amountMinor||0);
    let refund=await remedy(api,orderId,{cashDestination:true,totalMinor:cash});
    assert.equal(refund.settlement.deliveryMinor,delivery.collectedMinor);
    assert.equal(refund.settlement.platformDeliveryMinor,delivery.platformCollectedMinor);
    const persisted=await db.query('SELECT platform_delivery_minor FROM refund_settlements WHERE request_id=$1',[refund.id]);
    assert.equal(Number(persisted.rows[0].platform_delivery_minor),delivery.platformCollectedMinor);
    ({refund}=await ok(api,'ops','POST',`/refund-requests/${refund.id}/payment-attempts`,{expectedVersion:refund.version,reason:'Return verified client cash',destinationVerified:true,destinationRevision:1,provider:'gcash',sourceWallet:'ops-main'}));
    await ok(api,'ops','POST',`/refund-requests/${refund.id}/payments`,{expectedVersion:refund.version,reason:'Refund transfer completed',attemptId:refund.attempt.id,amountMinor:cash,reference:'FUNDED-CASH-REFUND',receiptFileId:'refundReceipt',paidAt:AT});
    const after=(await ok(api,'ops','GET',`/orders/${orderId}`)).order;
    const platformRefund=refund.settlement.feeMinor+delivery.platformCollectedMinor;
    assert.equal(after.platformRevenue.refundedMinor,platformRefund===0?0:-platformRefund);
    const ledger=await db.query("SELECT COALESCE(sum(amount_minor),0) AS amount FROM platform_revenue_adjustments WHERE order_id=$1 AND kind='refund'",[orderId]);
    assert.equal(Number(ledger.rows[0].amount),platformRefund===0?0:-platformRefund);
    // Returning all cash leaves only external GRIDGO funds, with revenue's funding cost preserved.
    const netDelivery=delivery.collectedMinor+delivery.fundedRiderMinor-refund.settlement.deliveryMinor;
    const netRider=delivery.riderCollectedMinor-(refund.settlement.deliveryMinor-refund.settlement.platformDeliveryMinor);
    const netPlatform=delivery.platformCollectedMinor-refund.settlement.platformDeliveryMinor;
    assert.equal(netDelivery,netRider+netPlatform);
    assert.equal(after.platformRevenue.collectedMinor+after.platformRevenue.refundedMinor,before.platformRevenue.collectedMinor-platformRefund);
  });
}
for (const [percent, amount, quantities] of [[100,20000,[1]],[75,20000,[1]],[75,21000,[10]],[100,50000,[1,1]]]) {
  test(`HTTP/SQL no-cash checkout has no invented transfer (${percent}%, ${quantities.length} shops, ${amount})`,{skip:!DB},async t=>{
    const {db,s,api}=await setup(t,{percent,amount}); const path=await cart(api,s,quantities);
    const {quote}=await ok(api,'client','GET',`${path}/quote`); assert.equal(quote.downpaymentMinor,0);
    const placed=await ok(api,'client','POST',`${path}/checkout`,{},201);
    const stored=await loadStore(db), orders=stored.orders.filter(o=>o.id!=='order');
    assert.equal(stored.voucherRedemptions.length,1); assert.equal(stored.vouchers[0].status,'used');
    for(const o of orders){
      assert.equal(o.state,'needs_qa'); assert.equal(o.payments.initial.method,'gridgo_voucher'); assert.equal(o.payments.initial.status,'confirmed');
      assert.equal(o.payments.initial.reference,null); assert.equal(o.payments.initial.proofFileId,null);
      assert.equal(o.fileCheck.status,'pending');
      if(percent===75 && amount===21000){assert.ok(o.totalMinor>0);assert.equal(o.payments.final_online.amountMinor,o.totalMinor);assert.equal(o.payments.final_online.status,'not_submitted');}
      assert.ok(collectedSupplierPrincipalMinor(o)>0);
      assert.equal(stored.files.find(f=>f.fileId==='receipt').references.length,0);
      await assert.rejects(db.query("UPDATE order_payments SET data=jsonb_set(data,'{reference}','\"FAKE\"') WHERE order_id=$1 AND code='initial'",[o.id]),{code:'23514'});
      const recon=await db.query('SELECT sum(amount_minor) AS cash,sum(gridgo_funded_minor) AS funding FROM order_payment_allocations WHERE order_id=$1',[o.id]);
      assert.equal(Number(recon.rows[0].cash),o.totalMinor); assert.equal(Number(recon.rows[0].funding),o.voucherDiscountMinor);
    }
    if(placed.basket){
      assert.equal(placed.basket.payment.method,'gridgo_voucher');
      assert.equal((await api('ops','POST',`/orders/${orders[0].id}/payments/initial/confirm`,{})).status,409);
      assert.equal((await api('ops','POST',`/baskets/${placed.basket.id}/payment/confirm`,{})).status,409);
    }
    const before=stored.orders.length;
    assert.equal((await api('client','POST',`${path}/checkout`,{})).status,409);
    assert.equal((await loadStore(db)).orders.length,before);
  });
}
for(const [clientCaused,expired,shopEntitlementMinor] of [[false,false,0],[true,false,0],[false,true,0],[false,false,400]]){
  test(`HTTP/SQL no-cash remedy is audited and restores only when allowed (fault=${clientCaused}, expired=${expired}, shop=${shopEntitlementMinor})`,{skip:!DB},async t=>{
    const {db,s,api}=await setup(t); const path=await cart(api,s);const placed=await ok(api,'client','POST',`${path}/checkout`,{},201);const orderId=placed.order.id;
    if(expired||shopEntitlementMinor) await mutate(db,s=>{
      if(expired)s.vouchers[0].expiresAt=new Date(Date.now()-1000).toISOString();
      if(shopEntitlementMinor){const o=s.orders.find(o=>o.id===orderId);o.state='production';o.timeline.push({at:AT,state:'production',by:'supplier'});}
    });
    const refund=await remedy(api,orderId,{clientCaused,shopEntitlementMinor});
    assert.equal(refund.status,'paid');assert.equal(refund.settlement.noCashSettlement,true);assert.equal(refund.payment,null);
    const stored=await loadStore(db), v=stored.vouchers[0],o=stored.orders.find(o=>o.id===orderId);
    assert.equal(v.status,clientCaused||expired?'used':'available');assert.equal(o.state,'cancelled');assert.equal(o.fileCheck.status,'cancelled');
    assert.equal(stored.refundAttempts.length,0);assert.equal(stored.refundPayments.length,0);assert.equal(stored.refundSettlements.length,1);
    assert.equal(stored.refundEvents.filter(e=>e.kind==='no_cash_settled').length,1);
    assert.equal(stored.auditLog.filter(a=>a.action==='refund.no_cash_settled').length,1);
    assert.ok(o.payoutMilestones.every(p=>p.status==='superseded'));
    if(shopEntitlementMinor)assert.equal(stored.refundSupplierPayouts[0].amountMinor,shopEntitlementMinor);
    assert.equal((await api('client','POST','/me/promotions/founding/claim',{})).body.error,'promotion_already_has_discount');
    assert.equal((await api('ops','POST',`/refund-requests/${refund.id}/payment-attempts`,{expectedVersion:refund.version,reason:'No transfer'})).status,409);
    await assert.rejects(db.query("UPDATE refund_requests SET status='approved' WHERE id=$1",[refund.id]),/no-cash remedy/);
  });
}
for(const clientCaused of [false,true])test(`mixed basket zero group remedy waits for the cash-group refund (fault=${clientCaused})`,{skip:!DB},async t=>{
  const {db,s,api}=await setup(t,{amount:32300,tinyFirstShop:true});const path=await cart(api,s,[1,10]);
  const placed=await ok(api,'client','POST',`${path}/checkout`,{payment:{method:'qr_manual',reference:'MIXED-ONE-CENT',proofFileId:'receipt'}},201);
  assert.equal(placed.basket.totalMinor,1);
  let stored=await loadStore(db), orders=stored.orders.filter(o=>o.id!=='order');
  assert.equal(orders.filter(o=>o.totalMinor===0).length,1);
  assert.ok(orders.every(o=>o.state==='initial_payment_review'));assert.equal(stored.vouchers[0].status,'available');
  await ok(api,'ops','POST',`/baskets/${placed.basket.id}/payment/confirm`,{});
  const zero=orders.find(o=>!o.totalMinor),cash=orders.find(o=>o.totalMinor);
  await remedy(api,zero.id,{clientCaused});
  assert.equal((await loadStore(db)).vouchers[0].status,'used');
  let refund=await remedy(api,cash.id,{totalMinor:1,cashDestination:true});
  ({refund}=await ok(api,'ops','POST',`/refund-requests/${refund.id}/payment-attempts`,{expectedVersion:refund.version,reason:'Return one centavo',destinationVerified:true,destinationRevision:1,provider:'gcash',sourceWallet:'ops-main'}));
  await ok(api,'ops','POST',`/refund-requests/${refund.id}/payments`,{expectedVersion:refund.version,reason:'Transfer completed',attemptId:refund.attempt.id,amountMinor:1,reference:`MIXED-REFUND-${clientCaused}`,receiptFileId:'refundReceipt',paidAt:AT});
  stored=await loadStore(db);assert.equal(stored.vouchers[0].status,clientCaused?'used':'available');
  assert.equal(stored.refundPayments.length,1);assert.equal(stored.refundPayments[0].amountMinor,1);
});
test('SQL friend attribution backstop and deferred HTTP matching keep the first invite after email changes',{skip:!DB},async t=>{
  const {db,api}=await setup(t);
  await mutate(db,s=>{claimFounding(s,'other',{id,at:AT});inviteFriend(s,'client','future-a@example.invalid',{id,at:AT});inviteFriend(s,'other','future-b@example.invalid',{id,at:AT});});
  // Existing unrelated client identity adopts the two formerly unknown emails in sequence.
  await mutate(db,s=>{const u=s.users.find(u=>u.id==='rider');s.userRoleMemberships.push({userId:u.id,role:'client',createdAt:AT});s.clientProfiles.push({userId:u.id,clientKind:'personal',updatedAt:AT});u.email='future-a@example.invalid';});
  await ok(api,'rider','GET','/auth/me/client');
  let stored=await loadStore(db), first=stored.promotionInvites.find(i=>i.clientId==='rider');assert.ok(first);
  await ok(api,'rider','POST','/me/promotions/friend-pass/claim',{});
  await mutate(db,s=>{s.users.find(u=>u.id==='rider').email='future-b@example.invalid';});
  await ok(api,'rider','GET','/auth/me/client');
  stored=await loadStore(db);const second=stored.promotionInvites.find(i=>i.id!==first.id);
  assert.equal(second.clientId,null);assert.equal(second.unmatchedReason,'account_already_attributed');
  assert.equal(stored.vouchers.filter(v=>v.clientId==='rider').length,1);
  await assert.rejects(db.query('UPDATE promotion_invites SET client_id=$1 WHERE id=$2',['rider',second.id]),{code:'23505'});
});

for(const [percent, finalPaid] of [[100,true],[75,false],[75,true]]) for(const higher of [true,false]) {
  test(`HTTP funded pin ${higher?'surcharge':'credit'} reconciles once (${percent}%, final paid=${finalPaid})`,{skip:!DB},async t=>{
    const {db,s,api}=await setup(t,{percent,amount:6000,far:!higher,riderRate:percent===100 && higher?8001:8500});const path=await cart(api,s,[10]);
    const placed=await ok(api,'client','POST',`${path}/checkout`,{payment:{method:'qr_manual',reference:'BASE-COLLECTION',proofFileId:'receipt'}},201);
    const orderId=placed.order.id;
    await ok(api,'ops','POST',`/orders/${orderId}/payments/initial/confirm`,{});
    if(percent===75 && finalPaid){
      await ok(api,'client','POST',`/orders/${orderId}/payments/final_online/submit`,{method:'qr_manual',reference:'FINAL-COLLECTION',proofFileId:'finalProof'});
      await ok(api,'ops','POST',`/orders/${orderId}/payments/final_online/confirm`,{});
    }
    await mutate(db,s=>{const o=s.orders.find(o=>o.id===orderId);o.state='production';requestDeliveryPin(s,o,{at:AT,id,audit,user:s.users.find(u=>u.id==='supplier')});});
    const before=(await ok(api,'ops','GET',`/orders/${orderId}`)).order;
    const point={lat:7.06+(higher?8:1.5)/111.195,lng:125.6,label:'Changed pin'};
    const pin=(await ok(api,'client','GET',`/orders/${orderId}/delivery-pin`)).deliveryPin;
    const {preview}=await ok(api,'client','POST',`/orders/${orderId}/delivery-pin/preview`,{point});
    let changed=(await ok(api,'client','POST',`/orders/${orderId}/delivery-pin/change`,{expectedVersion:pin.version,point,feeDifferenceMinor:preview.feeDifferenceMinor,acknowledgeOneChange:true})).deliveryPin;
    if(higher){
      changed=(await ok(api,'client','POST',`/orders/${orderId}/delivery-pin/payment`,{expectedVersion:changed.version,proofFileId:'pinProof',reference:'PIN-COLLECTION'})).deliveryPin;
      await ok(api,'ops','POST',`/orders/${orderId}/delivery-pin/payment/confirm`,{expectedVersion:changed.version,amountMinor:preview.feeDifferenceMinor,reason:'Transfer verified'});
    }
    const after=(await ok(api,'ops','GET',`/orders/${orderId}`)).order, d=after.deliverySettlement;
    assert.equal(d.collectedMinor+d.fundedRiderMinor,d.riderCollectedMinor+d.platformCollectedMinor);
    const stored=await loadStore(db), o=stored.orders.find(o=>o.id===orderId);
    const extra=higher?o.deliveryPin.change.riderDifferenceMinor:0;
    assert.equal(d.riderCollectedMinor,before.deliverySettlement.riderCollectedMinor+extra);
    assert.equal(stored.deliveryPinPayments.length,higher?1:0);
    assert.equal(stored.refundSettlements.filter(r=>r.orderId===orderId).length,higher?0:1);
    assert.equal(o.deliveryPin.change.status,'applied');assert.equal(o.voucherDiscountMinor,6000);
  });
}
