import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import * as adapter from '../src/postgres-store.js';
import { setupOrders, instrument } from './fixtures/order-reads.js';
import { AT } from './fixtures/reschedule.js';
const skip = !process.env.DATABASE_URL;

test('client save graph writes only its delta and preserves sparse global append positions', { skip }, async t => {
  const db = createDatabase(process.env); t.after(() => db.close());
  await setupOrders(db);
  assert.equal(typeof adapter.loadClientSaveStore, 'function');
  await db.query(`INSERT INTO notifications(id,user_id,type,created_at,position,data) VALUES('old','other','fixture',$1,9000,'{}')`, [AT]);
  await db.transaction(async () => {
    const graph = await adapter.loadClientSaveStore(db, 'clerk_client', '/me/matches', { subcategoryCode: 'flyers' });
    assert.ok(graph);
    assert.ok(!graph.notifications.some(n => n.id === 'old'));
    graph.matchSelections.push({ tokenHash: 'a'.repeat(64), clientId: 'client', requestId: 'fixture_request', expiresAt: '2099-01-01T00:00:00.000Z', selection: {} });
    graph.notifications.push({ id: 'new', userId: 'client', type: 'fixture', at: AT, read: false });
    await adapter.saveStore(db, graph);
  });
  assert.deepEqual((await db.query('SELECT id,position FROM notifications ORDER BY id')).rows, [{ id: 'new', position: 1 }, { id: 'old', position: 9000 }]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM client_match_selections WHERE token_hash=$1', ['a'.repeat(64)])).rows[0].n, 1);
});

test('client save graph is transaction-only and its history reads stay fixed under unrelated growth', { skip }, async t => {
  const db = createDatabase(process.env); t.after(() => db.close());
  await setupOrders(db);
  assert.equal(typeof adapter.loadClientSaveStore, 'function');
  await assert.rejects(adapter.loadClientSaveStore(db, 'clerk_client', '/me/matches', {}), /write transaction/);
  const sample = () => db.transaction(async () => {
    const { db: traced, queries } = instrument(db);
    const graph = await adapter.loadClientSaveStore(traced, 'clerk_client', '/me/matches', { subcategoryCode: 'flyers' });
    assert.ok(graph);
    return queries;
  });
  const before = await sample();
  await db.query(`INSERT INTO notifications(id,user_id,type,created_at,position,data) SELECT 'growth_'||i,'other','fixture',$1,10000+i,'{}' FROM generate_series(1,1000)i`, [AT]);
  assert.deepEqual(await sample(), before);
  assert.ok(!before.some(q => /FROM (audit_log|location_pings|notification_push_outbox)\b/.test(q.sql)));
});

test('HTTP matching and line-edit status/body and all resulting money/event rows equal full saves', { skip }, async t => {
  const { setupSaveParity, saveParityApi, saveRows } = await import('./fixtures/save-parity.js');
  const db = createDatabase(process.env); t.after(() => db.close());
  const run = async full => {
    await setupSaveParity(db);
    const api = await saveParityApi(t, full);
    const results = [];
    for (const [who, method, path, body, opts] of [
      [null, 'POST', '/me/matches', { subcategoryCode: 'flyers' }],
      ['supplier', 'POST', '/me/matches', { subcategoryCode: 'flyers' }],
      ['client', 'POST', '/me/matches/next', { subcategoryCode: 'flyers' }],
      ['client', 'POST', '/me/matches', { subcategoryCode: 'missing' }],
      ['client', 'PATCH', '/me/carts/save_cart/lines/missing', { quantity: 20 }],
      ['other', 'PATCH', '/me/carts/save_cart/lines/save_line', { quantity: 20 }],
      ['client', 'PATCH', '/me/carts/save_cart/lines/save_line', { quantity: 20 }],
      ['client', 'POST', '/me/carts/save_cart/lines', { catalogItemId: 'item_supplier', optionIds: [], quantity: 5 }],
      ['client', 'POST', '/me/matches', { subcategoryCode: 'flyers' }],
      ['client', 'POST', '/me/matches/next', { subcategoryCode: 'flyers', excludedSupplierIds: ['supplier'] }],
      ['client', 'DELETE', '/me/carts/save_cart/lines/save_line'],
    ]) {
      const response = await api(who, method, path, body, { ...opts, raw: true });
      results.push({ status: response.status, body: response.body, rows: await saveRows(db) });
    }
    return results;
  };
  const baseline = await run(true), scoped = await run(false);
  for (let i=0;i<baseline.length;i++) {
    assert.equal(scoped[i].status, baseline[i].status, `case ${i} status`);
    assert.equal(scoped[i].body, baseline[i].body, `case ${i} HTTP bytes`);
    for (const table of Object.keys(baseline[i].rows)) assert.deepEqual(scoped[i].rows[table], baseline[i].rows[table], `case ${i} ${table} rows`);
  }
  assert.equal(scoped[6].status, 200);
  assert.equal(scoped[7].status, 201);
  assert.equal(scoped[8].status, 200);
});

test('global supplement and pending-payment errors remain identical on a scoped draft edit', { skip }, async t => {
  const { setupSaveParity, saveParityApi, saveRows } = await import('./fixtures/save-parity.js');
  const db = createDatabase(process.env); t.after(() => db.close());
  const run = async (full, kind) => {
    await setupSaveParity(db);
    if (kind === 'supplement') await db.query(`UPDATE order_payments SET data=data || jsonb_build_object('reference',$1::text) WHERE order_id='unrelated' AND code='initial'`, ['\u00a0SUPPLEMENT\u00a0']);
    else await db.query(`UPDATE orders SET data=data || $1::jsonb WHERE id='unrelated'`, [JSON.stringify({ deliveryPin: { dispatchedAt: AT, change: { status: 'pending_confirmation' } } })]);
    const before = await saveRows(db);
    const api = await saveParityApi(t, full);
    const response = await api('client','PATCH','/me/carts/save_cart/lines/save_line',{ quantity: 25 },{raw:true});
    assert.equal(response.status,409,response.body);
    assert.deepEqual(await saveRows(db),before,'all request and incidental changes roll back');
    return {status:response.status,body:response.body};
  };
  for (const kind of ['supplement','pin']) assert.deepEqual(await run(false,kind),await run(true,kind),kind);
});

test('late persistence, push and realtime errors roll back direct call SQL plus the entire draft save', { skip }, async t => {
  const { setupSaveParity, saveParityApi, saveRows, SAVE_AT } = await import('./fixtures/save-parity.js');
  const db = createDatabase(process.env); t.after(() => db.close());
  for (const failSql of ['INSERT INTO notifications','INSERT INTO notification_push_outbox','SELECT pg_notify']) {
    await setupSaveParity(db);
    await db.query(`INSERT INTO order_calls(id,order_id,pair,rider_id,caller_id,callee_id,caller_role,callee_role,state,created_at,ring_expires_at,caller_seen_at,callee_seen_at)
      VALUES('00000000-0000-4000-9000-000000000001','a_active','delivery','rider','client','rider','client','rider','ringing',$1,$1,$1,$1)`, [new Date(SAVE_AT-1000).toISOString()]);
    await db.query(`INSERT INTO device_tokens(id,user_id,token,platform,created_at,updated_at,position,data)
      VALUES('rollback_device','rider','rollback_token','android',$1,$1,0,'{"appRole":"rider"}')`,[AT]);
    const before=await saveRows(db);
    const api=await saveParityApi(t,false,{failSql});
    const response=await api('client','PATCH','/me/carts/save_cart/lines/save_line',{quantity:25});
    assert.equal(response.status,500,`${failSql}: ${JSON.stringify(response.body)}`);
    assert.deepEqual(await saveRows(db),before,`${failSql}: transaction rollback`);
  }
});

test('concurrent line edits serialize on the existing advisory lock without lost cart versions', { skip }, async t => {
  const { setupSaveParity, saveParityApi }=await import('./fixtures/save-parity.js');
  const db=createDatabase(process.env); t.after(()=>db.close());
  await setupSaveParity(db);
  const api=await saveParityApi(t,false);
  const replies=await Promise.all([20,30].map(quantity=>api('client','PATCH','/me/carts/save_cart/lines/save_line',{quantity})));
  assert.deepEqual(replies.map(r=>r.status),[200,200]);
  assert.deepEqual(replies.map(r=>r.body.cart.version).sort(),[2,3]);
  const cart=(await db.query("SELECT version FROM client_carts WHERE id='save_cart'")).rows[0];
  assert.equal(cart.version,3);
  const final=(await db.query("SELECT quantity FROM client_cart_lines WHERE id='save_line'")).rows[0].quantity;
  assert.equal(final,replies.find(r=>r.body.cart.version===3).body.cart.lines.find(l=>l.id==='save_line').quantity);
});

test('unrelated invite and hub upkeep moves to the candidate sweep with the same business rows', { skip }, async t => {
  const { setupSaveParity, saveParityApi, saveRows, SAVE_AT }=await import('./fixtures/save-parity.js');
  const { saveUpkeepNeeded }=await import('../src/save-upkeep.js');
  const db=createDatabase(process.env); t.after(()=>db.close());
  const seed=async()=>{
    await setupSaveParity(db);
    await db.query(`INSERT INTO tester_invite_codes(client_id,code,created_at) VALUES('client','CODE',$1)`,[AT]);
    await db.query(`INSERT INTO tester_invites(id,inviter_id,code,email,created_at,unmatched_reason) VALUES('upkeep_invite','client','CODE','other@example.invalid',$1,'no_client_account')`,[AT]);
    await db.query(`UPDATE orders SET state='awaiting_collection',data=data || $1::jsonb WHERE id='unrelated'`,[JSON.stringify({handover:{qrToken:'upkeep_fixture',readyAt:new Date(SAVE_AT-3600000).toISOString(),schedule:null,notifiedDays:[],missedDays:0}})]);
  };
  await seed();
  assert.equal(await saveUpkeepNeeded(db,new Date(SAVE_AT).toISOString()),true);
  const baselineApi=await saveParityApi(t,true);
  assert.equal((await baselineApi('client','POST','/me/matches',{subcategoryCode:'flyers'})).status,200);
  const expected=await saveRows(db); delete expected.client_match_selections;
  await seed();
  const before=await saveRows(db);
  const scopedApi=await saveParityApi(t,false);
  assert.equal((await scopedApi('client','POST','/me/matches',{subcategoryCode:'flyers'})).status,200);
  const after=await saveRows(db);
  assert.deepEqual(after.tester_invites,before.tester_invites,'unrelated invitation did not piggyback');
  assert.deepEqual(after.orders.find(row=>row.id==='unrelated'),before.orders.find(row=>row.id==='unrelated'),'unrelated hub did not piggyback');
  // Restart the fixture so generated identifiers and SQL defaults have the
  // same initial state as the baseline. Only the sweep performs upkeep.
  await seed();
  await saveParityApi(t,false,{upkeep:true});
  const deadline=Date.now()+10000;
  while((await db.query("SELECT client_id FROM tester_invites WHERE id='upkeep_invite'")).rows[0].client_id===null && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
  const actual=await saveRows(db); delete actual.client_match_selections;
  // The moved event has real background provenance rather than borrowing the
  // next request's user-agent; all audit business fields remain exact.
  assert.ok(actual.audit_log.every(row=>row.data.app==='system' && row.data.device===null));
  const businessAudit=rows=>rows.map(row=>{const copy=structuredClone(row);delete copy.data.app;delete copy.data.device;return copy;});
  expected.audit_log=businessAudit(expected.audit_log);actual.audit_log=businessAudit(actual.audit_log);
  for(const table of Object.keys(expected)) assert.deepEqual(actual[table],expected[table],table);
  assert.equal(await saveUpkeepNeeded(db,new Date(SAVE_AT).toISOString()),false,'completed upkeep no longer requests a writer');
});

test('legacy review payment migration leaves no unnormalized order or basket payment', { skip }, async t => {
  const db=createDatabase(process.env);t.after(()=>db.close());
  await setupOrders(db);
  await db.query(`UPDATE order_payments p SET data=p.data-'simulated'-'confirmationSource' FROM orders o WHERE o.id=p.order_id AND o.review_data`);
  const money=(await db.query('SELECT order_id,code,amount_minor,method,status FROM order_payments ORDER BY order_id,code')).rows;
  const {up}=await import('../migrations/1794180610000_review_payment_normalization.js');
  let sql;up({sql:value=>{sql=value;}});await db.transaction(()=>db.query(sql));
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM order_payments p JOIN orders o ON o.id=p.order_id WHERE o.review_data AND (p.data->'simulated' IS DISTINCT FROM 'true'::jsonb OR (p.status='confirmed' AND p.data->>'confirmationSource' IS DISTINCT FROM 'review_data'))`)).rows[0].n,0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM order_baskets b WHERE EXISTS(SELECT 1 FROM order_basket_groups g JOIN orders o ON o.id=g.order_id WHERE g.basket_id=b.id AND o.review_data) AND (b.payment->'simulated' IS DISTINCT FROM 'true'::jsonb OR (b.payment->>'status'='confirmed' AND b.payment->>'confirmationSource' IS DISTINCT FROM 'review_data'))`)).rows[0].n,0);
  assert.deepEqual((await db.query('SELECT order_id,code,amount_minor,method,status FROM order_payments ORDER BY order_id,code')).rows,money);
});

