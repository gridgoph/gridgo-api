import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { createDatabase } from "../src/database.js";
import { hashPassword } from "../src/support-desk.js";
import { escapeHtml, toHtmlParagraphs } from "../src/support-html.js";
import { buildReplyEmail, createSupportMailer, emailConfigured } from "../src/support-mail.js";
import { clientKey, tooManyRequests } from "../src/support-rate-limit.js";
import { interpretSmtpResult } from "../src/support-smtp.js";
import { validateLogin, validateReply, validateTicket } from "../src/support-validate.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ISSUER = "https://casual-crab-9.clerk.accounts.dev";
const AUTHORIZED_PARTY = "http://localhost:19006";
const AT = "2026-09-08T01:00:00.000Z";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_KEY = publicKey.export({ type: "spki", format: "pem" });
const DESK_USER = "desk";
const DESK_PASSWORD = "desk-password-for-tests";
const DESK_JWT_SECRET = "support-desk-jwt-secret-for-tests-not-clerk";
const LANDING_ORIGIN = "https://gridgo.talasora.com";

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
      GRIDGO_BUILD_SHA: "support-desk-test",
      GRIDGO_BUILD_TIME: AT,
      SUPPORT_DESK_USERNAME: DESK_USER,
      SUPPORT_DESK_PASSWORD: DESK_PASSWORD,
      SUPPORT_DESK_JWT_SECRET: DESK_JWT_SECRET,
      EMAIL_USER: "",
      EMAIL_PASSWORD: "",
      GRIDGO_SUPPORT_MAIL_CAPTURE: "",
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
    } catch {}
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

async function request(api, pathname, { method = "GET", token, body, headers = {} } = {}) {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body == null ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function clearTickets(database) {
  await database.query("TRUNCATE support_tickets, support_admins RESTART IDENTITY CASCADE");
}

const sampleTicket = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "Ana <script>",
  email: "ana@example.com",
  subject: "Help & \"quotes\"",
  message: "Line 1\nLine 2",
  status: "open",
  adminReply: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

test("validateTicket accepts a complete public submission", () => {
  const result = validateTicket({
    name: "Ana",
    email: "ana@example.com",
    subject: "Late delivery",
    message: "Still waiting on order 12.",
  });
  assert.equal(result.ok, true);
});

test("validateTicket rejects a missing email and an invalid email", () => {
  assert.equal(validateTicket({ name: "Ana", subject: "Hi", message: "x" }).ok, false);
  assert.equal(
    validateTicket({ name: "Ana", email: "not-an-email", subject: "Hi", message: "x" }).ok,
    false,
  );
});

test("validateReply requires a non-empty replyMessage", () => {
  assert.equal(validateReply({ replyMessage: "   " }).ok, false);
  assert.equal(validateReply({ replyMessage: "We are on it." }).ok, true);
});

test("validateLogin requires both fields", () => {
  assert.equal(validateLogin({ username: "desk" }).ok, false);
  assert.equal(validateLogin({ username: "desk", password: "secret" }).ok, true);
});

test("escapeHtml encodes markup so ticket text cannot break the email layout", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('xss')"> & "quotes"`),
    "&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt; &amp; &quot;quotes&quot;",
  );
});

test("toHtmlParagraphs keeps line breaks after escaping", () => {
  assert.equal(toHtmlParagraphs("hello\nworld"), "hello<br/>world");
});

test("tooManyRequests trips after the limit and clientKey prefers forwarded-for", () => {
  const key = `ticket-test-${process.pid}-${Date.now()}`;
  assert.equal(tooManyRequests(key, 2, 60_000), false);
  assert.equal(tooManyRequests(key, 2, 60_000), false);
  assert.equal(tooManyRequests(key, 2, 60_000), true);
  assert.equal(clientKey("127.0.0.1", "203.0.113.9, 10.0.0.1"), "203.0.113.9");
});

test("interpretSmtpResult treats Gmail 250 + accepted recipient as sent", () => {
  const result = interpretSmtpResult({
    accepted: ["sgeto509@gmail.com"],
    rejected: [],
    response: "250 2.0.0 OK gsmtp",
    messageId: "<id@gmail.com>",
  });
  assert.equal(result.sent, true);
  assert.equal(result.messageId, "<id@gmail.com>");
});

test("interpretSmtpResult does not treat a rejected recipient as sent", () => {
  const result = interpretSmtpResult({
    accepted: [],
    rejected: ["nobody@example.com"],
    response: "550 5.1.1",
  });
  assert.equal(result.sent, false);
  assert.match(result.error ?? "", /rejected/i);
});

