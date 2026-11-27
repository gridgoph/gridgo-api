import { nearestTopShopOrder } from './shop-leaderboard-months.js';
import { EXPRESS_ACCEPTED_ORIGINAL } from './express-shop-pricing.js';
import { expressFail as fail, startExpressAcceptance, onAcceptFirstRefusal, publicExpress, declineExpress } from './express-orders.js';
import { PICKUP_PIN_VERSION } from './pickup-pin.js';
import { createExpressDraft, checkoutBasket, quotedExpressPrinters, withClientCatalog } from './order-match-routes.js';
import { notifyOrderParties, notifyOpsPaymentSubmitted } from './client-order-notifications.js';
import { privilegedAdminMemberships, queueOrderInvalidate } from './notifications.js';
import { releaseVoucherReservations, confirmVoucher } from './vouchers.js';
import { releaseMemberPerk } from './member-perks.js';
import { clientPaymentSnapshot } from './shop-payment-method.js';
import { approvalPolicy } from './approval-proof.js';
import { paymentSettled } from './operational-model.js';
import { EXPRESS_PAY_WINDOW_MS, EXPRESS_SHOPS_PER_ROUND, EXPRESS_KEEP_TRYING_MS, EXPRESS_CLIENT_DECISION_MS,
  expressPaymentOptions, expressCheckoutSettings, isAcceptFirst } from './express-checkout-rules.js';

/*
 * Accept-first Express (expressOrder.acceptFlow 2). The client sends, the shop has
 * one minute, and the client pays only after it accepts. Each shop attempt is its
 * own order because order lines and prices are immutable once committed; attempts
 * share expressOrder.requestId and link previousOrderId / reroute.nextOrderId.
 * A refused attempt is cancelled without charge and the next shop is asked in the
 * client's own sort order: same or lower price moves automatically, anything
 * higher waits for the client. At most three shops are asked per round.
 */
const ZONES = ['A', 'B', 'C'];
const HELD = ['price_check', 'exhausted', 'retrying'];
const RETRY_EVERY_MS = 30_000;
const iso = ms => new Date(ms).toISOString();

export function beginAcceptFirst(store, order, { at, createId }) {
  const e = order.expressOrder;
  e.requestId ||= order.id;
  e.attempt ||= 1;
  e.routing.triedSupplierIds = [...new Set([...(e.routing.triedSupplierIds || []), order.supplierId])];
  // Uploads are checked automatically at upload and checkout; nobody reviews Express files by hand.
  order.fileCheck = { status: 'passed', requestedAt: at, reviewedAt: at, reviewedBy: null, reason: null, checklist: null, automatic: true };
  order.state = 'supplier_assigned';
  startExpressAcceptance(order, at, store.settings);
  order.timeline.push({ at, state: 'supplier_assigned', by: 'system', note: `Sent to the shop. It has ${order.shopAcceptance.windowSeconds} seconds to accept; the client pays after it accepts.` });
  // Files are cleared automatically, so the job is ready for the shop the moment it accepts.
  for (const job of store.orderJobs || []) if (job.orderId === order.id) { job.state = 'approved_for_production'; job.updatedAt = at; }
  notifyOrderParties(store, order, { createId, at });
  queueOrderInvalidate(store, order, ['orders', 'jobs', 'notifications']);
}

/** Refuse a send that could never be paid for, before any shop is asked. */
export function assertAcceptFirstPayable(store, order, client, at) {
  if (order.payments?.initial && paymentSettled(order.payments.initial)) return;
  const options = expressPaymentOptions(store, order, client, at);
  if (!options.methods.some(row => row.available)) {
    fail(409, 'express_payment_unavailable');
  }
}

