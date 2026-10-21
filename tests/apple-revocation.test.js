import { generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appleConfiguration, appleClientSecret, clerkAppleSubjects, verifyAppleIdentity, revokeAppleAuthorization } from '../src/apple-revocation.js';
import { loadClerkAppleAccount } from '../src/auth.js';

const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = { GRIDGO_APPLE_TEAM_ID: 'TESTTEAM01', GRIDGO_APPLE_KEY_ID: 'TESTKEY001',
  GRIDGO_APPLE_PRIVATE_KEY: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  GRIDGO_APPLE_CLIENT_IDS: 'ph.gridgo.client,ph.gridgo.supplier,ph.gridgo.rider' };
const config = appleConfiguration(env);
const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'apple-test', alg: 'RS256', use: 'sig' };

test('bounded Clerk Apple lookup pins the installed BAPI version, maps provider subjects and suppresses provider failures', async () => {
  const config = { apiUrl: 'http://127.0.0.1:12345', secretKey: 'private-test-secret' };
  const account = { provider: 'oauth_apple', provider_user_id: 'apple-owner', verification: { status: 'verified' }, access_token: 'PRIVATE_PROVIDER_TOKEN' };
  const value = await loadClerkAppleAccount(config, 'user_/encoded', { fetcher: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:12345/v1/users/user_%2Fencoded');
    assert.equal(options.headers.Authorization, 'Bearer private-test-secret');
    assert.equal(options.headers['Clerk-API-Version'], '2026-05-12');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ id: 'user_/encoded', external_accounts: [account], private_metadata: { token: 'PRIVATE' } });
  } });
  assert.deepEqual(value, { id: 'user_/encoded', externalAccounts: [{ provider: 'oauth_apple', providerUserId: 'apple-owner', verification: { status: 'verified' } }] });
  for (const fetcher of [async () => { throw new Error('PRIVATE_PROVIDER_ERROR'); },
    async () => Response.json({ error: 'PRIVATE_PROVIDER_ERROR' }, { status: 503 }),
    async () => new Response('PRIVATE_PROVIDER_ERROR'), async () => Response.json({ id: 'user_wrong_shape' })]) {
    assert.equal(await loadClerkAppleAccount(config, 'user_test', { fetcher }), null);
  }
});
function identity(claims = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = [ { alg: 'RS256', kid: jwk.kid, ...header },
    { iss: 'https://appleid.apple.com', aud: 'ph.gridgo.client', sub: 'apple-owner', iat: now, exp: now + 300, ...claims },
  ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), rsa.privateKey).toString('base64url')}`;
}

test('Apple client secrets use ES256/P-256, a five-minute lifetime and the selected bundle ID', () => {
  for (const clientId of config.clientIds) {
    const [header, payload, signature] = appleClientSecret(config, clientId, 1000).split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'TESTKEY001', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), {
      iss: 'TESTTEAM01', iat: 1000, exp: 1300, aud: 'https://appleid.apple.com', sub: clientId,
    });
    assert.equal(Buffer.from(signature, 'base64url').length, 64);
    assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  }
  assert.throws(() => appleClientSecret(config, 'untrusted.bundle'), { code: 'invalid_apple_client_id' });
  for (const name of ['GRIDGO_APPLE_TEAM_ID', 'GRIDGO_APPLE_KEY_ID', 'GRIDGO_APPLE_PRIVATE_KEY', 'GRIDGO_APPLE_CLIENT_IDS']) {
    assert.throws(() => appleConfiguration({ ...env, [name]: '' }), { code: 'apple_revocation_not_configured' });
  }
  assert.throws(() => appleConfiguration({ ...env, GRIDGO_APPLE_PRIVATE_KEY: rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }) }), { code: 'apple_revocation_not_configured' });
  assert.throws(() => appleConfiguration({ ...env, NODE_ENV: 'production', GRIDGO_APPLE_API_URL: 'http://127.0.0.1:9000' }), { code: 'apple_revocation_not_configured' });
  assert.throws(() => appleConfiguration({ ...env, NODE_ENV: 'test', GRIDGO_APPLE_API_URL: 'https://attacker.test' }), { code: 'apple_revocation_not_configured' });
  assert.ok(appleConfiguration({ ...env, GRIDGO_APPLE_PRIVATE_KEY: env.GRIDGO_APPLE_PRIVATE_KEY.replace(/\n/g, '\\n') }));
});

test('Apple signing keys select complete per-bundle overrides and isolate unavailable keys to their app', () => {
  const supplier = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const rider = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const supplierPair = { keyId: 'SUPPLIER01', privateKey: supplier.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const riderPair = { keyId: 'RIDERKEY01', privateKey: rider.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const perApp = { ...env, GRIDGO_APPLE_SIGNING_KEYS: JSON.stringify({ 'ph.gridgo.supplier': supplierPair, 'ph.gridgo.rider': riderPair }) };
  for (const [clientId, keyId, key] of [['ph.gridgo.client', 'TESTKEY001', ec.publicKey],
    ['ph.gridgo.supplier', supplierPair.keyId, supplier.publicKey], ['ph.gridgo.rider', riderPair.keyId, rider.publicKey]]) {
    const selected = appleConfiguration(perApp, clientId);
    const [header, payload, signature] = appleClientSecret(selected, clientId).split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).kid, keyId);
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).sub, clientId);
    assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
    if (clientId !== 'ph.gridgo.client') assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), false);
  }
  const onlySupplier = { ...perApp, GRIDGO_APPLE_KEY_ID: '', GRIDGO_APPLE_PRIVATE_KEY: '',
    GRIDGO_APPLE_SIGNING_KEYS: JSON.stringify({ 'ph.gridgo.supplier': supplierPair, 'ph.gridgo.rider': { keyId: 'INCOMPLETE' } }) };
  assert.ok(appleClientSecret(appleConfiguration(onlySupplier, 'ph.gridgo.supplier'), 'ph.gridgo.supplier'));
  for (const clientId of ['ph.gridgo.client', 'ph.gridgo.rider']) assert.throws(() => appleConfiguration(onlySupplier, clientId), { code: 'apple_revocation_not_configured' });
  const incompleteOverride = { ...perApp, GRIDGO_APPLE_SIGNING_KEYS: JSON.stringify({ 'ph.gridgo.supplier': { privateKey: supplierPair.privateKey } }) };
  assert.throws(() => appleConfiguration(incompleteOverride, 'ph.gridgo.supplier'), { code: 'apple_revocation_not_configured' });
  assert.ok(appleClientSecret(appleConfiguration(incompleteOverride, 'ph.gridgo.client'), 'ph.gridgo.client'), 'invalid unrelated overrides never disable the default');
  const invalidCurve = { ...perApp, GRIDGO_APPLE_SIGNING_KEYS: JSON.stringify({ 'ph.gridgo.rider': {
    keyId: 'WRONGCURVE', privateKey: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  } }) };
  assert.throws(() => appleConfiguration(invalidCurve, 'ph.gridgo.rider'), { code: 'apple_revocation_not_configured' });
  assert.ok(appleClientSecret(appleConfiguration(invalidCurve, 'ph.gridgo.client'), 'ph.gridgo.client'));
  for (const value of ['not-json', 'null', '[]', '"string"']) assert.throws(() => appleConfiguration({ ...perApp, GRIDGO_APPLE_SIGNING_KEYS: value }, 'ph.gridgo.client'), { code: 'apple_revocation_not_configured' });
  assert.throws(() => appleClientSecret(appleConfiguration(perApp, 'ph.gridgo.supplier'), 'ph.gridgo.rider'), { code: 'apple_revocation_not_configured' }, 'selected keys cannot be reused for another bundle');
});

test('Apple binding uses verified providerUserId, never email, metadata or Clerk identification IDs', () => {
  assert.deepEqual(clerkAppleSubjects({ externalAccounts: [
    { provider: 'apple', providerUserId: 'subject', externalId: 'idn_wrong', verification: { status: 'verified' } },
    { provider: 'oauth_apple', providerUserId: 'second', verification: { status: 'verified' } },
    { provider: 'apple', providerUserId: 'unverified', verification: { status: 'unverified' } },
    { provider: 'google', providerUserId: 'wrong-provider', verification: { status: 'verified' } },
    { provider: 'apple', externalId: 'never-use-this', verification: { status: 'verified' } },
  ] }), ['subject', 'second']);
});

test('Apple identity verification rejects wrong issuer/audience, expiry, keys, algorithms and signatures', () => {
  assert.equal(verifyAppleIdentity(identity(), [jwk], 'ph.gridgo.client'), 'apple-owner');
  for (const claims of [{ iss: 'https://attacker.test' }, { aud: 'ph.gridgo.rider' }, { exp: 1 }, { sub: '' }, { iat: 9e12 }, { nbf: 9e12 }]) {
    assert.throws(() => verifyAppleIdentity(identity(claims), [jwk], 'ph.gridgo.client'), { code: 'apple_identity_invalid' });
  }
  assert.throws(() => verifyAppleIdentity(identity({}, { alg: 'none' }), [jwk], 'ph.gridgo.client'), { code: 'apple_identity_invalid' });
  assert.throws(() => verifyAppleIdentity(identity(), [], 'ph.gridgo.client'), { code: 'apple_identity_invalid' });
  const token = identity().split('.');
  token[2] = Buffer.alloc(256).toString('base64url');
  assert.throws(() => verifyAppleIdentity(token.join('.'), [jwk], 'ph.gridgo.client'), { code: 'apple_identity_invalid' });
});

test('Apple token exchange and revocation are form-encoded, bound to bundle, and use refresh/access hints', async () => {
  for (const refresh of [true, false]) {
    const calls = [];
    const fetcher = async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/auth/keys')) return Response.json({ keys: [jwk] });
      if (url.endsWith('/auth/token')) return Response.json({ id_token: identity(), access_token: 'private-access', ...(refresh ? { refresh_token: 'private-refresh' } : {}) });
      return new Response('', { status: 200 });
    };
    await revokeAppleAuthorization({ config, clientId: 'ph.gridgo.client', authorizationCode: 'code+&=', subjects: ['apple-owner'], fetcher });
    assert.deepEqual(calls.map(call => call.url), ['https://appleid.apple.com/auth/keys', 'https://appleid.apple.com/auth/token', 'https://appleid.apple.com/auth/revoke']);
    const exchange = calls[1].options;
    assert.equal(exchange.method, 'POST');
    assert.equal(exchange.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual([...exchange.body.keys()].sort(), ['client_id', 'client_secret', 'code', 'grant_type']);
    assert.equal(exchange.body.get('code'), 'code+&=');
    assert.equal(exchange.body.get('grant_type'), 'authorization_code');
    const revoke = calls[2].options;
    assert.deepEqual([...revoke.body.keys()].sort(), ['client_id', 'client_secret', 'token', 'token_type_hint']);
    assert.equal(revoke.body.get('client_id'), 'ph.gridgo.client');
    assert.equal(revoke.body.get('token_type_hint'), refresh ? 'refresh_token' : 'access_token');
    assert.equal(revoke.body.get('token'), refresh ? 'private-refresh' : 'private-access');
    for (const { options } of calls) { assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal); }
    const [header, payload, sig] = revoke.body.get('client_secret').split('.');
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).sub, 'ph.gridgo.client');
    assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: createPublicKey(config.privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  }
});

test('Apple transport/key/token failures return fixed errors and never revoke before verification', async () => {
  for (const failure of ['transport', 'keys-status', 'keys-json', 'keys-empty', 'token-missing', 'revoke-transport']) {
    const calls = [];
    const fetcher = async url => {
      calls.push(url);
      if (failure === 'transport' || (failure === 'revoke-transport' && url.endsWith('/auth/revoke'))) throw new Error('PRIVATE_PROVIDER_ERROR');
      if (url.endsWith('/auth/keys')) {
        if (failure === 'keys-status') return Response.json({ keys: [jwk] }, { status: 503 });
        if (failure === 'keys-json') return new Response('PRIVATE_PROVIDER_ERROR');
        return Response.json({ keys: failure === 'keys-empty' ? [] : [jwk] });
      }
      return Response.json({ id_token: identity(), ...(failure === 'token-missing' ? {} : { refresh_token: 'PRIVATE_REFRESH' }) });
    };
    const expected = failure === 'token-missing' ? 'apple_token_exchange_failed' : 'apple_unavailable';
    await assert.rejects(revokeAppleAuthorization({ config, clientId: 'ph.gridgo.client',
      authorizationCode: 'private-code', subjects: ['apple-owner'], fetcher }), { message: expected, code: expected, status: 502 });
    if (failure !== 'revoke-transport') assert.ok(!calls.some(url => url.endsWith('/auth/revoke')));
    if (failure.startsWith('keys') || failure === 'transport') assert.ok(!calls.some(url => url.endsWith('/auth/token')));
  }
});
