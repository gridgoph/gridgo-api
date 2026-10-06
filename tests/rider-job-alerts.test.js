import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyOrderParties } from '../src/client-order-notifications.js';
import { deriveDomainEvents } from '../src/domain-events.js';
import { enqueueNotificationPushes, deviceAcceptsNotification } from '../src/push-outbox.js';
import { pushMessageFor } from '../src/push.js';

function fixture() {
  const ids = ['idle', 'busy', 'pending', 'suspended', 'removed', 'no_device', 'other_app'];
  return {
    users: ids.map(id => ({id, role: 'client', accountStatus: id === 'removed' ? 'removed' : 'active'})),
    userRoleMemberships: ids.map(userId => ({userId, role: 'rider'})),
    approvalCases: ids.map(userId => ({userId, kind:'rider', status: ['pending','suspended'].includes(userId) ? userId : 'approved'})),
    orders: [
      {id:'job',state:'ready_for_dispatch',fulfillmentMode:'delivery',timeline:[]},
      {id:'trip',state:'rider_assigned',riderId:'busy'},
    ],
    deviceTokens: ids.filter(id => id !== 'no_device').map(userId => ({id:`device_${userId}`,userId,platform:'android',appRole:userId === 'other_app' ? 'client' : 'rider',token:'registered'})),
    notifications: [],
  };
}
let sequence = 0;
const options = {createId: () => `n${++sequence}`, at:'2026-10-06T00:00:00Z'};
const offers = s => s.notifications.filter(n => n.type === 'dispatch_available');

test('only approved idle riders with a claimed rider device enter the push outbox', async () => {
  const s = fixture();
  s.deviceTokens.push({id:'anonymous',userId:null,platform:'android'});
  notifyOrderParties(s, s.orders[0], options);
  assert.deepEqual(offers(s).map(n => n.userId), ['idle','no_device','other_app']);
  const queued = [];
  await enqueueNotificationPushes({query:async (_sql,args) => {queued.push(args);return {rowCount:1};}}, s, offers(s));
  assert.deepEqual(queued.map(row => row.slice(1)), [['device_idle','idle']]);
});

test('every active trip state excludes a rider; finished trips do not', () => {
  for (const state of ['rider_assigned','picked_up','out_for_delivery','delivered','awaiting_collection','completed','cancelled']) {
    const s=fixture();s.orders[1].state=state;
    notifyOrderParties(s,s.orders[0],options);
    assert.equal(offers(s).some(n=>n.userId==='busy'), !['rider_assigned','picked_up','out_for_delivery'].includes(state), state);
  }
});

test('a retry, real re-offer, or deleted inbox row never alerts the same rider twice', () => {
  const s=fixture();const job=s.orders[0];
  notifyOrderParties(s,job,options);
  offers(s)[0].deletedAt=options.at;
  job.timeline.push({state:'rider_assigned',at:options.at},{state:'ready_for_dispatch',at:'2026-10-06T01:00:00Z'});
  notifyOrderParties(s,job,options);
  assert.equal(offers(s).filter(n=>n.userId==='idle').length,1);
  // Migration-era occurrences also deduplicate against the new per-job key.
  offers(s)[0].occurrenceKey='legacy-occurrence';
  notifyOrderParties(s,job,options);
  assert.equal(offers(s).filter(n=>n.userId==='idle').length,1);
});

test('held, assigned, and contained pickup jobs are not offered; release of a hold alerts once', () => {
  for (const patch of [{riderId:'busy'},{shopRecovery:{status:'awaiting_client'}},{fulfillmentMode:'pickup',paymentPlan:'pickup_full_online'}]) {
    const s=fixture();Object.assign(s.orders[0],patch);
    notifyOrderParties(s,s.orders[0],options);
    assert.equal(offers(s).length,0);
  }
  const before=fixture();before.orders[0].shopRecovery={status:'awaiting_client'};
  const after=structuredClone(before);after.orders[0].shopRecovery.status='accepted';
  deriveDomainEvents(after,before,options);
  assert.equal(offers(after).filter(n=>n.userId==='idle').length,1);
  deriveDomainEvents(after,before,options);
  assert.equal(offers(after).filter(n=>n.userId==='idle').length,1);
});

test('queued alerts are suppressed when a rider becomes busy or the job leaves the pool', () => {
  const s=fixture();notifyOrderParties(s,s.orders[0],options);
  const n=offers(s)[0], device=s.deviceTokens[0];
  assert.equal(deviceAcceptsNotification(s,device,n),true);
  s.orders[1].riderId='idle';
  assert.equal(deviceAcceptsNotification(s,device,n),false);
  s.orders[1].state='completed';
  s.orders[0].riderId='busy';
  assert.equal(deviceAcceptsNotification(s,device,n),false);
  s.orders[0].riderId=null;s.orders[0].shopRecovery={status:'awaiting_client'};
  assert.equal(deviceAcceptsNotification(s,device,n),false);
});

test('dispatch lock-screen copy is fixed and the deep link uses the existing order id field', () => {
  const message=pushMessageFor({id:'n',type:'dispatch_available',orderId:'job',title:'private',body:'private',customer:'private'});
  assert.equal(message.title,'New delivery job');
  assert.equal(message.body,'A job is ready for pickup. Open GRIDGO to view it.');
  assert.deepEqual(message.data,{notificationId:'n',type:'dispatch_available',orderId:'job'});
  assert.equal(message.androidChannelId,'gridgo_default');
});
