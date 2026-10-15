import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One audit entry, written once.
 *
 * The name is copied from the user row at this moment. A later rename does
 * not come back and change it. A name that is not on the row is left blank.
 */

const auditContext = new AsyncLocalStorage();

export function requestSource(req) {
  const headers = req?.headers;
  if (!headers) return null;
  const appHeader = headers["x-gridgo-role"] || headers["x-gridgo-app"];
  const deviceHeader = headers["user-agent"];
  const source = {};
  if (typeof appHeader === "string" && appHeader.trim()) source.app = appHeader.trim().slice(0, 80);
  if (typeof deviceHeader === "string" && deviceHeader.trim()) source.device = deviceHeader.trim().slice(0, 240);
  return Object.keys(source).length ? source : null;
}

export function inAuditRequest() {
  return Boolean(auditContext.getStore());
}

export function runWithAuditRequest(req, fn) {
  return auditContext.run({ source: requestSource(req) }, fn);
}

function actorOf(raw) {
  if (raw.actor) return raw.actor;
  if (raw.actorId || raw.actorRole) {
    return { id: raw.actorId ?? null, role: raw.actorRole || null, name: raw.actorName };
  }
  return null;
}

export function actorNameAtWrite(store, actor) {
  if (!actor || actor.role === "system") return null;
  const written = typeof actor.name === "string" ? actor.name.trim() : "";
  if (written) return written;
  const id = actor.id;
  if (!id) return null;
  const row = (store?.users || []).find((user) => user.id === id);
  const name = typeof row?.name === "string" ? row.name.trim() : "";
  return name || null;
}

export function valuesOf(raw) {
  if (Object.hasOwn(raw, "previous") || Object.hasOwn(raw, "current")) {
    return { previous: raw.previous ?? null, current: raw.current ?? null };
  }
  const detail = raw.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    if (Object.hasOwn(detail, "previous") || Object.hasOwn(detail, "current")) {
      return { previous: detail.previous ?? null, current: detail.current ?? null };
    }
    if (Object.hasOwn(detail, "from") || Object.hasOwn(detail, "to")) {
      return { previous: detail.from ?? null, current: detail.to ?? null };
    }
  }
  return { previous: null, current: detail ?? null };
}

export function appendAudit(store, raw) {
  if (!raw?.id || !raw?.at || !raw?.action) {
    throw new Error("An audit entry needs an id, a time, and an action.");
  }
  if (!Array.isArray(store.auditLog)) store.auditLog = [];
  const actor = actorOf(raw);
  const { previous, current } = valuesOf(raw);
  const entry = {
    id: raw.id,
    at: raw.at,
    actorId: actor?.role === "system" ? null : actor?.id || null,
    actorRole: actor?.role || null,
    actorName: actorNameAtWrite(store, actor),
    source: Object.hasOwn(raw, "source") ? raw.source : (auditContext.getStore()?.source ?? null),
    action: raw.action,
    entityType: raw.entityType || null,
    entityId: raw.entityId || null,
    orderId: raw.orderId || null,
    previous,
    current,
    detail: raw.detail ?? null,
    reason: raw.reason || null,
  };
  store.auditLog.push(entry);
  return entry;
}

export function filterAuditLog(list, query = {}) {
  let rows = Array.isArray(list) ? list : [];
  if (query.entityType) rows = rows.filter((entry) => entry.entityType === query.entityType);
  if (query.entityId) rows = rows.filter((entry) => entry.entityId === query.entityId);
  if (query.orderId) rows = rows.filter((entry) => entry.orderId === query.orderId);
  if (query.actorId) rows = rows.filter((entry) => entry.actorId === query.actorId);
  if (query.action) rows = rows.filter((entry) => entry.action === query.action);
  if (query.actionQuery) {
    const needle = String(query.actionQuery).trim().toLowerCase();
    if (needle) rows = rows.filter((entry) => String(entry.action || "").toLowerCase().includes(needle));
  }
  if (query.actor) {
    const needle = String(query.actor).trim().toLowerCase();
    if (needle) {
      rows = rows.filter((entry) =>
        [entry.actorName, entry.actorId, entry.actorRole].some((value) =>
          String(value || "").toLowerCase().includes(needle),
        ),
      );
    }
  }
  if (query.from) rows = rows.filter((entry) => entry.at >= query.from);
  if (query.to) rows = rows.filter((entry) => entry.at <= query.to);
  const limit = Math.min(Math.max(Number(query.limit || 100), 0), 500);
  return [...rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

/**
 * Which of the asked-for records exist.
 *
 * `recorded` means the product already does that thing and writes this action.
 * `absent` means the product does not do that thing. Those are not given a
 * made-up row.
 *
 * Fees, delivery fees, the hub schedule, and the hub switch are one settings
 * save (`settings.operational_update`), which keeps the previous settings and
 * the new ones. Sign-in stays with Clerk: this API has no sign-in route.
 */
export const AUDIT_TOPICS = [
  { area: "Settings", topic: "fees", status: "recorded", action: "settings.operational_update" },
  { area: "Settings", topic: "delivery fees", status: "recorded", action: "settings.operational_update" },
  { area: "Settings", topic: "schedules", status: "recorded", action: "settings.operational_update" },
  { area: "Settings", topic: "hub switch", status: "recorded", action: "settings.operational_update" },
  { area: "Settings", topic: "vouchers", status: "absent", action: null },
  { area: "Settings", topic: "invoice mode", status: "absent", action: null },
  { area: "Orders", topic: "forced steps", status: "recorded", action: "order.production_override" },
  { area: "Orders", topic: "QA ticks", status: "recorded", action: "order.qa_tick" },
  { area: "Orders", topic: "QA problems", status: "recorded", action: "order.qa_request_file" },
  { area: "Orders", topic: "holds", status: "recorded", action: "order.qa_hold" },
  { area: "Orders", topic: "reassignments", status: "recorded", action: "order.supplier_assigned" },
  { area: "Orders", topic: "rider reassignment", status: "recorded", action: "order.rider_assigned" },
  { area: "Orders", topic: "cancellations", status: "recorded", action: "order.cancelled" },
  { area: "Orders", topic: "refunds", status: "recorded", action: "refund.", example: "refund.requested" },
  { area: "Orders", topic: "penalties", status: "recorded", action: "production_lapse.", example: "production_lapse.deduction" },
  { area: "Orders", topic: "pin changes", status: "recorded", action: "order.dropoff_confirmed" },
  { area: "Money", topic: "payout releases", status: "recorded", action: "payout_milestone.release" },
  { area: "Money", topic: "freezes", status: "recorded", action: "claim.hold" },
  { area: "Money", topic: "voucher issue and void", status: "absent", action: null },
  { area: "Legal and privacy", topic: "document publishes", status: "absent", action: null },
  { area: "Legal and privacy", topic: "privacy requests", status: "recorded", action: "account_deletion_requested" },
  { area: "Legal and privacy", topic: "artwork downloads", status: "recorded", action: "order.artwork_download" },
  { area: "Staff", topic: "sign-ins", status: "absent", action: null },
  { area: "Staff", topic: "role changes", status: "recorded", action: "user.role_change" },
  { area: "Staff", topic: "account creation", status: "recorded", action: "user.account_create" },
  { area: "Staff", topic: "account removal", status: "recorded", action: "user.account_remove" },
];
