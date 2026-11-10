import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { saveStore } from '../src/postgres-store.js';
import { fixture } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { resolveAuthorizationContext } from '../src/authorization-context.js';
import { routePlayOptin, validGoogleEmail } from '../src/play-optin.js';

const DB = process.env.DATABASE_URL;
const checked = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body; };
const install = { platform: 'android', channel: 'sideload' };
const own = (app = 'client', channel = 'sideload', platform = 'android') => `/me/play-optin?app=${app}&channel=${channel}&platform=${platform}`;
async function setup(t) {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE tester_program_settings, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  await db.transaction(() => saveStore(db, store));
  const api = await apiForTest(t);
  const enable = async (app = 'client') => checked(await api('ops', 'PATCH', '/ops/testers/settings', {
    app, campaignEnabled: true, groupJoinUrl: 'https://groups.google.com/g/gridgo-testers', target: 12 }));
  const event = (type, app = 'client', user = app) => api(user, 'POST', '/me/play-optin/event', { app, type, ...install });
  return { db, api, enable, event, store };
}

test('Google email validation requires explicit Google account assertion for custom domains', () => {
  for (const email of ['tester@gmail.com','tester+gridgo@googlemail.com']) assert.ok(validGoogleEmail(email));
  assert.ok(validGoogleEmail('tester@example.org', true));
  for (const email of ['tester@example.org','a..b@gmail.com','.ab@gmail.com','ab.@gmail.com','a b@gmail.com','a@gmail.com\n','a@-gmail.com','a@gmail..com','a@gmail.com.evil']) assert.equal(validGoogleEmail(email), false, email);
});

test('Android campaign eligibility, fallback funnel, three dismissals, Play detection and enrollment are app scoped', { skip: !DB }, async t => {
  const { db, api, enable, event } = await setup(t);
  assert.equal(checked(await api('client', 'GET', own())).show, false);
  await enable();
  const enabled = checked(await api('client', 'GET', own()));
  assert.equal(enabled.show, true);
  assert.equal(enabled.optInUrl, 'https://play.google.com/apps/testing/ph.gridgo.client');
  assert.equal(checked(await api('client', 'GET', own('client','sideload','ios'))).show, false);
  assert.equal(checked(await api('client', 'GET', own('client','sideload','web'))).show, false);
  checked(await event('tapped'));
  const unfinishedTap = checked(await api('ops','GET','/ops/testers?app=client')).playOptIn.unfinished;
  assert.equal(unfinishedTap.length, 1); assert.equal(unfinishedTap[0].lastStep, 'confirm_gmail');
  checked(await event('optin_opened'), 409);
  checked(await api('client','POST','/me/play-optin/confirm-gmail',{ app:'client', email:'x@example.org', ...install }),400);
  const confirm = checked(await api('client','POST','/me/play-optin/confirm-gmail',{ app:'client', email:'TESTER@gmail.com', ...install }));
  assert.equal(confirm.groupMode, 'link'); assert.equal(confirm.step,'join_group');
  assert.equal(confirm.groupJoinUrl, 'https://groups.google.com/g/gridgo-testers');
  checked(await event('optin_opened'),409); checked(await event('group_opened')); checked(await event('optin_opened'));
  assert.equal((await db.query('SELECT opted_in_at,group_joined_at FROM tester_program_play_optins')).rows[0].opted_in_at, null);
  assert.equal((await db.query('SELECT group_joined_at FROM tester_program_play_optins')).rows[0].group_joined_at, null);
  let dashboard = checked(await api('ops','GET','/ops/testers?app=client'));
  assert.equal(dashboard.playOptIn.unfinished[0].lastStep,'install_from_play');
  assert.equal(dashboard.playOptIn.unfinished[0].gmail,'tester@gmail.com');
  for (let i=0;i<3;i++) checked(await event('dismissed'));
  assert.equal(checked(await api('client','GET',own())).show,false);
  checked(await event('dismissed'),409);
  const play = checked(await api('client','GET',own('client','play')));
  assert.equal(play.show,false); assert.equal(play.optedIn,true);
  assert.equal(checked(await api('client','GET',own())).show,false);
  assert.equal(checked(await api('client','GET','/me/tester-program?app=client')).enrolled,true);
  assert.equal(checked(await api('client','POST','/me/tester-program/check-in',{ app:'client',version:'1.0',source:'open' })).day,1);
  await api('client','GET',own('client','play'));
  assert.equal((await db.query('SELECT count(*) FROM tester_program_enrollments')).rows[0].count,1);
  checked(await api('ops','PATCH','/ops/testers/settings',{ app:'client',optedInCount:5,target:15 }));
  dashboard = checked(await api('ops','GET','/ops/testers?app=client'));
  assert.equal(dashboard.stats.needed,15); assert.equal(dashboard.stats.optedInCount,5);
  assert.equal(dashboard.playOptIn.optedInCount,1); assert.equal(dashboard.playOptIn.detectedPlayCount,1);
  assert.equal(dashboard.playOptIn.playConsoleOptedInCount,5); assert.deepEqual(dashboard.playOptIn.unfinished,[]);
  assert.equal(checked(await api('ops','GET','/ops/testers?app=supplier')).playOptIn.optedInCount,0);
});

