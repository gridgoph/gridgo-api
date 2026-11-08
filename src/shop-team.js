import { createHash, randomBytes } from 'node:crypto';
import { clerkClientProfile } from './auth.js';
import { identityHasMembership, selectActorRole } from './authorization-context.js';
import { ensureShopOwners } from './shop-team-store.js';
import { queueInvalidate } from './notifications.js';

export const shopTeamError = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
export const inviteHash = token => createHash('sha256').update(token).digest('hex');
export const actorUserId = user => user?.actorUserId || user?.id;
export const actorRole = user => user?.shopRole || user?.role || 'system';
export const isShopStaff = user => user?.shopRole === 'staff';
const ops = user => identityHasMembership(user, 'ops_admin') || identityHasMembership(user, 'super_admin');
const isoNow = () => new Date().toISOString();

export function shopMembershipsFor(store, userId) {
  const rows = (store.shopMemberships || []).filter(row => row.userId === userId);
  // Compatibility for newly enrolled owners before their first save. Never revive a removed row.
  if (!rows.some(row => row.shopId === userId) && (store.userRoleMemberships || []).some(m => m.userId === userId && m.role === 'supplier')) {
    rows.push({ shopId: userId, userId, role: 'owner', status: 'active' });
  }
  return rows;
}
export function selectedShop(store, user, shopId) {
  const rows = shopMembershipsFor(store, user.id);
  if (shopId) {
    const row = rows.find(row => row.shopId === shopId);
    if (!row) shopTeamError(403, 'shop_membership_required');
    return row;
  }
  const own = rows.find(row => row.shopId === user.id);
  if (own) return own;
  const usable = rows.filter(row => row.status !== 'removed');
  if (usable.length > 1) shopTeamError(409, 'shop_selection_required');
  return usable[0] || rows[0] || null;
}
export function assertActiveShop(member) {
  if (!member) shopTeamError(403, 'shop_membership_required');
  if (member.status === 'removed') shopTeamError(403, 'shop_access_removed');
  if (member.status !== 'active') shopTeamError(403, 'shop_approval_pending');
}
export function shopSummary(store, member) {
  return { id: member.shopId, name: store.supplierProfiles?.find(row => row.userId === member.shopId)?.shopName
    || store.users.find(row => row.id === member.shopId)?.supplierName || 'Print shop', role: member.role, status: member.status };
}

// Every unlisted supplier route is Owner-only, including future routes. The
// existing handler still checks ownership, approval, artwork release and state.
export function staffRouteAllowed(method, path) {
  if (method === 'GET' && ['/auth/me', '/auth/me/supplier', '/me/shop-memberships', '/notifications', '/notifications/stream', '/web-push/public-key', '/orders', '/jobs'].includes(path)) return true;
  if (method === 'POST' && ['/auth/logout', '/devices', '/web-push/subscribe', '/web-push/unsubscribe', '/notifications/read-all'].includes(path)) return true;
  if (['POST', 'DELETE'].includes(method) && /^\/devices(?:\/[^/]+)?$/.test(path)) return true;
  if (['POST', 'PATCH', 'DELETE'].includes(method) && /^\/notifications\/[^/]+(?:\/read)?$/.test(path)) return true;
  if (method === 'GET' && /^\/orders\/[^/]+$/.test(path)) return true;
  if (method === 'GET' && /^\/dispatch\/[^/]+\/location$/.test(path)) return true;
  if (method === 'POST' && /^\/orders\/[^/]+\/(transition|decline|production-finished)$/.test(path)) return true;
  if (['GET', 'POST'].includes(method) && /^\/orders\/[^/]+\/(client-shop-chat|pickup-chat)(?:\/messages(?:\/[^/]+\/reports)?)?$/.test(path)) return true;
  if (method === 'POST' && path === '/files') return true;
  if (method === 'GET' && /^\/files\/[^/]+(?:\/(download-url|preview-url))?$/.test(path)) return true;
  if (method === 'POST' && /^\/files\/[^/]+\/(attach|preview|preview-failure)$/.test(path)) return true;
  return false;
}
export const identityShopRoute = path => /^\/(notifications|devices|web-push)(\/|$)/.test(path) || path === '/auth/logout' || path === '/me';
export function supplierShopActor(store, identity, member) {
  assertActiveShop(member);
  const shop = store.users.find(row => row.id === member.shopId);
  if (!shop || (shop.accountStatus || 'active') !== 'active') shopTeamError(403, 'shop_unavailable');
  // The legacy supplier ID is the shop key. Never copy the owner's other roles
  // into the actor; retain the signed-in person separately for audit and chat.
  const target = member.userId === member.shopId ? identity : { ...shop, name: identity.name };
  const facade = new Proxy(target, { get(object, key, receiver) {
    if (key === 'actorUserId') return identity.id;
    if (key === 'shopRole') return member.role;
    if (key === 'actorName') return identity.name;
    return Reflect.get(object, key, receiver);
  } });
  return selectActorRole(store, facade, 'supplier', { restrictMemberships: true });
}

