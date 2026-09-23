/**
 * Production inactivity reminders.
 *
 * The phone never decides that a job has gone quiet. This module is the clock:
 * Operations sets the wait, and the lifecycle tick writes at most one new shop
 * inbox row when that wait has elapsed. A shop move — starting production,
 * filing printing or packaging proof, or writing a production note — resets
 * the clock. `order.updatedAt` does not, so a rider ping or an Operations note
 * cannot silence a reminder the shop still owes.
 */
import { writeDraft } from "./client-order-notifications.js";
import { privilegedAdminMemberships } from "./notifications.js";
import { activePayoutHold, defaultProductionNudge } from "./operational-model.js";

const WATCHED_STATES = new Set(["payment_authorized", "production", "supplier_self_qc"]);
const SHOP_PROOF_CODES = new Set(["printing", "packaging_qc"]);

const SHOP_COPY = {
  payment_authorized: {
    title: "This job is still waiting to start",
    body: "Payment is in. Open Jobs and start production, or the promised date is at risk.",
  },
  production: {
    title: "Update this job on the press",
    body: "Nothing has moved on this job for a while. Add a production update, file printing proof, or mark it ready for pickup.",
  },
  supplier_self_qc: {
    title: "This job still needs packing",
    body: "Printing is done. Pack it, file packaging proof, or mark it ready so a rider can collect it.",
  },
};

function toHours(value, unit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Number.NaN;
  return unit === "days" ? number * 24 : number;
}

