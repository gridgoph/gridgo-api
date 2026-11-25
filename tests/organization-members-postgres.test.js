import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { checkoutFixture, liveCheckoutDeadline } from './helpers/promotion-checkout.mjs';
import { addPartner, addMember, setPerk } from './fixtures/organization-members.js';
import { AT, id } from './fixtures/reschedule.js';
import { schoolYear, selectMemberPerk, reserveMemberPerk } from '../src/member-perks.js';
import { sweepMembers } from '../src/organization-members.js';
import { createMemberInviteWorker } from '../src/member-invite-email.js';
import { eveningSlot, saveMemberList } from '../src/member-list.js';
import { createPayoutMilestones } from '../src/operational-model.js';
import { up, down } from '../migrations/1795622400000_organization_members.js';

const DB = process.env.DATABASE_URL, skip = !DB;
const NOW = () => new Date().toISOString();
const term = schoolYear(NOW());
const PERK = { endsAt: new Date(Date.now() + 60 * 86400000).toISOString() };
const person = (store, key, extra = {}) => {
  store.users.push({ id: key, role: 'client', email: `${key}@example.invalid`, name: `Person ${key}`, clerkUserId: `clerk_${key}`, accountType: 'individual', createdAt: AT, ...extra });
  store.userRoleMemberships.push({ userId: key, role: 'client', createdAt: AT });
  store.clientProfiles.push({ userId: key, clientKind: 'personal', updatedAt: AT });
};
async function setup(t, change = () => {}, { env = {}, server = true } = {}) {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, voucher_campaigns, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = checkoutFixture(); store.vouchers = []; store.voucherLedger = []; store.voucherCampaigns = [];
  for (const key of ['member', 'second', 'phone', 'unverified']) person(store, key);
  addPartner(store, { at: AT });
  change(store);
  await db.transaction(() => saveStore(db, store));
  if (!server) return { db, store };
  const clerk = http.createServer((req, res) => {
    const subject = /^\/v1\/users\/([^/?]+)/.exec(req.url)?.[1], name = subject?.replace('clerk_', '');
    if (!subject || name === 'second') { res.writeHead(500); res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ object: 'user', id: subject, first_name: name, last_name: 'Person', username: null, primary_email_address_id: `email_${name}`, primary_phone_number_id: null,
      email_addresses: name === 'phone' ? [] : [{ object: 'email_address', id: `email_${name}`, email_address: `${name.toUpperCase()}@example.invalid`, verification: { status: name === 'unverified' ? 'unverified' : 'verified' }, linked_to: [] }],
      phone_numbers: name === 'phone' ? [{ object: 'phone_number', id: 'phone_1', phone_number: '+639171234567', verification: { status: 'verified' }, linked_to: [] }] : [],
      external_accounts: [], web3_wallets: [], public_metadata: {}, private_metadata: {}, unsafe_metadata: {}, created_at: 0, updated_at: 0 }));
  });
  await new Promise(resolve => clerk.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => clerk.close(resolve)));
  const api = await apiForTest(t, { CLERK_API_URL: `http://127.0.0.1:${clerk.address().port}`, ...env });
  return { db, store, api };
}
async function mutate(db, action) { return db.transaction(async () => { const s = await loadStore(db); const result = await action(s); await saveStore(db, s); return result; }); }
async function ok(api, user, method, path, body, expected = 200, opts) {
  const result = await api(user, method, path, body, opts);
  assert.equal(result.status, expected, `${method} ${path}: ${JSON.stringify(result.body).slice(0, 400)}`);
  return result.body;
}
async function refused(api, user, method, path, body, status, error) {
  const result = await api(user, method, path, body);
  assert.deepEqual([result.status, result.body.error], [status, error], `${method} ${path}: ${JSON.stringify(result.body).slice(0, 400)}`);
  return result.body;
}
const inviteToken = async api => (await ok(api, 'org', 'POST', '/me/organization/members/invite', {})).invite.token;
async function cart(api, store, user = 'client', quantity = 5) {
  const made = await ok(api, user, 'POST', '/me/carts', { fulfillmentMode: 'delivery', defaultDropoff: store.orders[0].dropoff }, 201);
  const path = `/me/carts/${made.cart.id}`;
  await ok(api, user, 'POST', `${path}/lines`, { catalogItemId: 'item_supplier', quantity, optionIds: [], artworkFileId: user === 'client' ? 'artwork' : `artwork_${user}`, deadline: liveCheckoutDeadline() }, 201);
  return path;
}
const pay = (reference, extra = {}, proof = 'receipt') => ({ payment: { method: 'qr_manual', reference, proofFileId: proof }, ...extra });
async function settleCancellation(api, orderId, { clientCaused = false, totalMinor = 0 } = {}) {
  let { refund } = await ok(api, 'client', 'POST', `/orders/${orderId}/refund-requests`, { kind: 'cancellation', reason: 'Order cannot continue',
    ...(totalMinor ? { destination: { provider: 'bank', accountName: 'Client', qrFileId: 'refundQr', ownershipConfirmed: true } } : {}) }, 201);
  ({ refund } = await ok(api, 'ops', 'POST', `/refund-requests/${refund.id}/review`, { expectedVersion: refund.version, reason: 'Reviewed the order', ...(totalMinor ? { destinationVerified: true } : {}) }));
  ({ refund } = await ok(api, 'ops', 'POST', `/refund-requests/${refund.id}/settle`, { expectedVersion: refund.version, reason: 'Agreed cancellation', workStopped: true, clientCaused,
    shopAgreement: 'Nothing owed', deliveryEvidence: 'No delivery performed', shopEntitlementMinor: 0, riderEntitlementMinor: 0, totalMinor }));
  if (!totalMinor) return;
  ({ refund } = await ok(api, 'ops', 'POST', `/refund-requests/${refund.id}/payment-attempts`, { expectedVersion: refund.version, reason: 'Return client cash', destinationVerified: true, destinationRevision: 1, provider: 'bank', sourceWallet: 'ops-main' }));
  await ok(api, 'ops', 'POST', `/refund-requests/${refund.id}/payments`, { expectedVersion: refund.version, reason: 'Transfer completed', attemptId: refund.attempt.id, amountMinor: totalMinor, reference: 'MEMBER-REFUND', receiptFileId: 'refundReceipt', paidAt: AT });
}
const rows = async (db, table, where = 'true') => (await db.query(`SELECT * FROM ${table} WHERE ${where}`)).rows;

