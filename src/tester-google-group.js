import { createSign } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.member';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Fixed Google endpoints, bounded requests, no credential/provider response logging. */
export function createTesterGoogleGroup({ env = process.env, fetchImpl = fetch, clock = Date.now } = {}) {
  const groupKey = app => env[`PLAY_TESTER_GROUP_${app.toUpperCase()}`];
  const configured = app => Boolean(env.PLAY_TESTER_GOOGLE_CLIENT_EMAIL && env.PLAY_TESTER_GOOGLE_PRIVATE_KEY
    && env.PLAY_TESTER_GOOGLE_ADMIN_EMAIL && groupKey(app));
  let cached;
  async function accessToken() {
    if (cached && cached.until > clock()) return cached.token;
    const iat = Math.floor(clock() / 1000);
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: env.PLAY_TESTER_GOOGLE_CLIENT_EMAIL,
      sub: env.PLAY_TESTER_GOOGLE_ADMIN_EMAIL, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
    const signer = createSign('RSA-SHA256'); signer.update(input); signer.end();
    const assertion = `${input}.${signer.sign(env.PLAY_TESTER_GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), 'base64url')}`;
    const response = await fetchImpl(TOKEN_URL, { method: 'POST', signal: AbortSignal.timeout(8000),
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
    if (!response.ok) throw new Error('google_group_unavailable');
    const data = await response.json();
    if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('google_group_unavailable');
    cached = { token: data.access_token, until: clock() + Math.max(0, data.expires_in - 120) * 1000 };
    return cached.token;
  }
  return { configured, async addMember(app, email) {
    if (!configured(app)) throw new Error('google_group_not_configured');
    const response = await fetchImpl(`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(groupKey(app))}/members`, {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role: 'MEMBER' }),
    });
    // Directory returns 409 when this member already belongs to this group.
    if (!response.ok && response.status !== 409) throw new Error('google_group_unavailable');
  } };
}
