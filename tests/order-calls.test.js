import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, AT, id } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { callParty, callWindow, publicCall, iceConfiguration, parseCallSignal, purgeClosedCalls, reconcileCalls, routeOrderCalls } from '../src/order-calls.js';
import { pushMessageFor, fcmRequestBody } from '../src/push.js';
import { deviceAcceptsNotification } from '../src/push-outbox.js';
import { createRealtimeTransport } from '../src/realtime-transport.js';
import { createNotificationEvents, queueInvalidate, invalidateAudienceIds, takeQueuedInvalidates } from '../src/notifications.js';
const DATABASE_URL = process.env.DATABASE_URL;
const BASE = '/orders/order/calls';
const SDP = 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';

test('call windows and parties: only approved assigned pairs and active delivery/pre-pickup', () => {
  const store = fixture(), order = { ...store.orders[0], riderId: 'rider' };
  for (const state of ['production', 'ready_for_dispatch', 'rider_assigned', 'picked_up', 'out_for_delivery', 'issue_window_open', 'completed', 'cancelled', 'awaiting_collection']) {
    order.state = state;
    assert.equal(callWindow(order, 'delivery', AT), ['rider_assigned', 'picked_up', 'out_for_delivery'].includes(state), state);
    assert.equal(callWindow(order, 'pickup', AT), state === 'rider_assigned', state);
  }
  order.state = 'rider_assigned'; order.fulfillmentMode = 'pickup';
  assert.equal(callWindow(order, 'delivery', AT), false);
  assert.equal(callWindow(order, 'pickup', AT), true);
  for (const pair of ['delivery', 'pickup']) for (const actor of store.users) {
    const expected = (pair === 'delivery' ? ['client','rider'] : ['supplier','rider']).includes(actor.id) ? actor.role : null;
    assert.equal(callParty(actor, order, store, pair), expected, `${pair}:${actor.id}`);
  }
  store.users.find(u => u.id === 'rider').verificationStatus = 'pending';
  assert.equal(callParty({ id: 'rider', role: 'rider' }, order, store, 'delivery'), null);
  assert.equal(callParty({ id: 'rider', role: 'rider' }, order, store, 'pickup'), null);
});

test('ICE credentials: STUN fallback, bounded Unix expiry, random identity and coturn HMAC-SHA1', () => {
  assert.equal(iceConfiguration({}, AT).relayAvailable, false);
  assert.equal(iceConfiguration({ TURN_URLS: 'turn:relay.test:3478' }, AT).relayAvailable, false);
  const env = { TURN_URLS: 'turn:relay.test:3478,turns:relay.test:5349?transport=tcp', TURN_SHARED_SECRET: 'test-secret', TURN_CREDENTIAL_TTL_SECONDS: '600' };
  const result = iceConfiguration(env, AT), turn = result.iceServers[1];
  assert.equal(Date.parse(result.expiresAt), Date.parse(AT) + 600000);
  assert.match(turn.username, /^\d+:[a-f0-9]{32}$/);
  assert.equal(Number(turn.username.split(':')[0]) * 1000, Date.parse(result.expiresAt));
  assert.equal(turn.credential, crypto.createHmac('sha1', env.TURN_SHARED_SECRET).update(turn.username).digest('base64'));
  assert.notEqual(iceConfiguration(env, AT).iceServers[1].username, turn.username);
  assert.equal(Date.parse(iceConfiguration({ ...env, TURN_CREDENTIAL_TTL_SECONDS: '999999' }, AT).expiresAt), Date.parse(AT) + 3600000);
  assert.equal(Date.parse(iceConfiguration({ ...env, TURN_CREDENTIAL_TTL_SECONDS: '-1' }, AT).expiresAt), Date.parse(AT) + 60000);
});

