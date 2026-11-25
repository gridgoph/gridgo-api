import { createHash, createHmac } from 'node:crypto';
import { memberFail as fail, manilaDay, schoolYear } from './member-perks.js';
import { philippineMobileNumber } from './phone.js';

// List contacts are read and written only here, inside the caller's domain
// transaction. They never enter the domain store, the audit log or an inbox row.
export const LIST_ROW_LIMIT = 500;
export const LIST_DAILY_ROW_LIMIT = 2000;
const LIST_DAYS = 30;
const DAY_MS = 86400000;
const MANILA_MS = 8 * 3600000;

export function parseMemberSince(value, at) {
  const text = typeof value === 'string' ? value.trim() : '';
  const iso = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text), us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const day = iso ? `${iso[1]}-${iso[2]}-${iso[3] || '01'}` : us ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : null;
  if (!day || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return null;
  return day >= '1950-01-01' && day <= manilaDay(at) ? day : null;
}
// A plain addr-spec only: no groups, comments, quotes, literals or lists a mail parser could read differently.
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
export function parseContact(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.includes('@')) return text.length <= 254 && EMAIL.test(text) ? { kind: 'email', contact: text.toLowerCase() } : null;
  try { return { kind: 'mobile', contact: philippineMobileNumber(text) }; } catch { return null; }
}

const HEADERS = new Map([['name', 'name'], ['email or mobile', 'contact'], ['email', 'contact'], ['mobile', 'contact'], ['contact', 'contact'],
  ['member since', 'memberSince'], ['membersince', 'memberSince']]);
/** RFC 4180 rows with the three columns Name, Email or mobile, Member since, in any order. */
export function parseMemberCsv(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 512 * 1024) fail(413, 'member_list_too_large');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i <= source.length; i++) {
    const ch = source[i] ?? '\n';
    if (quoted && i < source.length) { if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') { quoted = false; closed = true; } else cell += ch; continue; }
    if (ch === '"' && !cell && !closed) { quoted = true; continue; }
    if (closed && ![',', '\r', '\n'].includes(ch)) fail(400, 'invalid_member_csv');
    if (ch === ',' || ch === '\n') { row.push(cell.trim()); cell = ''; closed = false; if (ch === '\n') { if (row.some(Boolean)) rows.push(row); row = []; } }
    else if (ch !== '\r') cell += ch;
  }
  if (quoted) fail(400, 'invalid_member_csv');
  const header = (rows.shift() || []).map(value => HEADERS.get(value.toLowerCase()));
  if (header.length !== 3 || new Set(header).size !== 3 || header.includes(undefined)) fail(400, 'invalid_member_csv_header');
  return rows.map(values => Object.fromEntries(header.map((field, index) => [field, values[index] ?? ''])));
}
function inputRows(body) {
  const rows = typeof body.csv === 'string' ? parseMemberCsv(body.csv) : body.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > LIST_ROW_LIMIT) fail(400, 'invalid_member_list', `Send 1 to ${LIST_ROW_LIMIT} rows.`);
  return rows;
}
/** A keyed fingerprint outlives the redacted contact until the term ends, only so nobody is invited twice. */
export function contactKey(contact, organizationUserId, term, secret) {
  const key = createHash('sha256').update(`gridgo-member-list:${secret || ''}`).digest();
  return createHmac('sha256', key).update(`${organizationUserId}\n${term}\n${contact}`).digest('hex');
}

/** Durable per-organization limit across checks and saves. */
async function spendListRows(database, organizationUserId, count, at) {
  const day = manilaDay(at);
  const { rows } = await database.query(`INSERT INTO member_list_usage AS u (organization_user_id, day, rows) VALUES ($1, $2, $3)
    ON CONFLICT (organization_user_id, day) DO UPDATE SET rows = u.rows + excluded.rows
      WHERE u.rows + excluded.rows <= $4 RETURNING rows`, [organizationUserId, day, count, LIST_DAILY_ROW_LIMIT]);
  await database.query('DELETE FROM member_list_usage WHERE organization_user_id = $1 AND day < $2::date - 7', [organizationUserId, day]);
  if (!rows.length || rows[0].rows > LIST_DAILY_ROW_LIMIT) fail(429, 'member_list_daily_limit', 'The daily member list limit is reached. Try again tomorrow.');
}

