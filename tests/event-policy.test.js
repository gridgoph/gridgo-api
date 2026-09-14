import test from "node:test";
import assert from "node:assert/strict";
import * as policy from "../src/notifications.js";
import {
  notifyOpsPaymentSubmitted,
  writeDraft,
} from "../src/client-order-notifications.js";
const store = () => ({
  users: [
    { id: "c", role: "client" },
    { id: "s", role: "supplier" },
    { id: "r", role: "rider" },
    { id: "r2", role: "client" },
    { id: "ops", role: "client" },
  ],
  userRoleMemberships: [
    { userId: "c", role: "client" },
    { userId: "s", role: "supplier" },
    { userId: "r", role: "rider" },
    { userId: "r2", role: "rider" },
    { userId: "ops", role: "ops_admin" },
  ],
  approvalCases: [
    { userId: "s", kind: "supplier", status: "approved" },
    { userId: "r", kind: "rider", status: "approved" },
    { userId: "r2", kind: "rider", status: "approved" },
  ],
  orders: [
    {
      id: "o",
      clientId: "c",
      supplierId: "s",
      riderId: "r",
      state: "out_for_delivery",
      fulfillmentMode: "pickup",
      title: "private",
    },
  ],
  notifications: [],
});
test("later installments and resubmissions alert, retry deduplicates", () => {
  const s = store();
  let i = 0;
  const o = { id: "o", payments: { initial: { submittedAt: "a" } } };
  const args = { createId: () => `n${++i}`, at: "a" };
  notifyOpsPaymentSubmitted(s, o, args);
  notifyOpsPaymentSubmitted(s, o, args);
  o.payments.final_online = { submittedAt: "b" };
  notifyOpsPaymentSubmitted(s, o, { ...args, at: "b" });
  o.payments.final_online.submittedAt = "c";
  notifyOpsPaymentSubmitted(s, o, { ...args, at: "c" });
  assert.equal(s.notifications.length, 3);
});
test("deleted occurrence remains deduplicated but a new occurrence is delivered", () => {
  const s = store();
  const d = { userId: "c", type: "x", orderId: "o", occurrenceKey: "one" };
  writeDraft(s, d, { id: "a", at: "a" });
  s.notifications[0].deletedAt = "b";
  assert.equal(writeDraft(s, d, { id: "b", at: "a" }).created, false);
  assert.equal(
    writeDraft(s, { ...d, occurrenceKey: "two" }, { id: "c", at: "c" }).created,
    true,
  );
});
test("current membership approval and relationship constrain notification visibility", () => {
  const s = store();
  assert.equal(typeof policy.notificationVisible, "function");
  const n = { userId: "r2", orderId: "o", type: "dispatch_available" };
  assert.equal(policy.notificationVisible(s, n, "r2", "rider"), false);
  s.orders[0].riderId = null;
  s.orders[0].state = "ready_for_dispatch";
  assert.equal(policy.notificationVisible(s, n, "r2", "rider"), true);
  s.approvalCases[2].status = "suspended";
  assert.equal(policy.notificationVisible(s, n, "r2", "rider"), false);
});
test("office location and assignment revocation share event access policy", () => {
  const s = store();
  assert.equal(typeof policy.canAccessOrder, "function");
  assert.equal(
    policy.canAccessOrder(s, "c", s.orders[0], { location: true }),
    false,
  );
  assert.equal(policy.canAccessOrder(s, "r2", s.orders[0]), false);
  assert.equal(policy.canAccessOrder(s, "s", s.orders[0]), true);
  s.orders[0].supplierId = "new";
  assert.equal(policy.canAccessOrder(s, "s", s.orders[0]), false);
});
test("inbox strips revoked order notification rather than enriching stale access", () => {
  const s = store();
  s.notifications = [
    {
      id: "n",
      userId: "r2",
      orderId: "o",
      title: "private",
      type: "dispatch_available",
      at: "a",
    },
  ];
  assert.deepEqual(policy.listInbox(s, "r2").notifications, []);
});
test("pending applicant can read only own role decision", () => {
  const s = store();
  s.approvalCases[1] = {
    id: "ar",
    userId: "r",
    kind: "rider",
    status: "pending",
  };
  assert.equal(typeof policy.notificationVisible, "function");
  assert.equal(
    policy.notificationVisible(
      s,
      { userId: "r", approvalCaseId: "ar", type: "approval_decision" },
      "r",
      "rider",
    ),
    true,
  );
  assert.equal(
    policy.notificationVisible(
      s,
      { userId: "r", approvalCaseId: "ar" },
      "r2",
      "rider",
    ),
    false,
  );
});
test("dual-member client context cannot read supplier payout notification", () => {
  const s = store();
  s.userRoleMemberships.push({ userId: "s", role: "client" });
  s.orders[0].clientId = "s";
  const n = { userId: "s", orderId: "o", type: "shop_payout_released" };
  assert.equal(policy.notificationVisible(s, n, "s", "client"), false);
  assert.equal(policy.notificationVisible(s, n, "s", "supplier"), true);
});
test("duplicate invalidate unions early explicit and later relational recipients", () => {
  const s = store();
  policy.queueInvalidate(s, { resource: "orders", id: "o", userIds: ["old"] });
  policy.queueOrderInvalidate(s, s.orders[0], ["orders"]);
  const e = policy.takeQueuedInvalidates(s)[0];
  assert.deepEqual(policy.invalidateAudienceIds(s, e).sort(), [
    "c",
    "old",
    "ops",
    "r",
    "s",
  ]);
});
test("super_admin sees its membership row; dual members do not inherit the ops copy", () => {
  const s = store();
  s.users.push({ id: "admin", role: "super_admin" });
  s.userRoleMemberships.push({ userId: "admin", role: "super_admin" });
  const opsRow = {
    userId: "ops",
    type: "ops_order_progress",
    appRole: "ops_admin",
    orderId: "o",
  };
  const superRow = {
    userId: "admin",
    type: "ops_order_progress",
    appRole: "super_admin",
    orderId: "o",
  };
  const legacy = {
    userId: "admin",
    type: "ops_order_progress",
    appRole: "ops_admin",
    orderId: "o",
  };
  assert.equal(policy.notificationVisible(s, opsRow, "ops", "ops_admin"), true);
  assert.equal(
    policy.notificationVisible(s, superRow, "admin", "super_admin"),
    true,
  );
  assert.equal(
    policy.notificationVisible(s, legacy, "admin", "super_admin"),
    true,
  );
  s.userRoleMemberships.push({ userId: "admin", role: "ops_admin" });
  assert.equal(
    policy.notificationVisible(s, legacy, "admin", "super_admin"),
    false,
  );
  assert.equal(
    policy.notificationVisible(s, superRow, "admin", "super_admin"),
    true,
  );
});
test("same person distinct app-role purposes are not deduplicated together", () => {
  const s = store();
  const d = {
    userId: "c",
    type: "order_rider_assigned",
    orderId: "o",
    occurrenceKey: "a",
  };
  policy.queueInvalidate(s, { resource: "orders" });
  assert.equal(
    writeDraft(s, { ...d, appRole: "client" }, { id: "client_n", at: "a" })
      .created,
    true,
  );
  assert.equal(
    writeDraft(s, { ...d, appRole: "rider" }, { id: "rider_n", at: "a" })
      .created,
    true,
  );
});
