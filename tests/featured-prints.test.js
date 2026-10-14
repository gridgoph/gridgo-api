import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { seedReferenceData } from '../src/seed.js';
import { publicFeaturedPrints, routeFeaturedPrints } from '../src/featured-prints.js';
import { listingSnapshot } from '../src/catalog-review-state.js';

const AT = new Date().toISOString();
function fixture(prefix = 'featured') {
  const supplier = `${prefix}_supplier`;
  const service = `${prefix}_service`;
  const roles = ['supplier', 'client', 'ops_admin', 'super_admin', 'rider'];
  return {
    settings: { serviceFeeRateBps: 1000 },
    users: roles.map(role => ({ id: `${prefix}_${role}`, clerkUserId: `${prefix}_${role}`, role,
      email: `${prefix}_${role}@example.test`, name: 'Private identity', createdAt: AT,
      ...(['supplier', 'rider'].includes(role) ? { verificationStatus: 'approved' } : {}),
      ...(role === 'client' ? { accountType: 'individual' } : {}) })),
    userRoleMemberships: roles.map(role => ({ userId: `${prefix}_${role}`, role, createdAt: AT })),
    supplierProfiles: [{ userId: supplier, shopName: 'PRIVATE SHOP', contactName: 'PRIVATE CONTACT',
      shop: { lat: 7.1, lng: 125.6, label: 'PRIVATE ADDRESS' }, updatedAt: AT }],
    approvalCases: [{ id: `${prefix}_approval`, userId: supplier, kind: 'supplier', status: 'approved',
      version: 1, applicationRevision: 1, createdAt: AT, updatedAt: AT }],
    supplierServices: [{ id: service, supplierId: supplier, categoryCode: 'marketing_collateral', state: 'live',
      pricingBasis: 'per_unit', referenceRateMinor: 1000, turnaroundHours: 24, version: 1, createdAt: AT, updatedAt: AT }],
    acceptedFileFormats: [{ code: 'pdf', displayName: 'PDF', inputKind: 'file', active: true }],
    supplierServiceFileFormats: [{ supplierServiceId: service, formatCode: 'pdf' }],
    catalogItems: ['a', 'b'].map((key, index) => ({ id: `${prefix}_${key}`, supplierId: supplier, supplierServiceId: service,
      subcategoryCode: 'flyers', name: `Flyer ${key}`, description: 'PRIVATE description', basePriceMinor: 1001 + index,
      pricingUnit: 'per_unit', turnaroundMode: 'inherit', fileFormatMode: 'inherit', active: true,
      reviewStatus: 'approved', version: 1, sortOrder: index, createdAt: AT, updatedAt: AT })),
    files: ['a', 'b'].map(key => ({ fileId: `${prefix}_photo_${key}`, ownerId: supplier, purpose: 'catalog_item_photo',
      originalFilename: 'PRIVATE.jpg', declaredContentType: 'image/jpeg', detectedContentType: 'image/jpeg',
      size: 12, state: 'ready', objectKey: `catalog/${prefix}_${key}.jpg`, references: [], createdAt: AT })),
    catalogItemPhotos: ['a', 'b'].map(key => ({ catalogItemId: `${prefix}_${key}`, fileId: `${prefix}_photo_${key}`,
      sortOrder: 0, altText: 'PRIVATE SHOP', createdAt: AT })),
    catalogOptionGroups: [], catalogOptions: [], notifications: [], auditLog: [],
  };
}

function select(store, ids = ['featured_b', 'featured_a']) {
  store.settings.featuredPrints = { version: 2, catalogItemIds: ids };
  return publicFeaturedPrints(store);
}

test('Featured Prints uses only curated products, client money, anonymous cards and approved revisions', () => {
  const store = fixture();
  assert.deepEqual(publicFeaturedPrints(store).items, []);
  assert.equal(publicFeaturedPrints(store).emptyState.action, 'browse_catalog');
  store.orders = [{ id: 'PRIVATE ORDER', name: 'PRIVATE CUSTOMER' }];
  const body = select(store);
  assert.deepEqual(body.items.map(item => item.id), ['featured_b', 'featured_a']);
  assert.equal(body.items[0].clientFromPriceMinor, 1102);
  assert.equal(body.emptyState, null);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE|supplier|owner|basePriceMinor|fromPriceMinor|objectKey|description|rating/);
  const item = store.catalogItems[0];
  item.approvedSnapshot = listingSnapshot(store, item);
  item.basePriceMinor = 99999;
  item.reviewStatus = 'pending';
  assert.equal(select(store).items[1].clientFromPriceMinor, 1101);
  item.reviewStatus = 'rejected';
  assert.equal(select(store).items[1].clientFromPriceMinor, 1101);
});

