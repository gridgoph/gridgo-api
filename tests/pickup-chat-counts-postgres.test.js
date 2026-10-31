import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import * as chat from '../src/pickup-chat.js';
import { setupOrders, instrument, actorView } from './fixtures/order-reads.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { AT } from './fixtures/reschedule.js';

const skip = !process.env.DATABASE_URL;
const READ_AT = '2026-10-20T00:00:00.000Z';
async function setup(database) {
  await setupOrders(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users.push({ ...store.users.find(row => row.id === 'rider'), id: 'rider_two', clerkUserId: 'clerk_rider_two', email: 'rider_two@example.invalid' });
    store.userRoleMemberships.push({ userId: 'rider_two', role: 'rider', createdAt: AT });
    store.approvalCases.push({ ...store.approvalCases.find(row => row.userId === 'rider'), id: 'case_rider_two', userId: 'rider_two' });
    const base = store.orders.find(row => row.id === 'a_active');
    for (let i = 0; i < 50; i++) store.orders.push({ ...structuredClone(base), id: `chat_${i}`, riderId: i % 2 ? 'rider_two' : 'rider' });
    for (const [id, hours] of [['read_only', 1], ['closed', 25]]) {
      store.orders.push({ ...structuredClone(base), id, state: 'completed',
        deliveryEvidence: { recordedAt: new Date(Date.now() - hours * 3600000).toISOString() } });
    }
    store.orders.push({ ...structuredClone(base), id: 'no_rider', riderId: null });
    await saveStore(database, store);
  });
  for (let i = 0; i < 50; i++) {
    const orderId = `chat_${i}`, riderId = i % 2 ? 'rider_two' : 'rider', previousRider = i % 2 ? 'rider' : 'rider_two';
    await database.query(`INSERT INTO pickup_chat_messages(order_id,rider_id,sender_user_id,sender_role,body,created_at)
      VALUES ($1,$2,'supplier','supplier','Own message',$4::timestamptz+interval '1 second'),
        ($1,$2,$2,'rider','Before read',$4::timestamptz-interval '1 second'),
        ($1,$2,$2,'rider','Exactly read',$4),
        ($1,$2,$2,'rider','After read',$4::timestamptz+interval '1 second'),
        ($1,$3,$3,'rider','Previous rider',$4::timestamptz+interval '2 seconds')`, [orderId,riderId,previousRider,READ_AT]);
    // Another caller's read and the previous rider's read cannot advance this pair.
    await database.query(`INSERT INTO pickup_chat_reads(order_id,rider_id,user_id,last_read_at)
      VALUES ($1,$2,'client',$4::timestamptz+interval '10 seconds'),
        ($1,$3,'supplier',$4::timestamptz+interval '10 seconds')`, [orderId,riderId,previousRider,READ_AT]);
    if (i % 3 !== 1) await database.query(`INSERT INTO pickup_chat_reads(order_id,rider_id,user_id,last_read_at)
      VALUES ($1,$2,'supplier',$3::timestamptz + $4::int * interval '1 second')`, [orderId,riderId,READ_AT,i % 3 === 0 ? 0 : 2]);
  }
  for (const orderId of ['read_only', 'closed']) await database.query(`INSERT INTO pickup_chat_messages
    (order_id,rider_id,sender_user_id,sender_role,body,created_at) VALUES ($1,'rider','rider','rider','Delivered conversation',$2)`, [orderId,READ_AT]);
  return loadStore(database);
}

