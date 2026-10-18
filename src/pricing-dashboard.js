import { isReviewData } from './review-data.js';
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
export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 366;
export const EXIT_ANSWERS_SHOWN = 50;
export const FUNNEL_BODY_MAX_BYTES = 2048;
export const FUNNEL_DEDUPE_MS = 60_000;
export const FUNNEL_DAILY_LIMIT = 2000;
export const FUNNEL_BURST = { limit: 120, windowMs: 10 * 60 * 1000 };
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
    reviewData: isReviewData(user),
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

function funnelFail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

/** One event per request, small enough that a client cannot ship a payload in it. */
export function assertFunnelBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    funnelFail(400, "invalid_funnel_event", "Send one funnel event per request.");
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > FUNNEL_BODY_MAX_BYTES) {
    funnelFail(413, "funnel_event_too_large", `A funnel event is at most ${FUNNEL_BODY_MAX_BYTES} bytes.`);
  }
}

/**
 * The stored twin of this event from the same client inside the dedupe window,
 * or null. The daily cap counts what this client stored in the last 24 hours.
 */
export async function recentFunnelState(database, event) {
  const since = new Date(Date.parse(event.at) - FUNNEL_DEDUPE_MS).toISOString();
  const day = new Date(Date.parse(event.at) - DAY_MS).toISOString();
  const result = await database.query(
    `SELECT
       (SELECT count(*)::int FROM funnel_events WHERE client_id = $1 AND at > $2::timestamptz) AS today,
       (SELECT jsonb_build_object('id', id, 'at', at) FROM funnel_events
         WHERE client_id = $1 AND at > $3::timestamptz AND kind = $4
           AND order_id IS NOT DISTINCT FROM $5 AND listing_id IS NOT DISTINCT FROM $6
           AND product_code IS NOT DISTINCT FROM $7 AND exit_answer IS NOT DISTINCT FROM $8
         ORDER BY at DESC, id DESC LIMIT 1) AS duplicate`,
    [event.clientId, day, since, event.kind, event.orderId, event.listingId, event.productCode, event.exitAnswer],
  );
  const row = result.rows[0] || {};
  const duplicate = row.duplicate ? { id: row.duplicate.id, at: new Date(row.duplicate.at).toISOString() } : null;
  return { today: row.today || 0, duplicate };
}

const iso = (value) => (value instanceof Date ? value.toISOString() : value);

function rangeFail(code, message) {
  funnelFail(400, code, message);
}

function rangeBound(value, end, field) {
  if (value == null || value === "") return null;
  const text = String(value);
  const bound = /^\d{4}-\d{2}-\d{2}$/.test(text) ? (end ? `${text}T23:59:59.999Z` : `${text}T00:00:00.000Z`) : text;
  const ms = Date.parse(bound);
  if (!Number.isFinite(ms)) rangeFail("invalid_pricing_range", `Use a date such as 2026-10-01 for ${field}.`);
  return new Date(ms).toISOString();
}

function dayStartBefore(iso, days) {
  const start = new Date(Date.parse(iso) - (days - 1) * DAY_MS);
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString();
}

function checkedRange(from, to) {
  if (Date.parse(from) > Date.parse(to)) rangeFail("invalid_pricing_range", "The start date is after the end date.");
  if (Date.parse(to) - Date.parse(from) > MAX_RANGE_DAYS * DAY_MS) {
    rangeFail("pricing_range_too_long", `Choose a range of ${MAX_RANGE_DAYS} days or fewer.`);
  }
  return { from, to };
}

/**
 * Every figure is read over a bounded range. With no dates the dashboard shows
 * the last 30 days; a comparison needs both of its dates.
 */
