import { clientInvoice } from './invoice-projection.js';
import { basketForOrder } from './baskets.js';
import { approvedRole, privilegedAdminMemberships, queueOrderInvalidate } from './notifications.js';
import { paymentSettled } from './operational-model.js';
import { textDocumentPdf } from './text-document-pdf.js';

export const ACKNOWLEDGEMENT_NOTE = 'This temporary receipt acknowledges initial receipt pending final processing. It does not replace an Official Receipt or final invoice.';
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const money = value => {
  if (!Number.isSafeInteger(value)) fail('acknowledgement_amount_unavailable');
  return value;
};
const sum = values => money(Number(values.reduce((total, value) => total + BigInt(money(value)), 0n)));
const staff = user => ['ops_admin', 'super_admin'].includes(user?.role);
const digitalMethods = new Set(['qr_manual', 'gcash', 'maya', 'bank_transfer', 'qr_ph']);

/** No catalog/settings lookups: only the checkout snapshot and recorded payments. */
export function acknowledgementSnapshot(store, order, at) {
  const basket = basketForOrder(store, order.id);
  const invoice = (store.orderInvoices || []).find(row => row.orderId === (basket?.receiptOrderId || order.id))?.snapshot;
  let source = basket ? invoice?.groups?.find(group => group.orderId === order.id) : invoice;
  let quotedLines;
  if (basket && !source) fail('acknowledgement_amount_unavailable');
  if (!source) {
    // Older orders may predate the invoice table but retain immutable line snapshots.
    const lines = (store.orderLineItems || []).filter(line => line.orderId === order.id);
    if (!lines.length) {
      // A legacy quoted order has one aggregate product price, no stored unit rate.
      // Preserve that fact instead of inventing a price by dividing/rounding it.
      if (!order.title || !Number.isSafeInteger(order.quantity) || order.quantity < 1) fail('acknowledgement_amount_unavailable');
      quotedLines = [{ id: order.id, description: order.title, quantity: order.quantity, unitPriceMinor: null,
        subtotalMinor: sum([order.supplierSubtotalMinor, order.grossServiceFeeMinor ?? order.serviceFeeMinor]) }];
    }
    source = { itemSubtotalMinor: order.supplierSubtotalMinor, serviceFeeMinor: order.serviceFeeMinor,
      grossServiceFeeMinor: order.grossServiceFeeMinor, serviceFeeRateBps: order.serviceFeeRateBps,
      serviceFeeSchedule: order.serviceFeeSchedule, deliveryFeeMinor: order.deliveryFeeMinor, totalMinor: order.totalMinor,
      lines: lines.map(line => ({ id: line.id, itemName: line.itemNameSnapshot, quantity: line.quantity,
        unitPriceMinor: line.effectiveUnitPriceMinor, amountMinor: line.lineSubtotalMinor })) };
  }
  if (source.totalMinor !== order.totalMinor || source.deliveryFeeMinor !== order.deliveryFeeMinor) fail('acknowledgement_amount_mismatch');
  if (!quotedLines && !source.lines?.length) fail('acknowledgement_amount_unavailable');
  const projected = quotedLines ? null : clientInvoice(source, { hideSupplierAmounts: true });
  const lines = quotedLines ?? projected.lines.map(line => {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0 || !line.itemName) fail('acknowledgement_amount_unavailable');
    return { id: line.id, description: line.itemName, quantity: line.quantity,
      unitPriceMinor: money(line.clientUnitPriceMinor), subtotalMinor: money(line.clientAmountMinor) };
  });
  const deliveryFeeMinor = money(order.deliveryFeeMinor);
  const organizationDiscountMinor = money(order.organizationDiscountMinor ?? 0);
  const voucherDiscountMinor = money(order.voucherDiscountMinor ?? 0);
  const grandTotalMinor = money(order.totalMinor);
  const roundingAdjustmentMinor = sum([grandTotalMinor, -deliveryFeeMinor, organizationDiscountMinor, voucherDiscountMinor,
    ...lines.map(line => -line.subtotalMinor)]);
  if (Math.abs(roundingAdjustmentMinor) > lines.length) fail('acknowledgement_amount_mismatch');
  const issuedTo = store.users.find(user => user.id === order.clientId)?.name;
  if (!issuedTo) fail('acknowledgement_customer_unavailable');
  const payments = Object.entries(order.payments || {}).filter(([, p]) => p.amountMinor > 0).map(([code, recorded]) => {
    const payment = basket && code === 'initial' ? { ...recorded, ...basket.payment, amountMinor: recorded.amountMinor } : recorded;
    if (!paymentSettled(payment)) fail('acknowledgement_payment_pending');
    const method = payment.method ?? null;
    const type = method === 'cash' ? 'cash' : digitalMethods.has(method) ? 'digital' : 'unknown';
    return { code, type, method, reference: payment.reference ?? null, amountMinor: money(payment.amountMinor),
      amountReceivedMinor: type === 'cash' && payment.amountReceivedMinor != null ? money(payment.amountReceivedMinor) : null,
      changeMinor: type === 'cash' && payment.changeMinor != null ? money(payment.changeMinor) : null };
  });
  if (sum(payments.map(p => p.amountMinor)) !== grandTotalMinor) fail('acknowledgement_amount_mismatch');
  return { version: 1, orderId: order.id, orderNumber: order.id, issuedAt: at, issuedTo, currency: 'PHP',
    lines, deliveryFeeMinor, organizationDiscountMinor, voucherDiscountMinor, roundingAdjustmentMinor,
    grandTotalMinor, payments, note: ACKNOWLEDGEMENT_NOTE };
}

