import { gridgoOfficePoint } from "./gridgo-office.js";
import { opsPayoutAccountProjection } from "./payout-account.js";

const BPS_DENOMINATOR = 10_000n;
const BPS_HALF = 5_000n;

export const PICKUP_CHECK_CODES = Object.freeze([
  "quantity_match",
  "specification_match",
  "visible_defects",
  "packaging_integrity",
  "documentation",
  "supplier_sign_off",
]);

export const PICKUP_SIGN_OFF_PROMPT = "GRIDGO partner! Quality check, done! Salamat po!";

/*
 The two shapes the word "pickup" has carried.

 The older one meant the job never travelled: the client walked to the shop
 counter that printed it. That route was never finished, and the payment plans
 written for it are the only place it survives.

 The one the platform runs on now means the client collects at GRIDGO Office,
 so the job still travels -- a rider carries it from the shop to that counter.
 It ends on our own shelf rather than in anybody's hands, which is why it needs
 an ending of its own.
*/
const CONTAINED_PICKUP_PLANS = Object.freeze(["pickup_full_online", "pickup_downpayment_store"]);

export function isContainedPickup(order) {
  return order?.fulfillmentMode === "pickup" && CONTAINED_PICKUP_PLANS.includes(order?.paymentPlan);
}

/** A collected order: it travels to the office, and waits there to be claimed. */
export function carriedToOffice(order) {
  return order?.fulfillmentMode === "pickup" && !isContainedPickup(order);
}

export class OperationalError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "OperationalError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details) {
  throw new OperationalError(status, code, message, details);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function finiteMinor(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail(400, "invalid_money", `${field} must be a non-negative integer in PHP minor units.`, { field });
  }
  return number;
}

function finiteBps(value, field, allowed = null) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 10_000 || (allowed && !allowed.includes(number))) {
    fail(400, "invalid_basis_points", `${field} must be a supported whole-number basis-point rate.`, { field });
  }
  return number;
}

export function roundBps(valueMinor, rateBps) {
  const value = finiteMinor(valueMinor, "valueMinor");
  const rate = finiteBps(rateBps, "rateBps");
  const rounded = (BigInt(value) * BigInt(rate) + BPS_HALF) / BPS_DENOMINATOR;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) {
    fail(400, "invalid_money", "The calculated money amount exceeds the safe API range.");
  }
  return result;
}

export function defaultOperationalSettings() {
  return {
    serviceFeeRateBps: 1_000,
    issueWindowHours: 24,
    deliveryFeeBands: [
      { maxDistanceMeters: 4_999, feeMinor: 2_500 },
      { maxDistanceMeters: 10_000, feeMinor: 5_000 },
      { maxDistanceMeters: null, feeMinor: 7_500 },
    ],
  };
}

export function validateOperationalSettings(settings) {
  const serviceFeeRateBps = settings?.serviceFeeRateBps;
  if (!Number.isInteger(serviceFeeRateBps) || serviceFeeRateBps < 0 || serviceFeeRateBps > 10_000) {
    fail(
      400,
      "invalid_service_fee_rate",
      "Set the client service-fee rate to a whole number from 0 to 10,000 basis points.",
      { field: "serviceFeeRateBps" },
    );
  }
  const issueWindowHours = settings?.issueWindowHours;
  if (!Number.isInteger(issueWindowHours) || issueWindowHours < 1 || issueWindowHours > 720) {
    fail(
      400,
      "invalid_issue_window",
      "Set the issue window to a whole number from 1 to 720 hours, then try again.",
      { field: "issueWindowHours" },
    );
  }
  const bands = settings?.deliveryFeeBands;
  if (!Array.isArray(bands) || bands.length < 1) {
    fail(
      400,
      "invalid_delivery_fee_bands",
      "Add at least one delivery fee band and finish with an open-ended band.",
    );
  }
  let previous = -1;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    if (!Number.isSafeInteger(band?.feeMinor) || band.feeMinor < 0) {
      fail(
        400,
        "invalid_money",
        `deliveryFeeBands[${index}].feeMinor must be a non-negative integer in PHP minor units.`,
        { field: `deliveryFeeBands[${index}].feeMinor` },
      );
    }
    const last = index === bands.length - 1;
    if (last) {
      if (band?.maxDistanceMeters !== null) {
        fail(
          400,
          "invalid_delivery_fee_bands",
          "Make the final delivery fee band open-ended by setting maxDistanceMeters to null.",
        );
      }
      continue;
    }
    const maximum = band?.maxDistanceMeters;
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum <= previous) {
      fail(
        400,
        "invalid_delivery_fee_bands",
        "Set each delivery distance maximum to a larger whole number of metres than the band before it.",
      );
    }
    previous = maximum;
  }
  return true;
}

