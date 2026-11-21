import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { emptyStore, saveStore } from '../src/postgres-store.js';
import { defaultOperationalSettings } from '../src/operational-model.js';
import { createEarlyAccessSignup, grantEarlyAccess, validateEarlyAccess } from '../src/early-access.js';
import { createEarlyAccessEmailWorker } from '../src/early-access-email.js';
import { createSupportMailer } from '../src/support-mail.js';
import { invalidateFrameVisible } from '../src/notifications.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { resetDatabase } from './fixtures/reset-database.js';

const DB = process.env.DATABASE_URL;
const input = { email: 'tester@gmail.com', consent: true, platform: 'android', source: 'booth' };
const checked = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.body)); return res.body; };

test('early access validates consent, account email, phone type and bounded source', () => {
  assert.deepEqual(validateEarlyAccess({ ...input, email: ' Test+Play@Example.Org ' }), {
    app: 'customer', shopName: null, email: 'test+play@example.org', platform: 'android', source: 'booth',
  });
  const { platform, ...legacyInput } = input;
  assert.equal(validateEarlyAccess(legacyInput).platform, 'android');
  assert.deepEqual(validateEarlyAccess({ ...input, email: ' Apple.ID@iCloud.com ', platform: 'iphone' }), {
    app: 'customer', shopName: null, email: 'apple.id@icloud.com', platform: 'iphone', source: 'booth',
  });
  for (const consent of [false, 'true', 1, undefined]) {
    assert.throws(() => validateEarlyAccess({ ...input, consent }), { status: 400, code: 'consent_required' });
  }
  for (const email of ['x', 'a..b@gmail.com', 'a\r\nb@gmail.com', 'a@-gmail.com', `${'x'.repeat(65)}@gmail.com`]) {
    assert.throws(() => validateEarlyAccess({ ...input, email }), { code: 'invalid_email' });
  }
  for (const source of ['a'.repeat(65), 'booth?<email>', {}, ['booth']]) {
    assert.throws(() => validateEarlyAccess({ ...input, source }), { code: 'invalid_source' });
  }
  for (const platform of ['ios', 'Android', '', null, false, 1, {}, ['iphone']]) {
    assert.throws(() => validateEarlyAccess({ ...input, platform }), { status: 400, code: 'invalid_platform' });
  }

  assert.equal(validateEarlyAccess({ ...input, app: 'shop', shopName: '  ' }).shopName, null);
  assert.equal(validateEarlyAccess({ ...input, app: 'shop', shopName: 'x'.repeat(80) }).shopName.length, 80);
  assert.equal(validateEarlyAccess({ ...input, app: 'shop', shopName: '🖨'.repeat(80) }).shopName, '🖨'.repeat(80));
  for (const app of ['supplier', '', null, 1, {}]) assert.throws(() => validateEarlyAccess({ ...input, app }), { code: 'invalid_app' });
  for (const shopName of ['x'.repeat(81), '🖨'.repeat(81), 1, {}, 'a\nb', 'a\u0085b']) {
    assert.throws(() => validateEarlyAccess({ ...input, app: 'shop', shopName }), { code: 'invalid_shop_name' });
  }
  for (const role of ['client', 'supplier', 'rider']) assert.equal(invalidateFrameVisible('early-access', role), false);
  for (const role of ['ops_admin', 'super_admin']) assert.equal(invalidateFrameVisible('early-access', role), true);
});

