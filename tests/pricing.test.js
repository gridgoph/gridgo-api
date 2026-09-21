import test from "node:test";
import assert from "node:assert/strict";

import {
  PricingError,
  PRICING_UNITS,
  applyOptions,
  applicableVolumeTier,
  asksQuantity,
  billableUnits,
  fromPriceMinor,
  gridgoAmountMinor,
  measurementKindFor,
  priceLine,
} from "../src/pricing.js";

/**
 * Every case here is a real line from the pilot master list, priced against the
 * figure the shop actually charges. A pricing engine that passes invented
 * numbers proves nothing -- the question is whether Dara, Jopal, Lovis, Pins On
 * and Polymedia can all sell what they sell.
 */

function expectDomainError(fn, status, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof PricingError, true);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.match(error.message, /[A-Za-z]/);
    return true;
  });
}

// Thousandths of the listing's own measure unit: 3 ft is 3_000, 3.5 ft is 3_500.
const ft = (value) => Math.round(value * 1000);

test("every unit is declared and only measured units ask for a measurement", () => {
  assert.deepEqual([...PRICING_UNITS], [
    "per_unit", "per_package", "per_page", "per_area", "per_length", "whole_job",
  ]);
  assert.equal(measurementKindFor("per_area"), "area");
  assert.equal(measurementKindFor("per_length"), "length");
  assert.equal(measurementKindFor("per_page"), "pages");
  assert.equal(measurementKindFor("per_unit"), "none");
  assert.equal(measurementKindFor("per_package"), "none");
  assert.equal(measurementKindFor("whole_job"), "none");
  assert.equal(asksQuantity("whole_job"), false);
  assert.equal(asksQuantity("per_area"), true);
});

test("Polymedia: eco solvent tarpaulin at PHP 40 per sq.ft, 3x4 ft", () => {
  const line = priceLine({
    basePriceMinor: 4_000,
    unit: "per_area",
    quantity: 1,
    measurement: { width: ft(3), height: ft(4) },
  });
  assert.equal(line.billableMilliUnits, 12_000); // 12.000 sq.ft
  assert.equal(line.lineSubtotalMinor, 48_000); // PHP 480.00
  assert.equal(line.minimumMeasurementApplied, false);
});

test("Polymedia: a 1x4 banner is billed at the 2x4 rate for waste", () => {
  const line = priceLine({
    basePriceMinor: 4_000,
    unit: "per_area",
    quantity: 1,
    measurement: { width: ft(1), height: ft(4) },
    minimumMeasurement: { width: ft(2), height: ft(4) },
  });
  assert.equal(line.billableMilliUnits, 8_000); // charged 8 sq.ft, not 4
  assert.equal(line.lineSubtotalMinor, 32_000); // PHP 320.00
  assert.equal(line.minimumMeasurementApplied, true);
});

test("the minimum applies per banner, so two small banners are two minimums", () => {
  const line = priceLine({
    basePriceMinor: 4_000,
    unit: "per_area",
    quantity: 2,
    measurement: { width: ft(1), height: ft(4) },
    minimumMeasurement: { width: ft(2), height: ft(4) },
  });
  assert.equal(line.billableMilliUnits, 16_000);
  assert.equal(line.lineSubtotalMinor, 64_000);
});

test("a fractional size stays exact: 3.5 x 6.5 ft is 22.75 sq.ft", () => {
  const line = priceLine({
    basePriceMinor: 4_000,
    unit: "per_area",
    quantity: 1,
    measurement: { width: ft(3.5), height: ft(6.5) },
  });
  assert.equal(line.billableMilliUnits, 22_750);
  assert.equal(line.lineSubtotalMinor, 91_000); // PHP 910.00, no float drift
});

test("Polymedia: an acrylic plaque at PHP 100 per inch of height", () => {
  const line = priceLine({
    basePriceMinor: 10_000,
    unit: "per_length",
    quantity: 1,
    measurement: { length: 5_000 }, // 5 inches
  });
  assert.equal(line.lineSubtotalMinor, 50_000); // PHP 500.00, the shop's own worked example
});

