import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createDatabase } from "../src/database.js";
import {
  MAX_SCREENSHOTS,
  routeIssueReports,
  sniffImageType,
  validateIssueReport,
} from "../src/issue-reports.js";
import { signAdminToken } from "../src/support-desk.js";
import { requestClientKey } from "../src/support-rate-limit.js";

const DATABASE_URL = process.env.DATABASE_URL;
const DESK_ENV = { SUPPORT_DESK_JWT_SECRET: "issue-report-test-secret" };
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
        req, res, pathname: url.pathname, url, send, database, storage, env,
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

  const token = signAdminToken({ id: "desk-1", username: "desk" }, DESK_ENV);
  const listed = await call(base, "/issue-reports?status=new", { token });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.reports.length, 1);
  const [report] = listed.body.reports;
  assert.equal(report.issue, "Orders need a manual refresh in Operations");
  assert.equal(report.category, "bug");
  assert.deepEqual(report.screenshots.map((shot) => shot.contentType), ["image/png", "image/jpeg"]);
  assert.match(report.screenshots[0].url, /^https:\/\/files\.example\/issue_reports\//);

  const published = await call(base, `/issue-reports/${report.id}`, {
    method: "PATCH", token, body: { status: "published", publishedIn: "09-24-2026" },
  });
  assert.equal(published.status, 200);
  assert.equal(published.body.status, "published");
  assert.equal(published.body.publishedIn, "09-24-2026");
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
