import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import { resolveAuthorizationContext } from "../src/authorization-context.js";
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

  assert.equal(Object.hasOwn(report, "trackerIssueUrl"), false);

  const tracked = await call(base, `/issue-reports/${report.id}`, {
    method: "PATCH", token, body: { status: "tracked", trackerIssueUrl: "https://github.com/gridgoph/gridgo-api/issues/94" },
  });
  assert.equal(tracked.status, 403);
  assert.equal(tracked.body.error, "tracker_issue_url_forbidden");
  const link = "https://github.com/gridgoph/gridgo-api/issues/94";
  await database.query("UPDATE issue_reports SET status = 'tracked', tracker_issue_url = $2, issue = $3 WHERE id = $1",
    [report.id, link, `Details: ${link}`]);
  const deskList = await call(base, "/issue-reports?status=tracked", { token });
  assert.equal(Object.hasOwn(deskList.body.reports[0], "trackerIssueUrl"), false);
  assert.doesNotMatch(JSON.stringify(deskList.body), /github/i);
  const deskDetail = await call(base, `/issue-reports/${report.id}`, { token });
  assert.equal(Object.hasOwn(deskDetail.body, "trackerIssueUrl"), false);
  assert.doesNotMatch(JSON.stringify(deskDetail.body), /github/i);
  assert.equal((await call(base, "/issue-reports?status=tracked", { token })).body.reports.length, 1);

  const published = await call(base, `/issue-reports/${report.id}`, {
    method: "PATCH", token, body: { status: "published", publishedIn: "09-24-2026" },
  });
  assert.equal(published.status, 200);
  assert.equal(published.body.status, "published");
  assert.equal(published.body.publishedIn, "09-24-2026");
  assert.equal(Object.hasOwn(published.body, "trackerIssueUrl"), false);
  assert.doesNotMatch(JSON.stringify(published.body), /github/i);
  for (const status of ["dismissed", "new", "tracked"]) {
    const updated = await call(base, `/issue-reports/${report.id}`, { method: "PATCH", token, body: { status } });
    assert.equal(updated.status, 200);
    assert.equal(Object.hasOwn(updated.body, "trackerIssueUrl"), false);
    assert.equal((await database.query("SELECT tracker_issue_url FROM issue_reports WHERE id = $1", [report.id])).rows[0].tracker_issue_url, link);
  }
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
  // Memberships, rather than a stale legacy role, govern link access.
  for (const user of Object.values(users)) {
    const role = user.role;
    resolveAuthorizationContext({ userRoleMemberships: [{ userId: user.id, role }] }, user);
    user.role = role === "super_admin" ? "ops_admin" : "super_admin";
  }
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
  assert.deepEqual(listed.body.counts, { new: 1, tracked: 0, published: 0, dismissed: 0, priorities: 0 });
  assert.equal(listed.body.reports[0].issue, "Rider map is blank");
  assert.equal(Object.hasOwn(listed.body.reports[0], "trackerIssueUrl"), false);

  const patch = (who, body) => staffCall(who, `/ops/issue-reports/${filed.id}`, { method: "PATCH", body: JSON.stringify(body) });
  const pinned = await patch("ops", { priority: true });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
  assert.equal(pinned.body.priority, true);
  assert.equal(pinned.body.status, "new");
  assert.equal((await staffCall("super", "/ops/issue-reports?priority=true")).body.reports[0].id, filed.id);
  assert.equal((await staffCall("ops", "/ops/issue-reports")).body.counts.priorities, 1);
  assert.equal((await patch("ops", { priority: "true" })).status, 400);
  assert.equal((await patch("client", { priority: false })).status, 403);
  assert.equal((await patch("super", { priority: false })).body.priority, false);
  assert.equal((await staffCall("ops", "/ops/issue-reports?priority=true")).body.reports.length, 0);
  for (const trackerIssueUrl of [
    "https://github.com/someone-else/gridgo-api/issues/1",
    "http://github.com/gridgoph/gridgo-api/issues/1",
    "https://github.com/gridgoph/gridgo-api/pull/1",
    "https://github.com/gridgoph/gridgo-api/issues/0",
    "https://github.com/gridgoph/gridgo-api/issues/1#issuecomment-2",
    "https://github.com/gridgoph/gridgo-api/issues/1/extra",
    42,
  ]) {
    const refused = await patch("super", { status: "tracked", trackerIssueUrl });
    assert.equal(refused.status, 400, String(trackerIssueUrl));
    assert.equal(refused.body.error, "invalid_request");
  }
  const badDismiss = await patch("super", { status: "dismissed", trackerIssueUrl: "https://example.com/1" });
  assert.equal(badDismiss.status, 400, "a bad link is refused, not silently dropped");
  assert.equal((await staffCall("ops", `/ops/issue-reports/${filed.id}`)).body.status, "new", "a refused PATCH changes nothing");

  const link = "https://github.com/gridgoph/gridgo-web/issues/12";
  const tracked = await patch("super", { status: "tracked", trackerIssueUrl: ` ${link} ` });
  assert.equal(tracked.status, 200);
  assert.equal(tracked.body.status, "tracked");
  assert.equal(tracked.body.trackerIssueUrl, link);
  assert.deepEqual((await staffCall("ops", "/ops/issue-reports")).body.counts, { new: 0, tracked: 1, published: 0, dismissed: 0, priorities: 0 });
  assert.equal((await staffCall("super", "/ops/issue-reports?status=tracked")).body.reports[0].trackerIssueUrl, link);
  assert.equal((await staffCall("super", `/ops/issue-reports/${filed.id}`)).body.trackerIssueUrl, link);
  for (const trackerIssueUrl of [link, null, "", 42]) {
    for (const body of [{ status: "tracked", trackerIssueUrl }, { priority: true, trackerIssueUrl }]) {
      const refused = await patch("ops", body);
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error, "tracker_issue_url_forbidden");
    }
  }
  await database.query("UPDATE issue_reports SET issue = $2 WHERE id = $1", [filed.id, `See ${link} and https://api.github.com/repos/gridgoph/gridgo-api`]);
  for (const response of [
    await staffCall("ops", "/ops/issue-reports"),
    await staffCall("ops", `/api/ops/issue-reports/${filed.id}`),
    await patch("ops", { priority: true }),
  ]) {
    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(response.body), /github|trackerIssueUrl/i);
  }
  for (const status of ["published", "dismissed", "new", "tracked"]) {
    const updated = await patch("ops", { status, publishedIn: "2026-10-19" });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.status, status);
    assert.equal(updated.body.publishedIn, status === "published" ? "2026-10-19" : null);
    assert.equal(Object.hasOwn(updated.body, "trackerIssueUrl"), false);
    assert.doesNotMatch(JSON.stringify(updated.body), /github/i);
    assert.equal((await staffCall("super", `/ops/issue-reports/${filed.id}`)).body.trackerIssueUrl, link);
    assert.equal((await database.query("SELECT tracker_issue_url FROM issue_reports WHERE id = $1", [filed.id])).rows[0].tracker_issue_url, link);
  }
  const labelUpdate = await patch("ops", { status: "published", publishedIn: `Release ${link}` });
  assert.equal(labelUpdate.body.publishedIn, "Release [link hidden]");
  assert.equal((await staffCall("super", `/ops/issue-reports/${filed.id}`)).body.publishedIn, `Release ${link}`);
  await patch("ops", { status: "tracked" });
  const linkedPin = await patch("super", { priority: true });
  assert.equal(linkedPin.body.trackerIssueUrl, link);
  assert.equal(linkedPin.body.status, "tracked");
  await patch("ops", { priority: false });
  const republished = await patch("super", { status: "published", publishedIn: "09-25-2026" });
  assert.equal(republished.body.trackerIssueUrl, link, "omitting the link keeps it");
  assert.equal((await patch("super", { status: "tracked", trackerIssueUrl: null })).body.trackerIssueUrl, null, "null clears it");
  await patch("super", { status: "tracked", trackerIssueUrl: link });
  const reopened = await patch("super", { status: "new", trackerIssueUrl: link });
  assert.equal(reopened.body.status, "new");
  assert.equal(reopened.body.trackerIssueUrl, null, "new clears the link");
  await patch("super", { status: "tracked", trackerIssueUrl: link });

  const dismissed = await staffCall("super", `/ops/issue-reports/${filed.id}`, {
    method: "PATCH", body: JSON.stringify({ status: "dismissed" }),
  });
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.body.status, "dismissed");
  assert.equal(dismissed.body.trackerIssueUrl, null, "dismissed clears the link");
  assert.deepEqual((await staffCall("ops", "/ops/issue-reports")).body.counts, { new: 0, tracked: 0, published: 0, dismissed: 1, priorities: 0 });
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
  assert.deepEqual(listed.body.counts, { new: 2, tracked: 0, published: 0, dismissed: 0, priorities: 0 });
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
  assert.equal((await call(base, "/firstmate/issue-reports?status=published", { token: FIRSTMATE_TOKEN })).body.reports[0].trackerIssueUrl, link);
  assert.equal((await call(base, `/firstmate/issue-reports/${filed.id}`, { token: FIRSTMATE_TOKEN })).body.trackerIssueUrl, link);
  const dismissed = await call(base, `/firstmate/issue-reports/${older.id}`, {
    method: "PATCH", token: FIRSTMATE_TOKEN, body: { status: "dismissed", trackerIssueUrl: link },
  });
  assert.equal(dismissed.body.trackerIssueUrl, null);
  assert.deepEqual(
    (await call(base, "/firstmate/issue-reports", { token: FIRSTMATE_TOKEN })).body.counts,
    { new: 0, tracked: 0, published: 1, dismissed: 1, priorities: 0 },
  );
});

