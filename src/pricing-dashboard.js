/**
 * Super Admin pricing figures from GRIDGO's own rows.
 * Funnel events are only the ones the client posted. Nothing here rebuilds
 * a view, a checkout, or a payment out of an older order.
 *
 * Vouchers are not a product, and no reprint cost is stored. Those lines stay
 * unknown. A missing number is never written as zero.
 */

export const FUNNEL_KINDS = ["product_viewed", "listing_viewed", "checkout_reached", "paid", "checkout_left"];
const DAY_MS = 24 * 60 * 60 * 1000;
const OPS_ROLES = new Set(["ops_admin", "super_admin"]);
const COMPLETED = new Set(["completed", "payout_released"]);

export const PRICE_BRACKETS = [
  { id: "under_500", label: "Under ₱500", min: 0, max: 50_000 },
  { id: "500_to_2000", label: "₱500–₱1,999", min: 50_000, max: 200_000 },
  { id: "2000_to_5000", label: "₱2,000–₱4,999", min: 200_000, max: 500_000 },
  { id: "5000_up", label: "₱5,000 and over", min: 500_000, max: null },
];

export const EXIT_QUESTION_ABSENT = "This question is not asked yet.";
export const OPERATIONS_MINIMUM = "Average and median are a minimum. Only recorded actions are counted.";
export const FUNNEL_SCOPE = "Funnel counts use only events stored since this release. Older orders are not rewritten into views, checkouts, or payments.";

const unknown = () => ({ known: false });
const known = (minor) => ({ known: true, minor });

function optionalId(value, field) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 120) {
    const error = new Error(field);
    error.status = 400;
    error.code = "invalid_funnel_event";
    throw error;
  }
  return value;
}

export function buildFunnelEvent(body, user, at, eventId) {
  if (!user?.id || !FUNNEL_KINDS.includes(body?.kind)) {
    const error = new Error("kind");
    error.status = 400;
    error.code = "invalid_funnel_event";
    throw error;
  }
  let exitAnswer = null;
  if (body.kind === "checkout_left" && body.exitAnswer != null && body.exitAnswer !== "") {
    if (typeof body.exitAnswer !== "string" || !body.exitAnswer.trim() || body.exitAnswer.length > 500) {
      const error = new Error("exitAnswer");
      error.status = 400;
      error.code = "invalid_funnel_event";
      throw error;
    }
    exitAnswer = body.exitAnswer.trim();
  }
  return {
    id: eventId,
    at,
    clientId: user.id,
    kind: body.kind,
    orderId: optionalId(body.orderId, "orderId"),
    listingId: optionalId(body.listingId, "listingId"),
    productCode: optionalId(body.productCode, "productCode"),
    exitAnswer,
  };
}