function radians(degrees) {
  return (degrees * Math.PI) / 180;
}

export function distanceMetersBetween(pickup, dropoff) {
  for (const [field, point] of [["pickup", pickup], ["dropoff", dropoff]]) {
    if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) {
      fail(
        409,
        "location_required",
        `Add valid ${field} coordinates before GRIDGO calculates the delivery fee.`,
        { field },
      );
    }
  }
  const earthRadiusMeters = 6_371_000;
  const lat1 = radians(Number(pickup.lat));
  const lat2 = radians(Number(dropoff.lat));
  const deltaLat = lat2 - lat1;
  const deltaLng = radians(Number(dropoff.lng) - Number(pickup.lng));
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return Math.round(earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export function deliveryFeeForDistance(distanceMeters, settings) {
  validateOperationalSettings(settings);
  const distance = Number(distanceMeters);
  if (!Number.isFinite(distance) || distance < 0) {
    fail(400, "invalid_delivery_distance", "Delivery distance must be a non-negative number of metres.");
  }
  const band = settings.deliveryFeeBands.find(
    (candidate) => candidate.maxDistanceMeters === null || distance <= candidate.maxDistanceMeters,
  );
  return band.feeMinor;
}

export function calculateOrderMoney({
  supplierSubtotalMinor,
  fulfillmentMode,
  paymentPlan,
  supplierDownpaymentRateBps,
  pickup,
  dropoff,
  distanceMeters,
  settings,
}) {
  validateOperationalSettings(settings);
  const supplierSubtotal = finiteMinor(supplierSubtotalMinor, "supplierSubtotalMinor");
  const serviceFeeRateBps = finiteBps(settings.serviceFeeRateBps, "serviceFeeRateBps");
  const serviceFeeMinor = roundBps(supplierSubtotal, serviceFeeRateBps);
  const allowedPlans = new Set(["delivery_online", "pickup_full_online", "pickup_downpayment_store"]);
  if (!allowedPlans.has(paymentPlan)) {
    fail(400, "invalid_payment_plan", "Choose one of the payment plans offered for this quote.");
  }
  if (!new Set(["delivery", "pickup"]).has(fulfillmentMode)) {
    fail(400, "invalid_fulfillment_mode", "Choose delivery or pickup for this quote.");
  }

  let rate;
  let resolvedDistance = 0;
  let deliveryFeeMinor = 0;
  if (paymentPlan === "delivery_online") {
    if (fulfillmentMode !== "delivery") fail(400, "invalid_payment_plan", "Delivery requires the delivery online plan.");
    rate = finiteBps(supplierDownpaymentRateBps, "supplierDownpaymentRateBps", [0, 2_500, 5_000]);
    resolvedDistance = distanceMeters == null ? distanceMetersBetween(pickup, dropoff) : Math.round(Number(distanceMeters));
    deliveryFeeMinor = deliveryFeeForDistance(resolvedDistance, settings);
  } else if (paymentPlan === "pickup_full_online") {
    if (fulfillmentMode !== "pickup") fail(400, "invalid_payment_plan", "Pickup full-online requires pickup fulfillment.");
    rate = 10_000;
  } else {
    if (fulfillmentMode !== "pickup") fail(400, "invalid_payment_plan", "Pickup at-store payment requires pickup fulfillment.");
    rate = finiteBps(supplierDownpaymentRateBps, "supplierDownpaymentRateBps", [2_500, 5_000]);
  }

  const initialSupplierPrincipalMinor = roundBps(supplierSubtotal, rate);
  const supplierRemainderMinor = supplierSubtotal - initialSupplierPrincipalMinor;
  const initialOnlineMinor = initialSupplierPrincipalMinor + serviceFeeMinor;
  const finalOnlineMinor = paymentPlan === "delivery_online" ? supplierRemainderMinor + deliveryFeeMinor : 0;
  const directStoreDueMinor = paymentPlan === "pickup_downpayment_store" ? supplierRemainderMinor : 0;
  const totalMinor = supplierSubtotal + serviceFeeMinor + deliveryFeeMinor;
  const onlineDueMinor = initialOnlineMinor + finalOnlineMinor;
  const supplierPlatformPayoutMinor = supplierSubtotal - directStoreDueMinor;

  for (const [field, amount] of Object.entries({
    serviceFeeMinor,
    deliveryFeeMinor,
    totalMinor,
    initialOnlineMinor,
    finalOnlineMinor,
    directStoreDueMinor,
    onlineDueMinor,
    supplierPlatformPayoutMinor,
  })) finiteMinor(amount, field);

  return {
    supplierSubtotalMinor: supplierSubtotal,
    subtotalMinor: supplierSubtotal,
    serviceFeeRateBps,
    serviceFeeMinor,
    deliveryDistanceMeters: resolvedDistance,
    deliveryFeeMinor,
    totalMinor,
    fulfillmentMode,
    paymentPlan,
    supplierDownpaymentRateBps: rate,
    initialSupplierPrincipalMinor,
    supplierRemainderMinor,
    initialOnlineMinor,
    finalOnlineMinor,
    onlineDueMinor,
    directStoreDueMinor,
    supplierPlatformPayoutMinor,
    supplierEarningsMinor: supplierSubtotal,
  };
}

function componentLine(component, amountMinor) {
  const labels = {
    supplier_principal: "Supplier principal",
    service_fee: "GRIDGO service fee",
    delivery_pass_through: "Delivery pass-through",
  };
  return { component, label: labels[component], amountMinor };
}

export function createPaymentSchedule(money) {
  const initialLines = [
    componentLine("supplier_principal", money.initialSupplierPrincipalMinor),
    componentLine("service_fee", money.serviceFeeMinor),
  ];
  const payments = {
    initial: {
      amountMinor: money.initialOnlineMinor,
      method: "qr_manual",
      status: "not_submitted",
      label: "Initial online payment",
      supplierPrincipalRateBps: money.supplierDownpaymentRateBps,
      percent: money.supplierDownpaymentRateBps / 100,
      componentLines: clone(initialLines),
      reference: null,
      submittedAt: null,
      confirmedAt: null,
      confirmedBy: null,
      confirmationSource: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
    },
  };
  const paymentAllocations = initialLines.map(({ component, amountMinor }) => ({ paymentCode: "initial", component, amountMinor }));
  if (money.paymentPlan === "delivery_online") {
    const finalLines = [
      componentLine("supplier_principal", money.supplierRemainderMinor),
      componentLine("delivery_pass_through", money.deliveryFeeMinor),
    ];
    payments.final_online = {
      amountMinor: money.finalOnlineMinor,
      method: "qr_manual",
      status: "not_submitted",
      label: "Final online payment",
      supplierPrincipalRateBps: 10_000 - money.supplierDownpaymentRateBps,
      percent: (10_000 - money.supplierDownpaymentRateBps) / 100,
      componentLines: clone(finalLines),
      reference: null,
      submittedAt: null,
      confirmedAt: null,
      confirmedBy: null,
      confirmationSource: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
    };
    paymentAllocations.push(...finalLines.map(({ component, amountMinor }) => ({ paymentCode: "final_online", component, amountMinor })));
  }
  return { payments, paymentAllocations };
}

export function estimatePriceRange({ supplierSubtotalCandidatesMinor }) {
  const candidates = (supplierSubtotalCandidatesMinor || [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  if (!candidates.length) candidates.push(10_000);
  const supplierMin = Math.min(...candidates);
  const supplierMax = Math.max(...candidates);
  return {
    supplierSubtotalMinMinor: supplierMin,
    supplierSubtotalMaxMinor: supplierMax,
    serviceFeeStatus: "calculated_at_quote_acceptance",
    deliveryFeeStatus: "pending_supplier_assignment",
  };
}

/*
 The four stages a shop is paid across.

 Not one payment at the end: a shop that has printed the run and packed it has
 done most of the work, and waiting for a rider to finish before any of it
 arrives is what makes a small press fund GRIDGO's float. The shares are the
 captain's, against the shop's own price.

 The last stage takes the rounding remainder so the four always sum to exactly
 what the shop is owed. It is the smallest of them and the last to move, so a
 stray centavo there can never overpay an earlier release.
*/
export const PAYOUT_STAGES = Object.freeze([
  Object.freeze({ code: "printing", shareBps: 5_000 }),
  Object.freeze({ code: "packaging_qc", shareBps: 1_500 }),
  Object.freeze({ code: "delivered", shareBps: 2_500 }),
  Object.freeze({ code: "retention", shareBps: 1_000 }),
]);

export function createPayoutMilestones(money) {
  const payoutBase = finiteMinor(money?.supplierPlatformPayoutMinor, "supplierPlatformPayoutMinor");
  let allocated = 0;
  return PAYOUT_STAGES.map((stage, index) => {
    const last = index === PAYOUT_STAGES.length - 1;
    const amountMinor = last ? payoutBase - allocated : roundBps(payoutBase, stage.shareBps);
    allocated += amountMinor;
    return {
      code: stage.code,
      sharePercent: stage.shareBps / 100,
      amountMinor,
      status: "pending_pof",
      pofFileIds: [],
      releasedAt: null,
      releasedBy: null,
    };
  });
}

export function collectedSupplierPrincipalMinor(order) {
  const confirmedPayments = new Set(
    Object.entries(order?.payments || {})
      .filter(([, payment]) => payment?.status === "confirmed")
      .map(([code]) => code),
  );
  return (order?.paymentAllocations || [])
    .filter(
      (allocation) => allocation.component === "supplier_principal" && confirmedPayments.has(allocation.paymentCode),
    )
    .reduce((sum, allocation) => sum + finiteMinor(allocation.amountMinor, "allocation.amountMinor"), 0);
}

export function moneyReportingForOrder(order) {
  const releasedThroughPlatformMinor = (order.payoutMilestones || [])
    .filter((milestone) => milestone.status === "released")
    .reduce((sum, milestone) => sum + finiteMinor(milestone.amountMinor, "milestone.amountMinor"), 0);
  const initialConfirmed = order.payments?.initial?.status === "confirmed";
  const serviceFeeCollectedMinor = initialConfirmed
    ? (order.paymentAllocations || [])
      .filter((allocation) => allocation.paymentCode === "initial" && allocation.component === "service_fee")
      .reduce((sum, allocation) => sum + finiteMinor(allocation.amountMinor, "allocation.amountMinor"), 0)
    : 0;
  const adjustedMinor = (order.revenueAdjustments || [])
    .filter((adjustment) => adjustment.kind === "adjustment")
    .reduce((sum, adjustment) => sum + Number(adjustment.amountMinor || 0), 0);
  const refundedMinor = (order.revenueAdjustments || [])
    .filter((adjustment) => adjustment.kind === "refund")
    .reduce((sum, adjustment) => sum + Number(adjustment.amountMinor || 0), 0);
  const handedOver = ["delivered", "issue_window_open", "completed", "payout_released"].includes(order.state);
  const receivedAtStoreMinor = 0;
  const collectedPrincipalMinor = collectedSupplierPrincipalMinor(order);
  const protectedPaymentMinor = Math.max(
    0,
    Math.min(order.supplierPlatformPayoutMinor || 0, collectedPrincipalMinor) - releasedThroughPlatformMinor,
  );
  return {
    supplierSettlement: {
      orderPriceMinor: order.supplierSubtotalMinor,
      dueAtStoreMinor: order.directStoreDueMinor || 0,
      receivedAtStoreMinor,
      collectedSupplierPrincipalMinor: collectedPrincipalMinor,
      protectedPaymentMinor,
      gridgoDeductionsMinor: 0,
      totalSupplierEarningsMinor: order.supplierSubtotalMinor,
      supplierReleasedMinor: releasedThroughPlatformMinor,
      supplierOutstandingMinor: Math.max(
        0,
        (order.supplierSubtotalMinor || 0) - receivedAtStoreMinor - releasedThroughPlatformMinor,
      ),
    },
    platformRevenue: {
      billedMinor: order.commercialCommittedAt ? order.serviceFeeMinor : 0,
      collectedMinor: serviceFeeCollectedMinor,
      recognizedMinor: handedOver ? Math.max(0, serviceFeeCollectedMinor + adjustedMinor + refundedMinor) : 0,
      adjustedMinor,
      refundedMinor,
    },
  };
}

export function activePayoutHold(store, order) {
  return Boolean(
    order.payoutHold ||
      (store?.claims || []).some(
        (claim) => claim.orderId === order.id && ["open", "payout_held"].includes(claim.status),
      ),
  );
}

/*
 One policy for every stage, and a person behind every release.

 Nothing here fires on a state change. A shop is paid when somebody at GRIDGO
 has looked at what it produced, which is the only reading of "proof of
 fulfilment" that means anything -- a photograph nobody opens is a file, not a
 check.

 The order of the refusals is the order of the questions worth asking: is this
 job even ours to pay on, is a claim holding it, is there anything to look at,
 has the work this stage names actually happened, and has the client's money
 arrived to cover it.
*/
const STAGE_GATES = Object.freeze({
  printing: Object.freeze({
    states: Object.freeze([
      "production", "supplier_self_qc", "ready_for_dispatch", "rider_assigned",
      "picked_up", "out_for_delivery", "awaiting_collection", "delivered",
      "issue_window_open", "completed", "payout_released",
    ]),
    code: "milestone_not_reached",
    message: "The shop has not started this job yet. Printing is released once production is under way.",
  }),
  packaging_qc: Object.freeze({
    states: Object.freeze([
      "supplier_self_qc", "ready_for_dispatch", "rider_assigned", "picked_up",
      "out_for_delivery", "awaiting_collection", "delivered", "issue_window_open",
      "completed", "payout_released",
    ]),
    code: "milestone_not_reached",
    message: "The job is not packed and ready for a rider yet. Packaging is released once it is.",
  }),
  delivered: Object.freeze({
    states: Object.freeze(["delivered", "issue_window_open", "completed", "payout_released"]),
    code: "delivery_required",
    message: "The client does not have this job yet. Record delivery or the counter hand-over first.",
  }),
  retention: Object.freeze({
    states: Object.freeze(["completed", "payout_released"]),
    code: "issue_window_open",
    message: "The client can still report a problem with this order. Retention is released once that window closes.",
  }),
});

export function releaseMilestone(order, code, actor, at, store = null) {
  if (!actor || !["ops_admin", "super_admin", "system"].includes(actor.role)) {
    fail(403, "forbidden", "Only Operations or Super Admin can release a supplier payout milestone.");
  }
  const milestone = (order?.payoutMilestones || []).find((item) => item.code === code);
  if (!milestone) {
    fail(404, "milestone_not_found", "That payout milestone does not exist. Refresh the order and try again.");
  }
  if (milestone.status === "released") return milestone;

  // The older meaning of "pickup", where the job never left the shop and its
  // handover was never finished. A collected job travels to the office and is
  // released at the counter, so its fulfilment is recorded like any other.
  if (isContainedPickup(order)) {
    fail(
      409,
      "pickup_payout_not_available",
      "Pickup payout release remains unavailable until the pickup handover lifecycle records fulfilment.",
      { milestoneCode: code },
    );
  }
  if (activePayoutHold(store, order)) {
    fail(
      409,
      "payout_held",
      "A claim is holding this payout. Resolve or release the claim before releasing the milestone.",
      { milestoneCode: code },
    );
  }
  if (!Array.isArray(milestone.pofFileIds) || milestone.pofFileIds.length === 0) {
    fail(
      409,
      "pof_required",
      "Attach a Proof of Fulfilment to this milestone before releasing the supplier payout.",
      { milestoneCode: code },
    );
  }
  const gate = STAGE_GATES[code];
  if (!gate) {
    fail(409, "unknown_milestone", "That payout stage is not one this platform releases.", { milestoneCode: code });
  }
  if (!gate.states.includes(order.state)) {
    fail(409, gate.code, gate.message, { milestoneCode: code, state: order.state });
  }

  /*
   GRIDGO never pays out money it has not collected.

   The shop's price arrives in two instalments, so releasing every stage the
   moment the work is done would have GRIDGO funding the gap out of its own
   pocket. This is the one rule the older four-stage code never carried, and
   the reason it could quietly overpay.
  */
  const releasedPrincipalMinor = (order.payoutMilestones || [])
    .filter((item) => item.status === "released")
    .reduce((sum, item) => sum + finiteMinor(item.amountMinor, "milestone.amountMinor"), 0);
  const collectedPrincipalMinor = collectedSupplierPrincipalMinor(order);
  if (releasedPrincipalMinor + finiteMinor(milestone.amountMinor, "milestone.amountMinor") > collectedPrincipalMinor) {
    fail(
      409,
      "supplier_principal_not_collected",
      "Confirmed client payments do not yet cover this supplier payout.",
      { milestoneCode: code, collectedPrincipalMinor, releasedPrincipalMinor },
    );
  }

  milestone.status = "released";
  milestone.releasedAt = at;
  milestone.releasedBy = actor.id || "system";
  return milestone;
}

function catalogUnitFromLine(line) {
  if (line?.pricingUnitSnapshot === "per_package" && Number(line.packageQtySnapshot) === 100) {
    return "pack100";
  }
  if (line?.pricingUnitSnapshot === "per_unit") return "piece";
  return "";
}

function emptySpec(value) {
  return value == null || value === "";
}

/**
 * Checkout writes quantity, size, material, finish and artwork onto
 * `orderLineItems`, not the order row. The client specification card still
 * reads the older order-level fields. Fill those from the line snapshot when
 * they are missing so a placed job does not render "undefined items".
 */
function fillOrderSpecFromLineItems(store, order) {
  const lines = (store?.orderLineItems || [])
    .filter((line) => line.orderId === order.id)
    .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || String(left.id).localeCompare(String(right.id)));
  if (lines.length === 0) return;

  const first = lines[0];
  const spec = first.structuredSpecSnapshot && typeof first.structuredSpecSnapshot === "object"
    ? first.structuredSpecSnapshot
    : {};
  const artworkIds = lines.map((line) => line.artworkFileId).filter(Boolean);
  const mockupIds = lines.map((line) => line.mockupFileId).filter(Boolean);
  const lastArtworkId = artworkIds[artworkIds.length - 1] || null;
  const artworkFile = lastArtworkId
    ? (store.files || []).find((file) => file.fileId === lastArtworkId)
    : null;

  if (emptySpec(order.title)) order.title = first.itemNameSnapshot || order.title;
  if (!Number.isFinite(Number(order.quantity))) {
    order.quantity = lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0);
  }
  if (emptySpec(order.unit)) order.unit = catalogUnitFromLine(first);
  if (emptySpec(order.size)) order.size = spec.size || "";
  if (emptySpec(order.material)) order.material = spec.material || "";
  if (order.finish == null || order.finish === "") order.finish = spec.finish || null;
  if (emptySpec(order.address)) {
    order.address = order.dropoff?.label || first.dropoff?.label || "";
  }
  if (!Array.isArray(order.artworkFileIds) || order.artworkFileIds.length === 0) {
    if (artworkIds.length) order.artworkFileIds = artworkIds;
  }
  if (!Array.isArray(order.mockupFileIds) || order.mockupFileIds.length === 0) {
    if (mockupIds.length) order.mockupFileIds = mockupIds;
  }
  if (emptySpec(order.artworkName) && artworkFile?.originalFilename) {
    order.artworkName = artworkFile.originalFilename;
  }
}

function productionItemsFor(store, order, user) {
  const jobs = (store?.orderJobs || []).filter((job) => job.orderId === order.id);
  const allLines = ["ops_admin", "super_admin"].includes(user?.role)
    || (user?.role === "client" && order.clientId === user.id)
    || (jobs.length === 0 && ((user?.role === "supplier" && order.supplierId === user.id)
      || (user?.role === "rider" && order.riderId === user.id)));
  const jobIds = new Set(jobs.filter((job) => (
    (user?.role === "supplier" && job.supplierId === user.id)
    || (user?.role === "rider" && job.riderId === user.id)
  )).map((job) => job.id));
  return (store?.orderLineItems || [])
    .filter((line) => line.orderId === order.id && (allLines || jobIds.has(line.jobId)))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.id).localeCompare(String(b.id)))
    .map((line) => {
      const spec = line.structuredSpecSnapshot || {};
      const measurement = line.measurement ? {
        ...(line.measurement.pages == null ? {} : { pages: line.measurement.pages }),
        ...(line.measurement.width == null ? {} : { widthMilli: line.measurement.width }),
        ...(line.measurement.height == null ? {} : { heightMilli: line.measurement.height }),
        ...(line.measurement.length == null ? {} : { lengthMilli: line.measurement.length }),
        // Old snapshots did not keep the unit. Never substitute today's listing unit.
        unit: ["mm", "cm", "m", "in", "ft"].includes(spec.measureUnit) ? spec.measureUnit : null,
      } : null;
      return {
        id: line.id, itemName: line.itemNameSnapshot || "", quantity: line.quantity,
        pricingUnit: line.pricingUnitSnapshot || null, packageQty: line.packageQtySnapshot ?? null,
        measurement,
        structuredSpec: Object.fromEntries(["size", "material", "finish"].filter((key) =>
          ["string", "number", "boolean"].includes(typeof spec[key])).map((key) => [key, spec[key]])),
        options: (store.orderLineItemOptions || []).filter((option) => option.orderLineItemId === line.id)
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
          .map((option) => ({ groupName: option.groupNameSnapshot, label: option.optionLabelSnapshot })),
        artworkFileId: line.artworkFileId || null, mockupFileId: line.mockupFileId || null,
      };
    });
}

