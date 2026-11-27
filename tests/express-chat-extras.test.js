import test from 'node:test';
import assert from 'node:assert/strict';
import * as extras from '../src/express-chat-extras.js';
import { serviceFeeMoney } from '../src/service-fee.js';
const schedule = { version: 3, rule: 'express_minimum_or_rate', minimumMinor: 500, rateBps: 2000, roundTotalUpToMinor: 50 };
test('printing plus extras use the locked accept-first fee and exact minor units', () => {
  assert.equal(typeof extras.extraPrice, 'function');
  const order = { supplierSubtotalMinor: 10800, serviceFeeSchedule: schedule, serviceFeeMinor: 2200, deliveryFeeMinor: 0 };
  const money = extras.extraPrice(order, [{ quantity: 3, unitPriceMinor: 100 }]);
  assert.equal(money.printingMinor, 10800); assert.equal(money.extrasMinor, 300);
  assert.equal(money.grossServiceFeeMinor, serviceFeeMoney(11100, schedule).grossServiceFeeMinor);
  assert.equal(money.totalMinor, 13350);
  assert.throws(() => extras.extraPrice(order, [{ quantity: 2, unitPriceMinor: Number.MAX_SAFE_INTEGER }]), { code: 'invalid_money' });
});

test('rounding preserves fixed discount funding or refuses a new quote that cannot fund it', () => {
  const order = { supplierSubtotalMinor: 101, serviceFeeSchedule: schedule, deliveryFeeMinor: 0,
    serviceFeeMinor: 549, voucherServiceFeeMinor: 549, voucherDiscountMinor: 549 };
  assert.throws(() => extras.extraPrice(order, [{ quantity: 1, unitPriceMinor: 49 }]), { code: 'express_extra_discount_requote_required' });
  const money = extras.extraPrice({ ...order, voucherServiceFeeMinor: 100, voucherDiscountMinor: 100 }, [{ quantity: 1, unitPriceMinor: 49 }]);
  assert.equal(money.serviceFeeMinor, 500); assert.equal(money.totalMinor, 550);
});