test('Featured Prints filters unavailable products without rewriting the curated order', () => {
  const changes = [
    store => { store.catalogItems[0].active = false; },
    store => { store.catalogItems[0].reviewStatus = 'pending'; },
    store => { store.catalogItems[0].reviewStatus = 'rejected'; },
    store => { store.catalogItems[0].suspendReason = 'Taken down'; },
    store => { store.catalogItems.splice(0, 1); },
    store => { store.files[0].state = 'deleted'; },
    store => { store.supplierServices[0].state = 'suspended'; },
    store => { store.supplierProfiles[0].isClosed = true; },
    store => { store.users[0].accountStatus = 'suspended'; },
    store => { store.approvalCases[0].status = 'suspended'; },
    store => { store.userRoleMemberships = []; },
    store => { store.supplierProfiles = []; },
  ];
  for (const change of changes) {
    const store = fixture();
    select(store);
    change(store);
    assert.equal(publicFeaturedPrints(store).items.some(item => item.id === 'featured_a'), false, String(change));
    assert.deepEqual(store.settings.featuredPrints.catalogItemIds, ['featured_b', 'featured_a']);
  }
});

test('Featured Prints validates complete replacement before mutating settings or audit', async () => {
  for (const body of [null, [], {}, { expectedVersion: '1' }, { expectedVersion: 0 },
    { expectedVersion: 1, catalogItemIds: ['featured_a', 'featured_a'], reason: 'Duplicate' },
    { expectedVersion: 1, catalogItemIds: Array.from({ length: 21 }, (_, i) => `item_${i}`), reason: 'Too many' },
    { expectedVersion: 1, catalogItemIds: [null], reason: 'Invalid' },
    { expectedVersion: 1, catalogItemIds: [], reason: ' ' },
    { expectedVersion: 1, catalogItemIds: ['missing'], reason: 'Missing' }]) {
    const store = fixture();
    const before = structuredClone(store);
    await assert.rejects(routeFeaturedPrints({ req: { method: 'PUT' }, url: new URL('http://test/admin/featured-prints'),
      store, user: store.users[2], readBody: async () => body, audit: () => assert.fail('No audit on rejection') }),
    error => [400, 409].includes(error.status));
    assert.deepEqual(store, before);
  }
});