test('signals reject video/data/contact identity and bound SDP/ICE; allowlisted output', () => {
  assert.deepEqual(parseCallSignal({ clientId: 's1', kind: 'offer', sdp: SDP, phone: 'private' }), { clientId: 's1', kind: 'offer', payload: { sdp: SDP } });
  for (const sdp of [SDP.replace('m=audio', 'm=video'), SDP + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n', SDP + 'e=private@example.test\r\n', SDP + 'p=09123456789\r\n', 'x'.repeat(60001)]) {
    assert.equal(parseCallSignal({ clientId: 's1', kind: 'offer', sdp }), null);
  }
  const sanitized = parseCallSignal({ clientId: 's1', kind: 'offer', sdp: SDP.replace('o=-', 'o=PrivateSurname').replace('s=-', 's=Full Name') });
  assert.equal(sanitized.payload.sdp, SDP);
  assert.equal(parseCallSignal({ clientId: 's1', kind: 'ice', candidate: 'x'.repeat(2049) }), null);
  assert.equal(parseCallSignal({ clientId: 's1', kind: 'ice', candidate: 'candidate:a\nprivate' }), null);
});

test('call projection never copies identifiers, phone, email or surnames', () => {
  const store = fixture();
  store.users.find(u => u.id === 'client').name = 'Alex PrivateSurname';
  store.users.find(u => u.id === 'rider').name = '09123456789';
  const call = { id: 'call', order_id: 'order', pair: 'delivery', state: 'ringing', caller_id: 'client', caller_role: 'client', callee_id: 'rider', callee_role: 'rider' };
  const result = publicCall(call, store, 'client');
  assert.deepEqual(result.caller, { firstName: 'Alex', role: 'client' });
  assert.deepEqual(result.callee, { firstName: 'Rider', role: 'rider' });
  assert.ok(!/PrivateSurname|09123456789|@|caller_id|callee_id|clerk/i.test(JSON.stringify(result)));
});

async function setup(t, patch = {}) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await db.query('TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture(); Object.assign(store.orders[0], { riderId: 'rider', state: 'rider_assigned', ...patch });
  store.users.find(u => u.id === 'client').name = 'Alex PrivateSurname';
  store.users.push({ id: 'rider2', role: 'rider', name: 'Taylor PrivateSurname', email: 'rider2@example.invalid', clerkUserId: 'clerk_rider2', verificationStatus: 'approved', createdAt: AT });
  store.userRoleMemberships.push({ userId: 'rider2', role: 'rider', createdAt: AT });
  for (const userId of ['rider', 'rider2', 'client', 'supplier']) {
    const role = store.users.find(u => u.id === userId).role;
    store.deviceTokens.push({ id: `device_${userId}`, userId, appRole: role, token: `${userId}:` + 'x'.repeat(120), tokenProvider: 'fcm', platform: 'android', createdAt: AT, updatedAt: AT });
  }
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t) };
}
async function patchOrder(db, patch) {
  await db.transaction(async () => { const store = await loadStore(db); Object.assign(store.orders[0], patch); await saveStore(db, store); });
}
const httpTest = (name, fn) => test(name, { skip: !DATABASE_URL }, fn);

