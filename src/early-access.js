import { randomBytes, randomUUID } from 'node:crypto';
import { identityHasMembership } from './authorization-context.js';
import { appendTesterProgramAudit } from './postgres-store.js';
import { createTesterGoogleGroup } from './tester-google-group.js';
import { playConfig, validGoogleEmail } from './play-optin.js';
import { deskOperatorFromRequest } from './support-desk.js';
import { readJsonBody } from './issue-reports.js';
import { requestClientKey, tooManyRequests } from './support-rate-limit.js';

const googleGroups = createTesterGoogleGroup();
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
const staffRow = row => ({ id: row.id, email: row.email, app: row.app, shopName: row.shop_name, source: row.source, platform: row.platform,
  status: row.status, createdAt: iso(row.created_at), grantedAt: iso(row.granted_at), grantedBy: row.granted_by });

export function validateEarlyAccess(body) {
  if (body?.consent !== true) fail(400, 'consent_required');
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  // Accept custom-domain Play accounts and Apple ID email addresses alike.
  if (!validGoogleEmail(email, true)) fail(400, 'invalid_email');
  const app = body.app === undefined ? 'customer' : body.app;
  if (!['customer', 'shop'].includes(app)) fail(400, 'invalid_app');
  const shopName = body.shopName == null ? null : body.shopName;
  if (shopName !== null && (typeof shopName !== 'string' || [...shopName.trim()].length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(shopName))) fail(400, 'invalid_shop_name');
  const platform = body.platform === undefined ? 'android' : body.platform;
  if (!['android', 'iphone'].includes(platform)) fail(400, 'invalid_platform');
  const source = body.source == null || body.source === '' ? null : body.source;
  if (source !== null && (typeof source !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source))) fail(400, 'invalid_source');
  return { email, source, platform, app, shopName: app === 'shop' ? shopName?.trim() || null : null };
}

async function queueMail(database, signupId, kind) {
  await database.query('INSERT INTO early_access_email_outbox(id,signup_id,kind) VALUES($1,$2,$3)', [randomUUID(), signupId, kind]);
}
async function requireShopActivation(database, app) {
  if (app !== 'shop') return;
  const { rows: [row] } = await database.query("SELECT settings->'shopEarlyAccessEnabled' = 'true'::jsonb AS enabled FROM platform_settings WHERE singleton");
  if (row?.enabled !== true) fail(409, 'shop_early_access_disabled');
}
async function audit(database, actor, action, row, at, detail = {}) {
  await appendTesterProgramAudit(database, { actor, action, entityType: 'early_access_signup', entityId: row.id,
    detail: { status: row.status, platform: row.platform, app: row.app, ...detail } }, at);
}

export async function createEarlyAccessSignup(database, body, { notifyStaff, kickMail = () => {} } = {}) {
  const input = validateEarlyAccess(body);
  return database.transaction(async () => {
    await requireShopActivation(database, input.app);
    let row = (await database.query('SELECT * FROM early_access_signups WHERE email=$1 AND app=$2', [input.email, input.app])).rows[0];
    const duplicate = Boolean(row);
    if (!row) {
      const at = new Date().toISOString();
      row = (await database.query(`INSERT INTO early_access_signups(id,email,token,consent_at,source,platform,created_at,app,shop_name)
        VALUES($1,$2,$3,$4,$5,$6,$4,$7,$8) RETURNING *`,
      [randomUUID(), input.email, randomBytes(32).toString('hex'), at, input.source, input.platform, input.app, input.shopName])).rows[0];
      await audit(database, { role: 'system' }, 'early_access.signed_up', row, at);
      await queueMail(database, row.id, 'team');
      await notifyStaff?.({ type: 'ops_early_access_signup', title: `A new ${row.platform === 'iphone' ? 'iPhone' : 'Android'}${row.app === 'shop' ? ' shop' : ''} tester requested ${row.app === 'shop' && row.platform === 'iphone' ? 'shop availability notification' : 'early access'}`,
        occurrenceKey: row.id, resource: 'early-access', id: row.id });
      database.afterCommit(kickMail);
    }
    return { token: row.token, app: row.app, platform: row.platform, status: row.status, createdAt: iso(row.created_at), grantedAt: iso(row.granted_at), duplicate };
  });
}