test('successful own call/invite/voucher maintenance preserves money, audit, push and realtime rows exactly', { skip }, async t => {
  const { setupSaveParity, saveParityApi, saveRows, SAVE_AT }=await import('./fixtures/save-parity.js');
  const db=createDatabase(process.env);
  t.after(async()=>{await db.query(`ALTER TABLE notification_push_outbox ALTER COLUMN next_attempt_at SET DEFAULT now(),ALTER COLUMN updated_at SET DEFAULT now(),ALTER COLUMN expires_at SET DEFAULT now()+interval '48 hours'`);await db.close();});
  const run=async full=>{
    await setupSaveParity(db);
    const at=new Date(SAVE_AT).toISOString(),earlier=new Date(SAVE_AT-1000).toISOString();
    await db.query(`ALTER TABLE notification_push_outbox ALTER COLUMN next_attempt_at SET DEFAULT '${at}'::timestamptz,ALTER COLUMN updated_at SET DEFAULT '${at}'::timestamptz,ALTER COLUMN expires_at SET DEFAULT '${at}'::timestamptz+interval '48 hours'`);
    await db.query(`INSERT INTO order_calls(id,order_id,pair,rider_id,caller_id,callee_id,caller_role,callee_role,state,created_at,ring_expires_at,caller_seen_at,callee_seen_at)
      VALUES('00000000-0000-4000-9000-000000000002','a_active','delivery','rider','client','rider','client','rider','ringing',$1,$1,$1,$1)`,[earlier]);
    await db.query(`INSERT INTO notifications(id,user_id,type,order_id,created_at,position,data) VALUES('own_incoming','rider','order_call_incoming','a_active',$1,0,$2)`,[earlier,JSON.stringify({callId:'00000000-0000-4000-9000-000000000002',appRole:'rider',callExpiresAt:earlier})]);
    await db.query(`INSERT INTO device_tokens(id,user_id,token,platform,created_at,updated_at,position,data) VALUES('own_device','rider','own_token','android',$1,$1,0,'{"appRole":"rider"}')`,[AT]);
    await db.query(`INSERT INTO tester_invite_codes(client_id,code,created_at) VALUES('other','OWNCODE',$1)`,[AT]);
    await db.query(`INSERT INTO tester_invites(id,inviter_id,code,email,created_at,unmatched_reason) VALUES('own_invite','other','OWNCODE','client@example.invalid',$1,'no_client_account')`,[AT]);
    await db.query(`UPDATE orders SET ready_at=$1 WHERE id='order'`,[earlier]);
    await db.query(`INSERT INTO supplier_performance_events(id,order_id,supplier_id,kind,source_key,occurred_at,recorded_at,data) VALUES('review_history','review','supplier','late_finish','finish',$1,$1,'{"tier":"moderate","workingLateMs":25200000}')`,[new Date(SAVE_AT-86400000).toISOString()]);
    await db.query(`UPDATE orders SET state='awaiting_collection',data=data || $1::jsonb WHERE id='m_offer'`,[JSON.stringify({handover:{qrToken:'own_hub_fixture',readyAt:earlier,schedule:null,notifiedDays:[],missedDays:0}})]);
    await db.query("UPDATE orders SET cancelled_by='client' WHERE id='z_history'");
    await db.query(`INSERT INTO voucher_campaigns(id,name,code,mode,status,value_minor,total_limit,per_account_limit,validity_days,created_at,updated_at)
      VALUES('own_campaign','Own fixture','OWNFIXTURE','assigned','active',1500,10,1,7,$1,$1) ON CONFLICT(id) DO NOTHING`,[AT]);
    await db.query(`INSERT INTO vouchers(id,campaign_id,client_id,status,value_minor,issued_at,expires_at) VALUES('own_voucher','own_campaign','client','available',1500,$1,$2)`,[AT,'2027-01-01T00:00:00Z']);
    await db.query(`INSERT INTO voucher_reservations(id,voucher_id,client_id,cart_id,status,expires_at,created_at,data)
      VALUES('own_reservation','own_voucher','client','save_cart','reserved',$2,$1,'{"orderIds":["z_history"]}')`,[AT,'2027-01-01T00:00:00Z']);
    await db.query(`INSERT INTO credit_accounts(user_id,balance_minor) VALUES('client',1000)`);
    await db.query(`INSERT INTO credit_ledger(id,user_id,amount_minor,balance_after_minor,created_at,position) VALUES('own_credit','client',1000,1000,$1,0)`,[AT]);
    const {default:pg}=await import('pg');
    const listener=new pg.Client({connectionString:process.env.DATABASE_URL});
    const frames=[];await listener.connect();await listener.query('LISTEN gridgo_realtime_v1');
    listener.on('notification',message=>frames.push(JSON.parse(message.payload)));
    let response;
    try {
      const api=await saveParityApi(t,full);
      response=await api('client','POST','/me/matches',{subcategoryCode:'flyers'},{raw:true});
      assert.equal(response.status,200,response.body);
      await new Promise(resolve=>setTimeout(resolve,25));
    } finally {await listener.end();}
    const rows=await saveRows(db);
    assert.ok(rows.audit_log.some(row=>row.action==='tester_invite.joined'));
    assert.equal(rows.order_calls[0].state,'missed');
    assert.equal(rows.notifications.find(row=>row.id==='own_incoming').data.push,false);
    assert.ok(rows.notification_push_outbox.length>0);
    assert.equal(rows.vouchers.find(row=>row.id==='own_voucher').status,'used');
    assert.equal(rows.voucher_reservations[0].status,'released');
    assert.deepEqual(rows.voucher_ledger.map(row=>[row.kind,row.amount_minor]).sort(),[['client_fault',0],['released',0]]);
    assert.equal(rows.credit_accounts[0].balance_minor,1000);
    assert.equal(rows.credit_ledger[0].amount_minor,1000);
    assert.equal(rows.supplier_performance_events.find(row=>row.order_id==='order' && row.source_key==='finish').data.topPickHiddenUntil,null,'review history cannot raise the requester shop performance count');
    assert.ok(frames.some(frame=>frame.kind==='invalidate' && frame.payload.resource==='catalog'));
    return {status:response.status,body:response.body,rows,frames};
  };
  assert.deepEqual(await run(false),await run(true));
});