test("the list pages with before=<last id shown>, never repeating or skipping a report", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  const storage = fakeStorage();
  const env = { FIRSTMATE_TRACKER_TOKEN: FIRSTMATE_TOKEN };
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

  // Seven reports, three of them filed in the same instant, plus one already handled.
  const ids = [];
  for (let index = 0; index < 7; index += 1) {
    const filed = await createIssueReport(database, storage, { issue: `Report ${index}`, category: null, screenshots: [] });
    const at = index < 3 ? "2026-09-20T00:00:00Z" : `2026-09-2${index - 2}T00:00:00Z`;
    await database.query("UPDATE issue_reports SET created_at = $2 WHERE id = $1", [filed.id, at]);
    ids.push(filed.id);
  }
  const handled = await createIssueReport(database, storage, { issue: "Handled", category: null, screenshots: [] });
  await database.query("UPDATE issue_reports SET status = 'dismissed' WHERE id = $1", [handled.id]);

  const everything = await call(base, "/firstmate/issue-reports?status=new", { token: FIRSTMATE_TOKEN });
  assert.equal(everything.body.reports.length, 7);
  assert.deepEqual(Object.keys(everything.body).sort(), ["counts", "reports", "triageCounts"]);

  const paged = [];
  let before = null;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await call(
      base,
      `/firstmate/issue-reports?status=new&limit=2${before ? `&before=${before}` : ""}`,
      { token: FIRSTMATE_TOKEN },
    );
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.counts, { new: 7, tracked: 0, published: 0, dismissed: 1, priorities: 0 });
    if (!page.body.reports.length) break;
    assert.ok(page.body.reports.length <= 2);
    paged.push(...page.body.reports.map((report) => report.id));
    before = paged.at(-1);
  }
  assert.deepEqual(paged, everything.body.reports.map((report) => report.id));
  assert.equal(new Set(paged).size, 7);

  // Priority paging spans statuses and can find pins older than the first normal page.
  await database.query("UPDATE issue_reports SET priority = true WHERE id = ANY($1::uuid[])", [[ids[0], ids[1], handled.id]]);
  const firstPins = await call(base, "/firstmate/issue-reports?priority=true&limit=2", {token:FIRSTMATE_TOKEN});
  assert.equal(firstPins.body.counts.priorities, 3);
  assert.equal(firstPins.body.reports[0].id, handled.id);
  const nextPins = await call(base, `/firstmate/issue-reports?priority=true&limit=2&before=${firstPins.body.reports.at(-1).id}`, {token:FIRSTMATE_TOKEN});
  assert.equal(nextPins.body.reports.length, 1);
  assert.equal(new Set([...firstPins.body.reports, ...nextPins.body.reports].map(item => item.id)).size, 3);
  assert.equal((await call(base, "/firstmate/issue-reports?priority=invalid", {token:FIRSTMATE_TOKEN})).status, 400);

  // The cursor may be a report that has since left the tab.
  const afterHandled = await call(base, `/firstmate/issue-reports?status=new&before=${handled.id}`, { token: FIRSTMATE_TOKEN });
  assert.equal(afterHandled.status, 200);
  assert.equal(afterHandled.body.reports.length, 7);

  for (const bad of ["nope", "00000000-0000-4000-8000-000000000000"]) {
    const refused = await call(base, `/firstmate/issue-reports?status=new&before=${bad}`, { token: FIRSTMATE_TOKEN });
    assert.equal(refused.status, 400, bad);
    assert.equal(refused.body.error, "invalid_request");
  }
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
    assert.deepEqual(listed.body.counts, { new: 1, tracked: 0, published: 0, dismissed: 0, priorities: 0 });
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