test("reply email uses the GRIDGO layout, escapes customer text, and uses #8A8A8A launcher dots", () => {
  const email = buildReplyEmail(sampleTicket, "We shipped it.");
  assert.match(email.subject, /Ticket #aaaaaaaa/);
  assert.match(email.html, /GRIDGO/);
  assert.match(email.html, /Admin Response/);
  assert.match(email.html, /Ana &lt;script&gt;/);
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /Help &amp; &quot;quotes&quot;/);
  assert.match(email.html, /Line 1<br\/>Line 2/);
  assert.match(email.text, /We shipped it/);
  const launcherDots = [...email.html.matchAll(/width:8px; height:8px; background-color:([^;]+);/g)].map((match) => match[1]);
  assert.deepEqual(launcherDots, ["#ffffff", "#ffffff", "#FFDE58", "#ffffff", "#ffffff", "#8A8A8A", "#ffffff", "#ffffff", "#8A8A8A"]);
  assert.equal(email.html.includes("background-color:#6B7280; border-radius:50%"), false);
});

test("sendReplyEmail uses nodemailer createTransport and reports SMTP success", async () => {
  const sent = [];
  const mailer = createSupportMailer(
    { EMAIL_USER: "gridgo-support@example.com", EMAIL_PASSWORD: "app-password" },
    {
      createTransport(options) {
        assert.equal(options.service, "gmail");
        assert.equal(options.auth.user, "gridgo-support@example.com");
        assert.equal(options.auth.pass, "app-password");
        return {
          async sendMail(mail) {
            sent.push(mail);
            return {
              accepted: [mail.to],
              rejected: [],
              response: "250 2.0.0 OK gsmtp",
              messageId: "<mock@gmail.com>",
            };
          },
        };
      },
    },
  );
  const result = await mailer.sendReplyEmail(sampleTicket, "We shipped it.");
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "ana@example.com");
  assert.match(sent[0].html, /#8A8A8A/);
});

test("emailConfigured is a boolean from EMAIL_* and never returns the password", () => {
  assert.equal(emailConfigured({}), false);
  assert.equal(emailConfigured({ EMAIL_USER: "a@b.c", EMAIL_PASSWORD: "secret" }), true);
  assert.equal(JSON.stringify(emailConfigured({ EMAIL_USER: "a@b.c", EMAIL_PASSWORD: "secret" })).includes("secret"), false);
});

