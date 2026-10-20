import { createHash, randomUUID } from 'node:crypto';
import { authorizationContextFor, contextHasMembership } from './authorization-context.js';
import { requestClientKey, tooManyRequests } from './support-rate-limit.js';
import { appleConfiguration, clerkAppleSubjects, revokeAppleAuthorization } from './apple-revocation.js';
import { DOMAIN_MUTATION_LOCK } from './database.js';

const ACCEPTED = { status: 202, body: { ok: true, message: 'We will delete your account within 30 days' } };
const failure = (status, error) => ({ status, body: { error } });
const project = (row) => ({
  id: row.id, userId: row.user_id, contactEmail: row.contact_email, source: row.source,
  status: row.status, requestedAt: row.requested_at, dueAt: row.due_at,
  completedAt: row.completed_at, completedBy: row.completed_by,
  appleRevocations: row.apple_revocations || [],
});
const revocationProjection = row => ({ clientId: row.client_id, status: row.status,
  attemptedAt: row.attempted_at, revokedAt: row.revoked_at, error: row.error_code });
const queueSelect = `SELECT r.*, COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'clientId', a.client_id, 'status', a.status, 'attemptedAt', a.attempted_at,
  'revokedAt', a.revoked_at, 'error', a.error_code) ORDER BY a.client_id)
  FROM (SELECT DISTINCT ON (client_id) * FROM account_deletion_apple_revocations
    WHERE request_id=r.id ORDER BY client_id, attempted_at DESC, id DESC) a), '[]'::jsonb) AS apple_revocations
  FROM account_deletion_requests r`;

async function appleRevocation({ req, user, database, readBody, onEvent, loadClerkUser, env }) {
  if (req.method !== 'POST') return failure(404, 'not_found');
  const body = await readBody(req);
  if (body?.confirmed !== true) return failure(400, 'confirmation_required');
  if (typeof body.clientId !== 'string' || !body.clientId || body.clientId.length > 255) return failure(400, 'invalid_apple_client_id');
  if (typeof body.authorizationCode !== 'string' || !body.authorizationCode.trim() || body.authorizationCode.length > 4096) return failure(400, 'invalid_apple_authorization_code');
  const digest = createHash('sha256').update(body.authorizationCode).digest('hex');
  return database.transaction(async () => {
    const previous = (await database.query(`SELECT a.* FROM account_deletion_apple_revocations a
      JOIN account_deletion_requests r ON r.id=a.request_id
      WHERE r.user_id=$1 AND a.client_id=$2 AND a.code_digest=$3
      ORDER BY a.attempted_at DESC LIMIT 1`, [user.id, body.clientId, digest])).rows[0];
    const respond = row => ({ status: row.http_status, body: {
      ...(row.error_code ? { error: row.error_code } : { ok: true }),
      requestId: row.request_id, appleRevocation: revocationProjection(row),
    } });
    // A lost response can be retried without spending its code again. A NEW
    // Apple sign-in may re-authorize the app, so new codes must always be revoked.
    if (previous) return respond(previous);
    const request = (await database.query("SELECT id FROM account_deletion_requests WHERE user_id=$1 AND status='pending'", [user.id])).rows[0];
    if (!request) return failure(409, 'account_deletion_request_required');
    let config;
    try { config = appleConfiguration(env); } catch (error) { return failure(error.status, error.code); }
    if (!config.clientIds.includes(body.clientId)) return failure(400, 'invalid_apple_client_id');
    let clerkUser;
    try { clerkUser = await loadClerkUser(user.clerkUserId); } catch { return failure(502, 'clerk_unavailable'); }
    if (!clerkUser || clerkUser.id !== user.clerkUserId) return failure(502, 'clerk_unavailable');
    const subjects = clerkAppleSubjects(clerkUser);
    if (!subjects.length) return failure(409, 'apple_account_not_linked');
    let errorCode = null;
    let httpStatus = 200;
    try {
      await revokeAppleAuthorization({ config, clientId: body.clientId, authorizationCode: body.authorizationCode, subjects });
    } catch (error) {
      // Never serialize/log a provider exception (which may contain tokens).
      const allowed = ['apple_unavailable', 'apple_token_exchange_failed', 'invalid_apple_authorization_code',
        'apple_identity_invalid', 'apple_identity_mismatch', 'apple_revocation_failed'];
      errorCode = allowed.includes(error.code) ? error.code : 'apple_unavailable';
      httpStatus = errorCode === 'apple_identity_mismatch' ? 403 : errorCode === 'invalid_apple_authorization_code' ? 400 : 502;
    }
    // Apple cannot hold up unrelated order/payment work. Take the domain lock
    // only when the result, audit and notifications are ready to commit.
    await database.query('SELECT pg_advisory_xact_lock(hashtext($1))', [DOMAIN_MUTATION_LOCK]);
    const row = (await database.query(`INSERT INTO account_deletion_apple_revocations
      (id,request_id,client_id,code_digest,status,error_code,http_status,revoked_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $5='revoked' THEN clock_timestamp() END) RETURNING *`,
    [randomUUID(), request.id, body.clientId, digest, errorCode ? 'retry_required' : 'revoked', errorCode, httpStatus])).rows[0];
    await onEvent({ action: errorCode ? 'account_deletion_apple_revocation_failed' : 'account_deletion_apple_revoked',
      id: request.id, eventId: row.id, actor: user,
      detail: { attemptId: row.id, clientId: row.client_id, status: row.status, error: errorCode } });
    return respond(row);
  }, { lockKey: `gridgo-apple-revocation:${user.id}` });
}

