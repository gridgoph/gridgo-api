import { isContainedPickup } from "./operational-model.js";
export const NOTIFICATION_LIST_DEFAULT_LIMIT = 40;
export const NOTIFICATION_LIST_MAX_LIMIT = 100;

export const INVALIDATE_RESOURCES = Object.freeze([
  "orders",
  "jobs",
  "approvals",
  "escalations",
  "claims",
  "dispatch",
  "payouts",
  "notifications", "identity", "catalog", "services", "availability", "settings", "location", "credits",
]);

const pendingInvalidates = new WeakMap();

export function notificationSnapshot(notifications, userId) {
  for (let index = notifications.length - 1; index >= 0; index -= 1) {
    if (notifications[index].userId === userId) return notifications[index].id;
  }
  return null;
}

export function parseNotificationListLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return NOTIFICATION_LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), NOTIFICATION_LIST_MAX_LIMIT);
}

const CLIENT_EVENT_STATES = {
  order_needs_qa: "needs_qa", order_client_correction: "client_correction",
  order_proof_approval: "proof_approval", supplier_assignment_final_price: "awaiting_checkout",
  order_in_production: "production", order_shop_qc: "supplier_self_qc",
  order_ready_for_dispatch: "ready_for_dispatch", order_rider_assigned: "rider_assigned",
  order_picked_up: "picked_up", order_out_for_delivery: "out_for_delivery",
  order_ready_for_pickup: "awaiting_collection", order_cancelled: "cancelled",
  order_completed: "completed",
};

const FINAL_PAYMENT_ACTION_STATES = new Set([
  "production", "supplier_self_qc", "ready_for_dispatch", "rider_assigned",
  "picked_up", "out_for_delivery", "awaiting_collection",
]);

export function finalPaymentAction(order) {
  if (!FINAL_PAYMENT_ACTION_STATES.has(order?.state)) return null;
  const initial = order.payments?.initial ?? order.payments?.downpayment;
  const final = order.payments?.final_online ?? order.payments?.balance;
  if (initial?.status !== "confirmed"
      || !Number.isSafeInteger(final?.amountMinor) || final.amountMinor <= 0
      || !["not_submitted", "pending_confirmation"].includes(final.status)) return null;
  return { installment: "final_online", status: final.status === "pending_confirmation" ? "pending_confirmation" : "due", amountMinor: final.amountMinor };
}

/** Inbox row with current action metadata; stored event copy remains historical. */
export function publicNotification(notification, order) {
  const item = {
    id: notification.id,
    userId: notification.userId,
    title: notification.title,
    body: notification.body,
    read: Boolean(notification.read),
    at: notification.at,
  };
  if (notification.type) item.type = notification.type;
  if (CLIENT_EVENT_STATES[notification.type]) item.eventState = CLIENT_EVENT_STATES[notification.type];
  if (notification.orderId) item.orderId = notification.orderId;
  if (notification.imageUrl) item.imageUrl = notification.imageUrl;
  if (notification.announcementId) item.announcementId = notification.announcementId;
  if (notification.approvalCaseId) item.approvalCaseId = notification.approvalCaseId;
  if (order?.title) item.orderTitle = order.title;
  if (order?.state) item.orderState = order.state;
  if (order?.fulfillmentMode === "pickup" || order?.fulfillmentMode === "delivery") {
    item.fulfillmentMode = order.fulfillmentMode;
  }
  if (order?.fulfillmentMode === "pickup" && order.state === "awaiting_collection") {
    const status = order.payments?.final_online?.status;
    item.collectHold = Boolean(status) && status !== "confirmed" && status !== "legacy_confirmed";
  }
  if (notification.userId === order?.clientId && (!notification.appRole || notification.appRole === "client")) {
    const action = finalPaymentAction(order);
    if (action) item.paymentAction = action;
  }
  return item;
}

export function listInbox(store, userId, options = {}) {
  const cap = parseNotificationListLimit(options.limit);
  const owned = (store.notifications || [])
    .filter((notification) => notificationVisible(store, notification, userId, options.role))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const ordersById = new Map((store.orders || []).map((order) => [order.id, order]));
  return {
    notifications: owned.slice(0, cap).map((notification) =>
      publicNotification(
        notification,
        notification.orderId ? ordersById.get(notification.orderId) ?? null : null,
      ),
    ),
    snapshot: notificationSnapshot(store.notifications || [], userId),
  };
}

function addSubscriber(subscribers, userId, handler) {
  let handlers = subscribers.get(userId);
  if (!handlers) {
    handlers = new Set();
    subscribers.set(userId, handlers);
  }
  handlers.add(handler);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    handlers.delete(handler);
    if (handlers.size === 0) subscribers.delete(userId);
  };
}

