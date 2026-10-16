import test from 'node:test';
import assert from 'node:assert/strict';
import { publicOrderFor } from '../src/operational-model.js';
import { displayFilename } from '../src/display-filename.js';

test('supplier updates retain production instructions while replacing internal payout words', () => {
  const order = { id: 'job', supplierId: 'shop', clientId: 'client', state: 'production', timeline: [
    { at: '1', state: 'production', note: 'Use the approved blue sample', by: 'ops' },
    { at: '2', state: 'production', note: 'Proof of Fulfilment attached for production_started', milestoneCode: 'production_started', fileId: 'private' },
    { at: '3', state: 'production', note: 'production_started supplier payout milestone released', milestoneCode: 'production_started' },
    { at: '4', state: 'needs_qa', note: 'Client private message', by: 'client' },
  ] };
  const job = publicOrderFor(order, { role: 'supplier', id: 'shop' });
  assert.equal(job.timeline[0].note, 'Use the approved blue sample');
  assert.equal(job.timeline.length, 4);
  assert.match(job.timeline[1].note, /Start of production/i);
  assert.doesNotMatch(JSON.stringify(job.timeline), /production_started|private|Client private/);
  assert.equal(job.timeline[3].note, 'Artwork being checked');
});

test('filename display decodes once, tolerates malformed percent input and removes controls', () => {
  for (const [input, expected] of [['My%20file.pdf', 'My file.pdf'], ['100% cotton.pdf', '100% cotton.pdf'], ['a%2520b.pdf', 'a%20b.pdf'], ['a+b.pdf', 'a+b.pdf'], ['x%0Aname.pdf', 'xname.pdf']]) {
    assert.equal(displayFilename(input), expected);
  }
});

test('material options and legacy zone labels fill job details without consulting live listing prices', () => {
  const order = { id: 'job', supplierId: 'shop', zone: 'davao_central', deadline: '2026-10-20', state: 'production' };
  const store = {
    zones: [{ code: 'davao_central', name: 'Central Davao' }],
    orderLineItems: [{ id: 'line', orderId: 'job', itemNameSnapshot: 'Flyer', structuredSpecSnapshot: {} }],
    orderLineItemOptions: [{ orderLineItemId: 'line', groupNameSnapshot: 'Material', optionLabelSnapshot: 'Coated paper' }],
  };
  const result = publicOrderFor(order, { id: 'shop', role: 'supplier' }, store);
  assert.deepEqual(result.jobDetails, { material: 'Coated paper', zone: 'Central Davao', promisedDate: '2026-10-20', missing: [] });
});

test('snapshotted zone and shop deadline win over live settings and client promise', () => {
  const order = { id: 'job', supplierId: 'shop', state: 'production', material: 'Paper',
    distanceZone: { key: 'nearby', label: 'Nearby' }, zone: 'away',
    readyBy: '2026-10-20T01:00:00.000Z', promisedDate: '2026-10-21T01:00:00.000Z', promiseBy: '2026-10-21T01:00:00.000Z' };
  const job = publicOrderFor(order, { id: 'shop', role: 'supplier' }, { settings: { deliveryFeeBands: [] } });
  assert.equal(job.jobDetails.zone, 'Nearby');
  assert.equal(job.promisedDate, '2026-10-20T01:00:00.000Z');
  assert.equal(job.promiseBy, undefined);
  assert.equal(order.promisedDate, '2026-10-21T01:00:00.000Z');
});
