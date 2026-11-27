import { serviceFeeMoney } from './service-fee.js';
import { actorUserId } from './shop-team.js';
import { isAcceptFirst, homePrinterLimitMinor } from './express-checkout-rules.js';
import { maskOrderChat } from './chat-contact-masking.js';
import { createPayoutMilestones } from './operational-model.js';
import { queueOrderInvalidate } from './notifications.js';
import { notifyAdmins } from './domain-events.js';
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const safe = n => { if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) fail(400, 'invalid_money'); return Number(n); };
export function extraPrice(order, items) {
  const printingMinor = order.expressOrder?.shopExtras?.printingMinor ?? order.supplierSubtotalMinor;
  const extrasMinor = safe(items.reduce((n, item) => n + BigInt(item.unitPriceMinor) * BigInt(item.quantity), 0n));
  const principal = safe(BigInt(printingMinor) + BigInt(extrasMinor));
  const fee = serviceFeeMoney(principal, order.serviceFeeSchedule);
  const discountMinor = Math.min(fee.grossServiceFeeMinor, safe((BigInt(principal) * BigInt(order.organizationDiscountRateBps || 0) + 5000n) / 10000n));
  const serviceFeeMinor = fee.grossServiceFeeMinor - discountMinor - (order.memberPerkMinor || 0);
  // Total rounding can lower the fee by a few centavos even as principal grows.
  // Never turn a locked promotion into negative cash allocation or move its funding.
  if (serviceFeeMinor < 0 || (order.voucherServiceFeeMinor || 0) > serviceFeeMinor) fail(409, 'express_extra_discount_requote_required');
  const totalMinor = safe(BigInt(principal) + BigInt(serviceFeeMinor) + BigInt(order.deliveryFeeMinor || 0) - BigInt(order.voucherDiscountMinor || 0));
  return { ...fee, organizationDiscountMinor: discountMinor, serviceFeeMinor, printingMinor, extrasMinor, supplierSubtotalMinor: principal, totalMinor };
}
export function publicShopExtras(order) {
  const extras = order.expressOrder?.shopExtras;
  if (!extras) return null;
  return { version: extras.version, applied: Boolean(extras.appliedAt), printingMinor: extras.printingMinor,
    extrasMinor: extras.price.extrasMinor, totalMinor: extras.price.totalMinor,
    items: extras.items.map(({ label, quantity, unitPriceMinor }) => ({ label, quantity, unitPriceMinor,
      amountMinor: safe(BigInt(quantity) * BigInt(unitPriceMinor)), addedBy: 'shop', marker: 'added by shop' })) };
}
export async function setShopExtras(database, store, user, order, body, { at, id }) {
  if (user?.role !== 'supplier' || order.supplierId !== user.id) fail(403, 'forbidden');
  if (!isAcceptFirst(order) || order.state !== 'supplier_assigned' || order.shopAcceptance?.status !== 'pending'
    || !Number.isFinite(Date.parse(order.shopAcceptance.deadlineAt)) || Date.parse(at) >= Date.parse(order.shopAcceptance.deadlineAt)
    || order.basketId || order.groupOrder) fail(409, 'express_extras_not_pending');
  if (!body || !Number.isSafeInteger(body.expectedVersion) || !Array.isArray(body.items) || body.items.length > 20
    || Object.keys(body).some(key => !['expectedVersion', 'items'].includes(key))) fail(400, 'invalid_express_extras');
  const previous = order.expressOrder.shopExtras;
  if (body.expectedVersion !== (previous?.version || 0)) fail(409, 'express_extras_stale');
  const items = [];
  for (const item of body.items) {
    if (!item || Object.keys(item).some(key => !['label','quantity','unitPriceMinor','agreedMessageId'].includes(key))
      || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 80
      || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000
      || !Number.isSafeInteger(item.unitPriceMinor) || item.unitPriceMinor < 1
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.agreedMessageId || '')) fail(400, 'invalid_express_extra');
    if (maskOrderChat(item.label, order).contactAttempt) fail(400, 'invalid_express_extra_label');
    const evidence = await database.query(`SELECT 1 FROM client_shop_chat_messages WHERE id=$1 AND order_id=$2
      AND supplier_id=$3 AND sender_user_id=$4 AND sender_role='client' AND masked_body<>'' AND NOT contact_attempt`,
    [item.agreedMessageId, order.id, user.id, order.clientId]);
    if (!evidence.rowCount) fail(409, 'express_extra_agreement_required');
    items.push({ label: item.label.trim(), quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, agreedMessageId: item.agreedMessageId });
  }
  const price = extraPrice(order, items);
  const limit = homePrinterLimitMinor(store.settings);
  if (order.homePrinter?.supplierId === order.supplierId && limit != null && price.totalMinor > limit) fail(409, 'home_printer_order_limit');
  order.expressOrder.shopExtras = { version: (previous?.version || 0) + 1, printingMinor: previous?.printingMinor ?? order.supplierSubtotalMinor,
    items, price, addedByUserId: actorUserId(user), ...(user.actorPinStaffId ? { addedByPinStaffId: user.actorPinStaffId } : {}), updatedAt: at };
  store.auditLog.push({ id: id('aud'), at, actorId: actorUserId(user), actorRole: 'supplier', action: 'express.extras_updated',
    entityType: 'order', entityId: order.id, orderId: order.id, detail: { count: items.length, extrasMinor: price.extrasMinor } });
  notifyAdmins(store, 'express_extras_updated', 'Shop extras updated', order, `express-extras:${order.id}:${order.expressOrder.shopExtras.version}`, { createId: id, at });
  queueOrderInvalidate(store, order, ['orders','jobs','chat']);
  return publicShopExtras(order);
}