test('automatic group join uses a mock client; retryable failures do not advance group state; custom Google account supported', { skip: !DB }, async t => {
  const { db, api, enable, store } = await setup(t); await enable(); await api('client','GET',own());
  const user = store.users.find(row=>row.id==='client'); resolveAuthorizationContext(store,user);
  const calls=[]; let down=true;
  const groups={ configured:()=>true, addMember: async(app,email)=>{ calls.push({app,email}); if(down) throw Error('private provider detail'); } };
  const call=body=>routePlayOptin({ req:{method:'POST'},url:new URL('http://test/me/play-optin/confirm-gmail'), user,database:db,
    readBody:async()=>({app:'client',...install,...body}),auditEvent:async()=>{},groups });
  checked(await call({email:'tester@gmail.com'}),503);
  assert.equal((await db.query('SELECT email FROM tester_program_play_optins')).rows[0].email,null);
  down=false;
  const response=checked(await call({email:'TESTER@example.org',googleAccount:true}));
  assert.equal(response.groupMode,'automatic'); assert.equal(response.step,'open_optin');
  assert.deepEqual(calls.at(-1),{app:'client',email:'tester@example.org'});
  assert.ok((await db.query('SELECT group_joined_at FROM tester_program_play_optins')).rows[0].group_joined_at);
  checked(await api('client','POST','/me/play-optin/event',{app:'client',type:'optin_opened',...install}));
});