const clientOf = (store, order) => {
  const user = (store.users || []).find(row => row.id === order.clientId);
  return user ? { ...user, role: 'client' } : null;
};
const agreed = order => ({
  printingFeeMinor: order.supplierSubtotalMinor + (order.grossServiceFeeMinor ?? order.serviceFeeMinor),
  deliveryFeeMinor: order.deliveryFeeMinor || 0,
});
function notifyClient(store, order, type, title, body, { at, id }) {
  for (const recipient of [{ userId: order.clientId, role: 'client' }, ...privilegedAdminMemberships(store)]) {
    (store.notifications ||= []).push({ id: id('ntf'), at, userId: recipient.userId, appRole: recipient.role, type, orderId: order.id, title, body, read: false });
  }
  queueOrderInvalidate(store, order, ['orders', 'notifications']);
}
function audit(store, order, action, { at, id, actorId = null, detail = {} }) {
  (store.auditLog ||= []).push({ id: id('aud'), at, actorId, actorRole: actorId ? 'client' : 'system', action: `express.${action}`,
    entityType: 'order', entityId: order.id, orderId: order.id, detail: { requestId: order.expressOrder.requestId, ...detail } });
}

function draftBody(order) {
  const e = order.expressOrder, r = e.routing;
  return {
    acceptFirst: true, fulfillmentMode: order.fulfillmentMode, location: { lat: e.location.lat, lng: e.location.lng },
    ...(order.fulfillmentMode === 'delivery' ? { dropoff: { lat: order.dropoff.lat, lng: order.dropoff.lng, label: order.dropoff.label } } : {}),
    productType: r.productType || 'documents', sort: r.sort, shopsOnly: r.shopsOnly === true, verifiedOnly: r.verifiedOnly === true,
    files: e.printSettings.map(print => ({ fileId: print.sourceFileId || print.fileId, copies: print.copies, colour: print.colour, paper: print.paper, sides: print.sides,
      // The shop receives a prepared PDF; re-price from its private original so
      // selected pages and layout are applied exactly once at every attempt.
      ...(print.printVersion === 2 ? { printVersion:2, previewKey:print.analysisKey, [EXPRESS_ACCEPTED_ORIGINAL]:print.renderStatus==='fallback', colourMode:print.colourMode, colourPages:print.colourPages,
        orientation:print.orientation, planType:print.planType } : {}),
      layout: print.layout, note: print.note || undefined, acceptedWarnings: print.acceptedWarnings || [], pageRange: print.pages?.range ?? null })),
  };
}

const sorters = {
  readyAt: (a, b) => Date.parse(a.readyAt || '9999-01-01') - Date.parse(b.readyAt || '9999-01-01'),
  rating: (a, b) => (b.rating?.average || 0) - (a.rating?.average || 0),
  jobs: (a, b) => (a.jobsAhead ?? 0) - (b.jobsAhead ?? 0),
  total: (a, b) => clientTotal(a) - clientTotal(b),
};
const SORT_BY = { fastest: 'readyAt', ready_soonest: 'readyAt', top_rated: 'rating', fewest_jobs: 'jobs', lowest_price: 'total', cheapest: 'total' };
const clientTotal = row => row.quote.printingMinor + row.quote.gridgoFeeMinor + (row.quote.deliveryFeeMinor || 0);

