import test from 'node:test';
import assert from 'node:assert/strict';
import { projectShopFinish } from '../src/order-match.js';
import { defaultShopSchedule } from '../src/availability.js';

const schedule = { ...defaultShopSchedule(), week: defaultShopSchedule().week.filter(day => day.weekday !== 6) };
const store = { supplierProfiles: [{ userId: 'shop', schedule }], settings: { promiseAllowanceMinutes: 0 } };

test('two production days ordered Friday evening finish Tuesday at closing', () => {
  const { projection } = projectShopFinish(store, { supplierId: 'shop', turnaroundDays: 2, now: '2026-09-04T11:00:00.000Z' });
  assert.equal(projection.readyBy, '2026-09-08T10:00:00.000Z');
});

test('two production days starting Friday morning finish Monday at closing', () => {
  const { projection } = projectShopFinish(store, { supplierId: 'shop', turnaroundDays: 2, now: '2026-09-04T00:00:00.000Z' });
  assert.equal(projection.readyBy, '2026-09-07T10:00:00.000Z');
});

import { hoursToDays, productionDayMinutes, productionDuration } from '../src/production-days.js';

test('converted turnaround never promises earlier, including short jobs and partial days', () => {
  for (const closing of [990, 1020, 1080]) {
    const calendar = { ...schedule, week: schedule.week.map(day => ({ ...day, closesMinute: closing })) };
    const graph = { ...store, supplierProfiles: [{ userId: 'shop', schedule: calendar }] };
    const minutes = productionDayMinutes(calendar);
    for (const hours of [2, 3, 4, 5, 12, 20, 24, 48, 72, 120]) {
      for (const now of ['2026-09-04T00:00:00Z', '2026-09-04T08:00:00Z', '2026-09-04T11:00:00Z']) {
        const old = projectShopFinish(graph, { supplierId: 'shop', turnaroundHours: hours, now }).projection;
        const next = projectShopFinish(graph, { supplierId: 'shop', turnaroundDays: hoursToDays(hours, minutes), now }).projection;
        assert.ok(Date.parse(next.readyBy) >= Date.parse(old.readyBy), `${hours}h at ${now}`);
      }
    }
  }
});

test('duration adapter validates whole days, preserves null, and gives days precedence', () => {
  assert.deepEqual(productionDuration({ turnaroundHours: 48 }, {}, 'turnaround', 600), { turnaroundDays: null, turnaroundMinutes: 2880, turnaroundHours: 48 });
  assert.deepEqual(productionDuration({ turnaroundDays: 2, turnaroundHours: 48 }, {}, 'turnaround', 540), { turnaroundDays: 2, turnaroundMinutes: 1080, turnaroundHours: 18 });
  assert.deepEqual(productionDuration({ minimumTurnaroundDays: null }, {}, 'minimumTurnaround', 600), { minimumTurnaroundDays: null, minimumTurnaroundMinutes: null, minimumTurnaroundHours: null });
  for (const value of [0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER]) assert.throws(() => productionDuration({ turnaroundDays: value }, {}, 'turnaround', 600));
});

test('a split shift counts its open minutes; an ambiguous or empty week is refused', () => {
  assert.equal(productionDayMinutes({ utcOffsetMinutes: 480, week: [
    { weekday: 1, opensMinute: 480, closesMinute: 720 },
    { weekday: 1, opensMinute: 780, closesMinute: 1020 },
  ] }), 480);
  assert.throws(() => productionDayMinutes({ utcOffsetMinutes: 480, week: [] }));
  assert.throws(() => productionDayMinutes({ ...schedule, week: schedule.week.map((row, i) => ({ ...row, closesMinute: i === 0 ? 1020 : 1080 })) }), { code: 'production_day_length_unavailable' });
});

test('legacy one-hour and fractional-hour writes retain exact working minutes', () => {
  assert.deepEqual(productionDuration({ turnaroundHours: 1 }, { turnaroundDays: 1 }, 'turnaround', 600),
    { turnaroundDays: null, turnaroundMinutes: 60, turnaroundHours: 1 });
  assert.deepEqual(productionDuration({ turnaroundHours: 1.25 }, {}, 'turnaround', 600),
    { turnaroundDays: null, turnaroundMinutes: 75, turnaroundHours: 1.25 });
});

test('same-day minutes schedule across closing without becoming a full working day', () => {
  const duration = productionDuration({ turnaroundMinutes: 90 }, {}, 'turnaround', 600);
  const { projection } = projectShopFinish(store, { supplierId: 'shop', ...duration, now: '2026-09-04T09:30:00.000Z' });
  assert.equal(projection.readyBy, '2026-09-07T01:00:00.000Z');
  for (const value of [0, -1, 1.5, '60', 600, 601]) {
    assert.throws(() => productionDuration({ turnaroundMinutes: value }, {}, 'turnaround', 600));
  }
});