test('joining by QR or link makes a request; the officer approves with the real date or declines; the client may cancel or leave', { skip }, async t => {
  const { db, api } = await setup(t, store => setPerk(store, null, PERK, AT));
  assert.equal((await ok(api, 'org', 'GET', '/me/organization/members/invite')).invite, null);
  const token = await inviteToken(api);
  assert.ok(token.length >= 32); assert.equal(await inviteToken(api), token);
  const shown = (await ok(api, 'member', 'POST', '/me/memberships/preview', { token })).invite;
  assert.deepEqual([shown.label, shown.membershipStatus, shown.term.code, shown.perk.amountMinor], ['Sample Guild member', null, term.code, 1000]);
  await refused(api, 'member', 'POST', '/me/memberships', { token, source: 'list' }, 400, 'invalid_member_source');
  const { membership } = await ok(api, 'member', 'POST', '/me/memberships', { token, source: 'qr' }, 201);
  assert.deepEqual([membership.status, membership.memberSince, membership.term.endsOn], ['pending', null, term.endsOn]);
  // Asking twice is one request.
  assert.equal((await ok(api, 'member', 'POST', '/me/memberships', { token, source: 'link' })).membership.id, membership.id);
  const request = (await ok(api, 'org', 'GET', '/me/organization/members/requests')).requests[0];
  assert.deepEqual([request.id, request.name, request.source], [membership.id, 'Person member', 'qr']);
  assert.doesNotMatch(JSON.stringify(request), /example\.invalid|clientId/);
  assert.equal((await ok(api, 'org', 'GET', '/me/organization/members/summary')).requestCount, 1);
  for (const memberSince of [undefined, '', '2999-01-01', '2024-02-30', 'today']) await refused(api, 'org', 'POST', `/me/organization/members/${membership.id}/approve`, { expectedVersion: 1, memberSince }, 400, 'invalid_member_since');
  await refused(api, 'org', 'POST', `/me/organization/members/${membership.id}/approve`, { expectedVersion: 9, memberSince: '2024-08-10' }, 409, 'membership_stale');
  await refused(api, 'org', 'POST', `/me/organization/members/${membership.id}/approve`, { expectedVersion: 1, memberSince: '2024-08-10', term: '2020-21' }, 400, 'invalid_member_term');
  const { member } = await ok(api, 'org', 'POST', `/me/organization/members/${membership.id}/approve`, { expectedVersion: 1, memberSince: '2024-08-10', term: term.code });
  assert.deepEqual([member.status, member.memberSince, member.termsCount, member.perksUsed, member.perksPerTerm], ['active', '2024-08-10', 1, 0, 5]);
  await refused(api, 'org', 'POST', `/me/organization/members/${membership.id}/approve`, { expectedVersion: 2, memberSince: '2024-08-10' }, 409, 'membership_not_pending');
  const mine = (await ok(api, 'member', 'GET', '/me/memberships')).memberships[0];
  assert.deepEqual([mine.status, mine.label, mine.perk.left, mine.perk.used, mine.totalSavedMinor], ['active', 'Sample Guild member', 5, 0, 0]);
  const edited = (await ok(api, 'org', 'PATCH', `/me/organization/members/${membership.id}`, { expectedVersion: 2, memberSince: '2023-07-01' })).member;
  assert.equal(edited.memberSince, '2023-07-01');
  assert.equal((await ok(api, 'org', 'GET', '/me/organization/members?q=PERSON%20mem')).total, 1);
  assert.equal((await ok(api, 'org', 'GET', '/me/organization/members?filter=ordered')).total, 0);
  assert.equal((await ok(api, 'org', 'GET', '/me/organization/members?filter=not_ordered')).total, 1);
  // Cancel, decline, leave, remove and ask again all reuse the one row.
  const other = (await ok(api, 'second', 'POST', '/me/memberships', { token, source: 'link' }, 201)).membership;
  assert.equal((await ok(api, 'second', 'DELETE', `/me/memberships/${other.id}`)).membership.removedReason, 'request_cancelled');
  assert.equal((await ok(api, 'second', 'POST', '/me/memberships', { token, source: 'link' }, 201)).membership.id, other.id);
  const again = (await ok(api, 'org', 'GET', '/me/organization/members/requests')).requests[0];
  await ok(api, 'org', 'POST', `/me/organization/members/${other.id}/decline`, { expectedVersion: again.version });
  assert.equal((await ok(api, 'second', 'GET', '/me/memberships')).memberships[0].removedReason, 'declined');
  await refused(api, 'second', 'DELETE', `/me/memberships/${membership.id}`, undefined, 404, 'membership_not_found');
  assert.equal((await ok(api, 'member', 'DELETE', `/me/memberships/${membership.id}`)).membership.removedReason, 'left');
  assert.equal((await ok(api, 'org', 'GET', '/me/organization/members?status=all')).total, 0);
  assert.equal((await rows(db, 'organization_memberships')).length, 2);
  const rejoined = (await ok(api, 'member', 'POST', '/me/memberships', { token, source: 'link' }, 201)).membership;
  assert.deepEqual([rejoined.id, rejoined.status], [membership.id, 'pending']);
  const actions = (await rows(db, 'audit_log', "action LIKE 'membership.%' OR action LIKE 'member_invite.%'")).map(row => row.action);
  for (const action of ['member_invite.created', 'membership.requested', 'membership.approved', 'membership.date_edited', 'membership.request_cancelled', 'membership.declined', 'membership.left']) assert.ok(actions.includes(action), action);
  // Staff learn that something happened, never to whom.
  const staff = await rows(db, 'notifications', "user_id IN ('ops','admin') AND data::text LIKE '%Organization members%'");
  assert.ok(staff.length); assert.doesNotMatch(JSON.stringify(staff), /Person |example\.invalid/);
});