test('role checks, settings validation, ops marking and account/app isolation', { skip: !DB }, async t => {
  const { db, api, enable, event }=await setup(t); await enable();
  const routes=[['GET',own()],['POST','/me/play-optin/confirm-gmail',{app:'client',email:'a@gmail.com',...install}],
    ['POST','/me/play-optin/event',{app:'client',type:'tapped',...install}],['POST','/ops/testers/broadcast',{app:'client'}],
    ['POST','/ops/testers/client/client/opt-in',{}]];
  for(const [method,path,body] of routes) checked(await api(null,method,path,body),401);
  for(const [method,path,body] of routes.slice(0,3)) checked(await api('supplier',method,path,body),403);
  for(const [method,path,body] of routes.slice(3)) checked(await api('client',method,path,body),403);
  checked(await api('client','GET','/me/play-optin?app=bad&channel=sideload&platform=android'),400);
  checked(await api('client','GET','/me/play-optin?app=client'),400);
  for(const patch of [{campaignEnabled:1},{target:0},{optInUrl:'https://evil.test/apps/testing/ph.gridgo.client'},
    {groupJoinUrl:'javascript:alert(1)'},{groupJoinUrl:'https://groups.google.com.evil/g/x'}]) checked(await api('ops','PATCH','/ops/testers/settings',{app:'client',...patch}),400);
  checked(await api('ops','PATCH','/ops/testers/settings',{app:'client',groupJoinUrl:'https://groups.google.com/a/example.org/g/testers'}));
  checked(await api('ops','POST','/ops/testers/client/supplier/opt-in',{}),404);
  checked(await api('admin','POST','/ops/testers/client/client/opt-in',{}));
  checked(await api('ops','POST','/ops/testers/client/client/opt-in',{}));
  assert.equal((await db.query("SELECT count(*) FROM tester_program_enrollments WHERE user_id='client'")).rows[0].count,1);
  const dashboard=checked(await api('ops','GET','/ops/testers?app=client'));
  assert.equal(dashboard.playOptIn.optedInCount,1); assert.equal(dashboard.playOptIn.detectedPlayCount,0);
  assert.equal(checked(await api('client','GET',own())).show,false);
  checked(await event('tapped'),409);
  await db.query("UPDATE users SET review_data=true WHERE id='ops'");
  for(const [method,path,body] of routes) assert.equal(checked(await api('ops',method,path,body),403).error,'test_operations_forbidden');
});

test('broadcast targets eligible Android installs of one app, uses outbox, and leaves orders byte-for-byte unchanged', { skip: !DB }, async t => {
  const { db, api, enable }=await setup(t); await enable(); await enable('supplier');
  const device=async(user,app,platform,installChannel,token)=>checked(await api(user,'POST','/devices',{token,appRole:app,platform,installChannel}),201);
  await device('client','client','android','apk','optin-client-android');
  await device('client','client','ios','ios','optin-client-ios');
  await device('client','client','web','apk','optin-client-web');
  await device('supplier','supplier','android','apk','optin-supplier-android');
  await device('other','client','android','play','optin-other-play');
  await device('other','client','android','apk','optin-other-apk');
  await db.query("UPDATE orders SET state='issue_window_open',issue_window_expires_at='2020-01-01T00:00:00Z' WHERE id='order'");
  const orders=async()=> (await db.query('SELECT row_to_json(o) AS row FROM orders o ORDER BY id')).rows;
  const before=await orders();
  const announcement=checked(await api('ops','POST','/ops/testers/broadcast',{app:'client'}),201).announcement;
  assert.equal(announcement.notifiedUsers,1); assert.equal(announcement.unclaimedDevices,0);
  const notifications=(await db.query("SELECT * FROM notifications WHERE type='play_optin'")).rows;
  assert.equal(notifications.length,1); assert.equal(notifications[0].user_id,'client');
  assert.equal(notifications[0].data.appRole,'client');
  const outbox=(await db.query(`SELECT d.token FROM notification_push_outbox o JOIN device_tokens d ON d.id=o.device_id WHERE o.notification_id=$1`,[notifications[0].id])).rows;
  assert.deepEqual(outbox,[{token:'optin-client-android'}]);
  assert.deepEqual(await orders(),before);
  await api('client','GET',own());
  for(let i=0;i<3;i++) checked(await api('client','POST','/me/play-optin/event',{app:'client',type:'dismissed',...install}));
  assert.equal(checked(await api('ops','POST','/ops/testers/broadcast',{app:'client'}),201).announcement.notifiedUsers,0);
  await api('client','GET',own('client','play'));
  assert.equal(checked(await api('ops','POST','/ops/testers/broadcast',{app:'client'}),201).announcement.notifiedUsers,0);
  assert.equal(checked(await api('ops','POST','/ops/testers/broadcast',{app:'supplier'}),201).announcement.notifiedUsers,1);
  assert.deepEqual(await orders(),before);
  checked(await api('ops','PATCH','/ops/testers/settings',{app:'client',campaignEnabled:false}));
  checked(await api('ops','POST','/ops/testers/broadcast',{app:'client'}),409);
});

