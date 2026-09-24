/**
 * Public issue reports: the landing site's /report form files one, and the
 * support desk login reads them back so the reports site can be written from
 * them. Contract: docs/ISSUE_REPORTS_API.md.
 *
 * Screenshots arrive as base64 in one JSON body so a report and its images land
 * together; the page downsizes them before sending. Bytes go to MinIO first and
 * the rows commit after, so a row never names an object that is not there.
 */
import crypto from "node:crypto";

import { readBearer, verifyAdminToken } from "./support-desk.js";
import { requestClientKey, tooManyRequests } from "./support-rate-limit.js";
import { asTrimmedString } from "./support-validate.js";

export const ISSUE_MAX_LENGTH = 5000;
export const ISSUE_CATEGORIES = Object.freeze(["bug", "feature", "other"]);
export const ISSUE_STATUSES = Object.freeze(["new", "published", "dismissed"]);
export const MAX_SCREENSHOTS = 6;
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
// Base64 grows bytes by 4/3; leave room for the text and JSON framing.
export const MAX_REPORT_BODY_BYTES = Math.ceil((MAX_SCREENSHOTS * MAX_SCREENSHOT_BYTES * 4) / 3) + 64 * 1024;
const ISSUE_LOCK = "gridgo-issue-reports";
// Site-wide ceilings over the last 24 hours, so no sender (or set of senders)
// can fill MinIO. Override with ISSUE_REPORTS_DAILY_LIMIT / ISSUE_REPORTS_DAILY_BYTES.
export const DEFAULT_DAILY_REPORTS = 200;
export const DEFAULT_DAILY_BYTES = 1024 * 1024 * 1024;
const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export function issueReportsPathname(pathname) {
  const path = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
  if (path === "/issue-reports" || /^\/issue-reports\/[^/]+$/.test(path)) return path;
  return null;
}

class ReportError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Identify an image by its first bytes; the declared type is never trusted. */
export function sniffImageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6))) return "image/gif";
  return null;
}

function decodeScreenshot(value, index) {
  const label = `Screenshot ${index + 1}`;
  const raw = typeof value === "string" ? value : typeof value?.data === "string" ? value.data : "";
  const base64 = raw.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "");
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new ReportError(400, "invalid_screenshot", `${label} is not a base64 image.`);
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_SCREENSHOT_BYTES) {
    throw new ReportError(413, "screenshot_too_large", `${label} is larger than 8 MB. Attach a smaller image.`);
  }
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw new ReportError(400, "invalid_screenshot", `${label} must be a PNG, JPEG, WebP, or GIF image.`);
  }
  return { bytes, contentType };
}

export function validateIssueReport(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  const issue = asTrimmedString(body.issue);
  if (!issue) return { ok: false, message: "Describe the issue." };
  if (issue.length > ISSUE_MAX_LENGTH) {
    return { ok: false, message: `The issue must be ${ISSUE_MAX_LENGTH} characters or fewer.` };
  }
  const categoryInput = asTrimmedString(body.category);
  const category = categoryInput || null;
  if (category && !ISSUE_CATEGORIES.includes(category)) {
    return { ok: false, message: `Category must be one of: ${ISSUE_CATEGORIES.join(", ")}.` };
  }
  const screenshotsInput = body.screenshots ?? [];
  if (!Array.isArray(screenshotsInput)) return { ok: false, message: "Screenshots must be a list." };
  if (screenshotsInput.length > MAX_SCREENSHOTS) {
    return { ok: false, message: `Attach at most ${MAX_SCREENSHOTS} screenshots.` };
  }
  try {
    const screenshots = screenshotsInput.map(decodeScreenshot);
    return { ok: true, value: { issue, category, screenshots } };
  } catch (error) {
    if (error instanceof ReportError) return { ok: false, status: error.status, code: error.code, message: error.message };
    throw error;
  }
}