test('guessing links is limited per account, answers are uniform, and a replaced or past link stops working', { skip }, async t => {
  const { db, api } = await setup(t, store => { addPartner(store, { at: AT, orgId: 'club', label: 'Second Club' }); });
  const token = await inviteToken(api);
  const replaced = (await ok(api, 'org', 'POST', '/me/organization/members/invite', { replace: true })).invite.token;
  assert.notEqual(replaced, token);
  await refused(api, 'member', 'POST', '/me/memberships/preview', { token }, 404, 'member_invite_not_found');
  await refused(api, 'member', 'POST', '/me/memberships/preview', { token: 'x' }, 404, 'member_invite_not_found');
  // The organization cannot join itself and an ended partner's link answers the same way.
  await refused(api, 'org', 'POST', '/me/memberships/preview', { token: replaced }, 404, 'member_invite_not_found');
  const club = (await ok(api, 'club', 'POST', '/me/organization/members/invite', {})).invite.token;
  await db.query("UPDATE organization_partners SET status = 'ended' WHERE user_id = 'club'");
  await refused(api, 'member', 'POST', '/me/memberships', { token: club, source: 'qr' }, 404, 'member_invite_not_found');
  await db.query("UPDATE member_join_links SET term = '2020-21' WHERE organization_user_id = 'org'");
  await refused(api, 'member', 'POST', '/me/memberships', { token: replaced, source: 'qr' }, 404, 'member_invite_not_found');
  // The fifth failure locks the account, even for a good link.
  await refused(api, 'member', 'POST', '/me/memberships/preview', { token: 'y'.repeat(43) }, 429, 'member_join_rate_limited');
  await db.query('UPDATE member_join_links SET term = $1', [term.code]);
  await refused(api, 'member', 'POST', '/me/memberships', { token: replaced, source: 'qr' }, 429, 'member_join_rate_limited');
  assert.equal((await rows(db, 'member_join_attempts', "client_id = 'member'"))[0].failures, 5);
  await db.query("UPDATE member_join_attempts SET locked_until = now() - interval '1 minute', attempts = 20");
  await refused(api, 'member', 'POST', '/me/memberships', { token: replaced, source: 'qr' }, 429, 'member_join_rate_limited');
  await db.query("UPDATE member_join_attempts SET window_at = now() - interval '2 hours'");
  await ok(api, 'member', 'POST', '/me/memberships', { token: replaced, source: 'qr' }, 201);
  await refused(api, null, 'POST', '/me/memberships/preview', { token: replaced }, 401, 'unauthorized');
});

const LIST = `Name,Email or mobile,Member since\r\n"Alpha, One",MEMBER@example.invalid,2024-08-01\r\nBeta,0917 123 4567,08/15/2023\r\nGamma,new.person@example.invalid,2022-06\r\nDelta,unverified@example.invalid,2024-01-02\r\nEpsilon,0918 765 4321,2024-01-02\r\nBad Contact,nobody,2024-01-01\r\nBad Date,ok@example.invalid,2999-01-01\r\nTwice,member@example.invalid,2024-01-01\r\n`;
test('a member list needs consent, checks rows, matches only verified contacts with one tap, and forgets contacts', { skip }, async t => {
  const { db, api } = await setup(t, store => { setPerk(store, null, PERK, AT); addPartner(store, { at: AT, orgId: 'club', label: 'Second Club' }); });
  await refused(api, 'org', 'POST', '/me/organization/members/list', { csv: LIST }, 400, 'member_list_consent_required');
  await refused(api, 'org', 'POST', '/me/organization/members/list/check', { csv: 'a,b\n1,2' }, 400, 'invalid_member_csv_header');
  await refused(api, 'org', 'POST', '/me/organization/members/list', { consent: true, rows: [] }, 400, 'invalid_member_list');
  const { check } = await ok(api, 'org', 'POST', '/me/organization/members/list/check', { csv: LIST });
  assert.deepEqual([check.rowCount, check.readyCount, check.needsFixCount, check.onGridgoCount, check.getsInviteCount, check.mobileOnlyCount], [8, 5, 3, 2, 1, 2]);
  assert.deepEqual(check.needsFix.map(row => [row.row, row.code]), [[6, 'invalid_member_contact'], [7, 'invalid_member_since'], [8, 'duplicate_member_contact']]);
  assert.equal((await rows(db, 'member_list_entries')).length, 0, 'checking stores nothing');
  // A one-row list must not say whether that person has an account.
  const one = (await ok(api, 'org', 'POST', '/me/organization/members/list/check', { rows: [{ name: 'Alpha', contact: 'member@example.invalid', memberSince: '2024-08-01' }] })).check;
  assert.deepEqual([one.countsHidden, one.onGridgoCount, one.getsInviteCount, one.mobileOnlyCount], [true, null, null, null]);
  const { list } = await ok(api, 'org', 'POST', '/me/organization/members/list', { csv: LIST, consent: true }, 201);
  assert.equal(list.savedCount, 5);
  assert.equal((await ok(api, 'org', 'POST', '/me/organization/members/list', { csv: LIST, consent: true }, 201)).list.savedCount, 0);
  assert.deepEqual((await rows(db, 'member_invite_outbox')).map(row => [row.kind, row.status]), [['invite', 'pending']]);
  assert.equal((await rows(db, 'organization_memberships')).length, 0, 'a listed person is not a member');
  assert.doesNotMatch(JSON.stringify([await rows(db, 'audit_log'), await rows(db, 'notifications')]), /Alpha, One|new\.person|9171234567/);
  // Nothing shows until the client asks, and only for verified addresses.
  assert.deepEqual((await ok(api, 'member', 'GET', '/me/memberships')).matches, []);
  assert.deepEqual((await ok(api, 'unverified', 'POST', '/me/memberships/matches')).matches, []);
  await refused(api, 'second', 'POST', '/me/memberships/matches', undefined, 502, 'clerk_unavailable');
  const { matches } = await ok(api, 'member', 'POST', '/me/memberships/matches');
  assert.deepEqual([matches.length, matches[0].label, matches[0].memberSince, matches[0].perk.amountMinor], [1, 'Sample Guild member', '2024-08-01', 1000]);
  assert.doesNotMatch(JSON.stringify(matches), /example\.invalid|Alpha/);
  assert.equal((await ok(api, 'member', 'GET', '/me/memberships')).matches.length, 1);
  const [phoneMatch] = (await ok(api, 'phone', 'POST', '/me/memberships/matches')).matches;
  await refused(api, 'member', 'POST', `/me/memberships/matches/${phoneMatch.id}/confirm`, undefined, 404, 'member_match_not_found');
  await refused(api, 'member', 'POST', `/me/memberships/matches/${phoneMatch.id}/dismiss`, undefined, 404, 'member_match_not_found');
  const { membership } = await ok(api, 'member', 'POST', `/me/memberships/matches/${matches[0].id}/confirm`);
  assert.deepEqual([membership.status, membership.memberSince], ['active', '2024-08-01']);
  await refused(api, 'member', 'POST', `/me/memberships/matches/${matches[0].id}/confirm`, undefined, 404, 'member_match_not_found');
  assert.deepEqual((await ok(api, 'phone', 'POST', `/me/memberships/matches/${phoneMatch.id}/dismiss`)).matches, []);
  assert.deepEqual((await ok(api, 'phone', 'POST', '/me/memberships/matches')).matches, []);
  const closed = await rows(db, 'member_list_entries', "status <> 'open'");
  assert.deepEqual(closed.map(row => row.status).sort(), ['accepted', 'dismissed']);
  for (const row of closed) assert.deepEqual([row.contact, row.name], [null, null]);
  const waiting = await ok(api, 'org', 'GET', '/me/organization/members/list');
  assert.deepEqual([waiting.entries.length, waiting.counts.accepted, waiting.counts.dismissed], [3, 1, 1]);
  // The other officer and every client see none of it.
  assert.equal((await ok(api, 'club', 'GET', '/me/organization/members/list')).entries.length, 0);
  await refused(api, 'club', 'DELETE', `/me/organization/members/list/${waiting.entries[0].id}`, undefined, 404, 'member_list_entry_not_found');
  // Removing and adding the same email again never sends a second invite.
  const gamma = waiting.entries.find(row => row.contact === 'new.person@example.invalid');
  await db.query("UPDATE member_invite_outbox SET status = 'sent'");
  await ok(api, 'org', 'DELETE', `/me/organization/members/list/${gamma.id}`);
  await ok(api, 'org', 'POST', '/me/organization/members/list', { consent: true, rows: [{ name: 'Gamma', contact: 'new.person@example.invalid', memberSince: '2022-06-01' }] }, 201);
  assert.equal((await rows(db, 'member_invite_outbox')).length, 1);
  // A dismissed contact cannot be listed again this term.
  assert.equal((await ok(api, 'org', 'POST', '/me/organization/members/list', { consent: true, rows: [{ name: 'Beta', contact: '+639171234567', memberSince: '2022-06-01' }] }, 201)).list.savedCount, 0);
  await db.query('UPDATE member_list_usage SET rows = 1999');
  await refused(api, 'org', 'POST', '/me/organization/members/list/check', { csv: LIST }, 429, 'member_list_daily_limit');
  await assert.rejects(db.query("UPDATE member_list_entries SET contact = 'kept@example.invalid' WHERE status = 'accepted'"), { code: '23514' });
});

