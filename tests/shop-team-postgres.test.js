import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore, loadDeliveryStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { OWNER_ROUTES, STAFF_ROUTES } from './fixtures/shop-team-routes.js';
import { PICKUP_CHECK_CODES } from '../src/operational-model.js';
import { up } from '../migrations/1794192200000_shop_teams.js';
import { notificationVisible } from '../src/notifications.js';
import { inviteHash } from '../src/shop-team.js';
const skip = !process.env.DATABASE_URL;
const supplier = { headers: { 'X-GRIDGO-Role': 'supplier' } };
const bodyOf = result => JSON.stringify(result.body);
async function setup(t, change = () => {}, onOutput) {
  const db = createDatabase(process.env); t.after(()=>db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  store.orders[0].readyBy = new Date(Date.now()+7*86400000).toISOString();
  store.orders[0].promiseBy = new Date(Date.now()+8*86400000).toISOString();
  store.orders[0].promisedDate = store.orders[0].promiseBy;
  store.shopMemberships.push({shopId:'supplier',userId:'other',role:'staff',status:'active',createdAt:AT,updatedAt:AT});
  change(store);
  await db.transaction(()=>saveStore(db,store));
  const clerk = http.createServer((req,res)=>{
    const subject = /^\/v1\/users\/([^/?]+)/.exec(req.url)?.[1];
    if (!subject) { res.writeHead(404); res.end('{}'); return; }
    const name=subject.replace('clerk_','');
    const phone = name==='phone' ? '+639171234567' : '+639170000000';
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({object:'user',id:subject,first_name:name,last_name:'Person',username:null,
      primary_email_address_id:`email_${name}`,primary_phone_number_id:`phone_${name}`,
      email_addresses: name==='phone' ? [] : [{object:'email_address',id:`email_${name}`,email_address:`${name}@example.invalid`,verification:{status:name==='unverified'?'unverified':'verified'},linked_to:[]}],
      phone_numbers:[{object:'phone_number',id:`phone_${name}`,phone_number:phone,verification:{status:'verified'},linked_to:[]}],
      external_accounts:[],web3_wallets:[],public_metadata:{},private_metadata:{},unsafe_metadata:{},created_at:0,updated_at:0}));
  });
  await new Promise(resolve=>clerk.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>clerk.close(resolve)));
  const env = {CLERK_API_URL:`http://127.0.0.1:${clerk.address().port}`,NOTIFICATION_HEARTBEAT_MS:'1000'};
  const api = await apiForTest(t,env,{onOutput});
  return {db,api,env};
}
async function mutate(db, fn) { return db.transaction(async()=>{const store=await loadStore(db);await fn(store);await saveStore(db,store);}); }
async function invite(api,kind='link',identity) {
  const r=await api('supplier','POST','/me/shop-team/invites',{kind,identity},supplier);
  assert.equal(r.status,201,bodyOf(r)); return r.body;
}

