import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, id } from './fixtures/reschedule.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { syncSurveys } from '../src/surveys.js';
import { publicOrderFor } from '../src/operational-model.js';
import { retentionDecision } from '../src/file-retention-policy.js';

const DB = process.env.DATABASE_URL;
const answers = { fulfillmentStars: 5, easeStars: 5, priceFeeling: 3, qualityStars: 5, recommendScore: 10 };
const delivery = { evidenceType: 'photo', evidenceFileId: 'proof', handoffReminderVersion: 1, remindedClient: true };
async function setup(t, state = 'issue_window_open') {
  assert.match(new URL(DB).pathname, /(?:_|-)test(?:_|$)/);
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, voucher_campaigns, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture(), at = new Date().toISOString();
  store.settings.foundingTesterLaunchAt = '2026-01-01T00:00:00.000Z';
  store.settings.testerSignupFormUrlTemplate = 'https://gridgo.example/invite?code={code}';
  store.users.find(user => user.id === 'client').name = 'Ana Maria Cruz';
  store.surveyLaunchedAt = (await db.query('SELECT launched_at FROM survey_launch')).rows[0].launched_at;
  Object.assign(store.orders[0], { state, riderId: 'rider', ...(state === 'issue_window_open' ? {
    issueWindowOpenedAt: at, issueWindowExpiresAt: new Date(Date.parse(at) + 86400000).toISOString(),
  } : {}) });
  store.approvalCases.push({ id: 'case_rider', userId: 'rider', kind: 'rider', status: 'approved', version: 1,
    applicationRevision: 1, submittedAt: at, decidedAt: at, createdAt: at, updatedAt: at });
  for (const [fileId, purpose] of [['proof', 'delivery_photo'], ['package', 'delivery_package_photo']]) store.files.push({
    fileId, ownerId: 'rider', purpose, state: 'ready', objectKey: `private/${fileId}`, originalFilename: `${fileId}.png`,
    declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: at,
    references: fileId === 'proof' ? [{ type: 'order', id: 'order', field: 'deliveryPhotoFileIds' }] : [],
  });
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t), at };
}

test('HTTP survey-to-share lifecycle persists the single repeat and taps, including concurrent event retries without any reward', { skip: !DB }, async t => {
  const { db, api } = await setup(t);
  const survey = await api('client', 'POST', '/orders/order/survey', answers);
  assert.equal(survey.status, 200, JSON.stringify(survey.body));
  let response = await api('client', 'POST', '/orders/order/share/prepare', {});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.share.firstName, 'Ana');
  assert.equal(response.body.share.foundingTester, false);
  assert.equal(response.body.share.card.showAfterSurvey, true);
  const code = response.body.share.inviteCode;
  assert.ok(response.body.share.inviteLink.endsWith(code));
  assert.equal((await api('client', 'POST', '/orders/order/share/prepare', {})).body.share.inviteCode, code);
  const card = (presentation, action) => api('client', 'POST', '/orders/order/share/card', { presentation, action });
  assert.equal((await card('after_survey', 'shown')).status, 200);
  assert.equal((await card('after_survey', 'maybe_later')).body.share.card.showFromOrder, true);
  assert.equal((await card('after_survey', 'maybe_later')).body.share.card.showFromOrder, true);
  assert.equal((await card('order_repeat', 'shown')).body.share.card.showFromOrder, false);
  assert.equal((await card('order_repeat', 'maybe_later')).status, 200);
  assert.equal((await card('order_repeat', 'shown')).body.share.card.showFromOrder, false);
  const rewardKeys = ['vouchers', 'voucherCampaigns', 'voucherLedger', 'testerRewards', 'creditLedger'];
  const before = await loadStore(db), rewards = rewardKeys.map(key => before[key]);
  const eventId = crypto.randomUUID(), body = { eventId, action: 'share' };
  const replies = await Promise.all([api('client', 'POST', '/orders/order/share/taps', body), api('client', 'POST', '/orders/order/share/taps', body)]);
  assert.deepEqual(replies.map(r => r.status), [200, 200]);
  assert.deepEqual(replies.map(r => r.body.replay).sort(), [false, true]);
  assert.equal((await api('client', 'POST', '/orders/order/share/taps', { eventId, action: 'send_to_friend' })).body.error, 'share_tap_conflict');
  assert.equal((await api('client', 'POST', '/orders/order/share/taps', { eventId: crypto.randomUUID(), action: 'send_to_friend' })).status, 200);
  const after = await loadStore(db);
  assert.equal(after.orderShareTaps.length, 2); assert.equal(after.orderShareCards.length, 1);
  assert.ok(after.orderShareCards[0].repeatShownAt); assert.ok(after.orderShareCards[0].closedAt);
  assert.deepEqual(rewardKeys.map(key => after[key]), rewards);
  response = await api('ops', 'GET', '/ops/mission-shares?clientId=client');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.clients, [{ clientId: 'client', shareTaps: 1, sendToFriendTaps: 1 }]);
  assert.equal((await api('admin', 'GET', '/ops/mission-shares?clientId=client')).status, 200);
  await assert.rejects(db.query("UPDATE order_share_taps SET action='send_to_friend' WHERE client_id='client'"), /append-only/);
  await assert.rejects(db.query("DELETE FROM order_share_taps WHERE client_id='client'"), /append-only/);
  await assert.rejects(db.query("UPDATE order_share_cards SET repeat_shown_at=NULL WHERE order_id='order'"), /immutable/);
  assert.equal((await api('client', 'GET', '/orders/order/share')).body.share.card.showFromOrder, false);
});