test('invites go out once in the early evening with one reminder at most, and a closed entry stops them', { skip }, async t => {
  const { db, store } = await setup(t, () => {}, { server: false });
  const partner = store.organizationPartners[0], noon = '2026-11-10T04:00:00.000Z';
  assert.equal(eveningSlot(noon), '2026-11-10T10:00:00.000Z');
  assert.equal(eveningSlot('2026-11-10T11:30:00.000Z'), '2026-11-10T11:30:00.000Z');
  assert.equal(eveningSlot('2026-11-10T12:00:00.000Z'), '2026-11-11T10:00:00.000Z');
  await db.transaction(() => saveMemberList(db, partner, { consent: true, rows: [
    { name: 'Alpha', contact: 'alpha@example.invalid', memberSince: '2024-01-01' }, { name: 'Beta', contact: 'beta@example.invalid', memberSince: '2024-01-01' },
    { name: 'Gamma', contact: '09181112222', memberSince: '2024-01-01' }] }, { at: noon, id, secret: 'test' }));
  const sent = []; let at = noon, failWith = null;
  const env = { EMAIL_USER: 'mailer@example.invalid', EMAIL_PASSWORD: 'test' };
  const createTransport = () => ({ sendMail: async message => { if (failWith) throw Object.assign(new Error('mail'), { code: failWith }); sent.push(message); return { accepted: [message.to], rejected: [], messageId: 'm' }; } });
  const run = createMemberInviteWorker({ database: db, env, createTransport, clock: () => at, id });
  await run(); assert.equal(sent.length, 0, 'never before 18:00 Manila');
  at = '2026-11-10T10:05:00.000Z'; await Promise.all([run(), run()]);
  assert.deepEqual(sent.map(row => row.to).sort(), ['alpha@example.invalid', 'beta@example.invalid']);
  assert.match(sent[0].text, /not a member until you confirm/); assert.doesNotMatch(sent[0].text, /Alpha|Beta|perk/i);
  at = '2026-11-11T10:05:00.000Z'; await run(); assert.equal(sent.length, 2);
  // One accepts; only the other is reminded, once.
  await db.query("UPDATE member_list_entries SET status = 'accepted', contact = NULL, name = NULL, closed_at = now() WHERE name = 'Alpha'");
  at = '2026-11-17T10:05:00.000Z'; failWith = 'ECONNREFUSED'; await run();
  at = '2026-11-18T10:05:00.000Z'; failWith = null; await run();
  assert.deepEqual(sent.slice(2).map(row => [row.to, /^Reminder/.test(row.subject)]), [['beta@example.invalid', true]]);
  for (const day of ['19', '25', '26']) { at = `2026-11-${day}T10:05:00.000Z`; await run(); }
  assert.equal(sent.length, 3);
  // An unknown outcome is never sent again, and the address is stored nowhere but the open entry.
  await db.transaction(() => saveMemberList(db, partner, { consent: true, rows: [{ name: 'Delta', contact: 'delta@example.invalid', memberSince: '2024-01-01' }] }, { at: '2026-11-26T04:00:00.000Z', id, secret: 'test' }));
  at = '2026-11-26T10:05:00.000Z'; failWith = 'ETIMEDOUT'; await run(); failWith = null; at = '2026-11-27T10:05:00.000Z'; await run();
  assert.equal(sent.length, 3);
  assert.doesNotMatch(JSON.stringify(await rows(db, 'member_invite_outbox')), /@example/);
  // No mailbox configured: nothing is sent and nothing is lost.
  await createMemberInviteWorker({ database: db, env: {}, clock: () => at, id })();
  // Expiry redacts; the term's end also drops the fingerprint.
  await db.transaction(async () => { const s = await loadStore(db); await sweepMembers(s, db, { at: '2026-12-11T00:00:00.000Z', id }); });
  const beta = (await rows(db, 'member_list_entries', "status = 'expired'"));
  assert.equal(beta.length, 2); for (const row of beta) assert.deepEqual([row.contact, row.name], [null, null]);
  await db.transaction(async () => { const s = await loadStore(db); await sweepMembers(s, db, { at: '2027-06-01T00:00:00.000Z', id }); });
  assert.equal((await rows(db, 'member_list_entries', 'contact IS NOT NULL OR contact_key IS NOT NULL OR matched_client_id IS NOT NULL')).length, 0);
});

