/** Mail is claimed durably, then sent outside every database transaction. */
export function createEarlyAccessEmailWorker({ database, mailer, env = process.env }) {
  let busy = false;
  return async function drain() {
    if (busy || !mailer.configured) return;
    busy = true;
    try {
      for (let n = 0; n < 20; n++) {
        const row = await database.transaction(async () => (await database.query(`
          WITH claimed AS (
            UPDATE early_access_email_outbox SET attempts=attempts+1,next_at=now()+interval '5 minutes'
            WHERE id=(SELECT id FROM early_access_email_outbox WHERE status='pending' AND next_at<=now()
              AND (kind='access' OR $1::boolean) ORDER BY created_at,id LIMIT 1)
            RETURNING *
          ) SELECT c.*,s.email,s.opt_in_url FROM claimed c JOIN early_access_signups s ON s.id=c.signup_id`,
        [Boolean(String(env.EARLY_ACCESS_TEAM_EMAIL || '').trim())])).rows[0]);
        if (!row) break;
        const team = row.kind === 'team';
        let sent = false;
        try {
          sent = Boolean((await mailer.sendEarlyAccessEmail({
            to: team ? env.EARLY_ACCESS_TEAM_EMAIL.trim() : row.email,
            subject: team ? `New tester: ${row.email}` : "You're in — GRIDGO Google Play Early Access",
            text: team ? `New tester: ${row.email}\n\nReview their Google Play tester-group membership, then grant access in the GRIDGO early-access list.`
              : `You're in!\n\nYour Google Play invite is ready. Open this link with the Google account you signed up with:\n${row.opt_in_url}\n\nKeep the app for 14 days. Thank you for helping GRIDGO launch!`,
            messageId: `<${row.id}@gridgo.early-access>`,
          })).sent);
        } catch { /* No SMTP errors or addresses in logs. Retry from the durable queue. */ }
        await database.transaction(() => database.query(`UPDATE early_access_email_outbox SET status=$2,
          next_at=now()+interval '5 minutes' WHERE id=$1 AND attempts=$3`,
        [row.id, sent ? 'sent' : row.attempts >= 8 ? 'failed' : 'pending', row.attempts]));
      }
    } finally { busy = false; }
  };
}
