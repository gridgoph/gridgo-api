/** Mail is claimed durably, then sent outside every database transaction. */
export function createEarlyAccessEmailWorker({ database, mailer, env = process.env }) {
  let busy = false;
  return async function drain() {
    if (busy || !mailer.configured) return;
    busy = true;
    try {
      for (let n = 0; n < 20; n++) {
        const row = await database.transaction(async () => {
          // The domain advisory lock serializes claims and budget debits across
          // replicas. Read the UTC day after acquiring it, even across midnight.
          // Failed attempts/retries consume the same allowance to bound SMTP load.
          const claimed = (await database.query(`
            WITH budget_clock AS MATERIALIZED (
              SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date AS budget_day
            ), claimed AS (
              UPDATE early_access_email_outbox SET attempts=attempts+1,next_at=clock_timestamp()+interval '5 minutes'
              WHERE id=(SELECT id FROM early_access_email_outbox WHERE status='pending' AND next_at<=clock_timestamp()
                AND (kind='access' OR ($1::boolean AND COALESCE(
                  (SELECT attempts FROM early_access_team_mail_budget
                    WHERE budget_day=(SELECT budget_day FROM budget_clock)),0) < 100))
                ORDER BY CASE WHEN kind='access' THEN 0 ELSE 1 END,created_at,id LIMIT 1)
              RETURNING *
            ) SELECT c.*,s.email,s.opt_in_url,(SELECT budget_day FROM budget_clock) AS budget_day
              FROM claimed c JOIN early_access_signups s ON s.id=c.signup_id`,
          [Boolean(String(env.EARLY_ACCESS_TEAM_EMAIL || '').trim())])).rows[0];
          if (claimed?.kind === 'team') await database.query(`
            INSERT INTO early_access_team_mail_budget(budget_day,attempts) VALUES($1,1)
            ON CONFLICT(budget_day) DO UPDATE SET attempts=early_access_team_mail_budget.attempts+1`, [claimed.budget_day]);
          return claimed;
        });
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
