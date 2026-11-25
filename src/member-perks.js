import { approvedOrganization } from './organization-money.js';
import { splitVoucherMinor } from './voucher-money.js';
import { sumMinor } from './refund-policy.js';
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';
import { isReviewData } from './review-data.js';

export const memberFail = (status, code, message, details = {}) => {
  throw Object.assign(new Error(message || code), { status, code, details });
};
const MANILA_MS = 8 * 3600000;
export const manilaDay = at => new Date(Date.parse(at) + MANILA_MS).toISOString().slice(0, 10);

/** A term is one school year, 1 June to 31 May, Manila time. `endsAt` is exclusive. */
export function schoolYear(at) {
  const day = manilaDay(at), start = Number(day.slice(0, 4)) - (Number(day.slice(5, 7)) < 6 ? 1 : 0);
  return termFor(start);
}
function termFor(start) {
  const code = `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
  return { code, label: `SY ${code}`, startsAt: new Date(`${start}-06-01T00:00:00+08:00`).toISOString(),
    endsOn: `${start + 1}-05-31`, endsAt: new Date(`${start + 1}-06-01T00:00:00+08:00`).toISOString() };
}
export const termFromCode = code => termFor(Number(code.slice(0, 4)));

export function partnerFor(store, organizationUserId) {
  const partner = (store.organizationPartners || []).find(row => row.userId === organizationUserId);
  const owner = (store.users || []).find(row => row.id === organizationUserId);
  // A partner whose verification, account or officer of record lapsed is not live.
  const officer = (store.organizationAccounts || []).find(row => row.userId === organizationUserId)?.currentOfficer;
  return partner?.status === 'active' && owner && officer && approvedOrganization(store, organizationUserId) ? partner : null;
}
export const membershipLive = (row, at) => row.status === 'active' && Date.parse(row.termEndsAt) > Date.parse(at);

/** An organization's own row replaces the standard perk completely, including turning it off. */
export function perkSettingFor(store, organizationUserId) {
  const rows = store.memberPerkSettings || [];
  return rows.find(row => row.organizationUserId === organizationUserId) || rows.find(row => row.id === 'standard') || null;
}
export function activePerk(store, organizationUserId, at) {
  const perk = perkSettingFor(store, organizationUserId);
  return perk?.enabled && Date.parse(perk.endsAt) > Date.parse(at) ? perk : null;
}
const kept = row => row.status !== 'returned';
export const perkUses = (store, membership, term = membership.term) => (store.memberPerkUses || [])
  .filter(row => row.membershipId === membership.id && row.term === term && kept(row));
export const perkSpentMinor = (store, organizationUserId) => sumMinor((store.memberPerkUses || [])
  .filter(row => row.organizationUserId === organizationUserId && kept(row)).map(row => row.amountMinor));

/** What one live membership gives at checkout now, before the fee cap. Null when it gives nothing. */
export function usablePerk(store, membership, at) {
  if (!membershipLive(membership, at) || !partnerFor(store, membership.organizationUserId)) return null;
  const client = store.users.find(row => row.id === membership.clientId);
  const organization = store.users.find(row => row.id === membership.organizationUserId);
  // Review data never spends GRIDGO money.
  if (!client || isReviewData(client) || isReviewData(organization)) return null;
  const perk = activePerk(store, membership.organizationUserId, at);
  if (!perk) return null;
  const used = perkUses(store, membership).length;
  if (used >= perk.maxOrdersPerTerm) return null;
  return { perk, used, remainingBudgetMinor: Math.max(0, perk.budgetCapMinor - perkSpentMinor(store, membership.organizationUserId)) };
}

/** The single largest usable perk for this checkout. GRIDGO's own service fee is the ceiling. */
export function selectMemberPerk(store, clientId, money, at) {
  const feeMinor = sumMinor(money.map(group => group.grossServiceFeeMinor ?? group.serviceFeeMinor));
  const choices = [];
  for (const membership of (store.organizationMemberships || []).filter(row => row.clientId === clientId)) {
    const usable = usablePerk(store, membership, at);
    if (!usable) continue;
    const amountMinor = Math.min(usable.perk.amountMinor, feeMinor);
    if (amountMinor <= 0 || amountMinor > usable.remainingBudgetMinor) continue;
    choices.push({ membership, perk: usable.perk, amountMinor, useNumber: usable.used + 1 });
  }
  return choices.sort((a, b) => b.amountMinor - a.amountMinor
    || a.membership.createdAt.localeCompare(b.membership.createdAt) || a.membership.id.localeCompare(b.membership.id))[0] || null;
}
/** Groups repriced with the perk instead of the organization discount. */
export function withMemberPerk(money, choice) {
  const shares = splitVoucherMinor(choice.amountMinor, money.map(group => group.grossServiceFeeMinor));
  return money.map((group, index) => ({ ...group, organizationDiscountRateBps: 0, organizationDiscountMinor: 0,
    memberPerkMinor: shares[index], serviceFeeMinor: group.grossServiceFeeMinor - shares[index] }));
}
export function perkLabel(store, organizationUserId) {
  return `${(store.organizationPartners || []).find(row => row.userId === organizationUserId)?.label || 'Organization'} member`;
}
export function publicPerkChoice(store, choice) {
  return choice && { membershipId: choice.membership.id, label: perkLabel(store, choice.membership.organizationUserId),
    amountMinor: choice.amountMinor, useNumber: choice.useNumber, maxOrdersPerTerm: choice.perk.maxOrdersPerTerm, fundedBy: 'GRIDGO' };
}
/** Immutable order snapshot: later perk or membership changes never reprice it. */
export function perkSnapshot(store, choice, useId, amountMinor) {
  return { useId, membershipId: choice.membership.id, organizationUserId: choice.membership.organizationUserId,
    label: perkLabel(store, choice.membership.organizationUserId), term: choice.membership.term, amountMinor,
    checkoutAmountMinor: choice.amountMinor, useNumber: choice.useNumber, maxOrdersPerTerm: choice.perk.maxOrdersPerTerm,
    perkVersion: choice.perk.version, fundedBy: 'GRIDGO' };
}

/** Audit and staff inbox for a member event. Copy never carries a member name or contact. */
export function memberEvent(store, type, { id, at, actor = null, entityId, entityType = 'organization_membership', organizationUserId, detail = {}, reason = null,
  before, after, notify = [], staffBody = null }) {
  (store.auditLog ||= []).push({ id: id('aud'), at, actorId: actor?.id || null, actorRole: actor?.role || (actor ? null : 'system'),
    action: type, entityType, entityId, reason, detail: { organizationUserId, ...detail },
    ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });
  store.notifications ||= [];
  for (const notice of notify) store.notifications.push({ id: id('ntf'), at, appRole: 'client', type, read: false,
    organizationUserId, membershipId: entityType === 'organization_membership' ? entityId : null, ...notice });
  if (staffBody) for (const admin of privilegedAdminMemberships(store)) store.notifications.push({ id: id('ntf'), at, userId: admin.userId, appRole: admin.role,
    type, title: 'Organization members', body: staffBody, read: false, organizationUserId });
  const userIds = [...new Set([organizationUserId, ...notify.map(notice => notice.userId)].filter(Boolean))];
  if (userIds.length) queueInvalidate(store, { resource: 'identity', id: entityId, userIds });
}

/** Count one use for the whole payment boundary. Runs in the checkout transaction. */
export function reserveMemberPerk(store, choice, useId, orders, { id, at }) {
  (store.memberPerkUses ||= []).push({ id: useId, membershipId: choice.membership.id, organizationUserId: choice.membership.organizationUserId,
    clientId: choice.membership.clientId, term: choice.membership.term, amountMinor: choice.amountMinor, status: 'reserved', createdAt: at,
    data: { orderIds: orders.map(order => order.id) } });
  memberEvent(store, 'member_perk.reserved', { id, at, actor: store.users.find(row => row.id === choice.membership.clientId), entityType: 'member_perk_use',
    entityId: useId, organizationUserId: choice.membership.organizationUserId, detail: { orderIds: orders.map(order => order.id), amountMinor: choice.amountMinor } });
}
function returnUse(store, use, reason, { id, at, actorId = null }) {
  use.status = 'returned';
  use.data = { ...use.data, returnedAt: at, returnReason: reason };
  memberEvent(store, 'member_perk.returned', { id, at, actor: store.users.find(row => row.id === actorId) || null, entityType: 'member_perk_use',
    entityId: use.id, organizationUserId: use.organizationUserId, reason, detail: { orderIds: use.data.orderIds, amountMinor: use.amountMinor },
    notify: [{ userId: use.clientId, orderId: use.data.orderIds[0], title: 'Member perk returned', body: 'Your member perk use was returned to you.' }],
    staffBody: 'A member perk use was returned.' });
}
/** A superseded quote was never payable, so its use goes back before the next acceptance picks again. */
export function releaseMemberPerk(store, order, reason, { id, at, actorId = null }) {
  const use = (store.memberPerkUses || []).find(row => row.id === order.memberPerk?.useId);
  if (use?.status === 'reserved') returnUse(store, use, reason, { id, at, actorId });
  delete order.memberPerk; delete order.memberPerkMinor;
}
const initialPaid = order => order.payments?.initial?.status === 'confirmed';

/**
 * Settle the perk ledger from order facts on every save: an order cancelled before
 * any payment returns the use and its budget; the first confirmed payment confirms it.
 * A scoped save holds only some orders, so a use with unseen orders is left alone.
 */
export function reconcileMemberPerks(store, { id, at }) {
  let changed = false;
  for (const use of store.memberPerkUses || []) {
    if (use.status !== 'reserved') continue;
    const orders = use.data.orderIds.map(orderId => (store.orders || []).find(order => order.id === orderId));
    if (!orders.length || orders.some(order => !order)) continue;
    if (orders.some(initialPaid)) {
      use.status = 'confirmed'; use.data = { ...use.data, confirmedAt: at }; changed = true;
      memberEvent(store, 'member_perk.confirmed', { id, at, entityType: 'member_perk_use', entityId: use.id,
        organizationUserId: use.organizationUserId, detail: { orderIds: use.data.orderIds, amountMinor: use.amountMinor } });
    } else if (orders.every(order => order.state === 'cancelled')) { returnUse(store, use, 'order_cancelled_before_payment', { id, at }); changed = true; }
  }
  return changed;
}
/** After payment the use comes back only when every order it served was cancelled through no client fault. */
export function restoreMemberPerkForRefund(store, order, { id, at, actorId, clientCaused, reason }) {
  if (!order.memberPerk || typeof clientCaused !== 'boolean') return;
  const use = (store.memberPerkUses || []).find(row => row.id === order.memberPerk.useId);
  if (!use || use.status === 'returned' || use.data.refundDecisions?.[order.id]) return;
  use.data = { ...use.data, refundDecisions: { ...use.data.refundDecisions, [order.id]: { clientCaused, reason, at, actorId } } };
  const orders = use.data.orderIds.map(orderId => store.orders.find(row => row.id === orderId));
  if (orders.every(row => row?.state === 'cancelled' && (use.data.refundDecisions[row.id]?.clientCaused === false || !initialPaid(row)))) {
    returnUse(store, use, 'cancelled_no_client_fault', { id, at, actorId });
  }
}

export function perkOffer(store, organizationUserId, at) {
  const perk = partnerFor(store, organizationUserId) && activePerk(store, organizationUserId, at);
  if (!perk) return null;
  const term = schoolYear(at);
  const left = perk.budgetCapMinor - perkSpentMinor(store, organizationUserId);
  return { amountMinor: perk.amountMinor, maxOrdersPerTerm: perk.maxOrdersPerTerm, currency: 'PHP', fundedBy: 'GRIDGO',
    validUntil: Date.parse(perk.endsAt) < Date.parse(term.endsAt) ? perk.endsAt : term.endsAt, budgetAvailable: left > 0 };
}