httpTest('HTTP lifecycle, every party boundary, cross-order protection, safe pushes and signal retries', async t => {
  const { db, api } = await setup(t);
  for (const actor of [null, 'ops', 'admin', 'other', 'replacement', 'rider2']) {
    assert.equal((await api(actor, 'POST', BASE, { pair: 'delivery' })).status, actor ? 403 : 401, actor);
  }
  assert.equal((await api('supplier', 'POST', BASE, { pair: 'delivery' })).status, 403);
  assert.equal((await api('client', 'POST', BASE, { pair: 'pickup' })).status, 403);
  const start = await api('client', 'POST', BASE, { pair: 'delivery' });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const path = `${BASE}/${start.body.call.id}`;
  assert.equal(start.body.call.state, 'ringing');
  assert.deepEqual(start.body.call.caller, { firstName: 'Alex', role: 'client' });
  assert.equal((await api('rider', 'POST', BASE, { pair: 'delivery' })).body.error, 'call_already_active');
  for (const actor of ['supplier', 'ops', 'admin', 'other', 'replacement', 'rider2']) for (const action of ['', '/accept', '/decline', '/cancel', '/end', '/heartbeat', '/signals', '/ice']) {
    const r = await api(actor, ['', '/ice'].includes(action) ? 'GET' : 'POST', path + action, ['', '/ice'].includes(action) ? undefined : {});
    assert.ok([403,404].includes(r.status), `${actor} ${action}: ${JSON.stringify(r.body)}`);
  }
  await patchOrder(db, {});
  await db.transaction(async () => {
    const store = await loadStore(db); const other = structuredClone(store.orders[0]); other.id = 'order2'; store.orders.push(other); await saveStore(db, store);
  });
  assert.equal((await api('rider', 'GET', path.replace('/order/', '/order2/'))).status, 404);
  assert.equal((await api('client', 'POST', path + '/accept', {})).body.error, 'invalid_call_transition');
  assert.equal((await api('rider', 'POST', path + '/cancel', {})).body.error, 'invalid_call_transition');
  assert.equal((await api('rider', 'GET', path + '/ice')).body.relayAvailable, false);
  const offer = { clientId: 'offer-1', kind: 'offer', sdp: SDP };
  const sent = await api('client', 'POST', path + '/signals', offer);
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.deepEqual((await api('client', 'POST', path + '/signals', offer)).body, sent.body);
  assert.equal((await api('client', 'POST', path + '/signals', { ...offer, sdp: SDP + 'a=sendrecv\r\n' })).body.error, 'call_signal_conflict');
  assert.equal((await api('rider', 'POST', path + '/signals', { ...offer, kind: 'answer' })).status, 409);
  const accept = await api('rider', 'POST', path + '/accept', {});
  assert.equal(accept.body.call.state, 'accepted');
  const answer = await api('rider', 'POST', path + '/signals', { ...offer, kind: 'answer' });
  assert.equal(answer.status, 201);
  const ice = await api('rider', 'POST', path + '/signals', { clientId: 'ice-1', kind: 'ice', candidate: 'candidate:1 1 UDP 1 192.0.2.1 1234 typ host', sdpMid: '0', sdpMLineIndex: 0, email: 'private' });
  assert.equal(ice.status, 201);
  const signals = await api('client', 'GET', path + '/signals?after=0');
  assert.deepEqual(signals.body.signals.map(s => s.kind), ['answer','ice']);
  assert.ok(!JSON.stringify(signals.body).includes('private'));
  assert.equal((await api('client', 'GET', path + `/signals?after=${signals.body.cursor}`)).body.signals.length, 0);
  assert.equal((await api('client', 'POST', path + '/heartbeat', {})).status, 200);
  assert.equal((await api('rider', 'POST', path + '/end', {})).body.call.state, 'ended');
  assert.equal((await db.query('SELECT 1 FROM order_call_signals')).rowCount, 0);
  const store = await loadStore(db);
  const incoming = store.notifications.find(n => n.type === 'order_call_incoming');
  assert.equal(incoming.userId, 'rider'); assert.equal(incoming.push, false);
  const push = pushMessageFor(incoming), fcm = fcmRequestBody(push, 'token');
  assert.equal(push.title, 'Incoming voice call'); assert.equal(push.data.type, 'order_call_incoming');
  assert.deepEqual(Object.keys(push.data).sort(), ['at','notificationId','orderId','type']);
  assert.equal(fcm.message.android.priority, 'high'); assert.equal(fcm.message.android.ttl, '0s');
  assert.equal(fcm.message.apns.headers['apns-expiration'], '0');
  assert.ok(!/PrivateSurname|@|Alex/.test(JSON.stringify(push)));
  assert.equal(deviceAcceptsNotification(store, store.deviceTokens.find(d => d.userId === 'rider'), incoming, new Date(Date.parse(incoming.callExpiresAt) + 1).toISOString()), false);
  assert.deepEqual([...new Set(store.notifications.filter(n => n.type === 'order_call_activity').map(n => n.userId))].sort(), ['admin','ops']);
  const outbox = await db.query(`SELECT user_id FROM notification_push_outbox WHERE notification_id = $1`, [incoming.id]);
  assert.deepEqual(outbox.rows.map(r => r.user_id), ['rider']);
});

httpTest('HTTP both pair directions, decline/cancel notify once, pickup window and hub eligibility', async t => {
  const { db, api } = await setup(t);
  for (const [caller, pair, callee] of [['client','delivery','rider'], ['rider','delivery','client'], ['supplier','pickup','rider'], ['rider','pickup','supplier']]) {
    const start = await api(caller, 'POST', BASE, { pair }); assert.equal(start.status, 201, JSON.stringify(start.body));
    const path = `${BASE}/${start.body.call.id}`;
    assert.equal((await api(callee, 'POST', path + '/decline', {})).body.call.state, 'declined');
    assert.equal((await api(callee, 'POST', path + '/decline', {})).body.error, 'call_not_active');
  }
  const start = await api('supplier', 'POST', BASE, { pair: 'pickup' });
  assert.equal((await api('supplier', 'POST', `${BASE}/${start.body.call.id}/cancel`, {})).body.call.state, 'cancelled');
  assert.equal((await loadStore(db)).notifications.filter(n => n.type === 'order_call_missed').length, 5);
  await patchOrder(db, { state: 'picked_up' });
  assert.equal((await api('supplier', 'POST', BASE, { pair: 'pickup' })).body.error, 'call_not_available');
});

httpTest('HTTP hub trips allow shop calls but never client calls', async t => {
  const { api } = await setup(t, { fulfillmentMode: 'pickup' });
  assert.equal((await api('client', 'POST', BASE, { pair: 'delivery' })).body.error, 'call_not_available');
  assert.equal((await api('supplier', 'POST', BASE, { pair: 'pickup' })).status, 201);
});