test('HTTP replace keeps recipient, delivery and unrelated invites; old links and QR fail without leaking secrets', {skip}, async t => {
  let output = '';
  const {db,api} = await setup(t,()=>{},chunk=>{output+=chunk;});
  const unrelated = await invite(api);
  const before = await loadStore(db);
  const secrets = [];
  for (const [kind,identity] of [['email','new@example.invalid'],['phone','+639171234567'],['qr',null],['link',null]]) {
    const original = await invite(api,kind,identity);
    const replaced = await api('supplier','POST',`/me/shop-team/invites/${original.invite.id}/replace`,{kind:'link',identity:'ignored@example.invalid'},supplier);
    assert.equal(replaced.status,201);
    assert.equal(replaced.headers.get('cache-control'),'private, no-store');
    assert.equal(replaced.body.invite.kind,kind);
    assert.equal(replaced.body.invite.identity,identity);
    assert.equal(replaced.body.delivery,'share_link');
    assert.notEqual(replaced.body.invite.id,original.invite.id);
    assert.match(replaced.body.token,/^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(replaced.body.token,original.token);
    assert.equal(Date.parse(replaced.body.invite.expiresAt)-Date.parse(replaced.body.invite.createdAt),172800000);
    const old = await api('new','POST','/auth/shop-invites/claim',{token:original.token});
    assert.equal(old.status,409); assert.equal(old.body.error,'shop_invite_revoked');
    if (['email','phone'].includes(kind)) {
      const byId = await api('new','POST','/auth/shop-invites/claim',{inviteId:original.invite.id});
      assert.equal(byId.body.error,'shop_invite_revoked');
    }
    const account = kind==='phone' ? 'phone' : 'new';
    const claimed = await api(account,'POST','/auth/shop-invites/claim',{token:replaced.body.token});
    assert.equal(claimed.status,200); assert.equal(claimed.body.member.status,'pending');
    assert.equal(claimed.body.member.role,'staff');
    assert.equal((await api(account,'POST','/auth/shop-invites/claim',{token:replaced.body.token})).body.error,'shop_invite_used');
    assert.equal((await api('supplier','DELETE',`/me/shop-team/members/${claimed.body.member.userId}`,null,supplier)).status,200);
    secrets.push(original.token,replaced.body.token,inviteHash(original.token),inviteHash(replaced.body.token));
    assert.equal(JSON.stringify(replaced.body).includes('tokenHash'),false);
    assert.equal(JSON.stringify(replaced.body).includes(inviteHash(replaced.body.token)),false);
  }
  const team = await api('supplier','GET','/me/shop-team',null,supplier);
  assert.equal(team.body.invites.find(row=>row.id===unrelated.invite.id).status,'open');
  const after = await loadStore(db);
  assert.deepEqual(after.orders,before.orders);
  assert.deepEqual(after.orderJobs,before.orderJobs);
  assert.deepEqual(after.userRoleMemberships,before.userRoleMemberships);
  assert.ok(after.auditLog.some(row=>row.action==='shop_team.invite_revoked'&&row.actorId==='supplier'));
  const visible = JSON.stringify({team:team.body,audit:after.auditLog,notifications:after.notifications,output});
  for (const secret of secrets) assert.equal(visible.includes(secret),false,'invite secrets stay out of lists, audit, notifications and logs');
  assert.ok(after.shopInvites.every(row=>!row.token));
});

test('HTTP replacement refuses Staff, non-members, other shops and consumed or expired invites', {skip}, async t => {
  const {db,api} = await setup(t);
  const original = await invite(api);
  const path = `/me/shop-team/invites/${original.invite.id}/replace`;
  const before = await db.query('SELECT * FROM shop_invites ORDER BY id');
  for (const [account,options,code] of [
    ['other',supplier,'shop_owner_required'],
    ['client',{headers:{'X-GRIDGO-Role':'supplier','X-GRIDGO-Shop-Id':'supplier'}},'shop_membership_required'],
    ['replacement',supplier,'shop_invite_not_found'],
  ]) {
    const result = await api(account,'POST',path,{},options);
    assert.equal(result.status,code==='shop_invite_not_found'?404:403);
    assert.equal(result.body.error,code);
  }
  assert.equal((await api(null,'POST',path,{},supplier)).status,401);
  assert.deepEqual((await db.query('SELECT * FROM shop_invites ORDER BY id')).rows,before.rows);
  await db.query(`INSERT INTO shop_invites(id,shop_id,kind,token_hash,created_by,created_at,expires_at)
    VALUES ('expired','supplier','qr',$1,'supplier',now()-interval '48 hours',now())`,[inviteHash('z'.repeat(43))]);
  assert.equal((await api('supplier','POST','/me/shop-team/invites/expired/replace',{},supplier)).body.error,'shop_invite_expired');
  assert.equal((await api('client','POST','/auth/shop-invites/claim',{token:original.token})).status,200);
  assert.equal((await api('supplier','POST',path,{},supplier)).body.error,'shop_invite_used');
  const revoked = await invite(api);
  await api('supplier','DELETE',`/me/shop-team/invites/${revoked.invite.id}`,null,supplier);
  assert.equal((await api('supplier','POST',`/me/shop-team/invites/${revoked.invite.id}/replace`,{},supplier)).body.error,'shop_invite_revoked');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM shop_invites')).rows[0].count,3);
});

test('HTTP claim versus replace serializes across API processes with one winner', {skip}, async t => {
  const {db,api,env} = await setup(t);
  const secondApi = await apiForTest(t,env);
  for (let attempt=0;attempt<4;attempt++) {
    const original = await invite(api);
    const replacePath = `/me/shop-team/invites/${original.invite.id}/replace`;
    const [claimed,replaced] = await Promise.all([
      api('client','POST','/auth/shop-invites/claim',{token:original.token}),
      secondApi('supplier','POST',replacePath,{},supplier),
    ]);
    if (claimed.status===200) {
      assert.equal(replaced.status,409); assert.equal(replaced.body.error,'shop_invite_used');
    } else {
      assert.equal(replaced.status,201);
      assert.equal(claimed.status,409); assert.equal(claimed.body.error,'shop_invite_revoked');
      assert.equal((await api('client','POST','/auth/shop-invites/claim',{token:replaced.body.token})).status,200);
    }
    assert.equal((await api('client','POST','/auth/shop-invites/claim',{token:original.token})).status,409);
    assert.equal((await api('supplier','POST',replacePath,{},supplier)).status,409);
    const {rows} = await db.query("SELECT count(*)::int AS count FROM shop_invites WHERE claimed_at IS NULL AND revoked_at IS NULL");
    assert.equal(rows[0].count,0);
    assert.equal((await api('supplier','DELETE','/me/shop-team/members/client',null,supplier)).status,200);
  }
  const original = await invite(api);
  const path = `/me/shop-team/invites/${original.invite.id}/replace`;
  const replacements = await Promise.all([api,secondApi].map(call=>call('supplier','POST',path,{},supplier)));
  assert.deepEqual(replacements.map(r=>r.status).sort(),[201,409]);
  assert.equal(replacements.find(r=>r.status===409).body.error,'shop_invite_revoked');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM shop_invites WHERE claimed_at IS NULL AND revoked_at IS NULL')).rows[0].count,1);
});

test('HTTP failed replacement rolls back revocation and audit together', {skip}, async t => {
  let output = '';
  const {db,api} = await setup(t,()=>{},chunk=>{output+=chunk;});
  const original = await invite(api);
  const before = await loadStore(db);
  await db.query(`CREATE FUNCTION reject_test_invite() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test issuance failure %', NEW.token_hash USING DETAIL = row_to_json(NEW)::text; END $$;
    CREATE TRIGGER reject_test_invite BEFORE INSERT ON shop_invites FOR EACH ROW EXECUTE FUNCTION reject_test_invite()`);
  try {
    const result = await api('supplier','POST',`/me/shop-team/invites/${original.invite.id}/replace`,{},supplier);
    assert.equal(result.status,500);
    const after = await loadStore(db);
    assert.deepEqual(after.shopInvites,before.shopInvites);
    assert.deepEqual(after.auditLog,before.auditLog);
    assert.equal(/[a-f0-9]{64}/.test(output+JSON.stringify(result.body)),false,'database errors must not expose invite hashes');
  } finally {
    await db.query('DROP TRIGGER reject_test_invite ON shop_invites; DROP FUNCTION reject_test_invite()');
  }
  assert.equal((await api('client','POST','/auth/shop-invites/claim',{token:original.token})).status,200);
});

test('HTTP Staff reads own legacy multi-shop artwork and mockups without crossing job scope', {skip}, async t => {
  const {db,api} = await setup(t, s => {
    s.orders[0].supplierId = null;
    s.orderJobs.push({...s.orderJobs[0], id:'other_job', supplierId:'replacement'});
    s.orderLineItems.push({...s.orderLineItems[0], id:'other_line', sortOrder:1, jobId:'other_job', catalogItemId:'item_replacement'});
    for (const purpose of ['artwork','mockup']) {
      for (const [key,line] of [['own',s.orderLineItems[0]],['foreign',s.orderLineItems[1]],['unattributed',null]]) {
        const fileId = `${purpose}_${key}`;
        if (line) line[`${purpose}FileId`] = fileId;
        s.files.push({fileId,purpose,ownerId:'client',state:'ready',objectKey:`private/${fileId}`,
          originalFilename:`${fileId}.png`,declaredContentType:'image/png',detectedContentType:'image/png',size:100,createdAt:AT,
          references:[{type:'order',id:'order',field:line ? `line:${line.id}:${purpose}` : `${purpose}FileIds`}]});
      }
      s.orders[0][`${purpose}FileIds`] = ['own','foreign','unattributed'].map(key=>`${purpose}_${key}`);
    }
  });
  // /health becomes available before boot-time MinIO recovery finishes.
  // Retry only that readiness response; authorization failures must fail immediately.
  let ready;
  for (let attempt = 0; attempt < 200; attempt++) {
    ready = await api('other','GET','/files/artwork_own',null,supplier);
    if (ready.status !== 503 || ready.body.error !== 'storage_initializing') break;
    await new Promise(resolve => setTimeout(resolve,25));
  }
  assert.equal(ready.status,200,bodyOf(ready));
  for (const who of ['supplier','other']) {
    const order = await api(who,'GET','/orders/order',null,supplier);
    assert.equal(order.status,200,bodyOf(order));
    assert.deepEqual(order.body.order.productionItems.map(line=>line.id),['line']);
    for (const purpose of ['artwork','mockup']) for (const suffix of ['', '/download-url']) {
      const own = await api(who,'GET',`/files/${purpose}_own${suffix}`,null,supplier);
      assert.equal(own.status,200,bodyOf(own));
      for (const key of ['foreign','unattributed']) {
        const denied = await api(who,'GET',`/files/${purpose}_${key}${suffix}`,null,supplier);
        assert.equal(denied.status,403,bodyOf(denied));
      }
    }
  }
  await mutate(db,s=>{s.orderJobs.find(job=>job.id==='job').state='cancelled';});
  assert.equal((await api('other','GET','/files/artwork_own',null,supplier)).status,403);
});

test('HTTP deny-by-default staff/pending/removed blocks every owner route; owners retain existing access', {skip},async t=>{
  const {db,api}=await setup(t);
  assert.equal((await api('supplier','GET','/me/supplier-profile')).status,200);
  assert.equal((await api('supplier','GET','/auth/me/supplier')).body.shop.role,'owner');
  const bootstrap=await api('other','GET','/auth/me/supplier');
  assert.equal(bootstrap.body.user.id,'other',bodyOf(bootstrap)); assert.equal(bootstrap.body.shop.role,'staff');
  assert.equal(bootstrap.body.user.email,undefined);
  for (const status of ['active','pending','removed']) {
    await mutate(db,s=>{s.shopMemberships.find(m=>m.userId==='other').status=status;});
    for (const [method,path] of OWNER_ROUTES) {
      const r=await api('other',method,path,method==='GET'?null:{},supplier);
      assert.equal(r.status,403,`${status} ${method} ${path}: ${bodyOf(r)}`);
      assert.equal(r.body.error,status==='active'?'shop_owner_required':status==='pending'?'shop_approval_pending':'shop_access_removed',`${method} ${path}`);
    }
    if(status!=='active') for(const [method,path] of STAFF_ROUTES.filter(([method,path])=>path!=='/files')) {
      const r=await api('other',method,path,method==='GET'?null:{},supplier);
      assert.equal(r.status,403,`${status} ${method} ${path}: ${bodyOf(r)}`);
      assert.equal(r.body.error,status==='pending'?'shop_approval_pending':'shop_access_removed');
    }
  }
  assert.equal((await api('other','GET','/auth/me/supplier')).body.error,'shop_access_removed');
  assert.equal((await api('supplier','GET','/me/supplier-profile')).status,200);
});

test('merged hours, tester and removal routes preserve shop and Super Admin boundaries', {skip}, async t => {
  const {db,api} = await setup(t);
  const hours = await api('supplier','GET','/me/shop-hours',null,supplier);
  assert.equal(hours.status,200,bodyOf(hours));
  const edit = {expectedVersion:hours.body.hours.version,schedule:{...hours.body.hours.schedule,
    weekdayOverrides:[{weekday:6,opensMinute:480,closesMinute:900}]}};
  for (const status of ['active','pending','removed']) {
    await mutate(db,s=>{s.shopMemberships.find(m=>m.userId==='other').status=status;});
    const error = status==='active' ? 'shop_owner_required' : status==='pending' ? 'shop_approval_pending' : 'shop_access_removed';
    for (const [path,body,opts] of [
      ['/me/shop-hours',edit,supplier],
      ['/ops/orders/order/remove',{reason:'Remove test order',confirmEmail:'client@example.invalid'},supplier],
      ['/me/tester-program/check-in',{app:'supplier',version:'1',source:'open'},{}],
    ]) {
      const response = await api('other',path==='/me/shop-hours'?'PATCH':'POST',path,body,opts);
      assert.equal(response.status,403,bodyOf(response)); assert.equal(response.body.error,error,bodyOf(response));
    }
    assert.equal((await api('other','GET','/me/tester-program?app=supplier')).body.error,error);
  }
  const edited = await api('supplier','PATCH','/me/shop-hours',edit,supplier);
  assert.equal(edited.status,200,bodyOf(edited));
  assert.deepEqual(edited.body.hours.schedule.weekdayOverrides,edit.schedule.weekdayOverrides);
  assert.equal((await api('supplier','GET','/me/tester-program?app=supplier',null,supplier)).status,200);
  for (const who of ['supplier','ops']) {
    const removed = await api(who,'POST','/ops/orders/order/remove',{reason:'Remove test order',confirmEmail:'client@example.invalid'});
    assert.equal(removed.status,403,bodyOf(removed)); assert.equal(removed.body.error,'forbidden');
  }
  await mutate(db,s=>{s.shopMemberships.find(m=>m.userId==='other').status='active';});
  assert.equal((await api('other','GET','/orders/order',null,supplier)).body.order.clientEmail,undefined);
  assert.equal((await api('admin','GET','/orders/order')).body.order.clientEmail,'client@example.invalid');
});

test('HTTP all invite kinds use verified identities, expire, revoke, claim once, approve/decline and guard last owner', {skip}, async t=>{
  const {db,api}=await setup(t,s=>{s.shopMemberships=[];});
  assert.equal((await api(null,'POST','/auth/shop-invites/claim',{token:'a'.repeat(43)})).status,401);
  assert.equal((await api('other','POST','/me/shop-team/invites',{kind:'link'},supplier)).status,403);
  for(const [kind,identity,account] of [['email','new@example.invalid','new'],['phone','+639171234567','phone'],['qr',undefined,'qr'],['link',undefined,'link']]) {
    const created=await invite(api,kind,identity);
    assert.equal(Date.parse(created.invite.expiresAt)-Date.parse(created.invite.createdAt),48*3600000);
    assert.match(created.token,/^[\w-]{43}$/); assert.equal(created.delivery,'share_link');
    if(identity) {
      const wrong=await api('client','POST','/auth/shop-invites/claim',{token:created.token});
      assert.equal(wrong.body.error,'shop_invite_identity_mismatch',bodyOf(wrong));
      const discovery=await api(account,'POST','/auth/shop-invites',{});
      assert.ok(discovery.body.invites.some(row=>row.id===created.invite.id),bodyOf(discovery));
    }
    const claim=await api(account,'POST','/auth/shop-invites/claim',identity?{inviteId:created.invite.id}:{token:created.token});
    assert.equal(claim.status,200,bodyOf(claim)); assert.equal(claim.body.member.status,'pending');
    const userId=claim.body.member.userId;
    assert.equal((await api(account,'GET','/jobs',null,supplier)).body.error,'shop_approval_pending');
    const again=await api(account,'POST','/auth/shop-invites/claim',{token:created.token});
    assert.equal(again.body.error,'shop_invite_used');
    const approved=await api('supplier','PATCH',`/me/shop-team/members/${userId}`,{status:'active'},supplier);
    assert.equal(approved.status,200,bodyOf(approved));
    assert.equal((await api(account,'GET','/jobs',null,supplier)).status,200);
  }
  const revoked=await invite(api);
  assert.equal((await api('supplier','DELETE',`/me/shop-team/invites/${revoked.invite.id}`,null,supplier)).status,200);
  assert.equal((await api('other','POST','/auth/shop-invites/claim',{token:revoked.token})).body.error,'shop_invite_revoked');
  // Build a genuinely expired invite at insertion; immutable issued timestamps cannot be edited.
  const expiredToken='z'.repeat(43);
  const {inviteHash}=await import('../src/shop-team.js');
  await db.query(`INSERT INTO shop_invites(id,shop_id,kind,token_hash,created_by,created_at,expires_at)
    VALUES ('expired','supplier','qr',$1,'supplier',now()-interval '49 hours',now()-interval '1 hour')`,[inviteHash(expiredToken)]);
  assert.equal((await api('other','POST','/auth/shop-invites/claim',{token:expiredToken})).body.error,'shop_invite_expired');
  const concurrent=await invite(api);
  const results=await Promise.all(['other','client'].map(account=>api(account,'POST','/auth/shop-invites/claim',{token:concurrent.token})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409],JSON.stringify(results));
  const claimant=results.find(r=>r.status===200).body.member.userId;
  assert.equal((await api('supplier','DELETE',`/me/shop-team/members/${claimant}`,null,supplier)).body.member.status,'removed');
  assert.equal((await api('supplier','PATCH',`/me/shop-team/members/${claimant}`,{status:'active'},supplier)).body.error,'shop_invite_required');
  for(const role of ['supplier','ops','admin']) {
    const path=role==='supplier'?'/me/shop-team/members/supplier':'/ops/shops/supplier/team/supplier';
    const r=await api(role,'DELETE',path,null,role==='supplier'?supplier:{});
    assert.equal(r.body.error,'last_shop_owner',bodyOf(r));
  }
  assert.equal((await api('supplier','PATCH','/me/shop-team/members/supplier',{role:'staff'},supplier)).body.error,'last_shop_owner');
  const store=await loadStore(db);
  assert.ok(store.shopInvites.every(row=>!row.token));
  assert.equal(store.users.filter(row=>row.role==='supplier').length,2);
  assert.equal(store.userRoleMemberships.filter(row=>row.role==='supplier').length,2);
});

test('HTTP Operations team reads/removal are audited, next call denied and connected app/web receives revocation', {skip},async t=>{
  const {db,api}=await setup(t);
  assert.equal((await api('client','GET','/ops/shops/supplier/team')).status,403);
  for(const who of ['ops','admin']) {
    const r=await api(who,'GET','/ops/shops/supplier/team'); assert.equal(r.status,200,bodyOf(r));
    assert.ok(r.body.members.some(m=>m.userId==='other'&&m.role==='staff')); assert.equal(r.body.invites,undefined);
  }
  const abort=new AbortController(); t.after(()=>abort.abort());
  const stream=await api('other','GET','/notifications/stream',null,{...supplier,stream:true,signal:abort.signal});
  assert.equal(stream.status,200);
  const reader=stream.body.getReader(); t.after(()=>reader.cancel().catch(()=>{}));
  await reader.read();
  const removed=await api('ops','DELETE','/ops/shops/supplier/team/other'); assert.equal(removed.status,200,bodyOf(removed));
  assert.equal((await api('other','GET','/orders/order',null,supplier)).body.error,'shop_access_removed');
  const data=await Promise.race([(async()=>{let text='';for(let i=0;i<10;i++){const r=await reader.read();text+=new TextDecoder().decode(r.value);if(r.done||text.includes('access_revoked')) return text;}return text;})(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('revocation missing')),5000);timer.unref();})]);
  assert.match(data,/access_revoked/); assert.match(data,/shop_access_removed/);
  const store=await loadStore(db);
  assert.ok(store.auditLog.some(row=>row.action==='shop_team.member_updated'&&row.actorId==='ops'&&row.after.status==='removed'));
});

