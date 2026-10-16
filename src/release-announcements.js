import { firstmateRefusal } from "./tracker.js";
import { INSTALL_CHANNELS } from "./push.js";

const APPS = new Map([["client", "Client"], ["supplier", "Supplier"], ["rider", "Rider"]]);
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

/**
 * The APK copy is the format released apps recognise to open the APK download,
 * so the store notices must never match it.
 */
const COPY = {
  apk: (label, version) => ({ title: `GRIDGO ${label} ${version} is ready`, body: "Update now for the latest fixes and features." }),
  play: (label, version) => ({ title: `GRIDGO ${label} ${version} is on the Play Store`, body: "Update from the Play Store for the latest fixes and features." }),
  ios: (label, version) => ({ title: `GRIDGO ${label} ${version} is in TestFlight`, body: "Update in TestFlight for the latest fixes and features." }),
};

export function isReleaseAnnouncementRoute(pathname) {
  return pathname === "/release-announcements" || pathname === "/firstmate/release-announcements";
}

/** Both credentials share the same durable idempotency key and transaction. */
export async function routeReleaseAnnouncement({ req, res, pathname, send, readBody, database, enqueueMutation, broadcast, env = process.env }) {
  if (!isReleaseAnnouncementRoute(pathname)) return false;
  const expected = pathname.startsWith("/firstmate/") ? env.FIRSTMATE_TRACKER_TOKEN : env.RELEASE_ANNOUNCE_TOKEN;
  // Reuse the firstmate SHA-256 + timingSafeEqual bearer check, without its route-specific copy.
  const refusal = firstmateRefusal(req, String(expected || "").trim());
  if (refusal) { send(res, refusal.status, { error: refusal.error }); return true; }
  if (req.method !== "POST") { send(res, 405, { error: "method_not_allowed" }); return true; }
  const body = await readBody(req);
  if (!body || !APPS.has(body.app) || typeof body.version !== "string" || body.version.length > 29 || !VERSION.test(body.version) || body.version.trim() !== body.version
      || (body.channel !== undefined && !INSTALL_CHANNELS.includes(body.channel))) {
    send(res, 400, { error: "invalid_release_announcement" });
    return true;
  }
  // No channel is the APK workflow call that predates stores.
  const { app, version, channel = "apk" } = body;
  const result = await enqueueMutation(async () => {
    const previous = await database.query("SELECT announcement FROM release_announcements WHERE app=$1 AND version=$2 AND channel=$3", [app, version, channel]);
    if (previous.rows.length) return { status: 200, announcement: previous.rows[0].announcement };
    const announcement = await broadcast({
      app, audience: `${app}s`, ...COPY[channel](APPS.get(app), version), releaseChannel: channel,
      actor: { role: "system" }, reason: "Published app release",
    });
    const record = { ...announcement, app, version };
    await database.query("INSERT INTO release_announcements(app,version,channel,announcement) VALUES ($1,$2,$3,$4::jsonb)", [app, version, channel, JSON.stringify(record)]);
    return { status: 201, announcement: record };
  });
  send(res, result.status, { announcement: result.announcement });
  return true;
}
