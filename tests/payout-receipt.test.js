import test from "node:test";
import assert from "node:assert/strict";

import {
  bindPayoutReceipt,
  paymentReferenceValue,
  resolvePayoutReceipt,
} from "../src/payout-receipt.js";
import { authorizeFileRead, authorizeFileUpload, markFileDeletePending, resolveFileTarget } from "../src/attachments.js";
import { publicOrderFor } from "../src/operational-model.js";
import { resolveAuthorizationContext, selectActorRole } from "../src/authorization-context.js";

const AT = "2026-09-15T00:00:00.000Z";

function receipt(fileId, overrides = {}) {
  return {
    fileId,
    ownerId: "ops",
    purpose: "payout_receipt",
    originalFilename: `${fileId}.png`,
    declaredContentType: "image/png",
    detectedContentType: "image/png",
    size: 10,
    state: "ready",
    objectKey: `payout-receipt/${fileId}.png`,
    references: [],
    createdAt: AT,
    readyAt: AT,
    ...overrides,
  };
}

function fixture() {
  return {
    users: [
      { id: "ops", role: "ops_admin" },
      { id: "other_ops", role: "ops_admin" },
      { id: "supplier", role: "supplier" },
      { id: "other_supplier", role: "supplier" },
      { id: "client", role: "client" },
    ],
    userRoleMemberships: [
      { userId: "ops", role: "ops_admin" },
      { userId: "other_ops", role: "ops_admin" },
      { userId: "supplier", role: "supplier" },
      { userId: "other_supplier", role: "supplier" },
      { userId: "client", role: "client" },
    ],
    approvalCases: [
      { id: "case_supplier", userId: "supplier", kind: "supplier", status: "approved" },
      { id: "case_other", userId: "other_supplier", kind: "supplier", status: "approved" },
    ],
    files: [receipt("rcpt_one"), receipt("rcpt_theirs", { ownerId: "other_ops" })],
    orders: [{
      id: "ord_1", clientId: "client", supplierId: "supplier", state: "supplier_self_qc", timeline: [],
      payoutMilestones: [{ code: "printing", sharePercent: 50, amountMinor: 50000, status: "released", pofFileIds: ["pof"], releasedAt: AT, releasedBy: "ops" }],
    }],
    orderJobs: [{ id: "job_1", orderId: "ord_1", supplierId: "supplier" }],
    shopReviews: [],
  };
}

function actor(store, id) {
  const user = store.users.find((candidate) => candidate.id === id);
  return selectActorRole(store, { ...user, context: resolveAuthorizationContext(store, user) }, user.role);
}

function rejects(fn, status, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.status, status, `${error.code}: ${error.message}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("a reference is trimmed, optional, and bounded", () => {
  assert.equal(paymentReferenceValue(undefined), null);
  assert.equal(paymentReferenceValue("   "), null);
  assert.equal(paymentReferenceValue("  GCASH-123 "), "GCASH-123");
  rejects(() => paymentReferenceValue(123), 400, "invalid_payout_reference");
  rejects(() => paymentReferenceValue("x".repeat(81)), 400, "invalid_payout_reference");
});

test("only Operations may upload a receipt, and it is never attached through the file route", () => {
  const store = fixture();
  assert.doesNotThrow(() => authorizeFileUpload(actor(store, "ops"), "payout_receipt"));
  rejects(() => authorizeFileUpload(actor(store, "supplier"), "payout_receipt"), 403, "forbidden");
  rejects(() => authorizeFileUpload(actor(store, "client"), "payout_receipt"), 403, "forbidden");
  rejects(() => resolveFileTarget(store, "payout_receipt", { orderId: "ord_1" }, actor(store, "ops")), 400, "payout_receipt_not_attachable");
});

test("a receipt must be the caller's own ready upload that nothing else claimed", () => {
  const store = fixture();
  const ops = actor(store, "ops");
  assert.equal(resolvePayoutReceipt(store, undefined, ops), null);
  assert.equal(resolvePayoutReceipt(store, null, ops), null);
  rejects(() => resolvePayoutReceipt(store, "   ", ops), 400, "invalid_payout_receipt");
  rejects(() => resolvePayoutReceipt(store, "missing", ops), 400, "invalid_payout_receipt");
  rejects(() => resolvePayoutReceipt(store, "rcpt_theirs", ops), 400, "invalid_payout_receipt");
  store.files.push(receipt("qr", { purpose: "supplier_payout_qr", ownerId: "ops" }));
  rejects(() => resolvePayoutReceipt(store, "qr", ops), 400, "invalid_payout_receipt");
  store.files[0].references = [{ type: "order", id: "ord_0", field: "payoutReceiptFileIds" }];
  rejects(() => resolvePayoutReceipt(store, "rcpt_one", ops), 409, "file_already_attached");
});

test("binding puts the receipt on the share and the order, and the right people can read it", () => {
  const store = fixture();
  const order = store.orders[0];
  const milestone = order.payoutMilestones[0];
  const file = resolvePayoutReceipt(store, "rcpt_one", actor(store, "ops"));
  bindPayoutReceipt(order, milestone, file);
  assert.equal(milestone.receiptFileId, "rcpt_one");
  assert.deepEqual(order.payoutReceiptFileIds, ["rcpt_one"]);
  assert.deepEqual(file.references, [{ type: "order", id: "ord_1", field: "payoutReceiptFileIds", milestoneCode: "printing" }]);
  milestone.reference = "GCASH-123";

  assert.doesNotThrow(() => authorizeFileRead(actor(store, "ops"), store, file));
  assert.doesNotThrow(() => authorizeFileRead(actor(store, "supplier"), store, file));
  assert.throws(() => authorizeFileRead(actor(store, "other_supplier"), store, file), (error) => error.status === 403);
  assert.throws(() => authorizeFileRead(actor(store, "client"), store, file), (error) => error.status === 403);
  assert.throws(() => markFileDeletePending(file, actor(store, "ops"), AT), (error) => error.code === "file_in_use");

  const forOps = publicOrderFor(order, actor(store, "ops"), store);
  assert.equal(forOps.payoutMilestones[0].receiptFileId, "rcpt_one");
  assert.equal(forOps.payoutMilestones[0].reference, "GCASH-123");
  const forShop = publicOrderFor(order, actor(store, "supplier"), store);
  assert.equal(forShop.payoutMilestones[0].receiptFileId, "rcpt_one");
  assert.equal(forShop.payoutMilestones[0].reference, "GCASH-123");
  const forClient = publicOrderFor(order, actor(store, "client"), store);
  assert.equal("receiptFileId" in forClient.payoutMilestones[0], false);
  assert.equal("reference" in forClient.payoutMilestones[0], false);
  assert.equal("payoutReceiptFileIds" in forClient, false);
});