test('a term end expires members and stops the perk; renewing is an officer action each year', { skip }, async t => {
  const { db, api } = await setup(t, store => {
    setPerk(store, null, PERK, AT);
    const past = { term: '2024-25', termEndsAt: '2025-05-31T16:00:00.000Z', data: { terms: [{ term: '2024-25', approvedAt: '2024-08-01T00:00:00.000Z', approvedBy: 'org' }] } };
    addMember(store, 'member', { at: NOW(), ...past });
    addMember(store, 'second', { at: NOW(), ...past });
    addMember(store, 'phone', { at: NOW(), ...past, status: 'pending', memberSince: null });
    addMember(store, 'client', { at: NOW() });
  });
  // The perk stops at term end even before the sweep runs.
  assert.equal((await ok(api, 'member', 'GET', '/me/memberships')).memberships[0].status, 'expired');
  assert.equal((await ok(api, 'org', 'GET', '/me/organization/members/summary')).memberCount, 1);
  assert.equal(await mutate(db, store => sweepMembers(store, db, { at: NOW(), id })), true);
  assert.equal(await mutate(db, store => sweepMembers(store, db, { at: NOW(), id })), false);
  assert.deepEqual((await rows(db, 'organization_memberships')).map(row => [row.client_id, row.status]).sort(), [['client', 'active'], ['member', 'expired'], ['phone', 'removed'], ['second', 'expired']]);
  const listed = (await ok(api, 'org', 'GET', '/me/organization/members?status=expired')).members;
  assert.equal(listed.length, 2);
  await refused(api, 'org', 'POST', '/me/organization/members/mem_org_client/renew', { expectedVersion: 1 }, 409, 'membership_not_expired');
  await refused(api, 'org', 'POST', '/me/organization/members/renew', { memberIds: ['mem_org_member', 'mem_org_client'] }, 409, 'membership_not_expired');
  assert.equal((await rows(db, 'organization_memberships', "client_id = 'member'"))[0].status, 'expired', 'a refused bulk renewal changes nobody');
  const renewed = (await ok(api, 'org', 'POST', '/me/organization/members/mem_org_member/renew', { expectedVersion: 2 })).member;
  assert.deepEqual([renewed.status, renewed.term.code, renewed.termsCount, renewed.memberSince], ['active', term.code, 2, '2024-08-01']);
  assert.deepEqual((await ok(api, 'org', 'POST', '/me/organization/members/renew', { memberIds: ['mem_org_second'] })).renewed, ['mem_org_second']);
  assert.equal((await ok(api, 'member', 'GET', '/me/memberships')).memberships[0].perk.left, 5);
});

test('an officer handover keeps the list under the same account; losing the officer closes it', { skip }, async t => {
  const { db, api } = await setup(t, store => addMember(store, 'member', { at: NOW() }));
  await db.query(`UPDATE organization_accounts SET current_officer = '{"id":"officer_two","fullName":"Officer Two","startedAt":"2026-11-01T00:00:00Z"}'`).catch(async () => {
    await mutate(db, store => { store.organizationAccounts[0].currentOfficer = { id: 'officer_two', fullName: 'Officer Two', startedAt: AT }; });
  });
  assert.equal((await ok(api, 'org', 'GET', '/me/organization/members')).total, 1);
  await mutate(db, store => { store.organizationAccounts[0].currentOfficer = null; });
  await refused(api, 'org', 'GET', '/me/organization/members', undefined, 403, 'officer_of_record_required');
});