function publishTo(subscribers, userId, payload, store) {
  for (const handler of subscribers.get(userId) || []) {
    try {
      handler(payload, store);
    } catch {
      // A broken/disconnected stream must not fail the already-persisted mutation.
    }
  }
}

export function createNotificationEvents() {
  const subscribers = new Map();
  const invalidateSubscribers = new Map();

  return {
    subscribe(userId, handler) {
      return addSubscriber(subscribers, userId, handler);
    },

    subscribeInvalidate(userId, handler) {
      return addSubscriber(invalidateSubscribers, userId, handler);
    },

    publish(notification, store) {
      publishTo(subscribers, notification.userId, notification, store);
    },

    publishInvalidate(userId, payload, store) {
      publishTo(invalidateSubscribers, userId, payload, store);
    },

    userIds() { return [...new Set([...subscribers.keys(), ...invalidateSubscribers.keys()])]; },

    subscriberCount(userId) {
      return subscribers.get(userId)?.size || 0;
    },
  };
}

/** Stream frames match GET /notifications — job title/state, never the order. */
export function formatNotificationEvent(notification, order) {
  const body = publicNotification(notification, order);
  return `id: ${notification.id}\nevent: notification\ndata: ${JSON.stringify(body)}\n\n`;
}

/**
 * Silent refetch ping. No `id:` field — reconnect refetch is enough; do not
 * resume invalidate history from Last-Event-ID.
 */
export function formatInvalidateEvent(payload) {
  const data = { resource: payload.resource };
  if (payload.id) data.id = payload.id;
  return `event: invalidate\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Ops and Super Admin memberships, one row per (user, role). Invalidate uses unique ids. */
export function privilegedAdminMemberships(store) {
  const seen = new Set();
  const rows = [];
  for (const membership of store.userRoleMemberships || []) {
    if (membership.role !== "ops_admin" && membership.role !== "super_admin") continue;
    const key = `${membership.userId}:${membership.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(membership);
  }
  return rows;
}

/** Identities that are ops or super_admin via memberships, not only users.role. */
export function opsAdminRecipientIds(store) {
  return [...new Set(privilegedAdminMemberships(store).map((membership) => membership.userId))];
}

export function orderFromNotification(store, notification) {
  if (!notification?.orderId) return null;
  return (store.orders || []).find((order) => order.id === notification.orderId) || null;
}

/**
 * Who should hear a refetch ping: every connected ops/admin for platform
 * resources, plus the assigned shop for jobs/orders/payouts and the
 * client/rider when the ping is about their order.
 */
export function invalidateAudienceIds(store, event) {
  const ids = new Set(event.userIds || []);
  if (["notifications", "identity", "credits"].includes(event.resource)) return [...ids];
  if (event.resource === "location") {
    const order = (store.orders || []).find(o => o.id === event.id);
    return (store.users || []).filter(u => canAccessOrder(store,u.id,order,{location:true})).map(u => u.id);
  }
  if (INVALIDATE_RESOURCES.includes(event.resource)) {
    for (const userId of opsAdminRecipientIds(store)) ids.add(userId);
  }
  if (
    event.supplierId
    && (event.resource === "jobs" || event.resource === "orders" || event.resource === "payouts")
  ) {
    ids.add(event.supplierId);
  }
  if (event.clientId && event.resource === "orders") ids.add(event.clientId);
  if (
    event.riderId
    && (event.resource === "dispatch" || event.resource === "orders" || event.resource === "jobs")
  ) {
    ids.add(event.riderId);
  }
  return [...ids];
}

export function queueInvalidate(store, event) {
  if (!event?.resource || !INVALIDATE_RESOURCES.includes(event.resource)) return;
  let list = pendingInvalidates.get(store);
  if (!list) {
    list = [];
    pendingInvalidates.set(store, list);
  }
  const key = `${event.resource}:${event.id || ""}`;
  const prior = list.find((row) => `${row.resource}:${row.id || ""}` === key);
  if (prior) {
    prior.userIds = [...new Set([...(prior.userIds || []), ...(event.userIds || []), ...invalidateAudienceIds(store,prior), ...invalidateAudienceIds(store,event)])];
    for (const field of ['supplierId','clientId','riderId']) if (!prior[field] && event[field]) prior[field]=event[field];
    return;
  }
  list.push({
    resource: event.resource,
    ...(event.userIds ? { userIds: [...event.userIds] } : {}),
    ...(event.id ? { id: event.id } : {}),
    ...(event.supplierId ? { supplierId: event.supplierId } : {}),
    ...(event.clientId ? { clientId: event.clientId } : {}),
    ...(event.riderId ? { riderId: event.riderId } : {}),
  });
}