export function readJsonBody(req, maxBytes = MAX_REPORT_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new ReportError(413, "request_body_too_large", "This report is too large. Attach fewer or smaller screenshots."));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        chunks.length = 0;
        reject(new ReportError(413, "request_body_too_large", "This report is too large. Attach fewer or smaller screenshots."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ReportError(400, "invalid_json", "Request body must be valid JSON."));
      }
    });
    req.on("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

function asIso(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function positiveIntegerEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function dailyCapacity(env = process.env) {
  return {
    reports: positiveIntegerEnv(env.ISSUE_REPORTS_DAILY_LIMIT, DEFAULT_DAILY_REPORTS),
    bytes: positiveIntegerEnv(env.ISSUE_REPORTS_DAILY_BYTES, DEFAULT_DAILY_BYTES),
  };
}

/** Refuse a report that would take the last 24 hours past either ceiling. */
export async function assertDailyCapacity(database, incomingBytes, env = process.env) {
  const capacity = dailyCapacity(env);
  const result = await database.query(
    `SELECT
       (SELECT count(*)::bigint FROM issue_reports WHERE created_at > now() - interval '24 hours') AS reports,
       (SELECT coalesce(sum(size_bytes), 0)::bigint FROM issue_report_screenshots
         WHERE created_at > now() - interval '24 hours') AS bytes`,
  );
  const reports = Number(result.rows[0].reports);
  const bytes = Number(result.rows[0].bytes);
  if (reports + 1 > capacity.reports || bytes + incomingBytes > capacity.bytes) {
    throw new ReportError(
      429,
      "report_capacity_reached",
      "GRIDGO has received a lot of reports today. Please try again tomorrow.",
    );
  }
}

export async function createIssueReport(database, storage, input, { now = new Date() } = {}) {
  const reportId = crypto.randomUUID();
  const datePath = now.toISOString().slice(0, 10).replaceAll("-", "/");
  const objects = input.screenshots.map((shot, position) => ({
    ...shot,
    position,
    objectKey: `issue_reports/${datePath}/${reportId}-${position + 1}.${EXTENSIONS[shot.contentType]}`,
  }));
  if (objects.length) await storage.ensureBucket();
  const stored = [];
  try {
    for (const object of objects) {
      await storage.putObject({
        key: object.objectKey,
        body: object.bytes,
        contentType: object.contentType,
        size: object.bytes.length,
      });
      stored.push(object.objectKey);
    }
    return await database.transaction(async () => {
      const result = await database.query(
        `INSERT INTO issue_reports (id, issue, category) VALUES ($1, $2, $3) RETURNING id, created_at`,
        [reportId, input.issue, input.category],
      );
      for (const object of objects) {
        await database.query(
          `INSERT INTO issue_report_screenshots (report_id, position, object_key, content_type, size_bytes)
           VALUES ($1, $2, $3, $4, $5)`,
          [reportId, object.position, object.objectKey, object.contentType, object.bytes.length],
        );
      }
      return { id: result.rows[0].id, createdAt: asIso(result.rows[0].created_at), screenshots: objects.length };
    }, { lockKey: ISSUE_LOCK });
  } catch (error) {
    await Promise.all(stored.map((key) => storage.deleteObject(key).catch(() => {})));
    throw error;
  }
}

async function projectReports(database, storage, rows) {
  if (!rows.length) return [];
  const shots = await database.query(
    `SELECT report_id, position, object_key, content_type, size_bytes
     FROM issue_report_screenshots
     WHERE report_id = ANY($1::uuid[])
     ORDER BY report_id, position`,
    [rows.map((row) => row.id)],
  );
  const byReport = new Map();
  for (const shot of shots.rows) {
    const signed = await storage.presignGet(shot.object_key);
    const list = byReport.get(shot.report_id) ?? [];
    list.push({
      position: shot.position,
      contentType: shot.content_type,
      size: shot.size_bytes,
      url: signed.url,
      expiresAt: signed.expiresAt,
    });
    byReport.set(shot.report_id, list);
  }
  return rows.map((row) => ({
    id: row.id,
    issue: row.issue,
    category: row.category,
    status: row.status,
    publishedIn: row.published_in,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    screenshots: byReport.get(row.id) ?? [],
  }));
}

const REPORT_COLUMNS = "id, issue, category, status, published_in, created_at, updated_at";

export async function listIssueReports(database, storage, { status = null, since = null, limit = 200 } = {}) {
  const result = await database.query(
    `SELECT ${REPORT_COLUMNS} FROM issue_reports
     WHERE ($1::text IS NULL OR status = $1) AND ($2::timestamptz IS NULL OR created_at >= $2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [status, since, limit],
  );
  return projectReports(database, storage, result.rows);
}

export async function findIssueReport(database, storage, id) {
  const result = await database.query(`SELECT ${REPORT_COLUMNS} FROM issue_reports WHERE id = $1`, [id]);
  const [report] = await projectReports(database, storage, result.rows);
  return report ?? null;
}

export async function updateIssueReport(database, id, { status, publishedIn }) {
  const result = await database.query(
    `UPDATE issue_reports SET status = $2, published_in = $3, updated_at = now() WHERE id = $1 RETURNING id`,
    [id, status, publishedIn],
  );
  return (result.rowCount ?? 0) > 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deskAdmin(req, env) {
  const token = readBearer(req.headers.authorization);
  if (!token) return null;
  try {
    return verifyAdminToken(token, env);
  } catch {
    return null;
  }
}

export async function routeIssueReports({ req, res, pathname, url, send, database, storage, env = process.env }) {
  const path = issueReportsPathname(pathname);
  if (!path) return false;
  const method = req.method;
  try {
    if (method === "POST" && path === "/issue-reports") {
      const ipKey = requestClientKey(req);
      if (tooManyRequests(`issue-report:${ipKey}`, 10, 10 * 60 * 1000)) {
        throw new ReportError(429, "too_many_requests", "Too many reports from this connection. Wait a few minutes and try again.");
      }
      const parsed = validateIssueReport(await readJsonBody(req));
      if (!parsed.ok) throw new ReportError(parsed.status ?? 400, parsed.code ?? "invalid_request", parsed.message);
      const incomingBytes = parsed.value.screenshots.reduce((sum, shot) => sum + shot.bytes.length, 0);
      await assertDailyCapacity(database, incomingBytes, env);
      const report = await createIssueReport(database, storage, parsed.value);
      send(res, 201, report);
      return true;
    }

    const itemMatch = /^\/issue-reports\/([^/]+)$/.exec(path);
    if ((method === "GET" && (path === "/issue-reports" || itemMatch)) || (method === "PATCH" && itemMatch)) {
      if (!deskAdmin(req, env)) throw new ReportError(401, "unauthorized", "Sign in with the support desk account.");
    }

    if (method === "GET" && path === "/issue-reports") {
      const status = url?.searchParams.get("status") || null;
      if (status && !ISSUE_STATUSES.includes(status)) {
        throw new ReportError(400, "invalid_request", `status must be one of: ${ISSUE_STATUSES.join(", ")}.`);
      }
      const sinceRaw = url?.searchParams.get("since") || null;
      if (sinceRaw && Number.isNaN(Date.parse(sinceRaw))) {
        throw new ReportError(400, "invalid_request", "since must be an ISO date or timestamp.");
      }
      const limitRaw = Number(url?.searchParams.get("limit") || 200);
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;
      send(res, 200, { reports: await listIssueReports(database, storage, { status, since: sinceRaw, limit }) });
      return true;
    }

    if (itemMatch && (method === "GET" || method === "PATCH")) {
      const id = itemMatch[1];
      const notFound = new ReportError(404, "issue_report_not_found", `Issue report ${id} was not found.`);
      if (!UUID_RE.test(id)) throw notFound;
      if (method === "PATCH") {
        const body = await readJsonBody(req, 64 * 1024);
        const status = asTrimmedString(body?.status);
        if (!ISSUE_STATUSES.includes(status)) {
          throw new ReportError(400, "invalid_request", `status must be one of: ${ISSUE_STATUSES.join(", ")}.`);
        }
        const publishedIn = asTrimmedString(body?.publishedIn) || null;
        if (publishedIn && publishedIn.length > 200) {
          throw new ReportError(400, "invalid_request", "publishedIn must be 200 characters or fewer.");
        }
        const updated = await database.transaction(
          () => updateIssueReport(database, id, { status, publishedIn: status === "published" ? publishedIn : null }),
          { lockKey: ISSUE_LOCK },
        );
        if (!updated) throw notFound;
      }
      const report = await findIssueReport(database, storage, id);
      if (!report) throw notFound;
      send(res, 200, report);
      return true;
    }

    throw new ReportError(404, "not_found", `No ${method} route for ${pathname}.`);
  } catch (error) {
    if (error instanceof ReportError || (error?.status && error?.code)) {
      send(res, error.status, { error: error.code, message: error.message });
      return true;
    }
    throw error;
  }
}
