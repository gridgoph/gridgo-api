import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from '../src/database.js';
import {loadStore,saveStore} from '../src/postgres-store.js';
import {resetDatabase} from './fixtures/reset-database.js';
import {fixture,AT,id} from './fixtures/reschedule.js';
import {parityApiForTest} from './fixtures/read-parity.js';
import {defaultTaxonomy} from '../src/taxonomy.js';
import {startExpressAcceptance,expireExpressPayments} from '../src/express-orders.js';
const skip=!process.env.DATABASE_URL;
const supplier={headers:{'X-GRIDGO-Role':'supplier'}};
const ok=response=>{assert.ok(response.status>=200&&response.status<300,JSON.stringify(response.body));return response.body;};
async function setup(t,productType) {
 const db=createDatabase(process.env);t.after(()=>db.close());
 await resetDatabase(db,'TRUNCATE voucher_campaigns, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
 const store=fixture();store.taxonomy=defaultTaxonomy();
 for(const key of ['orders','orderJobs','orderLineItems','orderLineItemOptions','orderInvoices','catalogOptionGroups','catalogOptions'])store[key]=[];
 for(const item of store.catalogItems) {
  Object.assign(item,{subcategoryCode:productType==='plans'?'blueprint_cad_plotting':'document_printing',express:true,
   pricingUnit:productType==='plans'?'per_unit':'per_page',printLayouts:['fit_to_paper'],basePriceMinor:6500});
  store.catalogOptionGroups.push({id:`size_${item.id}`,catalogItemId:item.id,name:'Size',kind:'spec',required:true,sortOrder:0,version:1,createdAt:AT,updatedAt:AT});
  store.catalogOptions.push({id:`paper_${item.id}`,optionGroupId:`size_${item.id}`,label:productType==='plans'?'A2':'A3',
   specBinding:{fieldCode:'size',value:productType==='plans'?'A2':'A3'},active:true,priceModifierMinor:0,sortOrder:0,version:1,createdAt:AT,updatedAt:AT});
 }
 for(const service of store.supplierServices)Object.assign(service,{categoryCode:productType==='plans'?'specialized_prototyping':'document_publication',turnaroundHours:1,standardTurnaroundHours:1});
 store.files.push({fileId:'choice_art',ownerId:'client',purpose:'artwork',state:'ready',objectKey:'choice/art.pdf',declaredContentType:'application/pdf',detectedContentType:'application/pdf',originalFilename:'art.pdf',size:100,createdAt:AT,detected:{pageCount:2},artworkCheck:{status:'passed'},references:[]},
 {fileId:'choice_payment',ownerId:'client',purpose:'payment_proof',state:'ready',objectKey:'choice/payment.png',declaredContentType:'image/png',detectedContentType:'image/png',originalFilename:'payment.png',size:100,createdAt:AT,references:[]});
 await db.transaction(()=>saveStore(db,store));
 const api=await parityApiForTest(t,false,Date.parse(AT),{onOutput:chunk=>{if(/error|constraint|Error/.test(chunk))process.stderr.write(chunk);}});
 const request={productType:productType==='plans'?'plans':'documents',location:{lat:7.06,lng:125.6},fulfillmentMode:'pickup',files:[{fileId:'choice_art',copies:2,colour:'bw',paper:productType==='plans'?'a2':'a3',sides:'one',layout:'fit_to_paper',acceptedWarnings:[]}]};
 return {db,api,request};
}
for(const productType of ['a3','plans'])test(`${productType}: printer quotes persist no drafts; pick, accept, timely submit and confirm keep original price`,{skip},async t=>{
 const {db,api,request}=await setup(t,productType);
 assert.equal((await api(null,'POST','/express/shops',request)).status,401);
 assert.equal((await api('supplier','POST','/express/shops',request,supplier)).status,403);
 const list=ok(await api('client','POST','/express/shops',{...request,sort:'lowest_price'}));
 assert.ok(list.shops.length>=2);assert.equal(list.shops[0].paymentTiming,'after_acceptance');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM client_carts')).rows[0].n,0);
 const draft=ok(await api('client','POST','/express/drafts',{...request,supplierId:'supplier'}));
 // Draft reload/checkout proves per-sheet plan metadata survives the adapter.
 const placed=ok(await api('client','POST',`/me/carts/${draft.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.confirmation}));
 const orderId=placed.order.id,path=`/orders/${orderId}`;
 let loaded=await loadStore(db),order=loaded.orders.find(o=>o.id===orderId);
 assert.equal(order.supplierSubtotalMinor,26000);
 if(productType==='plans') {
  assert.equal(loaded.orderLineItems.find(line=>line.orderId===orderId).quantity,4);
  assert.equal(order.expressOrder.printSettings[0].copies,2);
 }
 const originalMoney=order.totalMinor;
 order.state='supplier_assigned';order.fileCheck={status:'passed'};startExpressAcceptance(order,AT);
 await db.transaction(()=>saveStore(db,loaded));
 const accepted=ok(await api('supplier','POST',`${path}/express/accept`,{},supplier));
 assert.equal(accepted.state,'awaiting_initial_payment');assert.equal(accepted.expressOrder.payBy,'2026-10-05T00:05:00.000Z');
 ok(await api('client','POST',`${path}/payments/initial/submit`,{method:'qr_manual',reference:'CHOICE',proofFileId:'choice_payment'}));
 // Evidence submitted within the window is not cancelled while awaiting review.
 loaded=await loadStore(db);order=loaded.orders.find(o=>o.id===orderId);
 assert.equal(expireExpressPayments(loaded,{at:new Date(Date.parse(order.expressOrder.payBy)+1).toISOString(),id}),false);
 ok(await api('ops','POST',`${path}/payments/initial/confirm`,{}));
 loaded=await loadStore(db);order=loaded.orders.find(o=>o.id===orderId);
 assert.equal(order.state,'payment_authorized');assert.equal(order.totalMinor,originalMoney);
 assert.equal(order.expressOrder.printerZone.key,'nearby');assert.equal(order.payments.initial.status,'confirmed');
});

test('late A3 evidence is refused; lifecycle expiry commits cancellation, audit, inbox and repick flag atomically',{skip},async t=>{
 const {db,api,request}=await setup(t,'a3');
 const draft=ok(await api('client','POST','/express/drafts',{...request,supplierId:'supplier'}));
 const placed=ok(await api('client','POST',`/me/carts/${draft.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.confirmation}));
 const orderId=placed.order.id;
 let loaded=await loadStore(db),order=loaded.orders.find(o=>o.id===orderId);
 Object.assign(order,{state:'awaiting_initial_payment',shopAcceptance:{status:'accepted',supplierId:'supplier',acceptedAt:AT}});
 order.expressOrder.payBy=AT;
 await db.transaction(()=>saveStore(db,loaded));
 const late=await api('client','POST',`/orders/${orderId}/payments/initial/submit`,{method:'qr_manual',reference:'LATE',proofFileId:'choice_payment'});
 assert.equal(late.status,409);assert.equal(late.body.error,'express_payment_expired');
 await db.transaction(async()=>{
  loaded=await loadStore(db);assert.equal(expireExpressPayments(loaded,{at:new Date().toISOString(),id}),true);await saveStore(db,loaded);
 });
 loaded=await loadStore(db);order=loaded.orders.find(o=>o.id===orderId);
 assert.equal(order.state,'cancelled');assert.equal(order.expressOrder.repickRequired,true);
 assert.equal(order.payments.initial.status,'not_submitted');
 assert.ok(loaded.orderJobs.filter(j=>j.orderId===orderId).every(j=>j.state==='cancelled'));
 assert.ok(loaded.auditLog.some(a=>a.orderId===orderId&&a.action==='express.payment_expired'));
 for(const userId of ['client','ops','admin'])assert.ok(loaded.notifications.some(n=>n.orderId===orderId&&n.userId===userId));
});

test('automatic selection permission round trips through PostgreSQL and refuses a later fare above the client cap',{skip},async t=>{
 const {db,api,request}=await setup(t,'a3');
 let store=await loadStore(db);
 for(const option of store.catalogOptions) {option.label='A4';option.specBinding={fieldCode:'size',value:'A4'};}
 await db.transaction(()=>saveStore(db,store));
 const body={...request,fulfillmentMode:'delivery',dropoff:{...request.location,label:'Destination'},files:request.files.map(file=>({...file,paper:'a4'})),selection:'just_print_it',fareLimit:'up_to_149'};
 const draft=ok(await api('client','POST','/express/drafts',body));
 store=await loadStore(db);
 assert.equal(store.cartLines.find(line=>line.cartId===draft.cartId).expressPrint.selection.fareLimit,'up_to_149');
 store.settings.deliveryFeeBands[0].feeMinor=15000;
 await db.transaction(()=>saveStore(db,store));
 const refused=await api('client','POST',`/me/carts/${draft.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.confirmation,payment:{method:'qr_manual',reference:'CAP',proofFileId:'choice_payment'}});
 assert.equal(refused.status,409);assert.equal(refused.body.error,'express_shop_unavailable');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n,0);
});
