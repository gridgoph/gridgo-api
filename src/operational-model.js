const COMMISSION_RATE_PERCENT = 10;
const DOWNPAYMENT_PERCENT = 75;

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

export function defaultOperationalSettings() {
  return {
    issueWindowHours: 24,
    deliveryFeeBands: [
      { maxDistanceMeters: 4_999, feeMinor: 2_500 },
      { maxDistanceMeters: 10_000, feeMinor: 5_000 },
      { maxDistanceMeters: null, feeMinor: 7_500 },
    ],
  };
}

export function validateOperationalSettings(settings) {
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

export function calculateFinalPrice({ supplierPriceMinor, pickup, dropoff, distanceMeters, settings }) {
  const supplierPrice = finiteMinor(supplierPriceMinor, "supplierPriceMinor");
  if (supplierPrice === 0) {
    fail(400, "invalid_supplier_price", "Enter a supplier price greater than zero in PHP minor units.");
  }
  const resolvedDistance = distanceMeters == null ? distanceMetersBetween(pickup, dropoff) : Math.round(Number(distanceMeters));
  const commissionMinor = Math.round((supplierPrice * COMMISSION_RATE_PERCENT) / 100);
  const subtotalMinor = supplierPrice + commissionMinor;
  const deliveryFeeMinor = deliveryFeeForDistance(resolvedDistance, settings);
  const totalMinor = subtotalMinor + deliveryFeeMinor;
  const downpaymentMinor = Math.round((totalMinor * DOWNPAYMENT_PERCENT) / 100);
  return {
    supplierPriceMinor: supplierPrice,
    commissionRatePercent: COMMISSION_RATE_PERCENT,
    commissionMinor,
    subtotalMinor,
    deliveryDistanceMeters: resolvedDistance,
    deliveryFeeMinor,
    totalMinor,
    downpaymentMinor,
    balanceMinor: totalMinor - downpaymentMinor,
  };
}

export function estimatePriceRange({ supplierPriceCandidatesMinor }) {
  const candidates = (supplierPriceCandidatesMinor || [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  if (!candidates.length) candidates.push(10_000);
  const supplierMin = Math.min(...candidates);
  const supplierMax = Math.max(...candidates);
  return {
    subtotalMinMinor: supplierMin + Math.round((supplierMin * COMMISSION_RATE_PERCENT) / 100),
    subtotalMaxMinor: supplierMax + Math.round((supplierMax * COMMISSION_RATE_PERCENT) / 100),
    deliveryFeeStatus: "pending_supplier_assignment",
  };
}

export function createPayoutMilestones(supplierPriceMinor) {
  const supplierPrice = finiteMinor(supplierPriceMinor, "supplierPriceMinor");
  const printing = Math.round(supplierPrice * 0.5);
  const packaging = Math.round(supplierPrice * 0.15);
  const delivered = Math.round(supplierPrice * 0.25);
  const retention = supplierPrice - printing - packaging - delivered;
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
    if (order.payments?.balance?.status !== "confirmed") {
      fail(409, "balance_not_confirmed", "Operations must confirm the digital balance before releasing delivery payout.");
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
  delete publicRecord.attachments;
  const ops = user && ["ops_admin", "super_admin"].includes(user.role);
  const assignedSupplier = user?.role === "supplier" && order.supplierId === user.id;
  const owningClient = user?.role === "client" && order.clientId === user.id;
  if (!ops) {
    delete publicRecord.commissionMinor;
    delete publicRecord.commissionRatePercent;
  }
  if (!ops && !assignedSupplier) {
    delete publicRecord.supplierPriceMinor;
    if (Array.isArray(publicRecord.payoutMilestones)) {
      publicRecord.payoutMilestones = publicRecord.payoutMilestones.map((milestone) => {
        const { amountMinor: _amountMinor, ...visible } = milestone;
        return visible;
      });
    }
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