test("public submit, desk login, rate limit, mail, and CORS origin handling", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearTickets(database);
  const capturePath = path.join(os.tmpdir(), `gridgo-support-mail-${process.pid}.jsonl`);
  await fs.rm(capturePath, { force: true });
  const instance = await startApi({
    EMAIL_USER: "gridgo-support@example.com",
    EMAIL_PASSWORD: "app-password",
    GRIDGO_SUPPORT_MAIL_CAPTURE: capturePath,
    CORS_ALLOWED_ORIGINS: LANDING_ORIGIN,
  });
  try {
    const health = await request(instance.api, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.emailConfigured, true);
    assert.equal(JSON.stringify(health.body).includes("app-password"), false);
    assert.equal(JSON.stringify(health.body).includes("EMAIL_PASSWORD"), false);

    const blockedOrigin = await request(instance.api, "/api/support-tickets", {
      method: "POST",
      body: { name: "Ana", email: "ana@example.com", subject: "Hi", message: "Blocked origin" },
      headers: { Origin: "https://not-allowed.example" },
    });
    assert.equal(blockedOrigin.status, 403);
    assert.equal(blockedOrigin.body.error, "origin_not_allowed");

    const landingSubmit = await request(instance.api, "/api/support-tickets", {
      method: "POST",
      body: { name: "Ana", email: "ana@example.com", subject: "Late delivery", message: "Still waiting on order 12." },
      headers: { Origin: LANDING_ORIGIN },
    });
    assert.equal(landingSubmit.status, 201, JSON.stringify(landingSubmit.body));
    assert.equal(landingSubmit.body.status, "open");
    assert.equal(landingSubmit.headers.get("access-control-allow-origin"), LANDING_ORIGIN);
    assert.equal(landingSubmit.body.id.length > 0, true);

    const rootSubmit = await request(instance.api, "/support-tickets", {
      method: "POST",
      body: { name: "Ben", email: "ben@example.com", subject: "Quote", message: "How much for 50 flyers?" },
    });
    assert.equal(rootSubmit.status, 201, JSON.stringify(rootSubmit.body));

    const invalid = await request(instance.api, "/api/support-tickets", {
      method: "POST",
      body: { name: "Ana", email: "not-an-email", subject: "Hi", message: "x" },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "invalid_request");
    assert.match(invalid.body.message, /valid email/i);

    const missing = await request(instance.api, "/support-tickets", {
      method: "POST",
      body: { name: "Ana", subject: "Hi", message: "x" },
    });
    assert.equal(missing.status, 400);

    const rateIp = "198.51.100.24";
    for (let i = 0; i < 5; i += 1) {
      const submitted = await request(instance.api, "/api/support-tickets", {
        method: "POST",
        body: { name: "Rate", email: "rate@example.com", subject: `n${i}`, message: "rate-limit probe" },
        headers: { "X-Forwarded-For": rateIp },
      });
      assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    }
    const limited = await request(instance.api, "/api/support-tickets", {
      method: "POST",
      body: { name: "Rate", email: "rate@example.com", subject: "n5", message: "rate-limit probe" },
      headers: { "X-Forwarded-For": rateIp },
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "too_many_requests");

    const unauthList = await request(instance.api, "/api/support-tickets");
    assert.equal(unauthList.status, 401);

    const clerkList = await request(instance.api, "/support-tickets", { token: clerkToken("clerk_ops") });
    assert.equal(clerkList.status, 401);

    const badLogin = await request(instance.api, "/api/admin/login", {
      method: "POST",
      body: { username: DESK_USER, password: "wrong-password" },
    });
    assert.equal(badLogin.status, 401);
    assert.equal(badLogin.body.error, "invalid_credentials");

    const login = await request(instance.api, "/api/admin/login", {
      method: "POST",
      body: { username: DESK_USER, password: DESK_PASSWORD },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.body.username, DESK_USER);
    assert.equal(typeof login.body.token, "string");
    const deskToken = login.body.token;

    const me = await request(instance.api, "/api/admin/me", { token: deskToken });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, { username: DESK_USER });

    const listed = await request(instance.api, "/api/support-tickets", { token: deskToken });
    assert.equal(listed.status, 200);
    assert.equal(Array.isArray(listed.body), true);
    const first = listed.body.find((ticket) => ticket.email === "ana@example.com");
    assert.equal(first.subject, "Late delivery");

    const got = await request(instance.api, `/support-tickets/${first.id}`, { token: deskToken });
    assert.equal(got.status, 200);
    assert.equal(got.body.email, "ana@example.com");

    const replied = await request(instance.api, `/api/support-tickets/${first.id}/reply`, {
      method: "PATCH",
      token: deskToken,
      body: { replyMessage: "We shipped it this morning." },
    });
    assert.equal(replied.status, 200, JSON.stringify(replied.body));
    assert.equal(replied.body.status, "closed");
    assert.equal(replied.body.adminReply, "We shipped it this morning.");
    assert.equal(replied.body.emailSent, true);
    const captured = JSON.parse(await fs.readFile(capturePath, "utf8"));
    assert.equal(captured.to, "ana@example.com");
    assert.match(captured.html, /#8A8A8A/);
    assert.match(captured.subject, /Late delivery/);

    const other = listed.body.find((ticket) => ticket.email === "ben@example.com");
    const deleted = await request(instance.api, `/support-tickets/${other.id}`, {
      method: "DELETE",
      token: deskToken,
    });
    assert.equal(deleted.status, 204);
    const missingTicket = await request(instance.api, `/api/support-tickets/${other.id}`, { token: deskToken });
    assert.equal(missingTicket.status, 404);

    const envPasswordRejected = await database.query(
      "SELECT username, password_hash FROM support_admins WHERE username = $1",
      [DESK_USER],
    );
    assert.equal(envPasswordRejected.rowCount, 1);
    const rotatedHash = await hashPassword("rotated-desk-password");
    await database.query("UPDATE support_admins SET password_hash = $2 WHERE username = $1", [DESK_USER, rotatedHash]);
    const staleEnvLogin = await request(instance.api, "/admin/login", {
      method: "POST",
      body: { username: DESK_USER, password: DESK_PASSWORD },
    });
    assert.equal(staleEnvLogin.status, 401);
    const rotatedLogin = await request(instance.api, "/admin/login", {
      method: "POST",
      body: { username: DESK_USER, password: "rotated-desk-password" },
    });
    assert.equal(rotatedLogin.status, 200, JSON.stringify(rotatedLogin.body));
  } finally {
    await stopApi(instance);
    await fs.rm(capturePath, { force: true });
    await database.close();
  }
});

test("unconfigured mail still saves the reply", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearTickets(database);
  const instance = await startApi({
    EMAIL_USER: "",
    EMAIL_PASSWORD: "",
    GRIDGO_SUPPORT_MAIL_CAPTURE: "",
  });
  try {
    const health = await request(instance.api, "/health");
    assert.equal(health.body.emailConfigured, false);

    const created = await request(instance.api, "/support-tickets", {
      method: "POST",
      body: { name: "Cara", email: "cara@example.com", subject: "Invoice", message: "Need a copy." },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const login = await request(instance.api, "/admin/login", {
      method: "POST",
      body: { username: DESK_USER, password: DESK_PASSWORD },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));

    const replied = await request(instance.api, `/support-tickets/${created.body.id}/reply`, {
      method: "PATCH",
      token: login.body.token,
      body: { replyMessage: "Attached the invoice." },
    });
    assert.equal(replied.status, 200, JSON.stringify(replied.body));
    assert.equal(replied.body.emailSent, false);
    assert.equal(replied.body.status, "closed");
    assert.equal(replied.body.adminReply, "Attached the invoice.");

    const persisted = await database.query(
      "SELECT status, admin_reply FROM support_tickets WHERE id = $1",
      [created.body.id],
    );
    assert.equal(persisted.rows[0].status, "closed");
    assert.equal(persisted.rows[0].admin_reply, "Attached the invoice.");
  } finally {
    await stopApi(instance);
    await database.close();
  }
});
