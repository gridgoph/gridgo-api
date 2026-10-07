import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import { createDatabase } from "../src/database.js";
import {
  authorizeFileUpload,
  resolveFileTarget,
  validateUpload,
} from "../src/attachments.js";
import {
  formatChatEvent,
  isSupportChatRoute,
  messagePreview,
  parseAttachmentFileIds,
  parseMessageBody,
} from "../src/support-chat.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

const DATABASE_URL = process.env.DATABASE_URL;
const ISSUER = "https://casual-crab-9.clerk.accounts.dev";
const AUTHORIZED_PARTY = "http://localhost:19006";
const AT = "2026-09-20T03:00:00.000Z";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_KEY = publicKey.export({ type: "spki", format: "pem" });
const PREFIX = `chat_${process.pid}_${Date.now().toString(36)}`;

function clerkToken(subject) {
  const current = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "gridgo-test-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER, sub: subject, sid: `sess_${subject}`, azp: AUTHORIZED_PARTY,
    iat: current - 5, nbf: current - 5, exp: current + 300,
  })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startApi(extraEnv = {}) {
  const port = await freePort();
  const api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      DATABASE_URL,
      CLERK_SECRET_KEY: "test-only-placeholder",
      CLERK_ISSUER: ISSUER,
      CLERK_AUTHORIZED_PARTIES: AUTHORIZED_PARTY,
      CLERK_JWT_KEY: JWT_KEY,
      HOST: "127.0.0.1",
      PORT: String(port),
      GRIDGO_BUILD_SHA: "support-chat-test",
      GRIDGO_BUILD_TIME: AT,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`API exited before health:\n${output}`);
    try {
      if ((await fetch(`${api}/health`)).ok) return { api, child, output: () => output };
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGTERM");
  throw new Error(`API did not become healthy:\n${output}`);
}

async function stopApi(instance) {
  if (!instance) return;
  instance.child.kill("SIGTERM");
  await new Promise((resolve) => instance.child.once("exit", resolve));
}

async function request(api, pathname, { method = "GET", token, role, body, headers = {} } = {}) {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(role ? { "X-GRIDGO-Role": role } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: response.status, body: parsed };
}

async function seedPeople(database) {
  const people = [
    { id: `${PREFIX}_client`, clerk: `${PREFIX}_clerk_client`, email: `${PREFIX}-client@gridgo.test`, name: "Ana Client", role: "client", accountType: "individual" },
    { id: `${PREFIX}_client_b`, clerk: `${PREFIX}_clerk_client_b`, email: `${PREFIX}-client-b@gridgo.test`, name: "Ben Client", role: "client", accountType: "individual" },
    { id: `${PREFIX}_supplier`, clerk: `${PREFIX}_clerk_supplier`, email: `${PREFIX}-supplier@gridgo.test`, name: "Lovis Shop", role: "supplier", verification: "approved" },
    { id: `${PREFIX}_rider`, clerk: `${PREFIX}_clerk_rider`, email: `${PREFIX}-rider@gridgo.test`, name: "Rico Rider", role: "rider", verification: "approved" },
    { id: `${PREFIX}_ops`, clerk: `${PREFIX}_clerk_ops`, email: `${PREFIX}-ops@gridgo.test`, name: "Ops Desk", role: "ops_admin" },
    { id: `${PREFIX}_super`, clerk: `${PREFIX}_clerk_super`, email: `${PREFIX}-super@gridgo.test`, name: "Super Desk", role: "super_admin" },
  ];
  for (const person of people) {
    await database.query(
      `INSERT INTO users (id, clerk_user_id, email, name, role, account_type, verification_status, created_at, position, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 0, '{}')`,
      [
        person.id,
        person.clerk,
        person.email,
        person.name,
        person.role,
        person.accountType ?? null,
        person.verification ?? null,
      ],
    );
    await database.query(
      `INSERT INTO user_role_memberships (user_id, role, created_at) VALUES ($1, $2, now())`,
      [person.id, person.role],
    );
  }
  return people;
}

