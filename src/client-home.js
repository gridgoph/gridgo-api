/**
 * The client Home smart tile (gridgo-client#335): one targeted read giving the
 * first state that applies — unfinished missions, an active order, an unused
 * tester voucher, otherwise an invite prompt — plus the facts each state shows.
 * Contract: docs/CLIENT_HOME_API.md. Pure read; never reconciles or issues rewards.
 */
import { publicFoundingTester } from './founding-testers.js';
import { publicVoucher } from './vouchers.js';
import { BUG_REPORT_REWARD_MINOR, bugReportRewardAvailable } from './bug-report-rewards.js';

export const HOME_ORDER_STEPS = Object.freeze(['placed', 'printing', 'on_the_way', 'delivered']);

// Order state -> 1-based step of the four-step bar. States not listed (draft,
// completed, payout_released, cancelled) are not active orders.
export const HOME_ORDER_STEP_BY_STATE = Object.freeze({
  submitted: 1, needs_qa: 1, client_correction: 1, initial_payment_review: 1, proof_approval: 1,
  approved_for_matching: 1, supplier_assigned: 1, supplier_accepted: 1, awaiting_checkout: 1,
  awaiting_initial_payment: 1, awaiting_downpayment: 1, downpayment_review: 1, payment_authorized: 1,
  production: 2, supplier_self_qc: 2,
  ready_for_dispatch: 3, rider_assigned: 3, picked_up: 3, out_for_delivery: 3, awaiting_collection: 3,
  delivered: 4, issue_window_open: 4,
});
const AWAITING_PAYMENT = new Set(['awaiting_checkout', 'awaiting_initial_payment', 'awaiting_downpayment']);
const DAY_SECONDS = 86400;

const validTime = value => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);

function statusSince(order) {
  const entries = (Array.isArray(order.timeline) ? order.timeline : []).filter(entry => entry?.state === order.state && validTime(entry.at));
  return entries.map(entry => entry.at).sort().at(-1) || validTime(order.updatedAt) || validTime(order.createdAt);
}

function orderSummary(order) {
  const step = HOME_ORDER_STEP_BY_STATE[order.state];
  const promisedAt = validTime(order.promiseBy) || validTime(order.promisedDate) || validTime(order.deadline);
  const statusAt = statusSince(order);
  const deliveredAt = step === 4
    ? validTime(order.issueWindowOpenedAt) || (order.timeline || []).find(entry => entry?.state === 'delivered' && validTime(entry.at))?.at || statusAt
    : null;
  const time = step === 4 ? { kind: 'delivered', at: deliveredAt }
    : promisedAt ? { kind: 'promised', at: promisedAt } : { kind: 'since', at: statusAt };
  return {
    orderId: order.id, state: order.state, step, stepKey: HOME_ORDER_STEPS[step - 1], stepCount: HOME_ORDER_STEPS.length,
    fulfillmentMode: order.fulfillmentMode ?? null, basketId: order.basketId ?? null,
    awaitingPayment: AWAITING_PAYMENT.has(order.state), promisedAt, statusAt, time,
  };
}

const byTime = (left, right) => (left == null) - (right == null) || String(left ?? '').localeCompare(String(right ?? ''));

/** In-progress orders first, soonest promise first; otherwise the latest delivery awaiting confirmation. */
export function activeOrders(store, clientId) {
  const rows = (store.orders || []).filter(order => order.clientId === clientId && HOME_ORDER_STEP_BY_STATE[order.state])
    .map(orderSummary);
  const inProgress = rows.filter(row => row.step < 4)
    .sort((a, b) => byTime(a.promisedAt, b.promisedAt) || String(b.statusAt ?? '').localeCompare(String(a.statusAt ?? ''))
      || a.orderId.localeCompare(b.orderId));
  const delivered = rows.filter(row => row.step === 4)
    .sort((a, b) => String(b.time.at ?? '').localeCompare(String(a.time.at ?? '')) || a.orderId.localeCompare(b.orderId));
  return [...inProgress, ...delivered];
}

/** The client's own programme vouchers: mission, referral (either side) and bug report. */
export function testerVoucherIds(store, clientId) {
  const ids = new Map();
  for (const reward of store.testerRewards || []) {
    if (reward.clientId === clientId && reward.voucherId) ids.set(reward.voucherId, reward.kind);
    if (reward.inviterId === clientId && reward.inviterVoucherId) ids.set(reward.inviterVoucherId, reward.kind);
  }
  const awarded = (store.foundingTesters || []).find(row => row.clientId === clientId)?.rewardVoucherId;
  if (awarded && !ids.has(awarded)) ids.set(awarded, 'mission');
  return ids;
}

export function unusedTesterVoucher(store, clientId, at) {
  const kinds = testerVoucherIds(store, clientId);
  const candidates = (store.vouchers || []).filter(voucher => voucher.clientId === clientId && kinds.has(voucher.id))
    .map(voucher => ({ voucher: publicVoucher(store, voucher, at), kind: kinds.get(voucher.id) }))
    .filter(({ voucher }) => voucher.status === 'available')
    .sort((a, b) => a.voucher.expiresAt.localeCompare(b.voucher.expiresAt) || a.voucher.id.localeCompare(b.voucher.id));
  const first = candidates[0];
  if (!first) return null;
  const { voucher, kind } = first;
  return {
    voucherId: voucher.id, kind, valueMinor: voucher.valueMinor, code: voucher.code ?? null,
    expiresAt: voucher.expiresAt, secondsRemaining: voucher.secondsRemaining,
    daysLeft: Math.ceil(voucher.secondsRemaining / DAY_SECONDS), redeemable: voucher.redeemable, reserved: Boolean(voucher.reservation),
  };
}

export function clientHomeSummary(store, clientId, at) {
  const tester = publicFoundingTester(store, clientId, at);
  const missions = {
    eligible: tester.eligible, label: tester.label, awardedAt: tester.awardedAt, missions: tester.missions,
    completedCount: tester.completedCount, total: Object.keys(tester.missions).length, rewardStatus: tester.rewardStatus,
  };
  const orders = activeOrders(store, clientId);
  const activeOrder = orders[0] || null;
  const testerVoucher = unusedTesterVoucher(store, clientId, at);
  const tile = missions.eligible && !missions.awardedAt && missions.completedCount < missions.total ? 'missions'
    : activeOrder ? 'active_order' : testerVoucher ? 'tester_voucher' : 'invite';
  return {
    serverTime: at, tile, missions, activeOrder, activeOrderCount: orders.length, testerVoucher,
    bugReport: { rewardAvailable: bugReportRewardAvailable(store, clientId), amountMinor: BUG_REPORT_REWARD_MINOR },
  };
}
