import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/database.js";
import { loadStore, saveStore } from "../src/postgres-store.js";
import { fixture, AT } from "./fixtures/reschedule.js";
import { apiForTest } from "./fixtures/reschedule-http.js";
import { pushMessageFor } from "../src/push.js";
import { createFileRetention } from "../src/file-retention.js";
import {
  pickupChatParty,
  pickupChatWindow,
  purgeClosedPickupChats,
} from "../src/pickup-chat.js";

import { parseDeliveryMessage, parseDeliveryPhotoIds } from "../src/delivery-chat.js";

const DATABASE_URL = process.env.DATABASE_URL;
const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test("window: open while the rider has the job, readable one day after delivery, then closed", () => {
  const at = "2026-10-07T12:00:00.000Z";
  const base = { riderId: "rider", fulfillmentMode: "delivery" };
  for (const state of ["rider_assigned", "picked_up", "out_for_delivery"]) {
    assert.deepEqual(pickupChatWindow({ ...base, state }, at), { status: "open", closesAt: null });
  }
  assert.equal(pickupChatWindow({ ...base, state: "ready_for_dispatch", riderId: null }, at).status, "closed");
  const delivered = { ...base, state: "issue_window_open", deliveryEvidence: { recordedAt: "2026-10-07T02:00:00.000Z" } };
  assert.deepEqual(pickupChatWindow(delivered, at), { status: "read_only", closesAt: "2026-10-08T02:00:00.000Z" });
  assert.equal(pickupChatWindow(delivered, "2026-10-08T02:00:00.000Z").status, "closed");
  // Completed or under a claim still counts from the delivery, not the state.
  assert.equal(pickupChatWindow({ ...delivered, state: "completed" }, at).status, "read_only");
  // An older delivery without evidence falls back to the issue window opening.
  assert.equal(pickupChatWindow({ ...base, state: "issue_window_open", issueWindowOpenedAt: "2026-10-07T02:00:00.000Z" }, at).status, "read_only");
  // The rider collects from the shop on an Office job too.
  assert.equal(pickupChatWindow({ ...base, fulfillmentMode: "pickup", state: "out_for_delivery" }, at).status, "open");
  // Cancelled before delivery: nothing to keep.
  assert.equal(pickupChatWindow({ ...base, state: "ready_for_dispatch" }, at).status, "closed");
});

test("party: approved database memberships, never another shop or a claimed legacy role", () => {
  const store = fixture();
  const order = { ...store.orders[0], riderId: "rider" };
  store.approvalCases.push({ userId: "rider", kind: "rider", status: "approved" });
  assert.equal(pickupChatParty({ id: "supplier", role: "supplier" }, order, store), "supplier");
  assert.equal(pickupChatParty({ id: "rider", role: "rider" }, order, store), "rider");
  for (const [id, role] of [["replacement", "supplier"], ["client", "client"], ["ops", "ops_admin"], ["rider2", "rider"]]) {
    assert.equal(pickupChatParty({ id, role }, order, store), null);
  }
  store.users.find(u => u.id === "supplier").role = "client";
  assert.equal(pickupChatParty({ id: "supplier", role: "supplier" }, order, store), "supplier");
  store.approvalCases.find(c => c.userId === "supplier").status = "suspended";
  assert.equal(pickupChatParty({ id: "supplier", role: "supplier" }, order, store), null);
  store.approvalCases.find(c => c.userId === "supplier").status = "approved";
  store.userRoleMemberships = store.userRoleMemberships.filter(m => m.userId !== "supplier");
  assert.equal(pickupChatParty({ id: "supplier", role: "supplier" }, order, store), null);
});

test("message body is trimmed and bounded", () => {
  assert.deepEqual(parseDeliveryMessage("  On my way \r\n"), { ok: true, body: "On my way" });
  assert.equal(parseDeliveryMessage("   ").ok, false);
  assert.equal(parseDeliveryMessage(42).ok, false);
  assert.equal(parseDeliveryMessage("x".repeat(1001)).ok, false);
});

function chatPhoto(fileId, ownerId, patch = {}) {
  return { fileId, ownerId, purpose: "pickup_chat_image", originalFilename: "gate.jpg", declaredContentType: "image/jpeg",
    detectedContentType: "image/jpeg", size: 100, state: "ready", objectKey: `pickup_chat_image/${fileId}`, createdAt: AT,
    readyAt: AT, references: [], ...patch };
}

