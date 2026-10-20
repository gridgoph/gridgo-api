import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const ISSUER = 'https://appleid.apple.com';
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function appleConfiguration(env = process.env) {
  try {
    const teamId = String(env.GRIDGO_APPLE_TEAM_ID || '').trim();
    const keyId = String(env.GRIDGO_APPLE_KEY_ID || '').trim();
    const clientIds = String(env.GRIDGO_APPLE_CLIENT_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
    const privateKey = createPrivateKey(String(env.GRIDGO_APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'));
    if (!teamId || !keyId || !clientIds.length || clientIds.some(value => !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value))
      || privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
    let baseUrl = ISSUER;
    // Test-only loopback server. Production can never redirect the key or codes.
    if (env.GRIDGO_APPLE_API_URL) {
      const url = new URL(env.GRIDGO_APPLE_API_URL);
      if (env.NODE_ENV !== 'test' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
        || url.origin !== env.GRIDGO_APPLE_API_URL) throw new Error();
      baseUrl = url.origin;
    }
    return { teamId, keyId, clientIds, privateKey, baseUrl };
  } catch {
    throw fail(503, 'apple_revocation_not_configured');
  }
}

export function appleClientSecret(config, clientId, now = Math.floor(Date.now() / 1000)) {
  if (!config.clientIds.includes(clientId)) throw fail(400, 'invalid_apple_client_id');
  const input = `${encode({ alg: 'ES256', kid: config.keyId, typ: 'JWT' })}.${encode({
    iss: config.teamId, iat: now, exp: now + 300, aud: ISSUER, sub: clientId,
  })}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key: config.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

// Use the SDK's explicit providerUserId, never Clerk account/identification IDs.
export function clerkAppleSubjects(clerkUser) {
  return (clerkUser?.externalAccounts || []).filter(account =>
    ['apple', 'oauth_apple'].includes(account.provider) && account.verification?.status === 'verified'
    && typeof account.providerUserId === 'string' && account.providerUserId.length > 0,
  ).map(account => account.providerUserId);
}

export function verifyAppleIdentity(token, keys, clientId, now = Math.floor(Date.now() / 1000)) {
  try {
    if (typeof token !== 'string' || token.length > 16384) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    const key = keys.find(value => value.kid === header.kid && value.kty === 'RSA' && value.alg === 'RS256' && value.use === 'sig');
    if (header.alg !== 'RS256' || !key || claims.iss !== ISSUER || claims.aud !== clientId
      || typeof claims.sub !== 'string' || !claims.sub || !Number.isFinite(claims.exp) || claims.exp <= now
      || !Number.isFinite(claims.iat) || claims.iat > now + 60
      || (claims.nbf != null && (!Number.isFinite(claims.nbf) || claims.nbf > now + 60))
      || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error();
    return claims.sub;
  } catch {
    throw fail(502, 'apple_identity_invalid');
  }
}

async function appleFetch(fetcher, url, options) {
  try {
    return await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch {
    throw fail(502, 'apple_unavailable');
  }
}

/** Tokens exist only in this call's memory. No provider body/error escapes. */
export async function revokeAppleAuthorization({ config, clientId, authorizationCode, subjects, fetcher = fetch }) {
  const clientSecret = appleClientSecret(config, clientId);
  // Load verification keys before spending the single-use code.
  const jwks = await appleFetch(fetcher, `${config.baseUrl}/auth/keys`);
  let keys;
  try { keys = (await jwks.json()).keys; } catch { /* fixed error below */ }
  if (!jwks.ok || !Array.isArray(keys) || !keys.length) throw fail(502, 'apple_unavailable');
  const response = await appleFetch(fetcher, `${config.baseUrl}/auth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: authorizationCode, grant_type: 'authorization_code' }),
  });
  let tokens;
  try { tokens = await response.json(); } catch { throw fail(502, 'apple_token_exchange_failed'); }
  if (!response.ok) throw fail(tokens?.error === 'invalid_grant' ? 400 : 502,
    tokens?.error === 'invalid_grant' ? 'invalid_apple_authorization_code' : 'apple_token_exchange_failed');
  const subject = verifyAppleIdentity(tokens?.id_token, keys, clientId);
  if (!subjects.includes(subject)) throw fail(403, 'apple_identity_mismatch');
  const refresh = typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0;
  const token = refresh ? tokens.refresh_token : tokens.access_token;
  if (typeof token !== 'string' || !token) throw fail(502, 'apple_token_exchange_failed');
  const revoked = await appleFetch(fetcher, `${config.baseUrl}/auth/revoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token,
      token_type_hint: refresh ? 'refresh_token' : 'access_token' }),
  });
  if (revoked.status !== 200) throw fail(502, 'apple_revocation_failed');
}