export async function insertFunnelEvent(database, event) {
  if (!database?.query) return;
  await database.query(
    `INSERT INTO funnel_events (id, at, client_id, kind, order_id, listing_id, product_code, exit_answer)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [event.id, event.at, event.clientId, event.kind, event.orderId, event.listingId, event.productCode, event.exitAnswer],
  );
}

export async function readFunnelEvents(database, store) {
  if (!database?.query) return [...(store?.funnelEvents || [])];
  const result = await database.query(
    `SELECT id, at, client_id, kind, order_id, listing_id, product_code, exit_answer
     FROM funnel_events ORDER BY at, id`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    at: row.at instanceof Date ? row.at.toISOString() : row.at,
    clientId: row.client_id,
    kind: row.kind,
    orderId: row.order_id,
    listingId: row.listing_id,
    productCode: row.product_code,
    exitAnswer: row.exit_answer,
  }));
}

export function averageAndMedian(values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (!numbers.length) return { average: null, median: null, count: 0 };
  const sorted = [...numbers].sort((a, b) => a - b);
  const average = Math.round(sorted.reduce((total, value) => total + value, 0) / sorted.length);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return { average, median, count: sorted.length };
}

function paidClears(reach, paid) {
  if (paid.clientId !== reach.clientId) return false;
  if (reach.orderId && paid.orderId && paid.orderId !== reach.orderId) return false;
  const delta = Date.parse(paid.at) - Date.parse(reach.at);
  return delta >= 0 && delta <= DAY_MS;
}

/** Reached checkout and not paid within 24 hours. A payment can clear one checkout. */
export function funnelDropOff(checkouts, allEvents, nowMs) {
  const paid = allEvents.filter((event) => event.kind === "paid");
  const used = new Set();
  let dropOff = 0;
  let open = 0;
  let paidInTime = 0;
  for (const reach of [...checkouts].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const hit = paid.find((event) => !used.has(event) && paidClears(reach, event));
    if (hit) {
      used.add(hit);
      paidInTime += 1;
      continue;
    }
    if (nowMs - Date.parse(reach.at) >= DAY_MS) dropOff += 1;
    else open += 1;
  }
  return { dropOff, open, paidInTime, reached: checkouts.length };
}

export function subtractEarnings(parts) {
  const keys = ["paymentFeeMinor", "voucherMinor", "discountMinor", "reprintShareMinor", "refundShareMinor", "deliveryAbsorbedMinor"];
  const lines = {};
  let missing = !Number.isSafeInteger(parts.feeMinor);
  for (const key of keys) {
    if (Number.isSafeInteger(parts[key])) lines[key] = known(parts[key]);
    else {
      lines[key] = unknown();
      missing = true;
    }
  }
  const fee = Number.isSafeInteger(parts.feeMinor) ? known(parts.feeMinor) : unknown();
  if (missing) return { fee, ...lines, remains: unknown() };
  const taken = keys.reduce((total, key) => total + parts[key], 0);
  return { fee, ...lines, remains: known(parts.feeMinor - taken) };
}

/**
 * Orders per month that cover fixed costs from the fee left after the
 * payment-fee percentage. Both inputs are the settings Super Admin entered.
 */
export function breakEvenOrders(fixedCostsMinor, averageFeeMinor, paymentFeeBps) {
  if (!Number.isSafeInteger(fixedCostsMinor) || fixedCostsMinor < 0
    || !Number.isSafeInteger(averageFeeMinor) || averageFeeMinor < 0
    || !Number.isInteger(paymentFeeBps) || paymentFeeBps < 0 || paymentFeeBps > 10_000) {
    return { known: false, orders: null };
  }
  const net = averageFeeMinor - Math.round(averageFeeMinor * paymentFeeBps / 10_000);
  if (net <= 0) return { known: fixedCostsMinor === 0, orders: fixedCostsMinor === 0 ? 0 : null };
  return { known: true, orders: Math.ceil(fixedCostsMinor / net) };
}

export function bracketOf(minor) {
  if (!Number.isSafeInteger(minor) || minor < 0) return null;
  return PRICE_BRACKETS.find((band) => minor >= band.min && (band.max == null || minor < band.max))?.id ?? null;
}

export function categoryOf(order, lines, catalog) {
  const line = (lines || []).find((item) => item.orderId === order.id);
  const spec = line?.structuredSpecSnapshot || {};
  if (typeof spec.subcategoryCode === "string" && spec.subcategoryCode) return spec.subcategoryCode;
  if (typeof spec.categoryCode === "string" && spec.categoryCode) return spec.categoryCode;
  const item = (catalog || []).find((row) => row.id === line?.sourceCatalogItemId);
  if (typeof item?.subcategoryCode === "string" && item.subcategoryCode) return item.subcategoryCode;
  if (typeof order.subcategoryCode === "string" && order.subcategoryCode) return order.subcategoryCode;
  return "unspecified";
}

function accountTypeOf(order, users) {
  const user = (users || []).find((row) => row.id === order.clientId);
  if (user?.accountType === "business" || user?.accountType === "organization") return user.accountType;
  return "individual";
}

function cohortOf(order, orders) {
  const first = (orders || [])
    .filter((row) => row.clientId === order.clientId)
    .map((row) => row.createdAt)
    .filter(Boolean)
    .sort()[0];
  return order.createdAt && order.createdAt === first ? "new" : "repeat";
}

function bound(day, end) {
  if (!day) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return end ? `${day}T23:59:59.999Z` : `${day}T00:00:00.000Z`;
  return day;
}

function inRange(at, from, to) {
  if (!at) return !from && !to;
  if (from && at < from) return false;
  if (to && at > to) return false;
  return true;
}

function qaMillis(order) {
  const opened = order.fileCheck?.requestedAt
    || (order.timeline || []).find((event) => event.state === "needs_qa")?.at
    || null;
  const done = order.fileCheck?.reviewedAt || null;
  if (!opened || !done) return null;
  const ms = Date.parse(done) - Date.parse(opened);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function firstOpsMillis(order, audit) {
  if (!order.createdAt) return null;
  const times = (audit || [])
    .filter((entry) => entry.orderId === order.id && OPS_ROLES.has(entry.actorRole) && entry.at)
    .map((entry) => Date.parse(entry.at))
    .filter((value) => Number.isFinite(value));
  if (!times.length) return null;
  const ms = Math.min(...times) - Date.parse(order.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function shareOf(settlements, field) {
  if (!settlements.length) return known(0);
  if (settlements.some((row) => !Number.isSafeInteger(row[field]))) return unknown();
  return known(settlements.reduce((total, row) => total + row[field], 0));
}

function orderEarnings(order, refunds, paymentFeeBps) {
  const feeMinor = Number.isSafeInteger(order.grossServiceFeeMinor) ? order.grossServiceFeeMinor : order.serviceFeeMinor;
  const paymentFeeMinor = Number.isInteger(paymentFeeBps) && Number.isSafeInteger(order.totalMinor)
    ? Math.round(order.totalMinor * paymentFeeBps / 10_000)
    : null;
  const settlements = refunds.filter((row) => row.orderId === order.id);
  const refundShareMinor = !settlements.length ? 0
    : settlements.every((row) => Number.isSafeInteger(row.feeMinor) && Number.isSafeInteger(row.platformDeliveryMinor))
      ? settlements.reduce((total, row) => total + row.feeMinor + row.platformDeliveryMinor, 0)
      : null;
  let deliveryAbsorbedMinor = null;
  if (order.fulfillmentMode === "pickup") deliveryAbsorbedMinor = 0;
  else if (Number.isSafeInteger(order.deliveryFeeMinor) && Number.isSafeInteger(order.riderPayoutMinor)) {
    deliveryAbsorbedMinor = Math.max(0, order.riderPayoutMinor - order.deliveryFeeMinor);
  }
  const earnings = subtractEarnings({
    feeMinor: Number.isSafeInteger(feeMinor) ? feeMinor : null,
    paymentFeeMinor,
    voucherMinor: null,
    discountMinor: Number.isSafeInteger(order.organizationDiscountMinor) ? order.organizationDiscountMinor : null,
    reprintShareMinor: null,
    refundShareMinor,
    deliveryAbsorbedMinor,
  });
  const base = order.supplierSubtotalMinor;
  earnings.effectiveFeeBps = earnings.fee.known && Number.isSafeInteger(base) && base > 0
    ? Math.round(earnings.fee.minor * 10_000 / base)
    : null;
  earnings.orderId = order.id;
  return earnings;
}

function priceGroups(orders, lines, catalog) {
  const byCategory = new Map();
  const byBracket = new Map(PRICE_BRACKETS.map((band) => [band.id, []]));
  for (const order of orders) {
    if (!Number.isSafeInteger(order.supplierSubtotalMinor)) continue;
    const category = categoryOf(order, lines, catalog);
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(order.supplierSubtotalMinor);
    const bracket = bracketOf(order.supplierSubtotalMinor);
    if (bracket) byBracket.get(bracket).push(order.supplierSubtotalMinor);
  }
  const pack = (id, label, values) => ({ id, label, ...averageAndMedian(values) });
  return {
    byCategory: [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, values]) => pack(id, id, values)),
    byBracket: PRICE_BRACKETS.map((band) => pack(band.id, band.label, byBracket.get(band.id))),
  };
}

function completedAt(order) {
  const hit = (order.timeline || []).find((event) => COMPLETED.has(event.state));
  if (hit?.at) return hit.at;
  if (COMPLETED.has(order.state)) return order.updatedAt || order.createdAt || null;
  return null;
}

function sameMonth(at, now) {
  const when = new Date(at);
  const current = new Date(now);
  return when.getUTCFullYear() === current.getUTCFullYear() && when.getUTCMonth() === current.getUTCMonth();
}

function periodReport(orders, eventsInRange, allEvents, audit, refundRequests, refunds, lines, catalog, paymentFeeBps, nowMs) {
  const counts = Object.fromEntries(FUNNEL_KINDS.map((kind) => [kind, 0]));
  for (const event of eventsInRange) if (counts[event.kind] != null) counts[event.kind] += 1;
  const checkouts = eventsInRange.filter((event) => event.kind === "checkout_reached");
  const answers = eventsInRange.filter((event) => event.kind === "checkout_left" && event.exitAnswer);
  const tally = new Map();
  for (const event of answers) tally.set(event.exitAnswer, (tally.get(event.exitAnswer) || 0) + 1);
  const orderIds = new Set(orders.map((order) => order.id));
  const refundOrders = new Set([
    ...refundRequests.filter((row) => orderIds.has(row.orderId)).map((row) => row.orderId),
    ...refunds.filter((row) => orderIds.has(row.orderId)).map((row) => row.orderId),
  ]);
  const settlements = refunds.filter((row) => orderIds.has(row.orderId));
  return {
    funnel: {
      counts,
      ...funnelDropOff(checkouts, allEvents, nowMs),
      exitQuestion: answers.length
        ? { asked: true, message: null, answers: [...tally.entries()].map(([answer, count]) => ({ answer, count })) }
        : { asked: false, message: EXIT_QUESTION_ABSENT, answers: [] },
    },
    operations: {
      note: OPERATIONS_MINIMUM,
      qualityCheck: averageAndMedian(orders.map(qaMillis).filter((value) => value != null)),
      firstAction: averageAndMedian(orders.map((order) => firstOpsMillis(order, audit)).filter((value) => value != null)),
      manualInterventions: (audit || []).filter((entry) => orderIds.has(entry.orderId) && OPS_ROLES.has(entry.actorRole)).length,
    },
    reprints: {
      recorded: false,
      rate: null,
      cost: unknown(),
      borneBy: null,
      note: "No reprint record is stored.",
    },
    refunds: {
      orders: refundOrders.size,
      rate: orders.length ? refundOrders.size / orders.length : null,
      gridgo: shareOf(settlements.map((row) => ({
        gridgo: Number.isSafeInteger(row.feeMinor) && Number.isSafeInteger(row.platformDeliveryMinor)
          ? row.feeMinor + row.platformDeliveryMinor
          : null,
      })).map((row) => ({ gridgo: row.gridgo })), "gridgo"),
      shop: shareOf(settlements, "shopEntitlementMinor"),
      rider: shareOf(settlements, "riderEntitlementMinor"),
    },
    prices: priceGroups(orders, lines, catalog),
    earnings: orders.map((order) => orderEarnings(order, refunds, paymentFeeBps)),
  };
}

function eventMatches(event, filters, orders, users, selected) {
  if (filters.accountType && accountTypeOf({ clientId: event.clientId }, users) !== filters.accountType) return false;
  if (filters.cohort) {
    const first = orders.filter((row) => row.clientId === event.clientId).map((row) => row.createdAt).filter(Boolean).sort()[0];
    const cohort = !first || (event.at && event.at <= first) ? "new" : "repeat";
    if (cohort !== filters.cohort) return false;
  }
  if (filters.category || filters.bracket) {
    if (selected.some((row) => row.order.id === event.orderId)) return true;
    if (filters.category && !filters.bracket && event.productCode === filters.category) return true;
    return false;
  }
  return true;
}

function matches(order, index, filters) {
  if (filters.category && index.category !== filters.category) return false;
  if (filters.bracket && index.bracket !== filters.bracket) return false;
  if (filters.accountType && index.accountType !== filters.accountType) return false;
  if (filters.cohort && index.cohort !== filters.cohort) return false;
  return true;
}

export function pricingDashboard({
  orders = [], lines = [], catalog = [], users = [], audit = [], refundRequests = [], refunds = [],
  events = [], settings = {}, version = null, query = {}, now,
}) {
  const from = bound(query.from, false);
  const to = bound(query.to, true);
  const compareFrom = bound(query.compareFrom, false);
  const compareTo = bound(query.compareTo, true);
  const filters = {
    category: query.category || "",
    bracket: query.bracket || "",
    accountType: query.accountType || "",
    cohort: query.cohort || "",
  };
  const indexed = orders.map((order) => ({
    order,
    category: categoryOf(order, lines, catalog),
    bracket: bracketOf(order.supplierSubtotalMinor),
    accountType: accountTypeOf(order, users),
    cohort: cohortOf(order, orders),
  }));
  const selected = indexed.filter((row) => matches(row.order, row, filters));
  const visibleEvents = events.filter((event) => eventMatches(event, filters, orders, users, selected));
  const paymentFeeBps = Number.isInteger(settings.pricingPaymentFeeBps) ? settings.pricingPaymentFeeBps : null;
  const nowMs = Date.parse(now);
  const slice = (start, end) => periodReport(
    selected.filter((row) => inRange(row.order.createdAt, start, end)).map((row) => row.order),
    visibleEvents.filter((event) => inRange(event.at, start, end)),
    visibleEvents,
    audit,
    refundRequests,
    refunds,
    lines,
    catalog,
    paymentFeeBps,
    Number.isFinite(nowMs) ? nowMs : Date.now(),
  );
  const monthOrders = selected.filter((row) => {
    const at = completedAt(row.order);
    return at && sameMonth(at, now);
  }).map((row) => row.order);
  const fees = monthOrders.map((order) => Number.isSafeInteger(order.grossServiceFeeMinor) ? order.grossServiceFeeMinor : order.serviceFeeMinor)
    .filter((value) => Number.isSafeInteger(value));
  const averageFee = fees.length ? Math.round(fees.reduce((total, value) => total + value, 0) / fees.length) : null;
  return {
    scope: FUNNEL_SCOPE,
    brackets: PRICE_BRACKETS.map(({ id, label }) => ({ id, label })),
    filters: { from: query.from || "", to: query.to || "", ...filters },
    settings: {
      version,
      fixedCostsMinor: Number.isSafeInteger(settings.pricingFixedCostsMinor) ? settings.pricingFixedCostsMinor : null,
      paymentFeeBps,
    },
    period: slice(from, to),
    compare: query.compareFrom || query.compareTo ? slice(compareFrom, compareTo) : null,
    completedThisMonth: monthOrders.length,
    breakEven: breakEvenOrders(settings.pricingFixedCostsMinor, averageFee, settings.pricingPaymentFeeBps),
  };
}
