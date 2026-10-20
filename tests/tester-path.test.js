import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, id, AT } from './fixtures/reschedule.js';
import { testerProgress, reconcileFoundingTester } from '../src/founding-testers.js';
import { validateOperationalSettings } from '../src/operational-model.js';

test('signup form requires the actual code placeholder in the query', () => {
  const settings = fixture().settings;
  for (const template of [
    'https://forms.example.test/?probe=TESTERCODE#entry.123={code}',
    'https://forms.example.test/{code}?probe=TESTERCODE',
    'https://{code}.example.test/?probe=TESTERCODE',
    'https://forms.example.test/?first={code}&second={code}',
  ]) {
    assert.throws(() => validateOperationalSettings({ ...settings, testerSignupFormUrlTemplate: template }),
      { status: 400, code: 'invalid_tester_signup_form_url' });
  }
  assert.doesNotThrow(() => validateOperationalSettings({
    ...settings, testerSignupFormUrlTemplate: 'https://forms.example.test/?probe=TESTERCODE&entry.123={code}#form',
  }));
});

test('five-step path requires an explicit tracking event before the mission reward', () => {
  const store = fixture();
  store.orders[0].issueWindowOpenedAt = AT;
  store.orderSurveys.push({ orderId: 'order', clientId: 'client', submittedAt: AT });
  assert.deepEqual(testerProgress(store, 'client').missions, { added: true, placed: true, tracked: false, received: true, rated: true });
  assert.equal(reconcileFoundingTester(store, 'client', { id, at: AT }), false);
  store.testerTracking = [{ clientId: 'client', orderId: 'order', createdAt: AT }];
  assert.equal(reconcileFoundingTester(store, 'client', { id, at: AT }), true);
  assert.equal(reconcileFoundingTester(store, 'client', { id, at: AT }), false);
  assert.equal(store.vouchers.length, 1);
});

test('monthly budget pauses completed mission; a later profile read cannot release it', () => {
  const store = fixture();
  store.settings.testerMonthlyBudgetMinor = 0;
  store.orders[0].issueWindowOpenedAt = AT;
  store.orderSurveys.push({ orderId: 'order', clientId: 'client', submittedAt: AT });
  store.testerTracking = [{ clientId: 'client', orderId: 'order', createdAt: AT }];
  reconcileFoundingTester(store, 'client', { id, at: AT });
  assert.equal(store.vouchers.length, 0);
  assert.equal(store.testerRewards[0].status, 'paused');
  store.settings.testerMonthlyBudgetMinor = null;
  reconcileFoundingTester(store, 'client', { id, at: '2026-11-01T00:00:00.000Z' });
  assert.equal(store.vouchers.length, 0);
});

test('empty cart is not a step, observed cart lines persist after deletion, grandfathered award is five of five', async () => {
  const { recordTesterCartStep, publicFoundingTester } = await import('../src/founding-testers.js');
  const s = fixture(); s.orders = []; s.orderLineItems = [];
  s.carts.push({ id: 'cart', clientId: 'client' });
  assert.equal(testerProgress(s, 'client').missions.added, false);
  s.cartLines.push({ id: 'line', cartId: 'cart' });
  assert.equal(recordTesterCartStep(s, 'client', AT), true);
  s.cartLines = [];
  assert.equal(testerProgress(s, 'client').missions.added, true);
  s.foundingTesters[0].awardedAt = AT;
  assert.equal(publicFoundingTester(s, 'client', AT).completedCount, 5);
  assert.equal(reconcileFoundingTester(s, 'client', { id, at: AT }), false);
});
