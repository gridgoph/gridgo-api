import test from "node:test";
import assert from "node:assert/strict";

import {
  backfillOrderInboxNotifications,
  clientNotificationDraft,
  ensureClientOrderNotification,
  notifyClientPaymentRejected,
  notifyOpsIssueReported,
  notifyOpsJobNeedsQa,
  notifyOpsPaymentSubmitted,
  notifyOpsSignupSubmitted,
  notifyOrderParties,
  notifyShopPayoutHeld,
  riderNotificationDrafts,
  shopNotificationDraft,
  writeDraft,
} from "../src/client-order-notifications.js";

test("client-initiated states do not invent an inbox row", () => {
  assert.equal(clientNotificationDraft({ id: "ord_1", clientId: "user_c", state: "initial_payment_review" }), null);
  assert.equal(clientNotificationDraft({ id: "ord_1", clientId: "user_c", state: "submitted" }), null);
  assert.equal(clientNotificationDraft({ id: "ord_1", clientId: "user_c", state: "draft" }), null);
});

test("artwork check, correction, and out-for-delivery are the updates the empty state promised", () => {
  assert.equal(clientNotificationDraft({ id: "ord_1", clientId: "user_c", state: "needs_qa" }).type, "order_needs_qa");
  assert.equal(
    clientNotificationDraft({ id: "ord_1", clientId: "user_c", state: "client_correction" }).type,
    "order_client_correction",
  );
  const out = clientNotificationDraft({ id: "ord_1", clientId: "user_c", state: "out_for_delivery" });
  assert.equal(out.type, "order_out_for_delivery");
  assert.match(out.title, /out for delivery/i);
});

test("a collected job never tells the client it is out for delivery", () => {
  const out = clientNotificationDraft({
    id: "ord_1",
    clientId: "user_c",
    state: "out_for_delivery",
    fulfillmentMode: "pickup",
  });
  assert.equal(out.type, "order_out_for_delivery");
  assert.match(out.title, /GRIDGO Office/i);
  assert.doesNotMatch(out.title, /out for delivery/i);
  assert.doesNotMatch(out.body, /on the way(?! to)/i);

  const ready = clientNotificationDraft({
    id: "ord_1",
    clientId: "user_c",
    state: "awaiting_collection",
    fulfillmentMode: "pickup",
    payments: { final_online: { status: "confirmed" } },
  });
  assert.equal(ready.type, "order_ready_for_pickup");
  assert.match(ready.title, /counter/i);
  assert.doesNotMatch(ready.title, /settle/i);

  const hold = clientNotificationDraft({
    id: "ord_1",
    clientId: "user_c",
    state: "awaiting_collection",
    fulfillmentMode: "pickup",
    payments: { final_online: { status: "not_submitted" } },
  });
  assert.match(hold.title, /settle/i);
  assert.match(hold.body, /remaining balance/i);
});

test("ensure writes once per order and type", () => {
  const store = { notifications: [] };
  const order = { id: "ord_1", clientId: "user_c", state: "production", updatedAt: "2026-09-01T00:00:00.000Z" };
  const first = ensureClientOrderNotification(store, order, { id: "ntf_1", at: order.updatedAt });
  const second = ensureClientOrderNotification(store, order, { id: "ntf_2", at: order.updatedAt });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.notification.id, "ntf_1");
  assert.equal(store.notifications.length, 1);
});

test("backfill covers every client-facing job and skips the rest", () => {
  const store = {
    users: [{ id: "user_r", role: "rider", verificationStatus: "approved" }],
    orders: [
      { id: "ord_pay", clientId: "user_c", supplierId: "user_s", state: "initial_payment_review", updatedAt: "2026-09-01T00:00:00.000Z" },
      { id: "ord_qa", clientId: "user_c", supplierId: "user_s", state: "needs_qa", updatedAt: "2026-09-01T01:00:00.000Z" },
      { id: "ord_out", clientId: "user_c", supplierId: "user_s", riderId: "user_r", state: "out_for_delivery", updatedAt: "2026-09-01T02:00:00.000Z" },
    ],
    notifications: [],
  };
  let n = 0;
  const created = backfillOrderInboxNotifications(store, () => `ntf_${++n}`);
  assert.deepEqual(
    created.map((row) => `${row.userId}:${row.type}`).sort(),
    [
      "user_c:order_needs_qa",
      "user_c:order_out_for_delivery",
      "user_r:order_out_for_delivery",
      "user_s:shop_job_out_for_delivery",
    ],
  );
  const again = backfillOrderInboxNotifications(store, () => `ntf_${++n}`);
  assert.equal(again.length, 0);
});