test('one grouped query preserves unread semantics for 1/10/50 visible order/rider pairs', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  const store = await setup(database);
  assert.equal(typeof chat.pickupChatUnreadCounts, 'function');
  const { user } = actorView(store, 'supplier', '/jobs');
  const orders = store.orders.filter(row => row.id.startsWith('chat_'));
  for (const size of [1,10,50]) {
    const { db, queries } = instrument(database);
    const visible = orders.slice(0,size);
    const counts = await chat.pickupChatUnreadCounts(db, visible, user, store);
    assert.equal(queries.length, 1, `${size} eligible orders need one query`);
    assert.equal(counts.size, size);
    for (const [i,order] of visible.entries()) {
      const expected = i % 3 === 0 ? 1 : i % 3 === 1 ? 3 : 0;
      assert.equal(counts.get(order.id), expected, order.id);
      assert.equal(counts.get(order.id), await chat.pickupChatUnread(database, order, user.id));
    }
    assert.deepEqual(queries[0].values, [visible.map(row => row.id), visible.map(row => row.riderId), user.id]);
  }
  const { db, queries } = instrument(database);
  const counts = await chat.pickupChatUnreadCounts(db, store.orders, user, store);
  assert.equal(counts.get('read_only'), 1);
  assert.equal(counts.has('closed'), false);
  assert.equal(counts.has('no_rider'), false);
  assert.equal(counts.has('review'), false, 'another supplier conversation stays private');
  assert.equal(queries.length, 1);
  for (const caller of ['client','ops','rider','rider_two']) {
    const { user: actor } = actorView(store, caller, '/orders');
    const { db, queries } = instrument(database);
    const map = await chat.pickupChatUnreadCounts(db, orders, actor, store);
    const own = orders.filter(order => chat.pickupChatProjection(order, actor, store));
    assert.equal(queries.length, own.length ? 1 : 0);
    assert.equal(map.size, own.length);
    for (const order of own) assert.equal(map.get(order.id), 1, 'only the supplier message is unread for the assigned rider');
  }
  await database.query(`INSERT INTO pickup_chat_messages(order_id,rider_id,sender_user_id,sender_role,body,created_at)
    VALUES ('chat_0','rider','rider','rider','New message',$1::timestamptz+interval '3 seconds')`, [READ_AT]);
  assert.equal((await chat.pickupChatUnreadCounts(database, [orders[0]], user, store)).get('chat_0'), 2, 'no cross-request cache');
  store.approvalCases.find(row => row.userId === 'supplier').status = 'suspended';
  const revoked = instrument(database);
  assert.equal((await chat.pickupChatUnreadCounts(revoked.db, orders, user, store)).size, 0);
  assert.equal(revoked.queries.length, 0, 'revoked membership approval never reads conversations');
  assert.equal((await chat.pickupChatUnreadCounts(revoked.db, [], user, store)).size, 0);
  assert.equal(revoked.queries.length, 0);
});

test('HTTP order/job lists batch unread work while details retain the single-order path', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setup(database);
  const hook = `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (!url.endsWith('/src/database.js')) return result;
      const source = String(result.source).replace('async function query(text, values) {',
        "async function query(text, values) { if (text.includes('pickup_chat_messages') && text.includes('count(')) console.log('__PICKUP_UNREAD__');");
      if (source === String(result.source)) throw new Error('Unread query observer was not installed');
      return { ...result, source };
    } });`;
  let output = '';
  const api = await apiForTest(t, { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(hook)}` },
    { onOutput: chunk => { output += chunk; } });
  const check = async (caller,path,expectedQueries) => {
    const offset = output.length;
    const result = await api(caller,'GET',path);
    assert.equal(result.status, 200);
    // The request log follows all query logs on the same stdout pipe.
    for (let i = 0; !output.slice(offset).includes(`GET ${path} 200`) && i < 300; i++) await new Promise(resolve => setTimeout(resolve,10));
    assert.ok(output.slice(offset).includes(`GET ${path} 200`));
    assert.equal(output.slice(offset).split('__PICKUP_UNREAD__').length-1, expectedQueries, `${caller} ${path}`);
    return result.body;
  };
  for (const path of ['/orders','/jobs']) {
    const body = await check('supplier',path,1);
    for (let i = 0; i < 50; i++) assert.equal((body.orders || body.jobs).find(row => row.id === `chat_${i}`).pickupChat.unread,
      i % 3 === 0 ? 1 : i % 3 === 1 ? 3 : 0);
    assert.equal((body.orders || body.jobs).find(row => row.id === 'read_only').pickupChat.status, 'read_only');
    assert.equal((body.orders || body.jobs).find(row => row.id === 'closed').pickupChat, undefined);
  }
  await check('client','/orders',0);
  await check('rider','/orders',1);
  assert.equal((await check('supplier','/orders/chat_0',1)).order.pickupChat.unread, 1);
});
