import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import { createDatabase } from "../src/database.js";
import { loadStore, saveStore } from "../src/postgres-store.js";
import { seedReferenceData } from "../src/seed.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ISSUER = "https://casual-crab-9.clerk.accounts.dev";
const AUTHORIZED_PARTY = "http://localhost:19006";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_KEY = publicKey.export({ type: "spki", format: "pem" });
const AT = "2026-09-01T00:00:00.000Z";
const GITHUB_TOKEN = "github_pat_test_only";
const FIRSTMATE_TOKEN = "firstmate-test-token";
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(64, 1)]);

function token(subject) {
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
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function startApi(extraEnv) {
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
      GRIDGO_LIFECYCLE_INTERVAL_MS: "3600000",
      GRIDGO_PUSH_TOKEN_CHECK_INTERVAL_MS: "0",
      GITHUB_TRACKER_TOKEN: "",
      GITHUB_TRACKER_REPOS: "",
      FIRSTMATE_TRACKER_TOKEN: "",
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
  if (!instance || instance.child.exitCode != null) return;
  instance.child.kill("SIGTERM");
  await new Promise((resolve) => instance.child.once("exit", resolve));
}

async function request(api, pathname, { method = "GET", subject, bearer, body } = {}) {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: {
      ...(subject ? { Authorization: `Bearer ${token(subject)}` } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(body == null ? {} : { "Content-Type": "application/json" }),
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function upload(api, subject, { purpose = "tracker_decision", name = "evidence.png", bytes = PNG, type = "image/png" } = {}) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const form = new FormData();
    form.append("purpose", purpose);
    form.append("file", new Blob([bytes], { type }), name);
    const response = await fetch(`${api}/files`, { method: "POST", headers: { Authorization: `Bearer ${token(subject)}` }, body: form });
    const body = await response.json();
    if (response.status === 503 && body.error === "storage_initializing") {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    return { status: response.status, body };
  }
  throw new Error("storage never finished initializing");
}

/** A small in-memory GitHub Issues API. */
async function startMockGithub() {
  const marker = (fields) => `Body\n\n<!-- tracker: ${JSON.stringify(fields)} -->`;
  const repos = {
    "gridgo-api": [
      { number: 1, title: "API one", body: marker({ id: "S2-1", section: "step-02", order: 1, ref: "2.1", summary: "Quote in minutes", category: "Orders", sheetStatus: "Open", owner: "mark" }), state: "open", state_reason: null, labels: ["tracker", "owner:mark"] },
      { number: 2, title: "API two", body: marker({ id: "G-1", section: "general", order: 1, ref: "G.1", summary: "One login", category: "Auth", owner: "ven" }), state: "open", state_reason: null, labels: ["tracker", "owner:ven", "needs-decision"] },
      { number: 3, title: "Not tracked", body: "", state: "open", state_reason: null, labels: ["bug"] },
    ],
    "gridgo-web": [
      { number: 5, title: "Web five", body: marker({ id: "SU-1", section: "supplier", order: 1, ref: "S.1", summary: "Shop board", category: "Supplier" }), state: "closed", state_reason: "completed", labels: ["tracker", "owner:ven"] },
      { number: 6, title: "A pull request", body: "", state: "open", state_reason: null, labels: ["tracker"], pull_request: {} },
    ],
  };
  const calls = [];
  const comments = [];
  const out = (repo, issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state_reason,
    labels: issue.labels.map((name) => ({ name })),
    html_url: `https://github.com/gridgoph/${repo}/issues/${issue.number}`,
    ...(issue.pull_request ? { pull_request: issue.pull_request } : {}),
  });
  const mock = await listen((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url, "http://github.test");
      calls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization });
      const reply = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${GITHUB_TOKEN}`) return reply(401, { message: "Bad credentials" });
      const match = /^\/repos\/gridgoph\/([^/]+)\/issues(?:\/(\d+))?(\/comments)?$/.exec(url.pathname);
      const list = match && repos[match[1]];
      if (!list) return reply(404, { message: "Not Found" });
      if (!match[2] && req.method === "GET") {
        const label = url.searchParams.get("labels");
        return reply(200, list.filter((issue) => issue.labels.includes(label)).map((issue) => out(match[1], issue)));
      }
      const issue = list.find((candidate) => candidate.number === Number(match[2]));
      if (!issue) return reply(404, { message: "Not Found" });
      if (match[3] && req.method === "POST") {
        comments.push({ repo: match[1], number: issue.number, body: JSON.parse(raw).body });
        return reply(201, { id: comments.length });
      }
      if (req.method === "PATCH") {
        const patch = JSON.parse(raw);
        if (patch.labels) issue.labels = patch.labels;
        if (patch.state) {
          issue.state = patch.state;
          issue.state_reason = patch.state === "closed" ? patch.state_reason : patch.state_reason ?? null;
        }
        return reply(200, out(match[1], issue));
      }
      if (req.method === "GET") return reply(200, out(match[1], issue));
      return reply(405, { message: "Method not allowed" });
    });
  });
  return { ...mock, repos, calls, comments };
}

/** Enough of the S3 API for bucket checks, one-part uploads and stat. */
async function startMockMinio() {
  const objects = new Map();
  return listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const pathname = decodeURIComponent(new URL(req.url, "http://minio.test").pathname);
      const isBucket = pathname.split("/").filter(Boolean).length === 1;
      if (req.method === "PUT") {
        objects.set(pathname, Buffer.concat(chunks));
        res.writeHead(200, { ETag: '"etag"' });
        return res.end();
      }
      if (req.method === "HEAD") {
        if (isBucket) {
          res.writeHead(200);
          return res.end();
        }
        const object = objects.get(pathname);
        if (!object) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { "Content-Length": object.length, ETag: '"etag"', "Last-Modified": new Date().toUTCString(), "Content-Type": "image/png" });
        return res.end();
      }
      if (req.method === "DELETE") {
        objects.delete(pathname);
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });
}

async function fixture(database) {
  await database.query(`TRUNCATE tracker_decisions, audit_log, file_references, files, notifications, users RESTART IDENTITY CASCADE`);
  await seedReferenceData(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users.push(
      { id: "user_client", clerkUserId: "clerk_client", email: "client@gridgo.test", name: "Client", role: "client", accountType: "individual", createdAt: AT },
      { id: "user_ops", clerkUserId: "clerk_ops", email: "ops@gridgo.test", name: "Ops", role: "ops_admin", createdAt: AT },
      { id: "user_super", clerkUserId: "clerk_super", email: "super@gridgo.test", name: "Ria Super", role: "super_admin", createdAt: AT },
    );
    store.userRoleMemberships.push(
      { userId: "user_client", role: "client", createdAt: AT },
      { userId: "user_ops", role: "ops_admin", createdAt: AT },
      { userId: "user_super", role: "super_admin", createdAt: AT },
    );
    store.clientProfiles.push({ userId: "user_client", clientKind: "personal", updatedAt: AT });
    await saveStore(database, store);
  });
}

test("tracker answers 503 when unconfigured and hides the firstmate routes without their token", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await fixture(database);
  let instance = null;
  try {
    instance = await startApi({});
    assert.equal((await request(instance.api, "/admin/tracker")).status, 401);
    assert.equal((await request(instance.api, "/admin/tracker", { subject: "clerk_ops" })).status, 403);
    const unconfigured = await request(instance.api, "/admin/tracker", { subject: "clerk_super" });
    assert.equal(unconfigured.status, 503);
    assert.equal(unconfigured.body.error, "tracker_not_configured");
    assert.match(unconfigured.body.message, /GITHUB_TRACKER_TOKEN/);
    const patch = await request(instance.api, "/admin/tracker/gridgo-api/1/status", { method: "PATCH", subject: "clerk_super", body: { status: "open" } });
    assert.equal(patch.status, 503);

    const hidden = await request(instance.api, "/firstmate/tracker/decisions?unprocessed=1", { bearer: "anything" });
    assert.equal(hidden.status, 404);
    assert.equal((await request(instance.api, "/firstmate/tracker/decisions/tdec_x/processed", { method: "POST", bearer: "anything" })).status, 404);
    // The rest of the API is untouched.
    assert.equal((await request(instance.api, "/health")).status, 200);
  } finally {
    await stopApi(instance);
    await database.close?.();
  }
});

test("Super Admin reads, steers and decides tracker items; firstmate collects the decisions", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await fixture(database);
  const github = await startMockGithub();
  const minio = await startMockMinio();
  let instance = null;
  try {
    instance = await startApi({
      GITHUB_TRACKER_TOKEN: GITHUB_TOKEN,
      GITHUB_TRACKER_REPOS: "gridgo-api,gridgoph/gridgo-web",
      GITHUB_TRACKER_API_URL: github.url,
      FIRSTMATE_TRACKER_TOKEN: FIRSTMATE_TOKEN,
      MINIO_ENDPOINT: minio.url,
      MINIO_PUBLIC_URL: minio.url,
      MINIO_BUCKET: "gridgo-tracker-test",
    });
    const { api } = instance;

    // Super Admin only.
    assert.equal((await request(api, "/admin/tracker")).status, 401);
    for (const subject of ["clerk_ops", "clerk_client"]) {
      const denied = await request(api, "/admin/tracker", { subject });
      assert.equal(denied.status, 403, subject);
      assert.equal(denied.body.error, "forbidden");
    }
    assert.equal((await request(api, "/admin/tracker/gridgo-api/2/status", { method: "PATCH", subject: "clerk_ops", body: { status: "open" } })).status, 403);

    const listed = await request(api, "/admin/tracker", { subject: "clerk_super" });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.match(listed.body.fetchedAt, /^\d{4}-/);
    assert.deepEqual(listed.body.items.map((item) => item.key), ["gridgo-api#2", "gridgo-web#5", "gridgo-api#1"]);
    const [general, supplier, step] = listed.body.items;
    assert.deepEqual(general, {
      key: "gridgo-api#2", repo: "gridgo-api", number: 2, url: "https://github.com/gridgoph/gridgo-api/issues/2",
      section: "general", order: 1, ref: "G.1", module: "General", developer: "Ven", requirement: "One login",
      category: "Auth", status: "needs-decision", statusSource: "derived", decisions: [],
    });
    assert.equal(supplier.status, "live");
    assert.equal(supplier.statusSource, "derived");
    assert.equal(step.developer, "Mark");
    assert.equal(step.status, "open");
    assert.ok(github.calls.every((call) => call.auth === `Bearer ${GITHUB_TOKEN}`));
    assert.equal(JSON.stringify(listed.body).includes(GITHUB_TOKEN), false);

    // Cached for 60 s; ?refresh=1 goes back to GitHub.
    const listCalls = () => github.calls.filter((call) => call.method === "GET" && call.path.endsWith("/issues")).length;
    const before = listCalls();
    assert.equal((await request(api, "/admin/tracker", { subject: "clerk_super" })).status, 200);
    assert.equal(listCalls(), before);
    assert.equal((await request(api, "/admin/tracker?refresh=1", { subject: "clerk_super" })).status, 200);
    assert.equal(listCalls(), before + 2);

    // Status: one status label; live closes as completed; anything else reopens.
    const toReview = await request(api, "/admin/tracker/gridgo-api/1/status", { method: "PATCH", subject: "clerk_super", body: { status: "in-review", note: "PR up" } });
    assert.equal(toReview.status, 200, JSON.stringify(toReview.body));
    assert.equal(toReview.body.status, "in-review");
    assert.equal(toReview.body.statusSource, "explicit");
    assert.deepEqual(github.repos["gridgo-api"][0].labels, ["tracker", "owner:mark", "status:in-review"]);

    const live = await request(api, "/admin/tracker/gridgo-api/1/status", { method: "PATCH", subject: "clerk_super", body: { status: "live" } });
    assert.equal(live.body.status, "live");
    assert.equal(github.repos["gridgo-api"][0].state, "closed");
    assert.equal(github.repos["gridgo-api"][0].state_reason, "completed");

    const reopened = await request(api, "/admin/tracker/gridgo-web/5/status", { method: "PATCH", subject: "clerk_super", body: { status: "blocked" } });
    assert.equal(reopened.body.status, "blocked");
    assert.equal(github.repos["gridgo-web"][0].state, "open");
    assert.deepEqual(github.repos["gridgo-web"][0].labels, ["tracker", "owner:ven", "status:blocked"]);

    const asked = await request(api, "/admin/tracker/gridgo-web/5/status", { method: "PATCH", subject: "clerk_super", body: { status: "needs-decision" } });
    assert.equal(asked.body.status, "needs-decision");
    assert.deepEqual(github.repos["gridgo-web"][0].labels, ["tracker", "owner:ven", "status:needs-decision", "needs-decision"]);

    // The change shows on the cached list straight away.
    const cachedAfter = await request(api, "/admin/tracker", { subject: "clerk_super" });
    assert.equal(cachedAfter.body.items.find((item) => item.key === "gridgo-api#1").status, "live");

    // Report fields are never editable; unknown items and repos are 404.
    const readOnly = await request(api, "/admin/tracker/gridgo-api/1/status", { method: "PATCH", subject: "clerk_super", body: { status: "open", requirement: "Other" } });
    assert.equal(readOnly.status, 400);
    assert.equal(readOnly.body.error, "tracker_field_not_editable");
    assert.equal((await request(api, "/admin/tracker/gridgo-api/1/status", { method: "PATCH", subject: "clerk_super", body: { status: "done" } })).body.error, "invalid_tracker_status");
    assert.equal((await request(api, "/admin/tracker/gridgo-api/3/status", { method: "PATCH", subject: "clerk_super", body: { status: "open" } })).body.error, "tracker_item_not_found");
    assert.equal((await request(api, "/admin/tracker/gridgo-rider/1/status", { method: "PATCH", subject: "clerk_super", body: { status: "open" } })).status, 404);

    const statusAudit = (await database.query(
      "SELECT actor_id, entity_type, entity_id, data FROM audit_log WHERE action = 'tracker.status' ORDER BY position",
    )).rows;
    assert.equal(statusAudit.length, 4);
    assert.deepEqual(statusAudit[0], {
      actor_id: "user_super", entity_type: "tracker_item", entity_id: "gridgo-api#1",
      data: { detail: { from: "open", to: "in-review", note: "PR up" }, reason: null },
    });
    assert.deepEqual(statusAudit[1].data.detail, { from: "in-review", to: "live", note: null });

    // Decisions only while an item needs one.
    const notNeeded = await request(api, "/admin/tracker/gridgo-api/1/decisions", { method: "POST", subject: "clerk_super", body: { text: "Go" } });
    assert.equal(notNeeded.status, 409);
    assert.equal(notNeeded.body.error, "tracker_decision_not_needed");

    // Attachments: tracker_decision uploads, Super Admin only.
    assert.equal((await upload(api, "clerk_ops")).status, 403);
    const tooBig = await upload(api, "clerk_super", { bytes: Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]) });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.error, "file_too_large");
    const wrongType = await upload(api, "clerk_super", { name: "a.txt", bytes: Buffer.from("hello"), type: "text/plain" });
    assert.equal(wrongType.status, 415);
    const first = await upload(api, "clerk_super");
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await upload(api, "clerk_super", { name: "brief.pdf", bytes: Buffer.from("%PDF-1.7\nbody"), type: "application/pdf" });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const attachmentIds = [first.body.file.fileId, second.body.file.fileId];
    // Operations can neither read nor sign a tracker attachment.
    assert.equal((await request(api, `/files/${attachmentIds[0]}`, { subject: "clerk_ops" })).status, 403);
    assert.equal((await request(api, `/files/${attachmentIds[0]}/download-url`, { subject: "clerk_ops" })).status, 403);

    assert.equal((await request(api, "/admin/tracker/gridgo-api/2/decisions", { method: "POST", subject: "clerk_super", body: { text: "" } })).status, 400);
    assert.equal((await request(api, "/admin/tracker/gridgo-api/2/decisions", { method: "POST", subject: "clerk_super", body: { text: "x".repeat(5001) } })).status, 400);
    const seven = await request(api, "/admin/tracker/gridgo-api/2/decisions", { method: "POST", subject: "clerk_super", body: { text: "ok", attachmentIds: ["a", "b", "c", "d", "e", "f", "g"] } });
    assert.equal(seven.body.error, "too_many_attachments");
    const foreign = await request(api, "/admin/tracker/gridgo-api/2/decisions", { method: "POST", subject: "clerk_super", body: { text: "ok", attachmentIds: ["file_missing"] } });
    assert.equal(foreign.body.error, "invalid_tracker_attachment");
    assert.equal(github.comments.length, 0);

    const decided = await request(api, "/admin/tracker/gridgo-api/2/decisions", {
      method: "POST", subject: "clerk_super", body: { text: "Use Clerk Google sign-in only.", attachmentIds },
    });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.status, "open");
    assert.equal(decided.body.statusSource, "explicit");
    assert.equal(decided.body.decisions.length, 1);
    const [decision] = decided.body.decisions;
    assert.match(decision.id, /^tdec_/);
    assert.equal(decision.text, "Use Clerk Google sign-in only.");
    assert.deepEqual(decision.decidedBy, { id: "user_super", name: "Ria Super" });
    assert.deepEqual(decision.attachments.map(({ name, contentType }) => ({ name, contentType })), [
      { name: "evidence.png", contentType: "image/png" },
      { name: "brief.pdf", contentType: "application/pdf" },
    ]);
    assert.deepEqual(github.repos["gridgo-api"][1].labels, ["tracker", "owner:ven", "status:open"]);
    assert.equal(github.comments.length, 1);
    assert.match(
      github.comments[0].body,
      /^Decision recorded by Ria Super on [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M \(Manila\): Use Clerk Google sign-in only\.\n\n2 attachment\(s\) in the GRIDGO dashboard$/,
    );
    assert.equal(/https?:|X-Amz|evidence\.png/.test(github.comments[0].body), false);

    const row = (await database.query("SELECT repo, issue_number, text, attachment_ids, decided_by, processed_at FROM tracker_decisions")).rows;
    assert.deepEqual(row, [{ repo: "gridgo-api", issue_number: 2, text: "Use Clerk Google sign-in only.", attachment_ids: attachmentIds, decided_by: "user_super", processed_at: null }]);
    const decisionAudit = (await database.query("SELECT actor_id, entity_id, data FROM audit_log WHERE action = 'tracker.decision'")).rows;
    assert.deepEqual(decisionAudit, [{
      actor_id: "user_super", entity_id: "gridgo-api#2",
      data: { detail: { decisionId: decision.id, from: "needs-decision", to: "open", attachmentCount: 2 }, reason: null },
    }]);
    const pinned = (await database.query("SELECT file_id FROM file_references WHERE reference_type = 'tracker_decision' AND reference_id = $1 ORDER BY file_id", [decision.id])).rows;
    assert.deepEqual(pinned.map((pin) => pin.file_id), [...attachmentIds].sort());
    assert.equal((await request(api, `/files/${attachmentIds[0]}`, { method: "DELETE", subject: "clerk_super" })).body.error, "file_in_use");

    // The item no longer needs a decision; a second one is refused.
    assert.equal((await request(api, "/admin/tracker/gridgo-api/2/decisions", { method: "POST", subject: "clerk_super", body: { text: "Again" } })).status, 409);

    // A decision may set another status; an attachment can back only one decision.
    const reused = await request(api, "/admin/tracker/gridgo-web/5/decisions", { method: "POST", subject: "clerk_super", body: { text: "Reuse", attachmentIds: [attachmentIds[0]] } });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error, "tracker_attachment_in_use");
    const blocked = await request(api, "/admin/tracker/gridgo-web/5/decisions", { method: "POST", subject: "clerk_super", body: { text: "Wait for the supplier", status: "blocked" } });
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    assert.equal(blocked.body.status, "blocked");
    assert.equal(github.comments[1].body.endsWith("(Manila): Wait for the supplier"), true);

    // Signed attachment download for the Super Admin.
    const signed = await request(api, `/admin/tracker/decisions/${decision.id}/attachments/${attachmentIds[0]}`, { subject: "clerk_super" });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.attachmentId, attachmentIds[0]);
    assert.equal(signed.body.name, "evidence.png");
    assert.match(signed.body.url, /X-Amz-Signature=/);
    assert.ok(signed.body.expiresAt);
    assert.equal((await request(api, `/admin/tracker/decisions/${decision.id}/attachments/${attachmentIds[0]}`, { subject: "clerk_ops" })).status, 403);
    assert.equal((await request(api, `/admin/tracker/decisions/${decision.id}/attachments/file_other`, { subject: "clerk_super" })).body.error, "tracker_attachment_not_found");
    assert.equal((await request(api, "/admin/tracker/decisions/tdec_missing/attachments/x", { subject: "clerk_super" })).body.error, "tracker_decision_not_found");

    // The list carries the decisions.
    const withDecisions = await request(api, "/admin/tracker", { subject: "clerk_super" });
    assert.equal(withDecisions.body.items.find((item) => item.key === "gridgo-api#2").decisions[0].id, decision.id);

    // firstmate pickup: service token only, constant shape, then marked processed.
    assert.equal((await request(api, "/firstmate/tracker/decisions?unprocessed=1")).status, 401);
    assert.equal((await request(api, "/firstmate/tracker/decisions?unprocessed=1", { bearer: "wrong" })).status, 401);
    assert.equal((await request(api, "/firstmate/tracker/decisions?unprocessed=1", { subject: "clerk_super" })).status, 401);
    const pending = await request(api, "/firstmate/tracker/decisions?unprocessed=1", { bearer: FIRSTMATE_TOKEN });
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.equal(pending.body.decisions.length, 2);
    const picked = pending.body.decisions[0];
    assert.deepEqual(Object.keys(picked).sort(), ["attachments", "decidedAt", "decidedBy", "id", "itemKey", "text"]);
    assert.equal(picked.itemKey, "gridgo-api#2");
    assert.deepEqual(Object.keys(picked.attachments[0]).sort(), ["contentType", "expiresAt", "name", "url"]);
    assert.match(picked.attachments[0].url, /X-Amz-Signature=/);

    const done = await request(api, `/firstmate/tracker/decisions/${picked.id}/processed`, { method: "POST", bearer: FIRSTMATE_TOKEN });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.id, picked.id);
    assert.ok(done.body.processedAt);
    const again = await request(api, `/firstmate/tracker/decisions/${picked.id}/processed`, { method: "POST", bearer: FIRSTMATE_TOKEN });
    assert.equal(again.body.processedAt, done.body.processedAt);
    assert.equal((await request(api, "/firstmate/tracker/decisions/tdec_missing/processed", { method: "POST", bearer: FIRSTMATE_TOKEN })).status, 404);
    const remaining = await request(api, "/firstmate/tracker/decisions?unprocessed=1", { bearer: FIRSTMATE_TOKEN });
    assert.deepEqual(remaining.body.decisions.map((entry) => entry.itemKey), ["gridgo-web#5"]);
  } finally {
    await stopApi(instance);
    github.server.close();
    minio.server.close();
    await database.close?.();
  }
});
