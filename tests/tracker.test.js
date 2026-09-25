import test from "node:test";
import assert from "node:assert/strict";

import {
  AttachmentError,
  authorizeFileRead,
  authorizeFileUpload,
  markFileDeletePending,
  resolveFileTarget,
  validateUpload,
} from "../src/attachments.js";
import {
  DEFAULT_TRACKER_REPOS,
  createGithubClient,
  decisionComment,
  decisionInput,
  parseTrackerMarker,
  projectTrackerItem,
  statusInput,
  statusPatch,
  trackerConfig,
  trackerStatusOf,
} from "../src/tracker.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PDF = Buffer.from("%PDF-1.7\n");
const SUPER = { id: "user_super", role: "super_admin" };
const OPS = { id: "user_ops", role: "ops_admin" };

function issue(overrides = {}) {
  return { repo: "gridgo-api", number: 7, url: "https://github.com/gridgoph/gridgo-api/issues/7", title: "T", body: "", state: "open", stateReason: null, labels: ["tracker"], ...overrides };
}

test("trackerConfig defaults to the five repositories and is unconfigured without a token", () => {
  const empty = trackerConfig({});
  assert.equal(empty.configured, false);
  assert.match(empty.problem, /GITHUB_TRACKER_TOKEN/);
  assert.deepEqual([...empty.repos.keys()], DEFAULT_TRACKER_REPOS.map((repo) => repo.split("/")[1]));

  const custom = trackerConfig({ GITHUB_TRACKER_TOKEN: "t", GITHUB_TRACKER_REPOS: " gridgo-api , other/gridgo-web " });
  assert.equal(custom.configured, true);
  assert.deepEqual(custom.repos.get("gridgo-api"), { owner: "gridgoph", name: "gridgo-api" });
  assert.deepEqual(custom.repos.get("gridgo-web"), { owner: "other", name: "gridgo-web" });

  const bad = trackerConfig({ GITHUB_TRACKER_TOKEN: "t", GITHUB_TRACKER_REPOS: "a/b/c" });
  assert.equal(bad.configured, false);
  assert.match(bad.problem, /owner\/name/);
  assert.equal(trackerConfig({ GITHUB_TRACKER_TOKEN: "t", GITHUB_TRACKER_REPOS: "x/api,y/api" }).configured, false);
});

test("parseTrackerMarker reads the last marker block and ignores broken JSON", () => {
  const body = 'Text\n<!-- tracker: {"id":"old"} -->\nMore\n<!-- tracker: {"id":"G-3","section":"general"} -->';
  assert.deepEqual(parseTrackerMarker(body), { id: "G-3", section: "general" });
  assert.equal(parseTrackerMarker("<!-- tracker: {nope -->"), null);
  assert.equal(parseTrackerMarker("no marker"), null);
});

test("status: an explicit label wins, otherwise live when closed as completed, needs-decision when labelled, else open", () => {
  assert.deepEqual(trackerStatusOf(issue({ labels: ["tracker", "status:blocked", "needs-decision"] })), { status: "blocked", statusSource: "explicit" });
  assert.deepEqual(trackerStatusOf(issue({ labels: ["Status:In-Review"] })), { status: "in-review", statusSource: "explicit" });
  assert.deepEqual(trackerStatusOf(issue({ state: "closed", stateReason: "completed" })), { status: "live", statusSource: "derived" });
  assert.deepEqual(trackerStatusOf(issue({ state: "closed", stateReason: "not_planned" })), { status: "open", statusSource: "derived" });
  assert.deepEqual(trackerStatusOf(issue({ labels: ["tracker", "needs-decision"] })), { status: "needs-decision", statusSource: "derived" });
  assert.deepEqual(trackerStatusOf(issue({ labels: ["tracker", "status:bogus"] })), { status: "open", statusSource: "derived" });
});

