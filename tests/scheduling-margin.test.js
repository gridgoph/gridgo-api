import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/scheduling.js';
import { deadlineDays, projectShopFinish } from '../src/order-match.js';
import { operatingHours } from '../src/operating-hours.js';
import { validateOperationalSettings } from '../src/operational-model.js';

test('same-day default margin is two working hours and still permits today before dispatch cutoff', () => {
  const { store } = fixture(); delete store.settings.promiseAllowanceMinutes;
  delete store.settings.operatingHours.sameDayPromiseAllowanceMinutes;
  Object.assign(store.catalogItems[0], { turnaroundMode: 'override', turnaroundHours: 1, minimumTurnaroundHours: 1 });
  store.catalogItems.splice(1);
  assert.equal(operatingHours(store.settings).sameDayPromiseAllowanceMinutes, 120);
  const days = deadlineDays(store, { subcategoryCode: 'flyers', now: '2026-10-19T01:00:00Z', days: 1 });
  assert.equal(days.days[0].readyBy, '2026-10-19T04:30:00.000Z');
  store.settings.operatingHours.sameDayPromiseAllowanceMinutes = 600;
  const moved = deadlineDays(store, { subcategoryCode: 'flyers', now: '2026-10-19T01:00:00Z', days: 1 });
  assert.equal(moved.days[0].readyBy, null);
});
test('same-day setting leaves day-based margin intact', () => {
  const { store } = fixture(); delete store.settings.promiseAllowanceMinutes;
  delete store.settings.operatingHours.sameDayPromiseAllowanceMinutes;
  const input = { supplierId: 'shop_a', turnaroundHours: 30, now: '2026-10-19T01:00:00Z' };
  const before = projectShopFinish(store, input);
  store.settings.operatingHours.sameDayPromiseAllowanceMinutes = 0;
  assert.deepEqual(projectShopFinish(store, input), before);
});
test('same-day margin accepts integer working minutes from zero to 600 only', () => {
  const { store } = fixture();
  for (const value of [0, 120, 600]) {
    store.settings.operatingHours.sameDayPromiseAllowanceMinutes = value;
    assert.doesNotThrow(() => validateOperationalSettings(store.settings));
  }
  for (const value of [-1, 601, 1.5, null, '120']) {
    store.settings.operatingHours.sameDayPromiseAllowanceMinutes = value;
    assert.throws(() => validateOperationalSettings(store.settings), { code: 'invalid_operating_hours' });
  }
});
