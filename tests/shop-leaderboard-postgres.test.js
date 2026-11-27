import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT, id } from './fixtures/reschedule.js';
import { defaultTaxonomy } from '../src/taxonomy.js';
import { parityApiForTest } from './fixtures/read-parity.js';
import { closeLeaderboardMonth, topShopBadge, leaderboardMonthDue } from '../src/shop-leaderboard-months.js';

const DB = { skip: !process.env.DATABASE_URL };
async function setup(t) {
  const db=createDatabase(process.env);t.after(()=>db.close());
  await resetDatabase(db,'TRUNCATE voucher_campaigns, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store=fixture();store.taxonomy=defaultTaxonomy();
  return {db,store};
}

test('monthly snapshots and sticker delivery persist atomically and cannot be rewritten',DB,async t=>{
  const {db,store}=await setup(t);
  const template=structuredClone(store.orders[0]);
  // Existing valid order money/lines stay intact. Additional attempts are clones
  // of its commercial facts, each with its own acceptance and tracking evidence.
  Object.assign(template,{orderType:'express',readyBy:'2026-09-30T01:00:00.000Z',readyAt:'2026-09-30T00:30:00.000Z',
    shopAcceptance:{supplierId:'supplier',assignedAt:'2026-09-30T00:00:00.000Z',deadlineAt:'2026-09-30T00:01:00.000Z',status:'accepted',acceptedAt:'2026-09-30T00:00:12.000Z'},
    expressOrder:{version:1,acceptFlow:2,originalSupplierId:'supplier',pickupCode:'012345',events:[]}});
  Object.assign(store.orders[0],template);
  for(let n=1;n<5;n++)store.orders.push({...structuredClone(template),id:`score_${n}`});
  await db.transaction(()=>saveStore(db,store));
  for(const order of store.orders)store.shopReviews.push({id:`review_${order.id}`,orderId:order.id,supplierId:'supplier',clientId:'client',qualityStars:5,speedStars:5,valueStars:5,createdAt:'2026-09-30T00:35:00.000Z'});
  await db.transaction(()=>saveStore(db,store));
  let loaded=await db.transaction(()=>loadStore(db));
  assert.equal(await leaderboardMonthDue(db,AT),true);
  await db.transaction(async()=>{
    assert.equal(closeLeaderboardMonth(loaded,{at:AT,id}),true);
    await saveStore(db,loaded);
  });
  assert.equal(await leaderboardMonthDue(db,AT),false);
  loaded=await db.transaction(()=>loadStore(db));
  const result=loaded.shopLeaderboardMonths.find(row=>row.month==='2026-09');
  assert.equal(result.winners.length,1);assert.equal(result.winners[0].supplierId,'supplier');assert.equal(result.winners[0].score,98);
  assert.equal(topShopBadge(loaded,'supplier',AT).month,'2026-09');
  assert.equal(loaded.shopTopStickers.length,1);assert.equal(closeLeaderboardMonth(loaded,{at:AT,id}),false);
  await assert.rejects(db.query("UPDATE shop_leaderboard_months SET data=jsonb_set(data,'{winners}','[]') WHERE month='2026-09'"),/monthly shop awards are immutable/);
  await assert.rejects(db.query("DELETE FROM shop_leaderboard_months WHERE month='2026-09'"),/monthly shop awards are immutable/);
  const api=await parityApiForTest(t,false,Date.parse(AT));
  assert.equal((await api('client','GET','/me/shop-leaderboard')).status,403);
  const own=await api('supplier','GET','/me/shop-leaderboard?period=month');
  assert.equal(own.status,200,JSON.stringify(own.body));assert.equal(own.body.own.orderCount,0);
  assert.equal((await api('supplier','GET','/me/shop-leaderboard?period=forever')).status,400);
  assert.equal((await api('client','GET','/ops/top-shop-stickers')).status,403);
  const tasks=await api('ops','GET','/ops/top-shop-stickers');
  assert.equal(tasks.status,200);assert.equal(tasks.body.stickers.length,1);
  assert.equal((await api('ops','POST','/ops/top-shop-stickers/2026-09/supplier/deliver',{reason:'Handed to owner'})).status,200);
  assert.equal((await api('ops','POST','/ops/top-shop-stickers/2026-09/supplier/deliver',{reason:'Already handed over'})).status,200);
  loaded=await db.transaction(()=>loadStore(db));
  assert.equal(loaded.shopTopStickers[0].deliveredBy,'ops');
  assert.equal(loaded.auditLog.filter(row=>row.action==='shop_leaderboard.sticker_delivered').length,1);
  await assert.rejects(db.query("UPDATE shop_top_stickers SET delivered_at=NULL,delivered_by=NULL"),/sticker award and delivery are immutable/);
  const before=(await db.query('SELECT count(*) AS n FROM shop_leaderboard_months')).rows[0].n;
  await assert.rejects(db.transaction(async()=>{
    const fresh=await loadStore(db);closeLeaderboardMonth(fresh,{at:'2026-11-01T00:00:00.000Z',id});await saveStore(db,fresh);throw new Error('rollback probe');
  }),/rollback probe/);
  assert.equal((await db.query('SELECT count(*) AS n FROM shop_leaderboard_months')).rows[0].n,before);
});

test('only Super Admin reads or changes validated leaderboard settings with version and audit',DB,async t=>{
  const {db,store}=await setup(t);await db.transaction(()=>saveStore(db,store));
  const api=await parityApiForTest(t,false,Date.parse(AT));
  const admin=await api('admin','GET','/settings');
  assert.equal(admin.body.settings.shopLeaderboard.minimumOrders,5);
  const version=admin.body.version;
  for(const role of ['client','supplier','rider','ops']) {
    assert.equal(Object.hasOwn((await api(role,'GET','/settings')).body.settings,'shopLeaderboard'),false);
    assert.equal((await api(role,'PATCH','/settings',{expectedVersion:version,reason:'Change ranking',shopLeaderboard:{minimumOrders:6}})).status,403);
  }
  for(const patch of [{weights:{stars:90}},{minimumOrders:0},{radiusKm:'5'},{monthlyTopCount:-1},{weights:{stars:20,acceptance:20,onTime:20,answerSpeed:20}}]) {
    const response=await api('admin','PATCH','/settings',{expectedVersion:version,reason:'Invalid policy',shopLeaderboard:patch});
    assert.equal(response.status,400,JSON.stringify(response.body));assert.equal(response.body.error,'invalid_shop_leaderboard_settings');
  }
  const changed=await api('admin','PATCH','/settings',{expectedVersion:version,reason:'Adjust local competition',expressLightColourMaxBps:1800,shopLeaderboard:{minimumOrders:6,radiusKm:3,monthlyTopCount:2,weights:{stars:30,acceptance:40}}});
  assert.equal(changed.status,200,JSON.stringify(changed.body));
  const loaded=await db.transaction(()=>loadStore(db));
  assert.equal(loaded.settings.expressLightColourMaxBps,1800);
  assert.equal(changed.body.version,version+1);
  assert.deepEqual(loaded.settings.shopLeaderboard,{weights:{stars:30,acceptance:40,onTime:20,answerSpeed:10},minimumOrders:6,radiusKm:3,monthlyTopCount:2});
  assert.ok(loaded.auditLog.some(row=>row.action==='settings.operational_update'));
  const colourOnly=await api('admin','PATCH','/settings',{expectedVersion:version+1,reason:'Adjust print detection',expressLightColourMaxBps:2200});
  assert.equal(colourOnly.status,200);
  const combined=await db.transaction(()=>loadStore(db));
  assert.equal(combined.settings.expressLightColourMaxBps,2200);
  assert.deepEqual(combined.settings.shopLeaderboard,loaded.settings.shopLeaderboard);
  const conflict=await api('admin','PATCH','/settings',{expectedVersion:version,reason:'Stale policy',shopLeaderboard:{minimumOrders:8}});
  assert.equal(conflict.status,409);assert.equal(conflict.body.error,'settings_version_conflict');
});
