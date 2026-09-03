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

/** Inbox row. Job title/state only — never the hydrated order. */
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
  return item;
}

export function listInbox(store, userId, options = {}) {
  const cap = parseNotificationListLimit(options.limit);
  const owned = (store.notifications || [])
    .filter((notification) => notification.userId === userId && notification.deletedAt == null)
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

function publishTo(subscribers, userId, payload) {
  for (const handler of subscribers.get(userId) || []) {
    try {
      handler(payload);
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

    publish(notification) {
      publishTo(subscribers, notification.userId, notification);
    },

    publishInvalidate(userId, payload) {
      publishTo(invalidateSubscribers, userId, payload);
    },

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

/** Identities that are ops or super_admin via memberships, not only users.role. */
export function opsAdminRecipientIds(store) {
  const ids = new Set();
  for (const membership of store.userRoleMemberships || []) {
    if (membership.role === "ops_admin" || membership.role === "super_admin") {
      ids.add(membership.userId);
    }
  }
  return [...ids];
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
  const ids = new Set();
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
  if (list.some((row) => `${row.resource}:${row.id || ""}` === key)) return;
  list.push({
    resource: event.resource,
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
      events.publishInvalidate(userId, frame);
    }
  }
}
