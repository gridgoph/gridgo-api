import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from '../src/database.js';
import {loadStore,saveStore} from '../src/postgres-store.js';
import {resetDatabase} from './fixtures/reset-database.js';
import {fixture,AT} from './fixtures/reschedule.js';
import {defaultTaxonomy} from '../src/taxonomy.js';
import {parityApiForTest} from './fixtures/read-parity.js';
const skip=!process.env.DATABASE_URL;
const print=fileId=>({fileId,copies:1,pageRange:'1-3',paper:'a4',colour:'bw',sides:'one',layout:'fit_to_paper',acceptedWarnings:[]});
test('group HTTP transaction, reload, owned artwork, one payment, inbox and mixed-version preservation',{skip},async t=>{
 const db=createDatabase(process.env);t.after(()=>db.close());
 await resetDatabase(db,'TRUNCATE voucher_campaigns, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
 const store=fixture();for(const name of ['orders','orderJobs','orderLineItems','orderLineItemOptions','orderInvoices'])store[name]=[];
 store.taxonomy=defaultTaxonomy();
 for(const s of store.supplierServices)s.categoryCode='document_publication';
 for(const item of store.catalogItems)Object.assign(item,{subcategoryCode:'document_printing',express:true,pricingUnit:'per_page',printLayouts:['fit_to_paper']});
 for(const owner of ['client','other'])store.files.push({fileId:`art_${owner}`,ownerId:owner,purpose:'artwork',state:'ready',objectKey:`private/art_${owner}`,originalFilename:'document.pdf',declaredContentType:'application/pdf',detectedContentType:'application/pdf',size:100,createdAt:AT,detected:{pageCount:5},artworkCheck:{status:'passed'},references:[]});
 store.files.push({fileId:'proof',ownerId:'client',purpose:'payment_proof',state:'ready',objectKey:'private/proof',originalFilename:'payment.jpg',declaredContentType:'image/jpeg',detectedContentType:'image/jpeg',size:100,createdAt:AT,references:[]});
 await db.transaction(()=>saveStore(db,store));
 store.deviceTokens=['client','other'].map(userId=>({id:`device_${userId}`,userId,token:`group_token_${userId}:`+'x'.repeat(120),tokenProvider:'fcm',platform:'android',appRole:'client',createdAt:AT,updatedAt:AT}));
 await db.transaction(()=>saveStore(db,store));
 const api=await parityApiForTest(t,false,Date.parse(AT));
 assert.equal((await api(null,'POST','/express/groups',{})).status,401);
 const creations=await Promise.all([1,2].map(()=>api('client','POST','/express/groups',{fulfillmentMode:'delivery',location:{lat:7.06,lng:125.6},dropoff:{lat:7.07,lng:125.61,label:'Destination'},timeLimitMinutes:30})));
 assert.deepEqual(creations.map(r=>r.status).sort(),[201,409]);const made=creations.find(r=>r.status===201);
 assert.equal(made.status,201,JSON.stringify(made.body));const {id}=made.body.group,token=made.body.inviteToken;
 assert.equal((await api('other','POST',`/express/groups/invites/${token}/join`)).status,200);
 assert.equal((await api('other','POST','/express/groups',{fulfillmentMode:'pickup',location:{lat:7.06,lng:125.6}})).body.error,'group_already_open');
 assert.equal((await api('other','PUT',`/express/groups/${id}/files`,{files:[print('art_client')]})).status,409);
 let loaded=await loadStore(db);assert.equal(loaded.expressGroupMembers.find(m=>m.userId==='other').files.length,0,'refused mutation rolled back');
 for(const owner of ['client','other'])assert.equal((await api(owner,'PUT',`/express/groups/${id}/files`,{files:[print(`art_${owner}`)]})).status,200);
 assert.equal((await api('other','POST',`/express/groups/${id}/close`)).status,403);
 assert.equal((await api('client','POST',`/express/groups/${id}/close`)).status,200);
 assert.equal((await api('other','POST',`/express/groups/${id}/leave`)).status,409);
 const prepared=await api('client','POST',`/express/groups/${id}/prepare`,{});assert.equal(prepared.status,200,JSON.stringify(prepared.body));
 const rawCart=await api('client','GET',`/me/carts/${prepared.body.cartId}`);assert.equal(rawCart.status,200);assert.equal(JSON.stringify(rawCart.body).includes('art_other'),false);
 assert.equal((await api('other','POST',`/express/groups/${id}/checkout`,{})).status,403);
 const paid=await api('client','POST',`/express/groups/${id}/checkout`,{looksRight:true,expressConfirmation:prepared.body.confirmation,payment:{method:'qr_manual',reference:'GROUP-PAYMENT',proofFileId:'proof'}});
 assert.equal(paid.status,201,JSON.stringify(paid.body));const orderId=paid.body.orderId;
 loaded=await loadStore(db);const g=loaded.expressGroups[0],o=loaded.orders[0];
 assert.equal(g.orderId,orderId);assert.equal(loaded.orders.length,1);assert.equal(o.totalMinor,g.amounts.reduce((n,a)=>n+a.amountOwedMinor,0));assert.equal(o.totalMinor,prepared.body.quote.totalMinor);
 assert.equal((await api('other','GET',`/orders/${orderId}`)).status,403);
 const member=await api('other','GET',`/express/groups/${id}/tracking`);assert.equal(member.status,200);assert.equal(member.body.me.files[0].fileId,'art_other');assert.equal(JSON.stringify(member.body).includes('art_client'),false);
 const hostOrder=await api('client','GET',`/orders/${orderId}`);assert.equal(hostOrder.status,200);assert.equal(JSON.stringify(hostOrder.body).includes('art_other'),false);
 assert.equal((await api('client','GET','/files/art_other/download-url')).status,403);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM notification_push_outbox o JOIN notifications n ON n.id=o.notification_id WHERE n.user_id='other' AND n.type='group_updates'")).rows[0].n,1,'one group push enqueue in the frozen minute');
 assert.equal(JSON.stringify((await db.query('SELECT data FROM express_groups')).rows).includes(token),false);
 const inbox=await api('other','GET','/notifications');assert.equal(inbox.status,200);assert.ok(inbox.body.notifications.some(n=>n.groupId===id&&n.type==='group_placed'));
 // Pre-existing column upserts remain valid and preserve additive group rows.
 await db.transaction(()=>db.query(`INSERT INTO client_carts(id,client_id,state,version,service_level,fulfillment_mode,created_at,updated_at)
   VALUES('legacy_cart','client','draft',1,'standard','pickup',$1,$1)
   ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`,[AT]));
 assert.equal((await db.query('SELECT count(*)::int AS n FROM express_groups')).rows[0].n,1);
 // The assigned rider gets only a locked backup descriptor, then server arrival unlocks it.
 await db.transaction(async()=>{
   const latest=await loadStore(db),order=latest.orders.find(row=>row.id===orderId);
   const assigned=new Date(Date.parse(AT)-10*60000).toISOString();
   order.riderId='rider';order.state='out_for_delivery';
   order.timeline.push({state:'rider_assigned',at:assigned},{state:'picked_up',at:new Date(Date.parse(AT)-60000).toISOString()});
   order.groupOrder.backupReceiver={name:'Receiver',phone:'09123456789'};
   order.riderProgress={riderId:'rider',assignedAt:assigned,events:{arrived:AT}};
   order.handover={version:1,otp:'123456',createdAt:AT};
   await saveStore(db,latest);
 });
 assert.equal((await api('other','GET',`/dispatch/${orderId}/group-backup`)).status,403);
 assert.deepEqual((await api('rider','GET',`/dispatch/${orderId}/group-backup`)).body.backup,{unlocked:false});
 assert.equal((await api('other','GET',`/express/groups/${id}/tracking`)).body.deliveryCode,undefined);
 assert.equal((await api('client','GET',`/express/groups/${id}/tracking`)).body.deliveryCode,'123456');
 await db.transaction(async()=>{const latest=await loadStore(db);latest.orders[0].riderProgress.events.arrived=new Date(Date.parse(AT)-5*60000).toISOString();await saveStore(db,latest);});
 const backup=await api('rider','GET',`/dispatch/${orderId}/group-backup`);assert.equal(backup.body.backup.unlocked,true);assert.equal(backup.body.backup.receiver.name,'Receiver');
 assert.equal((await api('rider','POST',`/dispatch/${orderId}/group-arrival-estimate`,{minutes:7})).status,200);
 assert.equal((await api('other','GET',`/express/groups/${id}/tracking`)).body.estimatedArrivalAt,new Date(Date.parse(AT)+7*60000).toISOString());

 // Staff removal hides the group graph too, without deleting its durable rows.
 await db.transaction(()=>db.query("INSERT INTO order_removals(order_id,removed_at,removed_by,reason) VALUES($1,$2,'admin','Fixture removal')",[orderId,AT]));
 assert.equal((await api('client','GET',`/express/groups/${id}`)).status,404);
 assert.equal((await api('other','GET',`/express/groups/${id}/tracking`)).status,404);
 assert.equal((await loadStore(db)).expressGroupMembers.length,0);

});