export function publicOrderFor(order, user, store = null) {
  if (!order) return null;
  const publicRecord = clone(order);
  if (store) fillOrderSpecFromLineItems(store, publicRecord);
  publicRecord.productionItems = productionItemsFor(store, order, user);
  /*
    Whether this order has been rated, so a client is asked once.

    Without it the app cannot tell a finished order from a rated one, so it
    either asks forever or finds out by being refused — and "you have already
    rated this" is a poor way to learn that the screen was wrong to ask.

    A flag rather than the review itself: what somebody said about a shop is
    not something to hand back through an order that any of several roles can
    read.
  */
  publicRecord.rated = Boolean(
    store && (store.shopReviews || []).some((review) => review.orderId === order.id),
  );
  // Every client order screen reads this as an array. Seeded queue jobs and
  // older rows never stored one; omitting it crashes the order page.
  if (!Array.isArray(publicRecord.timeline)) publicRecord.timeline = [];
  const reporting = order.commercialCommittedAt ? moneyReportingForOrder(order) : null;
  delete publicRecord.attachments;
  const ops = user && ["ops_admin", "super_admin"].includes(user.role);
  const assignedSupplier = user?.role === "supplier" && order.supplierId === user.id;
  const owningClient = user?.role === "client" && order.clientId === user.id;
  const rider = user?.role === "rider";
  if (!ops) delete publicRecord.revenueAdjustments;

  /*
   What the shop is paid, under the name its own app asks for.

   The order stores this as `supplierSubtotalMinor`, which is the right name
   inside a total made of several parts. To a shop it is simply its price, and
   both the supplier app and the portal have been reading `supplierPriceMinor`
   — a field the platform never sent, so a shop opening a job it had been
   assigned was shown no price at all and asked to name one.

   Same number, named for who is reading it. Withheld from everyone who may not
   see the shop's side, exactly as the field it comes from is.
  */
  if (publicRecord.supplierSubtotalMinor != null) {
    publicRecord.supplierPriceMinor = publicRecord.supplierSubtotalMinor;
  }

  /*
   The padded date is not the shop's to see.

   `promiseBy` is what the client was told; `readyBy` is what the shop is held
   to, and the gap between them is the allowance that absorbs a bad afternoon.
   A shop shown the padded date works to the padded date, and the allowance is
   spent before the job even starts.
  */
  if (!ops && !owningClient && !rider) delete publicRecord.promiseBy;
  // And the shop's own date is not the client's to see. Told it, a client
  // expects the job two days before the date they agreed to, and every
  // on-time order arrives late.
  if (!ops && !assignedSupplier && !rider) delete publicRecord.readyBy;

  if (!ops && !assignedSupplier) {
    delete publicRecord.supplierPriceMinor;
    delete publicRecord.supplierSubtotalMinor;
    delete publicRecord.supplierPlatformPayoutMinor;
    delete publicRecord.supplierEarningsMinor;
    delete publicRecord.paymentAllocations;
    // A client never sees the shop's money, nor the wallet receipt that paid it.
    delete publicRecord.payoutReceiptFileIds;
    if (Array.isArray(publicRecord.payoutMilestones)) {
      publicRecord.payoutMilestones = publicRecord.payoutMilestones.map((milestone) => {
        const { amountMinor: _amountMinor, receiptFileId: _receipt, reference: _reference, ...visible } = milestone;
        return visible;
      });
    }
  }
  if (assignedSupplier && reporting) publicRecord.supplierSettlement = reporting.supplierSettlement;
  if (ops && reporting) {
    publicRecord.supplierSettlement = reporting.supplierSettlement;
    publicRecord.platformRevenue = reporting.platformRevenue;
  }
  // The release desk pays a shop by scanning its own receiving QR, so the
  // account rides with every order Operations reads. Never for anyone else.
  if (ops && store && order.supplierId) {
    publicRecord.supplierPayoutAccount = opsPayoutAccountProjection(store, order.supplierId);
  }
  if (rider) {
    delete publicRecord.payoutMilestones;
    delete publicRecord.quoteHistory;
    delete publicRecord.supplierDownpaymentRateBps;
    delete publicRecord.initialSupplierPrincipalMinor;
    delete publicRecord.supplierRemainderMinor;
    const paymentCollections = [publicRecord.payments, publicRecord.acceptedQuote?.payments];
    for (const payments of paymentCollections) {
      if (!payments) continue;
      for (const installment of Object.values(payments)) {
        if (!installment || typeof installment !== "object") continue;
        delete installment.componentLines;
        delete installment.supplierPrincipalRateBps;
      }
    }
    if (publicRecord.acceptedQuote) {
      delete publicRecord.acceptedQuote.paymentTerms;
      delete publicRecord.acceptedQuote.supplierDownpaymentRateBps;
    }
  }
  /*
    What "pickup" is, to the person reading it.

    The stored point is the assigned shop, because that is where a rider
    actually collects. A client is not going there: GRIDGO is the counter they
    bought from, a rider brings the finished job to GRIDGO's office, and they
    collect it there. So a collected order reads back with the office as its
    pickup, and a delivered one carries no origin at all for the client —
    they watch the rider and their own address, and the shop's coordinates are
    not theirs to have. Ops, the assigned supplier and riders are untouched.
  */
  if (owningClient && !ops) {
    if (order.fulfillmentMode === "pickup") publicRecord.pickup = gridgoOfficePoint();
    else delete publicRecord.pickup;
  }

  /*
   Nobody is delivering to a client who is collecting.

   A rider does carry a collected job, but only between two places that are
   GRIDGO's own -- the shop and the office counter. Handing the client a rider
   to watch invites them to set out while the job is still on the road, and
   dresses an errand of ours up as their delivery. What they are owed is the
   moment it is on the shelf, which the state already says.
  */
  if (owningClient && !ops && carriedToOffice(order)) delete publicRecord.riderId;

  /*
   Where a collected order is carried to.

   The client collects at GRIDGO Office, and a rider brings the finished run
   from the shop to that counter — so the job has a destination even though
   nobody is delivering to a home. It is not stored: a pickup job is required
   to have no drop-off, which is the older meaning of the word, where
   collecting meant the job never travelled.

   Supplied here instead, to the people who move it. Without it dispatch had
   no destination to draw and a rider's offer read as going nowhere.

   It replaces rather than fills. A collected order can still be carrying the
   address the client shopped with, and that address is not where this job is
   going — a rider sent to it would deliver work the client is on their way to
   the office to collect.
  */
  if (order.fulfillmentMode === "pickup") {
    if (ops || assignedSupplier || rider) publicRecord.dropoff = gridgoOfficePoint();
    else delete publicRecord.dropoff;
  }

  if (!ops && !owningClient) {
    for (const installment of [publicRecord.payments, publicRecord.acceptedQuote?.payments].flatMap((payments) => Object.values(payments || {}))) {
      if (!installment || typeof installment !== "object") continue;
      delete installment.proofFileId;
      delete installment.reference;
      delete installment.submittedBy;
      delete installment.confirmedBy;
      delete installment.rejectedBy;
      delete installment.rejectionReason;
    }
  }
  return publicRecord;
}