test('access: only the officer sees members and contacts, staff see totals, only Super Admin sets partners and the perk', { skip }, async t => {
  const { db, api } = await setup(t, store => { addPartner(store, { at: AT, orgId: 'club', label: 'Second Club' }); addMember(store, 'member', { at: NOW() }); person(store, 'plain', {}); });
  for (const [method, path] of [['GET', '/me/organization/members'], ['GET', '/me/organization/members/requests'], ['GET', '/me/organization/members/summary'], ['GET', '/me/organization/members/mem_org_member'],
    ['GET', '/me/organization/members/list'], ['POST', '/me/organization/members/list'], ['POST', '/me/organization/members/list/check'], ['GET', '/me/organization/members/invite'], ['POST', '/me/organization/members/invite'],
    ['POST', '/me/organization/members/renew'], ['PATCH', '/me/organization/members/mem_org_member'], ['DELETE', '/me/organization/members/mem_org_member'], ['GET', '/me/organization/partnership'], ['GET', '/me/organization/events']]) {
    assert.equal((await api(null, method, path, method === 'GET' ? undefined : {})).status, 401, path);
    for (const user of ['member', 'client', 'supplier', 'rider', 'ops', 'admin']) assert.equal((await api(user, method, path, method === 'GET' ? undefined : {})).status, 403, `${user} ${path}`);
  }
  for (const path of ['/me/organization/members/mem_org_member']) await refused(api, 'club', 'GET', path, undefined, 404, 'membership_not_found');
  await refused(api, 'club', 'DELETE', '/me/organization/members/mem_org_member', { expectedVersion: 1 }, 404, 'membership_not_found');
  // A client reads only their own memberships.
  assert.deepEqual((await ok(api, 'client', 'GET', '/me/memberships')).memberships, []);
  assert.doesNotMatch(JSON.stringify(await ok(api, 'member', 'GET', '/me/memberships')), /clientId|budget|organizationUserId/i);
  const partner = { label: 'Sample Guild', status: 'active', partnerSince: '2026-06-01', benefits: { badge: true, jointPromos: true, boothSupport: false }, expectedVersion: 1, reason: 'Recorded partnership' };
  const perk = { enabled: true, amountMinor: 1000, maxOrdersPerTerm: 5, endsAt: PERK.endsAt, budgetCapMinor: 100000, expectedVersion: 0, reason: 'Pilot' };
  for (const [method, path, body] of [['PUT', '/ops/organization-partners/org', partner], ['PUT', '/ops/member-perk', perk], ['PUT', '/ops/organization-partners/org/perk', perk], ['DELETE', '/ops/organization-partners/org/perk', { expectedVersion: 1, reason: 'x' }]]) {
    for (const user of ['ops', 'org', 'member', 'supplier', 'rider']) assert.equal((await api(user, method, path, body)).status, 403, `${user} ${path}`);
  }
  for (const user of ['org', 'member', 'supplier', 'rider']) for (const path of ['/ops/organization-partners', '/ops/member-perk']) assert.equal((await api(user, 'GET', path)).status, 403);
  assert.equal((await ok(api, 'ops', 'GET', '/ops/member-perk')).standard, null);
  for (const [field, value] of [['amountMinor', 0], ['amountMinor', 10.5], ['maxOrdersPerTerm', 0], ['budgetCapMinor', -1], ['endsAt', '2020-01-01T00:00:00Z'], ['endsAt', 'soon'], ['enabled', 'yes']]) {
    assert.equal((await refused(api, 'admin', 'PUT', '/ops/member-perk', { ...perk, [field]: value }, 400, 'invalid_member_perk')).field ?? field, field);
  }
  await refused(api, 'admin', 'PUT', '/ops/member-perk', { ...perk, reason: ' ' }, 400, 'reason_required');
  assert.equal((await ok(api, 'admin', 'PUT', '/ops/member-perk', perk)).standard.version, 1);
  await refused(api, 'admin', 'PUT', '/ops/member-perk', perk, 409, 'member_perk_stale');
  const overridden = (await ok(api, 'admin', 'PUT', '/ops/organization-partners/org/perk', { ...perk, amountMinor: 2500 })).partner;
  assert.deepEqual([overridden.perk.amountMinor, overridden.perkOverride.version, overridden.budgetLeftMinor], [2500, 1, 100000]);
  const partners = (await ok(api, 'ops', 'GET', '/ops/organization-partners')).partners;
  assert.deepEqual(partners.map(row => [row.label, row.results.memberCount, row.perk.amountMinor]), [['Sample Guild', 1, 2500], ['Second Club', 0, 1000]]);
  assert.doesNotMatch(JSON.stringify(partners), /Person |example\.invalid|mem_org/);
  const view = (await ok(api, 'org', 'GET', '/me/organization/partnership')).partnership;
  assert.deepEqual([view.perk.amountMinor, view.perk.setBy, view.perk.editable, view.perk.budgetCapMinor], [2500, 'GRIDGO', false, undefined]);
  await refused(api, 'admin', 'DELETE', '/ops/organization-partners/org/perk', { expectedVersion: 9, reason: 'Back to standard' }, 409, 'member_perk_stale');
  assert.equal((await ok(api, 'admin', 'DELETE', '/ops/organization-partners/org/perk', { expectedVersion: 1, reason: 'Back to standard' })).partner.perk.amountMinor, 1000);
  await refused(api, 'admin', 'PUT', '/ops/organization-partners/plain', { ...partner, expectedVersion: 0 }, 409, 'verified_organization_required');
  await refused(api, 'admin', 'PUT', '/ops/organization-partners/org', { ...partner, expectedVersion: 7 }, 409, 'organization_partner_stale');
  // Ending the partnership redacts the open list and stops the officer section, not the history.
  await ok(api, 'org', 'POST', '/me/organization/members/list', { consent: true, rows: [{ name: 'Alpha', contact: 'alpha@example.invalid', memberSince: '2024-01-01' }] }, 201);
  assert.equal((await ok(api, 'admin', 'PUT', '/ops/organization-partners/org', { ...partner, status: 'ended' })).partner.live, false);
  assert.equal((await rows(db, 'member_list_entries', 'contact IS NOT NULL')).length, 0);
  await refused(api, 'org', 'GET', '/me/organization/members', undefined, 403, 'organization_partner_required');
  assert.deepEqual([(await ok(api, 'member', 'GET', '/me/memberships')).memberships[0].partner, (await ok(api, 'member', 'GET', '/me/memberships')).memberships[0].perk], [false, null]);
  assert.equal((await ok(api, 'admin', 'PUT', '/ops/organization-partners/org', { ...partner, expectedVersion: 2 })).partner.live, true);
  const audit = await rows(db, 'audit_log', "action IN ('member_perk.set','member_perk.override_removed','organization_partner.set')");
  assert.equal(audit.length, 5); for (const row of audit) assert.ok(row.actor_id === 'admin' && row.data.reason);
});

