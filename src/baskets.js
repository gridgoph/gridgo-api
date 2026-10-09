import { confirmVoucher } from './vouchers.js';
import { groupSummary } from "./cart-groups.js";
import { publicOrganizationDiscount } from "./organization-money.js";
import { clientInvoice } from "./invoice-projection.js";
import { publicOrderFor } from './operational-model.js';
import { identityHasMembership } from './authorization-context.js';
import { MatchError } from './order-match.js';
import { queueOrderInvalidate } from './notifications.js';
import { notifyOpsJobNeedsQa, notifyOpsPaymentSubmitted, notifyClientPaymentRejected, notifyOrderParties } from './client-order-notifications.js';

export function shopLabel(index) {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
  return `Shop ${letters}`;
}
// One hub collection fee, with remainder minor units assigned in group order.
export function splitBasketFee(totalMinor, groupCount) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0 || !Number.isSafeInteger(groupCount) || groupCount < 0) throw new RangeError('Invalid basket fee allocation');
  if (!groupCount) return [];
  const total = BigInt(totalMinor), count = BigInt(groupCount);
  return Array.from({ length: groupCount }, (_, index) => Number(total / count + (BigInt(index) < total % count ? 1n : 0n)));
}
export function basketForOrder(store, orderId) {
  return (store.baskets || []).find((basket) => basket.orderIds.includes(orderId));
}
const staff = (user) => ['ops_admin', 'super_admin'].some((role) => identityHasMembership(user, role));
const fail = (status, code, message) => { throw new MatchError(status, code, message); };

export function publicBasket(store, basket, user) {
  const privileged = staff(user);
  const orders = basket.orderIds.map((id) => store.orders.find((order) => order.id === id));
  return {
    id: basket.id, receiptOrderId: basket.receiptOrderId, totalMinor: basket.totalMinor,
    ...groupSummary(orders), upfrontReason: "multiple_fulfillment_groups",
    deadline: basket.deadline, fulfillmentMode: basket.fulfillmentMode, createdAt: basket.createdAt,
    payment: { ...basket.payment, amountMinor: basket.totalMinor },
    ...(basket.pickupFeeMinor != null ? { pickupFeeMinor: basket.pickupFeeMinor,
      hubPickup: { ...structuredClone(orders[0].hubPickup), feeMinor: basket.pickupFeeMinor } } : {}),
    groups: orders.map((order, index) => ({
      orderId: order.id, label: order.groupLabel || shopLabel(index), deadline: order.deadline ?? order.basketDeadline ?? basket.deadline, state: order.state,
      ...publicOrganizationDiscount(order),
      clientItemSubtotalMinor: order.supplierSubtotalMinor + (order.grossServiceFeeMinor ?? order.serviceFeeMinor),
      ...(privileged ? { itemSubtotalMinor: order.supplierSubtotalMinor, serviceFeeMinor: order.serviceFeeMinor } : {}),
      deliveryFeeMinor: order.deliveryFeeMinor, totalMinor: order.totalMinor,
      ...(order.pickupFeeMinor != null ? { pickupFeeMinor: order.pickupFeeMinor } : {}),
      order: publicOrderFor(order, privileged ? { ...user, role: 'ops_admin' } : { ...user, role: 'client' }, store),
    })),
  };
}

