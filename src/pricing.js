/**
 * What a listing costs, for every way a real shop sells.
 *
 * The first catalogue model had one shape: a base price, options that each
 * added a flat amount, multiplied by a whole number of units or packs. That
 * covers a stack of flyers and nothing else. Three of the five shops on the
 * pilot master list price work it cannot express at all — Polymedia bills
 * tarpaulin by the square foot and plaques by the inch of height, Jopal drops
 * mugs from PHP 100 to PHP 60 a piece at 250, and Lovis prices hardbound
 * entirely by how fast it is wanted.
 *
 * So the unit is the shop's to choose, and four rules sit under it. Nothing
 * here is required: a listing that sells flyers per pack of 100 declares a unit
 * and a price and never meets any of the rest.
 *
 * Money is integer PHP minor units throughout and never touches a float.
 * Measurements are integers in thousandths of the listing's own measure unit
 * (3.5 ft is 3_500), so an area is exact and only the final peso amount is
 * rounded — half-up, the same direction as `roundBps` in the operational model.
 */

const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const MILLI = 1_000n;
const MILLI_SQUARED = MILLI * MILLI;
const BPS = 10_000n;

/**
 * How a shop sells the thing. Chosen once per listing, and it decides what shape
 * the job has -- which is the part GRIDGO can read off the artwork.
 *
 * Shape is never quantity. A 48-page thesis printed once is one job, not
 * forty-eight, so the page count is the job's shape and `quantity` stays what
 * the client asked for: how many of these. Dara's whole business is that
 * distinction -- a set of drawings, run as several sets.
 */
export const PRICING_UNITS = Object.freeze([
  "per_unit",
  "per_package",
  "per_page",
  "per_area",
  "per_length",
  "whole_job",
]);

/** The unit a shop states its measurements in. Area is that unit squared. */
export const MEASURE_UNITS = Object.freeze(["mm", "cm", "in", "ft", "m"]);

export class PricingError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "PricingError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details = {}) {
  throw new PricingError(status, code, message, details);
}

function minor(value, field) {
  if (!Number.isSafeInteger(value)) {
    fail(400, "invalid_money", `${field} must be a safe integer in PHP minor units.`, { field });
  }
  return BigInt(value);
}

function toNumber(value, field) {
  if (value > MAX_SAFE_MINOR || value < -MAX_SAFE_MINOR) {
    fail(400, "invalid_money", `${field} exceeds the supported money range.`, { field });
  }
  return Number(value);
}

/** A measurement in thousandths of the listing's measure unit. Never negative, never zero. */
function milliUnits(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(400, "invalid_measurement", `${field} must be a positive whole number of thousandths.`, { field });
  }
  return BigInt(value);
}

