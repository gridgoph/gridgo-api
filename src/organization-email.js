import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { applicationError as fail } from './client-applications.js';

export function createOrganizationMailer(env = process.env) {
  const configured = Boolean(env.EMAIL_USER && env.EMAIL_PASSWORD);
  const transport = configured ? nodemailer.createTransport({ service: 'gmail',
    auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASSWORD }, connectionTimeout: 10000, socketTimeout: 15000 }) : null;
  return {
    configured,
    async sendCode(email, code) {
      if (!transport) fail(503, 'organization_email_not_configured');
      try {
        const result = await transport.sendMail({ from: env.EMAIL_USER, to: email,
          subject: 'GRIDGO organization email verification',
          text: `Your GRIDGO verification code is ${code}. It expires in 10 minutes. If you did not request it, ignore this message.` });
        if (!result.accepted?.length || result.rejected?.length) fail(503, 'organization_email_delivery_failed');
      } catch { fail(503, 'organization_email_delivery_failed'); }
    },
  };
}
const digest = (secret, challenge, code) => crypto.createHmac('sha256', secret)
  .update(`${challenge.userId}:${challenge.nonce}:${challenge.email}:${code}`).digest('hex');
export async function requestOrganizationCode({ store, user, body, at, mailer, secret }) {
  if (!secret || !mailer.configured) fail(503, 'organization_email_not_configured');
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email !== String(user.email || '').toLowerCase()) fail(400, 'organization_login_email_required');
  store.organizationEmailChallenges ||= [];
  const previous = store.organizationEmailChallenges.find((row) => row.userId === user.id);
  if (previous && Date.parse(at) - Date.parse(previous.sentAt) < 60000) fail(429, 'organization_code_rate_limited');
  const withinHour = previous && Date.parse(at) - Date.parse(previous.windowStartedAt) < 3600000;
  if (withinHour && previous.sendCount >= 5) fail(429, 'organization_code_rate_limited');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const challenge = { userId: user.id, email, nonce: crypto.randomBytes(24).toString('hex'), sentAt: at,
    expiresAt: new Date(Date.parse(at) + 600000).toISOString(), attempts: 0,
    windowStartedAt: withinHour ? previous.windowStartedAt : at, sendCount: withinHour ? previous.sendCount + 1 : 1 };
  challenge.codeHash = digest(secret, challenge, code);
  await mailer.sendCode(email, code);
  if (previous) Object.assign(previous, { verifiedAt: null, consumedAt: null }, challenge);
  else store.organizationEmailChallenges.push(challenge);
  return { expiresAt: challenge.expiresAt, resendAfter: new Date(Date.parse(at) + 60000).toISOString() };
}
// Return errors instead of throwing so failed attempt counters commit atomically.
export function verifyOrganizationCode({ store, user, body, at, secret }) {
  const challenge = (store.organizationEmailChallenges || []).find((row) => row.userId === user.id);
  const invalid = () => ({ status: 400, body: { error: 'organization_code_invalid_or_expired' }, mutated: true });
  if (!secret || !challenge || challenge.consumedAt || challenge.verifiedAt || challenge.email !== String(user.email || '').toLowerCase()
    || Date.parse(challenge.expiresAt) <= Date.parse(at) || challenge.attempts >= 5) return invalid();
  challenge.attempts += 1;
  if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)
    || !crypto.timingSafeEqual(Buffer.from(challenge.codeHash, 'hex'), Buffer.from(digest(secret, challenge, body.code), 'hex'))) return invalid();
  challenge.verifiedAt = at;
  delete challenge.codeHash;
  return { status: 200, body: { verified: true, expiresAt: challenge.expiresAt }, mutated: true };
}