test("the shop is told about work on its board, not about artwork QA", () => {
  assert.equal(
    shopNotificationDraft({ id: "ord_1", supplierId: "user_s", state: "needs_qa" }),
    null,
  );
  const qc = shopNotificationDraft({ id: "ord_1", supplierId: "user_s", state: "supplier_self_qc" });
  assert.equal(qc.type, "shop_job_self_qc");
  assert.equal(qc.userId, "user_s");
});

test("assignment writes one shop row and a retry of the same type does not duplicate", () => {
  const store = { notifications: [] };
  const order = { id: "ord_1", supplierId: "user_s", state: "supplier_assigned" };
  assert.equal(shopNotificationDraft(order).type, "shop_job_assigned");
  let n = 0;
  const first = notifyOrderParties(store, order, { createId: () => `ntf_${++n}`, at: "2026-09-01T00:00:00.000Z" });
  assert.deepEqual(first.created.map((row) => row.type), ["shop_job_assigned"]);
  const second = notifyOrderParties(store, order, { createId: () => `ntf_${++n}`, at: "2026-09-01T00:00:00.000Z" });
  assert.equal(second.created.length, 0);
  assert.equal(store.notifications.length, 1);
  const again = writeDraft(store, shopNotificationDraft(order), { id: "ntf_dup", at: "2026-09-01T00:00:00.000Z" });
  assert.equal(again.created, false);
  assert.equal(again.notification.id, first.created[0].id);
});

test("payment_authorized tells an assigned shop it may start", () => {
  const draft = shopNotificationDraft({ id: "ord_1", supplierId: "user_s", state: "payment_authorized" });
  assert.equal(draft.type, "shop_job_may_start");
});

test("cancelled tells the client, assigned shop, and assigned rider", () => {
  assert.equal(
    clientNotificationDraft({ id: "ord_1", clientId: "user_c", state: "cancelled" }).type,
    "order_cancelled",
  );
  assert.equal(
    shopNotificationDraft({ id: "ord_1", supplierId: "user_s", state: "cancelled" }).type,
    "shop_job_cancelled",
  );
  const riders = riderNotificationDrafts({}, {
    id: "ord_1",
    riderId: "user_r",
    state: "cancelled",
  });
  assert.equal(riders.length, 1);
  assert.equal(riders[0].type, "order_cancelled");
  assert.equal(shopNotificationDraft({ id: "ord_1", state: "cancelled" }), null);
  assert.deepEqual(riderNotificationDrafts({}, { id: "ord_1", state: "cancelled" }), []);
});

