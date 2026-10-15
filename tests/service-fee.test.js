import test from 'node:test';
import assert from 'node:assert/strict';
import { organizationFeeMoney } from '../src/organization-money.js';
import { voucherMoney } from '../src/voucher-money.js';

const schedule = { version: 2, rounding: 'half_up_once', brackets: [
  { upToMinor: 200000, rateBps: 4500 }, { upToMinor: 2000000, rateBps: 2500 }, { upToMinor: null, rateBps: 1500 },
] };
const settings = { serviceFeeRateBps: 1000, organizationDiscountRateBps: 500, serviceFeeSchedule: schedule };
test('progressive fees match every report example, including preview PHP 500', () => {
  for (const [principal, fee] of [[50000,22500],[199900,89955],[200000,90000],[500000,165000],[2000000,540000],[5000000,990000]]) {
    const money = organizationFeeMoney(principal, settings);
    assert.equal(money.grossServiceFeeMinor, fee);
    assert.deepEqual(money.serviceFeeSchedule, schedule);
  }
});
test('half-centavos round once on the exact combined bracket numerator', () => {
  const custom = { ...settings, organizationDiscountRateBps: 0, serviceFeeSchedule: { ...schedule, brackets: [
    { upToMinor: 1, rateBps: 5000 }, { upToMinor: null, rateBps: 5000 },
  ] } };
  assert.equal(organizationFeeMoney(1, custom).grossServiceFeeMinor, 1);
  assert.equal(organizationFeeMoney(2, custom).grossServiceFeeMinor, 1);
  assert.equal(organizationFeeMoney(3, custom).grossServiceFeeMinor, 2);
});
test('bracket vouchers cap at the fee; organization discount leaves shop and delivery untouched', () => {
  const group = { supplierSubtotalMinor: 500000, deliveryFeeMinor: 8900, ...organizationFeeMoney(500000, settings, true) };
  assert.equal(group.organizationDiscountMinor, 25000);
  const voucher = voucherMoney([group], 999999);
  assert.equal(voucher.voucherDiscountMinor, 165000);
  assert.equal(voucher.groups[0].voucherDeliveryMinor, 0);
  assert.equal(voucher.groups[0].totalMinor, 508900);
  assert.equal(voucherMoney([group], 0).groups[0].totalMinor, 648900);
});

import { feeSchedule, serviceFeeMoney, validateFeeSchedule, nextFeeSettings, serviceFeePreview } from '../src/service-fee.js';
import { publicOrderFor, defaultOperationalSettings, calculateOrderMoney } from '../src/operational-model.js';
import { clientInvoice } from '../src/invoice-projection.js';

