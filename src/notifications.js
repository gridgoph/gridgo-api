/**
 * Additive notification migration for legacy stores.
 *
 * A missing read flag means unread. Deletion metadata is intentionally sparse:
 * an absent deletedAt means the notification is still visible.
 */
export function backfillNotifications(store) {
  let changed = false;
  if (!Array.isArray(store.notifications)) {
    store.notifications = [];
    return true;
  }

  for (const notification of store.notifications) {
    if (!Object.hasOwn(notification, "read")) {
      notification.read = false;
      changed = true;
    }
  }

  return changed;
}

export function notificationSnapshot(notifications, userId) {
  for (let index = notifications.length - 1; index >= 0; index -= 1) {
    if (notifications[index].userId === userId) return notifications[index].id;
  }
  return null;
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
