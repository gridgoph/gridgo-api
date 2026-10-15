import assert from "node:assert/strict";
import test from "node:test";

import {
  averageAndMedian,
  breakEvenOrders,
  buildFunnelEvent,
  funnelDropOff,
  pricingDashboard,
  subtractEarnings,
} from "../src/pricing-dashboard.js";

const hour = 60 * 60 * 1000;
const start = "2026-10-01T00:00:00.000Z";
const at = (ms) => new Date(Date.parse(start) + ms).toISOString();

test("a checkout unpaid for 24 hours is a drop-off, and a payment at the 24th hour is not", () => {
  const reached = { id: "c1", at: start, clientId: "client", kind: "checkout_reached", orderId: null };
  const onTime = { id: "p1", at: at(24 * hour), clientId: "client", kind: "paid", orderId: "ord_1" };
  assert.deepEqual(funnelDropOff([reached], [reached, onTime], Date.parse(at(48 * hour))), {
    dropOff: 0, open: 0, paidInTime: 1, reached: 1,
  });

  const late = { ...onTime, at: at(24 * hour + 1) };
  assert.equal(funnelDropOff([reached], [reached, late], Date.parse(at(48 * hour))).dropOff, 1);

  assert.deepEqual(funnelDropOff([reached], [reached], Date.parse(at(hour))), {
    dropOff: 0, open: 1, paidInTime: 0, reached: 1,
  });
  assert.equal(funnelDropOff([reached], [reached], Date.parse(at(24 * hour))).dropOff, 1);
});

test("average and median use every recorded value and skip nothing by turning it into zero", () => {
  assert.deepEqual(averageAndMedian([10, 30]), { average: 20, median: 20, count: 2 });
  assert.deepEqual(averageAndMedian([1, 2, 9]), { average: 4, median: 2, count: 3 });
  assert.deepEqual(averageAndMedian([]), { average: null, median: null, count: 0 });
});

test("earnings subtract every stored cost, and a cost that is not stored stays unknown", () => {
  const full = subtractEarnings({
    feeMinor: 1_000,
    paymentFeeMinor: 100,
    voucherMinor: 50,
    discountMinor: 20,
    reprintShareMinor: 10,
    refundShareMinor: 30,
    deliveryAbsorbedMinor: 40,
  });
  assert.equal(full.remains.minor, 750);

  const missing = subtractEarnings({
    feeMinor: 1_000,
    paymentFeeMinor: 100,
    voucherMinor: null,
    discountMinor: 0,
    reprintShareMinor: null,
    refundShareMinor: 0,
    deliveryAbsorbedMinor: 0,
  });
  assert.equal(missing.voucherMinor.known, false);
  assert.equal(missing.reprintShareMinor.known, false);
  assert.equal(missing.remains.known, false);
  assert.notEqual(missing.voucherMinor.minor, 0);
});

test("break-even orders come from the entered fixed costs and the fee after the payment percentage", () => {
  assert.deepEqual(breakEvenOrders(10_000, 1_000, 1_000), { known: true, orders: 12 });
  assert.deepEqual(breakEvenOrders(null, 1_000, 1_000), { known: false, orders: null });
});

test("the dashboard compares two ranges and does not invent a funnel or a reprint cost", () => {
  const events = [
    { id: "a", at: "2026-10-01T01:00:00.000Z", clientId: "c", kind: "checkout_reached", orderId: null, exitAnswer: null },
    { id: "b", at: "2026-10-03T01:00:00.000Z", clientId: "c", kind: "checkout_reached", orderId: null, exitAnswer: null },
    { id: "c", at: "2026-10-03T02:00:00.000Z", clientId: "c", kind: "checkout_left", orderId: null, exitAnswer: null },
  ];
  const report = pricingDashboard({
    events,
    orders: [{
      id: "ord_1", clientId: "c", createdAt: "2026-10-01T00:00:00.000Z", state: "completed",
      updatedAt: "2026-10-02T08:00:00.000Z", supplierSubtotalMinor: 10_000, serviceFeeMinor: 1_000,
      totalMinor: 11_000, fulfillmentMode: "pickup", organizationDiscountMinor: 0,
      timeline: [{ at: "2026-10-02T08:00:00.000Z", state: "completed" }],
    }],
    users: [{ id: "c", accountType: "individual" }],
    refunds: [{ orderId: "ord_1", feeMinor: 100, platformDeliveryMinor: 50 }],
    settings: { pricingFixedCostsMinor: 10_000, pricingPaymentFeeBps: 1_000 },
    query: { from: "2026-10-01", to: "2026-10-01", compareFrom: "2026-10-03", compareTo: "2026-10-03" },
    now: "2026-10-15T00:00:00.000Z",
  });
  assert.equal(report.period.funnel.counts.checkout_reached, 1);
  assert.equal(report.period.funnel.dropOff, 1);
  assert.equal(report.compare.funnel.counts.checkout_reached, 1);
  assert.equal(report.compare.funnel.counts.checkout_left, 1);
  assert.equal(report.compare.funnel.exitQuestion.asked, false);
  assert.match(report.compare.funnel.exitQuestion.message, /not asked yet/);
  assert.equal(report.period.reprints.cost.known, false);
  assert.equal(report.period.refunds.gridgo.minor, 150);
  assert.equal(report.period.refunds.shop.known, false);
  assert.equal(report.completedThisMonth, 1);
  assert.equal(report.breakEven.orders, 12);
  assert.equal(report.period.earnings[0].voucherMinor.known, false);
  assert.equal(report.period.earnings[0].remains.known, false);
  assert.match(report.period.operations.note, /minimum/);
});

test("a stored exit answer is counted, and the event still requires a client and a kind", () => {
  const event = buildFunnelEvent({ kind: "checkout_left", exitAnswer: "Too expensive" }, { id: "c" }, start, "fun_1");
  assert.equal(event.exitAnswer, "Too expensive");
  assert.throws(() => buildFunnelEvent({ kind: "elsewhere" }, { id: "c" }, start, "fun_2"), /kind/);
});
