/**
 * Super Admin Tracker: the GitHub issues labelled `tracker` across the GRIDGO
 * repositories, read and steered from the dashboard. Contract: docs/TRACKER_API.md.
 *
 * GitHub stays the source of truth for every item and its status. GRIDGO keeps
 * only the decisions a Super Admin records while an item needs one
 * (`tracker_decisions`), their attachments (ordinary `tracker_decision` files),
 * and the audit rows. firstmate collects unprocessed decisions with its own
 * service token.
 *
 * The GitHub token never leaves this process. Without it the tracker answers
 * 503 `tracker_not_configured` and nothing else in the API changes.
 */
import crypto from "node:crypto";

import { identityHasMembership } from "./authorization-context.js";
import { DOMAIN_MUTATION_LOCK } from "./database.js";

export const TRACKER_STATUSES = Object.freeze([
  "open", "in-review", "merged-dev", "live", "needs-decision", "blocked",
]);
export const TRACKER_STATUS_LABELS = Object.freeze({
  open: "Open",
  "in-review": "In review",
  "merged-dev": "Merged (dev)",
  live: "Live (prod)",
  "needs-decision": "Needs decision",
  blocked: "Blocked",
});
/** Report order. Anything the marker names outside this list sorts last. */
export const TRACKER_SECTIONS = Object.freeze([
  "general", "supplier",
  "step-01", "step-02", "step-03", "step-04", "step-05", "step-06", "step-07", "step-08",
]);
const SECTION_LABELS = Object.freeze(Object.fromEntries(TRACKER_SECTIONS.map((section) => [
  section,
  section.startsWith("step-") ? `Step ${section.slice(5)}` : section[0].toUpperCase() + section.slice(1),
])));
export const DEFAULT_TRACKER_OWNER = "gridgoph";
export const DEFAULT_TRACKER_REPOS = Object.freeze([
  "gridgoph/gridgo-api", "gridgoph/gridgo-web", "gridgoph/gridgo-client",
  "gridgoph/gridgo-supplier", "gridgoph/gridgo-rider",
]);
export const DECISION_TEXT_MAX = 5000;
export const STATUS_NOTE_MAX = 5000;
export const MAX_DECISION_ATTACHMENTS = 6;
export const TRACKER_CACHE_TTL_MS = 60_000;
const DEVELOPERS = Object.freeze({ mark: "Mark", ven: "Ven" });
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;
// Serializes tracker writes against each other. The domain lock is taken only
// for the final audit/file-reference commit, never while GitHub is answering.
const TRACKER_LOCK = "gridgo-tracker";
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const ADMIN_BASE = "/admin/tracker";
const FIRSTMATE_BASE = "/firstmate/tracker/decisions";
// Fields a Super Admin can see but never change: they belong to the report.
const READ_ONLY_FIELDS = Object.freeze([
  "module", "section", "step", "order", "ref", "id", "requirement", "summary", "category", "developer",
]);

export class TrackerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Read the tracker environment. Never throws: a bad value leaves the tracker
 * unconfigured with the reason, so the rest of the API still boots.
 */
export function trackerConfig(env = process.env) {
  const token = String(env.GITHUB_TRACKER_TOKEN || "").trim();
  const firstmateToken = String(env.FIRSTMATE_TRACKER_TOKEN || "").trim();
  const apiUrl = (String(env.GITHUB_TRACKER_API_URL || "").trim() || GITHUB_API_URL).replace(/\/+$/, "");
  const rawRepos = String(env.GITHUB_TRACKER_REPOS || "").trim();
  const entries = (rawRepos ? rawRepos.split(",") : [...DEFAULT_TRACKER_REPOS])
    .map((entry) => entry.trim())
    .filter(Boolean);
  const repos = new Map();
  let problem = null;
  for (const entry of entries) {
    const parts = entry.split("/");
    const [owner, name] = parts.length === 1 ? [DEFAULT_TRACKER_OWNER, parts[0]] : parts;
    if (parts.length > 2 || !NAME_RE.test(owner) || !NAME_RE.test(name)) {
      problem = `GITHUB_TRACKER_REPOS entry "${entry}" is not owner/name.`;
      break;
    }
    if (repos.has(name)) {
      problem = `GITHUB_TRACKER_REPOS names the repository "${name}" twice.`;
      break;
    }
    repos.set(name, { owner, name });
  }
  if (!problem && !repos.size) problem = "GITHUB_TRACKER_REPOS names no repository.";
  if (!token) problem = "The tracker is not configured on this server: GITHUB_TRACKER_TOKEN is not set.";
  return { configured: !problem, problem, token, firstmateToken, apiUrl, repos };
}

