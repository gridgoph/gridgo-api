import test from 'node:test';
import assert from 'node:assert/strict';
import { handoverRequirements } from '../src/shop-handover.js';

test('a replacement shop cannot inherit finished evidence or QA approval in the readiness/forced-step audit', () => {
  const order = { id: 'order', supplierId: 'replacement', shopHandover: {
    finished: { supplierId: 'old-shop', photoFileIds: ['finished'] }, review: { decision: 'approved' },
  } };
  const store = { files: [{ fileId: 'finished', ownerId: 'old-shop', purpose: 'finished_product_photo', state: 'ready',
    objectKey: 'private/finished', detectedContentType: 'image/png', references: [{ type: 'order', id: 'order' }] }] };
  const missing = handoverRequirements(store, order, 'ready_for_dispatch').map(item => item.code);
  assert.ok(missing.includes('production_finished_required'));
  assert.ok(missing.includes('production_review_required'));
  assert.ok(missing.includes('finished_product_photo_required'));
  order.supplierId = 'old-shop';
  assert.deepEqual(handoverRequirements(store, order, 'ready_for_dispatch'), []);
});