test("Polymedia: the all-in signage package ignores quantity entirely", () => {
  const line = priceLine({ basePriceMinor: 540_000, unit: "whole_job", quantity: 9 });
  assert.equal(line.quantity, 1);
  assert.equal(line.lineSubtotalMinor, 540_000); // PHP 5,400.00
});

test("Jopal: mugs drop from PHP 100 to PHP 60 a piece at 250", () => {
  const tiers = [
    { minQuantity: 1, unitPriceMinor: 10_000 },
    { minQuantity: 250, unitPriceMinor: 6_000 },
  ];
  const small = priceLine({ basePriceMinor: 10_000, unit: "per_unit", quantity: 100, volumeTiers: tiers });
  assert.equal(small.lineSubtotalMinor, 1_000_000); // PHP 10,000.00
  assert.equal(small.volumeTierApplied.minQuantity, 1);

  const bulk = priceLine({ basePriceMinor: 10_000, unit: "per_unit", quantity: 300, volumeTiers: tiers });
  assert.equal(bulk.lineSubtotalMinor, 1_800_000); // PHP 18,000.00, not 30,000
  assert.equal(bulk.volumeTierApplied.minQuantity, 250);
});

test("a volume tier is the highest breakpoint reached, whatever order they are declared in", () => {
  const tiers = [
    { minQuantity: 250, unitPriceMinor: 6_000 },
    { minQuantity: 1, unitPriceMinor: 10_000 },
    { minQuantity: 1_000, unitPriceMinor: 4_500 },
  ];
  assert.equal(applicableVolumeTier(tiers, 249).minQuantity, 1);
  assert.equal(applicableVolumeTier(tiers, 250).minQuantity, 250);
  assert.equal(applicableVolumeTier(tiers, 5_000).minQuantity, 1_000);
  assert.equal(applicableVolumeTier([], 10), null);
});

test("Lovis: back-to-back doubles the price rather than adding a fixed amount", () => {
  const line = priceLine({
    basePriceMinor: 200, // PHP 2.00 a sheet, short bond
    unit: "per_unit",
    quantity: 1,
    options: [{ priceMultiplierBps: 20_000 }],
  });
  assert.equal(line.unitRateMinor, 400); // PHP 4.00
});

test("additions land before multipliers, so a multiplier doubles the configured job", () => {
  // PHP 2.00 short + PHP 0.50 to make it A4, then doubled for back-to-back.
  // Doubling the base first and then adding the paper would give 450, which is
  // the wrong answer and the reason the order is fixed rather than incidental.
  const rate = applyOptions(200n, [
    { priceModifierMinor: 50 },
    { priceMultiplierBps: 20_000 },
  ]);
  assert.equal(Number(rate), 500);
});

test("Lovis: hardbound is priced by speed, and the tier replaces the base rate", () => {
  const speeds = [
    { code: "d5", hours: 120, priceMinor: 25_000 },
    { code: "d3", hours: 72, priceMinor: 35_000 },
    { code: "d1", hours: 24, priceMinor: 50_000 },
    { code: "h3", hours: 3, priceMinor: 70_000 },
  ];
  const rush = priceLine({
    basePriceMinor: 25_000,
    unit: "per_unit",
    quantity: 1,
    speedTier: speeds[3],
  });
  assert.equal(rush.lineSubtotalMinor, 70_000); // PHP 700.00 at 2-3 hours
  assert.equal(rush.speedTierApplied.code, "h3");

  const standard = priceLine({ basePriceMinor: 25_000, unit: "per_unit", quantity: 1, speedTier: speeds[0] });
  assert.equal(standard.lineSubtotalMinor, 25_000); // PHP 250.00 at five days
});

test("Pins On: a flat rush fee is charged once against the order, not per pin", () => {
  const line = priceLine({
    basePriceMinor: 2_500, // PHP 25.00 a pin
    unit: "per_unit",
    quantity: 20,
    minimumOrderQuantity: 20,
    speedTier: { code: "under24", hours: 24, surchargeMinor: 10_000 },
  });
  assert.equal(line.lineSubtotalMinor, 60_000); // PHP 500.00 of pins + PHP 100.00 flat
});

