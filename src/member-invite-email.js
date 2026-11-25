import nodemailer from 'nodemailer';
import { interpretSmtpResult } from './support-smtp.js';
import { eveningSlot } from './member-list.js';
import { manilaDay, termFromCode } from './member-perks.js';

const REMINDER_DAYS = 7;
/** The server never handed the message over, so a retry cannot send a second copy. */
const NOT_SENT = new Set(['ECONNECTION', 'ECONNREFUSED', 'EDNS', 'ENOTFOUND', 'EAUTH']);

export function memberInviteMessage({ label, term, kind, expiresAt }) {
  const subject = kind === 'invite' ? `${label} added you as a member on GRIDGO` : `Reminder: confirm your ${label} membership on GRIDGO`;
  return { subject, text: [
    `${label} put you on its ${termFromCode(term).label} member list.`, '',
    'To confirm, open the GRIDGO app and sign in with this email address. You will see one card: tap Confirm, or tap Not me.', '',
    `You are not a member until you confirm. ${kind === 'invite' ? 'We send this invite once, with one reminder at most.' : 'This is the only reminder.'}`,
    `If this is not you, ignore this email. GRIDGO deletes this address from the list by ${manilaDay(expiresAt)}.`,
  ].join('\n') };
}

/**
 * Durable invite queue: one invite, then at most one reminder, 18:00 to 20:00
 * Manila only. The address is read from the open entry at send time and stored
 * nowhere else. A send whose outcome is unknown is never repeated.
 */
export function createMemberInviteWorker({ database, env = process.env, createTransport = nodemailer.createTransport, clock = () => new Date().toISOString(), id }) {
  const transport = env.EMAIL_USER && env.EMAIL_PASSWORD ? createTransport({ service: 'gmail', auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASSWORD },
    connectionTimeout: 10000, socketTimeout: 15000 }) : null;
  const write = fn => database.transaction(fn, { lockKey: 'gridgo-member-invites' });
  let busy = false;
  return async () => {
    if (busy || !transport) return;
    busy = true;
    try {
      for (let n = 0; n < 20; n++) {
        const at = clock();
        if (eveningSlot(at) !== new Date(at).toISOString()) break;
        const due = await database.query("SELECT 1 FROM member_invite_outbox WHERE status = 'pending' AND next_at <= $1 LIMIT 1", [at]);
        if (!due.rowCount) break;
        const row = await write(async () => (await database.query(`UPDATE member_invite_outbox o SET status = 'sending', attempts = attempts + 1
          FROM member_list_entries e JOIN organization_partners p ON p.user_id = e.organization_user_id
          WHERE e.id = o.entry_id AND o.id = (SELECT q.id FROM member_invite_outbox q JOIN member_list_entries open ON open.id = q.entry_id
              JOIN organization_partners live ON live.user_id = open.organization_user_id AND live.status = 'active'
            WHERE q.status = 'pending' AND q.next_at <= $1 AND open.status = 'open' AND open.expires_at > $1 AND open.matched_client_id IS NULL
            ORDER BY q.next_at, q.id LIMIT 1)
          RETURNING o.id, o.entry_id, o.kind, o.attempts, e.contact, e.term, e.expires_at, p.label`, [at])).rows[0]);
        if (!row) break;
        const message = memberInviteMessage({ label: row.label, term: row.term, kind: row.kind, expiresAt: row.expires_at });
        let status = 'failed';
        try {
          if (interpretSmtpResult(await transport.sendMail({ from: env.EMAIL_USER, to: row.contact, ...message, messageId: `<${row.id}@gridgo.members>` })).sent) status = 'sent';
        } catch (error) { if (NOT_SENT.has(error?.code) && row.attempts < 3) status = 'pending'; }
        await write(async () => {
          await database.query('UPDATE member_invite_outbox SET status = $2, next_at = $3 WHERE id = $1', [row.id, status, status === 'pending' ? eveningSlot(clock(), 1) : at]);
          const reminderAt = eveningSlot(at, REMINDER_DAYS);
          if (status === 'sent' && row.kind === 'invite' && Date.parse(reminderAt) < Date.parse(row.expires_at)) {
            await database.query(`INSERT INTO member_invite_outbox (id, entry_id, kind, status, next_at, created_at)
              VALUES ($1,$2,'reminder','pending',$3,$4) ON CONFLICT (entry_id, kind) DO NOTHING`, [id('mlm'), row.entry_id, reminderAt, at]);
          }
        });
      }
    } finally { busy = false; }
  };
}
