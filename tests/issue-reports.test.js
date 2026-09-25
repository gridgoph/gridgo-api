import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import { createDatabase } from "../src/database.js";
import {
  MAX_SCREENSHOTS,
  createIssueReport,
  isFirstmateIssueReportsRoute,
  isStaffIssueReportsRoute,
  routeFirstmateIssueReports,
  routeIssueReports,
  routeStaffIssueReports,
  sniffImageType,
  validateIssueReport,
} from "../src/issue-reports.js";
import { requestClientKey } from "../src/support-rate-limit.js";

const DATABASE_URL = process.env.DATABASE_URL;
const DESK_ENV = { SUPPORT_DESK_ALLOWED_EMAILS: "gridgo26@gmail.com" };
// Stand-ins for the server's Clerk checks: the signature is Clerk's job, the
// allowlist is the desk's.
const DESK_TOKEN = "desk-session";
const OTHER_TOKEN = "ops-session";
async function verifyClerk(token) {
  if (token === DESK_TOKEN) return { claims: { sub: "user_desk", email: "gridgo26@gmail.com" } };
  if (token === OTHER_TOKEN) return { claims: { sub: "user_ops", email: "ops@gridgo.test" } };
  return { claims: null, status: 401 };
}
async function loadClerkUser() {
  throw new Error("the claim carries the email");
}
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);

test("sniffImageType trusts the bytes, not the name", () => {
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(sniffImageType(JPEG), "image/jpeg");
  assert.equal(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffImageType(Buffer.from("GIF89a..")), "image/gif");
  assert.equal(sniffImageType(Buffer.from("<svg onload=alert(1)>")), null);
});

test("validateIssueReport needs only the issue text", () => {
  const result = validateIssueReport({ issue: "  Orders do not refresh  " });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { issue: "Orders do not refresh", category: null, screenshots: [] });
});