test('HTTP delivered orders can share without a survey, with role/owner guards and strict event validation', { skip: !DB }, async t => {
  const { db, api } = await setup(t);
  assert.equal((await api('client', 'GET', '/orders/order/share')).body.share.available, true);
  assert.equal((await api('client', 'GET', '/orders/order/share')).body.share.card.showAfterSurvey, false);
  assert.equal((await api('client', 'POST', '/orders/order/share/taps', { eventId: crypto.randomUUID(), action: 'share' })).status, 200);
  assert.equal((await api('client', 'POST', '/orders/order/share/card', { presentation: 'after_survey', action: 'shown' })).body.error, 'share_card_not_available');
  for (const actor of [null, 'other', 'supplier', 'rider']) {
    const expected = actor === null ? 401 : actor === 'other' ? 404 : 403;
    for (const [method, suffix, body] of [['GET', '', null], ['POST', '/prepare', {}], ['POST', '/card', {}], ['POST', '/taps', { eventId: crypto.randomUUID(), action: 'share' }]]) {
      assert.equal((await api(actor, method, `/orders/order/share${suffix}`, body)).status, expected);
    }
  }
  for (const path of ['/ops/mission-shares', '/ops/delivery-reminders']) {
    for (const actor of [null, 'client', 'other', 'supplier', 'rider']) assert.equal((await api(actor, 'GET', path)).status, actor ? 403 : 401);
    for (const actor of ['ops', 'admin']) assert.equal((await api(actor, 'GET', path)).status, 200);
    assert.equal((await api('ops', 'GET', `${path}?limit=501`)).body.error, 'invalid_pagination');
    assert.equal((await api('ops', 'GET', `${path}?from=bad`)).body.error, 'invalid_share_filter');
  }
  assert.equal((await api('client', 'POST', '/orders/order/share/taps', { eventId: 'not-uuid', action: 'share' })).body.error, 'invalid_share_tap');
  assert.equal((await api('client', 'POST', '/orders/order/share/taps', { eventId: crypto.randomUUID(), action: 'completed_share' })).body.error, 'invalid_share_tap');
  await db.transaction(async () => {
    const store = await loadStore(db); store.orders[0].state = 'out_for_delivery'; delete store.orders[0].issueWindowOpenedAt;
    await saveStore(db, store);
  });
  assert.equal((await api('client', 'POST', '/orders/order/share/taps', { eventId: crypto.randomUUID(), action: 'share' })).body.error, 'order_share_not_available');
});