// This records a request only. Operations must verify web ownership and complete
// the deletion separately before recording completion here.
export async function routeAccountDeletion({ req, url, user, database, readBody, onEvent, loadClerkUser, env = process.env }) {
  const path = url.pathname === '/api/account-deletion-requests' ? '/account-deletion-requests' : url.pathname;
  const app = path === '/me/account-deletion-request';
  const apple = path === '/me/account-deletion-request/apple-revocation';
  const web = path === '/account-deletion-requests';
  const staff = path === '/ops/account-deletion-requests' || path.startsWith('/ops/account-deletion-requests/');
  if (!app && !apple && !web && !staff) return null;
  if (!web && !user) return failure(401, 'unauthorized');
  if (apple) return appleRevocation({ req, user, database, readBody, onEvent, loadClerkUser, env });
  if (app && req.method === 'GET') {
    const row = (await database.query(`${queueSelect} WHERE r.user_id=$1 AND r.status='pending'`, [user.id])).rows[0];
    return { status: 200, body: { request: row ? project(row) : null } };
  }
  if (staff) {
    const context = authorizationContextFor(user);
    if (!contextHasMembership(context, 'ops_admin') && !contextHasMembership(context, 'super_admin')) return failure(403, 'forbidden');
    if (req.method === 'GET' && path === '/ops/account-deletion-requests') {
      const status = url.searchParams.get('status') || 'pending';
      if (!['pending', 'done'].includes(status)) return failure(400, 'invalid_status');
      const offset = Number(url.searchParams.get('offset') || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) return failure(400, 'invalid_offset');
      const result = await database.query(`${queueSelect} WHERE r.status=$1 ORDER BY r.requested_at, r.id LIMIT 101 OFFSET $2`, [status, offset]);
      return { status: 200, body: { requests: result.rows.slice(0, 100).map(project), nextOffset: result.rows.length > 100 ? offset + 100 : null } };
    }
    if (req.method !== 'PATCH') return failure(404, 'not_found');
    const id = path.slice('/ops/account-deletion-requests/'.length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return failure(404, 'not_found');
    const body = await readBody(req);
    if (body?.status !== 'done' || body?.confirmed !== true) return failure(400, 'completion_confirmation_required');
    return database.transaction(async () => {
      const result = await database.query('SELECT * FROM account_deletion_requests WHERE id=$1', [id]);
      if (!result.rows.length) return failure(404, 'not_found');
      let row = result.rows[0];
      if (row.status !== 'done') {
        row = (await database.query("UPDATE account_deletion_requests SET status='done', completed_at=now(), completed_by=$2 WHERE id=$1 RETURNING *", [id, user.id])).rows[0];
        await onEvent({ action: 'account_deletion_request_completed', id, actor: user });
      }
      row = (await database.query(`${queueSelect} WHERE r.id=$1`, [id])).rows[0];
      return { status: 200, body: { request: project(row) } };
    });
  }
  if (req.method !== 'POST') return failure(404, 'not_found');
  if (web && tooManyRequests(`account-deletion:${requestClientKey(req)}`, 10, 10 * 60 * 1000)) return failure(429, 'too_many_requests');
  const body = await readBody(req);
  if (body?.confirmed !== true) return failure(400, 'confirmation_required');
  const email = app ? user.email : (typeof body.email === 'string' ? body.email.trim().toLowerCase() : '');
  if (web && (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return failure(400, 'invalid_email');
  return database.transaction(async () => {
    const existing = await database.query(app
      ? "SELECT id FROM account_deletion_requests WHERE user_id=$1 AND status='pending'"
      : "SELECT id FROM account_deletion_requests WHERE source='web' AND contact_email=$1 AND status='pending'", [app ? user.id : email]);
    if (!existing.rows.length) {
      const id = randomUUID();
      await database.query('INSERT INTO account_deletion_requests (id,user_id,contact_email,source) VALUES ($1,$2,$3,$4)', [id, app ? user.id : null, email || null, app ? 'app' : 'web']);
      await onEvent({ action: 'account_deletion_requested', id, actor: app ? user : null });
    }
    // No account lookup for web requests, and identical responses for retries.
    return ACCEPTED;
  });
}