async function setup(t, orderPatch = {}, { files = [] } = {}) {
  const db = createDatabase({ DATABASE_URL });
  t.after(() => db.close());
  await db.query("TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE");
  const store = fixture();
  const order = store.orders[0];
  Object.assign(order, { state: "out_for_delivery", riderId: "rider", pickupChecklist: { status: "passed" }, ...orderPatch });
  store.users.push({ id: "rider2", role: "rider", email: ["rider2", "example.invalid"].join("@"), name: "rider2",
    clerkUserId: "clerk_rider2", createdAt: AT, verificationStatus: "approved" });
  store.userRoleMemberships.push({ userId: "rider2", role: "rider", createdAt: AT });
  for (const riderId of ["rider", "rider2"]) {
    store.approvalCases.push({ id: `case_${riderId}`, userId: riderId, kind: "rider", status: "approved", version: 1,
      applicationRevision: 1, createdAt: AT, updatedAt: AT });
  }
  store.files.push(...files);
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t) };
}

async function patchOrder(db, patch) {
  await db.transaction(async () => {
    const store = await loadStore(db);
    Object.assign(store.orders[0], patch);
    await saveStore(db, store);
  });
}

const PATH = "/orders/order/pickup-chat";

async function messageCount(db) {
  return (await db.query("SELECT count(*)::int AS n FROM pickup_chat_messages")).rows[0].n;
}

test("HTTP: shop and rider message each other during the delivery; nobody else can", { skip: !DATABASE_URL }, async (t) => {
  const { db, api } = await setup(t);

  const empty = await api("supplier", "GET", PATH);
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.chat.status, "open");
  assert.equal(empty.body.chat.retentionHours, 24);
  assert.deepEqual(empty.body.messages, []);

  for (const [actor, status] of [[null, 401], ["other", 403], ["replacement", 403], ["client", 403], ["ops", 403], ["rider2", 403]]) {
    const read = await api(actor, "GET", PATH);
    assert.equal(read.status, status, `${actor} read: ${JSON.stringify(read.body)}`);
    const write = await api(actor, "POST", `${PATH}/messages`, { body: "hello" });
    assert.equal(write.status, status, `${actor} write: ${JSON.stringify(write.body)}`);
  }

  const sent = await api("supplier", "POST", `${PATH}/messages`, { body: "  Gate is the blue one  " });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.message.body, "Gate is the blue one");
  assert.equal(sent.body.message.senderRole, "supplier");
  assert.equal(sent.body.message.mine, true);

  assert.equal((await api("rider", "GET", "/orders/order")).body.order.pickupChat.unread, 1);
  const riderView = await api("rider", "GET", PATH);
  assert.equal(riderView.status, 200);
  assert.equal((await api("rider", "GET", "/orders/order")).body.order.pickupChat.unread, 0);
  assert.deepEqual(riderView.body.messages.map((m) => [m.senderRole, m.body, m.mine]), [["supplier", "Gate is the blue one", false]]);
  for (const message of riderView.body.messages) {
    assert.deepEqual(Object.keys(message).sort(), ["attachments", "body", "createdAt", "id", "mine", "senderRole"]);
    assert.deepEqual(message.attachments, []);
  }

  const reply = await api("rider", "POST", `${PATH}/messages`, { body: "Five minutes away" });
  assert.equal(reply.status, 201);
  const again = await api("supplier", "POST", `${PATH}/messages`, { body: "Thanks" });
  assert.equal(again.status, 201);
  assert.equal((await api("supplier", "POST", `${PATH}/messages`, { body: "   " })).status, 400);

  const store = await loadStore(db);
  const notices = store.notifications.filter((n) => n.type === "pickup_chat_message");
  const staffNotices = store.notifications.filter(n => n.type === "pickup_chat_activity");
  assert.deepEqual([...new Set(staffNotices.map(n => n.userId))].sort(), ["admin", "ops"]);
  assert.ok(staffNotices.every(n => !n.body.includes("Gate") && !n.body.includes("Five minutes")));
  // One per recipient: the second client message rode on the rider's unread notice.
  assert.deepEqual(notices.map((n) => [n.userId, n.appRole]).sort(), [["rider", "rider"], ["supplier", "supplier"]]);
  for (const notice of notices) {
    assert.equal(notice.orderId, "order");
    assert.ok(!notice.body.includes("Gate") && !notice.body.includes("Five minutes"), "notice never carries the words");
  }

  const shopOrder = await api("supplier", "GET", "/orders/order");
  assert.equal(shopOrder.body.order.pickupChat.status, "open");
  assert.equal(shopOrder.body.order.pickupChat.unread, 0);
  assert.equal(shopOrder.body.order.pickupChat.riderFirstName, "rider");
  assert.equal((await api("supplier", "GET", "/jobs")).body.jobs[0].pickupChat.status, "open");
  const riderOrder = await api("rider", "GET", "/orders/order");
  assert.equal(riderOrder.body.order.pickupChat.status, "open");
  for (const actor of ["client", "ops"]) {
    const read = await api(actor, "GET", "/orders/order");
    assert.equal(read.status, 200);
    assert.equal(read.body.order.pickupChat, undefined, `${actor} must not see the conversation`);
  }
});

