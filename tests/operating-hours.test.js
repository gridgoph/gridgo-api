import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultOperationalSettings, validateOperationalSettings } from '../src/operational-model.js';
import { projectShopFinish } from '../src/order-match.js';
import { defaultShopSchedule } from '../src/availability.js';
import { startShopAcceptance } from '../src/shop-recovery.js';
import { latenessTier } from '../src/production-penalties.js';
import { nextNudgeDueAt } from '../src/production-inactivity.js';

const hours = () => ({ timeZone: 'Asia/Manila', schedule: {
  utcOffsetMinutes: 480,
  week: [1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, opensMinute: 480, closesMinute: 1020 })),
  closures: [{ startDay: '2026-10-12', endDay: '2026-10-12' }],
}, artworkReviewMinutes: 60, priorityDispatchCutoffMinute: 960 });
const at = '2026-10-10T08:30:15.000Z'; // Saturday 16:30:15 Manila
const policy = () => ({ version: 1, schedule: structuredClone(hours().schedule) });

test('new settings supply launch hours; invalid and impossible calendars are rejected', () => {
  const settings = defaultOperationalSettings();
  assert.ok(settings.operatingHours, 'operating schedule is part of seeded settings');
  for (const bad of [null, { ...hours(), timeZone: 'UTC' }, { ...hours(), artworkReviewMinutes: 0 },
    { ...hours(), priorityDispatchCutoffMinute: 1440 },
    { ...hours(), schedule: { ...hours().schedule, closures: [{ startDay: '2026-02-30', endDay: '2026-03-01' }] } },
    { ...hours(), schedule: { ...hours().schedule, week: [] } }]) {
    assert.throws(() => validateOperationalSettings({ ...settings, operatingHours: bad }), { code: 'invalid_operating_hours' });
  }
});

test('match promise waits for review across Saturday close, Sunday and closure before production and delivery', () => {
  const store = { settings: { operatingHours: hours(), promiseAllowanceMinutes: 60 },
    supplierProfiles: [{ userId: 'shop', schedule: defaultShopSchedule() }], supplierServices: [], orderJobs: [] };
  const { projection } = projectShopFinish(store, { supplierId: 'shop', turnaroundHours: 1, now: at });
  assert.equal(projection.review.scheduledReviewAt, at);
  assert.equal(projection.review.reviewCompletesAt, '2026-10-13T00:30:15.000Z');
  assert.equal(projection.readyBy, '2026-10-13T01:30:15.000Z');
  assert.equal(projection.promiseBy, '2026-10-13T02:30:15.000Z');
});

test('new-order acceptance uses platform hours while legacy acceptance retains shop hours', () => {
  const store = { supplierProfiles: [{ userId: 'shop', schedule: defaultShopSchedule() }] };
  const order = { supplierId: 'shop', operatingClock: policy() };
  startShopAcceptance(store, order, at);
  assert.equal(order.shopAcceptance.deadlineAt, '2026-10-13T00:30:15.000Z');
  const legacy = { supplierId: 'shop' };
  startShopAcceptance(store, legacy, at);
  assert.equal(legacy.shopAcceptance.deadlineAt, '2026-10-10T09:30:15.000Z');
});

test('lateness and inactivity grace exclude closed hours, preserve seconds and legacy clocks', () => {
  const deadline = '2026-10-10T09:00:00.000Z';
  const clock = policy();
  assert.equal(latenessTier(deadline, '2026-10-13T00:00:00.000Z', false, clock), null);
  assert.equal(latenessTier(deadline, '2026-10-13T06:00:00.000Z', false, clock), 'minor');
  assert.equal(latenessTier(deadline, '2026-10-13T06:00:00.001Z', false, clock), 'moderate');
  assert.equal(latenessTier(deadline, '2026-10-13T00:00:00.000Z'), 'severe');
  const nudge = { enabled: true, afterMs: 3600000, everyMs: 3600000, maxCount: 3 };
  assert.equal(nextNudgeDueAt(at, null, 0, nudge, clock), '2026-10-13T00:30:15.000Z');
  assert.equal(nextNudgeDueAt(at, null, 0, nudge), '2026-10-10T09:30:15.000Z');
});

import { reviewTiming, requireOperatingHours, orderReviewTiming, tagDelayedReviews } from '../src/operating-hours.js';
import { publicOrderFor } from '../src/operational-model.js';
import { availableDispatch } from '../src/dispatch-policy.js';