/** The sole payment mutation boundary for multi-shop orders. The caller saves once. */
export async function routeBaskets({ req, url, store, user, readBody, id, now }) {
  const match = /^\/baskets(?:\/([^/]+)(?:\/(invoice|payment\/(submit|confirm|reject)))?)?$/.exec(url.pathname);
  if (!match) return null;
  if (!user) fail(401, 'unauthorized', 'Sign in to view this basket.');
  const privileged = staff(user);
  if (!privileged && !identityHasMembership(user, 'client')) fail(403, 'forbidden', 'Client or Operations access is required.');
  if (req.method === 'GET' && !match[1]) {
    return { status: 200, body: { baskets: (store.baskets || []).filter((basket) => privileged || basket.clientId === user.id)
      .map((basket) => publicBasket(store, basket, user)) } };
  }
  const basket = (store.baskets || []).find((row) => row.id === match[1]);
  if (!basket || (!privileged && basket.clientId !== user.id)) fail(404, 'basket_not_found', 'That basket is unavailable.');
  if (req.method === 'GET' && !match[2]) return { status: 200, body: { basket: publicBasket(store, basket, user) } };
  if (req.method === 'GET' && match[2] === 'invoice') {
    return { status: 200, body: { invoice: clientInvoice(store.orderInvoices.find((row) => row.orderId === basket.receiptOrderId).snapshot, { hideSupplierAmounts: !privileged }) } };
  }
  if (req.method !== 'POST' || !match[3]) fail(404, 'not_found', 'Route not found.');
  const action = match[3];
  if (action === 'submit' ? basket.clientId !== user.id : !privileged) fail(403, 'forbidden', 'This payment action is not available to this account.');
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request', 'Send a JSON object.');
  const payment = basket.payment;
  if (action === 'submit') {
    if (payment.status !== 'not_submitted') fail(409, 'payment_already_submitted', 'This basket payment is already submitted.');
    if (body.method !== 'qr_manual') fail(400, 'payment_method_not_allowed', 'Use the manual QR payment method.');
    if (typeof body.reference !== 'string' || !body.reference.trim() || body.reference.trim().length > 100) fail(400, 'payment_reference_required', 'Supply a payment reference of at most 100 characters.');
    const proof = (store.files || []).find((file) => file.fileId === body.proofFileId && file.ownerId === user.id);
    if (!proof || proof.purpose !== 'payment_proof' || proof.state !== 'ready') fail(400, 'payment_proof_invalid', 'Supply your ready payment proof.');
    payment.reference = body.reference.trim();
    payment.proofFileId = proof.fileId;
    payment.status = 'pending_confirmation';
    payment.submittedAt = now();
    for (const field of ['confirmedAt', 'confirmedBy', 'confirmationSource', 'rejectedAt', 'rejectedBy', 'rejectionReason']) delete payment[field];
    for (const orderId of basket.orderIds) {
      proof.references ||= [];
      if (!proof.references.some((ref) => ref.type === 'order' && ref.id === orderId && ref.field === 'payment:initial:proof')) {
        proof.references.push({ type: 'order', id: orderId, field: 'payment:initial:proof' });
      }
    }
  } else {
    if (payment.status !== 'pending_confirmation') fail(409, 'payment_not_pending', 'This basket has no payment waiting for review.');
    if (action === 'reject' && (typeof body.reason !== 'string' || !body.reason.trim())) fail(400, 'payment_rejection_reason_required', 'Explain what the client must correct.');
    if (action === 'confirm') confirmVoucher(store, basket.orderIds.map(orderId => store.orders.find(o => o.id === orderId)), { id, at: now(), actorId: user.id });
    if (action === 'confirm') Object.assign(payment, { status: 'confirmed', confirmedAt: now(), confirmedBy: user.id, confirmationSource: 'manual_ops' });
    else Object.assign(payment, { status: 'not_submitted', reference: null, proofFileId: null, submittedAt: null,
      rejectedAt: now(), rejectedBy: user.id, rejectionReason: body.reason.trim() });
  }
  const at = now();
  basket.updatedAt = at;
  for (const orderId of basket.orderIds) {
    const order = store.orders.find((row) => row.id === orderId);
    order.payments.initial = { ...payment, amountMinor: order.totalMinor, label: 'Full payment' };
    // Payment reconciliation must never restart a group Operations cancelled.
    if (order.state !== 'cancelled') order.state = action === 'confirm' ? 'needs_qa' : action === 'reject' ? 'awaiting_initial_payment' : 'initial_payment_review';
    order.paymentStatus = action === 'confirm' ? 'paid' : action === 'reject' ? 'unpaid' : 'initial_payment_pending';
    order.updatedAt = at;
    order.timeline.push({ at, state: order.state, by: user.id, note: `Basket payment ${action}` });
    if (action === 'confirm' && order.state === 'needs_qa') {
      notifyOpsJobNeedsQa(store, order, { createId: id, at });
      notifyOrderParties(store, order, { createId: id, at });
    }
    queueOrderInvalidate(store, order, ['orders', 'jobs']);
  }
  const firstOrder = store.orders.find((row) => row.id === basket.receiptOrderId);
  if (action === 'reject') notifyClientPaymentRejected(store, firstOrder, { createId: id, at, reason: payment.rejectionReason });
  if (action === 'submit') notifyOpsPaymentSubmitted(store, firstOrder, { createId: id, at });
  store.auditLog.push({ id: id('aud'), at, actorId: user.id, actorRole: user.role,
    action: `basket.payment_${action}`, entityType: 'basket', entityId: basket.id,
    detail: { orderIds: basket.orderIds, amountMinor: basket.totalMinor }, reason: body.reason || null });
  return { status: 200, body: { basket: publicBasket(store, basket, user) }, mutated: true };
}
