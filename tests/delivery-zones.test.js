import test from "node:test";
import assert from "node:assert/strict";
import * as model from "../src/operational-model.js";

const bands = () => [
  { zone: "nearby", label: "Nearby", maxDistanceMeters: 5000, feeMinor: 2500 },
  { zone: "away", label: "Away", maxDistanceMeters: 10000, feeMinor: 5000 },
  { zone: "long_distance", label: "Long Distance", maxDistanceMeters: 15000, feeMinor: 7500 },
  { zone: "out_of_zone", label: "Out of Zone", maxDistanceMeters: null, baseFeeMinor: 4000, perKmMinor: 1500 },
];

test("one inclusive zone table determines the distance label and delivery price", () => {
  const settings = model.defaultOperationalSettings();
  for (const [distance, key, label, fee] of [
    [0, "nearby", "Nearby", 2500], [4999, "nearby", "Nearby", 2500],
    [5000, "nearby", "Nearby", 2500], [5001, "away", "Away", 5000],
    [10000, "away", "Away", 5000], [10001, "long_distance", "Long Distance", 7500],
    [15000, "long_distance", "Long Distance", 7500], [15001, "out_of_zone", "Out of Zone", 28000],
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
    (rows) => { rows[0].maxDistanceMeters = 10001; },
    (rows) => { rows[1].maxDistanceMeters = null; },
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