/** Printers able to take this exact request now, in the client's own list order. */
function quotedCandidates(store, order, at) {
  const client = clientOf(store, order);
  if (!client) return [];
  const rows = withClientCatalog(store, client, () => quotedExpressPrinters(store, client, { ...draftBody(order), sort: 'all_davao' }, at).shops)
    .filter(row => row.selectable && row.quote?.status === 'priced' && Number.isSafeInteger(row.quote.printingMinor));
  const by = sorters[SORT_BY[order.expressOrder.routing.sort]];
  return rows.sort((a, b) => nearestTopShopOrder(order.expressOrder.routing.sort,a,b) || (by ? by(a, b) : 0) || (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity) || a.supplierId.localeCompare(b.supplierId));
}
function candidateView(row, order) {
  return { supplierId: row.supplierId, name: row.name, printerType: row.printerType, verified: row.verified === true,
    distanceMeters: row.distanceMeters, zone: row.zone?.code ?? null, readyAt: row.readyAt ?? null,
    printingMinor: row.quote.printingMinor, gridgoFeeMinor: row.quote.gridgoFeeMinor, deliveryFeeMinor: row.quote.deliveryFeeMinor || 0,
    totalMinor: row.quote.totalMinor, previousTotalMinor: order.totalMinor };
}
function inScope(row, routing) {
  const nearby = ZONES.indexOf(routing.nearbyZone || 'A');
  const zone = ZONES.indexOf(row.zone?.code);
  return routing.scope === 'away' ? zone > nearby : zone >= 0 && zone <= nearby;
}
function withinAgreedPrice(row, order) {
  const was = agreed(order), allowance = Math.max(was.deliveryFeeMinor, order.expressOrder.routing.deliveryAllowanceMinor || 0);
  return row.quote.printingMinor + row.quote.gridgoFeeMinor <= was.printingFeeMinor && (row.quote.deliveryFeeMinor || 0) <= allowance;
}

function hold(store, order, status, ctx, extra = {}) {
  const e = order.expressOrder;
  e.reroute = { status, at: ctx.at, expiresAt: iso(Date.parse(ctx.at) + EXPRESS_CLIENT_DECISION_MS), ...extra };
  order.updatedAt = ctx.at;
  audit(store, order, `reroute_${status}`, { ...ctx, detail: { candidate: extra.candidate?.supplierId ?? null } });
  const copy = status === 'price_check'
    ? ['express_reroute_price_check', 'A shop is ready for your print at a different price', 'Choose whether to send it there. Nothing was charged.']
    : status === 'retrying' ? null
      : ['express_reroute_exhausted', 'No shop took your print yet', 'Choose what to do next. Nothing was charged.'];
  if (copy) notifyClient(store, order, ...copy, ctx);
  else queueOrderInvalidate(store, order, ['orders']);
}

/** Cancel an unpaid attempt or request; nothing was charged. */
function closeAttempt(store, order, { at, id }, { reason, by = null, reroute }) {
  const e = order.expressOrder;
  // The voucher returns to the client without forfeit; the member perk returns on save.
  releaseVoucherReservations(store, { id, at }, row => row.data?.orderIds?.includes(order.id));
  order.state = 'cancelled'; order.cancelledAt = at; order.cancelledBy = by; order.cancellationReason = reason;
  if (reroute) e.reroute = reroute;
  e.refundRequired = Object.values(order.payments || {}).some(p => p.status === 'confirmed');
  for (const job of store.orderJobs || []) if (job.orderId === order.id) { job.state = 'cancelled'; job.updatedAt = at; }
  order.timeline.push({ at, state: 'cancelled', by: by || 'system', note: reason });
  order.updatedAt = at;
  queueOrderInvalidate(store, order, ['orders', 'jobs']);
}

