import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { emptyStore, loadStore, saveStore } from '../src/postgres-store.js';
import { defaultOperationalSettings } from '../src/operational-model.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { routeHomePromotions, recordPromotionEvent } from '../src/home-promotions.js';
import { seedDevelopmentPromotion } from '../src/seed-home-promotions.js';

const DB = process.env.DATABASE_URL;
const at = new Date().toISOString();
const values = { name: 'DavaoGo', logo: { fileId: 'promo_logo' }, description: 'Our partner app in Davao. Tap to visit.',
  tag: 'partner', linkText: 'Visit DavaoGo', linkUrl: 'https://davaogo.app/', style: 'yellow',
  startsAt: '2026-01-01T00:00:00Z', enabled: true, displayOrder: 1 };

async function setup(t) {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings RESTART IDENTITY CASCADE');
  const store = emptyStore(); store.settings = defaultOperationalSettings();
  for (const [id, role] of [['client', 'client'], ['ops', 'ops_admin'], ['admin', 'super_admin'], ['supplier', 'supplier'], ['rider', 'rider']]) {
    store.users.push({ id, role, clerkUserId: `clerk_${id}`, email: `${id}@test.invalid`, name: id, createdAt: at,
      ...(role === 'client' ? { accountType: 'individual' } : {}),
      ...(['supplier', 'rider'].includes(role) ? { verificationStatus: 'pending' } : {}) });
    store.userRoleMemberships.push({ userId: id, role, createdAt: at });
  }
  for (const [fileId, purpose, ownerId] of [['promo_logo', 'promotion_logo', 'ops'], ['promo_image', 'promotion_image', 'ops'],
    ['admin_logo', 'promotion_logo', 'admin'], ['wrong', 'artwork', 'client']]) store.files.push({
    fileId, purpose, ownerId, state: 'ready', objectKey: `private/${fileId}`, size: 100, originalFilename: `${fileId}.png`,
    declaredContentType: 'image/png', detectedContentType: 'image/png', createdAt: at, readyAt: at, references: [],
  });
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t) };
}