httpTest('ring timeout persists missed once; no late accept; independent pair and concurrent starts', async t => {
  const { db, api } = await setup(t);
  const starts = await Promise.all([api('client','POST', BASE, { pair:'delivery' }), api('rider','POST', BASE, { pair:'delivery' })]);
  assert.deepEqual(starts.map(r => r.status).sort(), [201,409]);
  assert.equal((await api('supplier', 'POST', BASE, { pair:'pickup' })).status, 201);
  const call = starts.find(r => r.status === 201).body.call;
  await db.query("UPDATE order_calls SET ring_expires_at = now() - interval '1 second' WHERE id = $1", [call.id]);
  const read = await api('client','GET', `${BASE}/${call.id}`);
  assert.equal(read.body.call.state, 'missed');
  assert.equal((await api(call.callee.role, 'POST', `${BASE}/${call.id}/accept`, {})).body.error, 'call_not_active');
  await api('client','GET', BASE);
  const missed = (await loadStore(db)).notifications.filter(n => n.type === 'order_call_missed');
  assert.equal(missed.length, 1); assert.equal(missed[0].appRole, call.callee.role);
  assert.equal(pushMessageFor(missed[0]).data.type, 'order_call_missed');
});

httpTest('reassignment revokes old rider, expiry clears stale accepted calls and chat sweep removes records', async t => {
  const { db, api } = await setup(t);
  let start = await api('supplier','POST', BASE, { pair:'pickup' });
  await api('rider','POST', `${BASE}/${start.body.call.id}/accept`, {});
  await patchOrder(db, { state:'picked_up' });
  assert.equal((await api('supplier','GET', `${BASE}/${start.body.call.id}`)).body.call.state, 'ended');
  start = await api('client','POST', BASE, { pair:'delivery' });
  await api('rider','POST', `${BASE}/${start.body.call.id}/accept`, {});
  await db.query("UPDATE order_calls SET caller_seen_at = now() - interval '91 seconds' WHERE id = $1", [start.body.call.id]);
  assert.equal((await api('client','GET', `${BASE}/${start.body.call.id}`)).body.call.state, 'ended');
  start = await api('client','POST', BASE, { pair:'delivery' });
  await patchOrder(db, { riderId:'rider2', state:'rider_assigned' });
  assert.equal((await api('rider','GET', `${BASE}/${start.body.call.id}`)).status, 403);
  assert.equal((await api('rider2','GET', `${BASE}/${start.body.call.id}`)).status, 404);
  assert.equal((await api('client','GET', BASE)).body.calls.length, 0);
  await db.transaction(async () => purgeClosedCalls(db, await loadStore(db), new Date().toISOString()));
  assert.equal((await db.query('SELECT 1 FROM order_calls')).rowCount, 0);
  start = await api('client','POST', BASE, { pair:'delivery' });
  await patchOrder(db, { state:'issue_window_open', deliveryEvidence:{ recordedAt: new Date().toISOString() } });
  assert.equal((await api('client','POST', BASE, { pair:'delivery' })).body.error, 'call_not_available');
  assert.equal((await api('client','GET', `${BASE}/${start.body.call.id}`)).body.call.state, 'ended');
  await db.transaction(async () => purgeClosedCalls(db, await loadStore(db), new Date().toISOString()));
  assert.equal((await db.query('SELECT 1 FROM order_calls')).rowCount, 1);
  await db.transaction(async () => purgeClosedCalls(db, await loadStore(db), new Date(Date.now() + 25 * 3600000).toISOString()));
  assert.equal((await db.query('SELECT 1 FROM order_calls')).rowCount, 0);
});

httpTest('reconcile queues only private party pointers; role revocation ends calls and prevents ICE/signals', async t => {
  const { db, api } = await setup(t);
  const start = await api('supplier','POST', BASE, { pair:'pickup' });
  await db.transaction(async () => {
    const store = await loadStore(db);
    Object.assign(store.approvalCases.find(c => c.userId === 'supplier'), { status: 'suspended', suspensionReason: 'Test suspension' });
    assert.equal(await reconcileCalls(db, store, { createId:id, at: new Date().toISOString() }), 1);
    const queued = takeQueuedInvalidates(store).filter(e => e.resource === 'calls');
    assert.equal(queued.length, 1);
    assert.deepEqual(invalidateAudienceIds(store, queued[0]).sort(), ['rider','supplier']);
    await saveStore(db, store);
  });
  for (const action of ['/ice','/signals']) assert.equal((await api('supplier','GET', `${BASE}/${start.body.call.id}${action}`)).status, 403);
});

