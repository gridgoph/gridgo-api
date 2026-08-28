export const NOTIFICATION_LIST_DEFAULT_LIMIT = 40;
export const NOTIFICATION_LIST_MAX_LIMIT = 100;

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
  if (order?.title) item.orderTitle = order.title;
  if (order?.state) item.orderState = order.state;
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

export function createNotificationEvents() {
  const subscribers = new Map();

  return {
    subscribe(userId, handler) {
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
    },

    publish(notification) {
      for (const handler of subscribers.get(notification.userId) || []) {
        try {
          handler(notification);
        } catch {
          // A broken/disconnected stream must not fail the already-persisted mutation.
        }
      }
    },

    subscriberCount(userId) {
      return subscribers.get(userId)?.size || 0;
    },
  };
}

export function formatNotificationEvent(notification) {
  return `id: ${notification.id}\nevent: notification\ndata: ${JSON.stringify(notification)}\n\n`;
}