test("Pins On: an order below the shop's minimum is refused, not silently repriced", () => {
  expectDomainError(
    () => priceLine({ basePriceMinor: 2_500, unit: "per_unit", quantity: 5, minimumOrderQuantity: 20 }),
    409,
    "below_minimum_quantity",
  );
});

test("Lovis: a 48-page thesis run three times is pages x copies, never 48 orders", () => {
  const line = priceLine({
    basePriceMinor: 200, // PHP 2.00 a page
    unit: "per_page",
    quantity: 3, // copies -- the client's number
    measurement: { pages: 48 }, // shape -- read off the file
  });
  assert.equal(line.quantity, 3);
  assert.equal(line.billableMilliUnits, 144_000); // 144 sheets
  assert.equal(line.lineSubtotalMinor, 28_800); // PHP 288.00
});

test("Dara: one set of plans is one job, and three sets are three", () => {
  const one = priceLine({
    basePriceMinor: 6_500, // PHP 65.00 an A2 CAD plot
    unit: "per_page",
    quantity: 1,
    measurement: { pages: 12 },
  });
  assert.equal(one.lineSubtotalMinor, 78_000); // PHP 780.00

  const three = priceLine({
    basePriceMinor: 6_500,
    unit: "per_page",
    quantity: 3,
    measurement: { pages: 12 },
  });
  assert.equal(three.lineSubtotalMinor, 234_000); // PHP 2,340.00
});

test("a page count is required before a per-page listing can be priced", () => {
  expectDomainError(
    () => priceLine({ basePriceMinor: 200, unit: "per_page", quantity: 1 }),
    400,
    "invalid_measurement",
  );
});

test("an area listing refuses to price without both measurements", () => {
  expectDomainError(
    () => billableUnits({ unit: "per_area", quantity: 1, measurement: { width: ft(3) } }),
    400,
    "invalid_measurement",
  );
});

test("money and measurements refuse anything that is not a positive whole number", () => {
  expectDomainError(
    () => priceLine({ basePriceMinor: 4_000, unit: "per_area", quantity: 0, measurement: { width: 1, height: 1 } }),
    400,
    "invalid_quantity",
  );
  expectDomainError(
    () => priceLine({ basePriceMinor: 1.5, unit: "per_unit", quantity: 1 }),
    400,
    "invalid_money",
  );
  expectDomainError(
    () => priceLine({ basePriceMinor: 100, unit: "per_unit", quantity: 1, options: [{ priceMultiplierBps: 0 }] }),
    400,
    "invalid_multiplier",
  );
  expectDomainError(
    () => priceLine({ basePriceMinor: 100, unit: "sold_by_vibes", quantity: 1 }),
    400,
    "invalid_pricing_unit",
  );
});

test("an option can never drive a line below zero", () => {
  const line = priceLine({
    basePriceMinor: 200,
    unit: "per_unit",
    quantity: 1,
    options: [{ priceModifierMinor: -900 }],
  });
  assert.equal(line.lineSubtotalMinor, 0);
});

test("the From price counts required steps only, never add-ons", () => {
  const groups = [
    { kind: "spec", required: true, options: [{ priceModifierMinor: 0 }, { priceModifierMinor: 1_500 }] },
    { kind: "addon", required: false, options: [{ priceModifierMinor: 2_500 }] },
  ];
  assert.equal(fromPriceMinor({ basePriceMinor: 2_500, groups }), 2_500);
});

test("the From price falls to the cheapest speed a shop sells", () => {
  assert.equal(
    fromPriceMinor({
      basePriceMinor: 70_000,
      speedTiers: [{ priceMinor: 25_000 }, { priceMinor: 70_000 }],
    }),
    25_000, // Lovis hardbound reads "From PHP 250.00", not PHP 700.00
  );
});

test("GRIDGO amount is the shop figure plus the fee, in minor units, no floats", () => {
  // ₱12.00 at 45% is ₱17.40. At 10% it is ₱13.20.
  assert.equal(gridgoAmountMinor(1_200, 4_500), 1_740);
  assert.equal(gridgoAmountMinor(1_200, 1_000), 1_320);
  assert.equal(gridgoAmountMinor(0, 4_500), 0);
  assert.equal(gridgoAmountMinor(null, 4_500), null);
});