test('HTTP promotions persist staff CRUD, enforce roles and private media, expose only live feed, keep removed stats', { skip: !DB }, async t => {
  const { db, api } = await setup(t);
  for (const role of [null, 'client', 'supplier', 'rider']) {
    const status = role ? 403 : 401;
    assert.equal((await api(role, 'GET', '/ops/promotions')).status, status);
    assert.equal((await api(role, 'POST', '/ops/promotions', values)).status, status);
  }
  for (const role of ['supplier', 'rider', 'ops', 'admin', null]) {
    assert.equal((await api(role, 'GET', '/me/promotions/home')).status, role ? 403 : 401);
  }
  let response = await api('ops', 'POST', '/ops/promotions', values);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const promo = response.body.promotion, path = `/ops/promotions/${promo.id}`;
  assert.equal(promo.status, 'live'); assert.equal(promo.tapAction, 'sheet'); assert.equal(promo.views, 0);
  assert.ok(promo.logo.downloadUrl.includes('X-Amz-Signature'));
  assert.equal(promo.logo.objectKey, undefined);
  assert.equal((await api('admin', 'GET', path)).body.promotion.id, promo.id);
  assert.equal((await api('ops', 'GET', '/ops/promotions')).body.promotions.length, 1);
  assert.equal((await api('client', 'GET', '/me/promotions/home')).body.promotions[0].views, undefined);
  assert.equal((await api('client', 'GET', '/files/promo_logo')).status, 200);
  assert.equal((await api('supplier', 'GET', '/files/promo_logo')).status, 403);
  assert.equal((await api('rider', 'GET', '/files/promo_logo')).status, 403);
  for (const patch of [{ linkUrl: 'http://bad.test' }, { tag: 'bad' }, { style: 'bad' }, { tapAction: 'bad' },
    { endsAt: '2025-01-01T00:00:00Z' }, { description: 'x'.repeat(141) }, { enabled: 1 }]) {
    assert.equal((await api('ops', 'PATCH', path, patch)).status, 400);
  }
  assert.equal((await api('ops', 'PATCH', path, { logo: { fileId: 'wrong' } })).status, 409);
  assert.equal((await api('ops', 'PATCH', path, { logo: { fileId: 'admin_logo' } })).status, 403);
  assert.equal((await api('admin', 'PATCH', path, { image: { fileId: 'promo_image' }, tapAction: 'link', style: 'light' })).status, 403);
  response = await api('ops', 'PATCH', path, { image: { fileId: 'promo_image' }, tapAction: 'link', style: 'light' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.body.promotion.image.downloadUrl);
  // Another staff member can edit already bound media without re-uploading.
  assert.equal((await api('admin', 'PATCH', path, { name: 'Partner' })).status, 200);
  const eventPath = `/me/promotions/${promo.id}/events`;
  for (const role of ['ops', 'admin', 'supplier', 'rider', null]) assert.equal((await api(role, 'POST', eventPath,
    { type: 'view', sessionId: 'session' })).status, role ? 403 : 401);
  for (const role of ['client', 'supplier', 'rider']) for (const [method, route] of [['GET', path], ['GET', `${path}/stats`], ['PATCH', path], ['DELETE', path]]) {
    assert.equal((await api(role, method, route, method === 'PATCH' ? { name: 'Denied' } : undefined)).status, 403);
  }
  for (const body of [{ type: 'bad', sessionId: 's' }, { type: 'view' }, { type: 'view', sessionId: 'x'.repeat(129) }]) {
    assert.equal((await api('client', 'POST', eventPath, body)).status, 400);
  }
  const views = await Promise.all(Array.from({ length: 6 }, () => api('client', 'POST', eventPath, { type: 'view', sessionId: 'same-session' }, { raw: true })));
  assert.ok(views.every(r => r.status === 204 && r.body === ''));
  for (const type of ['open', 'tap', 'tap']) assert.equal((await api('client', 'POST', eventPath, { type, sessionId: 'same-session' }, { raw: true })).status, 204);
  response = await api('ops', 'GET', path);
  assert.deepEqual([response.body.promotion.views, response.body.promotion.opens, response.body.promotion.taps], [1, 1, 2]);
  for (const query of ['to=nope', 'from=2026-02-30', 'from=2026-11-11&to=2026-11-10', 'from=2020-01-01&to=2026-01-01']) {
    assert.equal((await api('ops', 'GET', `${path}/stats?${query}`)).status, 400);
  }
  const liveFeed = (await api('client', 'GET', '/me/promotions/home')).body;
  assert.equal(liveFeed.promotions[0].name, 'Partner');
  await api('ops', 'PATCH', path, { startsAt: '2099-01-01T00:00:00Z' });
  assert.equal((await api('ops', 'GET', path)).body.promotion.status, 'scheduled');
  assert.deepEqual((await api('client', 'GET', '/me/promotions/home')).body.promotions, []);
  assert.equal((await api('client', 'POST', eventPath, { type: 'view', sessionId: 's' })).status, 404);
  await api('ops', 'PATCH', path, { startsAt: values.startsAt, endsAt: '2026-01-02T00:00:00Z' });
  assert.equal((await api('ops', 'GET', path)).body.promotion.status, 'ended');
  await api('ops', 'PATCH', path, { endsAt: null, enabled: false });
  assert.equal((await api('ops', 'GET', path)).body.promotion.status, 'off');
  assert.deepEqual((await api('client', 'GET', '/me/promotions/home')).body.promotions, []);
  assert.equal((await api('admin', 'DELETE', path, undefined, { raw: true })).status, 204);
  assert.equal((await api('ops', 'GET', path)).status, 404);
  assert.deepEqual((await api('ops', 'GET', '/ops/promotions')).body.promotions, []);
  assert.equal((await db.query('SELECT removed_at FROM home_promotions WHERE id=$1', [promo.id])).rows[0].removed_at != null, true);
  assert.equal((await db.query('SELECT views FROM home_promotion_daily_stats WHERE promotion_id=$1', [promo.id])).rows[0].views, 1);
  const persisted = await loadStore(db);
  assert.equal(persisted.files.find(f => f.fileId === 'promo_logo').references.length, 0);
  assert.ok(persisted.auditLog.some(a => a.action === 'home_promotion.removed'));
  for (const userId of ['ops', 'admin']) assert.ok(persisted.notifications.some(n => n.userId === userId && n.type === 'home_promotion_updated'));
});

test('Manila days, concurrent deduplication and rollback are durable; development seed is guarded and idempotent', { skip: !DB }, async t => {
  const { db, api } = await setup(t);
  const storage = { putObject: async () => {} };
  await assert.rejects(seedDevelopmentPromotion(db, { objectStorage: storage, env: { NODE_ENV: 'production', CLERK_SECRET_KEY: 'sk_test_fake' } }), /development_seed_not_allowed/);
  const options = { objectStorage: storage, env: { NODE_ENV: 'test', CLERK_SECRET_KEY: 'sk_test_fake' }, now: () => '2026-11-10T00:00:00Z' };
  assert.equal(await seedDevelopmentPromotion(db, options), true);
  const promoId = 'promo_dev_davaogo';
  const event = { type: 'view', sessionId: 'one-session' };
  const write = instant => db.transaction(() => recordPromotionEvent(db, promoId, event, instant));
  await Promise.all(Array.from({ length: 5 }, () => write('2026-11-10T15:59:59Z')));
  await write('2026-11-10T16:00:00Z');
  await assert.rejects(db.transaction(async () => {
    await recordPromotionEvent(db, promoId, { ...event, sessionId: 'rolled-back' }, '2026-11-10T16:01:00Z');
    throw new Error('rollback');
  }), /rollback/);
  const stats = await api('ops', 'GET', `/ops/promotions/${promoId}/stats?from=2026-11-09&to=2026-11-12`);
  assert.deepEqual(stats.body, { timeZone: 'Asia/Manila', from: '2026-11-09', to: '2026-11-12', days: [
    { day: '2026-11-09', views: 0, opens: 0, taps: 0 }, { day: '2026-11-10', views: 1, opens: 0, taps: 0 },
    { day: '2026-11-11', views: 1, opens: 0, taps: 0 }, { day: '2026-11-12', views: 0, opens: 0, taps: 0 },
  ] });
  const created = await api('ops', 'POST', '/ops/promotions', { ...values, name: 'First', displayOrder: 0 });
  const feed = await api('client', 'GET', '/me/promotions/home');
  assert.equal(feed.body.promotions[0].id, created.body.promotion.id);
  await api('ops', 'PATCH', `/ops/promotions/${promoId}`, { name: 'Edited by staff', enabled: false });
  assert.equal(await seedDevelopmentPromotion(db, options), false);
  assert.equal((await api('ops', 'GET', `/ops/promotions/${promoId}`)).body.promotion.name, 'Edited by staff');
  await api('ops', 'DELETE', `/ops/promotions/${promoId}`, undefined, { raw: true });
  assert.equal(await seedDevelopmentPromotion(db, options), false);
  assert.equal((await db.query('SELECT count(*) AS count FROM home_promotion_view_sessions WHERE promotion_id=$1', [promoId])).rows[0].count, 2);
});


test('promotion writes, media references, audits and staff inbox rows roll back together', { skip: !DB }, async t => {
  const { db } = await setup(t);
  const before = await loadStore(db);
  await assert.rejects(db.transaction(async () => {
    const store = await loadStore(db);
    const result = await routeHomePromotions({ req: { method: 'POST' }, url: new URL('http://api.test/ops/promotions'),
      user: { id: 'ops', role: 'ops_admin' }, store, database: db,
      storage: { presignGet: async () => ({ url: 'https://storage.test/signed', expiresAt: at }) },
      readBody: async () => values, now: () => at, id: (() => { let n = 0; return prefix => `${prefix}_rollback_${n++}`; })(),
      audit: (store, entry) => store.auditLog.push({ id: 'audit_promo_rollback', at, actorId: entry.actor.id,
        actorRole: entry.actor.role, action: entry.action, entityType: entry.entityType, entityId: entry.entityId, detail: entry.detail }),
    });
    assert.equal(result.status, 201);
    await saveStore(db, store);
    throw new Error('forced rollback');
  }), /forced rollback/);
  assert.equal((await db.query('SELECT count(*) AS count FROM home_promotions')).rows[0].count, 0);
  const after = await loadStore(db);
  assert.deepEqual(after.files, before.files);
  assert.deepEqual(after.auditLog, before.auditLog);
  assert.deepEqual(after.notifications, before.notifications);
});
