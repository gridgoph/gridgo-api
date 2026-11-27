import test from 'node:test';
import assert from 'node:assert/strict';
import * as board from '../src/shop-leaderboard.js';
import { expressAcceptRate } from '../src/express-checkout-rules.js';

const AT = '2026-11-27T04:00:00.000Z';
const SENT = '2026-11-25T00:00:00.000Z';
const iso = value => new Date(value).toISOString();
function attempt(supplierId, n, status = 'accepted', options = {}) {
  const assignedAt = options.at || SENT;
  const answeredAt = iso(Date.parse(assignedAt) + 12000);
  return { id: `${supplierId}_${n}`, supplierId, clientId: 'client', orderType: 'express', state: status === 'accepted' ? 'completed' : 'cancelled',
    createdAt: assignedAt, readyBy: iso(Date.parse(assignedAt) + 3600000), readyAt: iso(Date.parse(assignedAt) + 3000000),
    shopAcceptance: { supplierId, assignedAt, deadlineAt: iso(Date.parse(assignedAt) + 60000), status, ...(status === 'accepted' ? { acceptedAt: answeredAt } : {}) },
    expressOrder: { acceptFlow: 2, events: [{ state: status, supplierId, at: status === 'timed_out' ? iso(Date.parse(assignedAt) + 60000) : answeredAt }] }, ...options };
}
function fixture() {
  const store = { settings: {}, users: [], supplierProfiles: [], orders: [], shopReviews: [], shopLeaderboardMonths: [], shopTopStickers: [] };
  for (const [supplierId, lat, home] of [['aster',7,false], ['birch',7.01,true], ['cedar',7.1,false]]) {
    store.users.push({ id: supplierId });
    store.supplierProfiles.push({ userId: supplierId, shopName: `${supplierId} print`, shop: { lat, lng: 125, label: 'Private counter' },
      ...(home ? { homePrinter: { barangay: 'Sample district' }, supplierType: 'home', barangay: 'Sample district' } : {}) });
    for (let n = 0; n < 5; n++) {
      const order = attempt(supplierId, n); store.orders.push(order);
      store.shopReviews.push({ id: `review_${order.id}`, orderId: order.id, supplierId, qualityStars: 5, createdAt: SENT });
    }
  }
  return store;
}

test('weighted score uses actual offers, quality stars and readiness; losses reduce acceptance', () => {
  const store = fixture(); store.orders.push(attempt('aster',5,'declined'), attempt('aster',6,'timed_out'), attempt('aster',7,'withdrawn'));
  const row = board.shopScore(store,'aster',board.leaderboardPeriod('month',AT),AT);
  assert.equal(row.acceptance.offered,7); assert.equal(row.acceptance.accepted,5);
  assert.equal(row.declines,1); assert.equal(row.missed,1); assert.equal(row.orderCount,5);
  assert.equal(row.parts.stars.value,5); assert.equal(row.parts.stars.weight,40);
  assert.equal(row.parts.onTime.value,100); assert.equal(row.parts.answerSpeed.value,Math.round((12*6+60)/7*100)/100);
  assert.equal(row.score,88.29);
  const common = expressAcceptRate(store,'aster',AT);
  assert.equal(common.rate,row.acceptance.rate);
});

test('Manila periods are Monday based and half-open across week, month and year boundaries', () => {
  assert.deepEqual(board.leaderboardPeriod('week','2026-11-29T16:00:00.000Z'),{ kind:'week',startAt:'2026-11-29T16:00:00.000Z',endAt:'2026-12-06T16:00:00.000Z' });
  assert.deepEqual(board.leaderboardPeriod('month','2026-12-31T16:00:00.000Z'),{ kind:'month',startAt:'2026-12-31T16:00:00.000Z',endAt:'2027-01-31T16:00:00.000Z' });
  const store=fixture();
  store.orders.push(attempt('aster',10,'declined',{at:'2026-10-31T15:59:59.999Z'}), attempt('aster',11,'declined',{at:'2026-11-30T16:00:00.000Z'}));
  assert.equal(board.shopScore(store,'aster',board.leaderboardPeriod('month',AT),AT).declines,0);
});