test('review normalization covers nonempty basket payments and is idempotent', { skip }, async t => {
  const db=createDatabase(process.env);t.after(()=>db.close());
  const {up}=await import('../migrations/1794180610000_review_payment_normalization.js');let sql;up({sql:value=>{sql=value;}});
  await db.transaction(async()=>{
    await db.query(`CREATE TEMP TABLE orders(id text,review_data boolean) ON COMMIT DROP;
      CREATE TEMP TABLE order_payments(order_id text,status text,data jsonb) ON COMMIT DROP;
      CREATE TEMP TABLE order_baskets(id text,payment jsonb) ON COMMIT DROP;
      CREATE TEMP TABLE order_basket_groups(basket_id text,order_id text) ON COMMIT DROP;
      INSERT INTO orders VALUES('review',true),('real',false);
      INSERT INTO order_baskets VALUES('confirmed','{"status":"confirmed","amountMinor":12000}'),('pending','{"status":"pending_confirmation","amountMinor":7500}'),('real','{"status":"confirmed","amountMinor":100}');
      INSERT INTO order_basket_groups VALUES('confirmed','review'),('pending','review'),('real','real');`);
    await db.query(sql);
    const rows=(await db.query('SELECT * FROM order_baskets ORDER BY id')).rows;
    assert.deepEqual(rows,[{id:'confirmed',payment:{status:'confirmed',amountMinor:12000,simulated:true,confirmationSource:'review_data'}},{id:'pending',payment:{status:'pending_confirmation',amountMinor:7500,simulated:true}},{id:'real',payment:{status:'confirmed',amountMinor:100}}]);
    await db.query(sql);assert.deepEqual((await db.query('SELECT * FROM order_baskets ORDER BY id')).rows,rows);
  });
});