export async function readAcknowledgement(database, orderId) {
  return (await database.query('SELECT snapshot FROM acknowledgement_receipts WHERE order_id=$1', [orderId])).rows[0]?.snapshot ?? null;
}

/** Caller holds the domain transaction, so snapshot, number, audit and inbox commit together. */
export async function issueAcknowledgement({ database, store, order, user, now, id, audit }) {
  if (!database.inWriteTransaction()) throw new Error('Acknowledgement issuance requires a write transaction');
  const existing = await readAcknowledgement(database, order.id);
  if (existing) return { receipt: existing, created: false };
  if (order.fulfillmentMode !== 'delivery' || !order.riderId || !['picked_up', 'out_for_delivery'].includes(order.state)) {
    fail('acknowledgement_not_available');
  }
  const at = now();
  const snapshot = acknowledgementSnapshot(store, order, at);
  const sequence = (await database.query(`UPDATE acknowledgement_receipt_counter
    SET last_number=last_number+1 WHERE singleton RETURNING last_number`)).rows[0].last_number;
  const receipt = { ...snapshot, arNumber: `AR-${String(sequence).padStart(10, '0')}` };
  await database.query(`INSERT INTO acknowledgement_receipts(order_id,ar_sequence,issued_at,grand_total_minor,rounding_adjustment_minor,snapshot)
    VALUES($1,$2,$3,$4,$5,$6)`, [order.id, sequence, at, receipt.grandTotalMinor, receipt.roundingAdjustmentMinor, receipt]);
  audit(store, { actor: user, action: 'acknowledgement_receipt.issued', entityType: 'order', entityId: order.id,
    orderId: order.id, detail: { arNumber: receipt.arNumber } });
  for (const recipient of [{ userId: order.clientId, role: 'client' }, ...privilegedAdminMemberships(store)]) {
    store.notifications.push({ id: id('ntf'), userId: recipient.userId, appRole: recipient.role, orderId: order.id,
      type: 'acknowledgement_receipt_ready', title: 'Acknowledgement receipt ready',
      body: 'Your delivery acknowledgement receipt is available on the order.', at, read: false });
  }
  queueOrderInvalidate(store, order, ['orders', 'dispatch', 'notifications']);
  return { receipt, created: true };
}