/** Cancel-and-replace on a probe first, so a failed move never loses the shop's refusal. */
function moveTo(store, order, supplierId, ctx, { consent, newRound = false, approval = null, expectedTotalMinor = null, deliveryAllowanceMinor }) {
  let probe = null;
  try { probe = structuredClone(store); } catch { probe = null; }
  if (probe) performMove(probe, probe.orders.find(row => row.id === order.id), supplierId, ctx, { consent, newRound, approval, expectedTotalMinor, deliveryAllowanceMinor });
  return performMove(store, order, supplierId, ctx, { consent, newRound, approval, expectedTotalMinor, deliveryAllowanceMinor });
}
function performMove(store, order, supplierId, ctx, { consent, newRound, approval, expectedTotalMinor, deliveryAllowanceMinor }) {
  const { at, id } = ctx, e = order.expressOrder, client = clientOf(store, order);
  if (!client) fail(409, 'express_client_unavailable');
  const oldCart = (store.carts || []).find(cart => cart.checkedOutOrderId === order.id);
  releaseVoucherReservations(store, { id, at }, row => row.data?.orderIds?.includes(order.id));
  if (order.memberPerk) releaseMemberPerk(store, { memberPerk: structuredClone(order.memberPerk) }, 'express_moved', { id, at });
  const next = withClientCatalog(store, client, () => {
    const draft = createExpressDraft(store, client, { ...draftBody(order), supplierId }, id, at).body;
    const cart = store.carts.find(row => row.id === draft.cartId);
    const choice = oldCart && (store.voucherCartChoices || []).find(row => row.id === oldCart.id);
    if (choice) store.voucherCartChoices.push({ ...structuredClone(choice), id: cart.id });
    // Keep the client's hand-over choice: an "I'm on my way" PIN order stays one (src/pickup-pin.js).
    const pin = e.handoverVersion === PICKUP_PIN_VERSION ? { expressPickupPin: 'on_my_way' } : {};
    const result = checkoutBasket(store, client, cart, { looksRight: true, expressConfirmation: draft.confirmation, ...pin, ...(approval ? { approval } : {}) }, id, at, { method: 'POST', headers: {} });
    return store.orders.find(row => row.id === result.order.id);
  });
  if (expectedTotalMinor != null && next.totalMinor !== expectedTotalMinor) {
    fail(409, 'express_price_changed');
  }
  const n = next.expressOrder;
  n.requestId = e.requestId; n.attempt = (e.attempt || 1) + 1; n.previousOrderId = order.id;
  n.routing = { ...structuredClone(e.routing), triedSupplierIds: [...new Set([...(e.routing.triedSupplierIds || []), supplierId])],
    roundAsked: newRound ? 1 : (e.routing.roundAsked ?? 1) + 1, round: (e.routing.round || 1) + (newRound ? 1 : 0),
    ...(deliveryAllowanceMinor != null ? { deliveryAllowanceMinor } : {}) };
  closeAttempt(store, order, ctx, { reason: 'Sent to another printer. Nothing was charged.',
    reroute: { status: 'moved', at, nextOrderId: next.id, consent } });
  audit(store, order, 'rerouted', { ...ctx, detail: { from: order.supplierId, to: supplierId, nextOrderId: next.id, consent } });
  notifyClient(store, next, 'express_rerouted', 'Asking another shop',
    `Shop ${n.routing.roundAsked} of ${EXPRESS_SHOPS_PER_ROUND} is checking your print.`, ctx);
  return next;
}

/** Ask the next shop, hold for the client, or offer the after-three options. */
function advance(store, order, ctx) {
  const e = order.expressOrder, r = e.routing;
  if (Object.values(order.payments || {}).some(p => p.status === 'confirmed')) {
    // A voucher-covered attempt already settled: keep the legacy outcome (refund, choose again).
    e.repickRequired = true;
    closeAttempt(store, order, ctx, { reason: 'No Express shop accepted the order.' });
    return null;
  }
  const rows = quotedCandidates(store, order, ctx.at);
  if (!r.nearbyZone) r.nearbyZone = rows.find(row => row.supplierId === order.supplierId)?.zone?.code
    || (e.printerZone?.key ? ({ nearby: 'A', away: 'B', long_distance: 'C' })[e.printerZone.key] : null) || 'A';
  const fresh = rows.filter(row => !(r.triedSupplierIds || []).includes(row.supplierId));
  const awayPreview = () => {
    const row = fresh.find(item => inScope(item, { ...r, scope: 'away' }));
    return row ? { deliveryFeeMinor: row.quote.deliveryFeeMinor || 0, available: true } : { deliveryFeeMinor: null, available: false };
  };
  if ((r.roundAsked ?? 1) >= EXPRESS_SHOPS_PER_ROUND) { hold(store, order, 'exhausted', ctx, { searchAway: awayPreview() }); return null; }
  for (const row of fresh.filter(item => inScope(item, r))) {
    if (!withinAgreedPrice(row, order) || approvalPolicy(store.settings).required) {
      hold(store, order, 'price_check', ctx, { candidate: candidateView(row, order), approvalRequired: approvalPolicy(store.settings).required });
      return null;
    }
    try { return moveTo(store, order, row.supplierId, ctx, { consent: 'automatic' }); }
    catch (error) { if (!error.status) throw error; r.triedSupplierIds = [...(r.triedSupplierIds || []), row.supplierId]; }
  }
  if (e.reroute?.status === 'retrying') return null;
  hold(store, order, 'exhausted', ctx, { searchAway: awayPreview() });
  return null;
}

