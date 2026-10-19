import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, id } from './fixtures/reschedule.js';
import { foundingTesterEligible, publicFoundingTester, testerOrderFacts, reconcileFoundingTester, remindFoundingTesters } from '../src/founding-testers.js';
import { publicSurvey, submitSurvey, syncSurveys } from '../src/surveys.js';
import { addVoucherCode } from '../src/vouchers.js';
import { validateOperationalSettings } from '../src/operational-model.js';

const AT = '2026-10-14T00:00:00.000Z', DAY = 86400000;
const time = days => new Date(Date.parse(AT) + days * DAY).toISOString();
const answers = { fulfillmentStars: 5, easeStars: 4, priceFeeling: 3 };
function setup() {
  const store = fixture(); store.surveyLaunchedAt = AT;
  store.users.forEach(u => { u.createdAt = AT; });
  return store;
}
const view = store => publicFoundingTester(store, 'client', AT);
const reconcile = (store, at = AT) => reconcileFoundingTester(store, 'client', { id, at });
const deliver = store => Object.assign(store.orders[0], { state: 'issue_window_open', issueWindowOpenedAt: AT });
const submit = (store, at = AT) => submitSurvey(store, store.orders[0], answers, { id, at });

test('missions advance only on confirmed payment, actual handover, then survey; any order size counts', () => {
  const store = setup(), order = store.orders[0];
  order.totalMinor = 1; order.payments.initial.status = 'pending_confirmation';
  assert.equal(view(store).completedCount, 0);
  order.payments.initial.status = 'confirmed'; assert.equal(view(store).completedCount, 1);
  order.state = 'awaiting_collection'; assert.equal(view(store).completedCount, 1);
  deliver(store); assert.equal(view(store).completedCount, 2); assert.equal(reconcile(store), false);
  const response = submit(store);
  assert.equal(response.rewardProgram, 'founding_tester'); assert.equal(response.rewardStatus, 'founding_tester');
  assert.equal(view(store).label, 'Founding Tester'); assert.equal(view(store).completedCount, 3);
  assert.equal(response.reward.valueMinor, 1500); assert.equal(response.reward.expiresAt, time(30));
  assert.equal(store.voucherCampaigns[0].purpose, 'founding_tester');
  assert.equal(store.vouchers[0].emailAllowed, false); assert.equal(store.voucherEmailOutbox.length, 0);
  assert.equal(submit(store, time(20)).reward.id, response.reward.id); assert.equal(reconcile(store), false);
  assert.equal(store.vouchers.length, 1); assert.equal(store.voucherLedger.filter(e => e.kind === 'issued').length, 1);
  assert.equal(addVoucherCode(store, 'client', response.reward.code, { id, at: AT }).body.voucher.id, response.reward.id);
  assert.equal(addVoucherCode(store, 'other', response.reward.code, { id, at: AT }).status, 400);
  for (const userId of ['client', 'ops', 'admin']) assert.equal(store.notifications.filter(n => n.userId === userId && n.type === 'founding_tester_awarded').length, 1);
});

test('pickup confirmation counts, readiness does not; later surveys never earn another voucher', () => {
  const store = setup(); store.orders[0].fulfillmentMode = 'pickup';
  store.orders[0].state = 'awaiting_collection'; assert.equal(view(store).missions.received, false);
  deliver(store); const first = submit(store);
  store.orders.unshift({ ...structuredClone(store.orders[0]), id: 'second', issueWindowOpenedAt: time(8) });
  assert.equal(publicSurvey(store, store.orders[0], time(8)).rewardEligible, false);
  const second = submit(store, time(8));
  assert.equal(second.reward.id, first.reward.id); assert.equal(store.vouchers.length, 1);
});

test('strict launch boundary, unset launch, validation and existing award stability', () => {
  const store = setup(); assert.equal(foundingTesterEligible(store, 'client'), true);
  store.settings.foundingTesterLaunchAt = AT; assert.equal(foundingTesterEligible(store, 'client'), false);
  store.settings.foundingTesterLaunchAt = time(1); assert.equal(foundingTesterEligible(store, 'client'), true);
  for (const value of ['bad', '2026-10-14', '2026-02-30T00:00:00Z', 123]) {
    assert.throws(() => validateOperationalSettings({ ...store.settings, foundingTesterLaunchAt: value }), { code: 'invalid_founding_tester_launch_at' });
  }
  deliver(store); submit(store); store.settings.foundingTesterLaunchAt = time(-1);
  assert.equal(foundingTesterEligible(store, 'client'), true); assert.equal(reconcile(store), false);
});

