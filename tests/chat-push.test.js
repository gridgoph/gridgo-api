import { resetDatabase } from './fixtures/reset-database.js';
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/database.js";
import { loadStore, saveStore } from "../src/postgres-store.js";
import { fixture, AT } from "./fixtures/reschedule.js";
import { apiForTest } from "./fixtures/reschedule-http.js";

const DATABASE_URL = process.env.DATABASE_URL;
const roleOf = key => ({ ops: "ops_admin", admin: "super_admin" })[key] || key;
const tokenFor = key => `${key}:` + "x".repeat(120);

async function waitFor(check, description) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(description);
}

// Only Google's HTTP boundary is fake: the actual API, transaction/save,
// post-commit drain, token/app filtering, OAuth client and FCM serializer run.
async function setup(t) {
  const requests = [];
  const fcm = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/token") return res.end(JSON.stringify({ access_token: "test-access", expires_in: 3600 }));
    if (req.url !== "/v1/projects/chat-test/messages:send") {
      res.writeHead(404); return res.end("{}");
    }
    requests.push(JSON.parse(raw));
    res.end(JSON.stringify({ name: `projects/chat-test/messages/${requests.length}` }));
  });
  await new Promise(resolve => fcm.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => fcm.close(resolve)));
  const origin = `http://127.0.0.1:${fcm.address().port}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), "gridgo-chat-push-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentials = path.join(dir, "fake-fcm.json");
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(credentials, JSON.stringify({ project_id: "chat-test", client_email: "test@example.invalid",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: `${origin}/token` }));
  const db = createDatabase({ DATABASE_URL });
  t.after(() => db.close());
  await resetDatabase(db, "TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE");
  const store = fixture();
  Object.assign(store.orders[0], { state: "rider_assigned", riderId: "rider" });
  store.approvalCases.push({ id: "case_rider", userId: "rider", kind: "rider", status: "approved", version: 1,
    applicationRevision: 1, createdAt: AT, updatedAt: AT });
  // Valid secondary memberships prove app-role filtering, not just membership rejection.
  for (const key of ["client", "supplier", "rider"]) {
    const wrongRole = key === "client" ? "supplier" : "client";
    store.userRoleMemberships.push({ userId: key, role: wrongRole, createdAt: AT });
    for (const [suffix, appRole] of [["", key], ["_wrong_app", wrongRole]]) {
      store.deviceTokens.push({ id: `dev_${key}${suffix}`, userId: key, appRole,
        token: tokenFor(`${key}${suffix}`), platform: "android", tokenProvider: "fcm", createdAt: AT, updatedAt: AT });
    }
  }
  store.deviceTokens.push({ id: "dev_stranger", userId: null, appRole: "client", token: tokenFor("stranger"),
    platform: "android", tokenProvider: "fcm", createdAt: AT, updatedAt: AT });
  await db.transaction(() => saveStore(db, store));
  const rawApi = await apiForTest(t, { GRIDGO_FCM_SERVICE_ACCOUNT_FILE: credentials, GRIDGO_FCM_BASE_URL: origin });
  const api = (key, method, endpoint, body) => rawApi(key, method, endpoint, body, { headers: { "x-gridgo-role": roleOf(key) } });
  // Refresh the real app token through the authenticated registration route.
  for (const key of ["client", "supplier", "rider"]) {
    const registered = await api(key, "POST", "/devices", { token: tokenFor(key), platform: "android", appRole: key, tokenProvider: "fcm" });
    assert.equal(registered.status, 200);
    assert.equal(registered.body.device.appRole, key);
  }
  return { db, api, requests };
}

function assertPush(request, type, recipient, orderId) {
  assert.equal(request.validate_only, undefined);
  const message = request.message;
  assert.equal(message.token, tokenFor(recipient));
  assert.equal(message.data.type, type);
  assert.equal(message.data.orderId, orderId);
  assert.deepEqual(Object.keys(message.data).sort(), orderId ? ["at", "notificationId", "orderId", "type"] : ["at", "notificationId", "type"]);
  assert.ok(message.data.notificationId);
  assert.ok(Number.isFinite(Date.parse(message.data.at)));
  assert.equal(message.android.priority, "high");
  assert.equal(message.android.notification.channel_id, "gridgo_default");
  assert.equal(message.android.notification.sound, "default");
  assert.equal(message.apns.payload.aps.sound, "default");
  assert.deepEqual(message.notification, { title: "GRIDGO update", body: "Open GRIDGO for the latest update." });
  assert.ok(!JSON.stringify(request).includes("PRIVATE"));
}

const paths = [
  ["support", "ops", "client", "support_message"],
  ["support", "admin", "rider", "support_message"],
  ["support", "ops", "supplier", "support_message"],
  ["delivery", "rider", "client", "delivery_message"],
  ["delivery", "client", "rider", "delivery_message"],
  ["pickup", "supplier", "rider", "pickup_chat_message"],
  ["pickup", "rider", "supplier", "pickup_chat_message"],
];
for (const [kind, sender, recipient, type] of paths) {
  test(`${kind}: ${sender} → ${recipient} sends an audible private FCM push after commit, once per unread burst`, { skip: !DATABASE_URL }, async t => {
    const { db, api, requests } = await setup(t);
    let endpoint = `/orders/order/${kind}-chat/messages`;
    let threadId;
    if (kind === "support") {
      const opened = await api(sender, "POST", "/support-chat/threads", { userId: recipient, role: recipient });
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      threadId = opened.body.thread.id;
      endpoint = `/support-chat/threads/${threadId}/messages`;
    }
    const sent = await api(sender, "POST", endpoint, { body: "PRIVATE first message" });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const notices = () => db.query("SELECT * FROM notifications WHERE type=$1 AND user_id=$2 ORDER BY created_at", [type, recipient]);
    assert.equal((await notices()).rowCount, 1, "the first message creates a durable recipient notice");
    await waitFor(async () => (await db.query(`SELECT 1 FROM notification_push_outbox o JOIN notifications n ON n.id=o.notification_id
      WHERE n.type=$1 AND n.user_id=$2 AND o.status='delivered'`, [type, recipient])).rowCount === 1, "post-commit push should reach fake FCM without a lifecycle tick");
    assert.equal(requests.length, 1, "only the recipient's matching app receives the message");
    assertPush(requests[0], type, recipient, kind === "support" ? undefined : "order");
    const notificationId = requests[0].message.data.notificationId;
    const inbox = await api(recipient, "GET", "/notifications");
    assert.equal(inbox.status, 200);
    const notice = inbox.body.notifications.find(n => n.id === notificationId);
    assert.ok(notice, "push corresponds to the recipient's authenticated inbox");
    if (kind === "support") assert.equal(notice.threadId, threadId, "tap resolves the exact support thread via the inbox, never push data");
    const countBefore = (await db.query("SELECT count(*)::int AS n FROM notification_push_outbox")).rows[0].n;
    assert.equal((await api(sender, "POST", endpoint, { body: "PRIVATE burst" })).status, 201);
    assert.equal((await notices()).rowCount, 1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM notification_push_outbox")).rows[0].n, countBefore);
    // Time travel only the notice; no sleeping five minutes or changing policy.
    await db.query("UPDATE notifications SET created_at=now()-interval '5 minutes 1 second' WHERE id=$1", [notificationId]);
    assert.equal((await api(sender, "POST", endpoint, { body: "PRIVATE next burst" })).status, 201);
    assert.equal((await notices()).rowCount, 2);
    await waitFor(() => requests.length === 2, "next message after five minutes should send again");
    assertPush(requests[1], type, recipient, kind === "support" ? undefined : "order");
  });
}

test("delivery: a previous rider's unread notice cannot swallow the new rider's first message", { skip: !DATABASE_URL }, async t => {
  const { db, api, requests } = await setup(t);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.notifications.push({ id: "previous_rider_notice", userId: "client", appRole: "client", orderId: "order",
      chatRiderId: "previous_rider", type: "delivery_message", title: "Old rider", body: "Old rider", at: new Date().toISOString(), read: false });
    await saveStore(db, store);
  });
  assert.equal((await api("rider", "POST", "/orders/order/delivery-chat/messages", { body: "PRIVATE new rider" })).status, 201);
  assert.equal((await db.query("SELECT 1 FROM notifications WHERE type='delivery_message' AND id<>'previous_rider_notice'")).rowCount, 1);
  await waitFor(() => requests.length === 1, "new rider's first message should push");
  assertPush(requests[0], "delivery_message", "client", "order");
});

test("support: separate threads alert independently and a read notice ends that thread's quiet window", { skip: !DATABASE_URL }, async t => {
  const { db, api, requests } = await setup(t);
  const first = await api("ops", "POST", "/support-chat/threads", { userId: "client", role: "client" });
  const firstId = first.body.thread.id;
  assert.equal((await api("ops", "POST", `/support-chat/threads/${firstId}/messages`, { body: "PRIVATE first thread" })).status, 201);
  await waitFor(() => requests.length === 1, "first thread push");
  const second = await api("client", "POST", "/support-chat/me/threads", {});
  assert.equal(second.status, 200);
  assert.notEqual(second.body.thread.id, firstId);
  assert.equal((await api("ops", "POST", `/support-chat/threads/${second.body.thread.id}/messages`, { body: "PRIVATE second thread" })).status, 201);
  await waitFor(() => requests.length === 2, "a different thread must not be muted");
  const opened = await api("client", "PATCH", `/notifications/${requests[0].message.data.notificationId}`, { read: true });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.notification.threadId, firstId, "tap can resolve an older thread by notificationId");
  assert.equal((await api("ops", "POST", `/support-chat/threads/${firstId}/messages`, { body: "PRIVATE after read" })).status, 201);
  await waitFor(() => requests.length === 3, "a read notice must not suppress a new message");
  assert.equal((await db.query("SELECT 1 FROM notifications WHERE type='support_message'")).rowCount, 3);
});

test("support: outbox persistence failure rolls back the reply and inbox without sending FCM", { skip: !DATABASE_URL }, async t => {
  const { db, api, requests } = await setup(t);
  const opened = await api("ops", "POST", "/support-chat/threads", { userId: "client", role: "client" });
  const threadId = opened.body.thread.id;
  try {
    await db.query(`CREATE FUNCTION test_reject_chat_push() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected outbox failure'; END $$;
      CREATE TRIGGER test_reject_chat_push BEFORE INSERT ON notification_push_outbox
      FOR EACH ROW EXECUTE FUNCTION test_reject_chat_push()`);
    const sent = await api("ops", "POST", `/support-chat/threads/${threadId}/messages`, { body: "PRIVATE rollback" });
    assert.equal(sent.status, 500);
    assert.equal((await db.query("SELECT 1 FROM support_chat_messages WHERE thread_id=$1", [threadId])).rowCount, 0);
    assert.equal((await db.query("SELECT 1 FROM notifications WHERE type='support_message'")).rowCount, 0);
    assert.equal((await db.query("SELECT 1 FROM notification_push_outbox")).rowCount, 0);
    assert.equal(requests.length, 0);
  } finally {
    await db.query("DROP TRIGGER IF EXISTS test_reject_chat_push ON notification_push_outbox; DROP FUNCTION IF EXISTS test_reject_chat_push()");
  }
  assert.equal((await api("ops", "POST", `/support-chat/threads/${threadId}/messages`, { body: "PRIVATE recovered" })).status, 201);
  await waitFor(() => requests.length === 1, "a rolled-back write cannot start a quiet window");
});
