/**
 * Public issue reports: the landing site's /report form files one, and the
 * support desk (a Clerk session on SUPPORT_DESK_ALLOWED_EMAILS) reads them
 * back so the reports site can be written from them. Contract: docs/ISSUE_REPORTS_API.md.
 *
 * Screenshots arrive as base64 in one JSON body so a report and its images land
 * together; the page downsizes them before sending. Bytes go to MinIO first and
 * the rows commit after, so a row never names an object that is not there.
 */
import crypto from "node:crypto";

import { identityHasMembership } from "./authorization-context.js";
import { deskOperatorFromRequest } from "./support-desk.js";
import { requestClientKey, tooManyRequests } from "./support-rate-limit.js";
import { asTrimmedString } from "./support-validate.js";
import { firstmateRefusal } from "./tracker.js";

export const ISSUE_MAX_LENGTH = 5000;
export const ISSUE_CATEGORIES = Object.freeze(["bug", "feature", "other"]);
export const ISSUE_STATUSES = Object.freeze(["new", "tracked", "published", "dismissed"]);
// Staff triage, independent of the workflow status. `unreviewed` is the default.
export const ISSUE_VALIDITIES = Object.freeze(["unreviewed", "valid", "spam", "duplicate"]);
// The staff category; the reporter's own `category` is never rewritten.
export const TRIAGE_CATEGORIES = Object.freeze(["bug", "feature", "question", "feedback", "other"]);
export const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_LABELS = 10;
export const AI_NOTE_MAX_LENGTH = 500;
// For link managers, `new` and `dismissed` clear the tracker issue link.
const LINKED_STATUSES = Object.freeze(["tracked", "published"]);
// The GitHub tracker issue a report became. Firstmate files it; GRIDGO only stores the link.
export const TRACKER_ISSUE_URL_RE = /^https:\/\/github\.com\/gridgoph\/[A-Za-z0-9._-]+\/issues\/[1-9][0-9]*$/;
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

export async function createIssueReport(database, storage, input, { now = new Date(), notifyStaff } = {}) {
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
      const report = { id: result.rows[0].id, createdAt: asIso(result.rows[0].created_at), screenshots: objects.length };
      if (typeof notifyStaff === "function") {
        await notifyStaff({
          type: "ops_issue_report_filed",
          title: "A new issue report was filed",
          occurrenceKey: report.id,
          resource: "issue-reports",
          id: report.id,
        });
      }
      return report;
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
    priority: row.priority,
    publishedIn: row.published_in,
    trackerIssueUrl: row.tracker_issue_url,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    screenshots: byReport.get(row.id) ?? [],
    triage: {
      validity: row.validity,
      category: row.triage_category,
      labels: row.labels,
      duplicateOf: row.duplicate_of,
      triagedBy: row.triaged_by ? { id: row.triaged_by, name: row.triaged_by_name ?? null } : null,
      triagedAt: row.triaged_at ? asIso(row.triaged_at) : null,
    },
    aiReview: row.ai_reviewed_at ? {
      reviewedAt: asIso(row.ai_reviewed_at),
      validity: row.ai_validity,
      category: row.ai_category,
      labels: row.ai_labels,
      duplicateOf: row.ai_duplicate_of,
      note: row.ai_note,
      outcome: aiReviewOutcome(row),
    } : null,
  }));
}

/**
 * How the human verdict stands against the AI suggestion: `pending` until a
 * person sets a validity, then `confirmed` when they agree on validity (and on
 * the category and duplicate target, where the AI named one), else `overridden`.
 */
function aiReviewOutcome(row) {
  if (row.validity === "unreviewed") return "pending";
  const agrees = row.validity === row.ai_validity
    && (row.ai_category == null || row.triage_category === row.ai_category)
    && (row.ai_duplicate_of == null || row.duplicate_of === row.ai_duplicate_of);
  return agrees ? "confirmed" : "overridden";
}

const REPORT_COLUMNS = `r.id, r.issue, r.category, r.status, r.published_in, r.tracker_issue_url, r.priority, r.created_at, r.updated_at,
  r.validity, r.triage_category, r.labels, r.duplicate_of, r.triaged_by, triager.name AS triaged_by_name, r.triaged_at,
  r.ai_reviewed_at, r.ai_validity, r.ai_category, r.ai_labels, r.ai_duplicate_of, r.ai_note`;