export function pricingRanges(query = {}, now) {
  const nowIso = new Date(Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now()).toISOString();
  let from = rangeBound(query.from, false, "from");
  let to = rangeBound(query.to, true, "to");
  if (!to) to = from && Date.parse(from) > Date.parse(nowIso) ? rangeBound(query.from, true, "from") : nowIso;
  if (!from) from = dayStartBefore(to, DEFAULT_RANGE_DAYS);
  const period = checkedRange(from, to);
  const compareFrom = rangeBound(query.compareFrom, false, "compareFrom");
  const compareTo = rangeBound(query.compareTo, true, "compareTo");
  if (Boolean(compareFrom) !== Boolean(compareTo)) {
    rangeFail("invalid_pricing_range", "Choose both a start and an end date to compare.");
  }
  return { period, compare: compareFrom ? checkedRange(compareFrom, compareTo) : null };
}

/**
 * Which funnel events the dashboard filters keep. The same rules run in SQL
 * (funnelScopeSql) and in memory (funnelScopeMatches).
 */
export function funnelScope({ filters, orders = [], users = [], selectedOrderIds = [] }) {
  const firstOrderAt = new Map();
  for (const order of orders) {
    if (!order.clientId || !order.createdAt) continue;
    const prior = firstOrderAt.get(order.clientId);
    if (!prior || order.createdAt < prior) firstOrderAt.set(order.clientId, order.createdAt);
  }
  const typed = (type) => users.filter((user) => user.accountType === type).map((user) => user.id);
  const accountType = filters.accountType || "";
  return {
    accountType,
    accountIds: accountType === "business" || accountType === "organization" ? typed(accountType) : null,
    nonIndividualIds: accountType === "individual" ? [...typed("business"), ...typed("organization")] : null,
    cohort: filters.cohort || "",
    firstOrderAt: filters.cohort ? firstOrderAt : null,
    orderIds: filters.category || filters.bracket ? [...selectedOrderIds] : null,
    productCode: filters.category && !filters.bracket ? filters.category : null,
  };
}

export function funnelScopeMatches(event, scope) {
  if (scope.excludeReviewData && (isReviewData(event) || scope.reviewOrderIds?.includes(event.orderId))) return false;
  if (scope.accountType) {
    if (scope.accountIds) { if (!scope.accountIds.includes(event.clientId)) return false; }
    else if (scope.nonIndividualIds) { if (scope.nonIndividualIds.includes(event.clientId)) return false; }
    else return false;
  }
  if (scope.cohort) {
    const first = scope.firstOrderAt.get(event.clientId);
    const cohort = !first || Date.parse(event.at) <= Date.parse(first) ? "new" : "repeat";
    if (cohort !== scope.cohort) return false;
  }
  if (scope.orderIds) {
    if (scope.orderIds.includes(event.orderId)) return true;
    return Boolean(scope.productCode) && event.productCode === scope.productCode;
  }
  return true;
}

function funnelScopeSql(scope, params) {
  const add = (value) => { params.push(value); return `$${params.length}`; };
  const where = [];
  let join = "";
  if (scope.excludeReviewData) where.push(`NOT e.review_data AND NOT EXISTS (SELECT 1 FROM orders ro WHERE ro.id = e.order_id AND ro.review_data)`);
  if (scope.accountType) {
    if (scope.accountIds) where.push(`e.client_id = ANY(${add(scope.accountIds)}::text[])`);
    else if (scope.nonIndividualIds) where.push(`NOT (e.client_id = ANY(${add(scope.nonIndividualIds)}::text[]))`);
    else where.push("false");
  }
  if (scope.cohort) {
    const entries = [...scope.firstOrderAt.entries()];
    join = `LEFT JOIN unnest(${add(entries.map(([id]) => id))}::text[], ${add(entries.map(([, at]) => at))}::timestamptz[])
      AS f(client_id, first_at) ON f.client_id = e.client_id`;
    where.push(`(CASE WHEN f.first_at IS NULL OR e.at <= f.first_at THEN 'new' ELSE 'repeat' END) = ${add(scope.cohort)}`);
  }
  if (scope.orderIds) {
    where.push(`(e.order_id = ANY(${add(scope.orderIds)}::text[])${scope.productCode ? ` OR e.product_code = ${add(scope.productCode)}` : ""})`);
  }
  return { join, where: where.length ? ` AND ${where.join(" AND ")}` : "" };
}

