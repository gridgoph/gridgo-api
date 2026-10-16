import { resetDatabase } from './fixtures/reset-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, id } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { syncSurveys, submitSurvey, surveyReport } from '../src/surveys.js';
import { routeSurveys } from '../src/survey-routes.js';
import { publicOrderFor } from '../src/operational-model.js';

const DB = process.env.DATABASE_URL;
const answers = { fulfillmentStars: 2, fulfillmentTags: ['late'], easeStars: 4, easeTags: ['easy_checkout'], priceFeeling: 3,
  expectedPriceMinor: 10000, qualityStars: 5, recommendScore: 6, improvementNote: '=Fix the delay, please\nThank you' };
async function setup(db, state = 'issue_window_open') {
  assert.match(new URL(DB).pathname, /(?:_|-)test(?:_|$)/);
  await resetDatabase(db, 'TRUNCATE users, platform_settings, voucher_campaigns RESTART IDENTITY CASCADE');
  const store = fixture(), at = new Date().toISOString();
  store.surveyLaunchedAt = (await db.query('SELECT launched_at FROM survey_launch')).rows[0].launched_at;
  Object.assign(store.orders[0], { state, ...(state === 'awaiting_collection' ? { fulfillmentMode: 'pickup' } : {}), issueWindowOpenedAt: state === 'issue_window_open' ? at : undefined,
    issueWindowExpiresAt: state === 'issue_window_open' ? new Date(Date.parse(at) + 86400000).toISOString() : undefined });
  await db.transaction(() => saveStore(db, store));
  return at;
}

test('PostgreSQL serializes same-order retries and simultaneous orders; constraints and rollback protect rewards', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  const at = await setup(db);
  await db.transaction(async () => {
    const store = await loadStore(db);
    // Copy a legacy graph with no final line snapshot to exercise two order keys.
    store.orders.push({ ...structuredClone(store.orders[0]), id: 'second' });
    syncSurveys(store, { id, at }); await saveStore(db, store);
  });
  const submit = orderId => db.transaction(async () => {
    const store = await loadStore(db);
    const response = submitSurvey(store, store.orders.find(o => o.id === orderId), answers, { id, at });
    await saveStore(db, store); return response;
  });
  const results = await Promise.all([submit('order'), submit('order'), submit('second')]);
  assert.equal(results[0].reward.id, results[1].reward.id);
  assert.equal(results[2].rewardStatus, 'cooldown');
  let store = await loadStore(db);
  assert.equal(store.orderSurveys.length, 2); assert.equal(store.vouchers.length, 1);
  assert.equal(store.voucherLedger.filter(e => e.kind === 'issued').length, 1);
  assert.deepEqual(store.orderSurveys[0].fulfillmentTags, ['late']);
  assert.equal(store.voucherEmailOutbox.length, 0);
  assert.ok(store.notifications.some(n => n.type === 'voucher_issued' && n.userId === 'client' && n.push === false));
  for (const userId of ['ops', 'admin']) assert.ok(store.notifications.some(n => n.type === 'order_survey_submitted' && n.userId === userId));
  const voucherId = store.vouchers[0].id;
  await assert.rejects(db.query("UPDATE order_surveys SET fulfillment_stars=5 WHERE order_id='order'"), /immutable/);
  await assert.rejects(db.query("UPDATE order_surveys SET reward_voucher_id=NULL WHERE order_id='order'"), /immutable/);
  await assert.rejects(db.query("DELETE FROM order_surveys WHERE order_id='order'"), /immutable/);
  await assert.rejects(db.query("UPDATE survey_launch SET launched_at=now()"), /append only/);
  const report = surveyReport(store, new URLSearchParams('limit=1'));
  assert.equal(report.total, 2); assert.equal(report.responses.length, 1); assert.equal(report.aggregates.nps, -100);
  const csv = surveyReport(store, new URLSearchParams('limit=1&format=csv')).bytes.toString();
  assert.ok(csv.includes('"second"')); assert.ok(csv.includes('"order"')); assert.ok(csv.includes("'=Fix"));
  const ownerProjection = publicOrderFor(store.orders[0], store.users.find(u => u.id === 'client'), store);
  assert.equal(ownerProjection.orderSurveys, undefined);
  await db.transaction(async () => {
    const current = await loadStore(db);
    const next = new Date(Date.parse(at) + 7 * 86400000).toISOString();
    current.orders.push({ ...structuredClone(current.orders[0]), id: 'future', issueWindowOpenedAt: next });
    syncSurveys(current, { id, at: next }); await saveStore(db, current);
  });
  await assert.rejects(db.transaction(async () => {
    const current = await loadStore(db), next = new Date(Date.parse(at) + 7 * 86400000).toISOString();
    submitSurvey(current, current.orders.find(o => o.id === 'future'), answers, { id, at: next });
    await saveStore(db, current); throw new Error('simulate rollback');
  }), /simulate rollback/);
  store = await loadStore(db);
  assert.deepEqual(store.vouchers.map(v => v.id), [voucherId]);
  assert.equal(store.orderSurveys.find(s => s.orderId === 'future').submittedAt, null);
});