async function wipe(database, occurrenceKeys = []) {
  if (occurrenceKeys.length) {
    await database.query(
      `DELETE FROM notifications WHERE data->>'occurrenceKey' = ANY($1::text[])`,
      [occurrenceKeys],
    );
  }
  await database.query(`DELETE FROM notifications WHERE user_id LIKE $1`, [`${PREFIX}%`]);
  await database.query(
    `DELETE FROM file_references WHERE file_id LIKE $1 OR reference_id LIKE $1`,
    [`${PREFIX}%`],
  );
  await database.query(
    `DELETE FROM files WHERE file_id LIKE $1 OR owner_id LIKE $1`,
    [`${PREFIX}%`],
  );
  await database.query(
    `DELETE FROM support_chat_threads
     WHERE party_user_id LIKE $1 OR staff_peer_user_id LIKE $1`,
    [`${PREFIX}%`],
  );
  await database.query(`DELETE FROM user_role_memberships WHERE user_id LIKE $1`, [`${PREFIX}%`]);
  await database.query(`DELETE FROM users WHERE id LIKE $1`, [`${PREFIX}%`]);
}

async function staffNotices(database, occurrenceKey) {
  const result = await database.query(
    `SELECT user_id, type, order_id, data->>'appRole' AS app_role
     FROM notifications
     WHERE data->>'occurrenceKey' = $1`,
    [occurrenceKey],
  );
  return result.rows;
}

test("support-chat helpers keep messages honest", () => {
  assert.equal(isSupportChatRoute("/support-chat/me"), true);
  assert.equal(isSupportChatRoute("/support-chat/threads/abc"), true);
  assert.equal(isSupportChatRoute("/support-tickets"), false);
  assert.equal(isSupportChatRoute("/notifications/stream"), false);

  assert.deepEqual(parseMessageBody("  hello  "), { ok: true, body: "hello" });
  assert.equal(parseMessageBody("").ok, false);
  assert.equal(parseMessageBody("", { allowEmpty: true }).ok, true);
  assert.equal(parseMessageBody("   ").ok, false);
  assert.equal(parseMessageBody("x".repeat(4001)).ok, false);
  assert.equal(messagePreview("one   two   three"), "one two three");
  assert.equal(messagePreview("n".repeat(200)).endsWith("…"), true);
  assert.equal(messagePreview("", 1), "Sent a photo");
  assert.equal(messagePreview("", 2), "Sent 2 photos");
  assert.deepEqual(parseAttachmentFileIds(["a", "a", "b"]).fileIds, ["a", "b"]);
  assert.equal(parseAttachmentFileIds(["1", "2", "3", "4", "5"]).ok, false);

  authorizeFileUpload({ id: "c", role: "client" }, "support_chat_image");
  authorizeFileUpload({ id: "o", role: "ops_admin" }, "support_chat_image");
  assert.throws(
    () => resolveFileTarget({}, "support_chat_image", {}, { id: "c", role: "client" }),
    { code: "support_chat_image_not_attachable" },
  );
  assert.equal(
    validateUpload(
      { originalFilename: "shot.png", size: 120, sniffBytes: PNG, declaredContentType: "image/png" },
      "support_chat_image",
    ),
    "image/png",
  );
  assert.throws(
    () => validateUpload(
      { originalFilename: "notes.pdf", size: 120, sniffBytes: Buffer.from("%PDF-1.7"), declaredContentType: "application/pdf" },
      "support_chat_image",
    ),
    (error) => {
      assert.equal(error.code, "invalid_file_type");
      assert.equal(error.details.reason, "purpose_media_type_not_allowed");
      return true;
    },
  );

  const frame = formatChatEvent({
    type: "message",
    thread: { id: "t1" },
    message: { id: "m1", body: "hi" },
  });
  assert.match(frame, /^id: m1\n/);
  assert.match(frame, /event: support_chat\n/);
  assert.match(frame, /data: \{.*"type":"message".*\}\n\n$/);
});