test('checkout over HTTP: one quote, immutable snapshot, counted results, cancellation returns the use', { skip }, async t => {
  const { db, store, api } = await setup(t, s => { setPerk(s, null, { ...PERK, maxOrdersPerTerm: 2 }, AT); addMember(s, 'client', { at: NOW(), data: { terms: [{ term: term.code, approvedAt: AT, approvedBy: 'org' }] } }); });
  const path = await cart(api, store);
  const quote = (await ok(api, 'client', 'GET', path)).cart.clientQuote;
  assert.deepEqual([quote.memberPerkMinor, quote.memberPerk.useNumber, quote.memberPerk.maxOrdersPerTerm], [1000, 1, 2]);
  await refused(api, 'client', 'POST', `${path}/checkout`, pay('A', { expectedMemberPerkMinor: 900 }), 409, 'member_perk_changed');
  assert.equal((await rows(db, 'member_perk_uses')).length, 0);
  const placed = await ok(api, 'client', 'POST', `${path}/checkout`, pay('A', { expectedMemberPerkMinor: 1000 }), 201);
  assert.deepEqual([placed.order.totalMinor, placed.order.memberPerkMinor, placed.invoice.memberPerkMinor], [quote.totalMinor, 1000, 1000]);
  const first = placed.order.id;
  assert.equal((await ok(api, 'client', 'GET', `/orders/${first}`)).order.memberPerk.label, 'Sample Guild member');
  assert.doesNotMatch(JSON.stringify(await api('supplier', 'GET', `/orders/${first}`)), /Sample Guild|memberPerk/);
  for (const sql of [`UPDATE orders SET data = jsonb_set(data, '{memberPerkMinor}', '900') WHERE id = $1`, `UPDATE orders SET data = data - 'memberPerk' WHERE id = $1`, `UPDATE orders SET data = data - 'memberPerkMinor' WHERE id = $1`,
    `UPDATE orders SET data = jsonb_set(data, '{memberPerk,label}', '"Other"') WHERE id = $1`]) await assert.rejects(db.query(sql, [first]), error => error.code === '23514' || error.code === 'P0001', sql);
  // A second order uses the second and last use.
  const next = await ok(api, 'client', 'POST', `${await cart(api, store)}/checkout`, pay('B'), 201);
  assert.equal(next.order.memberPerk.useNumber, 2);
  const third = await cart(api, store);
  assert.equal((await ok(api, 'client', 'GET', third)).cart.clientQuote.memberPerkMinor, 0);
  await refused(api, 'client', 'POST', `${third}/checkout`, pay('C', { expectedMemberPerkMinor: 1000 }), 409, 'member_perk_changed');
  let mine = (await ok(api, 'client', 'GET', '/me/memberships')).memberships[0];
  assert.deepEqual([mine.perk.used, mine.perk.left, mine.perk.available, mine.totalSavedMinor], [2, 0, false, 0]);
  // The unpaid second order is cancelled: the use and the budget come back.
  await mutate(db, s => { const order = s.orders.find(row => row.id === next.order.id); Object.assign(order, { state: 'cancelled', cancelledAt: NOW(), cancelledBy: 'ops', cancellationReason: 'No payment' }); });
  await ok(api, 'admin', 'PUT', '/ops/member-perk', { enabled: true, amountMinor: 1000, maxOrdersPerTerm: 2, endsAt: PERK.endsAt, budgetCapMinor: 100000, expectedVersion: 1, reason: 'Any save settles the ledger' });
  assert.deepEqual((await rows(db, 'member_perk_uses')).map(row => row.status).sort(), ['reserved', 'returned']);
  assert.equal((await ok(api, 'client', 'GET', third)).cart.clientQuote.memberPerk.useNumber, 2);
  // Confirming the first payment counts the order and the saving.
  await ok(api, 'ops', 'POST', `/orders/${first}/payments/initial/confirm`, { reason: 'Received' });
  assert.equal((await rows(db, 'member_perk_uses', "status = 'confirmed'")).length, 1);
  mine = (await ok(api, 'client', 'GET', '/me/memberships')).memberships[0];
  assert.equal(mine.totalSavedMinor, 1000);
  const results = (await ok(api, 'org', 'GET', '/me/organization/partnership')).partnership.results;
  assert.deepEqual([results.memberCount, results.membersOrdered, results.membersSavedMinor], [1, 1, 1000]);
  assert.ok(results.memberOrders >= 1);
  const member = (await ok(api, 'org', 'GET', '/me/organization/members/mem_org_client')).member;
  assert.equal(member.ordersThisTerm, results.memberOrders);
  assert.equal((await ok(api, 'org', 'GET', '/me/organization/members?filter=ordered')).total, 1);
  assert.doesNotMatch(JSON.stringify(member), /ord_|artwork|total/i);
  // Removal stops the label and perk at once; the placed order keeps its own.
  await ok(api, 'org', 'DELETE', '/me/organization/members/mem_org_client', { expectedVersion: member.version });
  assert.equal((await ok(api, 'client', 'GET', third)).cart.clientQuote.memberPerk, null);
  assert.equal((await ok(api, 'client', 'GET', `/orders/${first}`)).order.memberPerkMinor, 1000);
});

test('HTTP: after payment only a no-fault cancellation returns the use', { skip }, async t => {
  for (const clientCaused of [false, true]) {
    const { db, store, api } = await setup(t, s => { setPerk(s, null, PERK, AT); addMember(s, 'client', { at: NOW() });
      for (const [fileId, purpose, ownerId] of [['refundQr', 'refund_qr', 'client'], ['refundReceipt', 'refund_receipt', 'ops']]) s.files.push({ fileId, purpose, ownerId, state: 'ready', objectKey: `private/${fileId}`, originalFilename: `${fileId}.png`, size: 100, declaredContentType: 'image/png', detectedContentType: 'image/png', createdAt: AT, references: [] }); });
    const placed = await ok(api, 'client', 'POST', `${await cart(api, store)}/checkout`, pay('PAID'), 201);
    await ok(api, 'ops', 'POST', `/orders/${placed.order.id}/payments/initial/confirm`, { reason: 'Received' });
    await settleCancellation(api, placed.order.id, { clientCaused, totalMinor: placed.order.totalMinor });
    assert.equal((await rows(db, 'member_perk_uses'))[0].status, clientCaused ? 'confirmed' : 'returned');
    const kept = (await loadStore(db)).orders.find(order => order.id === placed.order.id);
    assert.deepEqual([kept.memberPerkMinor, kept.totalMinor], [1000, placed.order.totalMinor], 'the order keeps its money snapshot');
  }
});

test('concurrent checkouts never pass the member cap or the organization budget', { skip }, async t => {
  const { db, store, api } = await setup(t, s => {
    setPerk(s, null, { ...PERK, maxOrdersPerTerm: 2, budgetCapMinor: 3000 }, AT);
    for (const key of ['client', 'member', 'second']) addMember(s, key, { at: NOW() });
    for (const key of ['member', 'second']) for (const [fileId, purpose] of [[`artwork_${key}`, 'artwork'], [`receipt_${key}`, 'payment_proof']]) s.files.push({ ...structuredClone(s.files.find(f => f.fileId === (purpose === 'artwork' ? 'artwork' : 'receipt'))), fileId, ownerId: key, objectKey: `private/${fileId}` });
  });
  const carts = [];
  for (const user of ['client', 'client', 'client', 'member', 'second']) carts.push([user, await cart(api, store, user)]);
  const placed = await Promise.all(carts.map(([user, path], index) => api(user, 'POST', `${path}/checkout`, pay(`RACE-${index}`, {}, user === 'client' ? 'receipt' : `receipt_${user}`))));
  assert.deepEqual(placed.map(result => result.status), [201, 201, 201, 201, 201], JSON.stringify(placed.map(result => result.body.error)));
  const uses = await rows(db, 'member_perk_uses');
  assert.equal(uses.length, 3); assert.equal(uses.reduce((sum, row) => sum + row.amount_minor, 0), 3000);
  assert.ok(uses.filter(row => row.client_id === 'client').length <= 2);
  assert.equal(placed.filter(result => result.body.order.memberPerkMinor === 1000).length, 3);
  for (const result of placed) assert.equal(result.body.order.totalMinor, result.body.order.memberPerkMinor ? placed.find(row => row.body.order.memberPerkMinor).body.order.totalMinor : placed.find(row => !row.body.order.memberPerkMinor).body.order.totalMinor);
});