export function queueOrderInvalidate(store, order, resources) {
  if (!order) return;
  for (const resource of resources) {
    queueInvalidate(store, {
      resource,
      id: order.id,
      supplierId: order.supplierId || null,
      clientId: order.clientId || null,
      riderId: order.riderId || null,
    });
  }
}

export function takeQueuedInvalidates(store) {
  const list = pendingInvalidates.get(store) || [];
  pendingInvalidates.delete(store);
  return list;
}

export function publishQueuedInvalidates(events, store) {
  for (const event of takeQueuedInvalidates(store)) {
    const frame = { resource: event.resource, ...(event.id ? { id: event.id } : {}) };
    for (const userId of invalidateAudienceIds(store, event)) {
      events.publishInvalidate(userId, frame, store);
    }
  }
}

export const EVENT_ROLES = Object.freeze(['client', 'supplier', 'rider', 'ops_admin', 'super_admin']);
export function hasRole(store, userId, role) {
  return (store.userRoleMemberships || []).some(m => m.userId === userId && m.role === role);
}
export function approvedRole(store, userId, role) {
  if (!hasRole(store, userId, role)) return false;
  if (!['supplier', 'rider'].includes(role)) return true;
  const approval = (store.approvalCases || []).find(c => c.userId === userId && c.kind === role);
  // Explicit migration-era fallback only where a case is absent.
  return approval ? approval.status === 'approved' : (store.users || []).some(u => u.id === userId && u.role === role && u.verificationStatus === 'approved');
}
export function eligibleRiderIds(store) {
  return [...new Set((store.userRoleMemberships || []).filter(m => m.role === 'rider' && approvedRole(store,m.userId,'rider')).map(m => m.userId))];
}
export function canAccessOrder(store, userId, order, {role, location = false, offer = false} = {}) {
  if (!order) return false;
  const roles = role ? [role] : EVENT_ROLES;
  return roles.some(r => {
    if (!hasRole(store,userId,r)) return false;
    if (r === 'ops_admin' || r === 'super_admin') return true;
    if (r === 'client') return order.clientId === userId && (!location || order.fulfillmentMode !== 'pickup');
    if (!approvedRole(store,userId,r)) return false;
    if (r === 'supplier') return order.supplierId === userId || (!location && !order.supplierId && (store.orderJobs || []).filter(j=>j.orderId===order.id&&j.state!=='cancelled').length>1 && (store.orderJobs || []).some(j => j.orderId === order.id && j.supplierId === userId && j.state !== 'cancelled'));
    return order.riderId === userId || (!location && offer && order.state === 'ready_for_dispatch' && !order.riderId && !isContainedPickup(order));
  });
}
export function notificationVisible(store, notification, userId, role) {
  if (!notification || notification.userId !== userId || notification.deletedAt != null) return false;
  if (role && !hasRole(store,userId,role)) return false;
  const requiredRole = notification.appRole || (notification.type?.startsWith('shop_') ? 'supplier' : notification.type?.startsWith('ops_') ? 'ops_admin' : null);
  const legacySuperSeesOps = requiredRole === "ops_admin"
    && (!role || role === "super_admin")
    && !hasRole(store, userId, "ops_admin")
    && hasRole(store, userId, "super_admin");
  if (requiredRole && role && requiredRole !== role) {
    // Super-only accounts still see historical ops_admin-tagged rows. Dual members
    // get a super_admin-appRole copy and must not see the ops copy in that inbox.
    if (!legacySuperSeesOps) return false;
  }
  if (requiredRole && !hasRole(store,userId,requiredRole) && !(requiredRole==='ops_admin'&&hasRole(store,userId,'super_admin'))) return false;
  if (notification.audienceRoles && !(role ? notification.audienceRoles.includes(role) && hasRole(store,userId,role) : notification.audienceRoles.some(r=>hasRole(store,userId,r)))) return false;
  if (notification.approvalCaseId) {
    const c = (store.approvalCases || []).find(c => c.id === notification.approvalCaseId);
    return Boolean(c && ((c.userId === userId && (!role || role === (c.kind === 'business_client' ? 'client' : c.kind))) || ((!role || ['ops_admin','super_admin'].includes(role)) && opsAdminRecipientIds(store).includes(userId))));
  }
  if (notification.orderId) return canAccessOrder(store,userId,orderFromNotification(store,notification),{role:role || (legacySuperSeesOps ? 'super_admin' : requiredRole),offer:notification.type === 'dispatch_available'});
  return true;
}
