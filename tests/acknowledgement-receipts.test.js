import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgementSnapshot, acknowledgementPdf, activeAcknowledgementHandover, ACKNOWLEDGEMENT_NOTE } from '../src/acknowledgement-receipts.js';
import { publicOrderFor } from '../src/operational-model.js';

function fixture(lines = [5005, 5005]) {
  const principal = lines.reduce((a, b) => a + b, 0);
  const fee = Math.floor((principal * 1000 + 5000) / 10000);
  const order = { id: 'order', clientId: 'client', fulfillmentMode: 'delivery', state: 'out_for_delivery',
    supplierSubtotalMinor: principal, serviceFeeMinor: fee, serviceFeeRateBps: 1000,
    deliveryFeeMinor: 5000, totalMinor: principal + fee + 5000,
    payments: { initial: { method: 'qr_manual', reference: 'QR-123', amountMinor: principal + fee + 5000, status: 'confirmed' },
      final_online: { method: 'qr_manual', amountMinor: 0, status: 'not_required' } } };
  const snapshot = { ...order, itemSubtotalMinor: principal,
    lines: lines.map((amountMinor, i) => ({ id: `line${i}`, itemName: `Item ${i}`, quantity: 1, unitPriceMinor: amountMinor, amountMinor })) };
  return { order, store: { users: [{ id: 'client', name: 'Client name' }], orderInvoices: [{ orderId: order.id, snapshot }] } };
}
const at = '2026-10-21T01:00:00.000Z';
test('receipt access requires current-assignment arrival and an unfinished door handover', () => {
  const rider = { id: 'rider', role: 'rider' };
  const order = { id: 'order', riderId: 'rider', fulfillmentMode: 'delivery', state: 'out_for_delivery', riderAssignedAt: at,
    riderProgress: { riderId: 'rider', assignedAt: at, events: { arrived: at } } };
  assert.equal(activeAcknowledgementHandover(order, rider), true);
  for (const patch of [
    { fulfillmentMode: 'pickup' }, { state: 'rider_assigned' }, { state: 'completed' }, { state: 'cancelled' },
    { state: 'issue_window_open' }, { riderId: 'other' }, { riderAssignedAt: '2026-10-21T02:00:00.000Z' },
    { riderProgress: null }, { deliveryEvidence: { recordedAt: at } }, { handover: { consumedAt: at } },
    { riderProgress: { riderId: 'rider', assignedAt: at, events: {} } },
  ]) assert.equal(Boolean(activeAcknowledgementHandover({ ...order, ...patch }, rider)), false);
  assert.equal(activeAcknowledgementHandover(order, { id: 'other', role: 'rider' }), false);
  assert.equal(activeAcknowledgementHandover(order, { id: 'rider', role: 'client' }), false);
});
test('ordinary rider projections never inline receipt or billing even inside the authorized handover window', () => {
  const { store, order } = fixture();
  Object.assign(order, { riderId: 'rider', acknowledgementReceipt: { grandTotalMinor: 16011 },
    clientItemSubtotalMinor: 11011, grandTotalMinor: 16011, supplementalTotalMinor: 50, totalIncludingSupplementsMinor: 16061,
    riderProgress: { riderId: 'rider', assignedAt: null, events: { arrived: at } } });
  for (const state of ['rider_assigned', 'out_for_delivery', 'issue_window_open', 'completed', 'cancelled']) {
    const view = publicOrderFor({ ...order, state }, { id: 'rider', role: 'rider' }, store);
    for (const key of ['acknowledgementReceipt', 'clientItemSubtotalMinor', 'grandTotalMinor', 'totalMinor', 'supplementalTotalMinor', 'totalIncludingSupplementsMinor']) {
      assert.equal(view[key], undefined, `${state}.${key}`);
    }
    assert.deepEqual(view.payments, { initial: { status: 'confirmed' }, final_online: { status: 'not_required' } });
  }
});
test('receipt preserves client line amounts, original total and bounded signed rounding adjustment', () => {
  const { store, order } = fixture();
  const receipt = acknowledgementSnapshot(store, order, at);
  assert.deepEqual(receipt.lines.map(l => l.subtotalMinor), [5506, 5506]);
  assert.equal(receipt.grandTotalMinor, 16011);
  assert.equal(receipt.roundingAdjustmentMinor, -1);
  assert.equal(receipt.deliveryFeeMinor, 5000);
  assert.equal(receipt.issuedTo, 'Client name');
  assert.equal(receipt.note, ACKNOWLEDGEMENT_NOTE);
  assert.deepEqual(receipt.payments, [{ code: 'initial', type: 'digital', method: 'qr_manual', reference: 'QR-123', amountMinor: 16011, amountReceivedMinor: null, changeMinor: null }]);
  assert.equal(JSON.stringify(receipt).includes('supplier'), false);
});
test('single line, discounts and zero rounding retain exact checkout money', () => {
  const { store, order } = fixture([10000]);
  Object.assign(order, { organizationDiscountMinor: 500, voucherDiscountMinor: 100, totalMinor: 15400 });
  order.payments.initial.amountMinor = 15400;
  Object.assign(store.orderInvoices[0].snapshot, { organizationDiscountMinor: 500, voucherDiscountMinor: 100, totalMinor: 15400 });
  const receipt = acknowledgementSnapshot(store, order, at);
  assert.equal(receipt.roundingAdjustmentMinor, 0);
  assert.equal(receipt.organizationDiscountMinor, 500);
  assert.equal(receipt.voucherDiscountMinor, 100);
  assert.equal(receipt.grandTotalMinor, 15400);
});
test('basket receipt is restricted to its group and uses shared recorded payment reference', () => {
  const { store, order } = fixture([10000]);
  const group = { ...store.orderInvoices[0].snapshot, orderId: order.id };
  order.basketId = 'basket';
  store.baskets = [{ id: 'basket', receiptOrderId: 'first', orderIds: ['first', order.id], payment: { method: 'qr_manual', reference: 'BASKET', status: 'confirmed' } }];
  store.orderInvoices = [{ orderId: 'first', snapshot: { ...group, totalMinor: 999999, groups: [{ ...group, orderId: 'first', lines: [{ itemName: 'Other shop' }] }, group] } }];
  const receipt = acknowledgementSnapshot(store, order, at);
  assert.equal(receipt.grandTotalMinor, 16000);
  assert.equal(receipt.lines.length, 1);
  assert.equal(receipt.payments[0].reference, 'BASKET');
  assert.equal(JSON.stringify(receipt).includes('Other shop'), false);
});
test('recorded payment methods are preserved without inventing wallet or cash facts', () => {
  for (const [method, type] of [['gcash', 'digital'], ['maya', 'digital'], ['bank_transfer', 'digital'], ['qr_ph', 'digital'], ['cash', 'cash'], ['legacy_unknown', 'unknown']]) {
    const { store, order } = fixture([10000]);
    Object.assign(order.payments.initial, { method, amountReceivedMinor: 20000, changeMinor: 4000 });
    const receipt = acknowledgementSnapshot(store, order, at);
    assert.equal(receipt.payments[0].method, method);
    assert.equal(receipt.payments[0].type, type);
    assert.equal(receipt.payments[0].amountReceivedMinor, type === 'cash' ? 20000 : null);
    assert.equal(receipt.payments[0].changeMinor, type === 'cash' ? 4000 : null);
  }
});
test('large discrepancies and checkout snapshot disagreement fail closed', () => {
  const { store, order } = fixture();
  order.totalMinor += 3;
  assert.throws(() => acknowledgementSnapshot(store, order, at), { code: 'acknowledgement_amount_mismatch' });
  store.orderInvoices[0].snapshot.totalMinor = order.totalMinor;
  order.totalMinor += 100;
  store.orderInvoices[0].snapshot.totalMinor = order.totalMinor;
  assert.throws(() => acknowledgementSnapshot(store, order, at), { code: 'acknowledgement_amount_mismatch' });
});
test('progressive multi-item lines use the existing allocated fee and indicative unit prices', () => {
  const { store, order } = fixture([200000, 300000]);
  Object.assign(order, { serviceFeeMinor: 165000, totalMinor: 670000 });
  order.payments.initial.amountMinor = 670000;
  Object.assign(store.orderInvoices[0].snapshot, { serviceFeeMinor: 165000, grossServiceFeeMinor: 165000, totalMinor: 670000,
    serviceFeeSchedule: { version: 2, rounding: 'half_up_once', brackets: [{ upToMinor: 200000, rateBps: 4500 }, { upToMinor: 2000000, rateBps: 2500 }, { upToMinor: null, rateBps: 1500 }] } });
  const receipt = acknowledgementSnapshot(store, order, at);
  assert.deepEqual(receipt.lines.map(l => l.subtotalMinor), [266000, 399000]);
  assert.equal(receipt.grandTotalMinor, 670000);
  assert.equal(receipt.roundingAdjustmentMinor, 0);
});
test('legacy aggregate quotes retain quantity and total without inventing a unit rate', () => {
  const { store, order } = fixture([10000]);
  store.orderInvoices = [];
  Object.assign(order, { title: 'Quoted flyers', quantity: 3 });
  const receipt = acknowledgementSnapshot(store, order, at);
  assert.deepEqual(receipt.lines, [{ id: 'order', description: 'Quoted flyers', quantity: 3, unitPriceMinor: null, subtotalMinor: 11000 }]);
});
test('download has the disclaimer, exact money, signatures and nonzero adjustment only', () => {
  const { store, order } = fixture();
  const receipt = { ...acknowledgementSnapshot(store, order, at), arNumber: 'AR-0000000001' };
  const pdf = acknowledgementPdf(receipt).toString();
  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.match(pdf, /Rounding adjustment: PHP -0.01/);
  assert.match(pdf, /Grand total: PHP 160.11/);
  assert.match(pdf, /Collected by/);
  assert.match(pdf, /Received by/);
  assert.match(pdf, /does not replace an/);
  assert.match(pdf, /Official Receipt or final invoice/);
  receipt.roundingAdjustmentMinor = 0;
  assert.doesNotMatch(acknowledgementPdf(receipt).toString(), /Rounding adjustment/);
});