test('artwork preflight graph is targeted and cannot be promoted into a writer', { skip }, async t => {
  const db=createDatabase(process.env);t.after(()=>db.close());
  await setupOrders(db);
  const graph=await adapter.loadClientSavePreflightStore(db,'clerk_client','/me/carts/absent/lines',{catalogItemId:'item_supplier'});
  assert.ok(graph.catalogItems.some(item=>item.id==='item_supplier'));
  await assert.rejects(db.transaction(()=>adapter.saveStore(db,graph)),/read-only/);
});

test('historical order compaction and mutable file gaps retain the exact full writer', { skip }, async t => {
  const db=createDatabase(process.env);t.after(()=>db.close());
  await setupOrders(db);
  await db.query("UPDATE orders SET position=9000 WHERE id='order'");
  assert.equal((await db.query("SELECT positions_contiguous FROM store_collection_counts WHERE name='orders'")).rows[0].positions_contiguous,false);
  await db.transaction(async()=>{
    assert.equal(await adapter.loadClientSaveStore(db,'clerk_client','/me/matches',{subcategoryCode:'flyers'}),null,'missing performance clock could compact this own order');
  });
  await setupOrders(db);
  await db.query("UPDATE files SET position=9000 WHERE file_id='photo_supplier'");
  await db.transaction(async()=>{
    assert.equal(await adapter.loadClientSaveStore(db,'clerk_client','/me/carts/absent/lines',{catalogItemId:'item_supplier'}),null,'line edits may mutate file analysis metadata');
  });
});