httpTest('silent phones time out without any call API read', async t => {
  const { db, api } = await setup(t);
  const start = await api('client', 'POST', BASE, { pair: 'delivery' });
  await db.query("UPDATE order_calls SET ring_expires_at = now() - interval '1 second' WHERE id = $1", [start.body.call.id]);
  let state;
  for (let i = 0; i < 100; i++) {
    state = (await db.query('SELECT state FROM order_calls WHERE id = $1', [start.body.call.id])).rows[0].state;
    if (state === 'missed') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(state, 'missed');
  assert.equal((await loadStore(db)).notifications.filter(n => n.type === 'order_call_missed').length, 1);
});

httpTest('signalling prompts reach only the two parties on a separate PostgreSQL listener; rollback sends none', async t => {
  const { db, api } = await setup(t);
  const events = createNotificationEvents(), frames = [];
  for (const userId of ['client','rider','supplier','ops','admin','rider2']) {
    events.subscribeInvalidate(userId, payload => { if (payload.resource === 'calls') frames.push({ userId, payload }); });
  }
  const transport = createRealtimeTransport({ database: db, loadStore, events, connectionString: DATABASE_URL });
  t.after(() => transport.close()); await transport.start();
  const start = await api('client', 'POST', BASE, { pair: 'delivery' });
  const waitFor = async n => {
    for (let i = 0; i < 100 && frames.length < n; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(frames.length, n);
  };
  await waitFor(2);
  assert.deepEqual(frames.map(f => f.userId).sort(), ['client','rider']);
  frames.length = 0;
  await api('client', 'POST', `${BASE}/${start.body.call.id}/signals`, { clientId: 's1', kind: 'offer', sdp: SDP });
  await waitFor(2);
  assert.deepEqual(frames.map(f => f.userId).sort(), ['client','rider']);
  assert.ok(frames.every(f => JSON.stringify(f.payload) === '{"resource":"calls","id":"order"}'));
  frames.length = 0;
  await assert.rejects(db.transaction(async () => {
    const store = await loadStore(db);
    queueInvalidate(store, { resource: 'calls', id: 'order', userIds: ['client','rider'] });
    await transport.enqueue(store, []);
    throw new Error('roll back');
  }), /roll back/);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(frames, []);
});

httpTest('invalid UUIDs, selected roles and empty payloads fail closed', async t => {
  const { db, api } = await setup(t);
  assert.equal((await api('client', 'GET', `${BASE}/${'a'.repeat(36)}`)).status, 404);
  assert.equal((await api('client', 'POST', BASE, {})).status, 400);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.userRoleMemberships.push({ userId: 'supplier', role: 'client', createdAt: AT });
    await saveStore(db, store);
  });
  assert.equal((await api('supplier', 'POST', BASE, { pair: 'pickup' }, { headers: { 'x-gridgo-role': 'client' } })).status, 403);
  assert.equal((await api('supplier', 'POST', BASE, { pair: 'pickup' }, { headers: { 'x-gridgo-role': 'supplier' } })).status, 201);
});

httpTest('signal budget and caller rate limit are durable database limits', async t => {
  const { db, api } = await setup(t);
  let start = await api('client', 'POST', BASE, { pair: 'delivery' });
  await db.query(`INSERT INTO order_call_signals (call_id, sender_id, client_id, kind, payload, created_at)
    SELECT $1, 'client', 'ice_' || n, 'ice', '{"candidate":""}'::jsonb, now() FROM generate_series(1,256) AS n`, [start.body.call.id]);
  const limited = await api('client', 'POST', `${BASE}/${start.body.call.id}/signals`, { clientId:'extra', kind:'ice', candidate:'' });
  assert.equal(limited.body.error, 'call_signal_limit');
  await api('client', 'POST', `${BASE}/${start.body.call.id}/cancel`, {});
  assert.equal((await db.query('SELECT 1 FROM order_call_signals')).rowCount, 0);
  for (let i = 1; i < 10; i++) {
    start = await api('client', 'POST', BASE, { pair: 'delivery' });
    assert.equal(start.status, 201);
    await api('client', 'POST', `${BASE}/${start.body.call.id}/cancel`, {});
  }
  assert.equal((await api('client', 'POST', BASE, { pair: 'delivery' })).body.error, 'too_many_requests');
});


test('unsupported methods never reconcile or write outside the HTTP mutation boundary', async () => {
  for (const method of ['HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
    let result;
    const routed = await routeOrderCalls({ req: { method }, res: {}, pathname: BASE,
      user: { id: 'client', role: 'client' },
      send: (_res, status, body) => { result = { status, body }; },
      database: { query() { throw new Error('unsupported method touched database'); } },
    });
    assert.equal(routed, true);
    assert.deepEqual(result, { status: 405, body: { error: 'method_not_allowed' } });
  }
});
