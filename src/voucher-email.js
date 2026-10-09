import nodemailer from 'nodemailer';
import { interpretSmtpResult } from './support-smtp.js';

/** Durable retry queue; provider I/O happens after the claim transaction commits. */
export function createVoucherEmailWorker({ database, env = process.env, createTransport = nodemailer.createTransport, clock = () => new Date().toISOString() }) {
  const transport = env.EMAIL_USER && env.EMAIL_PASSWORD ? createTransport({ service: 'gmail', auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASSWORD },
    connectionTimeout: 10000, socketTimeout: 15000 }) : null;
  let busy = false;
  return async () => {
    if (busy || !transport) return;
    busy = true;
    try {
      for (let n = 0; n < 20; n++) {
        const at = clock();
        const row = await database.transaction(async () => {
          const result = await database.query(`UPDATE voucher_email_outbox SET attempts=attempts+1, next_at=$1::timestamptz + interval '5 minutes'
            WHERE id=(SELECT e.id FROM voucher_email_outbox e JOIN vouchers v ON v.id=e.voucher_id
              WHERE e.status='pending' AND e.next_at <= $1 AND v.email_allowed=true AND v.status='available' AND v.expires_at > $1
              ORDER BY e.created_at LIMIT 1) RETURNING *`, [at]);
          return result.rows[0];
        });
        if (!row) break;
        let sent = false;
        try {
          sent = interpretSmtpResult(await transport.sendMail({ from: env.EMAIL_USER, to: row.email,
            subject: row.subject, text: row.body, messageId: `<${row.id}@gridgo.vouchers>` })).sent;
        } catch { /* Retried without failing the issuing transaction. */ }
        await database.transaction(() => database.query(`UPDATE voucher_email_outbox SET status=$2,
          next_at=$3::timestamptz + interval '15 minutes' WHERE id=$1 AND attempts=$4`,
        [row.id, sent ? 'sent' : row.attempts >= 8 ? 'failed' : 'pending', clock(), row.attempts]));
      }
    } finally { busy = false; }
  };
}