test("statusPatch keeps exactly one status label, pairs needs-decision, closes for live and reopens otherwise", () => {
  const base = issue({ labels: ["tracker", "owner:mark", "status:open", "status:blocked", "needs-decision"] });
  assert.deepEqual(statusPatch(base, "in-review"), { labels: ["tracker", "owner:mark", "status:in-review"] });
  assert.deepEqual(statusPatch(base, "needs-decision"), { labels: ["tracker", "owner:mark", "status:needs-decision", "needs-decision"] });
  assert.deepEqual(statusPatch(base, "live"), { labels: ["tracker", "owner:mark", "status:live"], state: "closed", state_reason: "completed" });
  const closed = issue({ state: "closed", stateReason: "completed", labels: ["tracker", "status:live"] });
  assert.deepEqual(statusPatch(closed, "merged-dev"), { labels: ["tracker", "status:merged-dev"], state: "open", state_reason: "reopened" });
  assert.deepEqual(statusPatch(closed, "live"), { labels: ["tracker", "status:live"], state: "closed", state_reason: "completed" });
});

test("projectTrackerItem maps the marker, developer label and module fallback", () => {
  const body = 'x\n<!-- tracker: {"id":"S1-2","section":"step-01","order":2,"ref":"1.2","summary":"Client can pay","category":"Payments","sheetStatus":"Open","owner":"ven"} -->';
  const item = projectTrackerItem(issue({ body, labels: ["tracker", "owner:mark"] }), []);
  assert.deepEqual(item, {
    key: "gridgo-api#7", repo: "gridgo-api", number: 7, url: "https://github.com/gridgoph/gridgo-api/issues/7",
    section: "step-01", order: 2, ref: "1.2", module: "Step 01", developer: "Mark",
    requirement: "Client can pay", category: "Payments", status: "open", statusSource: "derived", decisions: [],
  });
  const noLabel = projectTrackerItem(issue({ body: '<!-- tracker: {"owner":"ven","module":"Supplier onboarding","section":"supplier"} -->' }));
  assert.equal(noLabel.developer, "Ven");
  assert.equal(noLabel.module, "Supplier onboarding");
  assert.equal(noLabel.requirement, "T");
});

test("statusInput and decisionInput validate text, limits, statuses and read-only fields", () => {
  assert.deepEqual(statusInput({ status: "live", note: "  shipped " }), { status: "live", note: "shipped" });
  assert.throws(() => statusInput({ status: "done" }), { code: "invalid_tracker_status" });
  assert.throws(() => statusInput({ status: "open", requirement: "new" }), { code: "tracker_field_not_editable" });
  assert.throws(() => statusInput({ status: "open", category: "x" }), { code: "tracker_field_not_editable" });

  assert.deepEqual(decisionInput({ text: " Go with B " }), { text: "Go with B", attachmentIds: [], status: "open" });
  assert.deepEqual(decisionInput({ text: "ok", attachmentIds: ["f1", "f1", "f2"], status: "blocked" }), { text: "ok", attachmentIds: ["f1", "f2"], status: "blocked" });
  assert.throws(() => decisionInput({ text: "   " }), { code: "invalid_request" });
  assert.throws(() => decisionInput({}), { code: "invalid_request" });
  assert.equal(decisionInput({ text: "x".repeat(5000) }).text.length, 5000);
  assert.throws(() => decisionInput({ text: "x".repeat(5001) }), { code: "invalid_request" });
  assert.throws(() => decisionInput({ text: "ok", attachmentIds: ["1", "2", "3", "4", "5", "6", "7"] }), { code: "too_many_attachments" });
  assert.throws(() => decisionInput({ text: "ok", attachmentIds: [3] }), { code: "invalid_request" });
  assert.throws(() => decisionInput({ text: "ok", status: "shipped" }), { code: "invalid_tracker_status" });
  assert.throws(() => decisionInput({ text: "ok", module: "Step 9" }), { code: "tracker_field_not_editable" });
});

