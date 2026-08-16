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
    pickupNoShowHours: 72,
    issueWindowHours: 24,
    deliveryFeeBands: [
      { maxDistanceMeters: 4_999, feeMinor: 2_500 },
      { maxDistanceMeters: 10_000, feeMinor: 5_000 },
      { maxDistanceMeters: null, feeMinor: 7_500 },
    ],
  };
}

export function validateOperationalSettings(settings) {
  const serviceFeeRateBps = Number(settings?.serviceFeeRateBps);
  if (!Number.isInteger(serviceFeeRateBps) || serviceFeeRateBps < 0 || serviceFeeRateBps > 10_000) {
    fail(
      400,
      "invalid_service_fee_rate",
      "Set the client service-fee rate to a whole number from 0 to 10,000 basis points.",
      { field: "serviceFeeRateBps" },
    );
  }
  const pickupNoShowHours = Number(settings?.pickupNoShowHours);
  if (!Number.isInteger(pickupNoShowHours) || pickupNoShowHours < 24 || pickupNoShowHours > 168) {
    fail(
      400,
      "invalid_pickup_no_show_hours",
      "Set the pickup no-show window to a whole number from 24 to 168 hours.",
      { field: "pickupNoShowHours" },
    );
  }
  const issueWindowHours = Number(settings?.issueWindowHours);
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
    finiteMinor(band?.feeMinor, `deliveryFeeBands[${index}].feeMinor`);
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
    const maximum = Number(band?.maxDistanceMeters);
    if (!Number.isInteger(maximum) || maximum <= previous) {
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

export function createPayoutMilestones(supplierPlatformPayoutMinor, fulfillmentMode = "delivery") {
  const payoutBase = finiteMinor(supplierPlatformPayoutMinor, "supplierPlatformPayoutMinor");
  if (fulfillmentMode === "pickup") {
    const handover = roundBps(payoutBase, 9_000);
    return [
      ["pickup_handover", 90, handover],
      ["retention", 10, payoutBase - handover],
    ].map(([code, sharePercent, amountMinor]) => ({
      code,
      sharePercent,
      amountMinor,
      status: "pending_pof",
      pofFileIds: [],
      releasedAt: null,
      releasedBy: null,
    }));
  }
  const printing = roundBps(payoutBase, 5_000);
  const packaging = roundBps(payoutBase, 1_500);
  const delivered = roundBps(payoutBase, 2_500);
  const retention = payoutBase - printing - packaging - delivered;
  return [
    ["printing", 50, printing],
    ["packaging_qc", 15, packaging],
    ["delivered", 25, delivered],
    ["retention", 10, retention],
  ].map(([code, sharePercent, amountMinor]) => ({
    code,
    sharePercent,
    amountMinor,
    status: "pending_pof",
    pofFileIds: [],
    releasedAt: null,
    releasedBy: null,
  }));
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
  const refundedAdjustedMinor = (order.revenueAdjustments || [])
    .reduce((sum, adjustment) => sum + Number(adjustment.amountMinor || 0), 0);
  const handedOver = ["delivered", "pickup_confirmed", "issue_window_open", "completed", "payout_released"].includes(order.state);
  return {
    supplierSettlement: {
      orderPriceMinor: order.supplierSubtotalMinor,
      receivedAtStoreMinor: order.directStoreDueMinor || 0,
      protectedPaymentMinor: order.supplierPlatformPayoutMinor,
      gridgoDeductionsMinor: 0,
      totalSupplierEarningsMinor: order.supplierSubtotalMinor,
      supplierReleasedMinor: releasedThroughPlatformMinor,
      supplierOutstandingMinor: Math.max(
        0,
        (order.supplierSubtotalMinor || 0) - (order.directStoreDueMinor || 0) - releasedThroughPlatformMinor,
      ),
    },
    platformRevenue: {
      billedMinor: order.commercialCommittedAt ? order.serviceFeeMinor : 0,
      collectedMinor: serviceFeeCollectedMinor,
      recognizedMinor: handedOver ? Math.max(0, serviceFeeCollectedMinor + refundedAdjustedMinor) : 0,
      refundedAdjustedMinor,
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

export function publicOrderFor(order, user) {
  if (!order) return null;
  const publicRecord = clone(order);
  const reporting = order.commercialCommittedAt ? moneyReportingForOrder(order) : null;
  delete publicRecord.attachments;
  const ops = user && ["ops_admin", "super_admin"].includes(user.role);
  const assignedSupplier = user?.role === "supplier" && order.supplierId === user.id;
  const owningClient = user?.role === "client" && order.clientId === user.id;
  if (!ops) delete publicRecord.revenueAdjustments;
  if (!ops && !assignedSupplier) {
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