test("authenticated roles chat with Operations on isolated threads", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  const occurrenceKeys = [];
  t.after(async () => {
    await wipe(database, occurrenceKeys);
    await database.close();
  });
  await wipe(database);
  const people = await seedPeople(database);
  const byRole = Object.fromEntries(people.map((person) => [person.role === "super_admin" ? "super" : person.role === "ops_admin" ? "ops" : person.id.includes("client_b") ? "clientB" : person.role, person]));

  const instance = await startApi();
  t.after(() => stopApi(instance));

  const client = clerkToken(byRole.client.clerk);
  const otherClient = clerkToken(byRole.clientB.clerk);
  const supplier = clerkToken(byRole.supplier.clerk);
  const rider = clerkToken(byRole.rider.clerk);
  const ops = clerkToken(byRole.ops.clerk);
  const admin = clerkToken(byRole.super.clerk);

  const empty = await request(instance.api, "/support-chat/me", { token: client, role: "client" });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.thread, null);
  assert.deepEqual(empty.body.messages, []);
  assert.deepEqual(empty.body.threads ?? [], []);

  await database.query(
    `UPDATE users SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{imageUrl}', to_jsonb($2::text))
     WHERE id = $1`,
    [byRole.client.id, "https://img.clerk.com/ana.jpg"],
  );

  const sent = await request(instance.api, "/support-chat/me/messages", {
    method: "POST",
    token: client,
    role: "client",
    body: { body: "The tarpaulin colours look off." },
  });
  assert.equal(sent.status, 201);
  occurrenceKeys.push(sent.body.message.id);
  assert.equal(sent.body.thread.partyRole, "client");
  assert.equal(sent.body.thread.partyUserId, byRole.client.id);
  assert.equal(sent.body.message.body, "The tarpaulin colours look off.");
  assert.equal(sent.body.message.mine, true);
  assert.equal(sent.body.message.senderImageUrl, "https://img.clerk.com/ana.jpg");

  const mine = await request(instance.api, "/support-chat/me", { token: client, role: "client" });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.messages.length, 1);
  assert.equal(mine.body.thread.unreadCount, 0);

  const stranger = await request(instance.api, `/support-chat/threads/${sent.body.thread.id}`, {
    token: otherClient,
    role: "client",
  });
  assert.equal(stranger.status, 404);

  const shop = await request(instance.api, "/support-chat/me/messages", {
    method: "POST",
    token: supplier,
    role: "supplier",
    body: { body: "Need the artwork file formats for this listing." },
  });
  assert.equal(shop.status, 201);
  occurrenceKeys.push(shop.body.message.id);
  assert.equal(shop.body.thread.partyRole, "supplier");
  assert.notEqual(shop.body.thread.id, sent.body.thread.id);

  const bike = await request(instance.api, "/support-chat/me/messages", {
    method: "POST",
    token: rider,
    role: "rider",
    body: { body: "The drop-off gate is locked after 6." },
  });
  assert.equal(bike.status, 201);
  occurrenceKeys.push(bike.body.message.id);
  assert.equal(bike.body.thread.partyRole, "rider");

  const forbiddenDesk = await request(instance.api, "/support-chat/threads", {
    token: client,
    role: "client",
  });
  assert.equal(forbiddenDesk.status, 403);

  const inbox = await request(instance.api, "/support-chat/threads", { token: ops, role: "ops_admin" });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.threads.length, 3);
  assert.deepEqual(inbox.body.threads.map((row) => row.partyRole).sort(), ["client", "rider", "supplier"]);
  const clientRow = inbox.body.threads.find((row) => row.partyRole === "client");
  assert.equal(clientRow.unreadCount, 1);

  const clientsOnly = await request(instance.api, "/support-chat/threads?role=client", {
    token: ops,
    role: "ops_admin",
  });
  assert.equal(clientsOnly.body.threads.length, 1);
  assert.equal(clientsOnly.body.threads[0].partyName, "Ana Client");

  const reply = await request(instance.api, `/support-chat/threads/${sent.body.thread.id}/messages`, {
    method: "POST",
    token: ops,
    role: "ops_admin",
    body: { body: "Send a daylight photo of the print and we will check the file." },
  });
  assert.equal(reply.status, 201);
  occurrenceKeys.push(reply.body.message.id);
  assert.equal(reply.body.message.senderRole, "ops_admin");
  assert.equal((await staffNotices(database, reply.body.message.id)).length, 0);
  assert.equal(reply.body.message.mine, true);

  const afterReply = await request(instance.api, "/support-chat/me", { token: client, role: "client" });
  assert.equal(afterReply.body.messages.length, 2);
  assert.equal(afterReply.body.messages[1].mine, false);
  assert.equal(afterReply.body.thread.unreadCount, 1);

  const marked = await request(instance.api, "/support-chat/me/read", {
    method: "PATCH",
    token: client,
    role: "client",
    body: {},
  });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.thread.unreadCount, 0);

  const adminInbox = await request(instance.api, "/support-chat/threads?q=gate", {
    token: admin,
    role: "super_admin",
  });
  assert.equal(adminInbox.status, 200);
  assert.equal(adminInbox.body.threads.length, 1);
  assert.equal(adminInbox.body.threads[0].partyRole, "rider");

  const staffAsParty = await request(instance.api, "/support-chat/me", { token: ops, role: "ops_admin" });
  assert.equal(staffAsParty.status, 403);

  const partyPeople = await request(instance.api, "/support-chat/people?q=Ana", {
    token: client,
    role: "client",
  });
  assert.equal(partyPeople.status, 403);

  const foundPeople = await request(instance.api, "/support-chat/people?q=Ana", {
    token: ops,
    role: "ops_admin",
  });
  assert.equal(foundPeople.status, 200);
  assert.equal(foundPeople.body.people.some((row) => row.userId === byRole.client.id && row.role === "client"), true);
  assert.equal(foundPeople.body.people.some((row) => row.userId === byRole.ops.id), false);

  const staffPeople = await request(instance.api, "/support-chat/people?role=staff", {
    token: ops,
    role: "ops_admin",
  });
  assert.equal(staffPeople.status, 200);
  assert.equal(
    staffPeople.body.people.some((row) => row.userId === byRole.super.id && row.role === "super_admin"),
    true,
  );
  assert.equal(staffPeople.body.people.some((row) => row.userId === byRole.ops.id), false);

  const openedClient = await request(instance.api, "/support-chat/threads", {
    method: "POST",
    token: ops,
    role: "ops_admin",
    body: { userId: byRole.client.id, role: "client" },
  });
  assert.equal(openedClient.status, 200);
  assert.equal(openedClient.body.thread.id, sent.body.thread.id);

  const selfChat = await request(instance.api, "/support-chat/threads", {
    method: "POST",
    token: ops,
    role: "ops_admin",
    body: { userId: byRole.ops.id, role: "ops_admin" },
  });
  assert.equal(selfChat.status, 400);

  const staffOpen = await request(instance.api, "/support-chat/threads", {
    method: "POST",
    token: ops,
    role: "ops_admin",
    body: { userId: byRole.super.id, role: "super_admin" },
  });
  assert.equal(staffOpen.status, 200);
  assert.equal(staffOpen.body.thread.partyUserId, byRole.super.id);
  assert.equal(staffOpen.body.thread.staffPeerUserId, byRole.ops.id);

  const staffReuse = await request(instance.api, "/support-chat/threads", {
    method: "POST",
    token: admin,
    role: "super_admin",
    body: { userId: byRole.ops.id, role: "ops_admin" },
  });
  assert.equal(staffReuse.body.thread.id, staffOpen.body.thread.id);
  assert.equal(staffReuse.body.thread.staffPeerName, "Ops Desk");

  const hidden = await request(instance.api, `/support-chat/threads/${staffOpen.body.thread.id}`, {
    token: client,
    role: "client",
  });
  assert.equal(hidden.status, 404);

  const staffNote = await request(instance.api, `/support-chat/threads/${staffOpen.body.thread.id}/messages`, {
    method: "POST",
    token: ops,
    role: "ops_admin",
    body: { body: "Can you take the late drop-off?" },
  });
  assert.equal(staffNote.status, 201);
  occurrenceKeys.push(staffNote.body.message.id);
  assert.equal((await staffNotices(database, staffNote.body.message.id)).length, 0);

  const adminRead = await request(instance.api, `/support-chat/threads/${staffOpen.body.thread.id}`, {
    token: admin,
    role: "super_admin",
  });
  assert.equal(adminRead.status, 200);
  assert.equal(adminRead.body.messages.some((row) => row.body === "Can you take the late drop-off?"), true);

  const staffInbox = await request(instance.api, "/support-chat/threads?role=staff", {
    token: ops,
    role: "ops_admin",
  });
  assert.equal(staffInbox.body.threads.some((row) => row.id === staffOpen.body.thread.id), true);

  const foundByWord = await request(
    instance.api,
    `/support-chat/threads/${sent.body.thread.id}/messages?q=tarpaulin`,
    { token: ops, role: "ops_admin" },
  );
  assert.equal(foundByWord.status, 200);
  assert.equal(foundByWord.body.messages.some((row) => row.body.includes("tarpaulin")), true);
  const missedWord = await request(
    instance.api,
    `/support-chat/threads/${sent.body.thread.id}/messages?q=unicorn-keyword`,
    { token: ops, role: "ops_admin" },
  );
  assert.equal(missedWord.body.messages.length, 0);

  await database.query(
    `INSERT INTO files
       (file_id, owner_id, purpose, original_filename, declared_content_type, detected_content_type,
        size_bytes, state, object_key, created_at, position, data)
     VALUES ($1, $2, 'support_chat_image', 'print.png', 'image/png', 'image/png',
             240, 'ready', $3, now(), 0, '{}')`,
    [`${PREFIX}_chat_img`, byRole.client.id, `${PREFIX}/support_chat_image/print.png`],
  );
  const pictured = await request(instance.api, "/support-chat/me/messages", {
    method: "POST",
    token: client,
    role: "client",
    body: { body: "", threadId: sent.body.thread.id, attachmentFileIds: [`${PREFIX}_chat_img`] },
  });
  assert.equal(pictured.status, 201, JSON.stringify(pictured.body));
  occurrenceKeys.push(pictured.body.message.id);
  assert.equal(pictured.body.message.attachments?.[0]?.fileId, `${PREFIX}_chat_img`);
  assert.equal(pictured.body.thread.lastMessagePreview, "Sent a photo");

  const photos = await request(
    instance.api,
    `/support-chat/threads/${sent.body.thread.id}/messages?media=1`,
    { token: ops, role: "ops_admin" },
  );
  assert.equal(photos.body.messages.some((row) => row.attachments?.some((item) => item.fileId === `${PREFIX}_chat_img`)), true);

  const gone = await request(instance.api, `/support-chat/threads/${bike.body.thread.id}`, {
    method: "DELETE",
    token: rider,
    role: "rider",
  });
  assert.equal(gone.status, 200);
  const missing = await request(instance.api, `/support-chat/threads/${bike.body.thread.id}`, {
    token: ops,
    role: "ops_admin",
  });
  assert.equal(missing.status, 404);

  const unauth = await request(instance.api, "/support-chat/me");
  assert.equal(unauth.status, 401);

  const blank = await request(instance.api, "/support-chat/me/messages", {
    method: "POST",
    token: client,
    role: "client",
    body: { body: "   " },
  });
  assert.equal(blank.status, 400);

  const draft = await request(instance.api, "/support-chat/me/threads", {
    method: "POST",
    token: client,
    role: "client",
    body: {},
  });
  assert.equal(draft.status, 200);
  assert.notEqual(draft.body.thread.id, sent.body.thread.id);
  assert.equal(draft.body.thread.lastMessageAt, null);

  const reuse = await request(instance.api, "/support-chat/me/threads", {
    method: "POST",
    token: client,
    role: "client",
    body: {},
  });
  assert.equal(reuse.body.thread.id, draft.body.thread.id);

  const second = await request(instance.api, "/support-chat/me/messages", {
    method: "POST",
    token: client,
    role: "client",
    body: { body: "This is a new conversation.", threadId: draft.body.thread.id },
  });
  assert.equal(second.status, 201);
  occurrenceKeys.push(second.body.message.id);
  assert.equal(second.body.thread.id, draft.body.thread.id);
  assert.notEqual(second.body.thread.id, sent.body.thread.id);

  const history = await request(instance.api, "/support-chat/me", { token: client, role: "client" });
  assert.equal(history.body.threads.length, 2);

  for (const messageId of [sent.body.message.id, shop.body.message.id, bike.body.message.id]) {
    const rows = await staffNotices(database, messageId);
    assert.equal(rows.filter((row) => row.user_id === byRole.ops.id && row.app_role === "ops_admin" && row.type === "ops_support_message").length, 1);
    assert.equal(rows.filter((row) => row.user_id === byRole.super.id && row.app_role === "super_admin" && row.type === "ops_support_message").length, 1);
    assert.equal(rows.filter((row) => [byRole.client.id, byRole.supplier.id, byRole.rider.id].includes(row.user_id)).length, 0);
    assert.ok(rows.every((row) => row.order_id == null && (row.app_role === "ops_admin" || row.app_role === "super_admin")));
    const pairs = rows.map((row) => `${row.user_id}:${row.app_role}`);
    assert.equal(new Set(pairs).size, pairs.length);
  }

  for (const [token, role] of [[client, "client"], [supplier, "supplier"], [rider, "rider"]]) {
    const inbox = await request(instance.api, `/notifications?role=${role}`, { token, role });
    assert.equal(inbox.status, 200);
    assert.equal(
      inbox.body.notifications.some((row) => row.type === "ops_support_message" || row.type === "ops_issue_report_filed"),
      false,
    );
  }
  const opsInbox = await request(instance.api, "/notifications?role=ops_admin", { token: ops, role: "ops_admin" });
  assert.equal(opsInbox.status, 200);
  assert.equal(
    opsInbox.body.notifications.some((row) => row.type === "ops_support_message" && row.orderId == null),
    true,
  );
});