test('rank eligibility counts accepted orders, groups by radius and includes private home peers', () => {
  const store = fixture(); store.orders.push(attempt('aster',6,'declined'));
  const result = board.shopLeaderboard(store,'aster','month',AT);
  assert.deepEqual(result.rows.map(row=>row.supplierId),['birch','aster']);
  assert.equal(result.own.rank,2); assert.equal(result.own.gap.nextRank,1); assert.ok(result.own.gap.scorePoints>0);
  const home=result.rows[0]; assert.equal(home.printerType,'home'); assert.equal(home.name,'Sample district');
  assert.equal(JSON.stringify(result).includes('Private counter'),false); assert.equal(JSON.stringify(result).includes('"lat"'),false);
  store.orders=store.orders.filter(row=>row.id!=='aster_4');
  const under=board.shopLeaderboard(store,'aster','month',AT);
  assert.equal(under.own.rank,null); assert.equal(under.own.ordersToQualify,1); assert.equal(under.own.orderCount,4);
  assert.deepEqual(under.rows.map(row=>row.supplierId),['birch']);
});

test('missing evidence is not success; review, removed, future facts and out-of-period reviews do not inflate scores', () => {
  const store=fixture(); const period=board.leaderboardPeriod('month',AT);
  store.orders.find(row=>row.id==='aster_0').reviewData=true;
  store.orders.find(row=>row.id==='aster_1').removedAt=AT;
  store.shopReviews.find(row=>row.orderId==='aster_2').createdAt='2026-12-01T00:00:00.000Z';
  for(const order of store.orders.filter(row=>row.supplierId==='aster')){delete order.readyAt;order.readyBy='2026-11-26T00:00:00.000Z';}
  const row=board.shopScore(store,'aster',period,AT);
  assert.equal(row.orderCount,3);assert.equal(row.parts.stars.samples,2);assert.equal(row.parts.onTime.value,0);
  store.shopReviews=[];
  assert.equal(board.shopScore(store,'aster',period,AT).parts.stars.value,null);
});

test('expired unswept offers count as missed; pending and withdrawn offers never count', () => {
  const store=fixture();
  const pending=attempt('aster',6,'pending'); pending.state='supplier_assigned';store.orders.push(pending);
  const open=attempt('aster',7,'pending',{at:'2026-11-27T03:59:45.000Z'});open.state='supplier_assigned';store.orders.push(open,attempt('aster',8,'withdrawn'));
  const result=expressAcceptRate(store,'aster',AT);
  assert.equal(result.timedOut,1);assert.equal(result.offered,6);assert.equal(result.rate,0.8333);
});

test('settings merge partial weights and validate totals, bounds and types', () => {
  assert.deepEqual(board.leaderboardSettings({}),{weights:{stars:40,acceptance:30,onTime:20,answerSpeed:10},minimumOrders:5,radiusKm:5,monthlyTopCount:3});
  assert.equal(board.nextLeaderboardSettings({}, {weights:{stars:30,acceptance:40}}).weights.acceptance,40);
  for(const patch of [{weights:{stars:99}},{weights:{stars:'40'}},{weights:{bogus:0}},{minimumOrders:0},{radiusKm:0},{radiusKm:501},{monthlyTopCount:0},{monthlyTopCount:1.5},null,[],{unknown:true}]) {
    assert.throws(()=>board.nextLeaderboardSettings({},patch),error=>error.code==='invalid_shop_leaderboard_settings');
  }
});

