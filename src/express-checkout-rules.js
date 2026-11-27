import { expressFeeSchedule } from './service-fee.js';
import { cashSettings } from './cash-policy.js';
import { shopMoneyPolicy } from './shop-money-policy.js';

/** Super Admin rules for accept-first Express. Defaults need no seed or migration. */
export const EXPRESS_CHECKOUT_DEFAULTS = Object.freeze({
  feeMinimumMinor: 500, feeRateBps: 2000,
  paymentConfirmation: 'manual',
  manualQrInstantMaxMinor: 30000, manualQrReviewMinutes: 3,
  manualQrReviewOpens: '08:00', manualQrReviewCloses: '17:00',
});
/** Fixed product timings; they are part of the flow contract, not settings. */
export const EXPRESS_ACCEPT_FIRST_MS = 60_000;
export const EXPRESS_PAY_WINDOW_MS = 5 * 60_000;
export const EXPRESS_SHOPS_PER_ROUND = 3;
export const EXPRESS_KEEP_TRYING_MS = 5 * 60_000;
export const EXPRESS_CLIENT_DECISION_MS = 10 * 60_000;

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const KEYS = Object.keys(EXPRESS_CHECKOUT_DEFAULTS);
const clock = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const minutesOf = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

export const expressCheckoutSettings = settings => ({ ...EXPRESS_CHECKOUT_DEFAULTS, ...(settings?.expressCheckout || {}) });

/** Partial patches keep omitted values. The gateway position needs a connected
 * payment gateway; none exists yet, so the switch stays on manual until it does. */
export function nextExpressCheckoutSettings(settings, patch, { gatewayConnected = false } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !KEYS.includes(key))) fail(400, 'invalid_express_checkout_settings');
  const next = { ...expressCheckoutSettings(settings), ...patch };
  const money = value => Number.isSafeInteger(value) && value >= 0;
  if (!money(next.feeMinimumMinor) || !Number.isInteger(next.feeRateBps) || next.feeRateBps < 0 || next.feeRateBps > 10000
    || !['manual', 'gateway'].includes(next.paymentConfirmation) || !money(next.manualQrInstantMaxMinor)
    || !Number.isInteger(next.manualQrReviewMinutes) || next.manualQrReviewMinutes < 1 || next.manualQrReviewMinutes > 60
    || !clock(next.manualQrReviewOpens) || !clock(next.manualQrReviewCloses)
    || minutesOf(next.manualQrReviewOpens) >= minutesOf(next.manualQrReviewCloses)) fail(400, 'invalid_express_checkout_settings');
  if (next.paymentConfirmation === 'gateway' && !gatewayConnected) fail(409, 'payment_gateway_not_configured');
  return next;
}

export function expressCheckoutFeeSchedule(settings) {
  const rules = expressCheckoutSettings(settings);
  return expressFeeSchedule({ minimumMinor: rules.feeMinimumMinor, rateBps: rules.feeRateBps });
}

