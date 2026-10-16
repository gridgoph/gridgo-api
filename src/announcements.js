import { hasRole } from "./notifications.js";
import { RELEASE_STORE_TARGETS, deviceTokensFor, installChannelOf, unclaimedDeviceTokens } from "./push.js";

export const ANNOUNCEMENT_AUDIENCES = new Map([
  ["everyone", null],
  ["clients", ["client"]],
  ["suppliers", ["supplier"]],
  ["riders", ["rider"]],
  ["ops", ["ops_admin", "super_admin"]],
]);

/**
 * An app-release notice reaches only installs from its own channel. An account
 * whose installs of this app all came from another channel gets no inbox row;
 * one with no registered install keeps the APK notice it always had.
 */
function receivesRelease(store, userId, app, releaseChannel) {
  const installs = deviceTokensFor(store, userId).filter(device => !device.appRole || device.appRole === app);
  if (installs.some(device => installChannelOf(device) === releaseChannel)) return true;
  return releaseChannel === "apk" && installs.length === 0;
}

/** Shared inbox/audit boundary. The caller saves and delivers after commit. */
export function appendAnnouncement(store, { audience, title, body, imageUrl = null, app = null, releaseChannel = null, actor, reason = null }, { id, at, audit }) {
  const roles = ANNOUNCEMENT_AUDIENCES.get(audience);
  const recipients = store.users.filter(candidate => (roles === null || roles.some(role => hasRole(store, candidate.id, role)))
    && (!releaseChannel || receivesRelease(store, candidate.id, app, releaseChannel)));
  const release = releaseChannel ? { releaseChannel, storeTarget: RELEASE_STORE_TARGETS[releaseChannel] } : {};
  const announcementId = id("anc");
  for (const recipient of recipients) {
    store.notifications.push({
      id: id("ntf"), userId: recipient.id, type: "announcement",
      ...(roles ? { audienceRoles: roles } : {}),
      ...(app ? { appRole: app } : {}),
      orderId: null, announcementId, title, body, ...release,
      ...(imageUrl ? { imageUrl } : {}), read: false, at,
    });
  }
  // Fresh anonymous installs have no appRole. Never guess their installed app.
  const unclaimed = unclaimedDeviceTokens(store).filter(device => (app ? device.appRole === app : audience === "everyone")
    && (!releaseChannel || installChannelOf(device) === releaseChannel));
  audit(store, {
    actor, action: "announcement.broadcast", entityType: "announcement", entityId: announcementId,
    detail: { audience, title, ...release, notifiedUsers: recipients.length, unclaimedDevices: unclaimed.length, hasImage: Boolean(imageUrl) },
    reason,
  });
  return {
    announcement: { id: announcementId, audience, title, body, imageUrl, ...release, at, notifiedUsers: recipients.length, unclaimedDevices: unclaimed.length },
    unclaimed,
  };
}
