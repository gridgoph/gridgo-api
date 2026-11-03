import { createHash } from 'node:crypto';

/**
 * Observe a verified session once. The database method uses its own bounded
 * autocommit connection even when called inside a request transaction. Failed
 * or skipped attempts leave no marker, so a later request can retry.
 */
export async function recordUserSignIn(database, userId, sessionId, at) {
  if (!userId || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 1024) return false;
  if (!Number.isFinite(Date.parse(at))) return false;
  const sessionHash = createHash('sha256').update(sessionId).digest('hex');
  try {
    const result = await database.recordLastAuthenticated(userId, at, sessionHash);
    return result.rowCount > 0;
  } catch (error) {
    console.warn(`Last authenticated write failed: ${error?.code || 'unknown'}`);
    return false;
  }
}

/**
 * Only GRIDGO's durable sign-in evidence can supply historical observations.
 * Account creation, other audit actions and provider lookups are not sign-ins.
 * Future/nonfinite audit times are ignored. No audit row is modified.
 */
export async function backfillLastSignIns(database) {
  return database.transaction(async () => {
    await database.query(`
      INSERT INTO user_sign_in_sessions (user_id, session_hash, authenticated_at)
      SELECT a.actor_id, a.data->'detail'->>'sessionHash', MIN(a.at)
        FROM audit_log a JOIN users u ON u.id = a.actor_id
       WHERE a.action = 'staff.sign_in' AND a.at > 'epoch'::timestamptz AND a.at <= CURRENT_TIMESTAMP
         AND a.data->'detail'->>'sessionHash' ~ '^[0-9a-f]{64}$'
       GROUP BY a.actor_id, a.data->'detail'->>'sessionHash'
      ON CONFLICT (user_id, session_hash) DO NOTHING
    `);
    const result = await database.query(`
      WITH evidence AS (
        SELECT actor_id, MAX(at) AS at FROM audit_log
         WHERE action = 'staff.sign_in' AND at > 'epoch'::timestamptz AND at <= CURRENT_TIMESTAMP
         GROUP BY actor_id
      )
      UPDATE users u SET last_authenticated_at = e.at FROM evidence e
       WHERE u.id = e.actor_id AND (u.last_authenticated_at IS NULL OR u.last_authenticated_at < e.at)
    `);
    return { updated: result.rowCount };
  });
}