test('HTTP staff receive scoped orders, accept at locked price, progress/chat actions identify the person, and money stays private', {skip},async t=>{
  const {db,api}=await setup(t,s=>{s.orders[0].state='supplier_assigned';s.orderJobs[0].state='approved_for_production';});
  const before=await loadStore(db), money=before.orders[0].supplierSubtotalMinor;
  const jobs=await api('other','GET','/jobs',null,supplier);
  assert.equal(jobs.status,200,bodyOf(jobs)); assert.equal(jobs.body.jobs.length,1);
  assert.equal(JSON.stringify(jobs.body).includes('Minor'),false,bodyOf(jobs));
  const denied=await api('other','POST','/orders/order/transition',{state:'payment_authorized',supplierPriceMinor:1},supplier);
  assert.equal(denied.body.error,'shop_owner_required');
  const accepted=await api('other','POST','/orders/order/transition',{state:'payment_authorized'},supplier);
  assert.equal(accepted.status,200,bodyOf(accepted));
  assert.equal(accepted.body.order.timeline.at(-1).actor.userId,'other');
  assert.ok(accepted.body.order.actions.some(a=>a.actor.userId==='other'&&a.actor.role==='staff'));
  const progressed=await api('other','POST','/orders/order/transition',{state:'production'},supplier);
  assert.equal(progressed.status,200,bodyOf(progressed));
  const chat=await api('other','POST','/orders/order/client-shop-chat/messages',{body:'Printing the order now'},supplier);
  assert.equal(chat.status,201,bodyOf(chat)); assert.equal(chat.body.message.mine,true);
  const sent=await db.query('SELECT sender_user_id FROM client_shop_chat_messages WHERE id=$1',[chat.body.message.id]);
  assert.equal(sent.rows[0].sender_user_id,'other');
  for(const who of ['supplier','ops','admin']) {
    const r=await api(who,'GET','/orders/order'); assert.equal(r.status,200,bodyOf(r));
    assert.ok(r.body.order.actions.some(a=>a.action==='client_shop_chat.message_sent'&&a.actor.userId==='other'&&a.actor.role==='staff'),bodyOf(r));
  }
  assert.equal((await api('client','GET','/orders/order')).body.order.actions,undefined);
  assert.equal((await loadStore(db)).orders[0].supplierSubtotalMinor,money);
  assert.equal((await api('other','GET','/orders/foreign',null,supplier)).status,404);
  assert.equal((await api('other','GET','/files/photo_supplier',null,supplier)).body.error,'shop_owner_required');
  const notReady=await api('other','POST','/orders/order/production-finished',{},supplier);
  assert.equal(notReady.status,409,bodyOf(notReady));
  assert.notEqual(notReady.body.error,'shop_owner_required');
  await assert.rejects(db.query("UPDATE order_actions SET actor_name='tampered'"),/append-only/);
});

