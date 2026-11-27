import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,id,actors} from './fixtures/reschedule.js';
import {recordMissedOffer,shopJobPerformance} from '../src/shop-job-policy.js';
import {routeShopStatus,myShopStatus} from '../src/shop-status.js';
import {supplierMatchBlockersFor} from '../src/supplier-eligibility.js';
import {pingPrinterDemand} from '../src/printer-demand.js';
const AT='2026-11-23T02:00:00.000Z';
const at=n=>new Date(Date.parse(AT)+n*60000).toISOString();
function setup() {const s=fixture();s.orders=[];return s;}
function offer(s,n,status='timed_out') {
 const o={id:`offer-${n}`,supplierId:'supplier',orderType:'express',expressOrder:{acceptFlow:2},shopAcceptance:{supplierId:'supplier',assignedAt:at(n),deadlineAt:at(n+1),status}};
 s.orders.push(o);return o;
}
const status=(s,body,when=at(10),user=actors.supplier)=>routeShopStatus({req:{method:'PATCH'},url:new URL('http://api.test/me/shop-status'),store:s,user,readBody:async()=>body,now:()=>when,id,audit:(s,e)=>s.auditLog.push(e)});
test('three consecutive missed offers pause new work once, with each miss notifying shop and every administrator',()=>{
 const s=setup(),p=s.supplierProfiles[0];
 for(let n=1;n<=3;n++){const o=offer(s,n);recordMissedOffer(s,o,{at:at(n+1),id});recordMissedOffer(s,o,{at:at(n+1),id});}
 assert.equal(p.availability.missedJobPause.active,true);
 assert.equal(s.notifications.filter(n=>n.userId==='supplier'&&n.type==='shop_missed_job').length,3);
 for(const userId of ['ops','admin'])assert.equal(s.notifications.filter(n=>n.userId===userId&&n.type==='shop_missed_job').length,3);
 assert.ok(supplierMatchBlockersFor(s,at(10))('supplier',p).includes('shop_missed_jobs'));
 assert.equal(shopJobPerformance(s,'supplier',at(10)).acceptance.rate,0);
 assert.equal(shopJobPerformance(s,'supplier',at(10)).missedToday.length,3);
});
test('accepts and declines break the streak; review offers never count',()=>{
 const s=setup();offer(s,1);offer(s,2,'declined');const third=offer(s,3);recordMissedOffer(s,third,{at:at(4),id});
 assert.equal(shopJobPerformance(s,'supplier',at(4)).consecutiveMisses,1);
 const review=offer(s,4);review.reviewData=true;recordMissedOffer(s,review,{at:at(5),id});
 assert.equal(s.notifications.filter(n=>n.type==='shop_missed_job'&&n.userId==='supplier').length,1);
});
test('owner resumes or stays closed until Manila midnight; unrelated money hold survives resume',async()=>{
 const s=setup(),p=s.supplierProfiles[0];for(let n=1;n<=3;n++)recordMissedOffer(s,offer(s,n),{at:at(n+1),id});
 s.shopMoneyEvents=[{id:'due',kind:'pay_request',supplierId:'supplier',data:{amountMinor:1,deadlineAt:AT}}];
 await assert.rejects(status(s,{expectedVersion:p.version||1,missedJobs:'resume'},at(10),{...actors.supplier,shopRole:'staff'}),e=>e.status===403);
 await status(s,{expectedVersion:p.version||1,missedJobs:'resume'});
 assert.equal(p.availability.missedJobPause.active,false);
 assert.equal(shopJobPerformance(s,'supplier',at(10)).consecutiveMisses,0);
 assert.ok(supplierMatchBlockersFor(s,at(10))('supplier',p).includes('shop_payment_overdue'));
 await status(s,{expectedVersion:p.version,missedJobs:'closed_today'});
 assert.equal(p.availability.pausedUntil,'2026-11-23T16:00:00.000Z');
});
test('demand includes closed shops day or night, limits two per Manila day, deduplicates clients and supports mute',async()=>{
 const s=setup(),p=s.supplierProfiles[0];p.isClosed=true;
 for(const service of s.supplierServices)Object.assign(service,{categoryCode:'document_publication'});
 for(const item of s.catalogItems)Object.assign(item,{express:true,pricingUnit:'per_page',subcategoryCode:'document_printing'});
 const body={location:p.shop};
 for(let n=1;n<=4;n++)pingPrinterDemand(s,{...actors.client,id:`client-${n}`},body,{at:at(n),id});
 assert.equal(s.notifications.filter(n=>n.type==='printer_demand'&&n.userId==='supplier').length,2);
 await status(s,{expectedVersion:p.version||1,printerDemandPings:false});
 pingPrinterDemand(s,actors.client,body,{at:'2026-11-23T17:00:00.000Z',id});
 assert.equal(s.notifications.filter(n=>n.type==='printer_demand'&&n.userId==='supplier').length,2);
 await status(s,{expectedVersion:p.version,printerDemandPings:true,openFor:30});
 assert.equal(p.isClosed,false);assert.equal(p.availability.openUntil,at(40));
 assert.equal(myShopStatus(s,p,at(20)).isOpenNow,true);
 await status(s,{expectedVersion:p.version,openFor:'midnight'});
 assert.equal(p.availability.openUntil,'2026-11-23T16:00:00.000Z');
});

test('temporary opening expires exactly and modern demand delivery survives closure but honors mute',async()=>{
 const {deviceAcceptsNotification}=await import('../src/push-outbox.js');
 const s=setup(),p=s.supplierProfiles[0];p.isClosed=true;
 const n={id:'demand-example',type:'printer_demand',demandVersion:2,userId:'supplier',shopId:'supplier',appRole:'supplier',expiresAt:'2026-11-23T16:00:00.000Z'};
 assert.equal(deviceAcceptsNotification(s,{userId:'supplier',appRole:'supplier'},n,AT),true);
 await status(s,{expectedVersion:p.version||1,openFor:30});
 assert.equal(myShopStatus(s,p,at(39)).isOpenNow,true);
 assert.equal(myShopStatus(s,p,at(40)).isOpenNow,false);
 p.availability.printerDemandPings=false;
 assert.equal(deviceAcceptsNotification(s,{userId:'supplier',appRole:'supplier'},n,AT),false);
});
