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

test("same-state payment decisions reach both privileged inboxes once", () => {
  for (const status of ["confirmed", "not_submitted"]) {
    const before = fixture();
    Object.assign(before.orders[0], {
      state: "out_for_delivery", riderId: "r1", fulfillmentMode: "delivery",
      payments: { final_online: { status: "pending_confirmation" } },
      timeline: [{ state: "out_for_delivery", at: "earlier" }],
    });
    const s = structuredClone(before);
    Object.assign(s.orders[0].payments.final_online, {
      status, ...(status === "confirmed" ? { confirmedAt: options.at } : { rejectedAt: options.at }),
    });
    s.orders[0].timeline.push({ state: "out_for_delivery", at: options.at });
    deriveDomainEvents(s, before, options);
    const type = status === "confirmed" ? "ops_payment_confirmed" : "ops_payment_rejected";
    assert.deepEqual(s.notifications.filter((n) => n.type === type).map((n) => `${n.userId}:${n.appRole}`).sort(), ["ops:ops_admin", "super:super_admin"]);
    assert.equal(s.notifications.some((n) => ["ops_order_progress", "order_out_for_delivery", "shop_job_out_for_delivery"].includes(n.type)), false);
    const count = s.notifications.length;
    deriveDomainEvents(s, before, options);
    deriveDomainEvents(s, structuredClone(s), options);
    assert.equal(s.notifications.length, count);
  }
});

for (const [name, type, setup, change] of [
  ["credit adjustments", "ops_credit_updated", (s) => { s.credits = { c: { balanceMinor: 0 } }; }, (s) => { s.credits.c.balanceMinor = 100; }],
  ["claim release", "ops_claim_changed", (s) => { s.claims = [{ id: "claim", orderId: "o", status: "payout_held" }]; }, (s) => { s.claims[0].status = "released"; }],
  ["claim hold reason", "ops_claim_changed", (s) => { s.claims = [{ id: "claim", orderId: "o", status: "payout_held", holdReason: "first" }]; }, (s) => { s.claims[0].holdReason = "second"; }],
  ["issue resolution", "ops_issue_changed", (s) => { s.issues = [{ id: "issue", orderId: "o", status: "open" }]; }, (s) => { s.issues[0].status = "resolved"; }],
  ["pickup resolution", "pickup_escalation_changed", (s) => { s.escalations = [{ id: "esc", orderId: "o", riderId: "r1", status: "open" }]; }, (s) => { s.escalations[0].status = "resolved"; }],
  ["payout release", "ops_payout_released", (s) => { s.orders[0].payoutMilestones = [{ code: "printing", status: "pof_attached" }]; }, (s) => { s.orders[0].payoutMilestones[0].status = "released"; }],
  ["approval decision", "ops_approval_decision", () => {}, (s) => { s.approvalCases[0].status = "suspended"; }],
  ["service decision", "ops_service_decision", (s) => { s.supplierServices = [{ id: "svc", supplierId: "s", state: "pending_verification" }]; }, (s) => { s.supplierServices[0].state = "live"; }],
  ["role change", "ops_role_changed", () => {}, (s) => { s.userRoleMemberships.push({ userId: "c", role: "supplier" }); }],
  ["job assignment", "ops_assignment_changed", (s) => { s.orderJobs = []; }, (s) => { s.orderJobs.push({ id: "job", orderId: "o", supplierId: "s", state: "supplier_assigned" }); }],
]) {
  test(`${name} writes a durable row to every privileged membership`, () => {
    const before = fixture();
    setup(before);
    const s = structuredClone(before);
    change(s);
    s.auditLog = [{ actorId: "ops" }];
    deriveDomainEvents(s, before, options);
    const rows = s.notifications.filter((n) => n.type === type && ["ops_admin", "super_admin"].includes(n.appRole));
    assert.deepEqual(rows.map((n) => `${n.userId}:${n.appRole}`).sort(), ["ops:ops_admin", "super:super_admin"]);
    assert.equal(rows.find((n) => n.userId === "ops").push, false);
    const count = s.notifications.length;
    deriveDomainEvents(s, structuredClone(s), options);
    assert.equal(s.notifications.length, count);
  });
}

test("distinct credit and payout events in one transaction keep their own inbox rows", () => {
  const before = fixture();
  before.credits = { c: { balanceMinor: 0 }, new: { balanceMinor: 0 } };
  before.orders[0].payoutMilestones = ["printing", "retention"].map((code) => ({ code, status: "pof_attached" }));
  const s = structuredClone(before);
  for (const credit of Object.values(s.credits)) credit.balanceMinor = 100;
  for (const milestone of s.orders[0].payoutMilestones) milestone.status = "released";
  deriveDomainEvents(s, before, options);
  for (const type of ["ops_credit_updated", "ops_payout_released"]) {
    for (const userId of ["ops", "super"]) {
      const rows = s.notifications.filter((n) => n.type === type && n.userId === userId);
      assert.equal(rows.length, 2);
      assert.equal(new Set(rows.map((n) => n.occurrenceKey)).size, 2);
    }
  }
});

