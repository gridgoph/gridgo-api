import { initVouchers, issueVoucher, publicVoucher, voucherEvent, voucherFail as fail, generatedVoucherCode } from './vouchers.js';
import { promotionSettings, promotionVersion } from './promotion-settings.js';
import { isReviewData } from './review-data.js';
import { queueInvalidate, privilegedAdminMemberships } from './notifications.js';
import { sumMinor } from './refund-policy.js';

const normalizeEmail = value => String(value || '').trim().toLowerCase();
export const launchVoucher = v => ['founding', 'friend_pass'].includes(v.promotionKind);
const live = (voucher, at) => voucher.status === 'used' || voucher.status === 'available' && Date.parse(voucher.expiresAt) > Date.parse(at);
const slot = v => v.promotionKind === 'founding' || Boolean(v.data?.upgradedAt);
const own = (store, clientId) => store.vouchers.find(v => v.clientId === clientId && launchVoucher(v));
export function promotionEligible(store, clientId) {
  const user = store.users.find(u => u.id === clientId);
  const memberships = store.userRoleMemberships.filter(m => m.userId === clientId);
  return Boolean(user && !isReviewData(user) && !['suspended', 'removed'].includes(user.accountStatus)
    && memberships.some(m => m.role === 'client') && !memberships.some(m => ['staff', 'ops_admin', 'super_admin'].includes(m.role)));
}
export function promotionBudget(store, at) {
  const vouchers = (store.vouchers || []).filter(launchVoucher);
  const capMinor = promotionSettings(store).budgetCapMinor;
  const committedMinor = sumMinor(vouchers.filter(v => live(v, at)).map(v => v.valueMinor));
  const ids = new Set(vouchers.map(v => v.id));
  const redeemedMinor = sumMinor((store.voucherRedemptions || []).filter(r => ids.has(r.voucherId) && r.status === 'consumed').map(r => r.amountMinor));
  return { capMinor, committedMinor, redeemedMinor, remainingMinor: Math.max(0, capMinor - committedMinor) };
}
export function promotionSlotsLeft(store, at) {
  return Math.max(0, promotionSettings(store).founding.slots - (store.vouchers || []).filter(v => launchVoucher(v) && slot(v) && live(v, at)).length);
}
function windowError(settings, at, kind) {
  if (!settings.founding.enabled || kind === 'friend_pass' && !settings.friendPass.enabled) return 'promotion_disabled';
  if (Date.parse(at) < Date.parse(settings.founding.startsAt)) return 'promotion_not_started';
  if (Date.parse(at) >= Date.parse(settings.founding.endsAt)) return 'promotion_ended';
  return null;
}
function claimError(store, clientId, at, kind) {
  if (!promotionEligible(store, clientId)) return 'promotion_ineligible_account';
  if (own(store, clientId)) return 'promotion_already_has_discount';
  const settings = promotionSettings(store), error = windowError(settings, at, kind);
  if (error) return error;
  if (kind === 'founding' && !promotionSlotsLeft(store, at)) return 'promotion_sold_out';
  const value = kind === 'founding' ? settings.founding.amountMinor : settings.friendPass.amountMinor;
  if (BigInt(promotionBudget(store, at).committedMinor) + BigInt(value) > BigInt(settings.budgetCapMinor)) return 'promotion_budget_reached';
  return null;
}
function issueLaunchVoucher(store, clientId, kind, ctx) {
  const settings = promotionSettings(store), version = promotionVersion(store);
  const purpose = kind === 'founding' ? 'founding_launch' : 'friend_pass';
  let campaign = store.voucherCampaigns.find(c => c.purpose === purpose && c.id === `launch_${kind}_v${version}`);
  if (!campaign) {
    campaign = { id: `launch_${kind}_v${version}`, purpose, name: kind === 'founding' ? 'Founding 30' : 'Friend Pass',
      code: generatedVoucherCode(), mode: 'assigned', status: 'active', coversOrderTotal: true,
      valueMinor: kind === 'founding' ? settings.founding.amountMinor : settings.friendPass.amountMinor,
      totalLimit: 1000000, perAccountLimit: 1, endsAt: settings.founding.endsAt, validityDays: null, createdAt: ctx.at, updatedAt: ctx.at };
    store.voucherCampaigns.push(campaign);
  }
  return issueVoucher(store, campaign, clientId, { ...ctx, actorId: clientId }).voucher;
}
function inviteEvent(store, invite, action, ctx) {
  store.auditLog ||= [];
  store.auditLog.push({ id: ctx.id('aud'), at: ctx.at, actorId: ctx.actorId ?? null, actorRole: ctx.actorId ? 'client' : 'system',
    action: `promotion.${action}`, entityType: 'promotion_invite', entityId: invite.id, detail: { founderId: invite.founderId, clientId: invite.clientId, email: invite.email } });
  store.notifications ||= [];
  for (const m of privilegedAdminMemberships(store)) store.notifications.push({ id: ctx.id('not'), at: ctx.at, userId: m.userId,
    appRole: m.role, type: 'promotion_invite', title: 'Friend Pass activity', body: `Friend Pass ${action}.`, read: false });
  queueInvalidate(store, { resource: 'notifications', userIds: [invite.founderId, invite.clientId].filter(Boolean) });
}
function matchPromotionInvite(store, invite, ignoreAttribution = false) {
  if (invite.clientId) return { target: store.users.find(u => u.id === invite.clientId), reason: null };
  const matches = store.users.filter(u => promotionEligible(store, u.id) && normalizeEmail(u.email) === invite.email);
  if (matches.length !== 1) return { target: null, reason: matches.length ? 'ambiguous_email' : 'no_client_account' };
  const target = matches[0];
  if (target.id === invite.founderId) return { target: null, reason: 'self_invite' };
  if (!ignoreAttribution && own(store, target.id)?.promotionKind !== 'founding'
    && (store.promotionInvites || []).some(i => i.id !== invite.id && i.clientId === target.id && i.status !== 'skipped_already_founder')) {
    return { target: null, reason: 'account_already_attributed' };
  }
  return { target, reason: null };
}
const matchedClient = (store, invite) => matchPromotionInvite(store, invite).target;
const skipped = (store, invite) => invite.status === 'skipped_already_founder'
  || !invite.voucherId && own(store, matchedClient(store, invite)?.id)?.promotionKind === 'founding';
