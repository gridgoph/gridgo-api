import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fixture, id, actors } from './fixtures/reschedule.js';
import { routeOrderSharing, shareView } from '../src/order-sharing.js';
import { manilaWeek, reminderReport, validateDeliveryReminder } from '../src/delivery-reminders.js';
import { authorizeFileUpload, validateUpload } from '../src/attachments.js';

const AT = '2026-10-26T01:00:00.000Z';
const call = (store, suffix, body, user = actors.client, method = 'POST') => routeOrderSharing({
  req: { method }, url: new URL(`http://api/orders/order/share${suffix}`), store, user, readBody: async () => body, id, now: () => AT,
});
function ready() {
  const store = fixture();
  store.orderSurveys.push({ orderId: 'order', clientId: 'client', submittedAt: AT });
  return store;
}
const error = code => e => e.code === code;

test('share card requires the submitted survey, allows exactly one repeat, and keeps retries presentation-scoped', async () => {
  const store = ready();
  assert.equal(shareView(store, store.orders[0]).card.showAfterSurvey, true);
  await assert.rejects(call(store, '/card', { presentation: 'order_repeat', action: 'shown' }), error('share_card_transition_invalid'));
  await call(store, '/card', { presentation: 'after_survey', action: 'shown' });
  await call(store, '/card', { presentation: 'after_survey', action: 'shown' });
  assert.equal(shareView(store, store.orders[0]).card.showAfterSurvey, false);
  await call(store, '/card', { presentation: 'after_survey', action: 'maybe_later' });
  assert.equal(shareView(store, store.orders[0]).card.showFromOrder, true);
  await call(store, '/card', { presentation: 'order_repeat', action: 'shown' });
  assert.equal(shareView(store, store.orders[0]).card.showFromOrder, false);
  // Lost responses to the initial display/dismiss cannot consume or close the repeat.
  await call(store, '/card', { presentation: 'after_survey', action: 'maybe_later' });
  assert.equal(store.orderShareCards[0].closedAt, undefined);
  await call(store, '/card', { presentation: 'order_repeat', action: 'maybe_later' });
  await call(store, '/card', { presentation: 'order_repeat', action: 'shown' });
  assert.equal(store.orderShareCards.length, 1);
  assert.equal(shareView(store, store.orders[0]).card.closedAt, AT);
  assert.equal(shareView(store, store.orders[0]).card.showFromOrder, false);
  const unsubmitted = fixture(); unsubmitted.orders[0].state = 'delivered';
  assert.equal(shareView(unsubmitted, unsubmitted.orders[0]).available, true);
  assert.equal(shareView(unsubmitted, unsubmitted.orders[0]).card.showAfterSurvey, false);
  await assert.rejects(call(unsubmitted, '/card', { presentation: 'after_survey', action: 'shown' }), error('share_card_not_available'));
});

test('explicit close suppresses every further automatic card while manual sharing stays available', async () => {
  const store = ready();
  await call(store, '/card', { presentation: 'after_survey', action: 'shown' });
  await call(store, '/card', { presentation: 'after_survey', action: 'close' });
  await call(store, '/card', { presentation: 'after_survey', action: 'maybe_later' });
  const view = shareView(store, store.orders[0]);
  assert.equal(view.available, true); assert.equal(view.card.showFromOrder, false);
  assert.equal(store.orderShareCards[0].dismissedAt, undefined);
});

test('story uses the awarded label rather than eligibility; prepare uses existing invite configuration', async () => {
  const store = ready(); store.users[0].name = '  Ana Maria  Cruz ';
  store.settings.testerSignupFormUrlTemplate = 'https://gridgo.example/invite?code={code}';
  const prepared = await call(store, '/prepare', {});
  assert.equal(prepared.body.share.firstName, 'Ana');
  assert.equal(prepared.body.share.foundingTester, false);
  assert.ok(prepared.body.share.inviteCode);
  assert.ok(prepared.body.share.inviteLink.endsWith(prepared.body.share.inviteCode));
  store.foundingTesters.push({ clientId: 'client', awardedAt: AT });
  const retry = await call(store, '/prepare', {});
  assert.equal(retry.mutated, false); assert.equal(retry.body.share.foundingTester, true);
  assert.equal(store.testerInviteCodes.length, 1);
});