/** Plain GitHub REST over `fetch`. Error bodies from GitHub are never relayed. */
export function createGithubClient({ token, apiUrl = GITHUB_API_URL, fetch = globalThis.fetch }) {
  async function call(method, path, body, { notFound } = {}) {
    let response;
    try {
      response = await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "gridgo-api-tracker",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch {
      throw new TrackerError(502, "tracker_github_unavailable", "GitHub could not be reached. Try again in a moment.");
    }
    if (response.status === 404 && notFound) throw notFound;
    if (response.status === 401 || response.status === 403) {
      throw new TrackerError(
        502,
        "tracker_github_unavailable",
        `GitHub refused the tracker token (HTTP ${response.status}). Check GITHUB_TRACKER_TOKEN and its Issues access on the server.`,
      );
    }
    if (!response.ok) {
      throw new TrackerError(502, "tracker_github_unavailable", `GitHub answered HTTP ${response.status}. Try again in a moment.`);
    }
    return response.json();
  }

  return {
    async listTrackerIssues({ owner, name }) {
      const issues = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const batch = await call(
          "GET",
          `/repos/${owner}/${name}/issues?labels=tracker&state=all&per_page=100&page=${page}`,
        );
        if (!Array.isArray(batch)) break;
        issues.push(...batch.filter((issue) => !issue.pull_request));
        if (batch.length < 100) break;
      }
      return issues;
    },
    getIssue({ owner, name }, number, notFound) {
      return call("GET", `/repos/${owner}/${name}/issues/${number}`, null, { notFound });
    },
    updateIssue({ owner, name }, number, patch) {
      return call("PATCH", `/repos/${owner}/${name}/issues/${number}`, patch);
    },
    comment({ owner, name }, number, text) {
      return call("POST", `/repos/${owner}/${name}/issues/${number}/comments`, { body: text });
    },
  };
}

function labelNames(raw) {
  return (raw || []).map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean);
}

export function normalizeIssue(repo, raw) {
  return {
    repo: repo.name,
    number: raw.number,
    url: raw.html_url || null,
    title: raw.title || "",
    body: raw.body || "",
    state: raw.state === "closed" ? "closed" : "open",
    stateReason: raw.state_reason ?? null,
    labels: labelNames(raw.labels),
  };
}