test('closed monthly local winners are frozen, include home printers and expire after the next month', async () => {
  const monthly=await import('../src/shop-leaderboard-months.js');
  const store=fixture();store.settings.shopLeaderboard={monthlyTopCount:1};
  store.orders.push(attempt('aster',6,'declined'));
  const ctx={at:'2026-11-30T16:00:00.000Z',id:p=>`${p}_${Math.random()}`};
  assert.equal(monthly.closeLeaderboardMonth(store,ctx),true);
  assert.deepEqual(store.shopLeaderboardMonths[0].winners.map(row=>row.supplierId),['birch','cedar']);
  assert.equal(store.shopLeaderboardMonths[0].month,'2026-11');
  assert.equal(store.shopTopStickers.length,2);
  const badge=monthly.topShopBadge(store,'birch',ctx.at);
  assert.deepEqual(badge,{type:'top_shop',month:'2026-11',validFrom:'2026-11-30T16:00:00.000Z',validUntil:'2026-12-31T16:00:00.000Z'});
  assert.equal(monthly.topShopBadge(store,'aster',ctx.at),null);
  assert.equal(monthly.topShopBadge(store,'birch',AT),null);
  assert.equal(monthly.topShopBadge(store,'birch','2026-12-31T16:00:00.000Z'),null);
  const frozen=structuredClone(store.shopLeaderboardMonths);
  store.settings.shopLeaderboard={monthlyTopCount:3,weights:{stars:0,acceptance:100,onTime:0,answerSpeed:0}};
  store.shopReviews=[];store.orders=[];
  assert.equal(monthly.closeLeaderboardMonth(store,ctx),false);
  assert.deepEqual(store.shopLeaderboardMonths,frozen);assert.equal(store.shopTopStickers.length,2);
  assert.ok(store.notifications.some(row=>row.userId==='birch'));
  assert.ok(store.auditLog.some(row=>row.action==='shop_leaderboard.month_closed'));
});

test('empty months are closed once; client, rider and shop staff cannot read a board or sticker list', async () => {
  const monthly=await import('../src/shop-leaderboard-months.js');
  const routes=await import('../src/shop-leaderboard-routes.js');
  const store=fixture();store.orders=[];
  const ctx={at:'2026-11-30T16:00:00.000Z',id:p=>p};
  assert.equal(monthly.closeLeaderboardMonth(store,ctx),true);assert.equal(monthly.closeLeaderboardMonth(store,ctx),false);
  assert.deepEqual(store.shopLeaderboardMonths[0].winners,[]);
  for(const role of ['client','rider','ops_admin']) {
    await assert.rejects(routes.routeShopLeaderboard({req:{method:'GET'},url:new URL('http://test/me/shop-leaderboard'),store,user:{id:'aster',role},now:()=>AT}),e=>e.status===403);
  }
  for(const shopRole of ['staff','manager'])await assert.rejects(routes.routeShopLeaderboard({req:{method:'GET'},url:new URL('http://test/me/shop-leaderboard'),store,user:{id:'aster',role:'supplier',shopRole},now:()=>AT}),e=>e.status===403);
  for(const role of ['client','rider','supplier'])await assert.rejects(routes.routeShopLeaderboard({req:{method:'GET'},url:new URL('http://test/ops/top-shop-stickers'),store,user:{id:'aster',role},now:()=>AT}),e=>e.status===403);
});

test('Operations sticker list is scoped to the awarded month with audited, idempotent delivery', async () => {
  const monthly=await import('../src/shop-leaderboard-months.js');const routes=await import('../src/shop-leaderboard-routes.js');
  const store=fixture(),at='2026-11-30T16:00:00.000Z';
  monthly.closeLeaderboardMonth(store,{at,id:p=>p});
  const call=(role,method,path,body={})=>routes.routeShopLeaderboard({req:{method},url:new URL(`http://test${path}`),store,user:{id:'ops',role},now:()=>at,id:p=>p,readBody:async()=>body});
  const list=await call('ops_admin','GET','/ops/top-shop-stickers');
  assert.equal(list.body.month,'2026-11');assert.equal(list.body.stickers.length,3);assert.equal(list.body.stickers[0].status,'pending');
  assert.equal(JSON.stringify(list).includes('Private counter'),false);
  const path='/ops/top-shop-stickers/2026-11/aster/deliver';
  assert.equal((await call('ops_admin','POST',path,{reason:'Sticker handed to owner'})).mutated,true);
  assert.equal((await call('super_admin','POST',path,{reason:'Already delivered'})).mutated,false);
  assert.equal(store.shopTopStickers.find(row=>row.supplierId==='aster').deliveredBy,'ops');
  assert.equal(store.auditLog.filter(row=>row.action==='shop_leaderboard.sticker_delivered').length,1);
  await assert.rejects(call('ops_admin','GET','/ops/top-shop-stickers?month=2026-99'),e=>e.status===400);
});