test('first Play detection records opt-in without reversing staff removal, for every app', { skip: !DB }, async t => {
  const { db, api } = await setup(t);
  for (const app of ['client', 'supplier', 'rider']) {
    checked(await api('ops', 'POST', '/ops/testers', { app, email: `${app}@example.invalid` }));
    checked(await api('ops', 'DELETE', `/ops/testers/${app}/${app}`));
    const removed = (await db.query('SELECT * FROM tester_program_enrollments WHERE user_id=$1 AND app=$2', [app, app])).rows;
    assert.equal(checked(await api(app, 'GET', `/me/tester-program?app=${app}`)).enrolled, false);
    const play = checked(await api(app, 'GET', own(app, 'play')));
    assert.equal(play.optedIn, true); assert.equal(play.show, false);
    assert.equal(checked(await api(app, 'GET', `/me/tester-program?app=${app}`)).enrolled, false);
    checked(await api(app, 'POST', '/me/tester-program/check-in', { app, version: 'test-play', source: 'open' }), 404);
    assert.deepEqual((await db.query('SELECT * FROM tester_program_enrollments WHERE user_id=$1 AND app=$2', [app, app])).rows, removed);
    assert.equal(checked(await api('ops', 'GET', `/ops/testers?app=${app}`)).playOptIn.optedInCount, 1);
    // Only explicit staff enrollment reverses removal; another Play report
    // preserves the newly active run, then still respects a later removal.
    checked(await api('ops', 'POST', '/ops/testers', { app, email: `${app}@example.invalid` }));
    const active = (await db.query('SELECT * FROM tester_program_enrollments WHERE user_id=$1 AND app=$2 AND removed_at IS NULL', [app, app])).rows;
    checked(await api(app, 'GET', own(app, 'play')));
    assert.deepEqual((await db.query('SELECT * FROM tester_program_enrollments WHERE user_id=$1 AND app=$2 AND removed_at IS NULL', [app, app])).rows, active);
    checked(await api('ops', 'DELETE', `/ops/testers/${app}/${app}`));
    checked(await api(app, 'GET', own(app, 'play')));
    assert.equal(checked(await api(app, 'GET', `/me/tester-program?app=${app}`)).enrolled, false);
  }
});

test('staff opt-in marking preserves removal and removal in another app does not block first enrollment', { skip: !DB }, async t => {
  const { db, api } = await setup(t);
  checked(await api('ops', 'POST', '/ops/testers', { app: 'client', email: 'other@example.invalid' }));
  checked(await api('ops', 'DELETE', '/ops/testers/client/other'));
  checked(await api('ops', 'POST', '/ops/testers/client/other/opt-in', {}));
  assert.equal(checked(await api('other', 'GET', own())).optedIn, true);
  assert.equal(checked(await api('other', 'GET', '/me/tester-program?app=client')).enrolled, false);
  await db.query("INSERT INTO user_role_memberships(user_id,role,created_at) VALUES ('supplier','client',now())");
  checked(await api('ops', 'POST', '/ops/testers', { app: 'supplier', email: 'supplier@example.invalid' }));
  checked(await api('ops', 'DELETE', '/ops/testers/supplier/supplier'));
  checked(await api('supplier', 'GET', own('client', 'play')));
  assert.equal(checked(await api('supplier', 'GET', '/me/tester-program?app=client')).enrolled, true);
  assert.equal(checked(await api('supplier', 'GET', '/me/tester-program?app=supplier')).enrolled, false);
});