export async function grantEarlyAccess(database, signupId, actor, { notifyStaff, kickMail = () => {}, groups = googleGroups } = {}) {
  if (!UUID_RE.test(signupId)) fail(404, 'not_found');
  return database.transaction(async () => {
    let row = (await database.query('SELECT * FROM early_access_signups WHERE id=$1 FOR UPDATE', [signupId])).rows[0];
    if (!row) fail(404, 'not_found');
    await requireShopActivation(database, row.app);
    if (row.app === 'shop' && row.platform === 'iphone') fail(409, 'shop_android_only');
    // An immutable, timestamp-bound app-aware grant audit proves the stored
    // snapshot came from this implementation. Legacy grants have no app detail;
    // repair them once even if the client Play URL has changed since that grant.
    const repair = row.app === 'shop' && row.status === 'granted' && !(await database.query(`
      SELECT 1 FROM audit_log WHERE entity_type='early_access_signup' AND entity_id=$1
        AND action IN ('early_access.granted','early_access.grant_repaired') AND at=$2::timestamptz
        AND data #>> '{detail,app}'='shop' LIMIT 1`, [row.id, row.granted_at])).rowCount;
    if (row.status !== 'granted' || repair) {
      const previous = repair ? { previousOptInUrl: row.opt_in_url, previousGrantedAt: iso(row.granted_at), previousGrantedBy: row.granted_by } : {};
      // Customer enrollment stays manual. An unset supplier Group safely uses
      // the same staff-managed enrollment; configured provider failures may retry.
      if (row.app === 'shop' && groups.configured('supplier')) {
        try { await groups.addMember('supplier', row.email); } catch { fail(503, 'google_group_unavailable'); }
      }
      const optInUrl = row.platform === 'android' ? (await playConfig(database, row.app === 'shop' ? 'supplier' : 'client')).opt_in_url : null;
      const at = new Date().toISOString();
      row = (await database.query(`UPDATE early_access_signups SET status='granted',granted_at=$2,granted_by=$3,opt_in_url=$4
        WHERE id=$1 RETURNING *`, [signupId, at, actor.id, optInUrl])).rows[0];
      await audit(database, actor, repair ? 'early_access.grant_repaired' : 'early_access.granted', row, at, previous);
      if (repair) {
        // A distinct Message-ID allows a corrective invite after an old worker
        // already sent the wrong one, and invalidates the previous mail lease.
        await database.query(`INSERT INTO early_access_email_outbox(id,signup_id,kind) VALUES($1,$2,'access')
          ON CONFLICT(signup_id,kind) DO UPDATE SET id=EXCLUDED.id,status='pending',attempts=0,next_at=now(),created_at=now()`, [randomUUID(), row.id]);
      } else if (row.platform === 'android') await queueMail(database, row.id, 'access');
      await notifyStaff?.({ type: 'ops_early_access_granted', title: `${row.platform === 'iphone' ? 'iPhone' : 'Android'}${row.app === 'shop' ? ' shop' : ''} tester early access ${repair ? 'invite was corrected' : 'was granted'}`,
        occurrenceKey: repair ? `${row.id}:grant-repaired:${at}` : row.id, resource: 'early-access', id: row.id });
      if (row.platform === 'android') database.afterCommit(kickMail);
    }
    return staffRow(row);
  });
}

export async function listEarlyAccess(database, params) {
  const app = params.get('app') || null;
  if (app !== null && !['customer', 'shop'].includes(app)) fail(400, 'invalid_app');
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
      WHERE ($1::text IS NULL OR status=$1) AND strpos(email,$2)>0 AND ($5::text IS NULL OR app=$5) ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,
    [status, q, limit, offset, app])).rows;
    const grouped = (await database.query(`SELECT app,
      count(*) FILTER(WHERE status='pending')::int AS pending,
      count(*) FILTER(WHERE status='granted')::int AS granted,
      count(*) FILTER(WHERE status='granted' AND platform='android')::int AS "androidGranted",
      count(*) FILTER(WHERE app='shop' AND platform='iphone')::int AS "notifyOnly"
      FROM early_access_signups WHERE strpos(email,$1)>0 GROUP BY app`, [q])).rows;
    const countsByApp = Object.fromEntries(['customer', 'shop'].map(key => [key, { pending: 0, granted: 0, androidGranted: 0, notifyOnly: 0 }]));
    for (const { app: key, ...counts } of grouped) countsByApp[key] = counts;
    const selected = app ? [countsByApp[app]] : Object.values(countsByApp);
    const counts = selected.reduce((sum, row) => ({ pending: sum.pending + row.pending, granted: sum.granted + row.granted }), { pending: 0, granted: 0 });
    return { signups: rows.map(staffRow), counts, countsByApp, total: status ? counts[status] : counts.pending + counts.granted, limit, offset };
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
      const row = (await database.query('SELECT app,platform,status,granted_at,opt_in_url FROM early_access_signups WHERE token=$1', [token])).rows[0];
      if (!row) fail(404, 'not_found');
      send(res, 200, { app: row.app, platform: row.platform, status: row.status, grantedAt: iso(row.granted_at), optInUrl: row.status === 'granted' ? row.opt_in_url : null });
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