export function issueWindowExpiresAt(openedAt, issueWindowHours) {
  const opened = new Date(openedAt).getTime();
  return new Date(opened + issueWindowHours * 60 * 60 * 1000).toISOString();
}

/*
 Closing the issue window is one transition with two triggers: the clock, and
 the client saying the order arrived fine. Both end the same way -- the order
 completes and the retention share the rider's evidence already covers is
 released -- so both go through here, and only the timeline note says which.
*/
function closeIssueWindow(store, order, at, { by, note }) {
  order.state = "completed";
  order.updatedAt = at;
  if (!Array.isArray(order.timeline)) order.timeline = [];
  order.timeline.push({ at, state: "completed", by, note });
  const retention = (order.payoutMilestones || []).find((item) => item.code === "retention");
  if (retention?.pofFileIds?.length) {
    releaseMilestone(order, "retention", { id: "system", role: "system" }, at, store);
    order.timeline.push({
      at,
      state: "completed",
      by: "system",
      note: "Client retention milestone released",
    });
  }
}

export function expireIssueWindows(store, at, {limit = 100} = {}) {
  let processed = 0;
  const timestamp = new Date(at).getTime();
  let changed = false;
  for (const order of store.orders || []) {
    if (order.state !== "issue_window_open" || !order.issueWindowExpiresAt) continue;
    if (new Date(order.issueWindowExpiresAt).getTime() > timestamp) continue;
    if (activePayoutHold(store, order)) continue;
    if (processed >= limit) break;
    processed += 1;
    closeIssueWindow(store, order, at, {
      by: "system",
      note: "Issue window expired with no active claim",
    });
    changed = true;
  }
  return changed;
}

/*
 The client confirming the order arrived with no problems.

 It is the issue window's other ending. Rather than sit out the clock, the
 owning client says the job is fine, the window closes now, and the shop's
 retention is released today instead of tomorrow. The refusals are the two
 things the clock would also have waited on: the window has to be open, and
 nothing can be holding the payout -- a client with an open report cannot
 also call the job clean.
*/
export function confirmIssueWindow(store, order, actor, at) {
  if (order.state !== "issue_window_open") {
    fail(409, "issue_window_not_open", "This order is not in its issue window, so there is nothing to confirm.", {
      state: order.state,
    });
  }
  const openIssue = (store?.issues || []).find(
    (issue) => issue.orderId === order.id && !["resolved", "dismissed"].includes(issue.status),
  );
  if (openIssue || activePayoutHold(store, order)) {
    fail(409, "issue_open", "A problem is already reported on this order. Operations closes it once that is settled.", {
      issueId: openIssue?.id || null,
    });
  }
  closeIssueWindow(store, order, at, {
    by: actor.id,
    note: "Client confirmed the order arrived with no problems",
  });
  return order;
}