const REPORT_FROM = "issue_reports r LEFT JOIN users triager ON triager.id = r.triaged_by";

/**
 * Newest first, with `id` breaking ties so pages never overlap. `before` is
 * the id of the last report of the previous page: only older reports follow.
 * `validities` and `triageCategories` are lists (a null category entry means
 * uncategorised); `label` is one label the report must carry.
 */
export async function listIssueReports(database, storage, {
  status = null, since = null, limit = 200, before = null, priority = false,
  validities = null, triageCategories = null, label = null, aiReviewed = null,
} = {}) {
  const categories = triageCategories?.filter(Boolean) ?? null;
  const result = await database.query(
    `SELECT ${REPORT_COLUMNS} FROM ${REPORT_FROM}
     WHERE ($1::text IS NULL OR r.status = $1) AND ($2::timestamptz IS NULL OR r.created_at >= $2)
       AND (NOT $5::boolean OR r.priority)
       AND ($4::uuid IS NULL OR (r.created_at, r.id) < (SELECT created_at, id FROM issue_reports WHERE id = $4))
       AND ($6::text[] IS NULL OR r.validity = ANY($6))
       AND (NOT $7::boolean OR r.triage_category = ANY($8) OR ($9::boolean AND r.triage_category IS NULL))
       AND ($10::text IS NULL OR r.labels @> ARRAY[$10::text])
       AND ($11::boolean IS NULL OR (r.ai_reviewed_at IS NOT NULL) = $11)
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT $3`,
    [status, since, limit, before, priority, validities, triageCategories != null, categories ?? [],
      triageCategories?.includes(null) ?? false, label, aiReviewed],
  );
  return projectReports(database, storage, result.rows);
}

export async function findIssueReport(database, storage, id) {
  const result = await database.query(`SELECT ${REPORT_COLUMNS} FROM ${REPORT_FROM} WHERE r.id = $1`, [id]);
  const [report] = await projectReports(database, storage, result.rows);
  return report ?? null;
}

/**
 * `trackerIssueUrl` undefined keeps the stored link; the caller has already
 * cleared it (null) for a status that does not keep one.
 */