function refusal(store, order, { at, id, kind, actorId }) {
  // The timeout transition already applied the missed-offer availability policy.
  audit(store, order, kind, { at, id, actorId, detail: { supplierId: order.supplierId } });
  order.expressOrder.reroute = { status: 'searching', at };
  advance(store, order, { at, id });
}
onAcceptFirstRefusal(refusal);

const heldOrder = (store, user, orderId) => {
  const order = (store.orders || []).find(row => row.id === orderId);
  if (!order || !isAcceptFirst(order)) fail(404, 'order_not_found');
  if (user?.role !== 'client' || order.clientId !== user.id) fail(403, 'forbidden');
  return order;
};

/** Client answers: accept a pricier shop, pick one, widen, keep trying or cancel. */
function rerouteAction(store, user, order, body, ctx) {
  const e = order.expressOrder, r = e.routing, status = e.reroute?.status;
  if (order.state !== 'supplier_assigned' || !HELD.includes(status)) fail(409, 'express_reroute_not_waiting');
  const action = body.action;
  if (action === 'accept') {
    if (status !== 'price_check') fail(409, 'express_reroute_not_waiting');
    if (!Number.isSafeInteger(body.expectedTotalMinor)) fail(400, 'express_expected_total_required');
    const supplierId = e.reroute.candidate.supplierId;
    return moveTo(store, order, supplierId, ctx, { consent: 'client', approval: body.approval, expectedTotalMinor: body.expectedTotalMinor,
      deliveryAllowanceMinor: Math.max(r.deliveryAllowanceMinor || 0, e.reroute.candidate.deliveryFeeMinor) });
  }
  if (action === 'pick') {
    if (typeof body.supplierId !== 'string' || !Number.isSafeInteger(body.expectedTotalMinor)) fail(400, 'invalid_express_reroute');
    if ((r.triedSupplierIds || []).includes(body.supplierId)) fail(409, 'express_shop_already_asked');
    const row = quotedCandidates(store, order, ctx.at).find(item => item.supplierId === body.supplierId);
    if (!row) fail(409, 'express_shop_unavailable');
    return moveTo(store, order, body.supplierId, ctx, { consent: 'client', newRound: true, approval: body.approval, expectedTotalMinor: body.expectedTotalMinor,
      deliveryAllowanceMinor: row.quote.deliveryFeeMinor || 0 });
  }
  if (action === 'search_away' || action === 'keep_trying') {
    if (status !== 'exhausted') fail(409, 'express_reroute_not_waiting');
    if (action === 'search_away') {
      if (!e.reroute.searchAway?.available) fail(409, 'express_shop_unavailable');
      // The client tapped the button that showed the away delivery fee.
      Object.assign(r, { scope: 'away', roundAsked: 0, round: (r.round || 1) + 1, deliveryAllowanceMinor: e.reroute.searchAway.deliveryFeeMinor });
    } else {
      Object.assign(r, { scope: 'nearby', roundAsked: 0, round: (r.round || 1) + 1 });
      e.reroute = { status: 'retrying', at: ctx.at, retryUntil: iso(Date.parse(ctx.at) + EXPRESS_KEEP_TRYING_MS), nextTryAt: iso(Date.parse(ctx.at) + RETRY_EVERY_MS) };
    }
    audit(store, order, `reroute_${action}`, { ...ctx, actorId: user.id });
    return advance(store, order, ctx) || order;
  }
  fail(400, 'invalid_express_reroute');
}