test('additive migration backfills every existing supplier owner and retains Clerk subjects', {skip}, async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());
  await db.transaction(async()=>{
    await db.query('CREATE SCHEMA shop_team_migration_test');
    try {
      await db.query('SET LOCAL search_path TO shop_team_migration_test');
      await db.query(`CREATE TABLE users(id text PRIMARY KEY,name text,clerk_user_id text);
        CREATE TABLE user_role_memberships(user_id text,role text,created_at timestamptz);
        CREATE TABLE orders(id text PRIMARY KEY);
        CREATE TABLE audit_log(id text,order_id text,actor_id text,actor_role text,action text,at timestamptz,data jsonb);
        INSERT INTO users VALUES ('owner','Owner','same_clerk_subject'),('client','Client','client_subject');
        INSERT INTO user_role_memberships VALUES ('owner','supplier',now()),('client','client',now());`);
      await up({sql:sql=>db.query(sql)});
      const rows=(await db.query('SELECT * FROM shop_memberships')).rows;
      assert.equal(rows.length,1);assert.equal(rows[0].role,'owner');assert.equal(rows[0].status,'active');
      assert.equal((await db.query("SELECT clerk_user_id FROM users WHERE id='owner'")).rows[0].clerk_user_id,'same_clerk_subject');
    } finally {await db.query('SET LOCAL search_path TO public');await db.query('DROP SCHEMA shop_team_migration_test CASCADE');}
  });
});

