import test from 'node:test';
import assert from 'node:assert/strict';
import { locationFreshness, clientTracking, deliveryMilestones, pingDiagnostics, currentRiderPings } from '../src/rider-tracking.js';

const at = '2026-10-14T01:00:00.000Z';
const ms = Date.parse(at);
test('freshness flips at exactly two minutes and never clears the last fix', () => {
  const ping = { at };
  assert.equal(locationFreshness(ping, {}, ms + 119999).stale, false);
  assert.equal(locationFreshness(ping, {}, ms + 120000).stale, true);
  assert.equal(locationFreshness(null, {}, ms + 119999, at).stale, false);
  assert.equal(locationFreshness(null, {}, ms + 120000, at).stale, true);
  assert.equal(locationFreshness({ at: new Date(ms + 30000).toISOString() }, {}, ms).ageSeconds, 0);
  const order = { fulfillmentMode: 'delivery', state: 'picked_up', riderId: 'r', pickupChecklist: { completedAt: at } };
  const fix = { at, riderId: 'r', lat: 8, lng: 126, leg: 'delivery' };
  assert.equal(clientTracking(order, fix, {}, 4, ms + 120000).lastUpdatedAt, at);
  assert.equal(clientTracking({ ...order, state: 'delivered' }, fix, {}, 4, ms + 120000).status, 'inactive');
});
test('repeat pickup escalation timeline rows do not reset assignment; reassignment excludes previous fixes', () => {
  const order = { id: 'o', riderId: 'r', timeline: [{ state: 'rider_assigned', at }, { state: 'rider_assigned', at: new Date(ms + 10000).toISOString(), escalationId: 'e' }] };
  const ping = { orderId: 'o', riderId: 'r', at: new Date(ms + 1000).toISOString() };
  assert.deepEqual(currentRiderPings({ locationPings: [ping] }, order), [ping]);
  order.riderAssignedAt = new Date(ms + 10000).toISOString();
  assert.deepEqual(currentRiderPings({ locationPings: [ping] }, order), []);
});
test('milestones preserve missing event times and diagnostics are bounded without invented legacy receive times', () => {
  const rows = deliveryMilestones({ riderId: 'r', pickupChecklist: { completedAt: at }, timeline: [] });
  assert.equal(rows[1].status, 'passed');
  assert.equal(rows[1].at, null);
  assert.equal(rows[3].at, at);
  const pings = Array.from({ length: 110 }, (_, index) => ({ at, receivedAt: new Date(ms + index * 20000).toISOString() }));
  pings.push({ at });
  const diagnostics = pingDiagnostics(pings, ms + 2200000);
  assert.equal(diagnostics.sampleCount, 100);
  assert.equal(diagnostics.maxReceiveGapSeconds, 20);
  assert.equal(diagnostics.secondsSinceLastReceived, 20);
});