test('the database itself refuses a perk use past its caps, even without the domain lock', { skip }, async t => {
  const { db } = await setup(t, s => { setPerk(s, null, { ...PERK, maxOrdersPerTerm: 2, budgetCapMinor: 2500 }, AT); addMember(s, 'member', { at: NOW() }); addMember(s, 'second', { at: NOW() }); }, { server: false });
  const insert = (member, amount, key) => db.query(`INSERT INTO member_perk_uses (id, membership_id, organization_user_id, client_id, term, amount_minor, status, created_at) VALUES ($1,$2,'org',$3,$4,$5,'reserved',now())`, [key, `mem_org_${member}`, member, term.code, amount]);
  const race = await Promise.allSettled(Array.from({ length: 6 }, (_, n) => insert(n % 2 ? 'member' : 'second', 1000, `race_${n}`)));
  assert.equal(race.filter(row => row.status === 'fulfilled').length, 2);
  for (const row of race.filter(row => row.status === 'rejected')) assert.equal(row.reason.code, '23514');
  await assert.rejects(insert('member', 1001, 'too_much'), { code: '23514' });
  await assert.rejects(db.query('DELETE FROM member_perk_uses'), { code: '23514' });
  await assert.rejects(db.query('UPDATE member_perk_uses SET amount_minor = 1'), { code: '23514' });
  await db.query("UPDATE member_perk_uses SET status = 'returned'");
  await assert.rejects(db.query("UPDATE member_perk_uses SET status = 'reserved'"), { code: '23514' });
  await db.query("UPDATE organization_memberships SET status = 'removed'");
  await assert.rejects(insert('member', 100, 'not_member'), { code: '23514' });
});

test('event records group own orders once and download as a statement pack', { skip }, async t => {
  const { db, api } = await setup(t, store => {
    addPartner(store, { at: AT, orgId: 'club', label: 'Second Club' });
    for (const [key, state] of [['org_done', 'completed'], ['org_open', 'production'], ['org_cancelled', 'cancelled']]) {
      const order = structuredClone(store.orders[0]);
      Object.assign(order, { id: key, clientId: 'org', state, ...(state === 'cancelled' ? { cancelledAt: AT, cancelledBy: 'ops', cancellationReason: 'Test' } : {}), invoiceNumber: undefined, timeline: [{ at: AT, state, by: 'supplier' }] });
      order.payoutMilestones = createPayoutMilestones(order, { version: 2 });
      store.orders.push(order);
      store.orderJobs.push({ ...structuredClone(store.orderJobs[0]), id: `job_${key}`, orderId: key });
      store.orderLineItems.push({ ...structuredClone(store.orderLineItems[0]), id: `line_${key}`, orderId: key, jobId: `job_${key}` });
    }
  });
  await refused(api, 'org', 'POST', '/me/organization/events', { name: ' ' }, 400, 'invalid_event_name');
  await refused(api, 'org', 'POST', '/me/organization/events', { name: 'Foundation week', orderIds: ['order'] }, 404, 'event_order_not_found');
  await refused(api, 'org', 'POST', '/me/organization/events', { name: 'Foundation week', orderIds: ['org_cancelled'] }, 404, 'event_order_not_found');
  assert.equal((await rows(db, 'organization_events')).length, 0, 'a refused event is not stored');
  const { event } = await ok(api, 'org', 'POST', '/me/organization/events', { name: 'Foundation week', orderIds: ['org_done', 'org_open'] }, 201);
  assert.deepEqual([event.status, event.orderCount, event.totalMinor], ['open', 2, 24000]);
  await refused(api, 'org', 'POST', '/me/organization/events', { name: 'Other', orderIds: ['org_done'] }, 409, 'event_order_already_recorded');
  await refused(api, 'org', 'PATCH', `/me/organization/events/${event.id}`, { expectedVersion: 5, name: 'X' }, 409, 'organization_event_stale');
  const done = (await ok(api, 'org', 'PATCH', `/me/organization/events/${event.id}`, { expectedVersion: 1, orderIds: ['org_done'], name: 'Foundation week 2026' })).event;
  assert.deepEqual([done.status, done.orderCount, done.totalMinor, done.name, done.version], ['complete', 1, 12000, 'Foundation week 2026', 2]);
  const { pack } = await ok(api, 'org', 'GET', `/me/organization/events/${event.id}/pack`);
  assert.deepEqual([pack.status, pack.orderCount, pack.totalSpendMinor, pack.title], ['complete', 1, 12000, 'Foundation week 2026']);
  assert.match(pack.notice, /not a tax/i);
  const csv = await api('org', 'GET', `/me/organization/events/${event.id}/pack?format=csv`, undefined, { raw: true });
  assert.equal(csv.status, 200); assert.match(csv.body, /Foundation week 2026/); assert.match(csv.headers.get('content-disposition'), /organization-event/);
  const pdf = await api('org', 'GET', `/me/organization/events/${event.id}/pack?format=pdf`, undefined, { raw: true });
  assert.match(pdf.body, /^%PDF/);
  await refused(api, 'club', 'GET', `/me/organization/events/${event.id}`, undefined, 404, 'organization_event_not_found');
  await refused(api, 'club', 'GET', `/me/organization/events/${event.id}/pack`, undefined, 404, 'organization_event_not_found');
  assert.equal((await ok(api, 'org', 'GET', '/me/organization/partnership')).partnership.events.length, 1);
  await ok(api, 'org', 'DELETE', `/me/organization/events/${event.id}`, { expectedVersion: 2 });
  assert.equal((await ok(api, 'org', 'GET', '/me/organization/events')).events.length, 0);
});

test('the migration is additive and forward only', async () => {
  const sql = []; await up({ sql: text => sql.push(text) });
  assert.doesNotMatch(sql.join('\n'), /\b(DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|ALTER TABLE orders|UPDATE orders)\b/i);
  await assert.rejects(down(), /forward migration/);
});
