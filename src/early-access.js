import { randomBytes, randomUUID } from 'node:crypto';
import { identityHasMembership } from './authorization-context.js';
import { appendTesterProgramAudit } from './postgres-store.js';
import { playConfig, validGoogleEmail } from './play-optin.js';
import { deskOperatorFromRequest } from './support-desk.js';
import { readJsonBody } from './issue-reports.js';
import { requestClientKey, tooManyRequests } from './support-rate-limit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalizePath = path => path.startsWith('/api/') ? path.slice(4) : path;
export function isEarlyAccessRoute(path) {
  return /^\/early-access(?:\/status|\/desk(?:\/[^/]+\/grant)?)?$/.test(normalizePath(path));
}
export function isStaffEarlyAccessRoute(path) {
  return /^\/ops\/early-access(?:\/[^/]+\/grant)?$/.test(normalizePath(path));
}
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const iso = value => value instanceof Date ? value.toISOString() : value ?? null;
const staffRow = row => ({ id: row.id, email: row.email, source: row.source, platform: row.platform,
  status: row.status, createdAt: iso(row.created_at), grantedAt: iso(row.granted_at), grantedBy: row.granted_by });

export function validateEarlyAccess(body) {
  if (body?.consent !== true) fail(400, 'consent_required');
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  // Non-Gmail Google accounts are supported; the visitor supplies their Play account.
  if (!validGoogleEmail(email, true)) fail(400, 'invalid_email');
  if (body.platform !== 'android') fail(400, 'invalid_platform');
  const source = body.source == null || body.source === '' ? null : body.source;
  if (source !== null && (typeof source !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source))) fail(400, 'invalid_source');
  return { email, source, platform: 'android' };
}

async function queueMail(database, signupId, kind) {
  await database.query('INSERT INTO early_access_email_outbox(id,signup_id,kind) VALUES($1,$2,$3)', [randomUUID(), signupId, kind]);
}
async function audit(database, actor, action, row, at) {
  await appendTesterProgramAudit(database, { actor, action, entityType: 'early_access_signup', entityId: row.id,
    detail: { status: row.status, platform: row.platform } }, at);
}

export async function createEarlyAccessSignup(database, body, { notifyStaff, kickMail = () => {} } = {}) {
  const input = validateEarlyAccess(body);
  return database.transaction(async () => {
    let row = (await database.query('SELECT * FROM early_access_signups WHERE email=$1', [input.email])).rows[0];
    const duplicate = Boolean(row);
    if (!row) {
      const at = new Date().toISOString();
      row = (await database.query(`INSERT INTO early_access_signups(id,email,token,consent_at,source,platform,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$4) RETURNING *`,
      [randomUUID(), input.email, randomBytes(32).toString('hex'), at, input.source, input.platform])).rows[0];
      await audit(database, { role: 'system' }, 'early_access.signed_up', row, at);
      await queueMail(database, row.id, 'team');
      await notifyStaff?.({ type: 'ops_early_access_signup', title: 'A new Android tester requested early access',
        occurrenceKey: row.id, resource: 'early-access', id: row.id });
      database.afterCommit(kickMail);
    }
    return { token: row.token, status: row.status, createdAt: iso(row.created_at), grantedAt: iso(row.granted_at), duplicate };
  });
}

export async function grantEarlyAccess(database, signupId, actor, { notifyStaff, kickMail = () => {} } = {}) {
  if (!UUID_RE.test(signupId)) fail(404, 'not_found');
  return database.transaction(async () => {
    let row = (await database.query('SELECT * FROM early_access_signups WHERE id=$1 FOR UPDATE', [signupId])).rows[0];
    if (!row) fail(404, 'not_found');
    if (row.status !== 'granted') {
      const config = await playConfig(database, 'client');
      const at = new Date().toISOString();
      row = (await database.query(`UPDATE early_access_signups SET status='granted',granted_at=$2,granted_by=$3,opt_in_url=$4
        WHERE id=$1 RETURNING *`, [signupId, at, actor.id, config.opt_in_url])).rows[0];
      await audit(database, actor, 'early_access.granted', row, at);
      await queueMail(database, row.id, 'access');
      await notifyStaff?.({ type: 'ops_early_access_granted', title: 'Android tester early access was granted',
        occurrenceKey: row.id, resource: 'early-access', id: row.id });
      database.afterCommit(kickMail);
    }
    return staffRow(row);
  });
}