function inviteView(store, invite, at) {
  const voucher = store.vouchers.find(v => v.id === invite.voucherId), friend = matchedClient(store, invite);
  const status = skipped(store, invite) ? 'skipped_already_founder' : voucher ? publicVoucher(store, voucher, at).status : invite.status === 'invited' && Date.parse(at) >= Date.parse(promotionSettings(store).founding.endsAt) ? 'expired' : invite.status;
  return { id: invite.id, founder: person(store, invite.founderId), email: invite.email, friendEmail: invite.email,
    clientId: friend?.id ?? null, status: status === 'available' || status === 'reserved' ? 'claimed' : status,
    unmatchedReason: matchPromotionInvite(store, invite).reason ?? invite.unmatchedReason ?? null,
    createdAt: invite.createdAt, claimedAt: invite.claimedAt, valueMinor: voucher?.valueMinor ?? null, upgradedAt: voucher?.data?.upgradedAt ?? null };
}
export function reconcilePromotionInvites(store, ctx) {
  let changed = false;
  for (const invite of store.promotionInvites || []) {
    if (invite.status !== 'invited') continue;
    const { target, reason } = matchPromotionInvite(store, invite);
    if (invite.unmatchedReason !== reason) {
      invite.unmatchedReason = reason; changed = true;
      if (reason === 'account_already_attributed') inviteEvent(store, invite, 'attribution_conflict', ctx);
    }
    if (!target) continue;
    if (!invite.clientId) { invite.clientId = target.id; changed = true; }
    if (skipped(store, invite)) {
      invite.status = 'skipped_already_founder'; inviteEvent(store, invite, 'skipped_already_founder', ctx); changed = true;
    } else if (!invite.notifiedAt && !windowError(promotionSettings(store), ctx.at, 'friend_pass')) {
      store.notifications ||= [];
      store.notifications.push({ id: ctx.id('not'), userId: target.id, appRole: 'client', type: 'promotion_friend_pass_waiting',
        title: 'A Friend Pass is waiting', body: 'Open Account > Vouchers to claim your GRIDGO Friend Pass.', at: ctx.at, read: false, push: false });
      invite.notifiedAt = ctx.at; inviteEvent(store, invite, 'matched', ctx); changed = true;
    }
  }
  return changed;
}
export function claimFounding(store, clientId, ctx) {
  initVouchers(store);
  const error = claimError(store, clientId, ctx.at, 'founding');
  if (error) fail(409, error);
  issueLaunchVoucher(store, clientId, 'founding', ctx);
  reconcilePromotionInvites(store, ctx);
}
export function inviteFriend(store, founderId, email, ctx) {
  initVouchers(store); store.promotionInvites ||= [];
  if (!promotionEligible(store, founderId)) fail(403, 'promotion_ineligible_account');
  if (own(store, founderId)?.promotionKind !== 'founding') fail(409, 'promotion_not_founder');
  const settings = promotionSettings(store), error = windowError(settings, ctx.at, 'friend_pass');
  if (error) fail(409, error);
  if (typeof email !== 'string') fail(400, 'invalid_promotion_email');
  email = normalizeEmail(email);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'invalid_promotion_email');
  if (email === normalizeEmail(store.users.find(u => u.id === founderId)?.email)) fail(409, 'promotion_self_invite');
  if (store.promotionInvites.some(i => i.email === email)) fail(409, 'promotion_email_already_invited');
  const counted = store.promotionInvites.filter(i => !skipped(store, i));
  if (counted.filter(i => i.founderId === founderId).length >= settings.friendPass.perFounder) fail(409, 'promotion_invite_used');
  if (counted.length >= settings.friendPass.total) fail(409, 'promotion_sold_out');
  const invite = { id: ctx.id('pinv'), founderId, email, clientId: null, voucherId: null, status: 'invited', createdAt: ctx.at, claimedAt: null, notifiedAt: null, unmatchedReason: null };
  const target = matchPromotionInvite(store, invite, true).target;
  if (target && store.promotionInvites.some(i => i.clientId === target.id && !skipped(store, i))) fail(409, 'promotion_email_already_invited');
  if (target && own(store, target.id)?.promotionKind === 'friend_pass') fail(409, 'promotion_already_has_discount');
  store.promotionInvites.push(invite);
  inviteEvent(store, invite, 'invited', { ...ctx, actorId: founderId });
  reconcilePromotionInvites(store, ctx);
}
export function claimFriendPass(store, clientId, ctx) {
  initVouchers(store);
  const error = claimError(store, clientId, ctx.at, 'friend_pass');
  if (error) fail(409, error);
  const invites = (store.promotionInvites || []).filter(i => i.status === 'invited' && !skipped(store, i) && matchedClient(store, i)?.id === clientId);
  if (invites.length !== 1) fail(409, 'promotion_offer_unavailable');
  const invite = invites[0], voucher = issueLaunchVoucher(store, clientId, 'friend_pass', ctx);
  Object.assign(invite, { clientId, voucherId: voucher.id, status: 'claimed', claimedAt: ctx.at });
  inviteEvent(store, invite, 'claimed', { ...ctx, actorId: clientId });
}
export function sweepPromotions(store, ctx) {
  let changed = reconcilePromotionInvites(store, ctx);
  const settings = promotionSettings(store);
  if (windowError(settings, ctx.at, 'friend_pass') || Date.parse(ctx.at) < Date.parse(settings.friendPass.upgradeAt)) return changed;
  const candidates = (store.vouchers || []).filter(v => v.promotionKind === 'friend_pass' && !v.data.upgradedAt && v.status === 'available' && live(v, ctx.at)
    && !(store.voucherReservations || []).some(r => r.voucherId === v.id && r.status === 'reserved' && Date.parse(r.expiresAt) > Date.parse(ctx.at)))
    .sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt) || (a.data.promotionClaimSequence ?? 0) - (b.data.promotionClaimSequence ?? 0) || a.id.localeCompare(b.id));
  for (const voucher of candidates) {
    if (!promotionSlotsLeft(store, ctx.at)) break;
    const increment = Math.max(0, settings.founding.amountMinor - voucher.valueMinor);
    if (BigInt(promotionBudget(store, ctx.at).committedMinor) + BigInt(increment) > BigInt(settings.budgetCapMinor)) break;
    const previousValueMinor = voucher.valueMinor;
    voucher.valueMinor += increment; voucher.data.upgradedAt = ctx.at; voucher.data.upgradeSettingsVersion = promotionVersion(store);
    voucherEvent(store, voucher, 'upgraded', { ...ctx, amountMinor: increment, previousValueMinor, valueMinor: voucher.valueMinor });
    changed = true;
  }
  return changed;
}
const person = (store, id) => { const u = store.users.find(u => u.id === id); return u ? { id, name: u.name, email: u.email } : { id }; };
export function myPromotions(store, clientId, at) {
  initVouchers(store);
  const settings = promotionSettings(store), voucher = own(store, clientId);
  const invites = (store.promotionInvites || []).filter(i => i.founderId === clientId);
  const activeInvites = invites.filter(i => !skipped(store, i));
  const offers = (store.promotionInvites || []).filter(i => i.status === 'invited' && !skipped(store, i) && matchedClient(store, i)?.id === clientId);
  const canInvite = promotionEligible(store, clientId) && voucher?.promotionKind === 'founding' && !windowError(settings, at, 'friend_pass')
    && activeInvites.length < settings.friendPass.perFounder && (store.promotionInvites || []).filter(i => !skipped(store, i)).length < settings.friendPass.total;
  const offer = !claimError(store, clientId, at, 'friend_pass') && offers.length === 1 ? inviteView(store, offers[0], at) : null;
  return { serverTime: at, rewards: { ...settings.rewards }, founding: { claimable: !claimError(store, clientId, at, 'founding'), amountMinor: settings.founding.amountMinor,
    slotsLeft: promotionSlotsLeft(store, at), endsAt: settings.founding.endsAt, voucher: voucher?.promotionKind === 'founding' ? publicVoucher(store, voucher, at) : null },
    friendPass: { canInvite, invite: invites.length ? inviteView(store, activeInvites.at(-1) || invites.at(-1), at) : null,
      invites: invites.map(i => inviteView(store, i, at)), offer: offer ? { ...offer, amountMinor: settings.friendPass.amountMinor, endsAt: settings.founding.endsAt } : null,
      voucher: voucher?.promotionKind === 'friend_pass' ? publicVoucher(store, voucher, at) : null } };
}
export function adminPromotions(store, at) {
  initVouchers(store);
  const settings = promotionSettings(store), claims = store.vouchers.filter(v => launchVoucher(v) && slot(v));
  const status = v => { const p = publicVoucher(store, v, at); return p.status === 'available' && p.reservation ? 'reserved' : p.status; };
  return { settings, version: promotionVersion(store), serverTime: at,
    founding: { slots: settings.founding.slots, claimed: claims.filter(v => live(v, at)).length, available: promotionSlotsLeft(store, at),
      used: claims.filter(v => v.status === 'used').length, expiredUnused: claims.filter(v => status(v) === 'expired').length,
      claims: claims.map(v => ({ ...person(store, v.clientId), clientId: v.clientId, voucherId: v.id, claimedAt: v.issuedAt,
        valueMinor: v.valueMinor, status: status(v), promotionKind: v.promotionKind, upgradedAt: v.data.upgradedAt ?? null,
        orderIds: [...new Set(store.voucherRedemptions.filter(r => r.voucherId === v.id).flatMap(r => r.data.orderIds || []))] })) },
    friendPass: { total: settings.friendPass.total, issued: (store.promotionInvites || []).filter(i => i.voucherId).length,
      invites: (store.promotionInvites || []).map(i => inviteView(store, i, at)) }, budget: promotionBudget(store, at) };
}