export async function updateIssueReport(database, id, { status, publishedIn, trackerIssueUrl }) {
  const result = await database.query(
    `UPDATE issue_reports
     SET status = $2, published_in = $3,
         tracker_issue_url = CASE WHEN $4::boolean THEN tracker_issue_url ELSE $5 END,
         updated_at = now()
     WHERE id = $1 RETURNING id`,
    [id, status, publishedIn, trackerIssueUrl === undefined, trackerIssueUrl ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

async function reportCounts(database) {
  const result = await database.query("SELECT status, count(*)::int AS n FROM issue_reports GROUP BY status");
  const counts = Object.fromEntries(ISSUE_STATUSES.map((status) => [status, 0]));
  for (const row of result.rows) counts[row.status] = row.n;
  counts.priorities = (await database.query("SELECT count(*)::int AS n FROM issue_reports WHERE priority")).rows[0].n;
  return counts;
}

/** Totals across every report, whatever the list filters; `labels` is most used first. */
async function triageCounts(database) {
  const validity = Object.fromEntries(ISSUE_VALIDITIES.map((value) => [value, 0]));
  for (const row of (await database.query("SELECT validity, count(*)::int AS n FROM issue_reports GROUP BY validity")).rows) {
    validity[row.validity] = row.n;
  }
  const ai = (await database.query(
    `SELECT count(*) FILTER (WHERE ai_reviewed_at IS NOT NULL)::int AS reviewed,
       count(*) FILTER (WHERE ai_reviewed_at IS NOT NULL AND validity = 'unreviewed')::int AS awaiting
     FROM issue_reports`,
  )).rows[0];
  const labels = (await database.query(
    `SELECT label, count(*)::int AS n FROM issue_reports, unnest(labels) AS label
     GROUP BY label ORDER BY n DESC, label`,
  )).rows.map((row) => ({ label: row.label, count: row.n }));
  return { validity, aiReviewed: ai.reviewed, aiAwaitingHuman: ai.awaiting, labels };
}

function listParam(url, name, allowed) {
  const raw = url?.searchParams.get(name);
  if (raw == null || raw === "") return null;
  const values = [...new Set(raw.split(",").map((value) => value.trim()))];
  if (values.some((value) => !allowed.includes(value))) {
    throw new ReportError(400, "invalid_request", `${name} must be a comma-separated list of: ${allowed.join(", ")}.`);
  }
  return values;
}

function booleanParam(url, name) {
  const raw = url?.searchParams.get(name);
  if (raw == null) return null;
  if (!["true", "false"].includes(raw)) throw new ReportError(400, "invalid_request", `${name} must be true or false.`);
  return raw === "true";
}

const invalid = (message) => new ReportError(400, "invalid_request", message);

function categoryInput(value, field) {
  if (value === null) return null;
  if (!TRIAGE_CATEGORIES.includes(value)) throw invalid(`${field} must be one of: ${TRIAGE_CATEGORIES.join(", ")}, or null.`);
  return value;
}

/** Trimmed, lowercased and deduplicated; the whole list replaces the stored one. */
function labelsInput(value, field) {
  if (!Array.isArray(value)) throw invalid(`${field} must be a list of labels.`);
  const labels = [...new Set(value.map((label) => (typeof label === "string" ? label.trim().toLowerCase() : label)))];
  if (labels.some((label) => typeof label !== "string" || !LABEL_RE.test(label))) {
    throw invalid(`Each of ${field} must be 1-32 lowercase letters, digits or hyphens, starting with a letter or digit.`);
  }
  if (labels.length > MAX_LABELS) throw invalid(`${field} can hold at most ${MAX_LABELS} labels.`);
  return labels;
}

async function duplicateInput(database, id, value, field) {
  if (value === null) return null;
  if (typeof value !== "string" || !UUID_RE.test(value) || value.toLowerCase() === id.toLowerCase()) {
    throw invalid(`${field} must be the id of another issue report, or null.`);
  }
  if (!(await database.query("SELECT 1 FROM issue_reports WHERE id = $1", [value])).rowCount) {
    throw invalid(`${field} must be the id of another issue report, or null.`);
  }
  return value;
}

function onlyKeys(object, keys, field) {
  if (!object || typeof object !== "object" || Array.isArray(object)) throw invalid(`${field} must be an object.`);
  const unknown = Object.keys(object).filter((key) => !keys.includes(key));
  if (unknown.length) throw invalid(`${field} accepts only: ${keys.join(", ")}.`);
}

/**
 * Staff triage: omitted fields keep their stored value, `labels` replaces the
 * list, and leaving `duplicate` clears `duplicateOf`. Records who and when.
 */
async function applyTriage(database, id, input, actor) {
  onlyKeys(input, ["validity", "category", "labels", "duplicateOf"], "triage");
  if (!Object.keys(input).length) throw invalid("triage must change at least one of validity, category, labels or duplicateOf.");
  if (Object.hasOwn(input, "validity") && !ISSUE_VALIDITIES.includes(input.validity)) {
    throw invalid(`triage.validity must be one of: ${ISSUE_VALIDITIES.join(", ")}.`);
  }
  const category = Object.hasOwn(input, "category") ? categoryInput(input.category, "triage.category") : undefined;
  const labels = Object.hasOwn(input, "labels") ? labelsInput(input.labels, "triage.labels") : undefined;
  return database.transaction(async () => {
    const current = (await database.query("SELECT validity, duplicate_of FROM issue_reports WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!current) return false;
    const validity = input.validity ?? current.validity;
    let duplicateOf = validity === "duplicate" ? current.duplicate_of : null;
    if (Object.hasOwn(input, "duplicateOf")) {
      duplicateOf = await duplicateInput(database, id, input.duplicateOf, "triage.duplicateOf");
      if (duplicateOf && validity !== "duplicate") throw invalid("triage.duplicateOf needs validity duplicate.");
    }
    await database.query(
      `UPDATE issue_reports SET validity = $2,
         triage_category = CASE WHEN $3::boolean THEN $4 ELSE triage_category END,
         labels = coalesce($5::text[], labels), duplicate_of = $6,
         triaged_by = $7, triaged_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, validity, category !== undefined, category ?? null, labels ?? null, duplicateOf, actor.id],
    );
    return true;
  }, { lockKey: ISSUE_LOCK });
}

/**
 * AI review replaces only the AI suggestion as a whole; the human triage
 * columns are not part of this statement, so no AI write can change them.
 */
async function applyAiReview(database, id, input) {
  onlyKeys(input, ["validity", "category", "labels", "duplicateOf", "note"], "aiReview");
  if (!["valid", "spam", "duplicate"].includes(input.validity)) {
    throw invalid("aiReview.validity must be one of: valid, spam, duplicate.");
  }
  const category = categoryInput(input.category ?? null, "aiReview.category");
  const labels = labelsInput(input.labels ?? [], "aiReview.labels");
  const noteRaw = input.note ?? null;
  if (noteRaw !== null && typeof noteRaw !== "string") throw invalid("aiReview.note must be text or null.");
  const note = asTrimmedString(noteRaw) || null;
  if (note && note.length > AI_NOTE_MAX_LENGTH) throw invalid(`aiReview.note must be ${AI_NOTE_MAX_LENGTH} characters or fewer.`);
  return database.transaction(async () => {
    if (!(await database.query("SELECT 1 FROM issue_reports WHERE id = $1 FOR UPDATE", [id])).rowCount) return false;
    const duplicateOf = await duplicateInput(database, id, input.duplicateOf ?? null, "aiReview.duplicateOf");
    if (duplicateOf && input.validity !== "duplicate") throw invalid("aiReview.duplicateOf needs validity duplicate.");
    await database.query(
      `UPDATE issue_reports SET ai_reviewed_at = now(), ai_validity = $2, ai_category = $3, ai_labels = $4,
         ai_duplicate_of = $5, ai_note = $6, updated_at = now()
       WHERE id = $1`,
      [id, input.validity, category, labels, duplicateOf, note],
    );
    return true;
  }, { lockKey: ISSUE_LOCK });
}

/** Omitted keeps the stored link, null or "" clears it, anything else must be a tracker issue URL. */
function trackerIssueUrlInput(body) {
  if (!body || !Object.hasOwn(body, "trackerIssueUrl")) return undefined;
  const value = body.trackerIssueUrl;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ReportError(400, "invalid_request", "trackerIssueUrl must be a GitHub tracker issue URL or null.");
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!TRACKER_ISSUE_URL_RE.test(trimmed)) {
    throw new ReportError(
      400,
      "invalid_request",
      "trackerIssueUrl must look like https://github.com/gridgoph/<repo>/issues/<number>.",
    );
  }
  return trimmed;
}

/** Viewers without tracker link access must not receive GitHub URLs,
 * including links pasted into report text or publication labels. Stored text is unchanged.
 */
function withoutGithubLinks(value) {
  if (typeof value === "string") {
    return value.replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
      try {
        const host = new URL(url).hostname.toLowerCase();
        return ["github.com", "githubusercontent.com", "github.io"].some(domain => host === domain || host.endsWith(`.${domain}`))
          ? "[link hidden]" : url;
      } catch { return url; }
    });
  }
  if (Array.isArray(value)) return value.map(withoutGithubLinks);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "trackerIssueUrl")
      .map(([key, entry]) => [key, withoutGithubLinks(entry)]));
  }
  return value;
}

/**
 * List, read and mark reports under `base`. Shared by the support desk
 * (`/issue-reports`), signed-in Operations / Super Admin (`/ops/issue-reports`)
 * and firstmate's service token (`/firstmate/issue-reports`); the caller has
 * already decided who may reach it.
 */
async function reviewIssueReports({
  method, path, base, url, res, send, database, storage, readPatch, staffActor = null, canManageTrackerLink = false, aiReviewer = false,
}) {
  const project = report => canManageTrackerLink ? report : withoutGithubLinks(report);
  if (method === "GET" && path === base) {
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
    // Paging: the id of the last report already shown. Absent, the first page.
    const before = url?.searchParams.get("before") || null;
    if (before) {
      const anchor = UUID_RE.test(before)
        ? await database.query("SELECT 1 FROM issue_reports WHERE id = $1", [before])
        : { rowCount: 0 };
      if (!anchor.rowCount) {
        throw new ReportError(400, "invalid_request", "before must be the id of an issue report.");
      }
    }
    const priorityRaw = url?.searchParams.get("priority");
    if (priorityRaw != null && !["true", "false"].includes(priorityRaw)) {
      throw new ReportError(400, "invalid_request", "priority must be true or false.");
    }
    const triageCategories = listParam(url, "triageCategory", [...TRIAGE_CATEGORIES, "none"])
      ?.map((value) => (value === "none" ? null : value)) ?? null;
    const label = url?.searchParams.get("label")?.trim().toLowerCase() || null;
    if (label && !LABEL_RE.test(label)) throw invalid("label must be 1-32 lowercase letters, digits or hyphens.");
    const reports = await listIssueReports(database, storage, {
      status, since: sinceRaw, limit, before, priority: priorityRaw === "true",
      validities: listParam(url, "validity", ISSUE_VALIDITIES), triageCategories, label, aiReviewed: booleanParam(url, "aiReviewed"),
    });
    send(res, 200, { reports: reports.map(project), counts: await reportCounts(database), triageCounts: await triageCounts(database) });
    return true;
  }

  const itemMatch = path.startsWith(`${base}/`) ? /^([^/]+)$/.exec(path.slice(base.length + 1)) : null;
  if (!itemMatch || (method !== "GET" && method !== "PATCH")) return false;
  const id = itemMatch[1];
  const notFound = new ReportError(404, "issue_report_not_found", `Issue report ${id} was not found.`);
  if (!UUID_RE.test(id)) throw notFound;
  if (method === "PATCH") {
    const body = await readPatch();
    if (!canManageTrackerLink && body && Object.hasOwn(body, "trackerIssueUrl")) {
      throw new ReportError(403, "tracker_issue_url_forbidden", "Only Super Admin or the firstmate service can change the tracker issue link.");
    }
    if (body && Object.hasOwn(body, "priority")) {
      if (!staffActor) throw new ReportError(403, "forbidden", "Only Operations and Super Admin can change priority.");
      if (typeof body.priority !== "boolean" || Object.keys(body).some(key => key !== "priority")) {
        throw new ReportError(400, "invalid_request", "Send priority as true or false, separately from status changes.");
      }
      const result = await database.transaction(() => database.query(
        `UPDATE issue_reports SET priority = $2, priority_updated_by = $3,
           priority_updated_at = now(), updated_at = now()
         WHERE id = $1 RETURNING id`, [id, body.priority, staffActor.id],
      ), { lockKey: ISSUE_LOCK });
      if (!result.rowCount) throw notFound;
      send(res, 200, project(await findIssueReport(database, storage, id)));
      return true;
    }
    for (const [key, allowed, who] of [
      ["triage", Boolean(staffActor), "Only Operations and Super Admin can triage reports."],
      ["aiReview", aiReviewer, "Only the firstmate service can record an AI review."],
    ]) {
      if (!body || !Object.hasOwn(body, key)) continue;
      if (!allowed) throw new ReportError(403, "forbidden", who);
      if (Object.keys(body).length !== 1) throw invalid(`Send ${key} on its own, separately from status and priority changes.`);
      const applied = key === "triage"
        ? await applyTriage(database, id, body.triage, staffActor)
        : await applyAiReview(database, id, body.aiReview);
      if (!applied) throw notFound;
      send(res, 200, project(await findIssueReport(database, storage, id)));
      return true;
    }
    const status = asTrimmedString(body?.status);
    if (!ISSUE_STATUSES.includes(status)) {
      throw new ReportError(400, "invalid_request", `status must be one of: ${ISSUE_STATUSES.join(", ")}.`);
    }
    const publishedIn = asTrimmedString(body?.publishedIn) || null;
    if (publishedIn && publishedIn.length > 200) {
      throw new ReportError(400, "invalid_request", "publishedIn must be 200 characters or fewer.");
    }
    // Validated even when the status is about to clear it, so a bad link is never silently dropped.
    const linkInput = trackerIssueUrlInput(body);
    const trackerIssueUrl = canManageTrackerLink
      ? (LINKED_STATUSES.includes(status) ? linkInput : null)
      : undefined;
    const updated = await database.transaction(
      () => updateIssueReport(database, id, {
        status,
        publishedIn: status === "published" ? publishedIn : null,
        trackerIssueUrl,
      }),
      { lockKey: ISSUE_LOCK },
    );
    if (!updated) throw notFound;
  }
  const report = await findIssueReport(database, storage, id);
  if (!report) throw notFound;
  send(res, 200, project(report));
  return true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function routeIssueReports({
  req, res, pathname, url, send, database, storage, env = process.env, verifyClerk, loadClerkUser,
  notifyStaff,
}) {
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
      const report = await createIssueReport(database, storage, parsed.value, { notifyStaff });
      send(res, 201, report);
      return true;
    }

    if (method === "GET" || method === "PATCH") {
      const desk = await deskOperatorFromRequest(req, { env, verifyClerk, loadClerkUser });
      if (!desk.admin) throw new ReportError(desk.status, desk.error, desk.message);
    }
    if (await reviewIssueReports({
      method, path, base: "/issue-reports", url, res, send, database, storage,
      readPatch: () => readJsonBody(req, 64 * 1024),
    })) return true;

    throw new ReportError(404, "not_found", `No ${method} route for ${pathname}.`);
  } catch (error) {
    if (error instanceof ReportError || (error?.status && error?.code)) {
      send(res, error.status, { error: error.code, message: error.message });
      return true;
    }
    throw error;
  }
}

const STAFF_BASE = "/ops/issue-reports";

export function isStaffIssueReportsRoute(pathname) {
  const path = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
  return path === STAFF_BASE || /^\/ops\/issue-reports\/[^/]+$/.test(path);
}

/**
 * Operations and Super Admin read the same reports from the dashboard with their
 * Clerk session. Runs after authentication; `readBody` is the server's parsed body.
 */
export async function routeStaffIssueReports({ req, res, pathname, url, user, readBody, send, database, storage }) {
  if (!isStaffIssueReportsRoute(pathname)) return false;
  const path = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
  try {
    if (!user) throw new ReportError(401, "unauthorized", "Sign in to GRIDGO to read issue reports.");
    if (!(identityHasMembership(user, "ops_admin") || identityHasMembership(user, "super_admin"))) {
      throw new ReportError(403, "forbidden", "Only Operations and Super Admin can read issue reports.");
    }
    if (await reviewIssueReports({
      method: req.method, path, base: STAFF_BASE, url, res, send, database, storage, staffActor: user,
      canManageTrackerLink: identityHasMembership(user, "super_admin"),
      readPatch: () => readBody(req),
    })) return true;
    throw new ReportError(404, "not_found", `No ${req.method} route for ${pathname}.`);
  } catch (error) {
    if (error instanceof ReportError || (error?.status && error?.code)) {
      send(res, error.status, { error: error.code, message: error.message });
      return true;
    }
    throw error;
  }
}

const FIRSTMATE_BASE = "/firstmate/issue-reports";

export function isFirstmateIssueReportsRoute(pathname) {
  const path = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
  return path === FIRSTMATE_BASE || /^\/firstmate\/issue-reports\/[^/]+$/.test(path);
}

/**
 * firstmate reads new reports and links them to the GitHub tracker issues it
 * files, with FIRSTMATE_TRACKER_TOKEN as a Bearer credential. Invisible (404)
 * while that token is unset. Nothing here talks to GitHub.
 */
export async function routeFirstmateIssueReports({ req, res, pathname, url, send, database, storage, env = process.env }) {
  if (!isFirstmateIssueReportsRoute(pathname)) return false;
  const path = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
  try {
    const refusal = firstmateRefusal(req, String(env.FIRSTMATE_TRACKER_TOKEN || "").trim());
    if (refusal?.status === 404) {
      send(res, 404, { error: "not_found", path: pathname });
      return true;
    }
    if (refusal) throw new ReportError(refusal.status, refusal.error, refusal.message);
    if (await reviewIssueReports({
      method: req.method, path, base: FIRSTMATE_BASE, url, res, send, database, storage,
      canManageTrackerLink: true, aiReviewer: true,
      readPatch: () => readJsonBody(req, 64 * 1024),
    })) return true;
    throw new ReportError(404, "not_found", `No ${req.method} route for ${pathname}.`);
  } catch (error) {
    if (error instanceof ReportError || (error?.status && error?.code)) {
      send(res, error.status, { error: error.code, message: error.message });
      return true;
    }
    throw error;
  }
}