test("a new public report notifies each Operations and Super Admin membership once", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  const prefix = `rpt_${process.pid}_${Date.now().toString(36)}`;
  const people = [
    { id: `${prefix}_client`, role: "client" },
    { id: `${prefix}_supplier`, role: "supplier" },
    { id: `${prefix}_rider`, role: "rider" },
    { id: `${prefix}_ops`, role: "ops_admin" },
    { id: `${prefix}_super`, role: "super_admin" },
  ];
  const occurrenceKeys = [];
  async function cleanup() {
    const filed = await database.query(`SELECT id FROM issue_reports WHERE issue = $1`, [
      "The reports desk does not refresh.",
    ]);
    const keys = [...occurrenceKeys, ...filed.rows.map((row) => row.id)];
    if (keys.length) {
      await database.query(
        `DELETE FROM notifications WHERE data->>'occurrenceKey' = ANY($1::text[])`,
        [keys],
      );
    }
    await database.query(`DELETE FROM issue_reports WHERE issue = $1`, ["The reports desk does not refresh."]);
    await database.query(`DELETE FROM notifications WHERE user_id LIKE $1`, [`${prefix}%`]);
    await database.query(`DELETE FROM user_role_memberships WHERE user_id LIKE $1`, [`${prefix}%`]);
    await database.query(`DELETE FROM users WHERE id LIKE $1`, [`${prefix}%`]);
  }
  t.after(async () => {
    await cleanup();
    await database.close();
  });
  await cleanup();
  for (const person of people) {
    await database.query(
      `INSERT INTO users (id, clerk_user_id, email, name, role, account_type, verification_status, created_at, position, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 0, '{}')`,
      [
        person.id,
        `${person.id}_clerk`,
        `${person.id}@gridgo.test`,
        person.role,
        person.role,
        person.role === "client" ? "individual" : null,
        person.role === "supplier" || person.role === "rider" ? "approved" : null,
      ],
    );
    await database.query(
      `INSERT INTO user_role_memberships (user_id, role, created_at) VALUES ($1, $2, now())`,
      [person.id, person.role],
    );
  }
  const instance = await startApi({});
  t.after(() => stopApi(instance));
  const filed = await call(instance.api, "/issue-reports", {
    method: "POST",
    cfIp: "203.0.113.29",
    body: { issue: "The reports desk does not refresh.", category: "bug" },
  });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  occurrenceKeys.push(filed.body.id);
  const notes = await database.query(
    `SELECT user_id, type, order_id, data->>'appRole' AS app_role, data->>'occurrenceKey' AS occurrence_key
     FROM notifications WHERE data->>'occurrenceKey' = $1`,
    [filed.body.id],
  );
  const rows = notes.rows;
  assert.equal(rows.filter((row) => row.user_id === `${prefix}_ops` && row.app_role === "ops_admin" && row.type === "ops_issue_report_filed").length, 1);
  assert.equal(rows.filter((row) => row.user_id === `${prefix}_super` && row.app_role === "super_admin" && row.type === "ops_issue_report_filed").length, 1);
  assert.equal(rows.filter((row) => [`${prefix}_client`, `${prefix}_supplier`, `${prefix}_rider`].includes(row.user_id)).length, 0);
  assert.equal(
    rows.filter((row) => ["client", "supplier", "rider"].includes(row.app_role)).length,
    0,
    "ops_issue_report_filed would reach a party app",
  );
  assert.ok(rows.every((row) => row.order_id == null && row.occurrence_key === filed.body.id));
  const pairs = rows.map((row) => `${row.user_id}:${row.app_role}`);
  assert.equal(new Set(pairs).size, pairs.length);
});

