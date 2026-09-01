import test from "node:test";
import assert from "node:assert/strict";

import {
  backfillOrderInboxNotifications,
  clientNotificationDraft,
  ensureClientOrderNotification,
  notifyOrderParties,
  riderNotificationDrafts,
  shopNotificationDraft,
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
