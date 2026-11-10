import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { appendAnnouncement } from '../src/announcements.js';
import { enqueueNotificationPushes, createOutboxWorker } from '../src/push-outbox.js';
import * as play from '../src/play-optin.js';
import { fixture, id } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { resetDatabase } from './fixtures/reset-database.js';
const DB = process.env.DATABASE_URL;
const checked = (res, status=200) => { assert.equal(res.status,status,JSON.stringify(res.body)); return res.body; };
async function setup(t) {
  const db=createDatabase({DATABASE_URL:DB}); t.after(()=>db.close());
  await resetDatabase(db,'TRUNCATE tester_program_settings, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  await db.transaction(()=>saveStore(db,fixture()));
  const api=await apiForTest(t);
  const enable=async(app='client', extra={})=>checked(await api('ops','PATCH','/ops/testers/settings',{
    app,campaignEnabled:true,groupJoinUrl:'https://groups.google.com/g/gridgo-testers',...extra}));
  const device=async(user,app=user,platform='android',installChannel='apk')=>checked(await api(user,'POST','/devices',{
    token:id('device'),appRole:app,platform,installChannel}),201);
  const broadcastFor=database=>async({app,recipientIds,actor,at})=>{
    const store=await loadStore(database);
    const {announcement}=appendAnnouncement(store,{audience:`${app}s`,app,recipientIds,actor,type:'play_optin',
      title:'Help us launch GRIDGO on Play',body:play.PLAY_OPTIN_COPY},{id,at,audit:(s,e)=>s.auditLog.push({
        id:id('aud'),at,actorId:e.actor?.id||null,actorRole:e.actor?.role||'system',action:e.action,
        entityType:e.entityType,entityId:e.entityId,detail:e.detail})});
    const created=store.notifications.filter(n=>n.announcementId===announcement.id);
    await saveStore(database,store); await enqueueNotificationPushes(database,store,created);
    return announcement;
  };
  const broadcast=broadcastFor(db);
  const run=(at, database=db, send=broadcastFor(database))=>play.runPlayOptinReminders({database,broadcast:send,at});
  const notices=async()=> (await db.query("SELECT user_id,data->>'appRole' AS app FROM notifications WHERE type='play_optin' ORDER BY user_id,app")).rows;
  return {db,api,enable,device,run,notices,broadcast};
}

test('daily settings default, persist per app, validate hours and preserve omitted values', {skip:!DB}, async t=>{
  const {api,enable}=await setup(t);
  let settings=checked(await api('ops','GET','/ops/testers?app=client')).playOptIn;
  assert.equal(settings.dailyReminderEnabled,true); assert.equal(settings.dailyReminderHour,10);
  await enable('client',{dailyReminderEnabled:false,dailyReminderHour:0});
  await enable('client',{target:20});
  settings=checked(await api('ops','GET','/ops/testers?app=client')).playOptIn;
  assert.equal(settings.dailyReminderEnabled,false); assert.equal(settings.dailyReminderHour,0);
  assert.equal(checked(await api('ops','GET','/ops/testers?app=rider')).playOptIn.dailyReminderHour,10);
  for(const patch of [{dailyReminderEnabled:1},{dailyReminderHour:-1},{dailyReminderHour:24},{dailyReminderHour:1.5},{dailyReminderHour:'10'},{dailyReminderHour:null}])
    checked(await api('ops','PATCH','/ops/testers/settings',{app:'client',...patch}),400);
});

test('daily reminders use eligible app-scoped Android recipients and existing announcement/outbox copy', {skip:!DB}, async t=>{
  const {db,api,enable,device,run,notices}=await setup(t);
  for(const app of ['client','supplier','rider']) { await enable(app); await device(app); }
  await device('other','client','ios','ios'); await device('other','client','web');
  // A non-Android Play-channel report is not an Android Play install.
  assert.equal(checked(await api('client','GET','/me/play-optin?app=client&platform=ios&channel=play')).optedIn,false);
  await run('2026-11-10T02:00:00Z');
  assert.deepEqual(await notices(),[{user_id:'client',app:'client'},{user_id:'rider',app:'rider'},{user_id:'supplier',app:'supplier'}]);
  assert.equal((await db.query('SELECT count(*) FROM notification_push_outbox')).rows[0].count,3);
  const n=(await db.query("SELECT data->>'title' AS title,data->>'body' AS body FROM notifications WHERE type='play_optin' LIMIT 1")).rows[0];
  assert.deepEqual(n,{title:'Help us launch GRIDGO on Play',body:'Help us launch GRIDGO on Play, become a tester.'});
  await device('other','client');
  checked(await api('other','GET','/me/play-optin?app=client&platform=android&channel=sideload'));
  for(let i=0;i<3;i++) checked(await api('other','POST','/me/play-optin/event',{app:'client',platform:'android',channel:'sideload',type:'dismissed'}));
  await device('client','client','android','play');
  checked(await api('ops','POST','/ops/testers/supplier/supplier/opt-in',{}));
  await run('2026-11-11T02:00:00Z');
  assert.deepEqual((await notices()).filter(n=>n.app!=='rider'),[{user_id:'client',app:'client'},{user_id:'supplier',app:'supplier'}]);
});

test('Manila hour and date boundaries, restart and concurrent replicas enqueue once per app/day', {skip:!DB}, async t=>{
  const {db,enable,device,run,notices}=await setup(t); await enable(); await device('client');
  await run('2026-11-10T01:59:59Z'); assert.equal((await notices()).length,0);
  await run('2026-11-10T02:00:00Z'); await run('2026-11-10T15:59:59Z');
  const restarted=createDatabase({DATABASE_URL:DB}); t.after(()=>restarted.close());
  await run('2026-11-10T14:00:00Z',restarted); assert.equal((await notices()).length,1);
  await enable('client',{dailyReminderHour:0});
  await Promise.all([run('2026-11-10T16:00:00Z'),run('2026-11-10T16:00:00Z',restarted)]);
  assert.equal((await notices()).length,2);
  assert.deepEqual((await db.query('SELECT manila_date FROM tester_program_play_reminder_runs ORDER BY manila_date')).rows,
    [{manila_date:'2026-11-10'},{manila_date:'2026-11-11'}]);
});

test('manual broadcasts and automatic reminders share the recipient daily limit in both directions', {skip:!DB}, async t=>{
  const {api,enable,device,run,notices}=await setup(t); await enable('client',{dailyReminderHour:0}); await device('client');
  const today=new Date().toISOString();
  checked(await api('ops','POST','/ops/testers/broadcast',{app:'client'}),201);
  await run(today);
  checked(await api('ops','POST','/ops/testers/broadcast',{app:'client'}),201);
  assert.equal((await notices()).length,1);
  await enable('supplier',{dailyReminderHour:0}); await device('supplier');
  await run(today);
  assert.equal(checked(await api('ops','POST','/ops/testers/broadcast',{app:'supplier'}),201).announcement.notifiedUsers,0);
  assert.equal((await notices()).length,2);
});

test('disabled, approved, unconfigured and target-complete campaigns do not schedule; toggles remain independent', {skip:!DB}, async t=>{
  const {db,api,enable,device,run,notices}=await setup(t);
  await device('client'); await run('2026-11-10T02:00:00Z'); assert.equal((await notices()).length,0);
  await enable('client',{dailyReminderEnabled:false}); await run('2026-11-10T02:00:00Z'); assert.equal((await notices()).length,0);
  await enable('client',{dailyReminderEnabled:true,optedInCount:12}); await run('2026-11-10T02:00:00Z'); assert.equal((await notices()).length,0);
  await enable('client',{optedInCount:0,target:1});
  checked(await api('ops','POST','/ops/testers/client/other/opt-in',{}));
  await run('2026-11-10T02:00:00Z'); assert.equal((await notices()).length,0);
  await enable('client',{target:12,groupJoinUrl:null}); await run('2026-11-10T02:00:00Z'); assert.equal((await notices()).length,0);
  await enable('client',{productionApprovedAt:'2026-11-01T00:00:00Z'}); await run('2026-11-10T02:00:00Z'); assert.equal((await notices()).length,0);
  assert.equal((await db.query('SELECT count(*) FROM tester_program_play_reminder_runs')).rows[0].count,0);
});

test('failed run rolls back its ledger, inbox and outbox before a restart retries', {skip:!DB}, async t=>{
  const {db,enable,device,run,notices,broadcast}=await setup(t); await enable(); await device('client');
  await assert.rejects(run('2026-11-10T02:00:00Z',db,async input=>{await broadcast(input); throw Error('interrupted');}),/interrupted/);
  assert.equal((await notices()).length,0);
  assert.equal((await db.query('SELECT count(*) FROM notification_push_outbox')).rows[0].count,0);
  assert.equal((await db.query('SELECT count(*) FROM tester_program_play_reminder_runs')).rows[0].count,0);
  await run('2026-11-10T02:00:00Z'); assert.equal((await notices()).length,1);
});

test('server startup scheduler commits the normal inbox/outbox and a restarted API does not repeat it', {skip:!DB}, async t=>{
  const {db,enable,device,notices}=await setup(t);
  await device('client'); await enable('client',{dailyReminderHour:0});
  await apiForTest(t);
  for(let n=0;n<200 && !(await notices()).length;n++) await new Promise(resolve=>setTimeout(resolve,25));
  assert.deepEqual(await notices(),[{user_id:'client',app:'client'}]);
  assert.equal((await db.query('SELECT count(*) FROM notification_push_outbox')).rows[0].count,1);
  assert.equal((await db.query("SELECT count(*) FROM audit_log WHERE action='announcement.broadcast' AND actor_role='system'")).rows[0].count,1);
  await apiForTest(t);
  assert.deepEqual(await notices(),[{user_id:'client',app:'client'}]);
});

test('migration backfills manual broadcasts by Manila date and enforces durable daily uniqueness', {skip:!DB}, async t=>{
  const db=createDatabase({DATABASE_URL:DB}); t.after(()=>db.close());
  const {up}=await import('../migrations/1794314000000_play_optin_daily_reminders.js');
  await db.transaction(async()=>{
    await db.query(`CREATE SCHEMA play_reminder_migration_test;
      SET LOCAL search_path TO play_reminder_migration_test;
      CREATE TABLE users(id text PRIMARY KEY);
      CREATE TABLE tester_program_settings(app text PRIMARY KEY);
      CREATE TABLE notifications(user_id text,type text,created_at timestamptz,data jsonb);
      INSERT INTO users VALUES('person'); INSERT INTO tester_program_settings VALUES('client');
      INSERT INTO notifications VALUES
        ('person','play_optin','2026-11-10T15:59:59Z','{"appRole":"client"}'),
        ('person','play_optin','2026-11-10T15:59:59Z','{"appRole":"client"}'),
        ('person','play_optin','2026-11-10T16:00:00Z','{"appRole":"client"}'),
        ('person','announcement','2026-11-11T01:00:00Z','{"appRole":"client"}');`);
    await up({sql:sql=>db.query(sql)});
    assert.deepEqual((await db.query('SELECT manila_date FROM tester_program_play_reminder_recipients ORDER BY manila_date')).rows,
      [{manila_date:'2026-11-10'},{manila_date:'2026-11-11'}]);
    assert.equal((await db.query(`INSERT INTO tester_program_play_reminder_recipients VALUES
      ('client','2026-11-11','person',now()) ON CONFLICT DO NOTHING RETURNING user_id`)).rowCount,0);
    assert.deepEqual((await db.query('SELECT daily_reminder_enabled,daily_reminder_hour FROM tester_program_settings')).rows,
      [{daily_reminder_enabled:true,daily_reminder_hour:10}]);
    await db.query('DROP SCHEMA play_reminder_migration_test CASCADE');
  });
});

test('outbox delivers to eligible Android after non-Android Play telemetry and suppresses a newly completed target', {skip:!DB}, async t=>{
  const {db,api,enable,device,run}=await setup(t); await enable(); await device('client');
  checked(await api('client','GET','/me/play-optin?app=client&platform=ios&channel=play'));
  await run('2026-11-10T02:00:00Z');
  const drain=createOutboxWorker({database:db,loadStore:()=>loadStore(db),delivery:{configured:true,
    send:async(message,devices)=>devices.map(d=>({deviceId:d.id,ok:true}))}});
  await drain();
  assert.deepEqual((await db.query('SELECT status FROM notification_push_outbox')).rows,[{status:'delivered'}]);
  await run('2026-11-11T02:00:00Z');
  await db.query("UPDATE tester_program_settings SET opted_in_count=12 WHERE app='client'");
  await drain();
  assert.deepEqual((await db.query('SELECT status FROM notification_push_outbox ORDER BY status')).rows,
    [{status:'delivered'},{status:'suppressed'}]);
});