test('taps are telemetry only, idempotent per client event and conflict on changed contents', async () => {
  const store = ready(), eventId = crypto.randomUUID();
  const before = ['vouchers', 'voucherCampaigns', 'voucherLedger', 'testerRewards', 'creditLedger'].map(key => structuredClone(store[key]));
  const body = { eventId, action: 'share' };
  assert.equal((await call(store, '/taps', body)).body.replay, false);
  assert.equal((await call(store, '/taps', body)).body.replay, true);
  await assert.rejects(call(store, '/taps', { ...body, action: 'send_to_friend' }), error('share_tap_conflict'));
  await call(store, '/taps', { eventId: crypto.randomUUID(), action: 'send_to_friend' });
  assert.equal(store.orderShareTaps.length, 2);
  assert.deepEqual(['vouchers', 'voucherCampaigns', 'voucherLedger', 'testerRewards', 'creditLedger'].map(key => store[key]), before);
  for (const userId of ['ops', 'admin']) assert.equal(store.notifications.filter(n => n.type === 'order_share_tapped' && n.userId === userId).length, 2);
});

test('capability validation keeps legacy deliveries explicit; modern requests require the real boolean tick', () => {
  const store = fixture(), order = store.orders[0]; order.riderId = 'rider';
  assert.deepEqual(validateDeliveryReminder(store, order, {}), { protocolVersion: 0, remindedClient: false, clientAgreedToPhoto: false, packagePhotoFileId: null });
  for (const remindedClient of [undefined, false, 'true', 1]) assert.throws(() => validateDeliveryReminder(store, order, { handoffReminderVersion: 1, remindedClient }), error('client_reminder_required'));
  assert.throws(() => validateDeliveryReminder(store, order, { remindedClient: true }), error('unsupported_handoff_reminder_version'));
  assert.throws(() => validateDeliveryReminder(store, order, { handoffReminderVersion: 2, remindedClient: true }), error('unsupported_handoff_reminder_version'));
  assert.throws(() => validateDeliveryReminder(store, order, { handoffReminderVersion: 1, remindedClient: true, clientAgreedToPhoto: 'true' }), error('invalid_photo_consent'));
  assert.throws(() => validateDeliveryReminder(store, order, { handoffReminderVersion: 1, remindedClient: true, packagePhotoFileId: 'x' }), error('package_photo_consent_required'));
  order.fulfillmentMode = 'pickup';
  assert.equal(validateDeliveryReminder(store, order, { handoffReminderVersion: 1 }), null);
});

test('package uploads use the existing image policy with rider-only upload authority', () => {
  authorizeFileUpload(actors.rider, 'delivery_package_photo');
  assert.throws(() => authorizeFileUpload(actors.client, 'delivery_package_photo'), error('forbidden'));
  assert.equal(validateUpload({ originalFilename: 'package.png', size: 100, declaredContentType: 'image/png', sniffBytes: Buffer.from('89504e470d0a1a0a', 'hex') }, 'delivery_package_photo'), 'image/png');
});

test('Manila ISO weeks cross UTC Sunday and year boundaries correctly; reports join only same-order follow-through', () => {
  assert.deepEqual(manilaWeek('2026-10-25T15:59:59Z'), { week: '2026-W43', weekStart: '2026-10-19' });
  assert.deepEqual(manilaWeek('2026-10-25T16:00:00Z'), { week: '2026-W44', weekStart: '2026-10-26' });
  assert.deepEqual(manilaWeek('2027-01-01T00:00:00Z'), { week: '2026-W53', weekStart: '2026-12-28' });
  const store = ready();
  store.orders[0].deliveryEvidence = { riderId: 'rider', recordedAt: AT };
  store.deliveryReminders.push({ orderId: 'order', riderId: 'rider', deliveredAt: AT, protocolVersion: 1, remindedClient: true });
  store.orders.push({ ...structuredClone(store.orders[0]), id: 'second', deliveryEvidence: { riderId: 'rider', recordedAt: AT } });
  store.orderShareTaps.push({ orderId: 'second', action: 'share', createdAt: AT });
  store.orderShareTaps.push({ orderId: 'order', action: 'send_to_friend', createdAt: AT });
  store.orderShareTaps.push({ orderId: 'order', action: 'share', createdAt: '2026-10-25T12:00:00Z' });
  let row = reminderReport(store, new URLSearchParams(), () => true)[0];
  assert.equal(row.deliveries, 2); assert.equal(row.reminderRate, 0.5); assert.equal(row.legacyDeliveries, 1);
  assert.equal(row.surveySubmittedDeliveries, 1); assert.equal(row.shareTappedDeliveries, 0);
  store.orderShareTaps.push({ orderId: 'order', action: 'share', createdAt: AT });
  row = reminderReport(store, new URLSearchParams(), () => true)[0];
  assert.equal(row.shareTappedDeliveries, 1); assert.equal(row.surveyAndShareDeliveries, 1);
});
