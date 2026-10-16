import crypto from 'node:crypto';
import { deliveryFeeForDistance, distanceMetersBetween, distanceZoneForDistance, deliverySplit } from './operational-model.js';
import { deliveryPinLocked, deliveryPinPaymentPending, deliveryPinConfirmable } from './delivery-pin-policy.js';
import { collectedRefundComponents, ACTIVE_REFUND_STATUSES } from './refund-policy.js';
import { privilegedAdminMemberships, queueOrderInvalidate } from './notifications.js';

const ops = user => ['ops_admin', 'super_admin'].includes(user?.role);
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const validPoint = p => p && typeof p.lat === 'number' && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90
  && typeof p.lng === 'number' && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180;
function pointValue(p) {
  if (!validPoint(p) || typeof p.label !== 'string' || !p.label.trim() || p.label.trim().length > 240) {
    fail(400, 'invalid_dropoff_point', 'Choose valid coordinates and an address of up to 240 characters.');
  }
  return { lat: p.lat, lng: p.lng, label: p.label.trim() };
}
function text(value, max, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.trim().length > max) fail(400, 'invalid_delivery_pin_request', 'Check the required text fields.');
  return value.trim();
}
function notify(store, order, kind, at, id) {
  const copy = {
    requested: "Production is finished. Will you be at your delivery pin? Choose Yes, I'll be here or Change pin before rider dispatch.",
    confirmed: 'The client confirmed they will be at the delivery pin. Refresh the order for the receiver and notes.',
    proposed: 'A delivery pin change awaits an additional QR payment. The original destination remains in use.',
    payment_submitted: 'Verify the delivery pin payment before dispatch. The original destination remains in use.',
    payment_rejected: 'The delivery pin payment was rejected. Check the reason before trying again.',
    changed: 'The confirmed delivery pin changed. Refresh the order for the final destination and any delivery-fee credit.',
  };
  const recipients = [{ userId: order.clientId, role: 'client' }, ...privilegedAdminMemberships(store),
    ...(order.riderId ? [{ userId: order.riderId, role: 'rider' }] : [])];
  for (const { userId, role } of recipients) (store.notifications ||= []).push({ id: id('ntf'), userId, appRole: role,
    orderId: order.id, type: `delivery_pin_${kind}`, title: 'Delivery pin', body: copy[kind], read: false, at });
  queueOrderInvalidate(store, order, ['orders', 'dispatch', 'notifications']);
}
export function requestDeliveryPin(store, order, { at, id, audit, user }) {
  if (order.fulfillmentMode !== 'delivery' || order.deliveryPin || order.dropoffConfirmation || deliveryPinLocked(order)
    || !validPoint(order.dropoff) || !validPoint(order.pickup)) return;
  order.deliveryPin = { version: 1, requestedAt: at, original: structuredClone(order.dropoff),
    pricing: structuredClone(store.settings),
    status: 'pending', changeUsed: false, notes: '', receiverName: '' };
  audit(store, { actor: user, action: 'order.delivery_pin_requested', entityType: 'order', entityId: order.id, orderId: order.id,
    detail: { requestedAt: at } });
  notify(store, order, 'requested', at, id);
}
export function publicDeliveryPin(order, role) {
  const pin = order.deliveryPin;
  if (!pin || !['client', 'rider', 'ops_admin', 'super_admin'].includes(role)) return null;
  const result = { version: pin.version, status: pin.status, requestedAt: pin.requestedAt, confirmedAt: pin.confirmedAt || null,
    point: pin.point || pin.original, notes: pin.notes, receiverName: pin.receiverName,
    zone: pin.change?.status === 'applied' ? pin.change.zone : distanceZoneForDistance(distanceMetersBetween(order.pickup, pin.original), pin.pricing).key,
    changeUsed: pin.changeUsed, canConfirm: deliveryPinConfirmable(order), canChange: !pin.changeUsed && !deliveryPinLocked(order) && !deliveryPinPaymentPending(order) };
  if (role !== 'rider') {
    result.original = pin.original;
    if (pin.change) {
      const { id, status, point, zone, distanceMeters, feeDifferenceMinor, deliveryFeeMinor, createdAt, appliedAt, refundRequestId, payment, rejectionReason } = pin.change;
      result.change = { id, status, point, zone, distanceMeters, feeDifferenceMinor, deliveryFeeMinor, createdAt, appliedAt, refundRequestId, payment, rejectionReason };
      if (['ops_admin', 'super_admin'].includes(role)) Object.assign(result.change, {
        riderDifferenceMinor: pin.change.riderDifferenceMinor, platformDifferenceMinor: pin.change.platformDifferenceMinor });
    }
  }
  return result;
}
function assertAvailable(order, action) {
  if (!order.deliveryPin || order.fulfillmentMode !== 'delivery' || (action === 'confirm' ? !deliveryPinConfirmable(order) : deliveryPinLocked(order))) {
    fail(409, 'delivery_pin_locked', 'Changes end at first dispatch; presence confirmation ends when the delivery closes.');
  }
}
function preview(order, point) {
  const pin = order.deliveryPin;
  const distanceMeters = distanceMetersBetween(order.pickup, point);
  const zone = distanceZoneForDistance(distanceMeters, pin.pricing).key;
  const originalZone = distanceZoneForDistance(distanceMetersBetween(order.pickup, pin.original), pin.pricing).key;
  const deliveryFeeMinor = zone === originalZone && zone !== 'out_of_zone' ? order.deliveryFeeMinor : deliveryFeeForDistance(distanceMeters, pin.pricing);
  const feeDifferenceMinor = deliveryFeeMinor - order.deliveryFeeMinor;
  // Positive collection and negative credit each split their own difference, using the order's rate.
  const split = deliverySplit(Math.abs(feeDifferenceMinor), order.riderCommissionBps ?? 10000);
  const sign = Math.sign(feeDifferenceMinor);
  const riderDifferenceMinor = sign * split.riderPayoutMinor;
  const platformDifferenceMinor = sign * split.platformDeliveryShareMinor;
  const original = deliverySplit(order.deliveryFeeMinor, order.riderCommissionBps ?? 10000);
  if (!Number.isSafeInteger(order.totalMinor + feeDifferenceMinor) || original.riderPayoutMinor + riderDifferenceMinor < 0
    || original.platformDeliveryShareMinor + platformDifferenceMinor < 0) fail(409, 'delivery_pin_money_reconciliation_required', 'Operations must reconcile this delivery price.');
  return { point, zone, distanceMeters, deliveryFeeMinor, feeDifferenceMinor, riderDifferenceMinor, platformDifferenceMinor };
}
function ensureFunds(store, order, difference = order.deliveryPin.change.feeDifferenceMinor) {
  if ((store.refundRequests || []).some(r => r.orderId === order.id && ACTIVE_REFUND_STATUSES.includes(r.status))
    || (store.refundSettlements || []).some(r => r.orderId === order.id)) fail(409, 'delivery_pin_money_reconciliation_required', 'Resolve the existing refund before changing the delivery price.');
  if (order.directStoreDueMinor > 0 || Object.values(order.payments || {}).some(p => p.status === 'pending_confirmation')) {
    fail(409, 'delivery_pin_money_reconciliation_required', 'Reconcile pending or direct-store collections first.');
  }
  // Voucher-funded delivery is not refundable cash; never convert its subsidy into a credit.
  const collected = collectedRefundComponents(order);
  if (-difference > collected.deliveryMinor) fail(409, 'delivery_pin_money_reconciliation_required', 'The credit exceeds verified delivery collection. Reconcile the remaining installment first.');
}
function createCredit(store, order, change, { user, at, id, audit }) {
  const amount = -change.feeDifferenceMinor;
  const request = { id: id('refund'), orderId: order.id, clientId: order.clientId, policyVersion: 'available_funds_v1',
    status: 'destination_review', version: 1, kind: 'delivery_pin', reason: 'Delivery pin changed to a lower delivery fee.',
    beforeProduction: false, late: false, filingDeadlineAt: null, orderStateAtFiling: order.state,
    evidenceFileIds: [], destination: null, createdAt: at, updatedAt: at };
  store.refundRequests.push(request);
  store.refundSettlements.push({ id: id('rsettle'), requestId: request.id, orderId: order.id,
    sequence: store.refundSettlements.filter(row => row.orderId === order.id).length + 1, createdBy: user.id, createdAt: at,
    reason: request.reason, shopAgreement: 'No change to shop entitlement or published stages.', deliveryEvidence: 'Pin changed before first dispatch.',
    disposition: 'delivery_adjustment', shopEntitlementMinor: order.supplierSubtotalMinor, riderEntitlementMinor: 0,
    principalMinor: 0, feeMinor: 0, deliveryMinor: amount, platformDeliveryMinor: -change.platformDifferenceMinor, totalMinor: amount,
    snapshot: { changeId: change.id, originalFeeMinor: order.deliveryFeeMinor, deliveryFeeMinor: change.deliveryFeeMinor } });
  store.refundEvents.push({ id: id('revent'), requestId: request.id, requestVersion: 1, actorId: user.id,
    kind: 'delivery_credit_reserved', reason: request.reason, createdAt: at, data: { changeId: change.id } });
  change.refundRequestId = request.id;
  audit(store, { actor: user, action: 'refund.delivery_credit_reserved', entityType: 'refund_request', entityId: request.id,
    orderId: order.id, detail: { changeId: change.id, amountMinor: amount } });
}
function apply(store, order, context) {
  const pin = order.deliveryPin, change = pin.change;
  if (change.feeDifferenceMinor < 0) createCredit(store, order, change, context);
  change.status = 'applied'; change.appliedAt = context.at;
  pin.changeUsed = true; pin.status = 'confirmed'; pin.confirmedAt = context.at;
  pin.point = structuredClone(change.point); pin.notes = change.notes; pin.receiverName = change.receiverName;
}
export async function routeDeliveryPin({ req, url, store, user, readBody, now, id, audit }) {
  const match = url.pathname.match(/^\/orders\/([^/]+)\/delivery-pin(?:\/(preview|confirm|change|payment|payment\/confirm|payment\/reject))?$/);
  if (!match) return null;
  if (!user) fail(401, 'unauthorized', 'Sign in to manage a delivery pin.');
  const order = store.orders.find(row => row.id === match[1]);
  if (!order) fail(404, 'order_not_found', 'Order not found.');
  const action = match[2];
  const staffAction = ['payment/confirm', 'payment/reject'].includes(action);
  if (staffAction ? !ops(user) : !(user.role === 'client' && user.id === order.clientId)) fail(403, 'forbidden', 'This delivery pin action is not available to your account.');
  if (req.method === 'GET' && !action) return { status: 200, body: { deliveryPin: publicDeliveryPin(order, user.role) } };
  if (req.method !== 'POST' || !action) return null;
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_delivery_pin_request', 'Send a JSON object.');
  if (action === 'preview') {
    assertAvailable(order);
    const { riderDifferenceMinor, platformDifferenceMinor, ...result } = preview(order, pointValue(body.point));
    return { status: 200, body: { preview: result } };
  }
  const key = text(req.headers?.['idempotency-key'], 120);
  const route = `${req.method} ${url.pathname}`;
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const replay = store.refundCommands.find(row => row.actorId === user.id && row.requestKey === key);
  if (replay) {
    if (replay.route !== route || replay.bodyHash !== bodyHash) fail(409, 'delivery_pin_idempotency_conflict', 'Use a new key for a different request.');
    return structuredClone(replay.response);
  }
  assertAvailable(order, action);
  const pin = order.deliveryPin;
  if (body.expectedVersion !== pin.version) fail(409, 'delivery_pin_stale', 'Reload the current pin before changing it.');
  const at = now();
  const context = { user, at, id, audit };
  const before = publicDeliveryPin(order, 'ops_admin');
  let event;
  if (action === 'confirm') {
    pin.status = 'confirmed'; pin.confirmedAt = at;
    // Confirmation attests presence at the effective pin, never at an unpaid proposal.
    pin.notes = text(body.notes ?? pin.notes, 500, true);
    pin.receiverName = text(body.receiverName ?? pin.receiverName, 120, true);
    event = 'confirmed';
  } else if (action === 'change') {
    if (pin.changeUsed) fail(409, 'delivery_pin_change_used', 'Only one saved pin change is allowed.');
    if (deliveryPinPaymentPending(order)) fail(409, 'delivery_pin_payment_pending', 'Operations must resolve the submitted transfer first.');
    if (body.acknowledgeOneChange !== true) fail(400, 'delivery_pin_warning_required', 'Confirm that this is your one permitted pin change.');
    const quote = preview(order, pointValue(body.point));
    if (body.feeDifferenceMinor !== quote.feeDifferenceMinor) fail(409, 'delivery_pin_fee_changed', 'Preview and accept the exact fee difference.');
    if (quote.feeDifferenceMinor !== 0) ensureFunds(store, order, quote.feeDifferenceMinor);
    pin.change = { ...quote, id: id('pin'), createdAt: at, notes: text(body.notes, 500, true), receiverName: text(body.receiverName, 120, true),
      status: quote.feeDifferenceMinor > 0 ? 'pending_payment' : 'applied' };
    if (quote.feeDifferenceMinor <= 0) { apply(store, order, context); event = 'changed'; }
    else event = 'proposed';
  } else if (action === 'payment') {
    if (pin.change?.status !== 'pending_payment') fail(409, 'delivery_pin_payment_unavailable', 'Choose a pin requiring an extra payment first.');
    ensureFunds(store, order);
    const proof = store.files.find(file => file.fileId === body.proofFileId && file.ownerId === user.id && file.purpose === 'payment_proof'
      && file.state === 'ready' && file.objectKey && !file.deleteRequestedAt && !file.deletedAt);
    if (!proof || proof.references?.length) fail(400, 'payment_proof_invalid', 'Upload your own unused payment proof.');
    pin.change.payment = { proofFileId: proof.fileId, reference: text(body.reference, 120).toUpperCase(), submittedAt: at };
    (proof.references ||= []).push({ type: 'order', id: order.id, field: `delivery_pin:${pin.change.id}:payment` });
    pin.change.status = 'pending_confirmation'; event = 'payment_submitted';
  } else {
    if (!deliveryPinPaymentPending(order)) fail(409, 'delivery_pin_payment_unavailable', 'No submitted transfer awaits verification.');
    const reason = text(body.reason, 2000);
    if (action === 'payment/reject') {
      pin.change.status = 'pending_payment'; pin.change.rejectionReason = reason; event = 'payment_rejected';
    } else {
      ensureFunds(store, order);
      if (body.amountMinor !== pin.change.feeDifferenceMinor) fail(409, 'delivery_pin_payment_mismatch', 'Verify the exact additional amount.');
      pin.change.payment = { ...pin.change.payment, amountMinor: body.amountMinor, confirmedAt: at, confirmedBy: user.id };
      (store.deliveryPinPayments ||= []).push({ id: id('pinpay'), orderId: order.id, changeId: pin.change.id,
        amountMinor: body.amountMinor, reference: pin.change.payment.reference, proofFileId: pin.change.payment.proofFileId, confirmedBy: user.id, createdAt: at });
      apply(store, order, context); event = 'changed';
    }
  }
  pin.version += 1; order.updatedAt = at;
  audit(store, { actor: user, action: `order.delivery_pin_${event}`, entityType: 'order', entityId: order.id,
    orderId: order.id, before, after: publicDeliveryPin(order, 'ops_admin'), detail: { version: pin.version, changeId: pin.change?.id,
      feeDifferenceMinor: pin.change?.feeDifferenceMinor }, reason: staffAction ? body.reason : null });
  notify(store, order, event, at, id);
  const response = { status: 200, body: { deliveryPin: publicDeliveryPin(order, user.role) } };
  store.refundCommands.push({ id: id('rcmd'), actorId: user.id, requestKey: key, route, bodyHash, response: structuredClone(response), createdAt: at });
  return { ...response, mutated: true };
}
