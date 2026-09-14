import test from "node:test";
import assert from "node:assert/strict";
import { deriveDomainEvents } from "../src/domain-events.js";
import { takeQueuedInvalidates } from "../src/notifications.js";
function fixture() {
  return {
    users: [
      { id: "c" },
      { id: "s" },
      { id: "new" },
      { id: "r1" },
      { id: "r2" },
      { id: "ops" },
      { id: "super" },
    ],
    userRoleMemberships: [
      ["c", "client"],
      ["s", "supplier"],
      ["new", "supplier"],
      ["r1", "rider"],
      ["r2", "rider"],
      ["ops", "ops_admin"],
      ["super", "super_admin"],
    ].map(([userId, role]) => ({ userId, role })),
    approvalCases: ["s", "new", "r1", "r2"].map((userId) => ({
      userId,
      kind: userId.startsWith("r") ? "rider" : "supplier",
      status: "approved",
    })),
    orders: [
      {
        id: "o",
        clientId: "c",
        supplierId: "s",
        state: "ready_for_dispatch",
        updatedAt: "old",
        payments: { initial: { status: "pending_confirmation" } },
      },
    ],
    notifications: [],
  };
}
let id = 0;
const options = { createId: () => `n${++id}`, at: "2026-09-08T01:00:00Z" };
test("order state change pings Operations and Super Admin with the order id even when they need not act", () => {
  const before = fixture(),
    s = structuredClone(before);
  s.orders[0].state = "production";
  s.orders[0].updatedAt = "now";
  deriveDomainEvents(s, before, options);
  const rows = s.notifications.filter((n) => n.type === "ops_order_progress");
  assert.deepEqual(
    rows.map((n) => `${n.userId}:${n.appRole}`).sort(),
    ["ops:ops_admin", "super:super_admin"],
  );
  for (const row of rows) {
    assert.equal(row.orderId, "o");
    assert.match(row.title, /o/);
    assert.match(row.title, /production/i);
    assert.notEqual(row.push, false);
  }
});
test("draft orders do not create privileged progress rows", () => {
  const before = fixture(),
    s = structuredClone(before);
  s.orders.push({
    id: "draft",
    clientId: "c",
    state: "draft",
    updatedAt: "now",
  });
  deriveDomainEvents(s, before, options);
  assert.equal(
    s.notifications.some(
      (n) => n.orderId === "draft" && (n.userId === "ops" || n.userId === "super"),
    ),
    false,
  );
});
test("progress occurrence keys do not duplicate when the snapshot is derived twice", () => {
  const before = fixture(),
    s = structuredClone(before);
  s.orders[0].state = "delivered";
  s.orders[0].updatedAt = "now";
  deriveDomainEvents(s, before, options);
  const once = s.notifications.filter((n) => n.type === "ops_order_progress");
  assert.equal(once.length, 2);
  deriveDomainEvents(s, before, options);
  assert.equal(
    s.notifications.filter((n) => n.type === "ops_order_progress").length,
    2,
  );
});
test("a super_admin-only fleet still receives the progress row", () => {
  const before = fixture();
  before.userRoleMemberships = before.userRoleMemberships.filter(
    (m) => m.role !== "ops_admin",
  );
  const s = structuredClone(before);
  s.orders[0].state = "production";
  s.orders[0].updatedAt = "now";
  deriveDomainEvents(s, before, options);
  const row = s.notifications.find((n) => n.type === "ops_order_progress");
  assert.ok(row);
  assert.equal(row.userId, "super");
  assert.equal(row.appRole, "super_admin");
  assert.notEqual(row.push, false);
});
test("offer acceptance removes offer for both prior eligible riders with minimal refresh", () => {
  const before = fixture(),
    s = structuredClone(before);
  s.orders[0].riderId = "r1";
  s.orders[0].state = "rider_assigned";
  deriveDomainEvents(s, before, options);
  assert.ok(
    takeQueuedInvalidates(s).some(
      (e) => e.resource === "dispatch" && e.userIds.includes("r2"),
    ),
  );
  assert.equal(
    s.notifications.some((n) => n.userId === "r2"),
    false,
  );
});
for (const replacement of ["new", null])
  test(`decline ${replacement ? "replacement" : "unmatched"} alerts ops and client, revokes old shop`, () => {
    const before = fixture(),
      s = structuredClone(before);
    s.orders[0].supplierId = replacement;
    s.orders[0].state = replacement
      ? "supplier_assigned"
      : "approved_for_matching";
    deriveDomainEvents(s, before, options);
    assert.ok(
      s.notifications.some(
        (n) => n.userId === "ops" && n.type === "ops_assignment_changed",
      ),
    );
    assert.ok(s.notifications.some((n) => n.userId === "c"));
    assert.ok(
      takeQueuedInvalidates(s).some(
        (e) => e.resource === "jobs" && e.userIds?.includes("s"),
      ),
    );
    assert.equal(
      s.notifications.some((n) => n.userId === "s"),
      false,
    );
  });