function funnelSummary({ counts, answers, checkouts, paid }, nowMs) {
  const all = Object.fromEntries(FUNNEL_KINDS.map((kind) => [kind, 0]));
  for (const [kind, count] of Object.entries(counts)) if (all[kind] != null) all[kind] = count;
  return {
    counts: all,
    ...funnelDropOff(checkouts, paid, nowMs),
    exitQuestion: answers.length
      ? { asked: true, message: null, answers }
      : { asked: false, message: EXIT_QUESTION_ABSENT, answers: [] },
  };
}

const answerOrder = (a, b) => b.count - a.count || a.answer.localeCompare(b.answer);
const inWindow = (at, from, to) => Date.parse(at) >= Date.parse(from) && Date.parse(at) <= Date.parse(to);
const paidUntil = (to) => new Date(Date.parse(to) + DAY_MS).toISOString();

/** In-memory twin of readFunnelSummary, for stores without PostgreSQL. */
export function funnelFromEvents(events, range, scope, nowMs) {
  const visible = events.filter((event) => funnelScopeMatches(event, scope));
  const inRange = visible.filter((event) => inWindow(event.at, range.from, range.to));
  const counts = {};
  const tally = new Map();
  for (const event of inRange) {
    counts[event.kind] = (counts[event.kind] || 0) + 1;
    if (event.kind === "checkout_left" && event.exitAnswer) tally.set(event.exitAnswer, (tally.get(event.exitAnswer) || 0) + 1);
  }
  const byTime = (a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id));
  return funnelSummary({
    counts,
    answers: [...tally.entries()].map(([answer, count]) => ({ answer, count })).sort(answerOrder).slice(0, EXIT_ANSWERS_SHOWN),
    checkouts: inRange.filter((event) => event.kind === "checkout_reached").sort(byTime),
    paid: visible.filter((event) => event.kind === "paid" && inWindow(event.at, range.from, paidUntil(range.to))).sort(byTime),
  }, nowMs);
}

/**
 * Funnel figures for one range from indexed aggregates. Only the checkout and
 * payment rows the 24-hour pairing needs are read, never the whole table.
 */