function cancelRequest(store, user, order, ctx) {
  const unpaid = order.state === 'supplier_assigned'
    || (order.state === 'awaiting_initial_payment' && order.payments?.initial?.status === 'not_submitted');
  if (!unpaid || Object.values(order.payments || {}).some(p => p.status === 'confirmed')) fail(409, 'express_cancel_unavailable');
  closeAttempt(store, order, ctx, { reason: 'The client cancelled the request. Nothing was charged.', by: user.id,
    reroute: order.expressOrder.reroute && HELD.includes(order.expressOrder.reroute.status) ? { ...order.expressOrder.reroute, status: 'cancelled' } : order.expressOrder.reroute });
  audit(store, order, 'client_cancelled', { ...ctx, actorId: user.id });
  if (order.shopAcceptance?.status === 'pending') order.shopAcceptance.status = 'withdrawn';
  if (order.shopAcceptance?.status === 'accepted') {
    (store.notifications ||= []).push({ id: ctx.id('ntf'), at: ctx.at, userId: order.supplierId, appRole: 'supplier', type: 'express_order', orderId: order.id,
      title: 'Express request cancelled', body: 'The client cancelled before paying. Do not print it.', read: false });
  }
  return order;
}

/** After acceptance: cash at the counter, or the GRIDGO QR with a receipt. */
function pay(store, user, order, body, ctx) {
  const { at, id } = ctx, e = order.expressOrder, installment = order.payments?.initial;
  const resubmit = e.paymentRelease?.receiptRejected && installment?.status === 'rejected';
  if (!resubmit && (order.state !== 'awaiting_initial_payment' || order.shopAcceptance?.status !== 'accepted' || installment?.status !== 'not_submitted')) fail(409, 'express_payment_not_due');
  if (!resubmit && e.payBy && Date.parse(at) >= Date.parse(e.payBy)) fail(409, 'express_payment_expired');
  const option = method => (e.paymentOptions?.methods || []).find(row => row.method === method);
  if (body.method === 'cash_at_pickup') {
    if (resubmit || option('cash_at_pickup')?.available !== true) fail(409, 'express_cash_unavailable');
    order.paymentMethod = 'counter_cash';
    Object.assign(installment, { method: 'cash', status: 'not_submitted', submittedAt: at });
    order.clientPayment = clientPaymentSnapshot(order);
    order.paymentStatus = 'cash_due';
    e.paymentRelease = { method: 'cash_at_pickup', kind: 'cash_at_pickup', at };
    // Choosing cash commits the order, so a reserved voucher is used now.
    confirmVoucher(store, [order], { id, at, actorId: user.id });
  } else if (body.method === 'qr_ph') {
    if (!resubmit && option('qr_ph')?.available !== true) fail(409, 'express_qr_unavailable');
    const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
    if (!reference || reference.length > 100) fail(400, 'payment_reference_required');
    const proof = (store.files || []).find(file => file.fileId === body.proofFileId && file.ownerId === user.id);
    if (!proof) fail(404, 'file_not_found');
    if (proof.purpose !== 'payment_proof') fail(400, 'payment_proof_invalid');
    if (proof.state !== 'ready') fail(409, 'file_not_ready');
    // A receipt proves one payment: its file and its reference cannot be reused on another order.
    if ((proof.references || []).some(ref => ref.type === 'order' && ref.id !== order.id)) fail(409, 'payment_proof_already_used');
    if ((store.orders || []).some(row => row.id !== order.id && Object.values(row.payments || {}).some(p => p?.method === 'qr_manual'
      && typeof p.reference === 'string' && p.reference.trim().toLowerCase() === reference.toLowerCase()))) fail(409, 'payment_reference_already_used');
    const field = 'payment:initial:proof';
    if (!(proof.references || []).some(ref => ref.type === 'order' && ref.id === order.id && ref.field === field)) {
      proof.references = [...(proof.references || []), { type: 'order', id: order.id, field }];
    }
    Object.assign(installment, { method: 'qr_manual', status: 'pending_confirmation', reference, proofFileId: proof.fileId, submittedAt: at,
      confirmedAt: null, confirmedBy: null, confirmationSource: null, rejectedAt: null, rejectedBy: null, rejectionReason: null });
    order.paymentMethod = 'qr_manual';
    order.paymentStatus = 'initial_payment_pending';
    const rules = expressCheckoutSettings(store.settings);
    // A replacement receipt keeps handover blocked until Operations confirms it.
    if (resubmit) e.paymentRelease.receiptRejected.resubmittedAt = at;
    else if (rules.paymentConfirmation === 'gateway' || installment.amountMinor <= rules.manualQrInstantMaxMinor) {
      e.paymentRelease = { method: 'qr_ph', kind: 'receipt_under_limit', at };
    } else {
      // GRIDGO checks receipts above the limit by hand; the shop's slot is held meanwhile.
      e.paymentReview = { requestedAt: at, dueAt: iso(Date.parse(at) + rules.manualQrReviewMinutes * 60_000) };
      order.state = 'initial_payment_review';
    }
    notifyOpsPaymentSubmitted(store, order, { createId: id, at });
  } else fail(400, 'invalid_express_payment_method');
  if (e.paymentRelease && !resubmit) order.state = 'payment_authorized';
  order.updatedAt = at;
  order.timeline.push({ at, state: order.state, by: user.id, note: body.method === 'cash_at_pickup' ? 'Client will pay cash at pickup.' : 'Client sent a QR payment receipt.' });
  audit(store, order, 'payment_chosen', { ...ctx, actorId: user.id, detail: { method: body.method } });
  (store.notifications ||= []).push({ id: id('ntf'), at, userId: order.supplierId, appRole: 'supplier', type: 'express_order', orderId: order.id,
    title: e.paymentRelease ? 'Start printing' : 'GRIDGO is checking the payment', body: e.paymentRelease?.method === 'cash_at_pickup'
      ? 'The client pays cash at pickup.' : e.paymentRelease ? 'The client sent the payment.' : 'Hold the slot; GRIDGO confirms within minutes.', read: false });
  queueOrderInvalidate(store, order, ['orders', 'jobs', 'notifications']);
  return order;
}