export const STAFF_UPLOAD_PURPOSES = new Set(['fulfilment_proof', 'production_photo', 'finished_product_photo', 'packing_photo', 'client_shop_chat_attachment', 'pickup_chat_image']);
export function assertStaffFile(user, store, file, { upload = false, purpose = file?.purpose } = {}) {
  if (!isShopStaff(user)) return;
  if (upload) {
    if (!STAFF_UPLOAD_PURPOSES.has(purpose)) shopTeamError(403, 'shop_owner_required');
    return;
  }
  if (!file) return; // normal handler returns the existing not-found error
  const readPurposes = new Set([...STAFF_UPLOAD_PURPOSES, 'artwork', 'mockup', 'packing_photo', 'handoff_signature']);
  if (!readPurposes.has(file.purpose)) shopTeamError(403, 'shop_owner_required');
  if (file.ownerId === user.id && file.createdByUserId === actorUserId(user) && !file.references?.length) return;
  const refs = (file.references || []).flatMap(ref => ref.type === 'order' ? [ref] : ['client_shop_chat_message', 'pickup_chat_message'].includes(ref.type) ? [{ id: ref.orderId }] : []);
  if (!refs.length || !refs.some(ref => store.orders.some(order => order.id === ref.id && order.supplierId === user.id))) shopTeamError(403, 'forbidden');
}

function verifiedIdentities(clerkUser) {
  const email = (clerkUser?.emailAddresses || clerkUser?.email_addresses || [])
    .filter(row => row.verification?.status === 'verified').map(row => String(row.emailAddress || row.email_address || '').trim().toLowerCase());
  const phone = (clerkUser?.phoneNumbers || clerkUser?.phone_numbers || [])
    .filter(row => row.verification?.status === 'verified').map(row => String(row.phoneNumber || row.phone_number || '').trim());
  return { email, phone };
}
function inviteAvailable(invite, at) {
  if (!invite) shopTeamError(404, 'shop_invite_not_found');
  if (invite.claimedAt) shopTeamError(409, 'shop_invite_used');
  if (invite.revokedAt) shopTeamError(409, 'shop_invite_revoked');
  if (Date.parse(invite.expiresAt) <= Date.parse(at)) shopTeamError(410, 'shop_invite_expired');
}
const publicInvite = (row, at) => ({ id: row.id, shopId: row.shopId, kind: row.kind, identity: row.identity,
  createdAt: row.createdAt, expiresAt: row.expiresAt, claimedBy: row.claimedBy || null,
  status: row.claimedAt ? 'claimed' : row.revokedAt ? 'revoked' : Date.parse(row.expiresAt) <= Date.parse(at) ? 'expired' : 'open' });
