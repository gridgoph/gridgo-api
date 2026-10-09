import crypto from 'node:crypto';
import { voucherMoney } from './voucher-money.js';
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';
import { emptyVoucherStore } from './voucher-store.js';

export const voucherFail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
export function initVouchers(store) { for (const [key, value] of Object.entries(emptyVoucherStore())) store[key] ||= value; }
const expired = (expiresAt, at) => Date.parse(expiresAt) <= Date.parse(at);
const campaignFor = (store, voucher) => store.voucherCampaigns.find(c => c.id === voucher.campaignId);
export const normalizeVoucherCode = code => typeof code === 'string' ? code.trim().toUpperCase() : '';
export function voucherEvent(store, voucher, kind, { id, at, actorId = null, reason = null, amountMinor = 0, ...detail }) {
  store.voucherLedger.push({ id: id('vled'), voucherId: voucher.id, campaignId: voucher.campaignId, clientId: voucher.clientId,
    kind, amountMinor, at, data: { actorId, reason, ...detail } });
  store.auditLog ||= [];
  store.auditLog.push({ id: id('aud'), at, actorId, actorRole: (store.users || []).find(user => user.id === actorId)?.role || null,
    action: `voucher.${kind}`, entityType: 'voucher', entityId: voucher.id, detail: { amountMinor, ...detail }, reason });
  store.notifications ||= [];
  for (const membership of privilegedAdminMemberships(store)) store.notifications.push({ id: id('not'), userId: membership.userId,
    appRole: membership.role, type: `voucher_${kind}`, title: 'Voucher activity', body: `${campaignFor(store, voucher)?.name || 'Voucher'}: ${kind}.`, at, read: false });
}
function notice(store, voucher, kind, { id, at }) {
  const campaign = campaignFor(store, voucher);
  const title = kind === 'issued' ? 'Your GRIDGO voucher is ready' : 'Your GRIDGO voucher expires soon';
  const body = `${campaign.name}: PHP ${BigInt(voucher.valueMinor) / 100n}.${String(BigInt(voucher.valueMinor) % 100n).padStart(2, '0')}. Expires ${voucher.expiresAt}. Open your voucher wallet to use it.`;
  store.notifications ||= [];
  store.notifications.push({ id: id('not'), userId: voucher.clientId, appRole: 'client', type: `voucher_${kind}`, title, body, at, read: false,
    voucherId: voucher.id, ...(voucher.emailAllowed ? {} : { push: false }) });
  if (kind.startsWith('expiry_')) for (const membership of privilegedAdminMemberships(store)) store.notifications.push({ id: id('not'), userId: membership.userId,
    appRole: membership.role, type: `voucher_${kind}`, title: 'Voucher reminder', body: `${campaign.name}: ${kind}.`, at, read: false });
  queueInvalidate(store, { resource: 'notifications', userIds: [voucher.clientId] });
  const user = store.users.find(u => u.id === voucher.clientId);
  if (voucher.emailAllowed && user?.email) store.voucherEmailOutbox.push({ id: id('vmail'), voucherId: voucher.id,
    email: user.email, subject: title, body, status: 'pending', attempts: 0, nextAt: at, createdAt: at });
}
/** Internal reward hook. Caller holds the domain lock and saves notification/outbox atomically. */
export function issueVoucher(store, campaign, clientId, { id, at, actorId = null, adultConfirmed = false } = {}) {
  initVouchers(store);
  const prior = store.vouchers.find(v => v.campaignId === campaign.id && v.clientId === clientId);
  if (prior) return { voucher: prior, issued: false };
  if (campaign.status !== 'active' || (campaign.endsAt && expired(campaign.endsAt, at))) voucherFail(409, 'voucher_campaign_unavailable');
  if (!(store.userRoleMemberships || []).some(m => m.userId === clientId && m.role === 'client')) voucherFail(400, 'voucher_client_required');
  if (store.vouchers.filter(v => v.campaignId === campaign.id).length >= campaign.totalLimit) voucherFail(409, 'voucher_campaign_cap_reached');
  const voucher = { id: id('vch'), campaignId: campaign.id, clientId, status: 'available', valueMinor: campaign.valueMinor,
    issuedAt: at, expiresAt: campaign.endsAt || new Date(Date.parse(at) + campaign.validityDays * 86400000).toISOString(),
    emailAllowed: adultConfirmed === true, data: {} };
  store.vouchers.push(voucher);
  voucherEvent(store, voucher, 'issued', { id, at, actorId });
  notice(store, voucher, 'issued', { id, at });
  return { voucher, issued: true };
}
export function availableVouchers(store, clientId, at, cartId = null) {
  return (store.vouchers || []).filter(v => v.clientId === clientId && v.status === 'available' && !expired(v.expiresAt, at)
    && (campaignFor(store, v)?.status === 'active' || (cartId && (store.voucherReservations || []).some(r => r.voucherId === v.id
      && r.cartId === cartId && r.status === 'reserved' && !expired(r.expiresAt, at))))
    && !(store.voucherReservations || []).some(r => r.voucherId === v.id
      && r.status === 'reserved' && !expired(r.expiresAt, at) && r.cartId !== cartId));
}
export function selectVoucher(store, cart, groups, at) {
  const candidates = availableVouchers(store, cart.clientId, at, cart.id).filter(v => voucherMoney(groups, v.valueMinor).voucherDiscountMinor > 0);
  const choice = (store.voucherCartChoices || []).find(c => c.id === cart.id);
  if (choice?.removed) return null;
  if (choice?.voucherId) return candidates.find(v => v.id === choice.voucherId) || null;
  return candidates.length === 1 ? candidates[0] : null;
}
export function releaseVoucherReservations(store, { id, at }, predicate = () => true) {
  initVouchers(store);
  let changed = false;
  for (const reservation of store.voucherReservations.filter(r => r.status === 'reserved' && predicate(r))) {
    reservation.status = 'released'; reservation.data.releasedAt = at;
    const voucher = store.vouchers.find(v => v.id === reservation.voucherId);
    voucherEvent(store, voucher, 'released', { id, at, reservationId: reservation.id });
    changed = true;
  }
  return changed;
}
export function reserveVoucher(store, voucher, cart, { id, at, orderIds = [], amountMinor = 0 }) {
  releaseVoucherReservations(store, { id, at }, r => expired(r.expiresAt, at));
  if (!availableVouchers(store, cart.clientId, at, cart.id).some(v => v.id === voucher.id)) voucherFail(409, 'voucher_unavailable');
  let reservation = store.voucherReservations.find(r => r.cartId === cart.id && r.voucherId === voucher.id && r.status === 'reserved');
  if (reservation?.data.orderIds?.length) voucherFail(409, 'voucher_already_checked_out');
  releaseVoucherReservations(store, { id, at }, r => r.cartId === cart.id && r.voucherId !== voucher.id);
  if (!reservation) {
    reservation = { id: id('vres'), voucherId: voucher.id, clientId: cart.clientId, cartId: cart.id, status: 'reserved',
      createdAt: at, expiresAt: new Date(Math.min(Date.parse(voucher.expiresAt), Date.parse(at) + 30 * 60000)).toISOString(), data: {} };
    store.voucherReservations.push(reservation);
    voucherEvent(store, voucher, 'reserved', { id, at, reservationId: reservation.id });
  }
  Object.assign(reservation.data, { orderIds, amountMinor });
  return reservation;
}
export function confirmVoucher(store, orders, { id, at, actorId }) {
  initVouchers(store);
  const discounted = orders.filter(o => o.voucher);
  if (!discounted.length) return;
  const reservation = store.voucherReservations.find(r => r.data.orderIds?.includes(discounted[0].id));
  const voucher = store.vouchers.find(v => v.id === reservation?.voucherId);
  if (!voucher || voucher.status !== 'available' || reservation.status !== 'reserved'
    || expired(voucher.expiresAt, at) || expired(reservation.expiresAt, at)) voucherFail(409, 'voucher_expired_or_unavailable');
  if (reservation.data.orderIds.length !== orders.length || !orders.every(o => reservation.data.orderIds.includes(o.id))) voucherFail(409, 'voucher_payment_boundary_required');
  if (orders.some(o => o.state === 'cancelled')) voucherFail(409, 'voucher_cancelled_checkout');
  // Pausing stops new reservations; an existing valid promise is honored.
  reservation.status = 'consumed';
  voucher.status = 'used';
  const redemption = { id: id('vrd'), voucherId: voucher.id, reservationId: reservation.id, clientId: voucher.clientId,
    amountMinor: reservation.data.amountMinor, status: 'consumed', createdAt: at, data: { orderIds: [...reservation.data.orderIds] } };
  store.voucherRedemptions.push(redemption);
  voucherEvent(store, voucher, 'redeemed', { id, at, actorId, amountMinor: redemption.amountMinor, redemptionId: redemption.id, orderIds: redemption.data.orderIds });
}
export function restoreVoucherForRefund(store, order, { id, at, actorId, clientCaused, reason }) {
  initVouchers(store);
  if (!order.voucher) return;
  if (typeof clientCaused !== 'boolean') voucherFail(400, 'voucher_refund_fault_required');
  const redemption = store.voucherRedemptions.find(r => r.data.orderIds?.includes(order.id) && r.status === 'consumed');
  if (!redemption) return;
  redemption.data.refundDecisions ||= {};
  if (redemption.data.refundDecisions[order.id]) return;
  redemption.data.refundDecisions[order.id] = { clientCaused, reason, at, actorId };
  const voucher = store.vouchers.find(v => v.id === redemption.voucherId);
  voucherEvent(store, voucher, clientCaused ? 'client_fault' : 'no_fault', { id, at, actorId, reason, orderId: order.id });
  // One wallet item: restore only once all benefiting groups have a no-fault remedy.
  if (redemption.data.orderIds.every(orderId => redemption.data.refundDecisions[orderId]?.clientCaused === false)
    && !expired(voucher.expiresAt, at) && voucher.status === 'used') {
    voucher.status = 'available'; redemption.status = 'restored';
    voucherEvent(store, voucher, 'restored', { id, at, actorId, reason, amountMinor: -redemption.amountMinor, redemptionId: redemption.id });
  }
}
export function sweepVouchers(store, { id, at }) {
  let changed = releaseVoucherReservations(store, { id, at }, r => expired(r.expiresAt, at));
  for (const voucher of store.vouchers) {
    if (voucher.status !== 'available' || expired(voucher.expiresAt, at)) continue;
    const remaining = Date.parse(voucher.expiresAt) - Date.parse(at);
    for (const hours of [48, 24]) {
      const key = `reminded${hours}At`;
      if (remaining <= hours * 3600000 && remaining > (hours - 24) * 3600000 && !voucher.data[key]
        && Date.parse(voucher.issuedAt) < Date.parse(voucher.expiresAt) - hours * 3600000) {
        voucher.data[key] = at; notice(store, voucher, `expiry_${hours}h`, { id, at }); changed = true;
      }
    }
  }
  return changed;
}
export function addVoucherCode(store, clientId, code, { id, at }) {
  initVouchers(store);
  let attempt = store.voucherCodeAttempts.find(a => a.id === clientId);
  if (attempt?.lockedUntil && !expired(attempt.lockedUntil, at)) return { status: 429, body: { error: 'voucher_code_locked', retryAt: attempt.lockedUntil } };
  if (!attempt) { attempt = { id: clientId, windowAt: at, failures: 0, lockedUntil: null }; store.voucherCodeAttempts.push(attempt); }
  if (Date.parse(at) - Date.parse(attempt.windowAt) >= 3600000) Object.assign(attempt, { windowAt: at, failures: 0, lockedUntil: null });
  const normalized = normalizeVoucherCode(code);
  const campaign = store.voucherCampaigns.find(c => c.code === normalized && c.status === 'active' && c.mode === 'shared' && (!c.endsAt || !expired(c.endsAt, at)));
  if (!campaign) {
    attempt.failures++;
    if (attempt.failures >= 5) attempt.lockedUntil = new Date(Date.parse(at) + 15 * 60000).toISOString();
    return { status: attempt.failures >= 5 ? 429 : 400, body: { error: attempt.failures >= 5 ? 'voucher_code_locked' : 'voucher_code_invalid', ...(attempt.lockedUntil ? { retryAt: attempt.lockedUntil } : {}) }, mutated: true };
  }
  const result = issueVoucher(store, campaign, clientId, { id, at, actorId: clientId });
  return { status: 200, body: { voucher: publicVoucher(store, result.voucher, at), issued: result.issued }, mutated: true };
}
export function publicVoucher(store, voucher, at) {
  const reservation = store.voucherReservations.find(r => r.voucherId === voucher.id && r.status === 'reserved' && !expired(r.expiresAt, at));
  const status = voucher.status === 'available' && expired(voucher.expiresAt, at) ? 'expired' : voucher.status;
  return { id: voucher.id, campaignId: voucher.campaignId, name: campaignFor(store, voucher)?.name,
    valueMinor: voucher.valueMinor, status, issuedAt: voucher.issuedAt, expiresAt: voucher.expiresAt,
    secondsRemaining: Math.max(0, Math.ceil((Date.parse(voucher.expiresAt) - Date.parse(at)) / 1000)),
    redeemable: status === 'available' && !reservation && campaignFor(store, voucher)?.status === 'active',
    reservation: reservation ? { id: reservation.id, cartId: reservation.cartId, expiresAt: reservation.expiresAt } : null,
    fundedBy: 'GRIDGO', transferable: false, cashValue: false };
}
export const generatedVoucherCode = () => crypto.randomBytes(8).toString('hex').toUpperCase();

/** Unpaid cancellation releases the reservation; a client-caused cancellation forfeits it. */
export function cancelVoucherReservations(store, { id, at }) {
  for (const reservation of store.voucherReservations || []) {
    if (reservation.status !== 'reserved' || !reservation.data.orderIds?.length) continue;
    const orders = reservation.data.orderIds.map(orderId => store.orders.find(o => o.id === orderId));
    const cancelled = orders.filter(order => order?.state === 'cancelled');
    if (!cancelled.length) continue;
    const voucher = store.vouchers.find(v => v.id === reservation.voucherId);
    if (cancelled.some(order => order.cancelledBy === order.clientId)) {
      voucher.status = 'used';
      voucherEvent(store, voucher, 'client_fault', { id, at, reason: 'Client cancelled before payment confirmation', orderIds: reservation.data.orderIds });
    }
    releaseVoucherReservations(store, { id, at }, r => r.id === reservation.id);
  }
}