test("QR submit writes one ops row per ops/admin membership and none for client or shop", () => {
  const store = {
    userRoleMemberships: [
      { userId: "user_ops", role: "ops_admin" },
      { userId: "user_admin", role: "super_admin" },
      { userId: "user_admin", role: "ops_admin" },
      { userId: "user_c", role: "client" },
      { userId: "user_s", role: "supplier" },
    ],
    notifications: [],
  };
  const order = { id: "ord_1", clientId: "user_c", supplierId: "user_s" };
  let n = 0;
  const created = notifyOpsPaymentSubmitted(store, order, {
    createId: () => `ntf_${++n}`,
    at: "2026-09-01T00:00:00.000Z",
  });
  assert.deepEqual(
    created.map((row) => `${row.userId}:${row.type}`).sort(),
    ["user_admin:ops_payment_submitted", "user_ops:ops_payment_submitted"],
  );
  const again = notifyOpsPaymentSubmitted(store, order, {
    createId: () => `ntf_${++n}`,
    at: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(again.length, 0);
  assert.equal(store.notifications.some((row) => row.userId === "user_c" || row.userId === "user_s"), false);
});

test("checkout / enter needs_qa writes ops needs-QA rows once", () => {
  const store = {
    userRoleMemberships: [{ userId: "user_ops", role: "ops_admin" }],
    notifications: [],
  };
  const order = { id: "ord_1" };
  let n = 0;
  const first = notifyOpsJobNeedsQa(store, order, { createId: () => `ntf_${++n}`, at: "2026-09-01T00:00:00.000Z" });
  assert.equal(first[0].type, "ops_job_needs_qa");
  const second = notifyOpsJobNeedsQa(store, order, { createId: () => `ntf_${++n}`, at: "2026-09-01T00:00:00.000Z" });
  assert.equal(second.length, 0);
});

test("a client issue writes shop hold + ops rows without inventing a second hold", () => {
  const store = {
    userRoleMemberships: [{ userId: "user_ops", role: "ops_admin" }],
    notifications: [],
  };
  const order = { id: "ord_1", supplierId: "user_s", payoutHold: true };
  let n = 0;
  const shop = notifyShopPayoutHeld(store, order, { createId: () => `ntf_${++n}`, at: "2026-09-01T00:00:00.000Z" });
  const ops = notifyOpsIssueReported(store, order, { createId: () => `ntf_${++n}`, at: "2026-09-01T00:00:00.000Z" });
  assert.equal(shop[0].type, "shop_payout_held");
  assert.equal(ops[0].type, "ops_issue_reported");
  assert.equal(order.payoutHold, true);
  assert.equal(
    notifyShopPayoutHeld(store, order, { createId: () => `ntf_${++n}`, at: "2026-09-01T00:00:00.000Z" }).length,
    0,
  );
});

test("signup submit writes ops rows; an approval decision still notifies only the applicant", () => {
  const store = {
    userRoleMemberships: [
      { userId: "user_ops", role: "ops_admin" },
      { userId: "user_admin", role: "super_admin" },
    ],
    notifications: [],
  };
  let n = 0;
  const created = notifyOpsSignupSubmitted(
    store,
    { id: "case_1", kind: "supplier" },
    { createId: () => `ntf_${++n}`, at: "2026-09-01T00:00:00.000Z" },
  );
  assert.deepEqual(
    created.map((row) => row.userId).sort(),
    ["user_admin", "user_ops"],
  );
  assert.equal(created[0].type, "ops_signup_submitted");
  const again = notifyOpsSignupSubmitted(
    store,
    { id: "case_1", kind: "supplier" },
    { createId: () => `ntf_${++n}`, at: "2026-09-01T00:00:00.000Z" },
  );
  assert.equal(again.length, 0);
});

test("a rejected payment tells the client to resubmit, once", () => {
  const store = { notifications: [] };
  const order = { id: "ord_1", clientId: "user_c" };
  let n = 0;
  const first = notifyClientPaymentRejected(store, order, {
    createId: () => `ntf_${++n}`,
    at: "2026-09-01T00:00:00.000Z",
    reason: "The reference does not match.",
  });
  assert.equal(first[0].type, "order_payment_rejected");
  assert.equal(first[0].userId, "user_c");
  assert.equal(
    notifyClientPaymentRejected(store, order, {
      createId: () => `ntf_${++n}`,
      at: "2026-09-01T00:00:00.000Z",
      reason: "Still wrong.",
    }).length,
    0,
  );
});

test("an unassigned packed job is offered to approved riders", () => {
  const store = {
    users: [
      { id: "user_r", role: "rider", verificationStatus: "approved" },
      { id: "user_pending", role: "rider", verificationStatus: "pending" },
    ],
  };
  const drafts = riderNotificationDrafts(store, {
    id: "ord_1",
    state: "ready_for_dispatch",
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].userId, "user_r");
  assert.equal(drafts[0].type, "dispatch_available");
});

test("notifyOrderParties writes client, shop, and rider once", () => {
  const store = {
    users: [{ id: "user_r", role: "rider", verificationStatus: "approved" }],
    notifications: [],
  };
  let n = 0;
  const order = {
    id: "ord_1",
    clientId: "user_c",
    supplierId: "user_s",
    riderId: "user_r",
    state: "out_for_delivery",
  };
  const first = notifyOrderParties(store, order, { createId: () => `ntf_${++n}`, at: "2026-09-01T00:00:00.000Z" });
  assert.equal(first.created.length, 3);
  const second = notifyOrderParties(store, order, { createId: () => `ntf_${++n}`, at: "2026-09-01T00:00:00.000Z" });
  assert.equal(second.created.length, 0);
});