/** Called by the shop's accept: open the five-minute payment window with its choices. */
export function acceptFirstAccepted(store, order, at) {
  if (!isAcceptFirst(order) || paymentSettled(order.payments?.initial)) return;
  order.expressOrder.payBy = iso(Date.parse(at) + EXPRESS_PAY_WINDOW_MS);
  order.expressOrder.paymentOptions = expressPaymentOptions(store, order, clientOf(store, order), at);
  if (order.expressOrder.reroute) order.expressOrder.reroute = { ...order.expressOrder.reroute, status: 'accepted', at };
}

/** Cash at pickup: the shop's PIN entry confirms the cash and records GRIDGO's share. */
export function acceptFirstPickupPayment(order, body) {
  const release = order.expressOrder?.paymentRelease;
  if (!isAcceptFirst(order) || !release) return null;
  // After a rejected receipt, only a confirmed payment hands the print over.
  if (release.receiptRejected) return paymentSettled(order.payments?.initial) ? 'released' : null;
  if (release.method === 'cash_at_pickup' && !paymentSettled(order.payments?.initial)) {
    if (body.cashReceived !== true) fail(409, 'express_cash_confirmation_required');
    return 'cash';
  }
  return 'released';
}

export async function routeAcceptFirst({ req, url, store, user, readBody, id, now }) {
  const match = /^\/orders\/([^/]+)\/express\/(reroute|cancel|pay)$/.exec(url.pathname);
  if (!match || req.method !== 'POST') return null;
  const order = heldOrder(store, user, decodeURIComponent(match[1]));
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request');
  const ctx = { at: now(), id };
  const result = match[2] === 'reroute' ? rerouteAction(store, user, order, body, ctx)
    : match[2] === 'cancel' ? cancelRequest(store, user, order, ctx) : pay(store, user, order, body, ctx);
  const current = result || order;
  return { status: 200, mutated: true, body: { orderId: current.id, state: current.state, expressOrder: publicExpress(current, user),
    ...(current.id !== order.id ? { previousOrderId: order.id } : {}) } };
}