test('client-caused and unattributed cancellations/refunds never complete missions', () => {
  for (const kind of ['cancel', 'client_refund', 'unknown_refund', 'client_decision']) {
    const store = setup(); deliver(store);
    if (kind === 'cancel') Object.assign(store.orders[0], { state: 'cancelled', cancelledBy: 'client' });
    if (kind.endsWith('refund')) store.refundSettlements.push({ orderId: 'order', disposition: 'fulfilled_with_refund', snapshot: kind === 'client_refund' ? { clientCaused: true } : {} });
    if (kind === 'client_decision') store.issues.push({ orderId: 'order', faultDecision: { status: 'approved', fault: 'client', recordedAt: AT } });
    assert.equal(view(store).completedCount, 0, kind); assert.equal(reconcile(store), false);
  }
});

test('shop and approved GRIDGO failures count first two missions and permit a survey without delivery', () => {
  for (const kind of ['shop_event', 'shop', 'gridgo']) {
    const store = setup(), order = store.orders[0];
    Object.assign(order, { state: 'cancelled', cancelledBy: 'client' }); order.payments.initial.status = 'pending_confirmation';
    if (kind === 'shop_event') order.shopFailureEvents = [{ at: AT, kind: 'cancelled' }];
    else store.issues.push({ orderId: 'order', faultDecision: { status: 'approved', fault: kind, recordedAt: AT } });
    assert.equal(view(store).completedCount, 2); assert.equal(publicSurvey(store, order, AT).status, 'open');
    assert.equal(submit(store).reward.valueMinor, 1500); assert.equal(view(store).completedCount, 3);
  }
  const store = setup();
  store.issues.push({ orderId: 'order', faultDecision: { status: 'awaiting_approval', fault: 'gridgo', recordedAt: AT } });
  assert.equal(testerOrderFacts(store, store.orders[0]).received, false);
  assert.equal(publicSurvey(store, store.orders[0], AT), null);
  store.orders[0].shopFailureEvents = [{ at: AT }];
  store.refundSettlements.push({ orderId: 'order', snapshot: { clientCaused: true } });
  assert.equal(view(store).completedCount, 0);
});

test('existing completed accounts get one label and reuse even an expired survey voucher', () => {
  const store = setup(); deliver(store); store.settings.foundingTesterLaunchAt = AT;
  const survey = submit(store); assert.equal(survey.rewardStatus, 'issued');
  store.settings.foundingTesterLaunchAt = null;
  store.orders.push({ ...structuredClone(store.orders[0]), id: 'next' });
  assert.equal(publicSurvey(store, store.orders[1], AT).rewardEligible, false);
  assert.equal(reconcile(store, time(40)), true); assert.equal(reconcile(store, time(41)), false);
  assert.equal(view(store).reward.id, survey.reward.id); assert.equal(view(store).rewardStatus, 'existing_survey_reward');
  assert.equal(store.vouchers.length, 1); assert.equal(store.vouchers[0].expiresAt, time(30));
});

test('historical completed cooldown response earns once; review identities and orders never earn', () => {
  const store = setup(); deliver(store); syncSurveys(store, { id, at: AT });
  Object.assign(store.orderSurveys[0], { submittedAt: AT, rewardStatus: 'cooldown' });
  assert.equal(reconcile(store), true); assert.equal(reconcile(store), false);
  for (const kind of ['client', 'order']) {
    const review = setup(); deliver(review);
    if (kind === 'client') review.users.find(u => u.id === 'client').reviewData = true;
    else review.orders[0].reviewData = true;
    submit(review); assert.equal(review.vouchers.length, 0); assert.equal(reconcile(review), false);
  }
});

test('reminders at days two and five are durable, capped, no catch-up burst, only for accounts without orders', () => {
  const store = setup(); store.orders = [];
  store.users = store.users.filter(u => u.id === 'client');
  const remind = at => remindFoundingTesters(store, { id, at });
  assert.equal(remind(time(2 - 1 / DAY)), false);
  assert.equal(remind(time(2)), true); assert.equal(remind(time(2)), false);
  assert.equal(remind(time(5)), true); assert.equal(remind(time(90)), false);
  assert.equal(store.notifications.filter(n => n.userId === 'client').length, 2);
  assert.equal(store.notifications.filter(n => n.userId === 'admin').length, 2);
  const late = setup(); late.orders = []; late.users = late.users.filter(u => u.id === 'client');
  assert.equal(remindFoundingTesters(late, { id, at: time(5.5) }), true);
  assert.equal(remindFoundingTesters(late, { id, at: time(11) }), false);
  assert.equal(late.notifications.filter(n => n.userId === 'client').length, 1);
  const old = setup(); old.orders = [];
  assert.equal(remindFoundingTesters(old, { id, at: time(10) }), false);
  for (const kind of ['ordered', 'cutoff', 'review']) {
    const excluded = setup(); excluded.users = excluded.users.filter(u => u.id === 'client');
    if (kind !== 'ordered') excluded.orders = [];
    if (kind === 'cutoff') excluded.settings.foundingTesterLaunchAt = AT;
    if (kind === 'review') excluded.users[0].reviewData = true;
    assert.equal(remindFoundingTesters(excluded, { id, at: time(2) }), false);
  }
});