test("hold release follows the aggregate across claims and the order flag", () => {
  for (const orderFlag of [true, false]) {
    const before = fixture();
    before.orders[0].payoutHold = orderFlag;
    before.claims = ["first", "second"].map((id) => ({ id, orderId: "o", status: "payout_held" }));
    const s = structuredClone(before);
    s.claims[0].status = "released";
    deriveDomainEvents(s, before, options);
    assert.equal(s.notifications.some((n) => n.type === "shop_payout_hold_released"), false);
    const partial = structuredClone(s);
    s.claims[1].status = "released";
    s.orders[0].payoutHold = false;
    deriveDomainEvents(s, partial, options);
    assert.equal(s.notifications.filter((n) => n.type === "shop_payout_hold_released").length, 1);
    deriveDomainEvents(s, partial, options);
    assert.equal(s.notifications.filter((n) => n.type === "shop_payout_hold_released").length, 1);
  }
});

test("a remaining order hold prevents a claim release notice", () => {
  const before = fixture();
  before.orders[0].payoutHold = true;
  before.claims = [{ id: "claim", orderId: "o", status: "payout_held" }];
  const s = structuredClone(before);
  s.claims[0].status = "released";
  deriveDomainEvents(s, before, options);
  assert.equal(s.notifications.some((n) => n.type === "shop_payout_hold_released"), false);
});

test("derived supplier assignment writes one lifecycle row per recipient", () => {
  const before = fixture();
  before.orders[0].supplierId = null;
  before.orders[0].state = "approved_for_matching";
  const s = structuredClone(before);
  s.orders[0].supplierId = "s";
  s.orders[0].state = "supplier_assigned";
  s.orders[0].timeline = [{ state: "supplier_assigned", at: options.at }];
  deriveDomainEvents(s, before, options);
  assert.equal(s.notifications.filter((n) => n.userId === "s" && n.type === "shop_job_assigned").length, 1);
});

test("unsubmitted rider cases stay silent until the explicit submission writer runs", async () => {
  const { notifyOpsSignupSubmitted } = await import("../src/client-order-notifications.js");
  const before = fixture();
  before.approvalCases = [];
  const s = structuredClone(before);
  s.approvalCases.push({
    id: "rider-intake", userId: "r1", kind: "rider", status: "pending",
    version: 1, applicationRevision: 1,
  });
  deriveDomainEvents(s, before, options);
  assert.deepEqual(s.notifications, []);
  const intake = structuredClone(s);
  s.approvalCases[0].submittedAt = options.at;
  notifyOpsSignupSubmitted(s, s.approvalCases[0], options);
  deriveDomainEvents(s, intake, options);
  assert.deepEqual(
    s.notifications.map((n) => `${n.userId}:${n.appRole}:${n.type}`).sort(),
    ["ops:ops_admin:ops_signup_submitted", "super:super_admin:ops_signup_submitted"],
  );
  const submitted = structuredClone(s);
  s.approvalCases[0].status = "approved";
  s.approvalCases[0].version += 1;
  deriveDomainEvents(s, submitted, options);
  assert.deepEqual(
    s.notifications.filter((n) => n.type === "ops_approval_decision").map((n) => `${n.userId}:${n.appRole}`).sort(),
    ["ops:ops_admin", "super:super_admin"],
  );
});

test("pending application revisions do not derive submission alerts", () => {
  const before = fixture();
  before.approvalCases = [{ id: "case", userId: "r1", kind: "rider", status: "pending", applicationRevision: 1 }];
  const s = structuredClone(before);
  s.approvalCases[0].applicationRevision = 2;
  deriveDomainEvents(s, before, options);
  assert.deepEqual(s.notifications, []);
});

test("quote revisions share a new lifecycle occurrence across client and privileged inboxes", async () => {
  const { notifyOrderParties, notifyOpsOrderProgress } = await import("../src/client-order-notifications.js");
  const before = fixture();
  Object.assign(before.orders[0], {
    state: "awaiting_checkout", pendingQuote: { version: 1 },
    timeline: [{ state: "supplier_accepted", at: "t1" }, { state: "awaiting_checkout", at: "t1" }],
  });
  notifyOrderParties(before, before.orders[0], options);
  notifyOpsOrderProgress(before, before.orders[0], options);
  const s = structuredClone(before);
  const order = s.orders[0];
  order.pendingQuote.version = 2;
  order.updatedAt = "t2";
  order.timeline.push({ state: "supplier_accepted", at: "t2" }, { state: "awaiting_checkout", at: "t2" });
  notifyOrderParties(s, order, options);
  deriveDomainEvents(s, before, options);
  const clientRows = s.notifications.filter((n) => n.type === "supplier_assignment_final_price");
  assert.equal(clientRows.length, 2);
  for (const [userId, appRole] of [["ops", "ops_admin"], ["super", "super_admin"]]) {
    const rows = s.notifications.filter((n) => n.type === "ops_order_progress" && n.userId === userId && n.appRole === appRole);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].occurrenceKey, clientRows[1].occurrenceKey);
    assert.notEqual(rows[0].occurrenceKey, rows[1].occurrenceKey);
  }
  const count = s.notifications.length;
  deriveDomainEvents(s, before, options);
  const revised = structuredClone(s);
  order.updatedAt = "t3";
  order.timeline.push({ state: "awaiting_checkout", at: "t3", note: "Unrelated update" });
  deriveDomainEvents(s, revised, options);
  assert.equal(s.notifications.length, count);
});

test("legacy timeline mismatches do not turn same-state edits into lifecycle events", () => {
  const before = fixture();
  before.orders[0].state = "awaiting_checkout";
  before.orders[0].timeline = [{ state: "supplier_accepted", at: "t1" }];
  const s = structuredClone(before);
  s.orders[0].updatedAt = "t2";
  deriveDomainEvents(s, before, options);
  assert.deepEqual(s.notifications, []);
});