/** The last `<!-- tracker: {json} -->` block in an issue body, or null. */
export function parseTrackerMarker(body) {
  const matches = [...String(body || "").matchAll(/<!--\s*tracker:\s*([\s\S]*?)-->/g)];
  if (!matches.length) return null;
  try {
    const value = JSON.parse(matches.at(-1)[1].trim());
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** An explicit `status:<value>` label wins; otherwise derive from state and labels. */
export function trackerStatusOf(issue) {
  const lower = issue.labels.map((label) => label.toLowerCase());
  const explicit = lower
    .map((label) => /^status:(.+)$/.exec(label)?.[1])
    .find((value) => TRACKER_STATUSES.includes(value));
  if (explicit) return { status: explicit, statusSource: "explicit" };
  if (issue.state === "closed" && issue.stateReason === "completed") return { status: "live", statusSource: "derived" };
  if (lower.includes("needs-decision")) return { status: "needs-decision", statusSource: "derived" };
  return { status: "open", statusSource: "derived" };
}

/**
 * The GitHub edit that makes `status` true: exactly one `status:*` label, the
 * `needs-decision` label only alongside that status, closed-as-completed for
 * `live`, and reopened for anything else.
 */
export function statusPatch(issue, status) {
  const labels = issue.labels.filter(
    (label) => !/^status:/i.test(label) && label.toLowerCase() !== "needs-decision",
  );
  labels.push(`status:${status}`);
  if (status === "needs-decision") labels.push("needs-decision");
  const patch = { labels };
  if (status === "live") {
    patch.state = "closed";
    patch.state_reason = "completed";
  } else if (issue.state === "closed") {
    patch.state = "open";
    patch.state_reason = "reopened";
  }
  return patch;
}

function text(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function developerOf(issue, marker) {
  for (const label of issue.labels) {
    const owner = /^owner:(.+)$/i.exec(label)?.[1]?.toLowerCase();
    if (owner && DEVELOPERS[owner]) return DEVELOPERS[owner];
  }
  return DEVELOPERS[String(marker.owner || "").toLowerCase()] ?? null;
}

export function projectTrackerItem(issue, decisions = []) {
  const marker = parseTrackerMarker(issue.body) ?? {};
  const section = text(marker.section)?.toLowerCase() ?? null;
  const order = Number.isFinite(Number(marker.order)) && marker.order !== null && marker.order !== ""
    ? Number(marker.order)
    : null;
  return {
    key: `${issue.repo}#${issue.number}`,
    repo: issue.repo,
    number: issue.number,
    url: issue.url,
    section,
    order,
    ref: text(marker.ref),
    module: text(marker.module) ?? (section ? SECTION_LABELS[section] ?? null : null),
    developer: developerOf(issue, marker),
    requirement: text(marker.summary) ?? issue.title,
    category: text(marker.category),
    ...trackerStatusOf(issue),
    decisions,
  };
}

function compareItems(a, b) {
  const rank = (section) => {
    const index = TRACKER_SECTIONS.indexOf(section);
    return index === -1 ? TRACKER_SECTIONS.length : index;
  };
  return rank(a.section) - rank(b.section)
    || (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
    || a.repo.localeCompare(b.repo)
    || a.number - b.number;
}

export function manilaDateTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

/** The comment firstmate and the developers read on the issue. Never file bytes or links. */
export function decisionComment({ name, at, text: decisionText, attachmentCount }) {
  const lines = [`Decision recorded by ${name} on ${manilaDateTime(at)} (Manila): ${decisionText}`];
  if (attachmentCount > 0) lines.push(`${attachmentCount} attachment(s) in the GRIDGO dashboard`);
  return lines.join("\n\n");
}

function requireObject(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TrackerError(400, "invalid_request", "Send a JSON object.");
  }
}

function refuseReadOnlyFields(body) {
  const field = READ_ONLY_FIELDS.find((name) => Object.hasOwn(body, name));
  if (field) {
    throw new TrackerError(
      400,
      "tracker_field_not_editable",
      `${field} comes from the report and cannot be edited here. Send only the status (and an optional note).`,
    );
  }
}

function statusValue(value, { fallback } = {}) {
  if (value == null && fallback) return fallback;
  if (typeof value !== "string" || !TRACKER_STATUSES.includes(value)) {
    throw new TrackerError(400, "invalid_tracker_status", `status must be one of: ${TRACKER_STATUSES.join(", ")}.`);
  }
  return value;
}

export function statusInput(body) {
  requireObject(body);
  refuseReadOnlyFields(body);
  const status = statusValue(body.status);
  if (body.note != null && typeof body.note !== "string") {
    throw new TrackerError(400, "invalid_request", "note must be text.");
  }
  const note = text(body.note);
  if (note && note.length > STATUS_NOTE_MAX) {
    throw new TrackerError(400, "invalid_request", `note must be ${STATUS_NOTE_MAX} characters or fewer.`);
  }
  return { status, note };
}

export function decisionInput(body) {
  requireObject(body);
  refuseReadOnlyFields(body);
  if (typeof body.text !== "string" || !body.text.trim()) {
    throw new TrackerError(400, "invalid_request", "Write the decision in text.");
  }
  const decisionText = body.text.trim();
  if (decisionText.length > DECISION_TEXT_MAX) {
    throw new TrackerError(400, "invalid_request", `The decision must be ${DECISION_TEXT_MAX} characters or fewer.`);
  }
  const rawIds = body.attachmentIds ?? [];
  if (!Array.isArray(rawIds) || rawIds.some((value) => typeof value !== "string" || !value.trim())) {
    throw new TrackerError(400, "invalid_request", "attachmentIds must be a list of uploaded file ids.");
  }
  const attachmentIds = [...new Set(rawIds.map((value) => value.trim()))];
  if (attachmentIds.length > MAX_DECISION_ATTACHMENTS) {
    throw new TrackerError(
      400,
      "too_many_attachments",
      `Attach at most ${MAX_DECISION_ATTACHMENTS} files to one decision.`,
    );
  }
  return { text: decisionText, attachmentIds, status: statusValue(body.status, { fallback: "open" }) };
}

/** Each attachment must be the caller's own ready, unbound `tracker_decision` upload. */
function assertAttachments(store, attachmentIds, user) {
  const files = [];
  for (const fileId of attachmentIds) {
    const file = (store.files || []).find((candidate) => candidate.fileId === fileId);
    if (!file || file.purpose !== "tracker_decision" || file.ownerId !== user.id) {
      throw new TrackerError(
        400,
        "invalid_tracker_attachment",
        `${fileId} is not one of your tracker_decision uploads. Upload it through POST /files with purpose tracker_decision.`,
      );
    }
    if (file.state !== "ready") {
      throw new TrackerError(409, "file_not_ready", `${fileId} is not ready. Wait for its upload to finish and try again.`);
    }
    if ((file.references || []).length) {
      throw new TrackerError(409, "tracker_attachment_in_use", `${fileId} is already attached to a decision. Upload it again.`);
    }
    files.push(file);
  }
  return files;
}

function sameSecret(presented, expected) {
  const digest = (value) => crypto.createHash("sha256").update(String(value)).digest();
  return crypto.timingSafeEqual(digest(presented), digest(expected));
}

function segment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function bearer(req) {
  return /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1]?.trim() || null;
}

export function isAdminTrackerRoute(pathname) {
  return pathname === ADMIN_BASE || pathname.startsWith(`${ADMIN_BASE}/`);
}

export function isFirstmateTrackerRoute(pathname) {
  return pathname === FIRSTMATE_BASE || pathname.startsWith(`${FIRSTMATE_BASE}/`);
}

function errorResponse(error) {
  if (error instanceof TrackerError || (Number.isInteger(error?.status) && typeof error?.code === "string")) {
    return { status: error.status, body: { error: error.code, message: error.message } };
  }
  return null;
}

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.load   domain store loader (the caller's `load`)
 * @param {(store: object) => Promise<void>} deps.save  the caller's `save` boundary
 * @param {(store: object, entry: object) => object} deps.audit  the caller's audit writer
 */
export function createTracker({
  env = process.env,
  database,
  storage,
  load,
  save,
  audit,
  fetch = globalThis.fetch,
  clock = () => new Date(),
  createId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString("hex")}`,
  cacheTtlMs = TRACKER_CACHE_TTL_MS,
} = {}) {
  const config = trackerConfig(env);
  const github = config.configured ? createGithubClient({ token: config.token, apiUrl: config.apiUrl, fetch }) : null;
  let cache = null;
  let inflight = null;

  async function readAllIssues() {
    const lists = await Promise.all([...config.repos.values()].map(async (repo) => (
      (await github.listTrackerIssues(repo)).map((raw) => normalizeIssue(repo, raw))
    )));
    const issues = new Map();
    for (const issue of lists.flat()) issues.set(`${issue.repo}#${issue.number}`, issue);
    return { fetchedAt: clock().toISOString(), at: clock().getTime(), issues };
  }

  async function snapshot({ refresh = false } = {}) {
    if (!refresh && cache && clock().getTime() - cache.at < cacheTtlMs) return cache;
    if (!inflight) {
      inflight = readAllIssues()
        .then((fresh) => {
          cache = fresh;
          return fresh;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  function remember(issue) {
    if (!cache) return;
    const key = `${issue.repo}#${issue.number}`;
    if (issue.labels.some((label) => label.toLowerCase() === "tracker")) cache.issues.set(key, issue);
    else cache.issues.delete(key);
  }

  function repoFor(name) {
    const repo = config.repos.get(name);
    if (!repo) throw new TrackerError(404, "tracker_item_not_found", `${name} is not a tracker repository.`);
    return repo;
  }

  async function freshTrackedIssue(repo, number) {
    const notFound = new TrackerError(404, "tracker_item_not_found", `${repo.name}#${number} is not a tracker item.`);
    const issue = normalizeIssue(repo, await github.getIssue(repo, number, notFound));
    if (!issue.labels.some((label) => label.toLowerCase() === "tracker")) throw notFound;
    return issue;
  }

  async function applyStatus(repo, issue, status) {
    return normalizeIssue(repo, await github.updateIssue(repo, issue.number, statusPatch(issue, status)));
  }

  /** Take the domain lock inside the running tracker transaction and commit through `save`. */
  async function commitDomain(mutate) {
    await database.query("SELECT pg_advisory_xact_lock(hashtext($1))", [DOMAIN_MUTATION_LOCK]);
    const store = await load();
    mutate(store);
    await save(store);
  }

  async function decisionsFor(where = "", values = []) {
    const rows = (await database.query(
      `SELECT d.id, d.repo, d.issue_number, d.text, d.attachment_ids, d.decided_by, d.decided_at, u.name AS decided_by_name
       FROM tracker_decisions d LEFT JOIN users u ON u.id = d.decided_by
       ${where}
       ORDER BY d.decided_at, d.id`,
      values,
    )).rows;
    const fileIds = [...new Set(rows.flatMap((row) => row.attachment_ids))];
    const files = new Map();
    if (fileIds.length) {
      const result = await database.query(
        `SELECT file_id, original_filename, detected_content_type, size_bytes, state, object_key
         FROM files WHERE file_id = ANY($1::text[])`,
        [fileIds],
      );
      for (const row of result.rows) files.set(row.file_id, row);
    }
    return rows.map((row) => ({
      id: row.id,
      itemKey: `${row.repo}#${row.issue_number}`,
      text: row.text,
      attachments: row.attachment_ids.map((fileId) => files.get(fileId)).filter(Boolean),
      decidedBy: { id: row.decided_by, name: row.decided_by_name ?? null },
      decidedAt: row.decided_at,
    }));
  }

  function publicDecision(decision) {
    return {
      id: decision.id,
      text: decision.text,
      attachments: decision.attachments.map((file) => ({
        id: file.file_id,
        name: file.original_filename,
        contentType: file.detected_content_type,
        size: file.size_bytes,
      })),
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
    };
  }

  async function itemResponse(issue) {
    const decisions = await decisionsFor("WHERE d.repo = $1 AND d.issue_number = $2", [issue.repo, issue.number]);
    return projectTrackerItem(issue, decisions.map(publicDecision));
  }

  async function listItems(refresh) {
    const { fetchedAt, issues } = await snapshot({ refresh });
    const byItem = new Map();
    for (const decision of await decisionsFor()) {
      const list = byItem.get(decision.itemKey) ?? [];
      list.push(publicDecision(decision));
      byItem.set(decision.itemKey, list);
    }
    const items = [...issues.entries()]
      .map(([key, issue]) => projectTrackerItem(issue, byItem.get(key) ?? []))
      .sort(compareItems);
    return { fetchedAt, items };
  }

  async function changeStatus(user, repo, number, input) {
    return database.transaction(async () => {
      const issue = await freshTrackedIssue(repo, number);
      const from = trackerStatusOf(issue).status;
      const updated = await applyStatus(repo, issue, input.status);
      await commitDomain((store) => {
        audit(store, {
          actor: user,
          action: "tracker.status",
          entityType: "tracker_item",
          entityId: `${repo.name}#${number}`,
          detail: { from, to: input.status, note: input.note },
        });
      });
      remember(updated);
      return updated;
    }, { lockKey: TRACKER_LOCK });
  }

  /**
   * GitHub is written before the local commit, so a GitHub failure leaves no
   * decision behind and the Super Admin can simply retry. The decision row,
   * its file pins and the audit then commit together.
   */
  async function recordDecision(user, repo, number, input) {
    return database.transaction(async () => {
      const issue = await freshTrackedIssue(repo, number);
      const from = trackerStatusOf(issue).status;
      if (from !== "needs-decision") {
        throw new TrackerError(
          409,
          "tracker_decision_not_needed",
          `${repo.name}#${number} is ${TRACKER_STATUS_LABELS[from]}. A decision can be recorded only while it needs one.`,
        );
      }
      assertAttachments(await load(), input.attachmentIds, user);
      const decisionId = createId("tdec");
      const decidedAt = clock();
      await database.query(
        `INSERT INTO tracker_decisions (id, repo, issue_number, text, attachment_ids, decided_by, decided_at)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7)`,
        [decisionId, repo.name, number, input.text, input.attachmentIds, user.id, decidedAt.toISOString()],
      );
      await github.comment(repo, number, decisionComment({
        name: text(user.name) ?? "a Super Admin",
        at: decidedAt,
        text: input.text,
        attachmentCount: input.attachmentIds.length,
      }));
      const updated = await applyStatus(repo, issue, input.status);
      await commitDomain((store) => {
        for (const file of assertAttachments(store, input.attachmentIds, user)) {
          if (!Array.isArray(file.references)) file.references = [];
          file.references.push({ type: "tracker_decision", id: decisionId, field: "attachmentIds" });
        }
        audit(store, {
          actor: user,
          action: "tracker.decision",
          entityType: "tracker_item",
          entityId: `${repo.name}#${number}`,
          detail: { decisionId, from, to: input.status, attachmentCount: input.attachmentIds.length },
        });
      });
      remember(updated);
      return updated;
    }, { lockKey: TRACKER_LOCK });
  }

  async function signedAttachment(decisionId, attachmentId) {
    const decision = (await database.query(
      "SELECT attachment_ids FROM tracker_decisions WHERE id = $1",
      [decisionId],
    )).rows[0];
    if (!decision) throw new TrackerError(404, "tracker_decision_not_found", `Decision ${decisionId} was not found.`);
    const notFound = new TrackerError(404, "tracker_attachment_not_found", `${attachmentId} is not an attachment of this decision.`);
    if (!decision.attachment_ids.includes(attachmentId)) throw notFound;
    const file = (await database.query(
      `SELECT file_id, original_filename, detected_content_type, size_bytes, object_key
       FROM files WHERE file_id = $1 AND state = 'ready'`,
      [attachmentId],
    )).rows[0];
    if (!file) throw notFound;
    const signed = await storage.presignGet(file.object_key);
    return {
      attachmentId: file.file_id,
      name: file.original_filename,
      contentType: file.detected_content_type,
      size: file.size_bytes,
      ...signed,
    };
  }

  /** Super Admin routes. Runs after Clerk authentication; `user` may be null. */
  async function routeAdmin({ req, res, pathname, url, user, readBody, send }) {
    if (!isAdminTrackerRoute(pathname)) return false;
    try {
      if (!user) throw new TrackerError(401, "unauthorized", "Sign in to GRIDGO to open the tracker.");
      if (!identityHasMembership(user, "super_admin")) {
        throw new TrackerError(403, "forbidden", "Only a Super Admin can open the tracker.");
      }
      if (!config.configured) throw new TrackerError(503, "tracker_not_configured", config.problem);

      const method = req.method;
      if (method === "GET" && pathname === ADMIN_BASE) {
        send(res, 200, await listItems(url?.searchParams.get("refresh") === "1"));
        return true;
      }
      const attachment = /^\/admin\/tracker\/decisions\/([^/]+)\/attachments\/([^/]+)$/.exec(pathname);
      if (method === "GET" && attachment) {
        send(res, 200, await signedAttachment(segment(attachment[1]), segment(attachment[2])));
        return true;
      }
      const itemAction = /^\/admin\/tracker\/([^/]+)\/([^/]+)\/(status|decisions)$/.exec(pathname);
      const route = itemAction && `${method} ${itemAction[3]}`;
      if (route === "PATCH status" || route === "POST decisions") {
        const repo = repoFor(segment(itemAction[1]));
        const number = Number(itemAction[2]);
        if (!Number.isSafeInteger(number) || number < 1) {
          throw new TrackerError(404, "tracker_item_not_found", `${itemAction[2]} is not an issue number.`);
        }
        const body = await readBody(req);
        const updated = route === "PATCH status"
          ? await changeStatus(user, repo, number, statusInput(body))
          : await recordDecision(user, repo, number, decisionInput(body));
        send(res, 200, await itemResponse(updated));
        return true;
      }
      throw new TrackerError(404, "not_found", `No ${method} route for ${pathname}.`);
    } catch (error) {
      const response = errorResponse(error);
      if (!response) throw error;
      send(res, response.status, response.body);
      return true;
    }
  }

  /** firstmate's service-token routes. Invisible (404) unless FIRSTMATE_TRACKER_TOKEN is set. */
  async function routeFirstmate({ req, res, pathname, url, send }) {
    if (!isFirstmateTrackerRoute(pathname)) return false;
    try {
      if (!config.firstmateToken) {
        send(res, 404, { error: "not_found", path: pathname });
        return true;
      }
      const presented = bearer(req);
      if (!presented || !sameSecret(presented, config.firstmateToken)) {
        throw new TrackerError(401, "unauthorized", "Send the firstmate tracker token as a Bearer credential.");
      }
      if (req.method === "GET" && pathname === FIRSTMATE_BASE) {
        const unprocessed = url?.searchParams.get("unprocessed") === "1";
        const decisions = await decisionsFor(unprocessed ? "WHERE d.processed_at IS NULL" : "");
        const out = [];
        for (const decision of decisions) {
          const attachments = [];
          for (const file of decision.attachments) {
            if (file.state !== "ready") continue;
            const signed = await storage.presignGet(file.object_key);
            attachments.push({
              name: file.original_filename,
              contentType: file.detected_content_type,
              url: signed.url,
              expiresAt: signed.expiresAt,
            });
          }
          out.push({
            id: decision.id,
            itemKey: decision.itemKey,
            text: decision.text,
            decidedBy: decision.decidedBy,
            decidedAt: decision.decidedAt,
            attachments,
          });
        }
        send(res, 200, { decisions: out });
        return true;
      }
      const processed = /^\/firstmate\/tracker\/decisions\/([^/]+)\/processed$/.exec(pathname);
      if (req.method === "POST" && processed) {
        const decisionId = segment(processed[1]);
        const row = await database.transaction(async () => (await database.query(
          `UPDATE tracker_decisions SET processed_at = coalesce(processed_at, $2)
           WHERE id = $1 RETURNING id, processed_at`,
          [decisionId, clock().toISOString()],
        )).rows[0], { lockKey: TRACKER_LOCK });
        if (!row) throw new TrackerError(404, "tracker_decision_not_found", `Decision ${decisionId} was not found.`);
        send(res, 200, { id: row.id, processedAt: row.processed_at });
        return true;
      }
      throw new TrackerError(404, "not_found", `No ${req.method} route for ${pathname}.`);
    } catch (error) {
      const response = errorResponse(error);
      if (!response) throw error;
      send(res, response.status, response.body);
      return true;
    }
  }

  return { config, routeAdmin, routeFirstmate };
}
