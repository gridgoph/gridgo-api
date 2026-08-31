import { gridgoOfficePoint } from "./gridgo-office.js";

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

export function createPayoutMilestones(money) {
  const payoutBase = finiteMinor(money?.supplierPlatformPayoutMinor, "supplierPlatformPayoutMinor");
  const supplierSubtotal = finiteMinor(money?.supplierSubtotalMinor, "supplierSubtotalMinor");
  // 7,500 is the cart-checkout shape: the client pays 75 percent up front, so
  // the shop can be released 75 percent when it starts and the rest on delivery
  // -- fully covered by money already collected. The database has permitted the
  // rate since the checkout plan landed; this was the only place still refusing
  // it, which left every checkout order with no payout milestones at all.
  const downpaymentRate = finiteBps(
    money?.supplierDownpaymentRateBps,
    "supplierDownpaymentRateBps",
    [0, 2_500, 5_000, 7_500, 10_000],
  );
  const initialPrincipal = Math.min(roundBps(supplierSubtotal, downpaymentRate), payoutBase);
  const completionPrincipal = payoutBase - initialPrincipal;
  const rows = [];
  if (downpaymentRate > 0) {
    rows.push(["initial", downpaymentRate / 100, initialPrincipal]);
  }
  if (completionPrincipal > 0 || rows.length === 0) {
    const sharePercent = supplierSubtotal === 0 ? 0 : (10_000 - downpaymentRate) / 100;
    rows.push(["completion", sharePercent, completionPrincipal]);
  }
  return rows.map(([code, sharePercent, amountMinor]) => ({
    code,
    sharePercent,
    amountMinor,
    status: "pending",
    pofFileIds: [],
    releasedAt: null,
    releasedBy: null,
  }));
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

function activePayoutHold(store, order) {
  return Boolean(
    order.payoutHold ||
      (store?.claims || []).some(
        (claim) => claim.orderId === order.id && ["open", "payout_held"].includes(claim.status),
      ),
  );
}

export function releaseMilestone(order, code, actor, at, store = null) {
  if (!actor || !["ops_admin", "super_admin", "system"].includes(actor.role)) {
    fail(403, "forbidden", "Only Operations or Super Admin can release a supplier payout milestone.");
  }
  const milestone = (order?.payoutMilestones || []).find((item) => item.code === code);
  if (!milestone) {
    fail(404, "milestone_not_found", "That payout milestone does not exist. Refresh the order and try again.");
  }
  if (milestone.status === "released") return milestone;
  if (order.fulfillmentMode === "pickup") {
    fail(
      409,
      "pickup_payout_not_available",
      "Pickup payout release remains unavailable until the pickup handover lifecycle records fulfilment.",
      { milestoneCode: code },
    );
  }
  const currentPolicy = code === "initial" || code === "completion";
  if (currentPolicy) {
    if (activePayoutHold(store, order)) {
      fail(
        409,
        "payout_held",
        "A claim is holding this payout. Resolve or release the claim before releasing the milestone.",
        { milestoneCode: code },
      );
    }
    const productionStates = new Set([
      "production",
      "supplier_self_qc",
      "ready_for_dispatch",
      "rider_assigned",
      "picked_up",
      "out_for_delivery",
      "delivered",
      "issue_window_open",
      "completed",
      "payout_released",
    ]);
    const completionStates = new Set(["delivered", "issue_window_open", "completed", "payout_released"]);
    if (code === "initial" && !productionStates.has(order.state)) {
      fail(409, "milestone_not_reached", "Start production before releasing the supplier downpayment.", {
        milestoneCode: code,
        state: order.state,
      });
    }
    if (code === "completion" && !completionStates.has(order.state)) {
      fail(409, "fulfilment_required", "Record fulfilment before releasing the remaining supplier principal.", {
        milestoneCode: code,
        state: order.state,
      });
    }
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
  if (!Array.isArray(milestone.pofFileIds) || milestone.pofFileIds.length === 0) {
    fail(
      409,
      "pof_required",
      "Attach a Proof of Fulfilment to this milestone before releasing the supplier payout.",
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
  const printingStates = new Set([
    "production",
    "supplier_self_qc",
    "ready_for_dispatch",
    "rider_assigned",
    "picked_up",
    "out_for_delivery",
    "delivered",
    "issue_window_open",
    "completed",
    "payout_released",
  ]);
  const packagingStates = new Set([
    "supplier_self_qc",
    "ready_for_dispatch",
    "rider_assigned",
    "picked_up",
    "out_for_delivery",
    "delivered",
    "issue_window_open",
    "completed",
    "payout_released",
  ]);
  if ((code === "printing" && !printingStates.has(order.state)) || (code === "packaging_qc" && !packagingStates.has(order.state))) {
    fail(
      409,
      "milestone_not_reached",
      "Move the order to this production milestone before releasing its supplier payout.",
      { milestoneCode: code, state: order.state },
    );
  }
  if (code === "delivered") {
    if (!["issue_window_open", "completed", "payout_released"].includes(order.state)) {
      fail(409, "delivery_required", "Record delivery before releasing the delivered milestone.");
    }
    if (order.payments?.final_online?.status !== "confirmed") {
      fail(409, "final_payment_not_confirmed", "Operations must confirm the final online payment before releasing delivery payout.");
    }
  }
  if (code === "retention" && order.state !== "completed" && order.state !== "payout_released") {
    fail(
      409,
      "issue_window_open",
      "Wait for the issue window to expire before releasing retained supplier earnings.",
    );
  }
  milestone.status = "released";
  milestone.releasedAt = at;
  milestone.releasedBy = actor.id || "system";
  return milestone;
}

export function releaseEligibleSupplierPayouts(order, actor, at, store = null) {
  if (order?.fulfillmentMode === "pickup" || activePayoutHold(store, order)) return [];
  const productionReached = new Set([
    "production",
    "supplier_self_qc",
    "ready_for_dispatch",
    "rider_assigned",
    "picked_up",
    "out_for_delivery",
    "delivered",
    "issue_window_open",
    "completed",
    "payout_released",
  ]).has(order?.state);
  const fulfilmentReached = new Set(["delivered", "issue_window_open", "completed", "payout_released"]).has(order?.state);
  const eligibleCodes = [
    ...(productionReached ? ["initial"] : []),
    ...(fulfilmentReached ? ["completion"] : []),
  ];
  return eligibleCodes
    .map((code) => (order.payoutMilestones || []).find((milestone) => milestone.code === code))
    .filter((milestone) => milestone && milestone.status !== "released")
    .map((milestone) => releaseMilestone(order, milestone.code, actor, at, store));
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

export function publicOrderFor(order, user, store = null) {
  if (!order) return null;
  const publicRecord = clone(order);
  if (store) fillOrderSpecFromLineItems(store, publicRecord);
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
    if (Array.isArray(publicRecord.payoutMilestones)) {
      publicRecord.payoutMilestones = publicRecord.payoutMilestones.map((milestone) => {
        const { amountMinor: _amountMinor, ...visible } = milestone;
        return visible;
      });
    }
  }
  if (assignedSupplier && reporting) publicRecord.supplierSettlement = reporting.supplierSettlement;
  if (ops && reporting) {
    publicRecord.supplierSettlement = reporting.supplierSettlement;
    publicRecord.platformRevenue = reporting.platformRevenue;
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

  if (!ops && !owningClient && publicRecord.payments) {
    for (const installment of Object.values(publicRecord.payments)) {
      if (!installment || typeof installment !== "object") continue;
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

export function expireIssueWindows(store, at) {
  const timestamp = new Date(at).getTime();
  let changed = false;
  for (const order of store.orders || []) {
    if (order.state !== "issue_window_open" || !order.issueWindowExpiresAt) continue;
    if (new Date(order.issueWindowExpiresAt).getTime() > timestamp) continue;
    if (activePayoutHold(store, order)) continue;
    order.state = "completed";
    order.updatedAt = at;
    if (!Array.isArray(order.timeline)) order.timeline = [];
    order.timeline.push({
      at,
      state: "completed",
      by: "system",
      note: "Issue window expired with no active claim",
    });
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
    changed = true;
  }
  return changed;
}
