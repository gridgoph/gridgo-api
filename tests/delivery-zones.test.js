import test from "node:test";
import assert from "node:assert/strict";
import * as model from "../src/operational-model.js";

const bands = () => [
  { zone: "nearby", label: "Nearby", maxDistanceMeters: 5000, feeMinor: 8900 },
  { zone: "away", label: "Away", maxDistanceMeters: 10000, feeMinor: 14900 },
  { zone: "long_distance", label: "Long Distance", maxDistanceMeters: 15000, feeMinor: 22900 },
  { zone: "out_of_zone", label: "Out of Zone", maxDistanceMeters: null, baseFeeMinor: 4000, perKmMinor: 1500 },
];

test("one inclusive zone table determines the distance label and delivery price", () => {
  const settings = model.defaultOperationalSettings();
  for (const [distance, key, label, fee] of [
    [0, "nearby", "Nearby", 8900], [4999, "nearby", "Nearby", 8900],
    [5000, "nearby", "Nearby", 8900], [5001, "away", "Away", 14900],
    [10000, "away", "Away", 14900], [10001, "long_distance", "Long Distance", 22900],
    [15000, "long_distance", "Long Distance", 22900], [15001, "out_of_zone", "Out of Zone", 28000],
    [16000, "out_of_zone", "Out of Zone", 28000], [16001, "out_of_zone", "Out of Zone", 29500],
    [16200, "out_of_zone", "Out of Zone", 29500],
    [20550, "out_of_zone", "Out of Zone", 35500],
  ]) {
    assert.equal(model.deliveryFeeForDistance(distance, settings), fee, `${distance}m fee`);
    assert.deepEqual(model.distanceZoneForDistance(distance, settings), { key, label }, `${distance}m zone`);
  }
});

test("Out of Zone uses configurable integer money over the whole rounded-up distance and retains 85/15", () => {
  const settings = { ...model.defaultOperationalSettings(), deliveryFeeBands: bands() };
  Object.assign(settings.deliveryFeeBands[3], { baseFeeMinor: 8000, perKmMinor: 1200 });
  assert.equal(model.deliveryFeeForDistance(16000.1, settings), 28400);
  const money = model.calculateOrderMoney({
    supplierSubtotalMinor: 100000, fulfillmentMode: "delivery", paymentPlan: "delivery_online",
    supplierDownpaymentRateBps: 2500, distanceMeters: 16001, settings,
  });
  assert.equal(money.deliveryFeeMinor, 28400);
  assert.equal(money.riderPayoutMinor, 24140);
  assert.equal(money.platformDeliveryShareMinor, 4260);
  assert.equal(money.totalMinor, 138400);
  settings.deliveryFeeBands[3].baseFeeMinor = Number.MAX_SAFE_INTEGER;
  assert.throws(() => model.deliveryFeeForDistance(16001, settings), { code: "invalid_money" });
});

test("settings require four canonical ordered zones and safe minor-unit pricing", () => {
  const settings = { ...model.defaultOperationalSettings(), deliveryFeeBands: bands() };
  assert.equal(model.validateOperationalSettings(settings), true);
  for (const mutate of [
    (rows) => rows.pop(),
    (rows) => { rows[0].zone = "away"; },
    (rows) => { rows[0].label = "Around here"; },
    (rows) => rows.push({ ...rows[3] }),
    (rows) => { [rows[0], rows[1]] = [rows[1], rows[0]]; },
    (rows) => { rows[3].maxDistanceMeters = undefined; },
    (rows) => { rows[3].maxDistanceMeters = 20000; },
  ]) {
    const rows = bands(); mutate(rows);
    assert.throws(() => model.validateOperationalSettings({ ...settings, deliveryFeeBands: rows }), { code: "invalid_delivery_fee_bands" });
  }
  for (const [index, field] of [[0, "feeMinor"], [3, "baseFeeMinor"], [3, "perKmMinor"]]) {
    for (const value of [undefined, null, "1000", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const rows = bands(); rows[index][field] = value;
      assert.throws(() => model.validateOperationalSettings({ ...settings, deliveryFeeBands: rows }), { code: "invalid_money" });
    }
  }
});

for (const [limits, edges] of [
  [[1200, 6500, 23000], [
    [0, 0, 8900], [1199, 0, 8900], [1200, 0, 8900], [1201, 1, 14900],
    [6499, 1, 14900], [6500, 1, 14900], [6501, 2, 22900],
    [22999, 2, 22900], [23000, 2, 22900], [23001, 3, 40000],
  ]],
  [[1, 2, 100000], [[0, 0, 8900], [1, 0, 8900], [2, 1, 14900], [3, 2, 22900],
    [99999, 2, 22900], [100000, 2, 22900], [100001, 3, 155500]]],
]) {
  test(`custom inclusive limits ${limits.join('/')} drive labels and fee quotes together`, () => {
    const settings = model.defaultOperationalSettings();
    limits.forEach((limit, index) => { settings.deliveryFeeBands[index].maxDistanceMeters = limit; });
    assert.equal(model.validateOperationalSettings(settings), true);
    for (const [distance, bandIndex, expectedFee] of edges) {
      const band = settings.deliveryFeeBands[bandIndex];
      assert.deepEqual(model.distanceZoneForDistance(distance, settings), { key: band.zone, label: band.label });
      assert.equal(model.deliveryFeeForDistance(distance, settings), expectedFee);
      const quote = model.calculateOrderMoney({
        supplierSubtotalMinor: 10000, fulfillmentMode: 'delivery', paymentPlan: 'delivery_online',
        supplierDownpaymentRateBps: 2500, distanceMeters: distance, settings,
      });
      assert.equal(quote.deliveryFeeMinor, expectedFee, `${distance}m quote`);
    }
  });
}

test('zone limits require positive integer metres up to 100 km and strictly increasing order', () => {
  for (const index of [0, 1, 2]) {
    for (const value of [undefined, null, '5000', 0, -1, 1.5, NaN, Infinity, 100001, Number.MAX_SAFE_INTEGER]) {
      const settings = model.defaultOperationalSettings();
      settings.deliveryFeeBands[index].maxDistanceMeters = value;
      assert.throws(() => model.validateOperationalSettings(settings), error => {
        assert.equal(error.status, 400);
        assert.equal(error.code, 'invalid_delivery_zone_limit');
        assert.equal(error.details.field, `deliveryFeeBands[${index}].maxDistanceMeters`);
        return true;
      });
    }
  }
  for (const [index, value] of [[1, 5000], [1, 4999], [2, 10000], [2, 9999]]) {
    const settings = model.defaultOperationalSettings();
    settings.deliveryFeeBands[index].maxDistanceMeters = value;
    assert.throws(() => model.validateOperationalSettings(settings), { code: 'delivery_zone_limits_not_increasing' });
  }
});