const pesos = amount => {
  const value = BigInt(amount);
  const absolute = value < 0n ? -value : value;
  return `PHP ${value < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
};
export function acknowledgementPdf(receipt) {
  const lines = ['GRIDGO ACKNOWLEDGEMENT RECEIPT', '', `AR number: ${receipt.arNumber}`,
    `Order number: ${receipt.orderNumber}`, `Date issued: ${receipt.issuedAt}`, `Issued to: ${receipt.issuedTo}`, '',
    'Item description / quantity / unit price / subtotal'];
  for (const line of receipt.lines) {
    lines.push(line.description, `  Quantity: ${line.quantity}   Unit price: ${line.unitPriceMinor == null ? 'not recorded' : pesos(line.unitPriceMinor)}   Subtotal: ${pesos(line.subtotalMinor)}`);
  }
  lines.push('', 'Unit prices are indicative; use the item subtotals for this receipt.',
    `Delivery fee: ${pesos(receipt.deliveryFeeMinor)}`);
  if (receipt.organizationDiscountMinor) lines.push(`Organization discount: ${pesos(-receipt.organizationDiscountMinor)}`);
  if (receipt.voucherDiscountMinor) lines.push(`Voucher discount: ${pesos(-receipt.voucherDiscountMinor)}`);
  if (receipt.roundingAdjustmentMinor) lines.push(`Rounding adjustment: ${pesos(receipt.roundingAdjustmentMinor)}`);
  lines.push(`Grand total: ${pesos(receipt.grandTotalMinor)}`, '', 'Recorded payments (no amount to collect at the door)');
  const methodLabels = { qr_manual: 'Digital payment (manual QR)', gcash: 'GCash', maya: 'Maya',
    bank_transfer: 'Bank transfer', qr_ph: 'QR Ph', cash: 'Cash' };
  for (const payment of receipt.payments) {
    lines.push(`${methodLabels[payment.method] ?? payment.method ?? 'Payment method not recorded'}: ${pesos(payment.amountMinor)}`,
      `  Reference: ${payment.reference ?? 'not recorded'}`);
    if (payment.type === 'cash') lines.push(`  Amount received: ${payment.amountReceivedMinor == null ? 'not recorded' : pesos(payment.amountReceivedMinor)}`,
      `  Change: ${payment.changeMinor == null ? 'not recorded' : pesos(payment.changeMinor)}`);
  }
  lines.push('', 'Collected by (paper signature): __________________________',
    'Received by (paper signature): __________________________', '',
    'Signatures remain on the paper copy; this download does not certify a signature.', '', receipt.note);
  return textDocumentPdf(lines, 'GRIDGO Acknowledgement Receipt');
}

export async function routeAcknowledgement(args) {
  const { req, url, store, user, database } = args;
  const match = /^\/orders\/([^/]+)\/acknowledgement-receipt(\/download)?$/.exec(url.pathname);
  if (!match) return null;
  if (!user) fail('unauthorized', 401);
  const order = store.orders.find(row => row.id === match[1]);
  if (!order) fail('order_not_found', 404);
  const rider = user.role === 'rider' && order.riderId === user.id && approvedRole(store, user.id, 'rider');
  const owner = user.role === 'client' && order.clientId === user.id;
  if (!staff(user) && !owner && !rider) fail('forbidden', 403);
  if (req.method === 'POST' && !match[2]) {
    if (!rider && !staff(user)) fail('forbidden', 403);
    const { receipt, created } = await issueAcknowledgement({ ...args, order });
    return { status: created ? 201 : 200, body: { receipt }, mutated: created };
  }
  if (req.method !== 'GET') fail('not_found', 404);
  if (match[2] && !owner && !staff(user)) fail('forbidden', 403);
  const receipt = await readAcknowledgement(database, order.id);
  if (!receipt) fail('acknowledgement_receipt_not_found', 404);
  if (match[2]) return { status: 200, pdf: acknowledgementPdf(receipt), filename: `${receipt.arNumber}.pdf` };
  return { status: 200, body: { receipt } };
}
