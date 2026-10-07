import { randomUUID } from 'node:crypto';
import { authorizationContextFor, contextHasMembership } from './authorization-context.js';
import { requestClientKey, tooManyRequests } from './support-rate-limit.js';

const ACCEPTED = { status: 202, body: { ok: true, message: 'We will delete your account within 30 days' } };
const failure = (status, error) => ({ status, body: { error } });
const project = (row) => ({
  id: row.id, userId: row.user_id, contactEmail: row.contact_email, source: row.source,
  status: row.status, requestedAt: row.requested_at, dueAt: row.due_at,
  completedAt: row.completed_at, completedBy: row.completed_by,
});

// This records a request only. Operations must verify web ownership and complete
// the deletion separately before recording completion here.
export async function routeAccountDeletion({ req, url, user, database, readBody, onEvent }) {
  const path = url.pathname;
  const app = path === '/me/account-deletion-request';
  const web = path === '/account-deletion-requests';
  const staff = path === '/ops/account-deletion-requests' || path.startsWith('/ops/account-deletion-requests/');
  if (!app && !web && !staff) return null;
  if (!web && !user) return failure(401, 'unauthorized');
  if (staff) {
    const context = authorizationContextFor(user);
    if (!contextHasMembership(context, 'ops_admin') && !contextHasMembership(context, 'super_admin')) return failure(403, 'forbidden');
    if (req.method === 'GET' && path === '/ops/account-deletion-requests') {
      const status = url.searchParams.get('status') || 'pending';
      if (!['pending', 'done'].includes(status)) return failure(400, 'invalid_status');
      const offset = Number(url.searchParams.get('offset') || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) return failure(400, 'invalid_offset');
      const result = await database.query('SELECT * FROM account_deletion_requests WHERE status=$1 ORDER BY requested_at, id LIMIT 101 OFFSET $2', [status, offset]);
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