test('HTTP modern delivery refuses missing acknowledgement/consent and stores an optional attached package photo without changing payouts', { skip: !DB }, async t => {
  const { db, api } = await setup(t, 'out_for_delivery');
  let response = await api('rider', 'POST', '/dispatch/order/delivery', { ...delivery, remindedClient: false });
  assert.equal(response.status, 400); assert.equal(response.body.error, 'client_reminder_required');
  response = await api('rider', 'POST', '/dispatch/order/delivery', { evidenceType: 'photo', evidenceFileId: 'proof', handoffReminderVersion: 1 });
  assert.equal(response.body.error, 'client_reminder_required');
  let current = await loadStore(db);
  assert.equal(current.orders[0].state, 'out_for_delivery'); assert.equal(current.deliveryReminders.length, 0);
  assert.equal((await db.query('SELECT * FROM acknowledgement_receipts')).rowCount, 0);
  assert.equal((await api('rider', 'POST', '/files/package/attach', { orderId: 'order' })).status, 200);
  response = await api('rider', 'POST', '/dispatch/order/delivery', { ...delivery, packagePhotoFileId: 'package' });
  assert.equal(response.body.error, 'package_photo_consent_required');
  const before = await loadStore(db);
  response = await api('rider', 'POST', '/dispatch/order/delivery', { ...delivery, clientAgreedToPhoto: true, packagePhotoFileId: 'package' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.order.deliveryReminder.remindedClient, true);
  assert.equal(response.body.order.deliveryReminder.packagePhotoFileId, 'package');
  current = await loadStore(db);
  assert.equal(current.deliveryReminders.length, 1);
  assert.equal(current.orders[0].state, 'issue_window_open');
  assert.equal(current.orders[0].riderCommissionBps, before.orders[0].riderCommissionBps);
  for (const stage of current.orders[0].payoutMilestones) {
    const prior = before.orders[0].payoutMilestones.find(row => row.code === stage.code);
    assert.equal(stage.amountMinor, prior.amountMinor); assert.equal(stage.sharePercent, prior.sharePercent);
    assert.ok(!['released', 'paid'].includes(stage.status));
  }
  assert.equal(current.vouchers.length, 0); assert.equal(current.testerRewards.length, 0);
  for (const actor of ['client', 'rider', 'ops', 'admin']) assert.equal((await api(actor, 'GET', '/files/package')).status, 200);
  for (const actor of ['supplier', 'other']) assert.equal((await api(actor, 'GET', '/files/package')).status, 403);
  const supplierView = publicOrderFor(current.orders[0], current.users.find(u => u.id === 'supplier'), current);
  assert.equal(supplierView.deliveryReminder, undefined); assert.equal(supplierView.deliveryPackagePhotoFileIds, undefined);
  await assert.rejects(db.query("UPDATE delivery_reminders SET reminded_client=false WHERE order_id='order'"), /append-only/);
  current.claims.push({ id: 'open-claim', orderId: 'order', status: 'open' });
  assert.equal(retentionDecision(current, current.files.find(f => f.fileId === 'package'), '2035-01-01T00:00:00.000Z').eligible, false);
});

test('HTTP legacy riders finish without invented reminder consent, and optional consent needs no photo', { skip: !DB }, async t => {
  const { db, api } = await setup(t, 'out_for_delivery');
  const response = await api('rider', 'POST', '/dispatch/order/delivery', { evidenceType: 'photo', evidenceFileId: 'proof' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.order.deliveryReminder.protocolVersion, 0);
  assert.equal(response.body.order.deliveryReminder.remindedClient, false);
  assert.equal(response.body.order.deliveryReminder.clientAgreedToPhoto, false);
  assert.equal(response.body.order.deliveryReminder.packagePhotoFileId, null);
  await db.transaction(async () => {
    const store = await loadStore(db), order = structuredClone(store.orders[0]);
    Object.assign(order, { id: 'second', state: 'out_for_delivery', title: 'Flyers', quantity: 10 });
    delete order.deliveryEvidence; delete order.issueWindowOpenedAt; delete order.issueWindowExpiresAt;
    store.orders.push(order);
    store.files.find(f => f.fileId === 'proof').references.push({ type: 'order', id: 'second', field: 'deliveryPhotoFileIds' });
    await saveStore(db, store);
  });
  const modern = await api('rider', 'POST', '/dispatch/second/delivery', { ...delivery, clientAgreedToPhoto: true });
  assert.equal(modern.status, 200, JSON.stringify(modern.body));
  assert.equal(modern.body.order.deliveryReminder.packagePhotoFileId, null);
  const report = await api('ops', 'GET', '/ops/delivery-reminders');
  assert.equal(report.body.weeks[0].deliveries, 2);
  assert.equal(report.body.weeks[0].remindedDeliveries, 1);
  assert.equal(report.body.weeks[0].legacyDeliveries, 1);
  assert.equal(report.body.weeks[0].reminderRate, 0.5);
});

test('PostgreSQL weekly dashboard counts Manila delivery cohorts and deduplicates same-order survey/share follow-through', { skip: !DB }, async t => {
  const { db, api } = await setup(t);
  await db.transaction(async () => {
    const store = await loadStore(db), original = store.orders[0];
    const cases = [
      ['2026-10-25T15:59:59Z', 'rider', false],
      ['2026-10-25T16:00:00Z', 'rider', true],
      ['2026-10-26T01:00:00Z', 'rider', true],
      ['2026-10-26T02:00:00Z', 'rider', false],
      ['2026-10-26T02:00:00Z', 'other-rider', true],
    ];
    store.users.push({ ...store.users.find(u => u.id === 'rider'), id: 'other-rider', clerkUserId: 'clerk_other-rider', email: 'other-rider@example.invalid' });
    for (const [index, [deliveredAt, riderId, remindedClient]] of cases.entries()) {
      const orderId = `delivery-${index}`, order = { ...structuredClone(original), id: orderId, riderId,
        issueWindowOpenedAt: new Date(deliveredAt).toISOString(), deliveryEvidence: { riderId, recordedAt: new Date(deliveredAt).toISOString() } };
      store.orders.push(order);
      if (index !== 0) store.deliveryReminders.push({ orderId, clientId: 'client', riderId, deliveredAt,
        protocolVersion: remindedClient ? 1 : 0, remindedClient, clientAgreedToPhoto: false, packagePhotoFileId: null });
    }
    syncSurveys(store, { at: new Date().toISOString(), id });
    await saveStore(db, store);
  });
  for (const index of [1, 2, 4]) assert.equal((await api('client', 'POST', `/orders/delivery-${index}/survey`, answers)).status, 200);
  for (const [index, action] of [[1, 'share'], [1, 'share'], [2, 'send_to_friend'], [3, 'share'], [4, 'share']]) {
    assert.equal((await api('client', 'POST', `/orders/delivery-${index}/share/taps`, { eventId: crypto.randomUUID(), action })).status, 200);
  }
  let response = await api('ops', 'GET', '/ops/delivery-reminders?riderId=rider');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.timezone, 'Asia/Manila'); assert.equal(response.body.total, 2);
  assert.deepEqual(response.body.weeks, [
    { riderId: 'rider', week: '2026-W44', weekStart: '2026-10-26', deliveries: 3, remindedDeliveries: 2,
      legacyDeliveries: 1, surveySubmittedDeliveries: 2, shareTappedDeliveries: 1, surveyAndShareDeliveries: 1, reminderRate: 2 / 3 },
    { riderId: 'rider', week: '2026-W43', weekStart: '2026-10-19', deliveries: 1, remindedDeliveries: 0,
      legacyDeliveries: 1, surveySubmittedDeliveries: 0, shareTappedDeliveries: 0, surveyAndShareDeliveries: 0, reminderRate: 0 },
  ]);
  response = await api('admin', 'GET', '/ops/delivery-reminders?from=2026-10-25T16:00:00Z&to=2026-10-26T02:00:00Z');
  assert.equal(response.body.total, 1); assert.equal(response.body.weeks[0].deliveries, 2);
  assert.equal((await api('ops', 'GET', '/ops/delivery-reminders?limit=1&offset=1')).body.weeks.length, 1);
});