test('HTTP staff finished files, QA, ready and rider handoff retain all evidence gates and record individual actors', {skip}, async t=>{
  const {db,api}=await setup(t,s=>{
    s.orders[0].shopHandoverVersion=2;
    s.approvalCases.push({id:'case_rider',userId:'rider',kind:'rider',status:'approved',version:1,applicationRevision:1,createdAt:AT,updatedAt:AT});
    for(const [fileId,purpose,ownerId] of [['finished','finished_product_photo','supplier'],['packed','packing_photo','rider'],['signature','handoff_signature','rider'],['artwork','artwork','client']]) {
      s.files.push({fileId,purpose,ownerId,createdByUserId:ownerId==='supplier'?'other':ownerId,state:'ready',objectKey:`private/${fileId}`,
        originalFilename:'photo.png',declaredContentType:'image/png',detectedContentType:'image/png',size:100,createdAt:AT,
        references:fileId==='artwork'?[{type:'order',id:'order',field:'artworkFileIds',jobId:'job'}]:[]});
    }
    s.orders[0].artworkFileIds=['artwork'];
    const foreign=structuredClone(s.orders[0]);foreign.id='foreign';foreign.supplierId='replacement';s.orders.push(foreign);
  });
  const post=(who,path,body={})=>api(who,'POST',path,body,who==='other'?supplier:{});
  const ok=r=>{assert.equal(r.status,200,bodyOf(r));return r.body;};
  assert.equal((await api('other','GET','/orders/foreign',null,supplier)).status,403);
  assert.equal((await post('other','/orders/foreign/transition',{state:'ready_for_dispatch'})).status,403);
  assert.equal((await post('other','/orders/order/transition',{state:'ready_for_dispatch'})).body.error,'production_finished_required');
  ok(await post('other','/files/finished/attach',{orderId:'order'}));
  ok(await api('other','GET','/files/finished',null,supplier));
  ok(await api('other','GET','/files/finished/download-url',null,supplier));
  ok(await api('other','GET','/files/artwork/download-url',null,supplier));
  ok(await post('other','/orders/order/production-finished'));
  assert.equal((await post('other','/orders/order/transition',{state:'ready_for_dispatch'})).body.error,'production_review_required');
  assert.equal((await post('other','/orders/order/production-review',{decision:'approved'})).status,403);
  ok(await post('ops','/orders/order/production-review',{decision:'approved'}));
  const ready=ok(await post('other','/orders/order/transition',{state:'ready_for_dispatch'})).order;
  assert.equal(ready.handoverFlow,'rider_packs');assert.equal(ready.transitionReadiness.ready_for_dispatch.receiptScan.required,false);
  ok(await post('rider','/dispatch/order/accept'));
  const chat=await post('other','/orders/order/pickup-chat/messages',{body:'The prints are ready at the counter'});
  assert.equal(chat.status,201,bodyOf(chat));assert.equal(chat.body.message.mine,true);
  ok(await api('other','GET','/orders/order/pickup-chat',null,supplier));
  ok(await api('other','GET','/dispatch/order/location',null,supplier));
  const sent=await db.query('SELECT sender_user_id FROM pickup_chat_messages WHERE id=$1',[chat.body.message.id]);assert.equal(sent.rows[0].sender_user_id,'other');
  assert.equal((await post('other','/dispatch/order/pickup-confirm',{signature:{fileId:'signature',signerName:'Sam'}})).body.error,'shop_owner_required');
  assert.equal((await post('rider','/dispatch/order/pickup-confirm',{signature:{fileId:'signature',signerName:'Sam'}})).body.error,'unpacked_inspection_required');
  ok(await post('rider','/dispatch/order/pickup-checklist',{checks:PICKUP_CHECK_CODES.map(code=>({code,passed:true})),counts:[{lineItemId:'line',countedQuantity:10}]}));
  ok(await post('rider','/files/packed/attach',{orderId:'order'}));
  ok(await post('rider','/files/signature/attach',{orderId:'order'}));
  ok(await post('rider','/dispatch/order/pickup-confirm',{signature:{fileId:'signature',signerName:'Sam'}}));
  const final=(await loadStore(db)).orders.find(row=>row.id==='order');
  assert.equal(final.state,'picked_up');assert.equal(final.shopHandover.finished.by,'other');
  const history=ok(await api('ops','GET','/orders/order')).order.actions;
  for(const action of ['order.production_finished','pickup_chat.message_sent','artwork.download_authorized']) {
    assert.ok(history.some(row=>row.action===action&&row.actor.userId==='other'&&row.actor.role==='staff'),JSON.stringify(history));
  }
});