test('monthly badges boost only Nearest aliases; closed shops and all other sort keys keep priority', async () => {
  const { expressPrinterOrder }=await import('../src/express-printers.js');
  const { nearestTopShopOrder }=await import('../src/shop-leaderboard-months.js');
  const store=fixture(),location=store.supplierProfiles[0].shop;
  const near={supplierId:'aster',selectable:true,readyAt:'2026-11-27T05:00:00Z',rating:{average:5},jobsAhead:0,price:{totalMinor:100},quote:{clientItemSubtotalMinor:100}};
  const winner={supplierId:'birch',selectable:true,topShopBadge:{month:'2026-10'},readyAt:'2026-11-27T06:00:00Z',rating:{average:4},jobsAhead:2,price:{totalMinor:200},quote:{clientItemSubtotalMinor:200}};
  for(const sort of ['nearest','nearby'])assert.deepEqual([near,winner].sort(expressPrinterOrder(store,location,sort)).map(row=>row.supplierId),['birch','aster']);
  for(const sort of ['all_davao','fastest','ready_soonest','top_rated','lowest_price','cheapest','fewest_jobs']) {
    assert.deepEqual([near,winner].sort(expressPrinterOrder(store,location,sort)).map(row=>row.supplierId),['aster','birch'],sort);
    assert.equal(nearestTopShopOrder(sort,near,winner),0);
  }
  winner.selectable=false;
  assert.equal([near,winner].sort(expressPrinterOrder(store,location,'nearest'))[0],near);
});

test('radius is inclusive, groups are centered per shop and ties use stable IDs', () => {
  const store=fixture();store.supplierProfiles.find(row=>row.userId==='cedar').shop.lat=7.06;
  store.supplierProfiles.find(row=>row.userId==='birch').shop.lat=7.02;
  const period=board.leaderboardPeriod('month',AT),policy=board.leaderboardSettings(store.settings);
  const scores=board.leaderboardScores(store,period,AT);
  assert.deepEqual(board.localLeaderboard(store,'aster',scores,policy).map(row=>row.supplierId),['aster','birch']);
  assert.deepEqual(board.localLeaderboard(store,'birch',scores,policy).map(row=>row.supplierId),['aster','birch','cedar']);
  const center=store.supplierProfiles.find(row=>row.userId==='aster').shop;
  const other=store.supplierProfiles.find(row=>row.userId==='birch').shop;
  // The shared distance helper supplies an exact boundary, avoiding geographic approximations.
  const radians=value=>value*Math.PI/180;
  const exact=6371000*2*Math.atan2(Math.sqrt(Math.sin(radians(other.lat-center.lat)/2)**2),Math.sqrt(1-Math.sin(radians(other.lat-center.lat)/2)**2));
  const radius={...policy,radiusKm:exact/1000};
  assert.equal(board.localLeaderboard(store,'aster',scores,radius).length,2);
  assert.equal(board.localLeaderboard(store,'aster',scores,{...radius,radiusKm:radius.radiusKm-0.00001}).length,1);
  store.settings.shopLeaderboard={radiusKm:7};
  assert.equal(board.shopLeaderboard(store,'aster','month',AT).rows.length,3);
});