function publicMember(store, member) {
  const person = store.users.find(row => row.id === member.userId);
  return { userId: member.userId, name: person?.name || 'Member', role: member.role, status: member.status,
    createdAt: member.createdAt, updatedAt: member.updatedAt };
}
export function discoverShopInvites(store, clerkUser, at = isoNow()) {
  const verified = verifiedIdentities(clerkUser);
  return (store.shopInvites || []).filter(row => !row.claimedAt && !row.revokedAt && Date.parse(row.expiresAt) > Date.parse(at)
    && verified[row.kind]?.includes(row.identity)).map(row => ({ ...publicInvite(row, at), shop: shopSummary(store, { shopId: row.shopId, role: 'staff', status: 'pending' }) }));
}
export function claimShopInvite({ store, claims, clerkUser, body, id, at, audit }) {
  if (!claims?.sub) shopTeamError(401, 'unauthorized');
  if (!body || typeof body !== 'object' || Array.isArray(body)) shopTeamError(400, 'invalid_shop_invite_claim');
  if (!clerkUser || clerkUser.id !== claims.sub) shopTeamError(502, 'clerk_unavailable');
  const invite = typeof body.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.token)
    ? store.shopInvites.find(row => row.tokenHash === inviteHash(body.token))
    : typeof body.inviteId === 'string' ? store.shopInvites.find(row => row.id === body.inviteId && ['email', 'phone'].includes(row.kind)) : null;
  inviteAvailable(invite, at);
  if (['email', 'phone'].includes(invite.kind) && !verifiedIdentities(clerkUser)[invite.kind].includes(invite.identity)) shopTeamError(403, 'shop_invite_identity_mismatch');
  let user = store.users.find(row => row.clerkUserId === claims.sub);
  if (user && (user.accountStatus || 'active') !== 'active') shopTeamError(403, 'forbidden');
  if (!user) {
    const profile = clerkClientProfile(clerkUser);
    // Phone-only Clerk accounts have no email. This private sentinel is never
    // used as verification evidence; invite matching always uses verified BAPI fields.
    const email = profile.email || `phone-${inviteHash(claims.sub)}@identity.invalid`;
    if (store.users.some(row => row.email.toLowerCase() === email.toLowerCase())) shopTeamError(409, 'email_already_registered');
    user = { id: id('user'), clerkUserId: claims.sub, email, name: profile.name || profile.phone || 'Shop staff', phone: profile.phone,
      role: 'staff', accountStatus: 'active', createdAt: at };
    store.users.push(user);
  }
  ensureShopOwners(store);
  const existing = store.shopMemberships.find(row => row.shopId === invite.shopId && row.userId === user.id);
  if (existing && existing.status !== 'removed') shopTeamError(409, 'shop_member_exists');
  const member = existing || { shopId: invite.shopId, userId: user.id, createdAt: at };
  Object.assign(member, { role: 'staff', status: 'pending', updatedAt: at, decidedBy: null });
  if (!existing) store.shopMemberships.push(member);
  invite.claimedAt = at; invite.claimedBy = user.id;
  audit(store, { actor: user, action: 'shop_team.invite_claimed', entityType: 'shop_invite', entityId: invite.id, detail: { shopId: invite.shopId } });
  queueInvalidate(store, { resource: 'identity', userIds: [invite.shopId, user.id] });
  return { member: publicMember(store, member), shop: shopSummary(store, member) };
}