/** SQL precheck for the one-second sweep; idle ticks read one indexed row. */
export async function acceptFirstWorkDue(database, at) {
  const due = await database.query(`SELECT 1 FROM orders WHERE data#>>'{expressOrder,acceptFlow}'='2' AND (
      (state='supplier_assigned' AND data#>>'{shopAcceptance,status}'='pending' AND (data#>>'{shopAcceptance,deadlineAt}')::timestamptz <= $1)
      OR (state='supplier_assigned' AND data#>>'{expressOrder,reroute,status}' IN ('price_check','exhausted') AND (data#>>'{expressOrder,reroute,expiresAt}')::timestamptz <= $1)
      OR (state='supplier_assigned' AND data#>>'{expressOrder,reroute,status}'='retrying' AND (data#>>'{expressOrder,reroute,nextTryAt}')::timestamptz <= $1)
      OR (state='initial_payment_review' AND data#>'{expressOrder,paymentReview,overdueAt}' IS NULL AND (data#>>'{expressOrder,paymentReview,dueAt}')::timestamptz <= $1)
    ) LIMIT 1`, [at]);
  return due.rowCount > 0;
}

/** Timeouts move the request on; unanswered client choices close without charge. */
export function sweepAcceptFirst(store, { at, id }) {
  let changed = false;
  for (const order of [...(store.orders || [])]) {
    if (!isAcceptFirst(order)) continue;
    const e = order.expressOrder, ctx = { at, id };
    if (order.state === 'supplier_assigned' && order.shopAcceptance?.status === 'pending' && Date.parse(at) >= Date.parse(order.shopAcceptance.deadlineAt)) {
      declineExpress(store, order, { at, id, kind: 'timed_out' }); changed = true;
    } else if (order.state === 'supplier_assigned' && ['price_check', 'exhausted'].includes(e.reroute?.status) && Date.parse(at) >= Date.parse(e.reroute.expiresAt)) {
      closeAttempt(store, order, ctx, { reason: 'No printer was chosen in time. Nothing was charged.', reroute: { ...e.reroute, status: 'expired' } });
      notifyClient(store, order, 'express_request_closed', 'Express request closed', 'No printer was chosen in time. Nothing was charged.', ctx);
      changed = true;
    } else if (order.state === 'supplier_assigned' && e.reroute?.status === 'retrying' && Date.parse(at) >= Date.parse(e.reroute.nextTryAt)) {
      const moved = advance(store, order, ctx);
      if (!moved && e.reroute.status === 'retrying') {
        if (Date.parse(at) >= Date.parse(e.reroute.retryUntil)) hold(store, order, 'exhausted', ctx, { searchAway: null, afterRetry: true });
        else e.reroute.nextTryAt = iso(Date.parse(at) + RETRY_EVERY_MS);
      }
      changed = true;
    } else if (order.state === 'initial_payment_review' && e.paymentReview && !e.paymentReview.overdueAt && Date.parse(at) >= Date.parse(e.paymentReview.dueAt)) {
      e.paymentReview.overdueAt = at;
      for (const admin of privilegedAdminMemberships(store)) {
        (store.notifications ||= []).push({ id: id('ntf'), at, userId: admin.userId, appRole: admin.role, type: 'express_payment_review_overdue', orderId: order.id,
          title: 'Express payment check overdue', body: 'A shop is holding its slot for this QR receipt.', read: false });
      }
      queueOrderInvalidate(store, order, ['orders', 'notifications']);
      changed = true;
    }
  }
  return changed;
}