test('HTTP decline records staff actor; new-order notifications reach only active teammates and stop after removal', {skip},async t=>{
  const {db,api}=await setup(t,s=>{s.orders[0].state='needs_qa';});
  const assigned=await api('ops','POST','/orders/order/transition',{state:'supplier_assigned'});
  assert.equal(assigned.status,200,bodyOf(assigned));
  await mutate(db,s=>{s.notifications.push({id:'finance',userId:'supplier',appRole:'supplier',type:'shop_payout_released',orderId:'order',title:'Paid',body:'Private amount',at:new Date().toISOString(),read:false});});
  const inbox=await api('other','GET','/notifications',null,supplier);
  assert.equal(inbox.status,200,bodyOf(inbox));assert.ok(inbox.body.notifications.some(n=>n.type==='shop_job_assigned'));
  assert.ok(!inbox.body.notifications.some(n=>n.type==='shop_payout_released'));
  const notificationId=inbox.body.notifications.find(n=>n.type==='shop_job_assigned').id;
  const delivery=await loadDeliveryStore(db,{userIds:['other'],notificationIds:[notificationId]});
  assert.equal(notificationVisible(delivery,delivery.notifications[0],'other','supplier'),true);
  const decline=await api('other','POST','/orders/order/decline',{reason:'Printer unavailable'},supplier);
  assert.equal(decline.status,200,bodyOf(decline));
  let store=await loadStore(db);
  assert.equal(store.orders[0].shopFailureEvents.at(-1).actorId,'other');
  assert.ok(store.orderActions.some(a=>a.actorUserId==='other'&&a.actorRole==='staff'));
  assert.equal((await api('supplier','DELETE','/me/shop-team/members/other',null,supplier)).status,200);
  const removed=await loadDeliveryStore(db,{userIds:['other'],notificationIds:[notificationId]});
  assert.equal(notificationVisible(removed,removed.notifications[0],'other','supplier'),false);
});

