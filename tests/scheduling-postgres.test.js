import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { caller } from './fixtures/scheduling.js';

for (const [priceMinor,surchargeMinor,total] of [[1500,null,3000],[null,175,2175]]) test(`selected tier (${priceMinor ?? 'surcharge'}) survives cart reload, checkout snapshots and SQL immutability`, {skip:!process.env.DATABASE_URL}, async t => {
  const db=createDatabase({DATABASE_URL:process.env.DATABASE_URL});t.after(()=>db.close());
  await resetDatabase(db,'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const initial=fixture();
  initial.settings.hubPickupEnabled=true;
  initial.catalogSpeedTiers=[{id:'fast',catalogItemId:'item_supplier',label:'Fast',turnaroundHours:1,turnaroundMinutes:60,
    priceMinor,surchargeMinor,sortOrder:0,createdAt:AT,updatedAt:AT}];
  for(const [fileId,purpose,type] of [['art','artwork','application/pdf'],['qr','payment_proof','image/png']]) initial.files.push({
    fileId,ownerId:'client',purpose,state:'ready',objectKey:`private/${fileId}`,originalFilename:fileId,
    declaredContentType:type,detectedContentType:type,size:100,createdAt:AT,
    ...(purpose==='artwork'?{artworkCheck:{status:'passed',checkedAt:AT}}:{})});
  await db.transaction(()=>saveStore(db,initial));
  let cartId;
  await db.transaction(async()=>{
    const store=await loadStore(db),call=caller(store,store.users.find(u=>u.id==='client'),AT);
    cartId=(await call('POST','/me/carts',{fulfillmentMode:'pickup'})).body.cart.id;
    await call('POST',`/me/carts/${cartId}/lines`,{catalogItemId:'item_supplier',speedTierId:'fast',quantity:2,optionIds:[],artworkFileId:'art'});
    await saveStore(db,store);
  });
  let orderId;
  await db.transaction(async()=>{
    const store=await loadStore(db);
    assert.equal(store.cartLines[0].speedTierId,'fast');
    const call=caller(store,store.users.find(u=>u.id==='client'),AT);
    const result=await call('POST',`/me/carts/${cartId}/checkout`,{payment:{method:'qr_manual',proofFileId:'qr',reference:'tier-persistence'}});
    orderId=result.body.order.id;
    await saveStore(db,store);
  });
  const stored=await loadStore(db),line=stored.orderLineItems.find(line=>line.orderId===orderId);
  assert.equal(line.speedTierSnapshot.id,'fast');
  assert.equal(line.lineSubtotalMinor,total);
  assert.equal(line.turnaroundMinutesSnapshot,60);
  assert.equal(stored.orders.find(order=>order.id===orderId).scheduling.sameDay,true);
  await assert.rejects(db.query('UPDATE order_line_items SET speed_tier_snapshot=$1 WHERE id=$2',[{},line.id]),/speed tier snapshots are immutable/);
});