async function checkRows(database, partner, body, at, secret) {
  const rows = inputRows(body), term = schoolYear(at), seen = new Set(), fixes = [], valid = [];
  rows.forEach((row, index) => {
    const number = index + 1, problem = (field, code, message) => fixes.push({ row: number, field, code, message });
    if (!row || typeof row !== 'object' || Array.isArray(row)) return problem('name', 'invalid_row', 'Check this row.');
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name || name.length > 120) return problem('name', 'member_name_required', 'Enter the member’s name.');
    const contact = parseContact(row.contact);
    if (!contact) return problem('contact', 'invalid_member_contact', 'Enter a valid email or a Philippine mobile number.');
    const memberSince = parseMemberSince(row.memberSince, at);
    if (!memberSince) return problem('memberSince', 'invalid_member_since', 'Enter the real date they joined, not a future date. Use YYYY-MM-DD.');
    if (seen.has(contact.contact)) return problem('contact', 'duplicate_member_contact', 'This contact is on the list more than once.');
    seen.add(contact.contact);
    valid.push({ name, memberSince, ...contact, key: contactKey(contact.contact, partner.userId, term.code, secret) });
  });
  const listed = new Set(valid.length ? (await database.query(`SELECT contact_key FROM member_list_entries
    WHERE organization_user_id = $1 AND term = $2 AND contact_key = ANY($3::text[])
      AND status IN ('open','dismissed','expired')`, [partner.userId, term.code, valid.map(row => row.key)])).rows.map(row => row.contact_key) : []);
  const fresh = valid.filter(row => !listed.has(row.key));
  const accounts = new Set(fresh.length ? (await database.query(`SELECT lower(u.email) AS contact FROM users u
    JOIN user_role_memberships m ON m.user_id = u.id AND m.role = 'client' WHERE lower(u.email) = ANY($1::text[])
    UNION SELECT u.phone FROM users u JOIN user_role_memberships m ON m.user_id = u.id AND m.role = 'client' WHERE u.phone = ANY($2::text[])`,
  [fresh.filter(row => row.kind === 'email').map(row => row.contact), fresh.filter(row => row.kind === 'mobile').map(row => row.contact)])).rows.map(row => row.contact) : []);
  // A row taken off the list and added again never earns a second email.
  const invited = new Set(fresh.length ? (await database.query(`SELECT e.contact_key FROM member_list_entries e JOIN member_invite_outbox o ON o.entry_id = e.id
    WHERE e.organization_user_id = $1 AND e.term = $2 AND e.contact_key = ANY($3::text[])`, [partner.userId, term.code, fresh.map(row => row.key)])).rows.map(row => row.contact_key) : []);
  for (const row of fresh) Object.assign(row, { hasAccount: accounts.has(row.contact), invited: invited.has(row.key) });
  return { rows, term, fixes, valid, fresh };
}
/**
 * Counts what was typed, never who has an account: a list padded with contacts the
 * officer already knows would turn any account count, however rounded, into a lookup.
 */
function checkResult({ rows, fixes, valid, fresh }) {
  return { rowCount: rows.length, readyCount: fresh.length, alreadyListedCount: valid.length - fresh.length, needsFixCount: fixes.length, needsFix: fixes,
    // Email rows match in the app, or get the one invite. Mobile rows get no message: they match in the app or use the QR or link.
    emailCount: fresh.filter(row => row.kind === 'email').length, mobileCount: fresh.filter(row => row.kind === 'mobile').length };
}
export async function checkMemberList(database, partner, body, { at, secret }) {
  const rows = inputRows(body);
  await spendListRows(database, partner.userId, rows.length, at);
  return checkResult(await checkRows(database, partner, body, at, secret));
}

/** 18:00 to 20:00 Manila. Returns the moment to send: now inside the window, else the next 18:00. */
export function eveningSlot(at, addDays = 0) {
  const now = Date.parse(at) + addDays * DAY_MS;
  const local = new Date(now + MANILA_MS), hour = local.getUTCHours();
  if (!addDays && hour >= 18 && hour < 20) return new Date(now).toISOString();
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + (addDays || hour < 18 ? 0 : DAY_MS);
  return new Date(day + 18 * 3600000 - MANILA_MS).toISOString();
}

export async function saveMemberList(database, partner, body, { at, id, secret }) {
  if (body.consent !== true) fail(400, 'member_list_consent_required', 'Confirm that these members agreed to share their contact for this invite.');
  const checked = await checkRows(database, partner, body, at, secret);
  await spendListRows(database, partner.userId, checked.rows.length, at);
  const expiresAt = new Date(Math.min(Date.parse(at) + LIST_DAYS * DAY_MS, Date.parse(checked.term.endsAt))).toISOString();
  for (const row of checked.fresh) {
    const entryId = id('mle');
    await database.query(`INSERT INTO member_list_entries (id, organization_user_id, term, status, name, contact_kind, contact, contact_key, member_since, expires_at, created_at)
      VALUES ($1,$2,$3,'open',$4,$5,$6,$7,$8,$9,$10)`, [entryId, partner.userId, checked.term.code, row.name, row.kind, row.contact, row.key, row.memberSince, expiresAt, at]);
    const sendAt = eveningSlot(at);
    if (row.kind === 'email' && !row.hasAccount && !row.invited && Date.parse(sendAt) < Date.parse(expiresAt)) {
      await database.query(`INSERT INTO member_invite_outbox (id, entry_id, kind, status, next_at, created_at) VALUES ($1,$2,'invite','pending',$3,$4)`, [id('mlm'), entryId, sendAt, at]);
    }
  }
  return { ...checkResult(checked), savedCount: checked.fresh.length, expiresAt: checked.fresh.length ? expiresAt : null };
}