test('HTTP promoting a second Owner preserves the last-owner guard, demotion hides old finance notices and removed original Owner cannot return', {skip},async t=>{
  const {db,api}=await setup(t,s=>{
    for(const [id,type] of [['old_money','shop_payout_released'],['old_job','shop_job_assigned']]) s.notifications.push({id,userId:'supplier',appRole:'supplier',type,orderId:'order',title:'Notice',body:type==='shop_payout_released'?'PHP 10000':'Job',at:AT,read:false});
  });
  const promoted=await api('supplier','PATCH','/me/shop-team/members/other',{role:'owner'},supplier);
  assert.equal(promoted.status,200,bodyOf(promoted));
  assert.equal((await api('other','GET','/me/supplier-profile',null,supplier)).status,200);
  const demoted=await api('other','PATCH','/me/shop-team/members/supplier',{role:'staff'},supplier);
  assert.equal(demoted.status,200,bodyOf(demoted));
  assert.equal((await api('supplier','GET','/me/payout-account',null,supplier)).body.error,'shop_owner_required');
  const inbox=await api('supplier','GET','/notifications',null,supplier);
  assert.equal(inbox.status,200,bodyOf(inbox));assert.ok(inbox.body.notifications.some(n=>n.id==='old_job'));
  assert.ok(!inbox.body.notifications.some(n=>n.id==='old_money'));
  const delivery=await loadDeliveryStore(db,{userIds:['supplier'],notificationIds:['old_money']});
  assert.equal(notificationVisible(delivery,delivery.notifications[0],'supplier'),false);
  assert.equal((await api('other','DELETE','/me/shop-team/members/other',null,supplier)).body.error,'last_shop_owner');
  assert.equal((await api('other','DELETE','/me/shop-team/members/supplier',null,supplier)).status,200);
  assert.equal((await api('supplier','GET','/auth/me/supplier')).body.error,'shop_access_removed');
  assert.equal((await api('supplier','GET','/orders/order')).body.error,'shop_access_removed');
  assert.equal((await api('other','GET','/orders/order',null,supplier)).status,200);
});