test('closed platform hides new dispatch offers but permits legacy work and reports the next review window', () => {
  const settings = { operatingHours: hours() };
  const closedAt = '2026-10-11T01:00:00.000Z';
  const order = { state: 'ready_for_dispatch', fulfillmentMode: 'delivery', operatingClock: policy() };
  assert.equal(availableDispatch(order, { settings }, closedAt), false);
  assert.equal(availableDispatch({ ...order, operatingClock: undefined }, { settings }, closedAt), true);
  assert.throws(() => requireOperatingHours(settings, closedAt, 'Dispatch'), { code: 'outside_operating_hours' });
  assert.equal(reviewTiming(settings, closedAt).scheduledReviewAt, '2026-10-13T00:00:00.000Z');
  assert.equal(reviewTiming(settings, '2026-10-13T00:00:00.000Z').isOpenNow, true);
  assert.equal(reviewTiming(settings, '2026-10-13T09:00:00.000Z').isOpenNow, false);
});

test('closure tags a pending review and exposes safe queue timing without changing promise or SLA snapshot', () => {
  const previous = { operatingHours: { ...hours(), schedule: { ...hours().schedule, closures: [] } } };
  const order = { id: 'order', clientId: 'client', state: 'needs_qa', createdAt: at,
    fileCheck: { status: 'pending', requestedAt: at }, operatingClock: policy(),
    promiseBy: '2026-10-12T08:00:00.000Z', reviewSchedule: reviewTiming(previous, at) };
  const immutable = JSON.stringify([order.promiseBy, order.operatingClock]);
  const store = { settings: { operatingHours: hours() }, version: 2, orders: [order] };
  assert.deepEqual(tagDelayedReviews(store, previous, at), ['order']);
  assert.equal(JSON.stringify([order.promiseBy, order.operatingClock]), immutable);
  assert.equal(orderReviewTiming(order, store.settings, at).reviewDelayed, true);
  const client = publicOrderFor(order, { id: 'client', role: 'client' }, store);
  assert.equal(client.review.status, 'waiting_for_review');
  assert.equal(client.review.reviewDelayed, true);
  assert.equal(client.operatingClock, undefined);
  assert.equal(client.reviewSchedule, undefined);
  assert.equal(publicOrderFor(order, { id: 'shop', role: 'supplier' }, store).review, undefined);
});

import { assessProductionLapses } from '../src/production-penalties.js';
test('applied penalties are never reassessed after a calendar change', () => {
  const order = { id: 'paid', supplierId: 'shop', commercialCommittedAt: at, readyBy: at,
    state: 'production', operatingClock: policy(), payoutMilestones: [{ amountMinor: 9500, productionDeductionMinor: 500 }] };
  const store = { orders: [order], productionLapses: [{ orderId: 'paid', supplierId: 'shop', appliedAt: at,
    tier: 'minor', deductionMinor: 500 }], settings: { operatingHours: hours() } };
  const before = structuredClone(store);
  assert.equal(assessProductionLapses(store, { at: '2026-11-01T00:00:00.000Z', createId: () => { throw new Error('No reassessment'); } }), false);
  assert.deepEqual(store, before);
});

test('review runs mid-window and a published closure already marks new requests delayed', () => {
  const settings = { operatingHours: hours() };
  const mid = reviewTiming(settings, '2026-10-09T03:23:45.678Z');
  assert.equal(mid.scheduledReviewAt, '2026-10-09T03:23:45.678Z');
  assert.equal(mid.reviewCompletesAt, '2026-10-09T04:23:45.678Z');
  assert.equal(mid.reviewDelayed, false);
  assert.equal(reviewTiming(settings, at).reviewDelayed, true);
});

import { recordFileCheckTransition } from '../src/artwork-gates.js';
test('a closure delay persists for its pending review and a fresh correction resets it', () => {
  const settings = { operatingHours: hours() };
  const order = { operatingClock: policy(), createdAt: at, fileCheck: { status: 'pending', requestedAt: at },
    reviewSchedule: reviewTiming(settings, at) };
  assert.equal(orderReviewTiming(order, settings, '2026-10-13T02:00:00.000Z').reviewDelayed, true);
  order.fileCheck.status = 'failed';
  order.reviewDelayed = { at };
  recordFileCheckTransition(order, 'client_correction', 'needs_qa', { id: 'client' }, '2026-10-13T02:00:00.000Z', '', undefined, settings);
  assert.equal(orderReviewTiming(order, settings, '2026-10-13T02:00:00.000Z').reviewDelayed, false);
  assert.equal(order.reviewSchedule.scheduledReviewAt, '2026-10-13T02:00:00.000Z');
});
