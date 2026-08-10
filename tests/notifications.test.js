import test from "node:test";
import assert from "node:assert/strict";

import {
  backfillNotifications,
  createNotificationEvents,
  formatNotificationEvent,
  notificationSnapshot,
} from "../src/notifications.js";

test("notification backfill is additive and byte-idempotent", () => {
  const deletedAt = "2026-08-11T02:00:00.000Z";
  const store = {
    notifications: [
      { id: "ntf_legacy", userId: "user_client", at: "2026-08-11T00:00:00.000Z" },
      { id: "ntf_read", userId: "user_client", read: true, at: "2026-08-11T01:00:00.000Z" },
      { id: "ntf_deleted", userId: "user_client", read: false, deletedAt, at: deletedAt },
    ],
  };

  assert.equal(backfillNotifications(store), true);
  assert.equal(store.notifications[0].read, false);
  assert.equal(store.notifications[1].read, true);
  assert.equal(store.notifications[2].deletedAt, deletedAt);
  const afterFirst = JSON.stringify(store);

  assert.equal(backfillNotifications(store), false);
  assert.equal(JSON.stringify(store), afterFirst, "second backfill changed the store");
});

test("notification snapshot is the caller's last append, including a soft-deleted watermark", () => {
  const notifications = [
    { id: "ntf_client_1", userId: "client" },
    { id: "ntf_foreign", userId: "other" },
    { id: "ntf_client_2", userId: "client", deletedAt: "2026-08-11T02:00:00.000Z" },
  ];

  assert.equal(notificationSnapshot(notifications, "client"), "ntf_client_2");
  assert.equal(notificationSnapshot(notifications, "missing"), null);
});

test("notification events are user-scoped and unsubscribe cleanup is idempotent", () => {
  const events = createNotificationEvents();
  const received = [];
  const unsubscribeBroken = events.subscribe("client", () => {
    throw new Error("disconnected response");
  });
  const unsubscribe = events.subscribe("client", (notification) => received.push(notification.id));
  assert.equal(events.subscriberCount("client"), 2);

  events.publish({ id: "ntf_foreign", userId: "other" });
  events.publish({ id: "ntf_owned", userId: "client" });
  assert.deepEqual(received, ["ntf_owned"]);

  unsubscribe();
  unsubscribe();
  assert.equal(events.subscriberCount("client"), 1);
  events.publish({ id: "ntf_after_disconnect", userId: "client" });
  assert.deepEqual(received, ["ntf_owned"]);
  unsubscribeBroken();
  assert.equal(events.subscriberCount("client"), 0);
});

test("SSE notification frames carry the durable notification id and JSON event", () => {
  const notification = { id: "ntf_123", userId: "client", read: false };
  assert.equal(
    formatNotificationEvent(notification),
    `id: ntf_123\nevent: notification\ndata: ${JSON.stringify(notification)}\n\n`,
  );
});