const publicEntry = row => ({ id: row.id, name: row.name, contactKind: row.contact_kind, contact: row.contact, memberSince: row.member_since,
  term: row.term, status: 'waiting', expiresAt: row.expires_at, createdAt: row.created_at });
export async function listOpenEntries(database, organizationUserId, at, after = '') {
  const { rows } = await database.query(`SELECT * FROM member_list_entries WHERE organization_user_id = $1 AND status = 'open' AND expires_at > $2 AND id > $3
    ORDER BY id LIMIT 101`, [organizationUserId, at, after]);
  const counts = (await database.query(`SELECT status, count(*)::int AS count FROM member_list_entries WHERE organization_user_id = $1 GROUP BY status`, [organizationUserId])).rows;
  return { entries: rows.slice(0, 100).map(publicEntry), nextCursor: rows.length > 100 ? rows[99].id : null,
    counts: Object.fromEntries(['open', 'accepted', 'dismissed', 'expired', 'removed'].map(status => [status === 'open' ? 'waiting' : status, counts.find(row => row.status === status)?.count ?? 0])) };
}
const CLOSE = "status = $2, contact = NULL, name = NULL, matched_client_id = CASE WHEN $2 = 'removed' THEN NULL ELSE matched_client_id END, closed_at = $3";
/** Closing is redaction: the contact and the typed name go in the same statement. */
async function closeEntries(database, where, status, at, values) {
  return (await database.query(`UPDATE member_list_entries SET ${CLOSE} WHERE status = 'open' AND ${where} RETURNING id`, [values[0], status, at, ...values.slice(1)])).rowCount;
}
export const removeEntry = (database, organizationUserId, entryId, at) => closeEntries(database, 'organization_user_id = $1 AND id = $4', 'removed', at, [organizationUserId, entryId]);
export const closeOrganizationEntries = (database, organizationUserId, at) => closeEntries(database, 'organization_user_id = $1', 'removed', at, [organizationUserId]);
export const closeClientEntries = (database, organizationUserId, clientId, status, at) => closeEntries(database, 'organization_user_id = $1 AND matched_client_id = $4', status, at, [organizationUserId, clientId]);

/** Bind open entries to this signed-in client only through addresses Clerk verified. */
export async function matchEntries(database, clientId, identities, at) {
  const contacts = [...new Set([...identities.email, ...identities.phone])].filter(Boolean);
  if (!contacts.length) return 0;
  return (await database.query(`UPDATE member_list_entries SET matched_client_id = $1 WHERE status = 'open' AND expires_at > $2
    AND contact = ANY($3::text[]) AND organization_user_id <> $1 AND matched_client_id IS DISTINCT FROM $1`, [clientId, at, contacts])).rowCount;
}
export async function matchedEntries(database, clientId, at) {
  return (await database.query(`SELECT * FROM member_list_entries WHERE matched_client_id = $1 AND status = 'open' AND expires_at > $2 ORDER BY created_at, id`, [clientId, at])).rows;
}

export async function memberListWorkDue(database, at) {
  return (await database.query(`SELECT 1 FROM member_list_entries WHERE status = 'open' AND expires_at <= $1
    UNION ALL SELECT 1 FROM member_list_entries WHERE contact_key IS NOT NULL AND term < $2
    UNION ALL SELECT 1 FROM organization_memberships WHERE status IN ('pending','active') AND term_ends_at <= $1 LIMIT 1`, [at, schoolYear(at).code])).rowCount > 0;
}
export async function sweepMemberList(database, at) {
  await database.query(`UPDATE member_list_entries SET status = 'expired', contact = NULL, name = NULL, closed_at = $1 WHERE status = 'open' AND expires_at <= $1`, [at]);
  await database.query(`UPDATE member_list_entries SET contact_key = NULL, matched_client_id = NULL WHERE contact_key IS NOT NULL AND term < $1`, [schoolYear(at).code]);
}