test('collection health tracks inserts, updates, deletes and sparse bulk appends transactionally', { skip }, async t => {
  const db=createDatabase(process.env);t.after(()=>db.close());
  await setupOrders(db);
  await db.query(`INSERT INTO notifications(id,user_id,type,created_at,position,data) SELECT 'ordinal_'||i,'other','fixture',$1,i,'{}' FROM generate_series(0,9)i`,[AT]);
  let state=(await db.query("SELECT row_count,positions_contiguous FROM store_collection_counts WHERE name='notifications'")).rows[0];
  assert.deepEqual(state,{row_count:10,positions_contiguous:true});
  await assert.rejects(db.transaction(async()=>{await db.query("DELETE FROM notifications WHERE id='ordinal_0'");throw new Error('rollback ordinal');}),/rollback ordinal/);
  assert.deepEqual((await db.query("SELECT row_count,positions_contiguous FROM store_collection_counts WHERE name='notifications'")).rows[0],state);
  await db.query("DELETE FROM notifications WHERE id='ordinal_0'");
  assert.deepEqual((await db.query("SELECT row_count,positions_contiguous FROM store_collection_counts WHERE name='notifications'")).rows[0],{row_count:9,positions_contiguous:false});
});

test('logical removals exclude hidden notifications from scoped append ordinals', { skip }, async t => {
  const { setupSaveParity }=await import('./fixtures/save-parity.js');
  const db=createDatabase(process.env);t.after(()=>db.close());
  await setupSaveParity(db);
  await db.query(`INSERT INTO notifications(id,user_id,type,order_id,created_at,position,data) VALUES
    ('removed_notice','other','fixture','unrelated',$1,0,'{}'),
    ('visible_notice','other','fixture',NULL,$1,1,'{}')`,[AT]);
  await db.query("INSERT INTO order_removals VALUES('unrelated',$1,'test_ops','fixture')",[AT]);
  const count=async()=>(await db.query("SELECT row_count FROM store_collection_counts WHERE name='notifications'")).rows[0].row_count;
  assert.equal(await count(),1);
  await db.transaction(async()=>{
    const graph=await adapter.loadClientSaveStore(db,'clerk_client','/me/matches',{subcategoryCode:'flyers'});
    assert.ok(graph,'quiet own orders remain scoped after an unrelated removal');
    graph.notifications.push({id:'appended_notice',userId:'client',type:'fixture',at:AT,read:false});
    await adapter.saveStore(db,graph);
  });
  assert.equal((await db.query("SELECT position FROM notifications WHERE id='appended_notice'")).rows[0].position,1,'full adapter appends at the visible array length');
  assert.equal(await count(),2);
  await db.query(`INSERT INTO notifications(id,user_id,type,order_id,created_at,position,data) VALUES('hidden_later','other','fixture','unrelated',$1,9,'{}')`,[AT]);
  assert.equal(await count(),2);
  await db.query("UPDATE notifications SET order_id=NULL WHERE id='hidden_later'");
  assert.equal(await count(),3);
  await db.query("UPDATE notifications SET order_id='unrelated' WHERE id='hidden_later'");
  await db.query("DELETE FROM notifications WHERE id='hidden_later'");
  assert.equal(await count(),2,'hidden deletes do not decrement the active count');
});