test('a registered same-app Android Play install hides an APK Home card before its first campaign report', { skip: !DB }, async t => {
  const { db, api, enable } = await setup(t);
  for (const app of ['client', 'supplier', 'rider']) {
    await enable(app);
    checked(await api(app, 'POST', '/devices', { token: `known-${app}-play`, appRole: app, platform: 'android', installChannel: 'play' }), 201);
    checked(await api(app, 'POST', '/devices', { token: `known-${app}-apk`, appRole: app, platform: 'android', installChannel: 'apk' }), 201);
    assert.equal((await db.query('SELECT count(*) FROM tester_program_play_optins WHERE user_id=$1 AND app=$2', [app, app])).rows[0].count, 0);
    assert.equal(checked(await api('ops', 'POST', '/ops/testers/broadcast', { app }), 201).announcement.notifiedUsers, 0);
    const state = checked(await api(app, 'GET', own(app)));
    assert.equal(state.show, false); assert.equal(state.optedIn, true); assert.equal(state.step, 'opted_in');
    assert.equal(checked(await api(app, 'GET', `/me/tester-program?app=${app}`)).enrolled, true);
    // Removing the registration later must not clear the observed opt-in.
    checked(await api(app, 'POST', '/devices/unregister', { token: `known-${app}-play` }));
    assert.equal(checked(await api(app, 'GET', own(app))).show, false);
  }
});

test('known Play registration excludes campaign writes even before Home refreshes and preserves removed enrollment', { skip: !DB }, async t => {
  const { db, api, enable } = await setup(t); await enable();
  checked(await api('client', 'GET', own()));
  checked(await api('ops', 'POST', '/ops/testers', { app: 'client', email: 'client@example.invalid' }));
  checked(await api('ops', 'DELETE', '/ops/testers/client/client'));
  checked(await api('client', 'POST', '/devices', { token: 'known-client-play', appRole: 'client', platform: 'android', installChannel: 'play' }), 201);
  assert.equal(checked(await api('client', 'POST', '/me/play-optin/confirm-gmail', { app: 'client', email: 'tester@gmail.com', ...install }), 409).error, 'campaign_not_available');
  assert.equal(checked(await api('client', 'POST', '/me/play-optin/event', { app: 'client', type: 'tapped', ...install }), 409).error, 'campaign_not_available');
  const row = (await db.query("SELECT * FROM tester_program_play_optins WHERE user_id='client' AND app='client'")).rows[0];
  assert.equal(row.email, null); assert.equal(row.tapped_at, null);
  const state = checked(await api('client', 'GET', own()));
  assert.equal(state.show, false); assert.equal(state.optedIn, true);
  assert.equal(checked(await api('client', 'GET', '/me/tester-program?app=client')).enrolled, false);
});

test('known Play lookup ignores other accounts, apps, unknown app scopes and non-Android registrations', { skip: !DB }, async t => {
  const { db, api, enable } = await setup(t); await enable(); await enable('supplier');
  // A multi-role supplier can have Play on a different app without opting
  // their supplier app in. Registration still uses the real membership gate.
  await db.query("INSERT INTO user_role_memberships(user_id,role,created_at) VALUES ('supplier','client',now())");
  checked(await api('supplier', 'POST', '/devices', { token: 'scope-other-app', appRole: 'client', platform: 'android', installChannel: 'play' }), 201);
  checked(await api('other', 'POST', '/devices', { token: 'scope-other-account', appRole: 'client', platform: 'android', installChannel: 'play' }), 201);
  checked(await api('client', 'POST', '/devices', { token: 'scope-unknown-app', platform: 'android', installChannel: 'play' }), 201);
  checked(await api('client', 'POST', '/devices', { token: 'scope-web', appRole: 'client', platform: 'web', installChannel: 'play' }), 201);
  checked(await api('client', 'POST', '/devices', { token: 'scope-ios', appRole: 'client', platform: 'ios', installChannel: 'play' }), 201);
  assert.equal(checked(await api('client', 'GET', own())).show, true);
  assert.equal(checked(await api('supplier', 'GET', own('supplier'))).show, true);
  checked(await api('client', 'POST', '/me/play-optin/confirm-gmail', { app: 'client', email: 'tester@gmail.com', ...install }));
  assert.equal((await db.query('SELECT count(*) FROM tester_program_enrollments')).rows[0].count, 0);
});