async function openNotifications(api, person, role, lastEventId) {
  const controller = new AbortController();
  const response = await fetch(`${api}/notifications/stream?role=${role}`, {
    headers: { Authorization: `Bearer ${clerkToken(person.clerk)}`, ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const frames = [];
  const reader = response.body.getReader();
  const done = (async () => {
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += new TextDecoder().decode(value);
        let end;
        while ((end = pending.indexOf("\n\n")) !== -1) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) frames.push(JSON.parse(data.slice(6)));
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  return { frames, async close() { controller.abort(); await done; } };
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 250; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

test("staff alerts stay out of party SSE on local delivery, LISTEN, replay and listener recovery", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  const streams = [];
  const instances = [];
  const occurrences = [];
  let reportId;
  t.after(async () => {
    for (const stream of streams) await stream.close();
    for (const instance of instances) await stopApi(instance);
    if (reportId) await database.query("DELETE FROM issue_reports WHERE id=$1", [reportId]);
    await wipe(database, occurrences);
    await database.close();
  });
  await wipe(database);
  const people = await seedPeople(database);
  const byRole = Object.fromEntries(people.map((person) => [person.role, person]));
  // The same identity uses both a party app and the staff dashboard.
  await database.query("INSERT INTO user_role_memberships(user_id,role,created_at) VALUES ($1,'ops_admin',now())", [byRole.client.id]);
  const local = await startApi({ PGAPPNAME: `${PREFIX}_local`, GRIDGO_LIFECYCLE_INTERVAL_MS: "3600000", GRIDGO_PUSH_TOKEN_CHECK_INTERVAL_MS: "0" });
  instances.push(local);
  const remoteName = `${PREFIX}_remote`;
  const remote = await startApi({ PGAPPNAME: remoteName, GRIDGO_LIFECYCLE_INTERVAL_MS: "3600000", GRIDGO_PUSH_TOKEN_CHECK_INTERVAL_MS: "0" });
  instances.push(remote);
  const party = [], staff = [];
  for (const instance of instances) {
    for (const role of ["client", "supplier", "rider"]) {
      const stream = await openNotifications(instance.api, byRole[role], role);
      streams.push(stream); party.push(stream);
    }
    for (const [person, role] of [[byRole.ops_admin, "ops_admin"], [byRole.super_admin, "super_admin"], [byRole.client, "ops_admin"]]) {
      const stream = await openNotifications(instance.api, person, role);
      streams.push(stream); staff.push(stream);
    }
  }
  const message = await request(local.api, "/support-chat/me/messages", {
    method: "POST", token: clerkToken(byRole.client.clerk), role: "client", body: { body: "Private message must never become notification copy." },
  });
  assert.equal(message.status, 201, JSON.stringify(message.body));
  occurrences.push(message.body.message.id);
  const report = await request(local.api, "/issue-reports", {
    method: "POST", body: { issue: "Private report must never become notification copy." },
  });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  reportId = report.body.id;
  occurrences.push(reportId);
  await waitFor(() => staff.every((s) => ["chat", "issue-reports"].every((r) => s.frames.some((f) => f.resource === r))), "both API processes must deliver staff hints");
  await waitFor(() => staff.every((s) => ["ops_support_message", "ops_issue_report_filed"].every((type) => s.frames.some((f) => f.type === type))), "both staff roles must receive durable notifications");
  assert.ok(staff.every((s) => !JSON.stringify(s.frames).includes("Private")), "notification copy contains no report or message text");

  // A party reconnect may supply a cursor owned by this multi-role identity.
  const staffCursor = staff[2].frames.find((f) => f.type === "ops_support_message").id;
  const replay = await openNotifications(remote.api, byRole.client, "client", staffCursor);
  streams.push(replay); party.push(replay);
  const killed = await database.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND query='LISTEN gridgo_realtime_v1'",
    [remoteName],
  );
  assert.equal(killed.rowCount, 1, "terminate only this test API's LISTEN connection");
  await waitFor(() => staff.slice(3).every((s) => s.frames.some((f) => f.resource === "chat" && !f.id) && s.frames.some((f) => f.resource === "issue-reports" && !f.id)), "reconnected LISTEN sends staff collection refreshes");
  await waitFor(() => party.slice(3).every((s) => s.frames.some((f) => f.resource === "orders")), "party streams also observed listener recovery");
  assert.ok(party.every((s) => !s.frames.some((f) => ["chat", "issue-reports"].includes(f.resource) || ["ops_support_message", "ops_issue_report_filed"].includes(f.type))), "staff events never reach any party session, including multi-role replay");
});

test("staff inbox failure rolls back the submitted chat or report", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  let instance;
  const issue = `${PREFIX} rollback report`;
  t.after(async () => {
    if (instance) await stopApi(instance);
    await database.query("DROP TRIGGER IF EXISTS test_reject_staff_notice ON notifications");
    await database.query("DROP FUNCTION IF EXISTS test_reject_staff_notice()");
    await database.query("DELETE FROM issue_reports WHERE issue=$1", [issue]);
    await wipe(database);
    await database.close();
  });
  await wipe(database);
  const people = await seedPeople(database);
  const client = people.find((person) => person.role === "client");
  await database.query(`
    CREATE FUNCTION test_reject_staff_notice() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.type IN ('ops_support_message', 'ops_issue_report_filed') THEN
        RAISE EXCEPTION 'injected inbox persistence failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_reject_staff_notice BEFORE INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION test_reject_staff_notice();
  `);
  instance = await startApi();
  const chat = await request(instance.api, "/support-chat/me/messages", {
    method: "POST", token: clerkToken(client.clerk), role: "client", body: { body: "Must roll back with its staff inbox" },
  });
  assert.equal(chat.status, 500);
  assert.equal((await database.query("SELECT id FROM support_chat_threads WHERE party_user_id=$1", [client.id])).rowCount, 0);
  const report = await request(instance.api, "/issue-reports", { method: "POST", body: { issue } });
  assert.equal(report.status, 500);
  assert.equal((await database.query("SELECT id FROM issue_reports WHERE issue=$1", [issue])).rowCount, 0);
  assert.equal((await database.query("SELECT id FROM notifications WHERE user_id LIKE $1", [`${PREFIX}%`])).rowCount, 0);
});