function laterIso(current, candidate) {
  if (!candidate || Number.isNaN(Date.parse(candidate))) return current;
  if (!current || Number.isNaN(Date.parse(current))) return candidate;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

/** Hours the sweep actually waits. Days are converted here; the stored object keeps its unit. */
export function productionNudgeHours(settings) {
  const nudge = settings?.productionNudge ?? defaultProductionNudge();
  return {
    enabled: nudge.enabled === true,
    afterHours: toHours(nudge.afterValue, nudge.afterUnit),
    everyHours: toHours(nudge.repeatValue, nudge.repeatUnit),
    maxCount: nudge.maxCount,
  };
}

function isShopProductionMove(entry) {
  if (SHOP_PROOF_CODES.has(entry?.milestoneCode)) return true;
  return WATCHED_STATES.has(entry?.state);
}

/**
 * When the current silence started.
 *
 * That is the later of the moment the job entered this watched state and any
 * shop production move during the visit. A system entry (payment confirmed)
 * starts the clock; it does not count as the shop having moved.
 */
export function lastShopProductionAt(order, store) {
  if (!order?.supplierId || !WATCHED_STATES.has(order.state)) return null;
  const timeline = Array.isArray(order.timeline) ? order.timeline : [];
  let visitStart = -1;
  for (let index = 0; index < timeline.length; index += 1) {
    const entry = timeline[index];
    const previous = timeline[index - 1];
    if (entry?.state === order.state && previous?.state !== order.state) visitStart = index;
  }
  if (visitStart < 0) return null;
  let latest = timeline[visitStart]?.at || null;
  for (let index = visitStart; index < timeline.length; index += 1) {
    const entry = timeline[index];
    if (!entry || entry.by !== order.supplierId || !isShopProductionMove(entry)) continue;
    latest = laterIso(latest, entry.at);
  }
  for (const file of store?.files || []) {
    if (file?.ownerId !== order.supplierId || file.purpose !== "fulfilment_proof") continue;
    const attached = (file.references || []).some(
      (reference) => reference?.id === order.id && SHOP_PROOF_CODES.has(reference.milestoneCode),
    );
    if (!attached) continue;
    const at = file.attachedAt || file.updatedAt || file.createdAt;
    const enteredAt = timeline[visitStart]?.at;
    if (enteredAt && at && Date.parse(at) < Date.parse(enteredAt)) continue;
    latest = laterIso(latest, at);
  }
  return latest;
}

/**
 * When the next reminder may be written, or null when none is due to exist.
 *
 * The first reminder waits `afterHours` from the last shop move (or the state
 * entry). Each later one waits `everyHours` from the previous reminder, and
 * also a full `afterHours` from any shop move that happened after that
 * reminder — updating the job resets the clock. Null when reminders are off,
 * the silence has no anchor, or `maxCount` is already used up.
 */
export function nextNudgeDueAt(lastShopAt, lastNudgeAt, alreadySentCount, policy) {
  if (!policy?.enabled) return null;
  if (!Number.isInteger(alreadySentCount) || alreadySentCount < 0) return null;
  if (!Number.isInteger(policy.maxCount) || alreadySentCount >= policy.maxCount) return null;
  if (!lastShopAt || Number.isNaN(Date.parse(lastShopAt))) return null;
  if (!Number.isFinite(policy.afterHours) || !Number.isFinite(policy.everyHours)) return null;
  const afterMs = policy.afterHours * 60 * 60 * 1000;
  if (alreadySentCount === 0) return new Date(Date.parse(lastShopAt) + afterMs).toISOString();
  if (!lastNudgeAt || Number.isNaN(Date.parse(lastNudgeAt))) return null;
  const everyMs = policy.everyHours * 60 * 60 * 1000;
  const repeatAt = Date.parse(lastNudgeAt) + everyMs;
  const resetAt = Date.parse(lastShopAt) + afterMs;
  return new Date(Math.max(repeatAt, resetAt)).toISOString();
}

export function nudgeOccurrenceKey(order, n) {
  return `nudge:${order.id}:${order.state}:${n}`;
}

function proofWord(order) {
  if (order.state !== "production" && order.state !== "supplier_self_qc") return null;
  const milestones = order.payoutMilestones || [];
  for (const code of ["printing", "packaging_qc"]) {
    const milestone = milestones.find((item) => item.code === code);
    if (!milestone) continue;
    if (milestone.status === "released" || milestone.status === "pof_attached") continue;
    if (Array.isArray(milestone.pofFileIds) && milestone.pofFileIds.length > 0) continue;
    return code === "packaging_qc" ? "packaging" : "printing";
  }
  return null;
}

function shopDraft(order, n) {
  const copy = SHOP_COPY[order.state];
  const proof = proofWord(order);
  return {
    userId: order.supplierId,
    appRole: "supplier",
    type: "shop_production_inactive",
    occurrenceKey: nudgeOccurrenceKey(order, n),
    orderId: order.id,
    title: copy.title,
    body: proof
      ? `GRIDGO is still waiting on your ${proof} proof before that part of the job can be paid.`
      : copy.body,
    read: false,
  };
}

function sentForState(store, order) {
  const prefix = `nudge:${order.id}:${order.state}:`;
  return (store.notifications || []).filter(
    (notification) =>
      notification.type === "shop_production_inactive"
      && notification.orderId === order.id
      && typeof notification.occurrenceKey === "string"
      && notification.occurrenceKey.startsWith(prefix),
  );
}

/**
 * Write due reminders into the in-memory store. At most `limit` jobs per call.
 * Push is not this function's job; a later outbox failure must not unwind the
 * inbox rows the caller has already decided to keep.
 */
export function applyProductionNudges(store, { at, createId, limit = 100 } = {}) {
  if (typeof createId !== "function" || !at) {
    throw new Error("production nudge sweep requires createId and at");
  }
  const policy = productionNudgeHours(store?.settings);
  if (!policy.enabled) return [];
  const created = [];
  let written = 0;
  for (const order of store?.orders || []) {
    if (written >= limit) break;
    if (!order?.supplierId || !WATCHED_STATES.has(order.state)) continue;
    if (activePayoutHold(store, order)) continue;
    const sent = sentForState(store, order);
    const lastNudgeAt = sent.reduce((latest, notification) => laterIso(latest, notification.at), null);
    const due = nextNudgeDueAt(lastShopProductionAt(order, store), lastNudgeAt, sent.length, policy);
    if (!due || Date.parse(due) > Date.parse(at)) continue;
    const n = sent.length + 1;
    if (n > policy.maxCount) continue;
    const shop = writeDraft(store, shopDraft(order, n), { id: createId("ntf"), at });
    if (!shop.created) continue;
    created.push(shop.notification);
    written += 1;
    if (n !== policy.maxCount) continue;
    for (const membership of privilegedAdminMemberships(store)) {
      const ops = writeDraft(
        store,
        {
          userId: membership.userId,
          appRole: membership.role,
          type: "ops_production_inactive",
          occurrenceKey: nudgeOccurrenceKey(order, n),
          orderId: order.id,
          title: "A shop has not moved a job",
          body: "Every production reminder for this job has been sent and the shop still has not updated it.",
          read: false,
        },
        { id: createId("ntf"), at },
      );
      if (ops.created) created.push(ops.notification);
    }
  }
  return created;
}

/**
 * Run lifecycle steps in order. A failure in one — a push provider included —
 * is recorded and the remaining steps still run.
 */
export async function continueAfterStepFailure(steps, warn = console.warn) {
  const errors = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
      try {
        warn(`lifecycle worker failed: ${error?.code || "unavailable"}`);
      } catch {
        // Logging must not become the failure that skips the rest of the tick.
      }
    }
  }
  return errors;
}