/** Half-up, so a half-centavo lands the same way everywhere in the platform. */
function divideRounded(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

/**
 * What the client has to be asked before this listing can be priced.
 *
 * The listing's unit decides the questions, which is why the unit is the one
 * field a shop cannot leave blank. `whole_job` asks nothing at all — a
 * PHP 5,400 all-in signage package has no quantity and no measurement.
 */
export function measurementKindFor(unit) {
  if (unit === "per_area") return "area";
  if (unit === "per_length") return "length";
  if (unit === "per_page") return "pages";
  return "none";
}

export function asksQuantity(unit) {
  return unit !== "whole_job";
}

export function isPricingUnit(value) {
  return PRICING_UNITS.includes(value);
}

export function isMeasureUnit(value) {
  return MEASURE_UNITS.includes(value);
}

/**
 * How much of the shop's unit this job actually bills for.
 *
 * Area and length carry a minimum because a small job wastes the same sheet as
 * a big one: Polymedia bills a 1x4 tarpaulin at the 2x4 rate, and being unable
 * to say so means being underpaid on every small order. The minimum applies to
 * the measurement, before quantity, so two small banners are two minimums
 * rather than one.
 */
export function billableUnits({ unit, quantity, measurement = null, minimumMeasurement = null }) {
  if (unit === "whole_job") return MILLI;

  const count = Number.isSafeInteger(quantity) && quantity > 0
    ? BigInt(quantity)
    : fail(400, "invalid_quantity", "Quantity must be a positive whole number.", { field: "quantity" });

  if (unit === "per_unit" || unit === "per_package") return count * MILLI;

  // Pages times copies. Both are whole counts, so nothing here is fractional --
  // it shares this function only because it is the same "shape times how many"
  // arithmetic that area and length use.
  if (unit === "per_page") {
    const pages = measurement?.pages;
    if (!Number.isSafeInteger(pages) || pages <= 0) {
      fail(400, "invalid_measurement", "Page count must be a positive whole number.", {
        field: "measurement.pages",
      });
    }
    return BigInt(pages) * count * MILLI;
  }

  if (unit === "per_area") {
    const width = milliUnits(measurement?.width, "measurement.width");
    const height = milliUnits(measurement?.height, "measurement.height");
    let area = width * height;
    if (minimumMeasurement?.width != null && minimumMeasurement?.height != null) {
      const floor = milliUnits(minimumMeasurement.width, "minimumMeasurement.width")
        * milliUnits(minimumMeasurement.height, "minimumMeasurement.height");
      if (area < floor) area = floor;
    }
    // Area is unit-squared in millis; bring it back to one factor of MILLI so
    // every unit leaves this function on the same scale.
    return divideRounded(area * count, MILLI);
  }

  if (unit === "per_length") {
    let length = milliUnits(measurement?.length, "measurement.length");
    if (minimumMeasurement?.length != null) {
      const floor = milliUnits(minimumMeasurement.length, "minimumMeasurement.length");
      if (length < floor) length = floor;
    }
    return length * count;
  }

  return fail(400, "invalid_pricing_unit", "That listing has no supported pricing unit.", { field: "unit" });
}

/**
 * The rate this job is charged at, before options.
 *
 * Three things can name it, in this order: the speed the client's deadline
 * lands on, a volume break, then the listing's own base price. A speed tier
 * that states a price replaces the rate outright, which is how Lovis sells
 * hardbound — PHP 250 at five days and PHP 700 at two hours are not a base
 * price and a surcharge, they are two different prices for the same book.
 */
export function baseRateMinor({ basePriceMinor, volumeTiers = [], quantity = 1, speedTier = null }) {
  if (speedTier && speedTier.priceMinor != null) {
    return minor(speedTier.priceMinor, "speedTier.priceMinor");
  }
  const tier = applicableVolumeTier(volumeTiers, quantity);
  if (tier) return minor(tier.unitPriceMinor, "volumeTier.unitPriceMinor");
  return minor(basePriceMinor, "basePriceMinor");
}

/** The highest breakpoint this quantity reaches. Tiers need no particular order. */
export function applicableVolumeTier(volumeTiers, quantity) {
  if (!Array.isArray(volumeTiers) || volumeTiers.length === 0) return null;
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
  let winner = null;
  for (const tier of volumeTiers) {
    const from = tier?.minQuantity;
    if (!Number.isSafeInteger(from) || from <= 0 || from > quantity) continue;
    if (!winner || from > winner.minQuantity) winner = tier;
  }
  return winner;
}

/**
 * Options, applied in the only order that stays correct when a price changes.
 *
 * Additions land first and multipliers second, because "back-to-back doubles
 * it" means doubling the job the client actually configured — paper choice
 * included — not doubling the base and then adding the paper. A multiplier is
 * carried in basis points so a shop writing "x2" cannot introduce a float.
 */
export function applyOptions(rate, options = []) {
  let total = rate;
  for (const option of options) {
    if (option?.priceModifierMinor == null) continue;
    total += minor(option.priceModifierMinor, "option.priceModifierMinor");
  }
  for (const option of options) {
    const bps = option?.priceMultiplierBps;
    if (bps == null) continue;
    if (!Number.isSafeInteger(bps) || bps <= 0) {
      fail(400, "invalid_multiplier", "A multiplier add-on must be a positive whole basis-point rate.", {
        field: "option.priceMultiplierBps",
      });
    }
    total = divideRounded(total * BigInt(bps), BPS);
  }
  return total < 0n ? 0n : total;
}

/**
 * The whole price of one configured line.
 *
 * Returns the parts as well as the total, because every surface downstream has
 * to show its working: the client's sticky bar says "12 sq.ft x PHP 90", the
 * order line snapshots what was charged and why, and Operations has to be able
 * to answer a client asking where a number came from.
 */
export function priceLine({
  basePriceMinor,
  unit,
  packageQty = null,
  options = [],
  volumeTiers = [],
  minimumOrderQuantity = null,
  minimumMeasurement = null,
  speedTier = null,
  quantity = 1,
  measurement = null,
}) {
  if (!isPricingUnit(unit)) {
    fail(400, "invalid_pricing_unit", "That listing has no supported pricing unit.", { field: "unit" });
  }

  const orderedQuantity = asksQuantity(unit) ? quantity : 1;
  if (minimumOrderQuantity != null) {
    if (!Number.isSafeInteger(minimumOrderQuantity) || minimumOrderQuantity < 1) {
      fail(400, "invalid_minimum_quantity", "A listing minimum must be a positive whole number.", {
        field: "minimumOrderQuantity",
      });
    }
    if (orderedQuantity < minimumOrderQuantity) {
      fail(409, "below_minimum_quantity", "This shop does not run an order that small.", {
        field: "quantity",
        minimumOrderQuantity,
      });
    }
  }

  const rate = applyOptions(
    baseRateMinor({ basePriceMinor, volumeTiers, quantity: orderedQuantity, speedTier }),
    options,
  );
  const units = billableUnits({ unit, quantity: orderedQuantity, measurement, minimumMeasurement });
  let total = divideRounded(rate * units, MILLI);

  // A flat speed fee is charged once against the line, not against every piece
  // in it. Pins On adds PHP 100 to rush an order, whether it is 20 pins or 200.
  if (speedTier && speedTier.surchargeMinor != null) {
    total += minor(speedTier.surchargeMinor, "speedTier.surchargeMinor");
  }
  if (total < 0n) total = 0n;

  return {
    unit,
    packageQty: unit === "per_package" ? packageQty : null,
    quantity: orderedQuantity,
    /** Billable units in thousandths — 12.75 sq.ft is 12_750. */
    billableMilliUnits: toNumber(units, "billableMilliUnits"),
    unitRateMinor: toNumber(rate, "unitRateMinor"),
    volumeTierApplied: applicableVolumeTier(volumeTiers, orderedQuantity),
    speedTierApplied: speedTier ?? null,
    minimumMeasurementApplied: Boolean(
      minimumMeasurement && appliedMinimum({ unit, measurement, minimumMeasurement }),
    ),
    lineSubtotalMinor: toNumber(total, "lineSubtotalMinor"),
  };
}

/** Whether the shop's minimum billable size is what this line is actually charged on. */
function appliedMinimum({ unit, measurement, minimumMeasurement }) {
  try {
    if (unit === "per_area") {
      const asked = milliUnits(measurement?.width, "measurement.width")
        * milliUnits(measurement?.height, "measurement.height");
      const floor = milliUnits(minimumMeasurement?.width, "minimumMeasurement.width")
        * milliUnits(minimumMeasurement?.height, "minimumMeasurement.height");
      return asked < floor;
    }
    if (unit === "per_length") {
      return milliUnits(measurement?.length, "measurement.length")
        < milliUnits(minimumMeasurement?.length, "minimumMeasurement.length");
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * The lowest this listing can come to, for the "From PHP ..." line on a card.
 *
 * Only required single-select steps count: an add-on is not part of the floor,
 * and neither is a size the client has not chosen yet. A listing whose price
 * cannot move should say a price rather than "from" a price, so this returns
 * the base rate unchanged when nothing can push it up.
 */
export function fromPriceMinor({ basePriceMinor, groups = [], volumeTiers = [], speedTiers = [] }) {
  let total = minor(basePriceMinor, "basePriceMinor");

  const cheapestSpeed = speedTiers
    .filter((tier) => tier?.priceMinor != null)
    .reduce((lowest, tier) => {
      const value = minor(tier.priceMinor, "speedTier.priceMinor");
      return lowest == null || value < lowest ? value : lowest;
    }, null);
  if (cheapestSpeed != null) total = cheapestSpeed;

  const cheapestTier = volumeTiers.reduce((lowest, tier) => {
    if (tier?.unitPriceMinor == null) return lowest;
    const value = minor(tier.unitPriceMinor, "volumeTier.unitPriceMinor");
    return lowest == null || value < lowest ? value : lowest;
  }, null);
  if (cheapestTier != null && cheapestTier < total) total = cheapestTier;

  for (const group of groups) {
    if ((group?.kind || "spec") === "addon" || group?.required === false) continue;
    const options = group?.options || [];
    if (options.length === 0) return null;
    const lowest = options.reduce((least, option) => {
      const value = minor(option?.priceModifierMinor ?? 0, "option.priceModifierMinor");
      return least == null || value < least ? value : least;
    }, null);
    if (lowest != null) total += lowest;
  }

  if (total < 0n) total = 0n;
  return toNumber(total, "fromPriceMinor");
}
