import test from "node:test";
import assert from "node:assert/strict";

import {
  createNotificationEvents,
  formatNotificationEvent,
  listInbox,
  notificationSnapshot,
  parseNotificationListLimit,
} from "../src/notifications.js";

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

test("list inbox is bounded and carries the job title and state, not the whole order", () => {
  assert.equal(parseNotificationListLimit(undefined), 40);
  assert.equal(parseNotificationListLimit("0"), 40);
  assert.equal(parseNotificationListLimit("5000"), 100);

  const store = {
    notifications: [
      { id: "ntf_old", userId: "client", title: "Old", body: "x", read: true, at: "2026-08-11T01:00:00.000Z", orderId: "ord_1" },
      { id: "ntf_mid", userId: "client", title: "Mid", body: "x", read: false, at: "2026-08-11T02:00:00.000Z", orderId: "ord_1" },
      { id: "ntf_new", userId: "client", title: "New", body: "x", read: false, at: "2026-08-11T03:00:00.000Z", orderId: "ord_1" },
      { id: "ntf_other", userId: "other", title: "No", body: "x", read: false, at: "2026-08-11T04:00:00.000Z" },
    ],
    orders: [
      {
        id: "ord_1",
        title: "Grand opening tarpaulin",
        state: "production",
        timeline: [{ at: "2026-08-11T00:00:00.000Z", state: "production" }],
        payments: { downpayment: { amountMinor: 1 } },
      },
    ],
  };

  const listed = listInbox(store, "client", { limit: "2" });
  assert.equal(listed.notifications.length, 2);
  assert.deepEqual(
    listed.notifications.map((item) => item.id),
    ["ntf_new", "ntf_mid"],
  );
  assert.equal(listed.snapshot, "ntf_new");
  assert.equal(listed.notifications[0].orderTitle, "Grand opening tarpaulin");
  assert.equal(listed.notifications[0].orderState, "production");
  assert.equal(listed.notifications[0].timeline, undefined);
  assert.equal(listed.notifications[0].payments, undefined);
});