test("payment confirmation and later hold release notify only involved roles", () => {
  const before = fixture(),
    s = structuredClone(before);
  before.orders[0].payoutHold = true;
  s.orders[0].payoutHold = false;
  s.orders[0].payments.initial.status = "confirmed";
  deriveDomainEvents(s, before, options);
  assert.ok(
    s.notifications.some(
      (n) => n.userId === "c" && n.type === "order_payment_confirmed",
    ),
  );
  assert.ok(
    s.notifications.some(
      (n) => n.userId === "s" && n.type === "shop_payout_hold_released",
    ),
  );
  assert.equal(
    s.notifications.some((n) => n.userId === "r2"),
    false,
  );
});
test("read mutation invalidates only owner; catalog hints carry no private listing id", () => {
  const before = fixture();
  before.notifications = [{ id: "x", userId: "c", read: false }];
  const s = structuredClone(before);
  s.notifications[0].read = true;
  s.catalogItems = [{ id: "private-listing", supplierId: "s", state: "draft" }];
  deriveDomainEvents(s, before, options);
  const events = takeQueuedInvalidates(s);
  assert.deepEqual(events.find((e) => e.resource === "notifications").userIds, [
    "c",
  ]);
  assert.equal(
    events
      .filter((e) => e.resource === "catalog")
      .some((e) => e.id === "private-listing"),
    false,
  );
});
test("existing application and pickup resolution effects are not duplicated", () => {
  const before = fixture();
  before.approvalCases = [
    { id: "a", userId: "s", kind: "supplier", status: "pending" },
  ];
  const s = structuredClone(before);
  s.approvalCases[0].status = "approved";
  s.notifications.push({
    id: "existing",
    userId: "s",
    type: "approval_approved",
    approvalCaseId: "a",
  });
  deriveDomainEvents(s, before, options);
  assert.equal(
    s.notifications.filter((n) => n.userId === "s" && n.approvalCaseId === "a")
      .length,
    1,
  );
});
test("actor milestones and routine admin copies stay in inbox without a second banner", () => {
  const before = fixture(),
    s = structuredClone(before);
  s.orders[0].state = "production";
  s.orders[0].timeline = [{ at: options.at, by: "s" }];
  deriveDomainEvents(s, before, options);
  assert.equal(s.notifications.find((n) => n.userId === "s").push, false);
});
test("suspension alerts Ops for known active assigned work", () => {
  const before = fixture();
  before.approvalCases[0].id = "supplier-case";
  const s = structuredClone(before);
  s.approvalCases[0].status = "suspended";
  deriveDomainEvents(s, before, options);
  assert.ok(
    s.notifications.some(
      (n) =>
        n.userId === "ops" &&
        n.type === "ops_active_work_suspended" &&
        n.orderId === "o",
    ),
  );
});
test("final payment clears actual assigned delivery gate once", () => {
  const before = fixture();
  Object.assign(before.orders[0], {
    state: "out_for_delivery",
    riderId: "r1",
    fulfillmentMode: "delivery",
  });
  before.orders[0].payments.final_online = { status: "pending_confirmation" };
  const s = structuredClone(before);
  s.orders[0].payments.final_online.status = "confirmed";
  deriveDomainEvents(s, before, options);
  assert.equal(
    s.notifications.filter(
      (n) => n.userId === "r1" && n.type === "rider_delivery_payment_cleared",
    ).length,
    1,
  );
  const current = structuredClone(s);
  deriveDomainEvents(s, current, options);
  assert.equal(
    s.notifications.filter(
      (n) => n.userId === "r1" && n.type === "rider_delivery_payment_cleared",
    ).length,
    1,
  );
});