test('every centavo through both boundaries is monotone and each extra centavo costs at most one fee centavo', () => {
  let previous = 0;
  for (let n = 0; n <= 2000100; n++) {
    // Closed-form independent oracle for this published table.
    const expected = n <= 200000 ? Math.floor((n * 45 + 50) / 100)
      : n <= 2000000 ? 90000 + Math.floor(((n - 200000) * 25 + 50) / 100)
      : 540000 + Math.floor(((n - 2000000) * 15 + 50) / 100);
    const fee = serviceFeeMoney(n, schedule).grossServiceFeeMinor;
    assert.equal(fee, expected);
    assert.ok(fee >= previous && fee - previous <= 1);
    previous = fee;
  }
});
test('invalid schedules and unsafe money fail closed', () => {
  for (const brackets of [[], [{ upToMinor: 5, rateBps: 500 }], [{upToMinor:null,rateBps:10001}],
    [{upToMinor:0,rateBps:100},{upToMinor:null,rateBps:100}], [{upToMinor:1.5,rateBps:100},{upToMinor:null,rateBps:100}],
    [{upToMinor:2,rateBps:100},{upToMinor:1,rateBps:100},{upToMinor:null,rateBps:100}], [{upToMinor:null,rateBps:'500'}]]) {
    assert.throws(() => validateFeeSchedule({ ...schedule, brackets }), { code: 'invalid_service_fee_schedule' });
  }
  for (const n of [-1, 0.5, '10', NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => serviceFeeMoney(n, schedule), { code: 'invalid_money' });
  const zero = { ...schedule, brackets: [{ upToMinor: null, rateBps: 0 }] };
  assert.equal(serviceFeeMoney(Number.MAX_SAFE_INTEGER, zero).grossServiceFeeMinor, 0);
});
test('scheduled rate switches exactly at the effective instant; previews never change settings', () => {
  const before = '2026-10-15T00:00:00.000Z', effective = '2026-10-16T00:00:00.000Z';
  const old = { serviceFeeRateBps: 1000 };
  const body = { serviceFeeBrackets: schedule.brackets, serviceFeeEffectiveFrom: effective };
  const next = { ...old, ...nextFeeSettings(old, body, 8, before) };
  assert.equal(serviceFeeMoney(500000, feeSchedule(next, before)).grossServiceFeeMinor, 50000);
  assert.equal(serviceFeeMoney(500000, feeSchedule(next, effective)).grossServiceFeeMinor, 165000);
  const saved = structuredClone(next);
  const preview = serviceFeePreview(next, { serviceFeeBrackets: [{ upToMinor:null,rateBps:2000 }] }, 8, before);
  assert.equal(preview.examples[3].next.grossServiceFeeMinor, 100000);
  assert.deepEqual(next, saved);
  assert.throws(() => nextFeeSettings(old, { ...body, serviceFeeEffectiveFrom: before }, 8, effective), {code:'invalid_service_fee_effective_from'});
});
test('staff alone see bracket working; client order and nested quotes retain a combined price', () => {
  const money = calculateOrderMoney({supplierSubtotalMinor:500000, fulfillmentMode:'delivery', paymentPlan:'delivery_online',
    supplierDownpaymentRateBps:2500,distanceMeters:0,settings:{...defaultOperationalSettings(), ...settings}});
  const order = {id:'o',clientId:'c',state:'awaiting_initial_payment',...money,acceptedQuote:{...money},quoteHistory:[{...money}]};
  const client = publicOrderFor(order,{id:'c',role:'client'});
  assert.equal(client.clientItemSubtotalMinor,665000);
  assert.equal(JSON.stringify(client).includes('serviceFeeSchedule'),false);
  assert.equal(JSON.stringify(client).includes('serviceFeeWorking'),false);
  assert.equal(publicOrderFor(order,{role:'ops_admin'}).serviceFeeWorking[1].amountMinor,75000);
});
test('invoice group line allocations sum to the preserved fee-inclusive amount and hide snapshots', () => {
  const invoice = clientInvoice({itemSubtotalMinor:500000,serviceFeeMinor:165000,grossServiceFeeMinor:165000,
    serviceFeeSchedule:schedule,lines:[{amountMinor:200000,unitPriceMinor:200000},{amountMinor:300000,unitPriceMinor:300000}]});
  assert.equal(invoice.clientItemSubtotalMinor,665000);
  assert.equal(invoice.lines.reduce((sum,line)=>sum+line.clientAmountMinor,0),665000);
  assert.equal(JSON.stringify(invoice).includes('serviceFeeSchedule'),false);
});

import { createPaymentSchedule } from '../src/operational-model.js';
import { applyVoucherMoney } from '../src/voucher-money.js';
import { calculateRefundSettlement } from '../src/refund-policy.js';
test('partial refund prorates the fee actually paid after a bracket voucher', () => {
  const money=calculateOrderMoney({supplierSubtotalMinor:500000,fulfillmentMode:'pickup',paymentPlan:'pickup_full_online',
    supplierDownpaymentRateBps:10000,settings:{...defaultOperationalSettings(),...settings}});
  const order={...money,...createPaymentSchedule(money),payoutMilestones:[],moneyModelVersion:3};
  order.payments.final_online={amountMinor:0,status:'not_required'};
  applyVoucherMoney(order,voucherMoney([order],100000).groups[0],{id:'v',campaignId:'c'});
  for(const payment of Object.values(order.payments)) if(payment.amountMinor) payment.status='confirmed';
  const refund=calculateRefundSettlement(order,{beforeProduction:false,shopEntitlementMinor:250000,riderEntitlementMinor:0,principalMinor:250000});
  assert.equal(refund.feeMinor,32500);
  assert.equal(refund.totalMinor,282500);
  assert.equal(order.supplierPlatformPayoutMinor,500000);
});