test("HTTP: readable but closed to new messages for a day after delivery, then gone", { skip: !DATABASE_URL }, async (t) => {
  const { db, api } = await setup(t);
  assert.equal((await api("supplier", "POST", `${PATH}/messages`, { body: "Call the guard" })).status, 201);

  await patchOrder(db, { state: "issue_window_open", deliveryEvidence: { recordedAt: ago(2 * HOUR), evidenceType: "photo" } });
  const readOnly = await api("rider", "GET", PATH);
  assert.equal(readOnly.status, 200);
  assert.equal(readOnly.body.chat.status, "read_only");
  assert.ok(Date.parse(readOnly.body.chat.closesAt) > Date.now() + 21 * HOUR);
  assert.equal(readOnly.body.messages.length, 1);
  const refused = await api("supplier", "POST", `${PATH}/messages`, { body: "One more" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "pickup_chat_read_only");
  await purgeClosedPickupChats(db);
  assert.equal(await messageCount(db), 1, "a readable conversation stays");

  await patchOrder(db, { deliveryEvidence: { recordedAt: ago(25 * HOUR), evidenceType: "photo" } });
  for (const actor of ["supplier", "rider"]) {
    const gone = await api(actor, "GET", PATH);
    assert.equal(gone.status, 410, JSON.stringify(gone.body));
    assert.equal(gone.body.error, "pickup_chat_closed");
    const order = await api(actor, "GET", "/orders/order");
    assert.equal(order.body.order.pickupChat, undefined);
  }
  // The API's own lifecycle sweep may have got there first; either way it is gone.
  await purgeClosedPickupChats(db);
  assert.equal(await messageCount(db), 0);
});

test("HTTP: a reassigned rider starts clean and the old conversation is purged", { skip: !DATABASE_URL }, async (t) => {
  const { db, api } = await setup(t);
  assert.equal((await api("supplier", "POST", `${PATH}/messages`, { body: "For the first rider" })).status, 201);
  await patchOrder(db, { riderId: "rider2", state: "rider_assigned" });
  const fresh = await api("rider2", "GET", PATH);
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.body.messages, []);
  assert.equal((await api("rider", "GET", PATH)).status, 403);
  await purgeClosedPickupChats(db);
  assert.equal(await messageCount(db), 0);
});

test("HTTP: no conversation before a rider takes the job", { skip: !DATABASE_URL }, async (t) => {
  const { api } = await setup(t, { state: "ready_for_dispatch", riderId: null });
  const early = await api("supplier", "GET", PATH);
  assert.equal(early.status, 409);
  assert.equal(early.body.error, "pickup_chat_not_available");
  assert.equal((await api("supplier", "GET", "/orders/order")).body.order.pickupChat, undefined);
});

test("HTTP: GRIDGO Office trip opens chat and starts its fixed day at the office drop-off", { skip: !DATABASE_URL }, async (t) => {
  const { db, api } = await setup(t, { fulfillmentMode: "pickup", state: "rider_assigned" });
  assert.equal((await api("rider", "POST", `${PATH}/messages`, { body: "At the shop" })).status, 201);
  await patchOrder(db, { state: "awaiting_collection", awaitingCollectionAt: ago(2 * HOUR) });
  assert.equal((await api("supplier", "GET", PATH)).body.chat.status, "read_only");
  assert.equal((await api("rider", "POST", `${PATH}/messages`, { body: "Late" })).body.error, "pickup_chat_read_only");
  await patchOrder(db, { state: "issue_window_open", awaitingCollectionAt: ago(25 * HOUR), issueWindowOpenedAt: ago(HOUR) });
  assert.equal((await api("supplier", "GET", PATH)).status, 410);
  await purgeClosedPickupChats(db);
  assert.equal(await messageCount(db), 0);
});