test('paged staff administration preserves shop refusals and independent admin/Owner access', {skip}, async t => {
  const {db,api} = await setup(t, store => {
    store.shopMemberships.push({shopId:'supplier',userId:'admin',role:'staff',status:'active',createdAt:AT,updatedAt:AT});
  });
  const paths = ['/admin/staff','/admin/staff/invites','/admin/staff/roles'];
  for (const status of ['active','pending','removed']) {
    await mutate(db, store => { store.shopMemberships.find(row => row.userId === 'other').status = status; });
    const error = status === 'active' ? 'shop_owner_required' : status === 'pending' ? 'shop_approval_pending' : 'shop_access_removed';
    for (const path of [...paths,'/supplier-services']) for (const query of ['', '?limit=1', '?cursor=bad']) {
      const result = await api('other','GET',path+query,null,supplier);
      assert.equal(result.status,403,bodyOf(result)); assert.equal(result.body.error,error);
    }
  }
  for (const path of paths) {
    for (const who of ['supplier','other']) assert.equal((await api(who,'GET',path+'?limit=1',null,supplier)).status,403);
    const admin = await api('admin','GET',path+'?limit=1',null,{headers:{'X-GRIDGO-Role':'super_admin'}});
    assert.equal(admin.status,200,bodyOf(admin)); assert.ok('nextCursor' in admin.body);
    assert.equal((await api('admin','GET',path+'?limit=1')).status,200);
    assert.equal((await api('admin','GET',path+'?limit=1',null,supplier)).body.error,'shop_owner_required');
  }
  await mutate(db, store => { Object.assign(store.shopMemberships.find(row => row.userId === 'other'),{role:'owner',status:'active'}); });
  const page = await api('other','GET','/supplier-services?limit=1',null,supplier);
  assert.equal(page.status,200,bodyOf(page)); assert.equal(page.body.services.length,1);
  assert.ok(page.body.services.every(row => row.supplierId === 'supplier'));
  assert.ok('nextCursor' in page.body);
  assert.equal((await api('other','GET','/admin/staff?limit=1',null,supplier)).status,403);
});
