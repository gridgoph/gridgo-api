import { identityHasMembership } from './authorization-context.js';
import { voucherFail as fail } from './vouchers.js';
import { promotionSettings, promotionVersion, updatedPromotionSettings } from './promotion-settings.js';
import { adminPromotions, myPromotions, claimFounding, inviteFriend, claimFriendPass, promotionBudget } from './promotions.js';
import { queueInvalidate, privilegedAdminMemberships } from './notifications.js';

export async function routePromotions({ req, url, store, user, readBody, id, now }) {
  const path = url.pathname;
  if (!(path === '/admin/promotions' || path === '/me/promotions' || path.startsWith('/me/promotions/'))) return null;
  if (!user) fail(401, 'unauthorized');
  const admin = identityHasMembership(user, 'super_admin'), ops = admin || identityHasMembership(user, 'ops_admin');
  if (path.startsWith('/admin/') ? !ops : !identityHasMembership(user, 'client')) fail(403, 'forbidden');
  const at = now(), ctx = { id, at };
  const result = (body, mutated = false) => ({ status: 200, body, mutated });
  if (path === '/admin/promotions') {
    if (req.method === 'GET') return result(adminPromotions(store, at));
    if (req.method !== 'PATCH') fail(404, 'not_found');
    if (!admin) fail(403, 'forbidden');
    const body = await readBody(req), next = updatedPromotionSettings(store, body);
    if (next.budgetCapMinor < promotionBudget(store, at).committedMinor) fail(409, 'promotion_budget_reached');
    const previous = promotionSettings(store), version = promotionVersion(store) + 1;
    store.promotionSettings = [{ id: 'launch', version, settings: next }];
    store.auditLog ||= [];
    store.auditLog.push({ id: id('aud'), at, actorId: user.id, actorRole: 'super_admin', action: 'promotion.settings_updated',
      entityType: 'promotion_settings', entityId: 'launch', detail: { previous, current: next, version }, reason: body.reason || null });
    store.notifications ||= [];
    for (const membership of privilegedAdminMemberships(store)) store.notifications.push({ id: id('not'), at, userId: membership.userId, appRole: membership.role,
      type: 'promotion_settings_updated', title: 'Promotion settings updated', body: `Promotion settings version ${version} is active for new claims.`, read: false });
    queueInvalidate(store, { resource: 'notifications', userIds: privilegedAdminMemberships(store).map(m => m.userId) });
    return result(adminPromotions(store, at), true);
  }
  if (path === '/me/promotions' && req.method === 'GET') return result(myPromotions(store, user.id, at));
  if (req.method !== 'POST') fail(404, 'not_found');
  if (path === '/me/promotions/founding/claim') claimFounding(store, user.id, ctx);
  else if (path === '/me/promotions/friend-pass/invite') inviteFriend(store, user.id, (await readBody(req))?.email, ctx);
  else if (path === '/me/promotions/friend-pass/claim') claimFriendPass(store, user.id, ctx);
  else fail(404, 'not_found');
  queueInvalidate(store, { resource: 'identity', userIds: [user.id] });
  return result(myPromotions(store, user.id, at), true);
}