test("parse: up to four photo ids, and a photo can be the whole message", () => {
  assert.deepEqual(parseDeliveryPhotoIds(undefined), { ok: true, fileIds: [] });
  assert.deepEqual(parseDeliveryPhotoIds([" a ", "a", "b"]), { ok: true, fileIds: ["a", "b"] });
  assert.equal(parseDeliveryPhotoIds("a").ok, false);
  assert.equal(parseDeliveryPhotoIds(["a", "b", "c", "d", "e"]).ok, false);
  assert.deepEqual(parseDeliveryMessage(undefined, { allowEmpty: true }), { ok: true, body: "" });
  assert.deepEqual(parseDeliveryMessage("  ", { allowEmpty: true }), { ok: true, body: "" });
  assert.equal(parseDeliveryMessage(undefined).ok, false);
});

const PHOTOS = [
  chatPhoto("photo_gate", "supplier"),
  chatPhoto("photo_spare", "supplier"),
  chatPhoto("photo_door", "rider", { detectedContentType: "image/png", originalFilename: "door.png" }),
  chatPhoto("photo_support", "supplier", { purpose: "support_chat_image" }),
];

test("HTTP: a photo goes with the message, and only the shop and the rider can open it", { skip: !DATABASE_URL }, async (t) => {
  const { db, api } = await setup(t, {}, { files: PHOTOS });

  const sent = await api("supplier", "POST", `${PATH}/messages`, { attachmentFileIds: ["photo_gate"] });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.message.body, "");
  assert.deepEqual(sent.body.message.attachments, [{ fileId: "photo_gate", contentType: "image/jpeg", originalFilename: "gate.jpg" }]);

  const reply = await api("rider", "POST", `${PATH}/messages`, { body: "This door?", attachmentFileIds: ["photo_door"] });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));

  const riderView = await api("rider", "GET", PATH);
  assert.deepEqual(riderView.body.messages.map((m) => [m.body, m.attachments.map((a) => a.fileId)]),
    [["", ["photo_gate"]], ["This door?", ["photo_door"]]]);

  for (const fileId of ["photo_gate", "photo_door"]) {
    for (const actor of ["supplier", "rider"]) {
      const link = await api(actor, "GET", `/files/${fileId}/download-url`);
      assert.equal(link.status, 200, `${actor} ${fileId}: ${JSON.stringify(link.body)}`);
      assert.ok(link.body.url);
    }
    for (const actor of ["other", "replacement", "client", "ops", "admin", "rider2"]) {
      const link = await api(actor, "GET", `/files/${fileId}/download-url`);
      assert.equal(link.status, 403, `${actor} must not open ${fileId}: ${JSON.stringify(link.body)}`);
      assert.equal((await api(actor, "GET", `/files/${fileId}`)).status, 403);
    }
  }

  const refusals = [
    ["supplier", { attachmentFileIds: ["photo_gate"] }, 409, "file_already_attached"],
    ["rider", { attachmentFileIds: ["photo_spare"] }, 400, "invalid_chat_image"],
    ["supplier", { attachmentFileIds: ["photo_support"] }, 400, "invalid_chat_image"],
    ["supplier", { attachmentFileIds: ["photo_missing"] }, 400, "invalid_chat_image"],
    ["supplier", { attachmentFileIds: ["a", "b", "c", "d", "e"] }, 400, "invalid_request"],
    ["supplier", { attachmentFileIds: [] }, 400, "invalid_request"],
  ];
  for (const [actor, body, status, error] of refusals) {
    const refused = await api(actor, "POST", `${PATH}/messages`, body);
    assert.equal(refused.status, status, `${JSON.stringify(body)}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, error);
  }
  const attach = await api("supplier", "POST", "/files/photo_spare/attach", { orderId: "order" });
  assert.equal(attach.status, 400);
  assert.equal(attach.body.error, "pickup_chat_image_not_attachable");
  // An unsent upload is still its owner's alone.
  assert.equal((await api("supplier", "GET", "/files/photo_spare/download-url")).status, 200);
  assert.equal((await api("rider", "GET", "/files/photo_spare/download-url")).status, 403);

  const references = (await db.query(
    `SELECT file_id, reference_id, data FROM file_references WHERE reference_type = 'pickup_chat_message' ORDER BY file_id`,
  )).rows;
  assert.deepEqual(references.map((row) => [row.file_id, row.data]),
    [["photo_door", { orderId: "order", riderId: "rider" }], ["photo_gate", { orderId: "order", riderId: "rider" }]]);
});

test("HTTP: photos go with the conversation one day after delivery, bytes included", { skip: !DATABASE_URL }, async (t) => {
  const { db, api } = await setup(t, {}, { files: PHOTOS });
  assert.equal((await api("supplier", "POST", `${PATH}/messages`, { body: "Gate", attachmentFileIds: ["photo_gate"] })).status, 201);

  await patchOrder(db, { state: "issue_window_open", deliveryEvidence: { recordedAt: ago(2 * HOUR), evidenceType: "photo" } });
  for (const actor of ["supplier", "rider"]) {
    assert.equal((await api(actor, "GET", "/files/photo_gate/download-url")).status, 200, `${actor} reads it while delivered`);
  }
  assert.deepEqual(await purgeClosedPickupChats(db), { removed: 0, fileIds: [] });

  await patchOrder(db, { deliveryEvidence: { recordedAt: ago(25 * HOUR), evidenceType: "photo" } });
  // Refused at once (403), or already queued for deletion by the API's own sweep (404).
  for (const actor of ["supplier", "rider"]) {
    const status = (await api(actor, "GET", "/files/photo_gate/download-url")).status;
    assert.ok([403, 404].includes(status), `${actor}: ${status}`);
  }

  const purged = await purgeClosedPickupChats(db);
  assert.equal(await messageCount(db), 0);
  if (purged.removed) assert.deepEqual(purged.fileIds, ["photo_gate"]);
  const file = (await db.query(`SELECT state, data FROM files WHERE file_id = 'photo_gate'`)).rows[0];
  assert.equal(file.state === "delete_pending" || file.state === "deleted", true, file.state);
  assert.equal((await db.query(
    `SELECT 1 FROM file_references WHERE file_id = 'photo_gate'`,
  )).rowCount, 1, "opaque order reference remains for deletion-retry holds");

  // The file retention pass removes the bytes the sweep queued.
  const deleted = [];
  const retention = createFileRetention({ database: db, load: () => loadStore(db), save: (next) => saveStore(db, next),
    storage: { deleteObject: async (key) => { deleted.push(key); } }, id: (prefix) => `${prefix}_test` });
  await retention.finishPending("photo_gate");
  const after = (await db.query(`SELECT state, object_key FROM files WHERE file_id = 'photo_gate'`)).rows[0];
  assert.equal(after.state, "deleted");
  assert.equal(after.object_key, null);
  for (const actor of ["supplier", "rider"]) {
    assert.equal((await api(actor, "GET", "/files/photo_gate/download-url")).status, 404);
  }
  // The spare upload was never sent, so the conversation did not take it.
  assert.equal((await db.query(`SELECT state FROM files WHERE file_id = 'photo_spare'`)).rows[0].state, "ready");
});

test("HTTP: a reassigned rider never sees the previous rider's photos", { skip: !DATABASE_URL }, async (t) => {
  const { db, api } = await setup(t, {}, { files: PHOTOS });
  assert.equal((await api("supplier", "POST", `${PATH}/messages`, { attachmentFileIds: ["photo_gate"] })).status, 201);
  await patchOrder(db, { riderId: "rider2", state: "rider_assigned" });
  // 403 while the sweep has not run, 404 once it has queued the photo's deletion.
  for (const actor of ["rider2", "rider", "supplier"]) {
    const status = (await api(actor, "GET", "/files/photo_gate/download-url")).status;
    assert.ok([403, 404].includes(status), `${actor}: ${status}`);
  }
  await purgeClosedPickupChats(db);
  const file = (await db.query(`SELECT state FROM files WHERE file_id = 'photo_gate'`)).rows[0];
  assert.ok(["delete_pending", "deleted"].includes(file.state), file.state);
});

test("HTTP: membership selection, first-name-only identity and unread counts stay party scoped", { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, { state: "rider_assigned" });
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.users.find(u => u.id === "rider").name = "Alex PrivateSurname";
    store.userRoleMemberships.push({ userId: "supplier", role: "client", createdAt: AT });
    await saveStore(db, store);
  });
  assert.equal((await api("supplier", "GET", PATH, null, { headers: { "x-gridgo-role": "client" } })).status, 403);
  const selected = await api("supplier", "GET", PATH, null, { headers: { "x-gridgo-role": "supplier" } });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.chat.riderFirstName, "Alex");
  assert.ok(!JSON.stringify(selected.body).includes("PrivateSurname"));
  assert.equal((await api("rider", "POST", `${PATH}/messages`, { body: "Arriving" })).status, 201);
  assert.equal((await api("supplier", "GET", "/jobs")).body.jobs[0].pickupChat.unread, 1);
  assert.equal((await api("supplier", "GET", PATH)).body.chat.unread, 0);
  assert.equal((await api("supplier", "GET", "/jobs")).body.jobs[0].pickupChat.unread, 0);
  await db.transaction(async () => {
    const store = await loadStore(db);
    Object.assign(store.approvalCases.find(c => c.userId === "supplier"), { status: "suspended", suspensionReason: "Test hold" });
    await saveStore(db, store);
  });
  assert.equal((await api("supplier", "GET", PATH)).status, 403);
  assert.equal((await api("supplier", "POST", `${PATH}/messages`, { body: "Blocked" })).status, 403);
});

test("HTTP: same 30-message rate limit and five-minute notice burst", { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, { state: "rider_assigned" });
  for (let i = 0; i < 30; i++) {
    assert.equal((await api("supplier", "POST", `${PATH}/messages`, { body: `Message ${i}` })).status, 201);
  }
  const refused = await api("supplier", "POST", `${PATH}/messages`, { body: "One too many" });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, "too_many_requests");
  assert.equal((await loadStore(db)).notifications.filter(n => n.type === "pickup_chat_message").length, 1);
  assert.equal((await api("rider", "GET", "/orders/order")).body.order.pickupChat.unread, 30);
});

test("retention: chat closes immediately but photo bytes respect holds and retries", { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, {}, { files: [chatPhoto("held_chat_photo", "supplier")] });
  assert.equal((await api("supplier", "POST", `${PATH}/messages`, { attachmentFileIds: ["held_chat_photo"] })).status, 201);
  await patchOrder(db, { state: "issue_window_open", payoutHold: true, deliveryEvidence: { recordedAt: ago(25 * HOUR) } });
  await db.transaction(() => purgeClosedPickupChats(db));
  assert.equal(await messageCount(db), 0);
  const deleted = [];
  const retention = createFileRetention({ database: db, load: () => loadStore(db), save: next => saveStore(db, next),
    storage: { deleteObject: async key => deleted.push(key) }, id: prefix => `${prefix}_held` });
  assert.equal(await retention.finishPending("held_chat_photo"), false);
  assert.deepEqual(deleted, []);
  assert.equal((await api("supplier", "GET", "/files/held_chat_photo/download-url")).status, 404);
  await patchOrder(db, { payoutHold: false });
  assert.equal(await retention.finishPending("held_chat_photo"), true);
  assert.deepEqual(deleted, ["pickup_chat_image/held_chat_photo"]);
});

test("HTTP: message notices enqueue only the counterpart's app and safe push data", { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  await db.transaction(async () => {
    const store = await loadStore(db);
    for (const [userId, appRole] of [["supplier", "supplier"], ["rider", "rider"], ["client", "client"]]) {
      store.deviceTokens.push({ id: `device_${userId}`, userId, appRole, token: `${userId}:` + "x".repeat(120),
        platform: "android", tokenProvider: "fcm", createdAt: AT, updatedAt: AT });
    }
    await saveStore(db, store);
  });
  assert.equal((await api("supplier", "POST", `${PATH}/messages`, { body: "Private conversation text" })).status, 201);
  assert.equal((await api("rider", "POST", `${PATH}/messages`, { body: "Private reply" })).status, 201);
  const rows = await db.query(`SELECT o.user_id, o.device_id FROM notification_push_outbox o
    JOIN notifications n ON n.id = o.notification_id WHERE n.type = 'pickup_chat_message' ORDER BY o.user_id`);
  assert.deepEqual(rows.rows, [{ user_id: "rider", device_id: "device_rider" }, { user_id: "supplier", device_id: "device_supplier" }]);
  for (const notice of (await loadStore(db)).notifications.filter(n => n.type === "pickup_chat_message")) {
    const push = pushMessageFor(notice);
    assert.equal(push.data.type, "pickup_chat_message");
    assert.equal(push.data.orderId, "order");
    assert.deepEqual(Object.keys(push.data).sort(), ["at", "notificationId", "orderId", "type"]);
    assert.ok(!JSON.stringify(push).includes("Private"));
  }
});