test("decisionComment names the Super Admin and Manila time, never file links", () => {
  const at = new Date("2026-09-25T06:03:00.000Z");
  assert.equal(
    decisionComment({ name: "Ria", at, text: "Use option B", attachmentCount: 2 }),
    "Decision recorded by Ria on Sep 25, 2026, 2:03 PM (Manila): Use option B\n\n2 attachment(s) in the GRIDGO dashboard",
  );
  assert.equal(
    decisionComment({ name: "Ria", at, text: "No files", attachmentCount: 0 }),
    "Decision recorded by Ria on Sep 25, 2026, 2:03 PM (Manila): No files",
  );
});

test("tracker_decision uploads: Super Admin only, png/jpeg/webp/pdf, 10 MB, private from Operations", () => {
  authorizeFileUpload(SUPER, "tracker_decision");
  assert.throws(() => authorizeFileUpload(OPS, "tracker_decision"), { code: "forbidden" });
  assert.throws(() => authorizeFileUpload({ id: "c", role: "client" }, "tracker_decision"), { code: "forbidden" });

  const upload = (name, bytes, size = bytes.length) => ({ originalFilename: name, declaredContentType: "", size, sniffBytes: bytes });
  assert.equal(validateUpload(upload("shot.png", PNG), "tracker_decision"), "image/png");
  assert.equal(validateUpload(upload("brief.pdf", PDF), "tracker_decision"), "application/pdf");
  assert.equal(validateUpload(upload("max.png", PNG, 10 * 1024 * 1024), "tracker_decision"), "image/png");
  assert.throws(() => validateUpload(upload("big.png", PNG, 10 * 1024 * 1024 + 1), "tracker_decision"), { code: "file_too_large" });
  assert.throws(() => validateUpload(upload("a.psd", Buffer.from("8BPS....")), "tracker_decision"), AttachmentError);
  assert.throws(() => validateUpload(upload("a.gif", Buffer.from("GIF89a..")), "tracker_decision"), AttachmentError);

  const file = { fileId: "f1", ownerId: "user_super", purpose: "tracker_decision", state: "ready", references: [] };
  authorizeFileRead(SUPER, { files: [file] }, file);
  assert.throws(() => authorizeFileRead(OPS, { files: [file] }, file), { code: "forbidden" });
  assert.throws(() => markFileDeletePending({ ...file }, OPS, "2026-09-25T00:00:00Z"), { code: "forbidden" });
  assert.throws(
    () => markFileDeletePending({ ...file, references: [{ type: "tracker_decision", id: "tdec_1", field: "attachmentIds" }] }, SUPER, "2026-09-25T00:00:00Z"),
    { code: "file_in_use" },
  );
  assert.throws(() => resolveFileTarget({}, "tracker_decision", {}, SUPER), { code: "tracker_decision_not_attachable" });
});

test("GitHub client sends the server token, paginates, drops pull requests and never relays GitHub errors", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const page = Number(new URL(url).searchParams.get("page"));
    const body = page === 1
      ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1, ...(i === 0 ? { pull_request: {} } : {}) }))
      : [{ number: 101 }];
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const client = createGithubClient({ token: "ghp_secret", apiUrl: "https://gh.test", fetch });
  const issues = await client.listTrackerIssues({ owner: "gridgoph", name: "gridgo-api" });
  assert.equal(issues.length, 100);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.Authorization, "Bearer ghp_secret");
  assert.match(calls[0].url, /^https:\/\/gh\.test\/repos\/gridgoph\/gridgo-api\/issues\?labels=tracker&state=all/);

  const refused = createGithubClient({ token: "ghp_secret", apiUrl: "https://gh.test", fetch: async () => new Response('{"message":"Bad credentials"}', { status: 401 }) });
  await assert.rejects(refused.getIssue({ owner: "o", name: "n" }, 1), (error) => error.status === 502 && error.code === "tracker_github_unavailable" && !error.message.includes("ghp_secret"));
  const down = createGithubClient({ token: "t", fetch: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(down.getIssue({ owner: "o", name: "n" }, 1), { code: "tracker_github_unavailable" });
});
