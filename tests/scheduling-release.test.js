import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, caller } from './fixtures/scheduling.js';
import { deadlineDays, matchShop, projectShopFinish } from '../src/order-match.js';
import { fitsDeadline } from '../src/availability.js';

const now = '2026-10-19T01:00:00.000Z'; // Monday 09:00 Manila
function listing(store, min = 40, max = 80) {
  store.catalogItems.splice(1);
  Object.assign(store.catalogItems[0], { turnaroundMode: 'override', turnaroundHours: max, minimumTurnaroundHours: min });
}
test('calendar starts at shortest production time and becomes secured at longest, independent of shop count', () => {
  const { store } = fixture(); listing(store);
  const result = deadlineDays(store, { subcategoryCode: 'flyers', now, days: 15 });
  assert.equal(result.days.find(d => d.day === '2026-10-23').status, 'tight');
  assert.equal(result.days.find(d => d.day === '2026-10-28').status, 'secured');
  assert.equal(result.days.find(d => d.day === '2026-10-25').reason, 'gridgo_closed_sunday');
  const match = matchShop(store, { ranking: ['speed','quality','cost','distance'], subcategoryCode: 'flyers', now, deadline: '2026-10-23T10:00:00Z' });
  assert.equal(match.listings[0].scheduling.status, 'tight');
  assert.equal(match.listings[0].scheduling.tightDeadline, true);
});
test('Express cannot bypass production, Sunday, the cutoff, or a passed clock time', () => {
  const { store } = fixture({ express: true }); listing(store, 1, 1);
  for (const [at, deadline] of [
    ['2026-10-18T13:00:00Z','2026-10-18T15:00:00Z'],
    ['2026-10-19T08:00:00Z','2026-10-19T10:00:00Z'],
    ['2026-10-19T01:00:00Z','2026-10-19T00:30:00Z'],
  ]) assert.throws(() => matchShop(store, { ranking: ['speed','quality','cost','distance'], subcategoryCode: 'flyers', now: at, deadline }), e => e.code === 'deadline_not_met');
  const p = projectShopFinish(store, {supplierId:'shop_a', turnaroundHours:30, now, express:true, deadline:'2026-10-19T10:00:00Z'}).projection;
  assert.equal(fitsDeadline(p, '2026-10-19T10:00:00Z'), false);
});
test('same-day review is 30 minutes and ready time includes delivery; cutoff rolls dispatch forward', () => {
  const { store } = fixture(); listing(store, 1, 1);
  const result = deadlineDays(store, { subcategoryCode: 'flyers', now, days: 3 });
  assert.equal(result.days[0].readyBy, '2026-10-19T03:30:00.000Z');
  assert.equal(result.days[0].status, 'secured');
  const late = projectShopFinish(store, {supplierId:'shop_a', turnaroundHours:1, now:'2026-10-19T06:00:00Z'}).projection;
  assert.equal(late.promiseBy, '2026-10-20T00:00:00.000Z');
});
test('a listed faster tier exposes rush and its price, and selection charges that tier through checkout', async () => {
  const { store, client } = fixture(); listing(store, 40, 80);
  store.catalogSpeedTiers = [{id:'tier_fast',catalogItemId:'item_shop_a', label:'Fast',turnaroundHours:1,priceMinor:12000,surchargeMinor:null}];
  const day = deadlineDays(store, {subcategoryCode:'flyers',now,days:2}).days[0];
  assert.equal(day.status, 'rush');
  assert.equal(day.rushTier.id, 'tier_fast');
  const call = caller(store,client,now);
  const matched = await call('POST','/me/matches',{subcategoryCode:'flyers',fulfillmentMode:'pickup',deadline:'2026-10-19T10:00:00Z'});
  assert.equal(matched.body.listings[0].scheduling.rushTier.priceMinor,12000);
  const cartId = (await call('POST','/me/carts',{fulfillmentMode:'pickup'})).body.cart.id;
  const added = await call('POST',`/me/carts/${cartId}/lines`,{selectToken:matched.body.listings[0].selectToken, matchRequestId:matched.body.matchRequestId,optionIds:[],quantity:2,artworkFileId:'file_art'});
  assert.equal(added.body.cart.lines[0].speedTierId,'tier_fast');
  const checkout = await call('POST',`/me/carts/${cartId}/checkout`,{payment:{method:'qr_manual',proofFileId:'file_qr',reference:'RUSH'}});
  assert.equal(checkout.status,201);
  assert.equal(store.orderLineItems[0].lineSubtotalMinor,24000);
  assert.equal(store.orders[0].scheduling.sameDay,true);
});