export async function routeShopTeam({ req, url, store, user, readBody, id, now, audit }) {
  const path = url.pathname;
  const operations = /^\/ops\/shops\/([^/]+)\/team(?:\/([^/]+))?$/.exec(path);
  const own = /^\/me\/shop-team(?:\/(invites|members)(?:\/([^/]+))?)?$/.exec(path);
  if (path !== '/me/shop-memberships' && !operations && !own) return null;
  if (!user) shopTeamError(401, 'unauthorized');
  if ((user.accountStatus || 'active') !== 'active') shopTeamError(403, 'forbidden');
  const at = now();
  if (path === '/me/shop-memberships' && req.method === 'GET') return { status: 200, body: { shops: shopMembershipsFor(store, user.id).map(row => shopSummary(store, row)) } };
  ensureShopOwners(store);
  const member = operations ? null : selectedShop(store, user, req.headers['x-gridgo-shop-id']);
  if (operations) {
    const role = req.headers['x-gridgo-role'];
    if (!ops(user) || (role && (!['ops_admin','super_admin'].includes(role) || !identityHasMembership(user, role)))) shopTeamError(403, 'forbidden');
  }
  else { assertActiveShop(member); if (member.role !== 'owner') shopTeamError(403, 'shop_owner_required'); }
  const shopId = operations?.[1] || member.shopId;
  if (!store.shopMemberships.some(row => row.shopId === shopId)) shopTeamError(404, 'shop_not_found');
  const memberId = operations?.[2] || (own?.[1] === 'members' ? own[2] : null);
  if (req.method === 'GET' && !memberId && !own?.[2]) return { status: 200, body: {
    members: store.shopMemberships.filter(row => row.shopId === shopId).map(row => publicMember(store, row)),
    ...(!operations ? { invites: store.shopInvites.filter(row => row.shopId === shopId).map(row => publicInvite(row, at)) } : {}),
  } };
  if (!operations && own?.[1] === 'invites' && req.method === 'POST' && !own[2]) {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) shopTeamError(400, 'invalid_invite_kind');
    if (!['email', 'phone', 'qr', 'link'].includes(body.kind)) shopTeamError(400, 'invalid_invite_kind');
    let identity = null;
    if (body.kind === 'email') {
      identity = String(body.identity || '').trim().toLowerCase();
      if (identity.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity)) shopTeamError(400, 'invalid_invite_identity');
    }
    if (body.kind === 'phone') {
      identity = String(body.identity || '').trim();
      if (!/^\+[1-9][0-9]{7,14}$/.test(identity)) shopTeamError(400, 'invalid_invite_identity');
    }
    const token = randomBytes(32).toString('base64url');
    const invite = { id: id('shi'), shopId, kind: body.kind, identity, tokenHash: inviteHash(token), createdBy: user.id,
      createdAt: at, expiresAt: new Date(Date.parse(at) + 48 * 3600000).toISOString() };
    store.shopInvites.push(invite);
    audit(store, { actor: user, action: 'shop_team.invite_created', entityType: 'shop_invite', entityId: invite.id, detail: { shopId, kind: invite.kind } });
    return { status: 201, mutated: true, body: { invite: publicInvite(invite, at), token, delivery: 'share_link' } };
  }
  if (!operations && own?.[1] === 'invites' && own[2] && req.method === 'DELETE') {
    const invite = store.shopInvites.find(row => row.id === own[2] && row.shopId === shopId);
    inviteAvailable(invite, at); invite.revokedAt = at;
    audit(store, { actor: user, action: 'shop_team.invite_revoked', entityType: 'shop_invite', entityId: invite.id, detail: { shopId } });
    return { status: 200, mutated: true, body: { invite: publicInvite(invite, at) } };
  }
  if (memberId && (req.method === 'DELETE' || (!operations && req.method === 'PATCH'))) {
    const target = store.shopMemberships.find(row => row.shopId === shopId && row.userId === memberId);
    if (!target) shopTeamError(404, 'shop_member_not_found');
    const body = req.method === 'DELETE' ? { status: 'removed' } : await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) shopTeamError(400, 'invalid_shop_member_update');
    if (Object.keys(body).some(key => !['status', 'role'].includes(key)) || (!body.status && !body.role)
      || (body.status && !['active', 'removed'].includes(body.status)) || (body.role && !['owner', 'staff'].includes(body.role))) shopTeamError(400, 'invalid_shop_member_update');
    if (target.status === 'removed' && body.status !== 'removed') shopTeamError(409, 'shop_invite_required');
    const status = body.status || target.status, role = body.role || target.role;
    if (status === 'pending' && role === 'owner') shopTeamError(409, 'shop_approval_required');
    if (target.role === 'owner' && target.status === 'active' && (status !== 'active' || role !== 'owner')
      && !store.shopMemberships.some(row => row.shopId === shopId && row.userId !== target.userId && row.role === 'owner' && row.status === 'active')) shopTeamError(409, 'last_shop_owner');
    const before = { role: target.role, status: target.status };
    Object.assign(target, { status, role, updatedAt: at, decidedBy: user.id });
    audit(store, { actor: user, action: 'shop_team.member_updated', entityType: 'shop_membership', entityId: target.userId,
      detail: { shopId }, before, after: { role, status } });
    queueInvalidate(store, { resource: 'identity', userIds: [target.userId, shopId] });
    return { status: 200, mutated: true, body: { member: publicMember(store, target) } };
  }
  shopTeamError(405, 'method_not_allowed');
}

/** Only new-order notifications are fanned out; owner money/events stay private. */
export function notifyShopStaff(store, baseline, { id }) {
  const previous = new Set((baseline?.notifications || []).map(row => row.id));
  for (const notification of [...store.notifications]) {
    if (previous.has(notification.id) || notification.type !== 'shop_job_assigned' || notification.shopTeamCopy) continue;
    for (const member of store.shopMemberships || []) {
      if (member.shopId !== notification.userId || member.userId === member.shopId || member.status !== 'active') continue;
      store.notifications.push({ ...notification, id: id('ntf'), userId: member.userId, shopId: member.shopId, shopTeamCopy: true,
        occurrenceKey: `${notification.occurrenceKey || notification.id}:${member.userId}` });
    }
  }
}