test('early access HTTP and PostgreSQL contract with durable notifications and mocked SMTP', { skip: !DB }, async t => {
  const database = createDatabase({ DATABASE_URL: DB });
  t.after(() => database.close());
  await resetDatabase(database, 'TRUNCATE early_access_team_mail_budget, early_access_signups, users, platform_settings, taxonomy_categories, accepted_file_formats CASCADE');
  const store = emptyStore();
  store.settings = defaultOperationalSettings();
  const at = new Date().toISOString();
  for (const [id, role] of [['ops', 'ops_admin'], ['admin', 'super_admin'], ['client', 'client']]) {
    store.users.push({ id, role, email: `${id}@example.invalid`, name: id, clerkUserId: `clerk_${id}`, createdAt: at,
      ...(role === 'client' ? { accountType: 'individual' } : {}) });
    store.userRoleMemberships.push({ userId: id, role, createdAt: at });
    if (role === 'client') store.clientProfiles.push({ userId: id, clientKind: 'personal', updatedAt: at });
  }
  await database.transaction(() => saveStore(database, store));
  let logs = '';
  const api = await apiForTest(t, { CORS_ALLOWED_ORIGINS: 'https://landing.example.test',
    SUPPORT_DESK_ALLOWED_EMAILS: 'desk@example.test', EMAIL_USER: '', EMAIL_PASSWORD: '',
    EARLY_ACCESS_TEAM_EMAIL: '', GRIDGO_SUPPORT_MAIL_CAPTURE: '' }, { onOutput: text => { logs += text; } });
  let ip = 1;
  const post = (body = input, key = null, path = '/early-access') => api(key, 'POST', path, body, {
    headers: { 'CF-Connecting-IP': `198.51.100.${ip++}` },
  });
  let signup, signupId;

  await t.test('public signup defaults to Android, normalized dedupe, CORS and durable ops/super inbox', async () => {
    const { platform, ...legacyInput } = input;
    const response = await api(null, 'POST', '/early-access', { ...legacyInput, email: ' TESTER@GMAIL.COM ' }, {
      headers: { Origin: 'https://landing.example.test', 'CF-Connecting-IP': '192.0.2.1' },
    });
    signup = checked(response);
    assert.match(signup.token, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(signup).sort(), ['app', 'createdAt', 'duplicate', 'grantedAt', 'platform', 'status', 'token']);
    assert.equal(signup.platform, 'android');
    assert.equal(signup.status, 'pending'); assert.equal(signup.duplicate, false); assert.equal(signup.grantedAt, null);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://landing.example.test');
    assert.match(response.headers.get('cache-control'), /no-store/);
    const duplicate = checked(await post({ ...input, platform: 'iphone', source: 'nu' }));
    assert.deepEqual(duplicate, { ...signup, duplicate: true });
    const rows = (await database.query('SELECT * FROM early_access_signups')).rows;
    assert.equal(rows.length, 1); signupId = rows[0].id;
    assert.equal(rows[0].platform, 'android');
    assert.equal(rows[0].email, input.email); assert.equal(rows[0].source, 'booth'); assert.equal(rows[0].consent_at, signup.createdAt);
    assert.equal((await database.query('SELECT count(*)::int AS n FROM early_access_email_outbox')).rows[0].n, 1);
    const inbox = (await database.query("SELECT user_id,data FROM notifications WHERE type='ops_early_access_signup' ORDER BY user_id")).rows;
    assert.deepEqual(inbox.map(row => row.user_id), ['admin', 'ops']);
    assert.equal(JSON.stringify(inbox).includes(input.email), false);
    const audits = (await database.query("SELECT * FROM audit_log WHERE action='early_access.signed_up'")).rows;
    assert.equal(audits.length, 1); assert.equal(audits[0].entity_id, signupId);
    assert.equal(JSON.stringify(audits).includes(input.email), false);
    const denied = await api(null, 'POST', '/early-access', input, { headers: { Origin: 'https://evil.example.test' } });
    checked(denied, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null);
    checked(await api(null, 'OPTIONS', '/early-access', null, { raw: true, headers: { Origin: 'https://landing.example.test' } }), 204);
  });

  await t.test('consent refusal, validation and body limits create nothing', async () => {
    assert.deepEqual(checked(await post({ ...input, consent: false }), 400), { error: 'consent_required' });
    assert.equal(checked(await post({ ...input, email: 'bad' }), 400).error, 'invalid_email');
    for (const platform of ['ios', 'Android', '', null, false, 1, {}, ['iphone']]) {
      assert.deepEqual(checked(await post({ ...input, platform }), 400), { error: 'invalid_platform' });
    }
    assert.equal(checked(await post({ ...input, source: 'bad source' }), 400).error, 'invalid_source');
    checked(await post({ ...input, email: 'x'.repeat(5000) }), 413);
    assert.equal((await database.query('SELECT count(*)::int AS n FROM early_access_signups')).rows[0].n, 1);
  });

  await t.test('status token read never exposes email, IDs, or link before grant', async () => {
    const status = checked(await api(null, 'GET', `/early-access/status?token=${signup.token}`));
    assert.deepEqual(status, { app: 'customer', platform: 'android', status: 'pending', grantedAt: null, optInUrl: null });
    checked(await api(null, 'GET', `/early-access/status?token=${'f'.repeat(64)}`), 404);
    checked(await api(null, 'GET', '/early-access/status?token=invalid'), 404);
  });

  await t.test('ops/super and verified desk authorization, literal search and paging', async () => {
    checked(await api(null, 'GET', '/ops/early-access'), 401);
    checked(await api('client', 'GET', '/ops/early-access'), 403);
    checked(await api(null, 'GET', '/early-access/desk'), 401);
    checked(await api('client', 'GET', '/early-access/desk', null, { claims: { email: 'outsider@example.test' } }), 403);
    const list = checked(await api('ops', 'GET', '/ops/early-access?q=TESTER&status=pending&limit=1&offset=0'));
    assert.deepEqual(list.counts, { pending: 1, granted: 0 }); assert.equal(list.total, 1);
    assert.equal(list.signups[0].id, signupId); assert.equal(list.signups[0].email, input.email);
    assert.equal(list.signups[0].platform, 'android');
    assert.equal('token' in list.signups[0], false);
    assert.equal(checked(await api('admin', 'GET', '/ops/early-access?q=%25')).total, 0);
    for (const query of ['status=unknown', 'limit=0', 'limit=101', 'offset=-1']) checked(await api('ops', 'GET', `/ops/early-access?${query}`), 400);
    const desk = checked(await api('desk', 'GET', '/api/early-access/desk', null, { claims: { email: 'desk@example.test' } }));
    assert.deepEqual(desk, checked(await api('admin', 'GET', '/ops/early-access')));
    assert.equal(checked(await api('ops', 'GET', '/ops/early-access?offset=1')).signups.length, 0);
  });

  await t.test('grant is idempotent across ops/super, snapshots client URL and queues one invite', async () => {
    checked(await api('client', 'POST', `/ops/early-access/${signupId}/grant`, {}), 403);
    checked(await api(null, 'POST', `/early-access/desk/${signupId}/grant`, {}), 401);
    checked(await api('ops', 'POST', '/ops/early-access/not-uuid/grant', {}), 404);
    checked(await api('ops', 'POST', '/ops/early-access/00000000-0000-0000-0000-000000000001/grant', {}), 404);
    const link = 'https://play.google.com/apps/testing/ph.gridgo.client';
    await database.transaction(() => database.query("INSERT INTO tester_program_settings(app,opt_in_url) VALUES('client',$1) ON CONFLICT(app) DO UPDATE SET opt_in_url=$1", [link]));
    const results = await Promise.all(['ops', 'admin'].map(role => api(role, 'POST', `/ops/early-access/${signupId}/grant`, {})));
    const grant = checked(results[0]); assert.deepEqual(checked(results[1]), grant);
    assert.equal(grant.status, 'granted'); assert.ok(grant.grantedAt); assert.ok(['ops', 'admin'].includes(grant.grantedBy));
    await database.transaction(() => database.query("UPDATE tester_program_settings SET opt_in_url='https://play.google.com/apps/testing/ph.gridgo.next' WHERE app='client'"));
    assert.deepEqual(checked(await api(null, 'GET', `/early-access/status?token=${signup.token}`)), {
      app: 'customer', platform: 'android', status: 'granted', grantedAt: grant.grantedAt, optInUrl: link,
    });
    const duplicate = checked(await post());
    assert.equal(duplicate.status, 'granted'); assert.equal(duplicate.token, signup.token); assert.equal(duplicate.duplicate, true);
    assert.equal((await database.query("SELECT count(*)::int AS n FROM early_access_email_outbox WHERE kind='access'")).rows[0].n, 1);
    assert.equal((await database.query("SELECT count(*)::int AS n FROM audit_log WHERE action='early_access.granted'")).rows[0].n, 1);
    const notices = (await database.query("SELECT user_id,data FROM notifications WHERE type='ops_early_access_granted' ORDER BY user_id")).rows;
    assert.deepEqual(notices.map(row => row.user_id), ['admin', 'ops']);
    assert.equal(JSON.stringify(notices).includes(input.email), false);
  });

  await t.test('desk grant records verified Clerk subject, needs no mapped GRIDGO account', async () => {
    checked(await post({ ...input, email: 'desk-grant@example.test' }));
    const id = (await database.query('SELECT id FROM early_access_signups WHERE email=$1', ['desk-grant@example.test'])).rows[0].id;
    const grant = checked(await api('desk', 'POST', `/api/early-access/desk/${id}/grant`, {}, { claims: { email: 'desk@example.test' } }));
    assert.equal(grant.grantedBy, 'clerk_desk');
    const audit = (await database.query("SELECT actor_id,actor_role FROM audit_log WHERE action='early_access.granted' AND entity_id=$1", [id])).rows[0];
    assert.deepEqual(audit, { actor_id: 'clerk_desk', actor_role: 'support_desk' });
  });

  await t.test('iPhone signup and duplicate preserve phone type; desk grant records TestFlight addition without Play mail', async () => {
    const iphone = checked(await post({ ...input, email: ' Apple.ID@iCloud.com ', platform: 'iphone', source: 'booth-iphone' }, null, '/api/early-access'));
    assert.equal(iphone.platform, 'iphone'); assert.equal(iphone.status, 'pending');
    assert.deepEqual(checked(await api(null, 'GET', `/api/early-access/status?token=${iphone.token}`)), {
      app: 'customer', platform: 'iphone', status: 'pending', grantedAt: null, optInUrl: null,
    });
    assert.deepEqual(checked(await post({ email: 'apple.id@icloud.com', consent: true, source: 'different' })), {
      ...iphone, duplicate: true,
    });
    const before = checked(await api('ops', 'GET', '/ops/early-access?q=apple.id'));
    const row = before.signups[0];
    assert.equal(before.total, 1);
    assert.deepEqual(row, { id: row.id, app: 'customer', shopName: null, email: 'apple.id@icloud.com', platform: 'iphone', source: 'booth-iphone',
      status: 'pending', createdAt: iphone.createdAt, grantedAt: null, grantedBy: null });
    const grant = checked(await api('desk', 'POST', `/api/early-access/desk/${row.id}/grant`, {}, { claims: { email: 'desk@example.test' } }));
    assert.equal(grant.platform, 'iphone'); assert.equal(grant.status, 'granted');
    assert.ok(grant.grantedAt); assert.equal(grant.grantedBy, 'clerk_desk');
    assert.deepEqual(checked(await api('ops', 'POST', `/ops/early-access/${row.id}/grant`, {})), grant);
    assert.deepEqual(checked(await api(null, 'GET', `/early-access/status?token=${iphone.token}`)), {
      app: 'customer', platform: 'iphone', status: 'granted', grantedAt: grant.grantedAt, optInUrl: null,
    });
    const duplicate = checked(await post({ ...input, email: row.email }));
    assert.equal(duplicate.platform, 'iphone'); assert.equal(duplicate.status, 'granted');
    assert.equal(duplicate.grantedAt, grant.grantedAt); assert.equal(duplicate.token, iphone.token);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(checked(await api('desk', 'GET', '/early-access/desk?q=apple.id&status=granted', null,
      { claims: { email: 'desk@example.test' } })).signups, [grant]);
    assert.equal((await database.query('SELECT opt_in_url FROM early_access_signups WHERE id=$1', [row.id])).rows[0].opt_in_url, null);
    assert.deepEqual((await database.query('SELECT kind FROM early_access_email_outbox WHERE signup_id=$1', [row.id])).rows, [{ kind: 'team' }]);
    assert.equal((await database.query("SELECT count(*)::int AS n FROM audit_log WHERE action='early_access.granted' AND entity_id=$1", [row.id])).rows[0].n, 1);
    const notices = (await database.query("SELECT user_id,data FROM notifications WHERE type='ops_early_access_granted' AND data->>'occurrenceKey'=$1 ORDER BY user_id", [row.id])).rows;
    assert.deepEqual(notices.map(notice => notice.user_id), ['admin', 'ops']);
    assert.equal(JSON.stringify(notices).includes(row.email), false);
    await assert.rejects(database.transaction(() => database.query('UPDATE early_access_signups SET opt_in_url=$2 WHERE id=$1',
      [row.id, 'https://play.google.com/apps/testing/ph.gridgo.client'])), { code: '23514' });
    await assert.rejects(database.transaction(() => database.query('UPDATE early_access_signups SET opt_in_url=NULL WHERE id=$1',
      [signupId])), { code: '23514' });
  });

  await t.test('IP rate limit includes invalid submissions and status has its own bucket', async () => {
    const opts = { headers: { 'CF-Connecting-IP': '203.0.113.93' } };
    for (let n = 0; n < 10; n++) checked(await api(null, 'POST', '/early-access', { ...input, consent: false }, opts), 400);
    assert.deepEqual(checked(await api(null, 'POST', '/early-access', input, opts), 429), { error: 'rate_limited' });
    for (let n = 0; n < 120; n++) checked(await api(null, 'GET', '/early-access/status?token=bad', null, opts), 404);
    checked(await api(null, 'GET', `/early-access/status?token=${signup.token}`, null, opts), 429);
  });

  await t.test('failed atomic notification rolls back sign-up, audit and mail; concurrent dedupe', async () => {
    const before = (await database.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
    await assert.rejects(createEarlyAccessSignup(database, { ...input, email: 'rollback@example.test' }, {
      notifyStaff: async () => { throw new Error('save failed'); },
      kickMail: () => assert.fail('rolled-back mail must not run'),
    }), /save failed/);
    assert.equal((await database.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n, before);
    assert.equal((await database.query("SELECT count(*)::int AS n FROM early_access_signups WHERE email='rollback@example.test'")).rows[0].n, 0);
    let notifications = 0, kicks = 0;
    const results = await Promise.all(Array.from({ length: 4 }, () => createEarlyAccessSignup(database,
      { ...input, email: 'race@example.test' }, { notifyStaff: async () => { notifications++; }, kickMail: () => { kicks++; } })));
    assert.equal(new Set(results.map(row => row.token)).size, 1);
    assert.equal(results.filter(row => !row.duplicate).length, 1); assert.equal(notifications, 1); assert.equal(kicks, 1);
  });

  await t.test('SMTP failure cannot undo sign-up or grant; durable retries send team and invite', async () => {
    const sent = [];
    let down = true;
    const mailer = createSupportMailer({ EMAIL_USER: 'sender@example.test', EMAIL_PASSWORD: 'mock-password' }, {
      createTransport: () => ({ async sendMail(mail) {
        assert.equal(database.inWriteTransaction(), false);
        if (down) throw new Error('private SMTP details tester@gmail.com');
        sent.push(mail); return { accepted: [mail.to], rejected: [] };
      } }),
    });
    const drain = createEarlyAccessEmailWorker({ database, mailer, env: { EARLY_ACCESS_TEAM_EMAIL: 'team@example.test' } });
    await drain();
    const failed = (await database.query('SELECT * FROM early_access_email_outbox')).rows;
    assert.ok(failed.every(row => row.status === 'pending' && row.attempts === 1));
    assert.equal((await database.query('SELECT status FROM early_access_signups WHERE id=$1', [signupId])).rows[0].status, 'granted');
    await database.transaction(() => database.query("UPDATE early_access_email_outbox SET next_at=now()-interval '1 minute'"));
    down = false;
    const secondInstance = createEarlyAccessEmailWorker({ database, mailer, env: { EARLY_ACCESS_TEAM_EMAIL: 'team@example.test' } });
    await Promise.all([drain(), drain(), secondInstance()]);
    assert.equal(sent.filter(mail => mail.subject === `New Android tester: ${input.email}`).length, 1);
    const iphoneAlert = sent.filter(mail => mail.subject === 'New iPhone tester: apple.id@icloud.com');
    assert.equal(iphoneAlert.length, 1);
    assert.match(iphoneAlert[0].text, /App Store Connect under TestFlight external testers/);
    assert.equal(iphoneAlert[0].to, 'team@example.test');
    assert.equal(sent.some(mail => mail.to === 'apple.id@icloud.com'), false);
    const invite = sent.find(mail => mail.to === input.email);
    assert.equal(invite.subject, "You're in — GRIDGO Google Play Early Access");
    assert.equal(invite.text, `You're in!\n\nYour Google Play invite is ready. Open this link with the Google account you signed up with:\nhttps://play.google.com/apps/testing/ph.gridgo.client\n\nKeep the app for 14 days. Thank you for helping GRIDGO launch!`);
    assert.match(invite.messageId, /@gridgo.early-access>/);
    assert.ok((await database.query('SELECT status FROM early_access_email_outbox')).rows.every(row => row.status === 'sent'));
    await drain(); assert.equal(sent.length, failed.length);
    assert.equal(logs.includes(input.email), false); assert.equal(logs.includes(signup.token), false);
  });

  await t.test('missing team recipient preserves alerts while grants still deliver; rejected mail exhausts retries', async () => {
    await createEarlyAccessSignup(database, { ...input, email: 'recipient-config@example.test' });
    const row = (await database.query("SELECT id FROM early_access_signups WHERE email='recipient-config@example.test'")).rows[0];
    await grantEarlyAccess(database, row.id, { id: 'ops', role: 'ops_admin' });
    const sent = [];
    const mailer = { configured: true, async sendEarlyAccessEmail(mail) { sent.push(mail); return { sent: true }; } };
    await createEarlyAccessEmailWorker({ database, mailer, env: {} })();
    assert.deepEqual(sent.map(mail => mail.to), ['recipient-config@example.test']);
    const pending = (await database.query("SELECT status,attempts FROM early_access_email_outbox WHERE signup_id=$1 AND kind='team'", [row.id])).rows[0];
    assert.deepEqual(pending, { status: 'pending', attempts: 0 });
    await database.transaction(() => database.query("UPDATE early_access_email_outbox SET attempts=7 WHERE signup_id=$1 AND kind='team'", [row.id]));
    const rejected = createSupportMailer({ EMAIL_USER: 'sender@example.test', EMAIL_PASSWORD: 'mock-password' }, {
      createTransport: () => ({ async sendMail() { return { accepted: [], rejected: ['team@example.test'] }; } }),
    });
    await createEarlyAccessEmailWorker({ database, mailer: rejected, env: { EARLY_ACCESS_TEAM_EMAIL: 'team@example.test' } })();
    assert.deepEqual((await database.query("SELECT status,attempts FROM early_access_email_outbox WHERE signup_id=$1 AND kind='team'", [row.id])).rows[0],
      { status: 'failed', attempts: 8 });
  });

  await t.test('access invitations are claimed before older team alerts', async () => {
    await createEarlyAccessSignup(database, { ...input, email: 'priority@example.test' });
    const row = (await database.query("SELECT id FROM early_access_signups WHERE email='priority@example.test'")).rows[0];
    await grantEarlyAccess(database, row.id, { id: 'ops', role: 'ops_admin' });
    const delivered = [];
    const mailer = { configured: true, async sendEarlyAccessEmail(mail) { delivered.push(mail); return { sent: true }; } };
    await createEarlyAccessEmailWorker({ database, mailer, env: { EARLY_ACCESS_TEAM_EMAIL: 'team@example.test' } })();
    assert.equal(delivered[0].to, 'priority@example.test');
    assert.equal(delivered[1].to, 'team@example.test');
  });

  await t.test('many source IPs and two instances share a durable team budget without blocking invitations', async () => {
    // Each IP remains within its route limit; the aggregate budget must still hold.
    for (let n = 0; n < 101; n++) checked(await api(null, 'POST', '/early-access', {
      ...input, email: `budget-${n}@example.test`, platform: n % 2 ? 'iphone' : 'android',
    }, { headers: { 'CF-Connecting-IP': `198.18.0.${1 + Math.floor(n / 10)}` } }));
    const delivered = [];
    const mailer = { configured: true, async sendEarlyAccessEmail(mail) { delivered.push(mail); return { sent: true }; } };
    const secondDatabase = createDatabase({ DATABASE_URL: DB });
    t.after(() => secondDatabase.close());
    const worker = db => createEarlyAccessEmailWorker({ database: db, mailer, env: { EARLY_ACCESS_TEAM_EMAIL: 'team@example.test' } });
    const first = worker(database), second = worker(secondDatabase);
    // Earlier tests may have consumed part of today's allowance.
    for (let round = 0; round < 3; round++) await Promise.all([first(), second()]);
    assert.ok(delivered.length <= 100, `team budget exceeded: ${delivered.length} deliveries`);
    assert.equal((await database.query("SELECT attempts FROM early_access_team_mail_budget WHERE budget_day=(now() AT TIME ZONE 'UTC')::date")).rows[0].attempts, 100);
    const pending = (await database.query("SELECT count(*)::int AS n FROM early_access_email_outbox WHERE kind='team' AND status='pending'")).rows[0].n;
    assert.ok(pending > 0, 'excess team intents must remain pending');
    assert.equal((await database.query("SELECT count(*)::int AS n FROM early_access_email_outbox WHERE kind='team' AND status='pending' AND attempts<>0")).rows[0].n, 0);
    assert.equal((await database.query("SELECT count(*)::int AS n FROM early_access_email_outbox WHERE kind='team'")).rows[0].n,
      (await database.query('SELECT count(*)::int AS n FROM early_access_signups')).rows[0].n);
    // A new instance/restart cannot reset the shared budget.
    const sentBeforeRestart = delivered.length;
    await worker(secondDatabase)();
    assert.equal(delivered.length, sentBeforeRestart);
    const row = (await database.query("SELECT id FROM early_access_signups WHERE email='budget-100@example.test'")).rows[0];
    await grantEarlyAccess(database, row.id, { id: 'ops', role: 'ops_admin' });
    await worker(secondDatabase)();
    assert.equal(delivered.at(-1).to, 'budget-100@example.test');
    assert.equal(delivered.length, sentBeforeRestart + 1);
    // Budget returns the next UTC day, preserving the deferred intent identities.
    await database.transaction(() => database.query('UPDATE early_access_team_mail_budget SET budget_day=budget_day-1'));
    await worker(database)();
    assert.equal((await database.query("SELECT count(*)::int AS n FROM early_access_email_outbox WHERE kind='team' AND status='pending'")).rows[0].n, 0);
  });

  await t.test('same email can join both apps; shop duplicates preserve first consent and shop name', async () => {
    const shop = checked(await post({ ...input, app: 'shop', shopName: '  Example printing  ' }));
    assert.equal(shop.app, 'shop'); assert.equal(shop.duplicate, false);
    assert.notEqual(shop.token, signup.token);
    assert.deepEqual(checked(await post({ ...input, app: 'shop', shopName: 'changed' })), { ...shop, duplicate: true });
    const rows = (await database.query('SELECT * FROM early_access_signups WHERE email=$1 ORDER BY app', [input.email])).rows;
    assert.deepEqual(rows.map(row => row.app), ['customer', 'shop']);
    assert.equal(rows[1].shop_name, 'Example printing');
    await assert.rejects(database.transaction(() => database.query(`INSERT INTO early_access_signups
      (id,email,app,token,consent_at,created_at) VALUES(gen_random_uuid(),$1,'shop',repeat('b',64),now(),now())`, [input.email])), { code: '23505' });
    const notices = (await database.query("SELECT data->>'title' AS title FROM notifications WHERE type='ops_early_access_signup' AND data->>'occurrenceKey'=$1", [rows[1].id])).rows;
    assert.ok(notices.length > 0); assert.ok(notices.every(row => /shop tester/i.test(row.title)));
    for (const body of [{ ...input, app: 'invalid' }, { ...input, app: 'shop', shopName: 'x'.repeat(81) }, { ...input, app: 'shop', shopName: 'a\u0085b' }]) checked(await post(body), 400);
  });

  await t.test('desk filters app, separates Android grants from notify-only iPhone shops and never grants those requests', async () => {
    const iphone = checked(await post({ ...input, email: 'notify@example.test', app: 'shop', platform: 'iphone', shopName: 'Example' }));
    const all = checked(await api('ops', 'GET', '/ops/early-access'));
    const shops = checked(await api('desk', 'GET', '/api/early-access/desk?app=shop', null, { claims: { email: 'desk@example.test' } }));
    assert.equal(shops.total, 2); assert.ok(shops.signups.every(row => row.app === 'shop'));
    assert.deepEqual(shops.counts, { pending: 2, granted: 0 });
    assert.deepEqual(all.countsByApp.shop, { pending: 2, granted: 0, androidGranted: 0, notifyOnly: 1 });
    assert.deepEqual(shops.countsByApp, all.countsByApp);
    const customers = checked(await api('ops', 'GET', '/ops/early-access?app=customer'));
    assert.ok(customers.signups.every(row => row.app === 'customer' && row.shopName === null));
    checked(await api('ops', 'GET', '/ops/early-access?app=supplier'), 400);
    assert.equal(checked(await api('ops', 'GET', '/ops/early-access?app=shop&q=TESTER&limit=1')).total, 1);
    const row = shops.signups.find(row => row.platform === 'iphone');
    assert.deepEqual(checked(await api('ops', 'POST', `/ops/early-access/${row.id}/grant`, {}), 409), { error: 'shop_android_only' });
    assert.deepEqual(checked(await api(null, 'GET', `/early-access/status?token=${iphone.token}`)), {
      app: 'shop', platform: 'iphone', status: 'pending', grantedAt: null, optInUrl: null,
    });
    await assert.rejects(database.transaction(() => database.query(`UPDATE early_access_signups
      SET status='granted',granted_at=now(),granted_by='ops' WHERE id=$1`, [row.id])), { code: '23514' });
    assert.equal((await database.query("SELECT count(*)::int AS n FROM early_access_email_outbox WHERE signup_id=$1 AND kind='access'", [row.id])).rows[0].n, 0);
  });

  await t.test('shop grant uses supplier settings and Group, rolls back provider failure and retries idempotently', async () => {
    const row = (await database.query("SELECT * FROM early_access_signups WHERE app='shop' AND platform='android'")).rows[0];
    const actor = { id: 'ops', role: 'ops_admin' };
    const link = 'https://play.google.com/apps/testing/ph.gridgo.supplier';
    await database.transaction(() => database.query("INSERT INTO tester_program_settings(app,opt_in_url) VALUES('supplier',$1) ON CONFLICT(app) DO UPDATE SET opt_in_url=$1", [link]));
    let calls = 0;
    const groups = { configured: app => app === 'supplier', async addMember(app, email) {
      assert.equal(app, 'supplier'); assert.equal(email, input.email);
      calls++; if (calls === 1) throw new Error('provider private details');
    } };
    await assert.rejects(grantEarlyAccess(database, row.id, actor, { groups }), { status: 503, code: 'google_group_unavailable' });
    assert.equal((await database.query('SELECT status FROM early_access_signups WHERE id=$1', [row.id])).rows[0].status, 'pending');
    assert.equal((await database.query("SELECT count(*)::int AS n FROM early_access_email_outbox WHERE signup_id=$1 AND kind='access'", [row.id])).rows[0].n, 0);
    const grant = await grantEarlyAccess(database, row.id, actor, { groups });
    assert.equal(grant.app, 'shop'); assert.equal(grant.status, 'granted');
    assert.deepEqual(await grantEarlyAccess(database, row.id, actor, { groups }), grant);
    assert.equal(calls, 2);
    await database.transaction(() => database.query("UPDATE tester_program_settings SET opt_in_url='https://play.google.com/apps/testing/ph.gridgo.changed' WHERE app='supplier'"));
    assert.equal(checked(await api(null, 'GET', `/early-access/status?token=${row.token}`)).optInUrl, link);
    const list = checked(await api('ops', 'GET', '/ops/early-access?app=shop&status=granted'));
    assert.equal(list.total, 1); assert.deepEqual(list.countsByApp.shop, { pending: 1, granted: 1, androidGranted: 1, notifyOnly: 1 });
    const sent = [];
    const mailer = { configured: true, async sendEarlyAccessEmail(mail) { sent.push(mail); return { sent: true }; } };
    await database.transaction(() => database.query('DELETE FROM early_access_team_mail_budget'));
    await createEarlyAccessEmailWorker({ database, mailer, env: { EARLY_ACCESS_TEAM_EMAIL: 'team@example.test' } })();
    const invite = sent.find(mail => mail.to === input.email);
    assert.match(invite.subject, /shop/i); assert.ok(invite.text.includes(link));
    assert.match(invite.text, /14 days/); assert.match(invite.text, /test jobs/i);
    const shopAlert = sent.find(mail => /shop tester/i.test(mail.subject));
    assert.ok(shopAlert); assert.match(shopAlert.text, /shop/i);
    const notify = sent.find(mail => mail.subject.includes('notify@example.test'));
    assert.ok(notify); assert.match(notify.text, /notify/i); assert.doesNotMatch(notify.text, /App Store Connect|TestFlight external testers/);
    assert.equal(sent.some(mail => mail.to === 'notify@example.test'), false);
    const unconfigured = checked(await post({ ...input, email: 'manual-shop@example.test', app: 'shop' }));
    const manualRow = (await database.query('SELECT id FROM early_access_signups WHERE token=$1', [unconfigured.token])).rows[0];
    assert.equal(checked(await api('ops', 'POST', `/ops/early-access/${manualRow.id}/grant`, {})).status, 'granted');
    await createEarlyAccessEmailWorker({ database, mailer, env: { EARLY_ACCESS_TEAM_EMAIL: 'team@example.test' } })();
    assert.match(sent.find(mail => mail.to === 'manual-shop@example.test').subject, /shop/i);
    assert.equal((await database.query("SELECT count(*)::int AS n FROM early_access_email_outbox WHERE status='pending'")).rows[0].n, 0);
  });
});

test('unconfigured mail leaves queued work untouched', async () => {
  const work = createEarlyAccessEmailWorker({ database: { query() { assert.fail('unexpected query'); } }, mailer: { configured: false }, env: {} });
  await work();
});