/** Asia/Manila has no daylight saving: UTC+8 all year. */
export function manualReviewOpen(settings, at) {
  const rules = expressCheckoutSettings(settings);
  const local = new Date(Date.parse(at) + 8 * 3600000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return minute >= minutesOf(rules.manualQrReviewOpens) && minute < minutesOf(rules.manualQrReviewCloses);
}

export const isAcceptFirst = order => order?.orderType === 'express' && order.expressOrder?.acceptFlow === 2;
export const isHomePrinterOrder = order => Boolean(order?.homePrinter && order.homePrinter.supplierId === order.supplierId);

/** Home printers are capped while QR is confirmed by hand; checked on the client's total. */
export function homePrinterLimitMinor(settings) {
  const rules = expressCheckoutSettings(settings);
  return rules.paymentConfirmation === 'manual' ? rules.manualQrInstantMaxMinor : null;
}

/**
 * The payment choices shown after the shop accepts. Cash at pickup is the default
 * only where cash payments are switched on (platform cash switch and the shop's
 * counter-cash policy) and never for a home printer. QR above the instant limit
 * needs a person, so it is offered only during review hours.
 */
export function expressPaymentOptions(store, order, client, at) {
  const rules = expressCheckoutSettings(store.settings);
  const amountMinor = order.payments?.initial?.amountMinor ?? order.totalMinor;
  const home = isHomePrinterOrder(order);
  const cash = cashSettings(store.settings);
  const cashReason = home ? 'home_printer_qr_only'
    : order.fulfillmentMode !== 'pickup' ? 'cash_pickup_only'
      : cash.enabled !== true ? 'cash_disabled'
        : !shopMoneyPolicy(store, order.supplierId).counterCashEnabled ? 'shop_cash_disabled'
          : client?.accountType !== 'individual' ? 'cash_individual_only'
            : !(amountMinor < cash.limitMinor) ? 'cash_limit_exceeded'
              : amountMinor <= 0 ? 'cash_payment_not_required' : null;
  const instant = rules.paymentConfirmation === 'gateway' || amountMinor <= rules.manualQrInstantMaxMinor;
  const reviewOpen = manualReviewOpen(store.settings, at);
  const qrReason = amountMinor <= 0 ? 'payment_not_required'
    : !instant && !reviewOpen ? 'manual_review_closed'
      : home && rules.paymentConfirmation === 'manual' && amountMinor > rules.manualQrInstantMaxMinor ? 'home_printer_order_limit' : null;
  const methods = [
    { method: 'cash_at_pickup', available: cashReason === null, reason: cashReason },
    { method: 'qr_ph', available: qrReason === null, reason: qrReason, confirmation: rules.paymentConfirmation,
      shopStartsOnReceipt: instant, reviewMinutes: instant ? null : rules.manualQrReviewMinutes,
      instantMaxMinor: rules.paymentConfirmation === 'manual' ? rules.manualQrInstantMaxMinor : null,
      reviewHours: { opens: rules.manualQrReviewOpens, closes: rules.manualQrReviewCloses, timeZone: 'Asia/Manila' } },
  ];
  const preferred = methods.find(row => row.available)?.method ?? null;
  return { amountMinor, payBy: order.expressOrder?.payBy ?? null, defaultMethod: preferred, methods };
}

/** Canonical resolved accept-first offers shared by rankings and performance.
 * Periods use assignment time; outcomes must already have happened at the cutoff.
 * An unswept one-minute expiry is a miss, never an open offer forever. */
export function expressOfferOutcomes(store, supplierId, at, { since = Date.parse(at) - 30 * 86400000, until = Date.parse(at) + 1 } = {}) {
  const cutoff = Date.parse(at);
  const rows = [];
  for (const order of store.orders || []) {
    const offer = order.shopAcceptance;
    if (!isAcceptFirst(order) || order.reviewData === true || order.removedAt || offer?.supplierId !== supplierId) continue;
    const assigned = Date.parse(offer.assignedAt);
    if (!(assigned >= since && assigned < until && assigned <= cutoff)) continue;
    let status = offer.status;
    let answerAt = status === 'accepted' ? offer.acceptedAt
      : order.expressOrder.events?.find(event => event.state === status && event.supplierId === supplierId && Date.parse(event.at) >= assigned)?.at;
    if (status === 'pending' && order.state === 'supplier_assigned' && Date.parse(offer.deadlineAt) <= cutoff) status = 'timed_out';
    if (status === 'timed_out') answerAt = offer.deadlineAt;
    if (!['accepted', 'declined', 'timed_out'].includes(status)) continue;
    // Historical legacy rows sometimes have no answer timestamp. They still
    // count in acceptance; missing timing evidence earns no speed credit.
    if (answerAt && Date.parse(answerAt) > cutoff) continue;
    const elapsed = Date.parse(answerAt) - assigned;
    rows.push({ order, status, answerSeconds: elapsed >= 0 ? Math.min(60, elapsed / 1000) : null });
  }
  return rows;
}

/** Same 30-day accept rate for shop summaries, performance and missed-job policy.
 * An explicit period lets the leaderboard consume the identical offer rules. */
export function expressAcceptRate(store, supplierId, at, period) {
  const row = { ...(period ? {} : { windowDays: 30 }), offered: 0, accepted: 0, declined: 0, timedOut: 0, rate: null };
  for (const offer of expressOfferOutcomes(store, supplierId, at, period)) {
    row.offered++;
    row[{ accepted: 'accepted', declined: 'declined', timed_out: 'timedOut' }[offer.status]]++;
  }
  if (row.offered) row.rate = Number((row.accepted / row.offered).toFixed(4));
  return row;
}
