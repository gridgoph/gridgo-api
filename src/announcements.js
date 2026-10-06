import { hasRole } from "./notifications.js";
import { unclaimedDeviceTokens } from "./push.js";

export const ANNOUNCEMENT_AUDIENCES = new Map([
  ["everyone", null],
  ["clients", ["client"]],
  ["suppliers", ["supplier"]],
  ["riders", ["rider"]],
  ["ops", ["ops_admin", "super_admin"]],
]);

/** Shared inbox/audit boundary. The caller saves and delivers after commit. */
export function appendAnnouncement(store, { audience, title, body, imageUrl = null, app = null, actor, reason = null }, { id, at, audit }) {
  const roles = ANNOUNCEMENT_AUDIENCES.get(audience);
  const recipients = store.users.filter(candidate => roles === null || roles.some(role => hasRole(store, candidate.id, role)));
  const announcementId = id("anc");
  for (const recipient of recipients) {
    store.notifications.push({
      id: id("ntf"), userId: recipient.id, type: "announcement",
      ...(roles ? { audienceRoles: roles } : {}),
      ...(app ? { appRole: app } : {}),
      orderId: null, announcementId, title, body,
      ...(imageUrl ? { imageUrl } : {}), read: false, at,
    });
  }
  // Fresh anonymous installs have no appRole. Never guess their installed app.
  const unclaimed = unclaimedDeviceTokens(store).filter(device => app ? device.appRole === app : audience === "everyone");
  audit(store, {
    actor, action: "announcement.broadcast", entityType: "announcement", entityId: announcementId,
    detail: { audience, title, notifiedUsers: recipients.length, unclaimedDevices: unclaimed.length, hasImage: Boolean(imageUrl) },
    reason,
  });
  return {
    announcement: { id: announcementId, audience, title, body, imageUrl, at, notifiedUsers: recipients.length, unclaimedDevices: unclaimed.length },
    unclaimed,
  };
}