test('HTTP collection triggers one survey notice; owning client submits; only Admin reads responses', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  await setup(db, 'awaiting_collection');
  const api = await apiForTest(t);
  const pickupAnswers = { ...answers, fulfillmentTags: ['long_wait'] };
  assert.equal((await api(null, 'GET', '/me/surveys')).status, 401);
  assert.equal((await api('client', 'GET', '/orders/order/survey')).body.survey, null);
  const completion = await api('ops', 'POST', '/orders/order/collection', { receivedBy: 'Test client' });
  assert.equal(completion.status, 200, JSON.stringify(completion.body));
  const card = await api('client', 'GET', '/orders/order/survey');
  assert.equal(card.status, 200); assert.equal(card.body.survey.status, 'open');
  assert.equal(card.body.survey.fulfillmentKind, 'pickup');
  assert.match(card.headers.get('cache-control'), /no-store/);
  assert.equal((await api('other', 'GET', '/orders/order/survey')).status, 404);
  assert.equal((await api('supplier', 'GET', '/orders/order/survey')).status, 403);
  const dismiss = await api('client', 'POST', '/orders/order/survey/dismiss', {});
  assert.equal(dismiss.status, 200); assert.ok(dismiss.body.survey.dismissedAt);
  assert.equal((await api('client', 'GET', '/me/surveys')).body.surveys.length, 1);
  const posted = await api('client', 'POST', '/orders/order/survey', pickupAnswers);
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(posted.body.survey.reward.valueMinor, 1500); assert.ok(posted.body.survey.reportProblem);
  assert.equal((await api('client', 'POST', '/orders/order/survey', pickupAnswers)).body.survey.reward.id, posted.body.survey.reward.id);
  assert.equal((await api('client', 'GET', '/me/surveys')).body.surveys.length, 0);
  const wallet = await api('client', 'GET', '/me/vouchers');
  assert.equal(wallet.body.vouchers[0].code, posted.body.survey.reward.code);
  for (const actor of ['client', 'supplier', 'rider', 'ops']) {
    assert.equal((await api(actor, 'GET', '/admin/survey-responses')).status, 403);
    assert.equal((await api(actor, 'GET', '/admin/survey-responses?format=csv')).status, 403);
  }
  const report = await api('admin', 'GET', '/admin/survey-responses?needsFollowUp=true&tag=long_wait');
  assert.equal(report.body.total, 1); assert.equal(report.body.aggregates.nps, -100);
  const exportResult = await api('admin', 'GET', '/admin/survey-responses?format=csv', null, { raw: true });
  assert.equal(exportResult.status, 200); assert.match(exportResult.headers.get('content-type'), /text\/csv/);
  assert.match(exportResult.headers.get('content-disposition'), /survey-responses.csv/); assert.ok(exportResult.body.includes("'=Fix"));
  assert.equal((await api('admin', 'GET', '/admin/survey-responses?needsFollowUp=maybe')).status, 400);
  assert.equal((await api('admin', 'POST', `/admin/voucher-campaigns/${posted.body.survey.reward.campaignId}/issue`, { emails: ['other@example.invalid'] })).status, 409);
  const store = await loadStore(db);
  assert.equal(store.notifications.filter(n => n.type === 'order_survey_available' && n.userId === 'client').length, 1);
  assert.equal(store.issues.length, 0); assert.equal(store.claims.length, 0);
  const csvResponse = await routeSurveys({ req: { method: 'GET' }, url: new URL('http://api/admin/survey-responses?format=csv'),
    store, user: { id: 'admin', role: 'super_admin' }, now: () => new Date().toISOString() });
  assert.equal(csvResponse.filename, 'survey-responses.csv'); assert.ok(csvResponse.bytes.toString().includes("'=Fix"));
});