const DATABASE_URL = process.env.DATABASE_URL;
test('PostgreSQL HTTP: roles, signed anonymous public read, version race, audit, rollback and persisted filtering', { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  const prefix = `featured_${crypto.randomUUID()}`;
  const data = fixture(prefix);
  const ids = data.catalogItems.map(item => item.id);
  const userIds = data.users.map(user => user.id);
  const ISSUER = 'https://featured-tests.clerk.accounts.dev';
  const PARTY = 'http://localhost:19006';
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  function token(role) {
    const t = Math.floor(Date.now() / 1000);
    const input = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({
      iss: ISSUER, sub: `${prefix}_${role}`, sid: 'test_session', azp: PARTY, iat: t - 5, exp: t + 600,
    })).toString('base64url')}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
  }
  let child;
  let originalSettings;
  try {
    await seedReferenceData(database);
    await database.transaction(async () => {
      const store = await loadStore(database);
      originalSettings = structuredClone(store.settings);
      store.settings.serviceFeeRateBps = 1000;
      delete store.settings.featuredPrints;
      for (const [key, rows] of Object.entries(data)) {
        if (['settings', 'acceptedFileFormats'].includes(key)) continue;
        store[key].push(...rows);
      }
      await saveStore(database, store);
    });
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, DATABASE_URL, HOST: '127.0.0.1', PORT: String(port),
      CLERK_SECRET_KEY: 'test-only-placeholder', CLERK_ISSUER: ISSUER, CLERK_AUTHORIZED_PARTIES: PARTY,
      CLERK_JWT_KEY: publicKey.export({ type: 'spki', format: 'pem' }), GRIDGO_FCM_SERVICE_ACCOUNT_FILE: '', GRIDGO_APNS_KEY_FILE: '',
      MINIO_ENDPOINT: 'http://127.0.0.1:1', MINIO_PUBLIC_URL: 'https://samples.example.test',
      MINIO_ACCESS_KEY: 'featured-test', MINIO_SECRET_KEY: 'featured-test-secret', MINIO_REGION: 'us-east-1',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    child.stdout.on('data', bytes => { logs += bytes; });
    child.stderr.on('data', bytes => { logs += bytes; });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode != null) throw new Error(logs);
      try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(ready, logs);
    async function request(path, method = 'GET', role, body) {
      const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json',
        ...(role ? { Authorization: `Bearer ${token(role)}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: await res.json(), cacheControl: res.headers.get('cache-control') };
    }
    const path = '/admin/featured-prints';
    const edit = { expectedVersion: 1, catalogItemIds: [...ids].reverse(), reason: 'Curate Home samples' };
    assert.equal((await request('/featured-prints')).body.emptyState.action, 'browse_catalog');
    for (const method of ['GET', 'PUT']) {
      assert.equal((await request(path, method, null, method === 'PUT' ? edit : undefined)).status, 401);
      for (const role of ['client', 'supplier', 'rider']) {
        assert.equal((await request(path, method, role, method === 'PUT' ? edit : undefined)).status, 403);
      }
    }
    assert.equal((await request(path, 'GET', 'ops_admin')).body.version, 1);
    const written = await request(path, 'PUT', 'ops_admin', edit);
    assert.equal(written.status, 200, JSON.stringify(written.body));
    assert.equal(written.body.version, 2);
    await seedReferenceData(database);
    assert.deepEqual((await loadStore(database)).settings.featuredPrints, { version: 2, catalogItemIds: [...ids].reverse() });
    const publicRead = await request('/featured-prints');
    assert.equal(publicRead.status, 200);
    assert.equal(publicRead.cacheControl, 'no-store');
    assert.deepEqual(publicRead.body.items.map(item => item.id), [...ids].reverse());
    assert.equal(publicRead.body.items[0].clientFromPriceMinor, 1102);
    assert.match(publicRead.body.items[0].photos[0].downloadUrl, /^https:\/\/samples\.example\.test\/.*X-Amz-Signature=/);
    assert.ok(Date.parse(publicRead.body.items[0].photos[0].downloadUrlExpiresAt) > Date.now());
    assert.doesNotMatch(JSON.stringify(publicRead.body), /PRIVATE|supplierId|supplierServiceId|ownerId|basePriceMinor|fromPriceMinor|description/);
    assert.equal((await request('/settings', 'GET', 'client')).body.settings.featuredPrints, undefined);
    const race = await Promise.all(['super_admin', 'ops_admin'].map(role => request(path, 'PUT', role,
      { ...edit, expectedVersion: 2, catalogItemIds: ids })));
    assert.deepEqual(race.map(row => row.status).sort(), [200, 409]);
    assert.equal(race.find(row => row.status === 409).body.error, 'featured_prints_version_conflict');
    let stored = await loadStore(database);
    assert.deepEqual(stored.settings.featuredPrints, { version: 3, catalogItemIds: ids });
    const audits = stored.auditLog.filter(row => row.action === 'catalog.featured_prints_update' && userIds.includes(row.actorId));
    assert.equal(audits.length, 2);
    assert.deepEqual(audits[0].detail.previous, { version: 1, catalogItemIds: [] });
    for (const role of ['ops_admin', 'super_admin']) assert.equal(stored.notifications.filter(row => row.userId === `${prefix}_${role}` && row.type === 'featured_prints_updated').length, 2);
    // The same save boundary rolls back configuration, audit and inbox together.
    await assert.rejects(database.transaction(async () => {
      const store = await loadStore(database);
      await routeFeaturedPrints({ req: { method: 'PUT' }, url: new URL(`http://test${path}`), store,
        user: data.users[3], readBody: async () => ({ ...edit, expectedVersion: 3, catalogItemIds: [] }),
        id: () => crypto.randomUUID(), now: () => AT,
        audit: (graph, entry) => graph.auditLog.push({ id: crypto.randomUUID(), at: AT, actorId: data.users[3].id, actorRole: 'super_admin', ...entry }),
      });
      await saveStore(database, store);
      throw new Error('rollback featured');
    }), /rollback featured/);
    stored = await loadStore(database);
    assert.equal(stored.settings.featuredPrints.version, 3);
    assert.equal(stored.auditLog.filter(row => row.action === 'catalog.featured_prints_update' && userIds.includes(row.actorId)).length, 2);
    for (const role of ['ops_admin', 'super_admin']) assert.equal(stored.notifications.filter(row => row.userId === `${prefix}_${role}` && row.type === 'featured_prints_updated').length, 2);
    await database.transaction(async () => {
      const store = await loadStore(database);
      store.catalogItems.find(item => item.id === ids[0]).active = false;
      await saveStore(database, store);
    });
    assert.deepEqual((await request('/featured-prints')).body.items.map(item => item.id), [ids[1]]);
    const staff = await request(path, 'GET', 'super_admin');
    assert.deepEqual(staff.body.catalogItemIds, ids);
    assert.equal(staff.body.items[0].available, false);
    assert.equal(staff.body.items[0].item, null);
    assert.equal((await request(path, 'PUT', 'ops_admin', { ...edit, expectedVersion: 3 })).body.error, 'featured_prints_item_unavailable');
    assert.equal((await request(path, 'PUT', 'super_admin', { ...edit, expectedVersion: 3, catalogItemIds: [] })).status, 200);
    assert.equal((await request('/featured-prints')).body.emptyState.action, 'browse_catalog');
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    try {
      await database.transaction(async () => {
        const store = await loadStore(database);
        for (const [key, rows] of Object.entries(data)) {
          if (['settings', 'acceptedFileFormats', 'auditLog', 'notifications'].includes(key)) continue;
          store[key] = store[key].filter(row => !rows.some(fixtureRow =>
            row.id ? row.id === fixtureRow.id : row.fileId ? row.fileId === fixtureRow.fileId
              : row.userId ? row.userId === fixtureRow.userId : row.supplierServiceId === fixtureRow.supplierServiceId));
        }
        store.notifications = store.notifications.filter(row => !userIds.includes(row.userId));
        store.supplierPaymentTerms = store.supplierPaymentTerms.filter(row => !userIds.includes(row.supplierId));
        if (originalSettings) store.settings = originalSettings;
        await saveStore(database, store);
      });
    } finally {
      await database.close();
    }
  }
});