export async function readFunnelSummary(database, range, scope, nowMs) {
  const run = async (select, extra, tail = "") => {
    const params = [range.from, range.to];
    const { join, where } = funnelScopeSql(scope, params);
    const sql = `SELECT ${select} FROM funnel_events e ${join} WHERE ${extra(params)}${where} ${tail}`;
    return (await database.query(sql, params)).rows;
  };
  const between = () => "e.at >= $1::timestamptz AND e.at <= $2::timestamptz";
  // One pooled client may serve a read snapshot, so these run in turn.
  const countRows = await run("e.kind, count(*)::int AS count", between, "GROUP BY e.kind");
  const answerRows = await run("e.exit_answer AS answer, count(*)::int AS count",
    () => `${between()} AND e.kind = 'checkout_left' AND e.exit_answer IS NOT NULL`,
    `GROUP BY e.exit_answer ORDER BY count DESC, answer LIMIT ${EXIT_ANSWERS_SHOWN}`);
  const checkoutRows = await run("e.id, e.at, e.client_id, e.order_id",
    () => `${between()} AND e.kind = 'checkout_reached'`, "ORDER BY e.at, e.id");
  const paidRows = await run("e.id, e.at, e.client_id, e.order_id",
    () => `e.kind = 'paid' AND e.at >= $1::timestamptz AND e.at <= $2::timestamptz + interval '24 hours'
      AND e.client_id IN (SELECT c.client_id FROM funnel_events c
        WHERE c.kind = 'checkout_reached' AND c.at >= $1::timestamptz AND c.at <= $2::timestamptz)`,
    "ORDER BY e.at, e.id");
  const event = (kind) => (row) => ({ id: row.id, at: iso(row.at), clientId: row.client_id, kind, orderId: row.order_id });
  return funnelSummary({
    counts: Object.fromEntries(countRows.map((row) => [row.kind, row.count])),
    answers: answerRows.map((row) => ({ answer: row.answer, count: row.count })).sort(answerOrder),
    checkouts: checkoutRows.map(event("checkout_reached")),
    paid: paidRows.map(event("paid")),
  }, nowMs);
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

function categoryFrom(order, line, item) {
  const spec = line?.structuredSpecSnapshot || {};
  if (typeof spec.subcategoryCode === "string" && spec.subcategoryCode) return spec.subcategoryCode;
  if (typeof spec.categoryCode === "string" && spec.categoryCode) return spec.categoryCode;
  if (typeof item?.subcategoryCode === "string" && item.subcategoryCode) return item.subcategoryCode;
  if (typeof order.subcategoryCode === "string" && order.subcategoryCode) return order.subcategoryCode;
  return "unspecified";
}

export function categoryOf(order, lines, catalog) {
  const line = (lines || []).find((item) => item.orderId === order.id);
  return categoryFrom(order, line, (catalog || []).find((row) => row.id === line?.sourceCatalogItemId));
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

/** Operations actions per order, read from the audit log once. */
function opsActivity(audit) {
  const byOrder = new Map();
  for (const entry of audit || []) {
    if (!entry.orderId || !OPS_ROLES.has(entry.actorRole)) continue;
    const row = byOrder.get(entry.orderId) || { count: 0, first: null };
    row.count += 1;
    const at = entry.at ? Date.parse(entry.at) : NaN;
    if (Number.isFinite(at) && (row.first == null || at < row.first)) row.first = at;
    byOrder.set(entry.orderId, row);
  }
  return byOrder;
}

function firstOpsMillis(order, ops) {
  if (!order.createdAt) return null;
  const first = ops.get(order.id)?.first;
  if (first == null) return null;
  const ms = first - Date.parse(order.createdAt);
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

function priceGroups(rows) {
  const byCategory = new Map();
  const byBracket = new Map(PRICE_BRACKETS.map((band) => [band.id, []]));
  for (const { order, category, bracket } of rows) {
    if (!Number.isSafeInteger(order.supplierSubtotalMinor)) continue;
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(order.supplierSubtotalMinor);
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

function periodReport(rows, funnel, ops, refundRequests, refunds, paymentFeeBps) {
  const orders = rows.map((row) => row.order);
  const orderIds = new Set(orders.map((order) => order.id));
  const refundOrders = new Set([
    ...refundRequests.filter((row) => orderIds.has(row.orderId)).map((row) => row.orderId),
    ...refunds.filter((row) => orderIds.has(row.orderId)).map((row) => row.orderId),
  ]);
  const settlements = refunds.filter((row) => orderIds.has(row.orderId));
  return {
    funnel,
    operations: {
      note: OPERATIONS_MINIMUM,
      qualityCheck: averageAndMedian(orders.map(qaMillis).filter((value) => value != null)),
      firstAction: averageAndMedian(orders.map((order) => firstOpsMillis(order, ops)).filter((value) => value != null)),
      manualInterventions: orders.reduce((total, order) => total + (ops.get(order.id)?.count || 0), 0),
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
    prices: priceGroups(rows),
    earnings: orders.map((order) => orderEarnings(order, refunds, paymentFeeBps)),
  };
}

function matches(order, index, filters) {
  if (filters.category && index.category !== filters.category) return false;
  if (filters.bracket && index.bracket !== filters.bracket) return false;
  if (filters.accountType && index.accountType !== filters.accountType) return false;
  if (filters.cohort && index.cohort !== filters.cohort) return false;
  return true;
}

/** Orders kept by the dashboard filters, each indexed once (no per-order scans). */
function pricingSelection({ orders = [], lines = [], catalog = [], users = [], query = {} }) {
  orders = orders.filter(order => !isReviewData(order));
  const filters = {
    category: query.category || "",
    bracket: query.bracket || "",
    accountType: query.accountType || "",
    cohort: query.cohort || "",
  };
  const firstLine = new Map();
  for (const line of lines) if (!firstLine.has(line.orderId)) firstLine.set(line.orderId, line);
  const catalogById = new Map(catalog.map((item) => [item.id, item]));
  const usersById = new Map(users.map((user) => [user.id, user]));
  const firstOrderAt = new Map();
  for (const order of orders) {
    if (!order.createdAt) continue;
    const prior = firstOrderAt.get(order.clientId);
    if (!prior || order.createdAt < prior) firstOrderAt.set(order.clientId, order.createdAt);
  }
  const indexed = orders.map((order) => {
    const line = firstLine.get(order.id);
    const accountType = usersById.get(order.clientId)?.accountType;
    return {
      order,
      category: categoryFrom(order, line, catalogById.get(line?.sourceCatalogItemId)),
      bracket: bracketOf(order.supplierSubtotalMinor),
      accountType: accountType === "business" || accountType === "organization" ? accountType : "individual",
      cohort: order.createdAt && order.createdAt === firstOrderAt.get(order.clientId) ? "new" : "repeat",
    };
  });
  return { filters, selected: indexed.filter((row) => matches(row.order, row, filters)) };
}

function dashboardContext(input) {
  const ranges = pricingRanges(input.query, input.now);
  const { filters, selected } = pricingSelection(input);
  const scope = funnelScope({ filters, orders: input.orders, users: input.users, selectedOrderIds: selected.map((row) => row.order.id) });
  scope.excludeReviewData = true;
  scope.reviewOrderIds = (input.orders || []).filter(isReviewData).map(row => row.id);
  const nowMs = Number.isFinite(Date.parse(input.now)) ? Date.parse(input.now) : Date.now();
  return { ranges, filters, selected, scope, nowMs };
}

/**
 * The dashboard over bounded ranges. Funnel figures come from `funnel`
 * ({ period, compare }, see readPricingDashboard) or, without PostgreSQL,
 * from the in-memory `events`.
 */
export function pricingDashboard(input) {
  const {
    audit = [], refundRequests = [], refunds = [], events = [], funnel = null,
    settings = {}, version = null, query = {}, now,
  } = input;
  const { ranges, filters, selected, scope, nowMs } = dashboardContext(input);
  const paymentFeeBps = Number.isInteger(settings.pricingPaymentFeeBps) ? settings.pricingPaymentFeeBps : null;
  const ops = opsActivity(audit);
  const slice = (range, summary) => periodReport(
    selected.filter((row) => inRange(row.order.createdAt, range.from, range.to)),
    summary ?? funnelFromEvents(events, range, scope, nowMs),
    ops,
    refundRequests,
    refunds,
    paymentFeeBps,
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
    range: { ...ranges.period, defaultDays: DEFAULT_RANGE_DAYS, maxDays: MAX_RANGE_DAYS },
    compareRange: ranges.compare,
    settings: {
      version,
      fixedCostsMinor: Number.isSafeInteger(settings.pricingFixedCostsMinor) ? settings.pricingFixedCostsMinor : null,
      paymentFeeBps,
    },
    period: slice(ranges.period, funnel?.period),
    compare: ranges.compare ? slice(ranges.compare, funnel?.compare) : null,
    completedThisMonth: monthOrders.length,
    breakEven: breakEvenOrders(settings.pricingFixedCostsMinor, averageFee, settings.pricingPaymentFeeBps),
  };
}

/** The dashboard with funnel figures from indexed PostgreSQL aggregates. */
export async function readPricingDashboard(database, input) {
  const { ranges, scope, nowMs } = dashboardContext(input);
  const funnel = {
    period: await readFunnelSummary(database, ranges.period, scope, nowMs),
    compare: ranges.compare ? await readFunnelSummary(database, ranges.compare, scope, nowMs) : null,
  };
  return pricingDashboard({ ...input, funnel });
}
