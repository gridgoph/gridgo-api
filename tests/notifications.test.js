import test from "node:test";
import assert from "node:assert/strict";

import {
  createNotificationEvents,
  formatInvalidateEvent,
  formatNotificationEvent,
  invalidateAudienceIds,
  listInbox,
  notificationSnapshot,
  parseNotificationListLimit,
  publicNotification,
  queueInvalidate,
  queueOrderInvalidate,
  takeQueuedInvalidates,
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

test("SSE notification frames are decorated like GET /notifications", () => {
  const notification = {
    id: "ntf_123",
    userId: "client",
    title: "Ready",
    body: "Review",
    read: false,
    at: "2026-09-01T00:00:00.000Z",
    type: "order_needs_qa",
    orderId: "ord_1",
    timeline: [{ at: "2026-09-01T00:00:00.000Z" }],
  };
  const order = { id: "ord_1", title: "Flyers", state: "needs_qa" };
  const framed = formatNotificationEvent(notification, order);
  assert.match(framed, /^id: ntf_123\nevent: notification\ndata: /);
  const data = JSON.parse(framed.split("data: ")[1]);
  assert.equal(data.orderTitle, "Flyers");
  assert.equal(data.orderState, "needs_qa");
  assert.equal(data.timeline, undefined);
  assert.deepEqual(data, publicNotification(notification, order));
});

test("invalidate frames have no event id and never carry a collection", () => {
  assert.equal(
    formatInvalidateEvent({ resource: "orders", id: "ord_1" }),
    `event: invalidate\ndata: ${JSON.stringify({ resource: "orders", id: "ord_1" })}\n\n`,
  );
  assert.equal(
    formatInvalidateEvent({ resource: "approvals" }),
    `event: invalidate\ndata: ${JSON.stringify({ resource: "approvals" })}\n\n`,
  );
});

test("invalidate audience is membership-aware ops plus the assigned shop for jobs", () => {
  const store = {
    userRoleMemberships: [
      { userId: "user_ops", role: "ops_admin" },
      { userId: "user_admin", role: "super_admin" },
      { userId: "user_s", role: "supplier" },
      { userId: "user_c", role: "client" },
    ],
    users: [
      { id: "user_legacy_ops", role: "ops_admin" },
    ],
  };
  assert.deepEqual(
    invalidateAudienceIds(store, { resource: "orders", clientId: "user_c", supplierId: "user_s" }).sort(),
    ["user_admin", "user_c", "user_ops", "user_s"],
  );
  assert.deepEqual(
    invalidateAudienceIds(store, { resource: "jobs", supplierId: "user_s" }).sort(),
    ["user_admin", "user_ops", "user_s"],
  );
  assert.ok(!invalidateAudienceIds(store, { resource: "approvals" }).includes("user_legacy_ops"));
});

test("queued invalidates de-dupe in one transaction and publish after take", () => {
  const store = {};
  queueOrderInvalidate(store, { id: "ord_1", supplierId: "user_s" }, ["orders", "jobs"]);
  queueOrderInvalidate(store, { id: "ord_1", supplierId: "user_s" }, ["orders"]);
  queueInvalidate(store, { resource: "secrets" });
  const pending = takeQueuedInvalidates(store);
  assert.deepEqual(
    pending.map((row) => `${row.resource}:${row.id}`).sort(),
    ["jobs:ord_1", "orders:ord_1"],
  );
  assert.deepEqual(takeQueuedInvalidates(store), []);
});

test("invalidate subscribers are user-scoped and do not resume from Last-Event-ID", () => {
  const events = createNotificationEvents();
  const received = [];
  const unsubscribe = events.subscribeInvalidate("user_ops", (payload) => received.push(payload));
  events.publishInvalidate("user_other", { resource: "orders" });
  events.publishInvalidate("user_ops", { resource: "orders", id: "ord_1" });
  assert.deepEqual(received, [{ resource: "orders", id: "ord_1" }]);
  unsubscribe();
  events.publishInvalidate("user_ops", { resource: "jobs" });
  assert.deepEqual(received, [{ resource: "orders", id: "ord_1" }]);
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
  assert.equal(listed.notifications[0].fulfillmentMode, undefined);
  assert.equal(listed.notifications[0].collectHold, undefined);
});

test("list inbox stamps collect jobs so the phone can tell pickup from a door delivery", () => {
  const store = {
    notifications: [
      {
        id: "ntf_hold",
        userId: "client",
        title: "Ready for pickup",
        body: "x",
        read: false,
        at: "2026-09-01T05:16:00.000Z",
        orderId: "ord_pick",
        type: "order_ready_for_pickup",
      },
    ],
    orders: [
      {
        id: "ord_pick",
        title: "Booth backdrops",
        state: "awaiting_collection",
        fulfillmentMode: "pickup",
        payments: { final_online: { status: "not_submitted" } },
      },
    ],
  };

  const listed = listInbox(store, "client");
  assert.equal(listed.notifications[0].fulfillmentMode, "pickup");
  assert.equal(listed.notifications[0].collectHold, true);
  assert.equal(listed.notifications[0].orderTitle, "Booth backdrops");
  assert.equal(listed.notifications[0].payments, undefined);
});