test('HTTP rider delivery queues a survey atomically with the existing push outbox', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  await setup(db, 'out_for_delivery');
  await db.transaction(async () => {
    const store = await loadStore(db), at = new Date().toISOString();
    store.orders[0].riderId = 'rider';
    store.deviceTokens.push({ id: 'survey-device', userId: 'client', token: 'survey-test-token-1234567890-test-only', platform: 'android', appRole: 'client', tokenProvider: 'fcm', createdAt: at, updatedAt: at });
    store.approvalCases.push({ id: 'case_rider', userId: 'rider', kind: 'rider', status: 'approved', version: 1,
      applicationRevision: 1, submittedAt: at, decidedAt: at, createdAt: at, updatedAt: at });
    store.files.push({ fileId: 'delivery-proof', ownerId: 'rider', purpose: 'delivery_photo', state: 'ready', objectKey: 'private/delivery-proof',
      originalFilename: 'proof.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: at,
      references: [{ type: 'order', id: 'order', field: 'deliveryEvidence' }] });
    await saveStore(db, store);
  });
  const api = await apiForTest(t);
  const result = await api('rider', 'POST', '/dispatch/order/delivery', { evidenceType: 'photo', evidenceFileId: 'delivery-proof' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const store = await loadStore(db);
  assert.equal(store.orderSurveys.length, 1); assert.equal(store.orderSurveys[0].fulfillmentKind, 'delivery');
  const notification = store.notifications.find(n => n.userId === 'client' && n.type === 'order_survey_available');
  assert.ok(notification); assert.equal(notification.push, undefined);
  assert.equal((await db.query('SELECT * FROM notification_push_outbox WHERE notification_id=$1', [notification.id])).rowCount, 1);
  assert.equal(store.vouchers.length, 0);
  assert.equal((await api('client', 'GET', '/orders/order/survey')).body.survey.status, 'open');
});

test('database rejects a second reward inside seven days even if application policy is bypassed', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  const at = await setup(db);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.orders.push({ ...structuredClone(store.orders[0]), id: 'second' });
    syncSurveys(store, { id, at });
    submitSurvey(store, store.orders[0], answers, { id, at });
    await saveStore(db, store);
  });
  await assert.rejects(db.transaction(async () => {
    await db.query(`INSERT INTO voucher_campaigns(id,name,code,purpose,mode,status,value_minor,total_limit,per_account_limit,validity_days,created_at,updated_at)
      VALUES ('bypass-campaign','Bypass','BYPASS','survey','assigned','active',1500,1,1,30,$1,$1)`, [at]);
    await db.query(`INSERT INTO vouchers(id,campaign_id,client_id,status,value_minor,issued_at,expires_at)
      VALUES ('bypass-voucher','bypass-campaign','client','available',1500,$1,$1::timestamptz + interval '720 hours')`, [at]);
    await db.query(`UPDATE order_surveys SET submitted_at=$1,fulfillment_stars=5,ease_stars=5,price_feeling=3,
      reward_status='issued',reward_voucher_id='bypass-voucher' WHERE order_id='second'`, [at]);
  }), /survey reward cooldown/);
  assert.equal((await db.query('SELECT * FROM vouchers')).rowCount, 1);
});

test('launch lifecycle backfills recent legacy completions once without another order mutation', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  await setup(db, 'completed');
  let launchedAt;
  await db.transaction(async () => {
    const store = await loadStore(db); launchedAt = store.surveyLaunchedAt;
    const completion = new Date(Date.parse(launchedAt) - 14 * 86400000).toISOString();
    store.orders[0].timeline = [{ state: 'delivered', at: completion, by: 'rider' }];
    store.orders.push({ ...structuredClone(store.orders[0]), id: 'too-old', timeline: [{ state: 'delivered', at: new Date(Date.parse(completion) - 1).toISOString() }] });
    await saveStore(db, store);
  });
  const api = await apiForTest(t);
  let store;
  for (let n = 0; n < 100; n++) {
    store = await loadStore(db);
    if (store.orderSurveys.length) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(store.orderSurveys.length, 1);
  assert.equal(store.orderSurveys[0].orderId, 'order');
  assert.equal(store.orderSurveys[0].openedAt, launchedAt);
  assert.equal(store.orderSurveys[0].expiresAt, new Date(Date.parse(launchedAt) + 7 * 86400000).toISOString());
  assert.equal((await api('client', 'GET', '/orders/too-old/survey')).body.survey, null);
  assert.equal(store.notifications.filter(n => n.type === 'order_survey_available' && n.userId === 'client').length, 1);
});
