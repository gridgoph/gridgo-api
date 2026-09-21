import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import { createDatabase } from "../src/database.js";
import {
  formatChatEvent,
  isSupportChatRoute,
  messagePreview,
  parseMessageBody,
} from "../src/support-chat.js";

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

async function startApi() {
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

async function wipe(database) {
  await database.query(
    `DELETE FROM support_chat_threads WHERE party_user_id LIKE $1`,
    [`${PREFIX}%`],
  );
  await database.query(`DELETE FROM user_role_memberships WHERE user_id LIKE $1`, [`${PREFIX}%`]);
  await database.query(`DELETE FROM users WHERE id LIKE $1`, [`${PREFIX}%`]);
}

test("support-chat helpers keep messages honest", () => {
  assert.equal(isSupportChatRoute("/support-chat/me"), true);
  assert.equal(isSupportChatRoute("/support-chat/threads/abc"), true);
  assert.equal(isSupportChatRoute("/support-tickets"), false);
  assert.equal(isSupportChatRoute("/notifications/stream"), false);

  assert.deepEqual(parseMessageBody("  hello  "), { ok: true, body: "hello" });
  assert.equal(parseMessageBody("").ok, false);
  assert.equal(parseMessageBody("   ").ok, false);
  assert.equal(parseMessageBody("x".repeat(4001)).ok, false);
  assert.equal(messagePreview("one   two   three"), "one two three");
  assert.equal(messagePreview("n".repeat(200)).endsWith("…"), true);

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
  t.after(async () => {
    await wipe(database);
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

  const sent = await request(instance.api, "/support-chat/me/messages", {
    method: "POST",
    token: client,
    role: "client",
    body: { body: "The tarpaulin colours look off." },
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.thread.partyRole, "client");
  assert.equal(sent.body.thread.partyUserId, byRole.client.id);
  assert.equal(sent.body.message.body, "The tarpaulin colours look off.");
  assert.equal(sent.body.message.mine, true);

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
  assert.equal(shop.body.thread.partyRole, "supplier");
  assert.notEqual(shop.body.thread.id, sent.body.thread.id);

  const bike = await request(instance.api, "/support-chat/me/messages", {
    method: "POST",
    token: rider,
    role: "rider",
    body: { body: "The drop-off gate is locked after 6." },
  });
  assert.equal(bike.status, 201);
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
  assert.equal(reply.body.message.senderRole, "ops_admin");
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
  assert.equal(second.body.thread.id, draft.body.thread.id);
  assert.notEqual(second.body.thread.id, sent.body.thread.id);

  const history = await request(instance.api, "/support-chat/me", { token: client, role: "client" });
  assert.equal(history.body.threads.length, 2);
});