test("validateIssueReport accepts data URLs and rejects unknown categories, non-images and too many files", () => {
  const ok = validateIssueReport({
    issue: "Map is blank",
    category: "bug",
    screenshots: [`data:image/png;base64,${PNG.toString("base64")}`],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.screenshots[0].contentType, "image/png");

  assert.equal(validateIssueReport({ issue: "x", category: "urgent" }).ok, false);
  assert.equal(validateIssueReport({ issue: "   " }).ok, false);
  const svg = validateIssueReport({ issue: "x", screenshots: [Buffer.from("<svg/>").toString("base64")] });
  assert.equal(svg.ok, false);
  assert.equal(svg.code, "invalid_screenshot");
  const many = validateIssueReport({
    issue: "x",
    screenshots: Array.from({ length: MAX_SCREENSHOTS + 1 }, () => PNG.toString("base64")),
  });
  assert.equal(many.ok, false);
});

function fakeStorage() {
  const objects = new Map();
  return {
    objects,
    failNextPut: false,
    async ensureBucket() {},
    async putObject({ key, body, contentType }) {
      if (this.failNextPut) {
        this.failNextPut = false;
        throw Object.assign(new Error("MinIO is down"), { status: 503, code: "minio_unavailable" });
      }
      objects.set(key, { body, contentType });
    },
    async deleteObject(key) { objects.delete(key); },
    async presignGet(key) {
      return { url: `https://files.example/${key}?sig=1`, expiresAt: "2026-09-24T00:05:00.000Z", expiresInSeconds: 300 };
    },
  };
}

async function startRouter(database, storage, env = DESK_ENV) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (response, status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      const handled = await routeIssueReports({
        req, res, pathname: url.pathname, url, send, database, storage, env, verifyClerk, loadClerkUser,
      });
      if (!handled) send(res, 404, { error: "not_found" });
    } catch (error) {
      send(res, 500, { error: "server_error", message: error.message });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function call(base, pathname, { method = "GET", body, token, forwardedFor, cfIp } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body == null ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
      ...(cfIp ? { "CF-Connecting-IP": cfIp } : {}),
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test("a public report with screenshots is stored and read back by the desk", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  const storage = fakeStorage();
  const { server, base } = await startRouter(database, storage);
  t.after(async () => {
    server.close();
    await database.query("TRUNCATE issue_reports CASCADE").catch(() => {});
    await database.close?.();
  });
  await database.query("TRUNCATE issue_reports CASCADE");
  const ip = `198.51.100.${process.pid % 250}`;

  const created = await call(base, "/api/issue-reports", {
    method: "POST",
    forwardedFor: ip,
    body: {
      issue: "Orders need a manual refresh in Operations",
      category: "bug",
      screenshots: [PNG.toString("base64"), `data:image/jpeg;base64,${JPEG.toString("base64")}`],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.screenshots, 2);
  assert.equal(storage.objects.size, 2);
  for (const key of storage.objects.keys()) assert.match(key, /^issue_reports\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}-\d\.(png|jpg)$/);

  assert.equal((await call(base, "/issue-reports")).status, 401);
  assert.equal((await call(base, "/issue-reports", { token: "not.a.token" })).status, 401);

  const other = await call(base, "/issue-reports", { token: OTHER_TOKEN });
  assert.equal(other.status, 403);
  assert.equal(other.body.error, "forbidden");

  const token = DESK_TOKEN;
  const listed = await call(base, "/issue-reports?status=new", { token });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.reports.length, 1);
  const [report] = listed.body.reports;
  assert.equal(report.issue, "Orders need a manual refresh in Operations");
  assert.equal(report.category, "bug");
  assert.deepEqual(report.screenshots.map((shot) => shot.contentType), ["image/png", "image/jpeg"]);
  assert.match(report.screenshots[0].url, /^https:\/\/files\.example\/issue_reports\//);

  assert.equal(report.trackerIssueUrl, null);

  const tracked = await call(base, `/issue-reports/${report.id}`, {
    method: "PATCH", token, body: { status: "tracked", trackerIssueUrl: "https://github.com/gridgoph/gridgo-api/issues/94" },
  });
  assert.equal(tracked.status, 200);
  assert.equal(tracked.body.status, "tracked");
  assert.equal(tracked.body.trackerIssueUrl, "https://github.com/gridgoph/gridgo-api/issues/94");
  assert.equal((await call(base, "/issue-reports?status=tracked", { token })).body.reports.length, 1);

  const published = await call(base, `/issue-reports/${report.id}`, {
    method: "PATCH", token, body: { status: "published", publishedIn: "09-24-2026" },
  });
  assert.equal(published.status, 200);
  assert.equal(published.body.status, "published");
  assert.equal(published.body.publishedIn, "09-24-2026");
  assert.equal(published.body.trackerIssueUrl, "https://github.com/gridgoph/gridgo-api/issues/94", "published keeps the link");
  assert.equal((await call(base, "/issue-reports?status=new", { token })).body.reports.length, 0);
  assert.equal((await call(base, "/issue-reports/00000000-0000-4000-8000-000000000000", { token })).status, 404);
  assert.equal((await call(base, "/issue-reports/not-a-uuid", { token })).status, 404);

  const textOnly = await call(base, "/issue-reports", { method: "POST", forwardedFor: ip, body: { issue: "No screenshot" } });
  assert.equal(textOnly.status, 201);
  assert.equal(textOnly.body.screenshots, 0);

  const rejected = await call(base, "/issue-reports", {
    method: "POST", forwardedFor: ip, body: { issue: "bad file", screenshots: [Buffer.from("hello").toString("base64")] },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, "invalid_screenshot");
});

test("a storage failure leaves no report row and no stray object", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  const storage = fakeStorage();
  const { server, base } = await startRouter(database, storage);
  t.after(async () => {
    server.close();
    await database.query("TRUNCATE issue_reports CASCADE").catch(() => {});
    await database.close?.();
  });
  await database.query("TRUNCATE issue_reports CASCADE");

  const realPut = storage.putObject.bind(storage);
  let puts = 0;
  storage.putObject = async (object) => {
    puts += 1;
    if (puts === 2) throw Object.assign(new Error("MinIO is down"), { status: 503, code: "minio_unavailable" });
    return realPut(object);
  };
  const response = await call(base, "/issue-reports", {
    method: "POST",
    forwardedFor: `203.0.113.${process.pid % 250}`,
    body: { issue: "Two screenshots", screenshots: [PNG.toString("base64"), PNG.toString("base64")] },
  });
  assert.equal(response.status, 503);
  assert.equal(response.body.error, "minio_unavailable");
  assert.equal(storage.objects.size, 0);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM issue_reports")).rows[0].n, 0);
});

test("requestClientKey trusts a well-formed CF-Connecting-IP and falls back otherwise", () => {
  const req = (headers) => ({ headers, socket: { remoteAddress: "172.18.0.5" } });
  assert.equal(requestClientKey(req({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "172.18.0.2" })), "203.0.113.7");
  assert.equal(requestClientKey(req({ "cf-connecting-ip": "2001:db8::1" })), "2001:db8::1");
  assert.equal(requestClientKey(req({ "cf-connecting-ip": "not-an-ip", "x-forwarded-for": "172.18.0.2" })), "172.18.0.2");
  assert.equal(requestClientKey(req({})), "172.18.0.5");
});

test("one sender is limited, and the site-wide daily caps hold across senders", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  const storage = fakeStorage();
  const capped = { ...DESK_ENV, ISSUE_REPORTS_DAILY_LIMIT: "12", ISSUE_REPORTS_DAILY_BYTES: String(PNG.length * 2) };
  const { server, base } = await startRouter(database, storage, capped);
  t.after(async () => {
    server.close();
    await database.query("TRUNCATE issue_reports CASCADE").catch(() => {});
    await database.close?.();
  });
  await database.query("TRUNCATE issue_reports CASCADE");

  const sender = `192.0.2.${(process.pid % 200) + 1}`;
  for (let i = 0; i < 10; i += 1) {
    const ok = await call(base, "/issue-reports", { method: "POST", cfIp: sender, forwardedFor: `10.0.0.${i}`, body: { issue: `spam ${i}` } });
    assert.equal(ok.status, 201, "a spoofed X-Forwarded-For must not reset the sender");
  }
  const limited = await call(base, "/issue-reports", { method: "POST", cfIp: sender, body: { issue: "one too many" } });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "too_many_requests");

  const shot = PNG.toString("base64");
  const other = (n) => `198.18.${process.pid % 200}.${n}`;
  assert.equal((await call(base, "/issue-reports", { method: "POST", cfIp: other(1), body: { issue: "a", screenshots: [shot] } })).status, 201);
  const overBytes = await call(base, "/issue-reports", { method: "POST", cfIp: other(2), body: { issue: "b", screenshots: [shot, shot] } });
  assert.equal(overBytes.status, 429);
  assert.equal(overBytes.body.error, "report_capacity_reached");
  assert.equal(storage.objects.size, 1, "a refused report stores nothing");

  assert.equal((await call(base, "/issue-reports", { method: "POST", cfIp: other(3), body: { issue: "c" } })).status, 201);
  const overCount = await call(base, "/issue-reports", { method: "POST", cfIp: other(4), body: { issue: "d" } });
  assert.equal(overCount.status, 429);
  assert.equal(overCount.body.error, "report_capacity_reached");
  assert.equal((await database.query("SELECT count(*)::int AS n FROM issue_reports")).rows[0].n, 12);
});

test("Operations and Super Admin read and mark reports with their session; other roles cannot", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  const storage = fakeStorage();
  const users = { ops: { id: "u_ops", role: "ops_admin" }, super: { id: "u_super", role: "super_admin" }, client: { id: "u_client", role: "client" } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (response, status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const handled = await routeStaffIssueReports({
      req, res, pathname: url.pathname, url, user: users[req.headers["x-test-user"]] ?? null,
      readBody: async () => parsed, send, database, storage,
    });
    if (!handled) send(res, 404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await database.query("TRUNCATE issue_reports CASCADE").catch(() => {});
    await database.close?.();
  });
  await database.query("TRUNCATE issue_reports CASCADE");
  const staffCall = (who, pathname, init = {}) => fetch(`${base}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(who ? { "X-Test-User": who } : {}) },
  }).then(async (response) => ({ status: response.status, body: await response.json() }));

  assert.equal(isStaffIssueReportsRoute("/api/ops/issue-reports"), true);
  assert.equal(isStaffIssueReportsRoute("/ops/issue-reports/abc/extra"), false);

  const filed = await createIssueReport(database, storage, { issue: "Rider map is blank", category: "bug", screenshots: [] });

  assert.equal((await staffCall(null, "/ops/issue-reports")).status, 401);
  assert.equal((await staffCall("client", "/ops/issue-reports")).status, 403);

  const listed = await staffCall("ops", "/api/ops/issue-reports?status=new");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.counts, { new: 1, tracked: 0, published: 0, dismissed: 0 });
  assert.equal(listed.body.reports[0].issue, "Rider map is blank");
  assert.equal(listed.body.reports[0].trackerIssueUrl, null);

  const patch = (who, body) => staffCall(who, `/ops/issue-reports/${filed.id}`, { method: "PATCH", body: JSON.stringify(body) });
  for (const trackerIssueUrl of [
    "https://github.com/someone-else/gridgo-api/issues/1",
    "http://github.com/gridgoph/gridgo-api/issues/1",
    "https://github.com/gridgoph/gridgo-api/pull/1",
    "https://github.com/gridgoph/gridgo-api/issues/0",
    "https://github.com/gridgoph/gridgo-api/issues/1#issuecomment-2",
    "https://github.com/gridgoph/gridgo-api/issues/1/extra",
    42,
  ]) {
    const refused = await patch("ops", { status: "tracked", trackerIssueUrl });
    assert.equal(refused.status, 400, String(trackerIssueUrl));
    assert.equal(refused.body.error, "invalid_request");
  }
  const badDismiss = await patch("ops", { status: "dismissed", trackerIssueUrl: "https://example.com/1" });
  assert.equal(badDismiss.status, 400, "a bad link is refused, not silently dropped");
  assert.equal((await staffCall("ops", `/ops/issue-reports/${filed.id}`)).body.status, "new", "a refused PATCH changes nothing");

  const link = "https://github.com/gridgoph/gridgo-web/issues/12";
  const tracked = await patch("ops", { status: "tracked", trackerIssueUrl: ` ${link} ` });
  assert.equal(tracked.status, 200);
  assert.equal(tracked.body.status, "tracked");
  assert.equal(tracked.body.trackerIssueUrl, link);
  assert.deepEqual((await staffCall("ops", "/ops/issue-reports")).body.counts, { new: 0, tracked: 1, published: 0, dismissed: 0 });
  assert.equal((await staffCall("ops", "/ops/issue-reports?status=tracked")).body.reports[0].trackerIssueUrl, link);
  const republished = await patch("super", { status: "published", publishedIn: "09-25-2026" });
  assert.equal(republished.body.trackerIssueUrl, link, "omitting the link keeps it");
  assert.equal((await patch("ops", { status: "tracked", trackerIssueUrl: null })).body.trackerIssueUrl, null, "null clears it");
  await patch("ops", { status: "tracked", trackerIssueUrl: link });
  const reopened = await patch("ops", { status: "new", trackerIssueUrl: link });
  assert.equal(reopened.body.status, "new");
  assert.equal(reopened.body.trackerIssueUrl, null, "new clears the link");
  await patch("ops", { status: "tracked", trackerIssueUrl: link });

  const dismissed = await staffCall("super", `/ops/issue-reports/${filed.id}`, {
    method: "PATCH", body: JSON.stringify({ status: "dismissed" }),
  });
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.body.status, "dismissed");
  assert.equal(dismissed.body.trackerIssueUrl, null, "dismissed clears the link");
  assert.deepEqual((await staffCall("ops", "/ops/issue-reports")).body.counts, { new: 0, tracked: 0, published: 0, dismissed: 1 });
  assert.equal((await staffCall("client", `/ops/issue-reports/${filed.id}`, { method: "PATCH", body: JSON.stringify({ status: "new" }) })).status, 403);
});

const FIRSTMATE_TOKEN = "firstmate-issue-token";

test("firstmate reads new reports with signed screenshots and links them with its service token", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  const storage = fakeStorage();
  let env = {};
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (response, status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const handled = await routeFirstmateIssueReports({ req, res, pathname: url.pathname, url, send, database, storage, env });
    if (!handled) send(res, 404, { error: "unrouted" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await database.query("TRUNCATE issue_reports CASCADE").catch(() => {});
    await database.close?.();
  });
  await database.query("TRUNCATE issue_reports CASCADE");

  assert.equal(isFirstmateIssueReportsRoute("/firstmate/issue-reports"), true);
  assert.equal(isFirstmateIssueReportsRoute("/api/firstmate/issue-reports/abc"), true);
  assert.equal(isFirstmateIssueReportsRoute("/firstmate/issue-reports/abc/extra"), false);
  assert.equal(isFirstmateIssueReportsRoute("/firstmate/tracker/decisions"), false);

  const older = await createIssueReport(database, storage, { issue: "Old report", category: null, screenshots: [] }, { now: new Date("2026-09-20T00:00:00Z") });
  await database.query("UPDATE issue_reports SET created_at = '2026-09-20T00:00:00Z' WHERE id = $1", [older.id]);
  const filed = await createIssueReport(database, storage, {
    issue: "Checkout spins forever",
    category: "bug",
    screenshots: [{ bytes: PNG, contentType: "image/png" }, { bytes: JPEG, contentType: "image/jpeg" }],
  });

  // Unset token: the routes do not exist, whatever is presented.
  const hidden = await call(base, "/firstmate/issue-reports?status=new", { token: "anything" });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.error, "not_found");
  assert.equal((await call(base, `/firstmate/issue-reports/${filed.id}`, { method: "PATCH", token: "anything", body: { status: "tracked" } })).status, 404);

  env = { FIRSTMATE_TRACKER_TOKEN: FIRSTMATE_TOKEN };
  for (const token of [undefined, "wrong", `${FIRSTMATE_TOKEN}x`, DESK_TOKEN]) {
    const refused = await call(base, "/firstmate/issue-reports", { token });
    assert.equal(refused.status, 401, String(token));
    assert.equal(refused.body.error, "unauthorized");
  }
  assert.equal((await call(base, `/firstmate/issue-reports/${filed.id}`, { method: "PATCH", token: "wrong", body: { status: "tracked" } })).status, 401);

  const listed = await call(base, "/firstmate/issue-reports?status=new", { token: FIRSTMATE_TOKEN });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.counts, { new: 2, tracked: 0, published: 0, dismissed: 0 });
  assert.deepEqual(listed.body.reports.map((report) => report.issue), ["Checkout spins forever", "Old report"]);
  const [report] = listed.body.reports;
  assert.equal(report.trackerIssueUrl, null);
  assert.deepEqual(report.screenshots.map((shot) => shot.contentType), ["image/png", "image/jpeg"]);
  for (const shot of report.screenshots) {
    assert.match(shot.url, /^https:\/\/files\.example\/issue_reports\/.+\?sig=1$/);
    assert.equal(shot.expiresAt, "2026-09-24T00:05:00.000Z");
  }
  const recent = await call(base, "/api/firstmate/issue-reports?status=new&since=2026-09-21&limit=5", { token: FIRSTMATE_TOKEN });
  assert.deepEqual(recent.body.reports.map((entry) => entry.id), [filed.id]);
  assert.equal((await call(base, "/firstmate/issue-reports?status=new&limit=1", { token: FIRSTMATE_TOKEN })).body.reports.length, 1);
  assert.equal((await call(base, "/firstmate/issue-reports?status=open", { token: FIRSTMATE_TOKEN })).status, 400);

  const one = await call(base, `/firstmate/issue-reports/${filed.id}`, { token: FIRSTMATE_TOKEN });
  assert.equal(one.status, 200);
  assert.equal(one.body.screenshots.length, 2);
  assert.equal((await call(base, "/firstmate/issue-reports/00000000-0000-4000-8000-000000000000", { token: FIRSTMATE_TOKEN })).status, 404);

  const refusedLink = await call(base, `/firstmate/issue-reports/${filed.id}`, {
    method: "PATCH", token: FIRSTMATE_TOKEN, body: { status: "tracked", trackerIssueUrl: "https://github.com/gridgoph/gridgo-api/issues/abc" },
  });
  assert.equal(refusedLink.status, 400);
  assert.equal(refusedLink.body.error, "invalid_request");

  const link = "https://github.com/gridgoph/gridgo-api/issues/95";
  const tracked = await call(base, `/firstmate/issue-reports/${filed.id}`, {
    method: "PATCH", token: FIRSTMATE_TOKEN, body: { status: "tracked", trackerIssueUrl: link },
  });
  assert.equal(tracked.status, 200);
  assert.equal(tracked.body.status, "tracked");
  assert.equal(tracked.body.trackerIssueUrl, link);
  assert.equal(tracked.body.screenshots.length, 2);
  const published = await call(base, `/firstmate/issue-reports/${filed.id}`, {
    method: "PATCH", token: FIRSTMATE_TOKEN, body: { status: "published", publishedIn: "09-25-2026" },
  });
  assert.equal(published.body.trackerIssueUrl, link);
  assert.equal(published.body.publishedIn, "09-25-2026");
  const dismissed = await call(base, `/firstmate/issue-reports/${older.id}`, {
    method: "PATCH", token: FIRSTMATE_TOKEN, body: { status: "dismissed", trackerIssueUrl: link },
  });
  assert.equal(dismissed.body.trackerIssueUrl, null);
  assert.deepEqual(
    (await call(base, "/firstmate/issue-reports", { token: FIRSTMATE_TOKEN })).body.counts,
    { new: 0, tracked: 0, published: 1, dismissed: 1 },
  );
});

const ISSUER = "https://casual-crab-9.clerk.accounts.dev";

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function startApi(extraEnv) {
  const port = await freePort();
  const api = `http://127.0.0.1:${port}`;
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      DATABASE_URL,
      CLERK_SECRET_KEY: "test-only-placeholder",
      CLERK_ISSUER: ISSUER,
      CLERK_AUTHORIZED_PARTIES: "http://localhost:19006",
      CLERK_JWT_KEY: publicKey.export({ type: "spki", format: "pem" }),
      HOST: "127.0.0.1",
      PORT: String(port),
      GRIDGO_LIFECYCLE_INTERVAL_MS: "3600000",
      GRIDGO_PUSH_TOKEN_CHECK_INTERVAL_MS: "0",
      GITHUB_TRACKER_TOKEN: "",
      GITHUB_TRACKER_REPOS: "",
      FIRSTMATE_TRACKER_TOKEN: "",
      MINIO_PUBLIC_URL: "http://minio.test:9000",
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
      if ((await fetch(`${api}/health`)).ok) return { api, child };
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

test("the running API serves the firstmate issue-report routes only with FIRSTMATE_TRACKER_TOKEN", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  t.after(async () => {
    await database.query("TRUNCATE issue_reports CASCADE").catch(() => {});
    await database.close?.();
  });
  await database.query("TRUNCATE issue_reports CASCADE");
  const filed = await createIssueReport(database, fakeStorage(), {
    issue: "Rider app freezes on pickup", category: "bug", screenshots: [{ bytes: PNG, contentType: "image/png" }],
  });

  let instance = await startApi({});
  try {
    const hidden = await call(instance.api, "/firstmate/issue-reports?status=new", { token: FIRSTMATE_TOKEN });
    assert.equal(hidden.status, 404);
    const hiddenPatch = await call(instance.api, `/firstmate/issue-reports/${filed.id}`, {
      method: "PATCH", token: FIRSTMATE_TOKEN, body: { status: "tracked" },
    });
    assert.equal(hiddenPatch.status, 404);
  } finally {
    await stopApi(instance);
  }

  instance = await startApi({ FIRSTMATE_TRACKER_TOKEN: FIRSTMATE_TOKEN });
  try {
    const { api } = instance;
    assert.equal((await call(api, "/firstmate/issue-reports")).status, 401);
    assert.equal((await call(api, "/firstmate/issue-reports", { token: "wrong" })).status, 401);
    assert.equal((await call(api, `/firstmate/issue-reports/${filed.id}`, { method: "PATCH", token: "wrong", body: { status: "tracked" } })).status, 401);

    const listed = await call(api, "/firstmate/issue-reports?status=new", { token: FIRSTMATE_TOKEN });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.counts, { new: 1, tracked: 0, published: 0, dismissed: 0 });
    const [shot] = listed.body.reports[0].screenshots;
    assert.match(shot.url, /^http:\/\/minio\.test:9000\/[^/]+\/issue_reports\//);
    assert.match(shot.url, /X-Amz-Signature=/);
    assert.ok(shot.expiresAt);

    const link = "https://github.com/gridgoph/gridgo-api/issues/96";
    const tracked = await call(api, `/firstmate/issue-reports/${filed.id}`, {
      method: "PATCH", token: FIRSTMATE_TOKEN, body: { status: "tracked", trackerIssueUrl: link },
    });
    assert.equal(tracked.status, 200, JSON.stringify(tracked.body));
    assert.equal(tracked.body.trackerIssueUrl, link);
    const read = await call(api, `/api/firstmate/issue-reports/${filed.id}`, { token: FIRSTMATE_TOKEN });
    assert.equal(read.body.status, "tracked");
    assert.equal(read.body.trackerIssueUrl, link);
  } finally {
    await stopApi(instance);
  }
});