test('one shop reaching its maximum makes a date secured even when another shop is still tight', () => {
  const { store } = fixture();
  Object.assign(store.catalogItems[0], { turnaroundMode:'override', turnaroundHours:80,minimumTurnaroundHours:40 });
  Object.assign(store.catalogItems[1], { turnaroundMode:'override', turnaroundHours:40,minimumTurnaroundHours:20 });
  const days = deadlineDays(store,{subcategoryCode:'flyers',now,days:10}).days;
  assert.equal(days.find(d=>d.day==='2026-10-21').status,'tight');
  assert.equal(days.find(d=>d.day==='2026-10-23').status,'secured');
});
test('shop hours and dated GRIDGO closures delay even an Express estimate, with no fees', () => {
  const {store}=fixture({express:true}); listing(store,1,1);
  store.supplierProfiles[0].schedule={utcOffsetMinutes:480,week:[1,2,3,4,5,6].map(weekday=>({weekday,opensMinute:780,closesMinute:1020})),closures:[{startDay:'2026-10-19',endDay:'2026-10-19'}]};
  store.settings.operatingHours.schedule.closures=[{startDay:'2026-10-20',endDay:'2026-10-20'}];
  const result = deadlineDays(store,{subcategoryCode:'flyers',now,days:4});
  assert.equal(result.days[0].status,'not_possible');
  assert.equal(result.days[1].reason,'gridgo_closed');
  assert.equal(result.earliest,'2026-10-21T01:00:00.000Z');
});
test('calendar earliest survives a requested display horizon shorter than production', () => {
  const {store}=fixture();listing(store);
  assert.equal(deadlineDays(store,{subcategoryCode:'flyers',now,days:1}).earliest,'2026-10-23T03:00:00.000Z');
});
test('Tight checkout snapshots the warning and shortest duration while supplier projection hides client timing', async () => {
  const {store,client}=fixture();listing(store);
  const call=caller(store,client,now);
  const matched=await call('POST','/me/matches',{subcategoryCode:'flyers',fulfillmentMode:'pickup',deadline:'2026-10-23T10:00:00Z'});
  const cartId=(await call('POST','/me/carts',{fulfillmentMode:'pickup'})).body.cart.id;
  await call('POST',`/me/carts/${cartId}/lines`,{selectToken:matched.body.listings[0].selectToken,matchRequestId:matched.body.matchRequestId,optionIds:[],quantity:1,artworkFileId:'file_art'});
  const checked=await call('POST',`/me/carts/${cartId}/checkout`,{payment:{method:'qr_manual',proofFileId:'file_qr',reference:'TIGHT'}});
  assert.equal(checked.body.order.scheduling.tightDeadline,true);
  assert.equal(store.orderLineItems[0].turnaroundMinutesSnapshot,2400);
  const {publicOrderFor}=await import('../src/operational-model.js');
  const projected=publicOrderFor(store.orders[0],{id:'shop_a',role:'supplier'},store);
  assert.equal(projected.scheduling.label,'Tight deadline');
  assert.equal(projected.scheduling.readyBy,undefined);
});

test('a removed speed tier leaves the cart readable for repair and cannot be checked out', async () => {
  const {store,client}=fixture();listing(store,40,80);
  store.catalogSpeedTiers=[{id:'fast',catalogItemId:'item_shop_a',label:'Fast',turnaroundHours:1,priceMinor:12000}];
  const call=caller(store,client,now),cartId=(await call('POST','/me/carts',{fulfillmentMode:'pickup'})).body.cart.id;
  await call('POST',`/me/carts/${cartId}/lines`,{catalogItemId:'item_shop_a',speedTierId:'fast',quantity:1,optionIds:[],artworkFileId:'file_art'});
  store.catalogSpeedTiers=[];
  const read=await call('GET',`/me/carts/${cartId}`);
  assert.equal(read.body.cart.groups[0].readyBy,null);
  await assert.rejects(call('POST',`/me/carts/${cartId}/checkout`,{payment:{method:'qr_manual',proofFileId:'file_qr',reference:'stale-tier'}}),e=>e.code==='speed_tier_unavailable');
});

test('dispatch cutoff is exclusive to the millisecond and closed-now today is never offered', () => {
  const {store}=fixture();listing(store,1,1);
  const input={supplierId:'shop_a',turnaroundHours:1};
  assert.equal(projectShopFinish(store,{...input,now:'2026-10-19T05:29:59.999Z'}).projection.promiseBy,'2026-10-19T07:59:59.999Z');
  assert.equal(projectShopFinish(store,{...input,now:'2026-10-19T05:30:00.000Z'}).projection.promiseBy,'2026-10-20T00:00:00.000Z');
  assert.equal(deadlineDays(store,{subcategoryCode:'flyers',now:'2026-10-19T08:00:00Z',days:1}).days[0].reason,'after_dispatch_cutoff');
  assert.equal(deadlineDays(store,{subcategoryCode:'flyers',now:'2026-10-18T23:00:00Z',days:1}).days[0].reason,'outside_operating_hours');
});