test("report notification rollback removes uploaded screenshots and metadata", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  const storage = fakeStorage();
  const issue = `report rollback ${crypto.randomUUID()}`;
  let reportId;
  let delivered = false;
  t.after(async () => {
    await database.query("DELETE FROM issue_reports WHERE issue=$1", [issue]);
    await database.close();
  });
  await assert.rejects(createIssueReport(database, storage, {
    issue, category: "bug", screenshots: [{ bytes: PNG, contentType: "image/png" }],
  }, {
    notifyStaff: async (event) => {
      reportId = event.id;
      assert.equal(database.inWriteTransaction(), true);
      assert.equal((await database.query("SELECT report_id FROM issue_report_screenshots WHERE report_id=$1", [reportId])).rowCount, 1);
      database.afterCommit(() => { delivered = true; });
      throw new Error("injected notification failure");
    },
  }), /injected notification failure/);
  assert.ok(reportId);
  assert.equal((await database.query("SELECT id FROM issue_reports WHERE id=$1", [reportId])).rowCount, 0);
  assert.equal((await database.query("SELECT report_id FROM issue_report_screenshots WHERE report_id=$1", [reportId])).rowCount, 0);
  assert.equal(storage.objects.size, 0);
  assert.equal(delivered, false);
});

test("staff triage and AI review are separate: filters, permissions, and AI never overwriting a human verdict", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  const storage = fakeStorage();
  const users = { ops: { id: "u_triage_ops", role: "ops_admin" }, super: { id: "u_triage_super", role: "super_admin" }, client: { id: "u_triage_client", role: "client" } };
  for (const user of Object.values(users)) resolveAuthorizationContext({ userRoleMemberships: [{ userId: user.id, role: user.role }] }, user);
  const env = { ...DESK_ENV, FIRSTMATE_TRACKER_TOKEN: FIRSTMATE_TOKEN };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (response, status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    let handled;
    if (isStaffIssueReportsRoute(url.pathname)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      handled = await routeStaffIssueReports({
        req, res, pathname: url.pathname, url, user: users[req.headers["x-test-user"]] ?? null,
        readBody: async () => parsed, send, database, storage,
      });
    } else if (isFirstmateIssueReportsRoute(url.pathname)) {
      handled = await routeFirstmateIssueReports({ req, res, pathname: url.pathname, url, send, database, storage, env });
    } else {
      handled = await routeIssueReports({ req, res, pathname: url.pathname, url, send, database, storage, env, verifyClerk, loadClerkUser });
    }
    if (!handled) send(res, 404, { error: "unrouted" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await database.query("TRUNCATE issue_reports CASCADE").catch(() => {});
    await database.query("DELETE FROM users WHERE id = $1", [users.super.id]).catch(() => {});
    await database.close?.();
  });
  await database.query("TRUNCATE issue_reports CASCADE");
  await database.query("DELETE FROM users WHERE id = $1", [users.super.id]);
  await database.query(
    `INSERT INTO users (id, clerk_user_id, email, name, role, created_at, position, data)
     VALUES ($1, 'clerk_triage_super', 'triage-super@gridgo.test', 'Triage Admin', 'super_admin', now(), 0, '{}')`,
    [users.super.id],
  );
  const staff = (who, pathname, body) => fetch(`${base}${pathname}`, {
    method: body ? "PATCH" : "GET",
    headers: { "Content-Type": "application/json", ...(who ? { "X-Test-User": who } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  const firstmate = (pathname, body) => call(base, pathname, { token: FIRSTMATE_TOKEN, ...(body ? { method: "PATCH", body } : {}) });
  const ids = async (who, query) => {
    const listed = await staff(who, `/ops/issue-reports${query}`);
    assert.equal(listed.status, 200, `${query}: ${JSON.stringify(listed.body)}`);
    return listed.body.reports.map((report) => report.id);
  };

  const filed = [];
  for (const [index, issue] of ["Checkout map is blank", "BUY FOLLOWERS NOW", "Checkout map blank again", "Add dark mode"].entries()) {
    const report = await createIssueReport(database, storage, { issue, category: index === 3 ? "feature" : "bug", screenshots: [] });
    await database.query("UPDATE issue_reports SET created_at = $2 WHERE id = $1", [report.id, `2026-10-0${index + 1}T00:00:00Z`]);
    filed.push(report.id);
  }
  const [a, b, c, d] = filed;

  const fresh = await staff("ops", `/ops/issue-reports/${a}`);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.category, "bug", "the reporter's category stays");
  assert.deepEqual(fresh.body.triage, { validity: "unreviewed", category: null, labels: [], duplicateOf: null, triagedBy: null, triagedAt: null });
  assert.equal(fresh.body.aiReview, null);
  const initial = await staff("ops", "/ops/issue-reports");
  assert.deepEqual(initial.body.counts, { new: 4, tracked: 0, published: 0, dismissed: 0, priorities: 0 });
  assert.deepEqual(initial.body.triageCounts, {
    validity: { unreviewed: 4, valid: 0, spam: 0, duplicate: 0 }, aiReviewed: 0, aiAwaitingHuman: 0, labels: [],
  });

  // Who may write which half.
  assert.equal((await staff("client", `/ops/issue-reports/${a}`, { triage: { validity: "valid" } })).status, 403);
  assert.equal((await staff(null, `/ops/issue-reports/${a}`, { triage: { validity: "valid" } })).status, 401);
  for (const response of [
    await call(base, `/issue-reports/${a}`, { method: "PATCH", token: DESK_TOKEN, body: { triage: { validity: "valid" } } }),
    await call(base, `/issue-reports/${a}`, { method: "PATCH", token: DESK_TOKEN, body: { aiReview: { validity: "valid" } } }),
    await firstmate(`/firstmate/issue-reports/${a}`, { triage: { validity: "valid" } }),
    await staff("ops", `/ops/issue-reports/${a}`, { aiReview: { validity: "valid" } }),
    await staff("super", `/ops/issue-reports/${a}`, { aiReview: { validity: "valid" } }),
  ]) {
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error, "forbidden");
  }

  for (const triage of [
    { validity: "maybe" }, { category: "urgent" }, { labels: "checkout" }, { labels: ["has space"] }, { labels: ["-dash"] },
    { labels: ["x".repeat(33)] }, { labels: Array.from({ length: 11 }, (_, n) => `l${n}`) }, { labels: [7] },
    { duplicateOf: a, validity: "duplicate" }, { duplicateOf: b, validity: "valid" }, { duplicateOf: b },
    { duplicateOf: "00000000-0000-4000-8000-000000000000", validity: "duplicate" }, { duplicateOf: "nope", validity: "duplicate" },
    { reason: "x" }, {}, null, ["valid"],
  ]) {
    const refused = await staff("ops", `/ops/issue-reports/${a}`, { triage });
    assert.equal(refused.status, 400, JSON.stringify(triage));
    assert.equal(refused.body.error, "invalid_request");
  }
  for (const body of [{ triage: { validity: "valid" }, status: "dismissed" }, { triage: { validity: "valid" }, priority: true }]) {
    assert.equal((await staff("ops", `/ops/issue-reports/${a}`, body)).status, 400, JSON.stringify(body));
  }
  for (const aiReview of [
    { validity: "unreviewed" }, {}, { validity: "spam", note: "x".repeat(501) }, { validity: "spam", note: 5 },
    { validity: "valid", duplicateOf: b }, { validity: "spam", confidence: 1 }, { validity: "valid", labels: ["Bad Label"] },
  ]) {
    assert.equal((await firstmate(`/firstmate/issue-reports/${a}`, { aiReview })).status, 400, JSON.stringify(aiReview));
  }
  assert.equal((await firstmate(`/firstmate/issue-reports/${a}`, { aiReview: { validity: "spam" }, status: "dismissed" })).status, 400);
  assert.equal((await staff("ops", "/ops/issue-reports/00000000-0000-4000-8000-000000000000", { triage: { validity: "valid" } })).status, 404);
  assert.equal((await firstmate("/firstmate/issue-reports/00000000-0000-4000-8000-000000000000", { aiReview: { validity: "valid" } })).status, 404);
  const untouched = (await database.query("SELECT validity, triaged_at, ai_reviewed_at FROM issue_reports WHERE id = $1", [a])).rows[0];
  assert.deepEqual(untouched, { validity: "unreviewed", triaged_at: null, ai_reviewed_at: null }, "refused writes change nothing");

  // AI goes first and suggests spam; the human verdict stays unreviewed.
  const link = "https://github.com/gridgoph/gridgo-web/issues/31";
  const suggested = await firstmate(`/firstmate/issue-reports/${a}`, {
    aiReview: { validity: "spam", category: "other", labels: ["Promo", "promo"], note: ` Looks like an ad; see ${link} ` },
  });
  assert.equal(suggested.status, 200, JSON.stringify(suggested.body));
  assert.equal(suggested.body.triage.validity, "unreviewed");
  assert.equal(suggested.body.triage.triagedAt, null);
  assert.deepEqual({ ...suggested.body.aiReview, reviewedAt: undefined }, {
    reviewedAt: undefined, validity: "spam", category: "other", labels: ["promo"], duplicateOf: null,
    note: `Looks like an ad; see ${link}`, outcome: "pending",
  });
  assert.equal((await staff("ops", `/ops/issue-reports/${a}`)).body.aiReview.note, "Looks like an ad; see [link hidden]");
  assert.equal((await staff("super", `/ops/issue-reports/${a}`)).body.aiReview.note, `Looks like an ad; see ${link}`);
  assert.deepEqual(await ids("ops", "?aiReviewed=true"), [a]);
  assert.deepEqual(await ids("ops", "?aiReviewed=false"), [d, c, b]);
  assert.deepEqual((await staff("ops", "/ops/issue-reports")).body.triageCounts.aiAwaitingHuman, 1);

  // A person overrides it.
  const triaged = await staff("super", `/ops/issue-reports/${a}`, { triage: { validity: "valid", category: "bug", labels: [" Checkout", "map", "checkout"] } });
  assert.equal(triaged.status, 200, JSON.stringify(triaged.body));
  assert.equal(triaged.body.triage.validity, "valid");
  assert.equal(triaged.body.triage.category, "bug");
  assert.deepEqual(triaged.body.triage.labels, ["checkout", "map"]);
  assert.deepEqual(triaged.body.triage.triagedBy, { id: users.super.id, name: "Triage Admin" });
  assert.ok(triaged.body.triage.triagedAt);
  assert.equal(triaged.body.aiReview.outcome, "overridden");
  assert.equal(triaged.body.aiReview.validity, "spam", "the AI suggestion is kept beside the verdict");
  const human = (await database.query("SELECT validity, triage_category, labels, triaged_by, triaged_at FROM issue_reports WHERE id = $1", [a])).rows[0];

  // AI reviews again, agreeing this time: the human columns do not move.
  const agreed = await firstmate(`/firstmate/issue-reports/${a}`, { aiReview: { validity: "valid", category: "bug", labels: ["checkout"] } });
  assert.equal(agreed.status, 200);
  assert.equal(agreed.body.aiReview.outcome, "confirmed");
  assert.equal(agreed.body.aiReview.note, null, "each AI review replaces the whole suggestion");
  assert.deepEqual(agreed.body.aiReview.labels, ["checkout"]);
  // ...nor when it disagrees, nor through the workflow route.
  await firstmate(`/firstmate/issue-reports/${a}`, { aiReview: { validity: "duplicate", duplicateOf: c, category: "feature", labels: [] } });
  const tracked = await firstmate(`/firstmate/issue-reports/${a}`, { status: "tracked", trackerIssueUrl: link });
  assert.equal(tracked.status, 200);
  assert.equal(tracked.body.aiReview.duplicateOf, c);
  assert.equal(tracked.body.aiReview.outcome, "overridden");
  assert.deepEqual(tracked.body.triage, {
    validity: "valid", category: "bug", labels: ["checkout", "map"], duplicateOf: null,
    triagedBy: { id: users.super.id, name: "Triage Admin" }, triagedAt: triaged.body.triage.triagedAt,
  });
  assert.deepEqual((await database.query("SELECT validity, triage_category, labels, triaged_by, triaged_at FROM issue_reports WHERE id = $1", [a])).rows[0], human);

  // Partial triage keeps the other fields; duplicateOf follows validity.
  assert.equal((await staff("ops", `/ops/issue-reports/${b}`, { triage: { validity: "spam" } })).body.triage.validity, "spam");
  const duplicate = await staff("ops", `/ops/issue-reports/${c}`, { triage: { validity: "duplicate", duplicateOf: a, labels: ["map"] } });
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.triage.duplicateOf, a);
  assert.deepEqual(duplicate.body.triage.triagedBy, { id: users.ops.id, name: null });
  assert.equal((await staff("ops", `/ops/issue-reports/${c}`, { triage: { category: "bug" } })).body.triage.duplicateOf, a);
  const labelled = await staff("ops", `/ops/issue-reports/${d}`, { triage: { category: "feature", labels: ["ui"] } });
  assert.equal(labelled.body.triage.validity, "unreviewed");
  assert.equal(labelled.body.triage.category, "feature");
  assert.deepEqual((await staff("ops", `/ops/issue-reports/${d}`, { triage: { validity: "valid" } })).body.triage.labels, ["ui"]);
  assert.equal((await staff("ops", `/ops/issue-reports/${d}`, { triage: { validity: "unreviewed" } })).body.triage.category, "feature");

  // Filters, alone and with the existing ones and paging.
  assert.deepEqual(await ids("ops", "?validity=spam"), [b]);
  assert.deepEqual(await ids("ops", "?validity=unreviewed,valid"), [d, a]);
  assert.deepEqual(await ids("ops", "?triageCategory=bug"), [c, a]);
  assert.deepEqual(await ids("ops", "?triageCategory=none"), [b]);
  assert.deepEqual(await ids("ops", "?triageCategory=feature,none"), [d, b]);
  assert.deepEqual(await ids("ops", "?label=map"), [c, a]);
  assert.deepEqual(await ids("ops", "?label=MAP&validity=duplicate"), [c]);
  assert.deepEqual(await ids("ops", "?label=nothing"), []);
  assert.deepEqual(await ids("ops", "?status=tracked&validity=valid"), [a]);
  assert.deepEqual(await ids("ops", "?status=new&validity=valid"), []);
  assert.deepEqual(await ids("ops", `?validity=unreviewed,valid,duplicate&limit=1&before=${d}`), [c]);
  assert.deepEqual(await ids("ops", `?validity=unreviewed,valid,duplicate&limit=5&before=${c}`), [a]);
  for (const query of ["?validity=open", "?validity=spam,", "?triageCategory=urgent", "?label=has%20space", "?aiReviewed=yes"]) {
    const refused = await staff("ops", `/ops/issue-reports${query}`);
    assert.equal(refused.status, 400, query);
    assert.equal(refused.body.error, "invalid_request");
  }
  const desk = await call(base, `/issue-reports?validity=spam`, { token: DESK_TOKEN });
  assert.deepEqual(desk.body.reports.map((report) => report.id), [b]);
  assert.equal(desk.body.reports[0].triage.validity, "spam");
  const fm = await firstmate("/firstmate/issue-reports?aiReviewed=true&validity=valid");
  assert.deepEqual(fm.body.reports.map((report) => report.id), [a]);
  assert.deepEqual(fm.body.reports[0].triage.labels, ["checkout", "map"]);

  assert.deepEqual((await staff("ops", "/ops/issue-reports")).body.triageCounts, {
    validity: { unreviewed: 1, valid: 1, spam: 1, duplicate: 1 }, aiReviewed: 1, aiAwaitingHuman: 0,
    labels: [{ label: "map", count: 2 }, { label: "checkout", count: 1 }, { label: "ui", count: 1 }],
  });
  assert.deepEqual((await staff("ops", "/ops/issue-reports")).body.counts, { new: 3, tracked: 1, published: 0, dismissed: 0, priorities: 0 });

  // Leaving duplicate clears the target; a deleted target leaves no dangling id.
  assert.equal((await staff("ops", `/ops/issue-reports/${c}`, { triage: { validity: "valid" } })).body.triage.duplicateOf, null);
  await staff("ops", `/ops/issue-reports/${c}`, { triage: { validity: "duplicate", duplicateOf: b } });
  await database.query("DELETE FROM issue_reports WHERE id = $1", [b]);
  assert.equal((await staff("ops", `/ops/issue-reports/${c}`)).body.triage.duplicateOf, null);

  // Priority and status changes leave triage alone.
  await staff("ops", `/ops/issue-reports/${a}`, { priority: true });
  await staff("ops", `/ops/issue-reports/${a}`, { status: "dismissed" });
  assert.deepEqual((await database.query("SELECT validity, triage_category, labels, triaged_by, triaged_at FROM issue_reports WHERE id = $1", [a])).rows[0], human);
});