/** Only acceptance can commit extras. Original print lines and fee schedule stay intact. */
export function applyShopExtras(store, order, at) {
  const extras = order.expressOrder?.shopExtras;
  if (!extras || extras.appliedAt || !extras.items.length) return;
  if (Object.entries(order.payments || {}).some(([code, p]) => code === 'initial' ? p.status !== 'not_submitted' : p.amountMinor !== 0)
    || order.payoutMilestones.some(p => p.status !== 'pending_pof')) fail(409, 'express_extras_payment_started');
  const money = extraPrice(order, extras.items);
  const principalDelta = money.supplierSubtotalMinor - order.supplierSubtotalMinor;
  const feeDelta = money.serviceFeeMinor - order.serviceFeeMinor;
  const delta = money.totalMinor - order.totalMinor;
  Object.assign(order, { grossServiceFeeMinor: money.grossServiceFeeMinor, serviceFeeWorking: money.serviceFeeWorking,
    serviceFeeMinor: money.serviceFeeMinor, organizationDiscountMinor: money.organizationDiscountMinor,
    supplierSubtotalMinor: money.supplierSubtotalMinor, subtotalMinor: money.supplierSubtotalMinor,
    supplierPlatformPayoutMinor: money.supplierSubtotalMinor, totalMinor: money.totalMinor, onlineDueMinor: money.totalMinor });
  if (order.clientServiceFeeMinor != null) order.clientServiceFeeMinor += feeDelta;
  if (order.clientSupplierSubtotalMinor != null) order.clientSupplierSubtotalMinor += principalDelta;
  order.payments.initial.amountMinor += delta;
  for (const [component, increase] of [['supplier_principal', principalDelta], ['service_fee', feeDelta]]) {
    let allocation = order.paymentAllocations.find(a => a.paymentCode === 'initial' && a.component === component);
    if (!allocation) { allocation = { paymentCode: 'initial', component, amountMinor: 0 }; order.paymentAllocations.push(allocation); }
    allocation.amountMinor += increase;
  }
  order.payoutMilestones = createPayoutMilestones(order, { version: order.payoutPlanVersion });
  for (const job of store.orderJobs.filter(j => j.orderId === order.id)) job.supplierSubtotalMinor += principalDelta;
  extras.price = money; extras.appliedAt = at;
  const invoice = store.orderInvoices.find(i => i.orderId === order.id)?.snapshot;
  if (invoice) {
    Object.assign(invoice, { itemSubtotalMinor: money.supplierSubtotalMinor, serviceFeeMinor: money.serviceFeeMinor,
      grossServiceFeeMinor: money.grossServiceFeeMinor, serviceFeeWorking: money.serviceFeeWorking,
      organizationDiscountMinor: money.organizationDiscountMinor, totalMinor: money.totalMinor, shopExtras: publicShopExtras(order) });
    if (order.clientServiceFeeMinor != null) invoice.clientServiceFeeMinor = order.clientServiceFeeMinor;
    if (order.clientSupplierSubtotalMinor != null) invoice.clientSupplierSubtotalMinor = order.clientSupplierSubtotalMinor;
    invoice.paymentPlan.downpaymentMinor = order.payments.initial.amountMinor;
  }
}
