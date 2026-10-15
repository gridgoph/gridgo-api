import test from "node:test";
import assert from "node:assert/strict";

import {
  artworkDownloadAudits,
  orderArtworkFileIds,
  qaClientActionAudit,
  qaRequestFileAudit,
  qaTickAudit,
} from "../src/qa-review.js";

function audit(store, entry) {
  store.auditLog.push({ ...entry, id: `aud_${store.auditLog.length}` });
}

test("artwork downloads, ticks and the three problem actions are audit entries", () => {
  const store = { auditLog: [] };
  const order = { id: "ord_1" };
  const actor = { id: "ops", role: "ops_admin" };
  const write = (entry) => audit(store, {
    actor, action: entry.action, entityType: "order", entityId: order.id, orderId: order.id,
    detail: entry.detail || null, reason: entry.reason || null,
  });

  for (const entry of artworkDownloadAudits({ fileIds: ["file_a"], all: false })) write(entry);
  for (const entry of artworkDownloadAudits({ fileIds: ["file_a", "file_b"], all: true })) write(entry);
  write(qaTickAudit("artwork", true));
  write(qaRequestFileAudit("Export with bleed."));
  write(qaClientActionAudit("message", { note: "The cyan looks blocked.", threadId: "thread_1" }));
  write(qaClientActionAudit("hold", { note: "Waiting on a new file.", threadId: "thread_1" }));

  const actions = store.auditLog.map((row) => row.action);
  assert.deepEqual(actions, [
    "order.artwork_download",
    "order.artwork_download_all",
    "order.artwork_download",
    "order.artwork_download",
    "order.qa_tick",
    "order.qa_request_file",
    "order.qa_message",
    "order.qa_hold",
  ]);
  assert.deepEqual(store.auditLog[0].detail, { fileId: "file_a" });
  assert.deepEqual(store.auditLog[1].detail, { fileIds: ["file_a", "file_b"] });
  assert.equal(store.auditLog[2].detail.via, "all");
  assert.deepEqual(store.auditLog[4].detail, { checkId: "artwork", checked: true });
  assert.equal(store.auditLog[6].detail.threadId, "thread_1");
  assert.equal(store.auditLog[7].reason, "Waiting on a new file.");
});

test("a tick that is not one of the four checks is refused", () => {
  assert.throws(() => qaTickAudit("bleed", true), { code: "invalid_qa_check" });
  assert.throws(() => qaTickAudit("artwork", "yes"), { code: "invalid_qa_check" });
});

test("a hold tells the client in the same words the audit keeps", () => {
  const entry = qaClientActionAudit("hold", { note: "  The pin is outside the area.  ", threadId: null });
  assert.equal(entry.clientText, "This order is on hold. The pin is outside the area.");
  assert.equal(entry.reason, "The pin is outside the area.");
  assert.throws(() => qaClientActionAudit("message", { note: "  " }), { code: "invalid_qa_note" });
});

test("line artwork is included when the order row has not copied it yet", () => {
  const ids = orderArtworkFileIds(
    { orderLineItems: [{ orderId: "ord_1", artworkFileId: "file_line" }, { orderId: "other", artworkFileId: "no" }] },
    { id: "ord_1", artworkFileIds: ["file_row", "file_line"] },
  );
  assert.deepEqual(ids, ["file_row", "file_line"]);
});