export async function listEarlyAccess(database, params) {
  const status = params.get('status') || null;
  if (status !== null && !['pending', 'granted'].includes(status)) fail(400, 'invalid_status');
  const q = (params.get('q') || '').trim().toLowerCase();
  if (q.length > 254) fail(400, 'invalid_query');
  const number = (key, fallback, max) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw)) fail(400, 'invalid_pagination');
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > max || value < (key === 'limit' ? 1 : 0)) fail(400, 'invalid_pagination');
    return value;
  };
  const limit = number('limit', 50, 100), offset = number('offset', 0, 1_000_000);
  return database.snapshot(async () => {
    const rows = (await database.query(`SELECT * FROM early_access_signups
      WHERE ($1::text IS NULL OR status=$1) AND strpos(email,$2)>0 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,
    [status, q, limit, offset])).rows;
    const counts = (await database.query(`SELECT count(*) FILTER(WHERE status='pending')::int AS pending,
      count(*) FILTER(WHERE status='granted')::int AS granted FROM early_access_signups WHERE strpos(email,$1)>0`, [q])).rows[0];
    return { signups: rows.map(staffRow), counts, total: status ? counts[status] : counts.pending + counts.granted, limit, offset };
  });
}

/** Public and desk routes run before domain authentication; ops uses database memberships. */
export async function routeEarlyAccess({ req, res, pathname, url, send, database, user,
  env = process.env, verifyClerk, loadClerkUser, notifyStaff, kickMail }) {
  const staff = isStaffEarlyAccessRoute(pathname);
  if (!staff && !isEarlyAccessRoute(pathname)) return false;
  const path = normalizePath(pathname);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    let actor;
    if (staff) {
      if (!user) fail(401, 'unauthorized');
      if (!(identityHasMembership(user, 'ops_admin') || identityHasMembership(user, 'super_admin'))) fail(403, 'forbidden');
      actor = user;
    } else if (path.startsWith('/early-access/desk')) {
      const desk = await deskOperatorFromRequest(req, { env, verifyClerk, loadClerkUser });
      if (!desk.admin) fail(desk.status, desk.error);
      // Stable Clerk subject is an audit snapshot, never a local authorization role.
      actor = { id: desk.admin.clerkUserId, role: 'support_desk', name: 'Support desk' };
    }
    if (path === '/early-access' && req.method === 'POST') {
      if (tooManyRequests(`early-access:signup:${requestClientKey(req)}`, 10, 60 * 60 * 1000)) fail(429, 'rate_limited');
      send(res, 200, await createEarlyAccessSignup(database, await readJsonBody(req, 4096), { notifyStaff, kickMail }));
    } else if (path === '/early-access/status' && req.method === 'GET') {
      if (tooManyRequests(`early-access:status:${requestClientKey(req)}`, 120, 60 * 1000)) fail(429, 'rate_limited');
      const token = url.searchParams.get('token') || '';
      if (!/^[a-f0-9]{64}$/.test(token)) fail(404, 'not_found');
      const row = (await database.query('SELECT status,granted_at,opt_in_url FROM early_access_signups WHERE token=$1', [token])).rows[0];
      if (!row) fail(404, 'not_found');
      send(res, 200, { status: row.status, grantedAt: iso(row.granted_at), optInUrl: row.status === 'granted' ? row.opt_in_url : null });
    } else if (actor) {
      const base = staff ? '/ops/early-access' : '/early-access/desk';
      if (req.method === 'GET' && path === base) send(res, 200, await listEarlyAccess(database, url.searchParams));
      else if (req.method === 'POST' && path.endsWith('/grant')) {
        if (!staff) await readJsonBody(req, 4096);
        send(res, 200, await grantEarlyAccess(database, path.slice(base.length + 1, -6), actor, { notifyStaff, kickMail }));
      } else fail(404, 'not_found');
    } else fail(404, 'not_found');
  } catch (error) {
    if (!error.status || !error.code) throw error;
    send(res, error.status, { error: error.code });
  }
  return true;
}
