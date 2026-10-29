import { promotionSettings } from './promotion-settings.js';
import crypto from 'node:crypto';
import { GRIDGO_OFFICE } from './gridgo-office.js';
import { voucherFail as fail } from './vouchers.js';
import { foundingTesterEligible, testerProgress } from './founding-testers.js';
import { createTesterReward, issueTesterReward, testerEvent } from './tester-rewards.js';
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';
import { isReviewData } from './review-data.js';

const init = store => { for (const key of ['testerInviteCodes', 'testerInvites', 'testerInstallations', 'testerRewards', 'testerTracking']) store[key] ||= []; };
const client = (store, clientId) => store.users.some(u => u.id === clientId && !isReviewData(u))
  && store.userRoleMemberships.some(m => m.userId === clientId && m.role === 'client');
export function createInviteCode(store, clientId, { at }) {
  init(store);
  if (!client(store, clientId)) fail(403, 'tester_client_required');
  let row = store.testerInviteCodes.find(r => r.clientId === clientId);
  if (!row) { row = { clientId, code: crypto.randomBytes(12).toString('hex').toUpperCase(), createdAt: at }; store.testerInviteCodes.push(row); }
  return row;
}
export function recordTesterInstallation(store, clientId, installationId, { at }) {
  init(store);
  if (typeof installationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(installationId)) fail(400, 'invalid_tester_installation_id');
  installationId = installationId.toLowerCase();
  if (store.testerInstallations.some(r => r.clientId === clientId && r.installationId === installationId)) return false;
  store.testerInstallations.push({ clientId, installationId, createdAt: at });
  return true;
}
function inviteEvent(store, invite, action, { id, at, actorId = null }) {
  store.auditLog.push({ id: id('aud'), at, actorId, actorRole: store.users.find(u => u.id === actorId)?.role || 'system',
    action: `tester_invite.${action}`, entityType: 'tester_invite', entityId: invite.id, detail: { clientId: invite.clientId } });
  for (const member of privilegedAdminMemberships(store)) store.notifications.push({ id: id('not'), at, userId: member.userId,
    appRole: member.role, type: `tester_invite_${action}`, title: 'Tester invitation update', body: `Tester invitation ${action}.`, read: false });
  queueInvalidate(store, { resource: 'identity', userIds: [invite.inviterId, invite.clientId].filter(Boolean) });
}
export function submitTesterInvite(store, { code, email }, ctx) {
  const { id, at } = ctx;
  init(store);
  code = typeof code === 'string' ? code.trim().toUpperCase() : '';
  email = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'invalid_tester_email');
  const owner = store.testerInviteCodes.find(r => r.code === code);
  if (!owner) fail(400, 'invalid_tester_invite_code');
  const prior = store.testerInvites.find(i => i.email === email);
  if (prior) { if (prior.inviterId !== owner.clientId) fail(409, 'tester_invite_already_attributed'); return prior; }
  const invite = { id: id('tinv'), inviterId: owner.clientId, code, email, clientId: null, createdAt: at,
    matchedAt: null, completedAt: null, unmatchedReason: 'no_client_account' };
  store.testerInvites.push(invite);
  inviteEvent(store, invite, 'recorded', ctx);
  return invite;
}
// Form ingestion and account activation match identities only; neither issues rewards.
export function matchTesterInvites(store, ctx) {
  const { at } = ctx;
  init(store); let changed = false;
  for (const invite of store.testerInvites.filter(i => !i.clientId)) {
    const matches = store.users.filter(u => client(store, u.id) && String(u.email || '').trim().toLowerCase() === invite.email);
    const target = matches.length === 1 ? matches[0] : null;
    let reason = matches.length > 1 ? 'ambiguous_email' : 'no_client_account';
    if (target) {
      reason = target.id === invite.inviterId ? 'self_invite' : store.testerInvites.some(i => i.clientId === target.id) ? 'account_already_attributed' : null;
      if (!reason) { Object.assign(invite, { clientId: target.id, matchedAt: at }); inviteEvent(store, invite, 'joined', ctx); }
    }
    if (reason !== invite.unmatchedReason || invite.clientId) { invite.unmatchedReason = reason; changed = true; }
  }
  return changed;
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function normalizedPhone(value) {
  let digits = String(value || '').replace(/[^0-9]/g, '');
  if (/^09\d{9}$/.test(digits)) digits = `63${digits.slice(1)}`;
  if (/^9\d{9}$/.test(digits)) digits = `63${digits}`;
  if (/^00/.test(digits)) digits = digits.slice(2);
  return /^\d{10,15}$/.test(digits) ? digits : null;
}
function normalizedAddress(value) {
  const text = typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ' ').trim().replace(/\s+/g, ' ') : '';
  const generic = ['home', 'work', 'office', 'school', 'client', 'delivery', 'dropoff', 'drop off', 'gridgo office', 'gridgo hub', 'hub'];
  return text.length >= 5 && !generic.includes(text) ? text : null;
}
export function testerEvidence(store, clientId) {
  const phone = normalizedPhone(store.users.find(u => u.id === clientId)?.phone);
  // Only immutable personal DELIVERY order destinations. Saved addresses can be
  // edited/deleted; a shared hub destination is never evidence against a client.
  const addresses = store.orders.filter(o => o.clientId === clientId && !isReviewData(o) && o.fulfillmentMode === 'delivery'
    && !(o.dropoff?.lat === GRIDGO_OFFICE.lat && o.dropoff?.lng === GRIDGO_OFFICE.lng))
    .map(o => normalizedAddress(o.dropoff?.addressLine || o.dropoff?.label)).filter(Boolean);
  return { phone: phone ? [hash(`phone:${phone}`)] : [],
    device: (store.testerInstallations || []).filter(r => r.clientId === clientId).map(r => hash(`device:${r.installationId}`)),
    address: [...new Set(addresses.map(a => hash(`address:${a}`)))] };
}
export function referralChecks(store, invite) {
  const invitee = testerEvidence(store, invite.clientId);
  const comparators = [{ clientId: invite.inviterId, evidence: testerEvidence(store, invite.inviterId) },
    ...store.testerRewards.filter(r => r.kind === 'referral' && r.inviterId === invite.inviterId && r.clientId !== invite.clientId && r.issuedAt)
      .map(r => { const current = testerEvidence(store, r.clientId); return { clientId: r.clientId, evidence: Object.fromEntries(['phone', 'device', 'address'].map(key => [key, [...new Set([...(r.evidence.invitee?.[key] || []), ...current[key]])]])) }; })];
  const checks = {};
  for (const key of ['phone', 'device', 'address']) {
    const comparedClientIds = comparators.filter(c => invitee[key].length && c.evidence?.[key]?.length).map(c => c.clientId);
    const missingClientIds = [...(!invitee[key].length ? [invite.clientId] : []), ...comparators.filter(c => !c.evidence?.[key]?.length).map(c => c.clientId)];
    const matchedClientIds = comparators.filter(c => c.evidence?.[key]?.some(value => invitee[key].includes(value))).map(c => c.clientId);
    checks[key] = { status: matchedClientIds.length ? 'match' : comparedClientIds.length ? 'no_match' : 'missing', comparedClientIds, missingClientIds, matchedClientIds };
  }
  return { checks, evidence: { invitee }, blocked: Object.values(checks).some(c => c.status === 'match') };
}
export function testerInviteNeedsReconciliation(store, clientId, { resume = false } = {}) {
  const invite = store.testerInvites.find(i => i.clientId === clientId);
  if (!invite || !client(store, invite.inviterId) || !foundingTesterEligible(store, clientId)
    || testerProgress(store, clientId, { preserveAward: false }).completedCount !== 5) return false;
  const previous = store.testerRewards.find(r => r.kind === 'referral' && r.clientId === clientId);
  return !previous || (resume && previous.status === 'paused');
}
export function reconcileTesterInvite(store, clientId, ctx) {
  init(store);
  if (!testerInviteNeedsReconciliation(store, clientId, ctx)) return false;
  const invite = store.testerInvites.find(i => i.clientId === clientId);
  invite.completedAt ||= ctx.at;
  const reward = createTesterReward(store, { kind: 'referral', clientId, inviterId: invite.inviterId, inviteId: invite.id, amountMinor: promotionSettings(store).rewards.inviteMinor * 2 }, ctx);
  const { checks, evidence, blocked } = referralChecks(store, invite);
  Object.assign(reward, { checks, evidence });
  if (blocked) {
    reward.status = 'blocked'; reward.reason = Object.entries(checks).filter(([, c]) => c.status === 'match').map(([key]) => `same_${key}`).join(',');
    testerEvent(store, reward, 'blocked', ctx, { checks }); return true;
  }
  issueTesterReward(store, reward, ctx);
  return true;
}
export function publicTesterInvites(store, clientId) {
  const code = store.testerInviteCodes?.find(r => r.clientId === clientId)?.code || null;
  const template = store.settings.testerSignupFormUrlTemplate;
  const invites = (store.testerInvites || []).filter(i => i.inviterId === clientId);
  return { code, link: code && template ? template.replace('{code}', encodeURIComponent(code)) : null,
    invited: invites.length, joined: invites.filter(i => i.clientId).length, completed: invites.filter(i => i.completedAt).length };
}
