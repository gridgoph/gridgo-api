import { effectiveShopRole, memberPreferences, routeTeamWork, resolveShopWorker, teamPhotoReadable, bindTeamPhoto } from './shop-team-work.js';
import { expressOfferCopy } from './express-offers.js';
import { createHash, randomBytes } from 'node:crypto';
import { clerkClientProfile } from './auth.js';
import { identityHasMembership, selectActorRole } from './authorization-context.js';
import { ensureShopOwners } from './shop-team-store.js';
import { queueInvalidate, privilegedAdminMemberships } from './notifications.js';
import { canReadOrderArtwork } from './order-file-access.js';
import { signupForShop } from './supplier-signup.js';

export const shopTeamError = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
export const inviteHash = token => createHash('sha256').update(token).digest('hex');
export const actorUserId = user => user?.actorUserId || user?.id;
export const actorRole = user => user?.shopRole || user?.role || 'system';
export const isShopStaff = user => ['staff','manager'].includes(user?.shopRole);
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
  const lastUsed = rows.filter(row => row.status === 'active' && row.lastUsedAt)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || a.shopId.localeCompare(b.shopId))[0];
  if (lastUsed) return lastUsed;
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
    || store.users.find(row => row.id === member.shopId)?.supplierName || 'Print shop', role: effectiveShopRole(store, member), status: member.status };
}

// Every unlisted supplier route is Owner-only, including future routes. The
// existing handler still checks ownership, approval, artwork release and state.
export function staffRouteAllowed(method, path) {
  if (method === 'GET' && ['/me/shop-team','/me/shop-team/stats','/me/shop-team/settings','/me/shop-team/working'].includes(path)) return true;
  if (method === 'POST' && ['/me/shop-team/working/select','/me/shop-team/working/lock'].includes(path)) return true;
  if (method === 'PATCH' && path === '/me/shop-team/me') return true;
  if (method === 'PATCH' && path === '/me/shop-memberships/selected') return true;
  if (method === 'GET' && ['/auth/me', '/auth/me/supplier', '/me/shop-memberships', '/notifications', '/notifications/stream', '/web-push/public-key', '/orders', '/jobs', '/me/shop-status'].includes(path)) return true;
  if (method === 'POST' && ['/auth/logout', '/devices', '/web-push/subscribe', '/web-push/unsubscribe', '/notifications/read-all'].includes(path)) return true;
  if (['POST', 'DELETE'].includes(method) && /^\/devices(?:\/[^/]+)?$/.test(path)) return true;
  if (['POST', 'PATCH', 'DELETE'].includes(method) && /^\/notifications\/[^/]+(?:\/read)?$/.test(path)) return true;
  if (method === 'GET' && /^\/orders\/[^/]+$/.test(path)) return true;
  if (method === 'GET' && /^\/dispatch\/[^/]+\/location$/.test(path)) return true;
  if (method === 'POST' && /^\/orders\/[^/]+\/(transition|decline|production-finished|production-progress|express\/(accept|decline|pickup)|files\/[^/]+\/access)$/.test(path)) return true;
  if (['GET', 'POST'].includes(method) && /^\/orders\/[^/]+\/(client-shop-chat|pickup-chat)(?:\/messages(?:\/[^/]+\/reports)?)?$/.test(path)) return true;
  if (method === 'POST' && path === '/files') return true;
  if (method === 'GET' && /^\/files\/[^/]+(?:\/(download-url|preview-url))?$/.test(path)) return true;
  if (method === 'POST' && /^\/files\/[^/]+\/(attach|preview|preview-failure)$/.test(path)) return true;
  return false;
}
export const identityShopRoute = path => /^\/(notifications|devices|web-push)(\/|$)/.test(path) || path === '/auth/logout' || path === '/me';
export function supplierShopActor(store, identity, member, worker = null) {
  assertActiveShop(member);
  const shop = store.users.find(row => row.id === member.shopId);
  if (!shop || (shop.accountStatus || 'active') !== 'active') shopTeamError(403, 'shop_unavailable');
  // The legacy supplier ID is the shop key. Never copy the owner's other roles
  // into the actor; retain the signed-in person separately for audit and chat.
  const target = member.userId === member.shopId ? identity : { ...shop, name: identity.name };
  const facade = new Proxy(target, { get(object, key, receiver) {
    if (key === 'actorUserId') return identity.id;
    if (key === 'shopRole') return worker?.role || effectiveShopRole(store,member);
    if (key === 'actorPinStaffId') return worker?.pinStaffId || null;
    if (key === 'actorName') return worker?.name || identity.name;
    return Reflect.get(object, key, receiver);
  } });
  return selectActorRole(store, facade, 'supplier', { restrictMemberships: true });
}

export const STAFF_UPLOAD_PURPOSES = new Set(['shop_team_photo','fulfilment_proof', 'production_photo', 'finished_product_photo', 'packing_photo', 'client_shop_chat_attachment', 'pickup_chat_image']);
export function assertStaffFile(user, store, file, { upload = false, purpose = file?.purpose } = {}) {
  if (!isShopStaff(user)) return;
  if (purpose === 'shop_team_photo') {
    if (upload || teamPhotoReadable(store,file,user,user.id)) return;
    shopTeamError(403,'forbidden');
  }
  if (user.shopRole === 'manager' && ['catalog_item_photo','supplier_price_list'].includes(purpose)) {
    if (upload || file?.ownerId === user.id) return;
    shopTeamError(403,'forbidden');
  }
  if (upload) {
    if (!STAFF_UPLOAD_PURPOSES.has(purpose)) shopTeamError(403, 'shop_owner_required');
    return;
  }
  if (!file) return; // normal handler returns the existing not-found error
  const readPurposes = new Set([...STAFF_UPLOAD_PURPOSES, 'artwork', 'mockup', 'packing_photo', 'handoff_signature']);
  if (!readPurposes.has(file.purpose)) shopTeamError(403, 'shop_owner_required');
  if (file.ownerId === user.id && file.createdByUserId === actorUserId(user) && !file.references?.length) return;
  const refs = (file.references || []).flatMap(ref => ref.type === 'order' ? [ref] : ['client_shop_chat_message', 'pickup_chat_message'].includes(ref.type) ? [{ id: ref.orderId }] : []);
  if (!refs.some(ref => store.orders.some(order => {
    if (order.id !== ref.id) return false;
    const jobs = (store.orderJobs || []).filter(job => job.orderId === order.id && job.state !== 'cancelled');
    const ownWork = order.supplierId === user.id || (!order.supplierId && jobs.length > 1 && jobs.some(job => job.supplierId === user.id));
    return ownWork && (!['artwork', 'mockup'].includes(file.purpose)
      || canReadOrderArtwork(user, store, order, file.fileId, file.purpose, file));
  }))) shopTeamError(403, 'forbidden');
}

export function verifiedIdentities(clerkUser) {
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
export function publicMember(store, member) {
  const person = store.users.find(row => row.id === member.userId);
  return { userId: member.userId, name: person?.name || 'Member', role: effectiveShopRole(store, member), status: member.status,
    createdAt: member.createdAt, updatedAt: member.updatedAt, jobAlerts: memberPreferences(store,member.shopId,member.userId)?.jobAlerts !== false, photoFileId: memberPreferences(store,member.shopId,member.userId)?.photoFileId || null };
}
function issueShopInvite({ store, user, shopId, kind, identity, at, id, audit }) {
  const token = randomBytes(32).toString('base64url');
  const invite = { id: id('shi'), shopId, kind, identity, tokenHash: inviteHash(token), createdBy: user.id,
    createdAt: at, lifetimeHours: 24, expiresAt: new Date(Date.parse(at) + 24 * 3600000).toISOString() };
  (store.shopInvites||=[]).push(invite);
  audit(store, { actor: user, action: 'shop_team.invite_created', entityType: 'shop_invite', entityId: invite.id, detail: { shopId, kind } });
  return { status: 201, mutated: true, body: { invite: publicInvite(invite, at), token, delivery: 'share_link' } };
}
export function discoverShopInvites(store, clerkUser, at = isoNow()) {
  const verified = verifiedIdentities(clerkUser);
  return (store.shopInvites || []).filter(row => !row.claimedAt && !row.revokedAt && Date.parse(row.expiresAt) > Date.parse(at)
    && verified[row.kind==='owner'?'phone':row.kind]?.includes(row.identity)).map(row => ({ ...publicInvite(row, at), shop: shopSummary(store, { shopId: row.shopId, role: 'staff', status: 'pending' }) }));
}
export function claimShopInvite({ store, claims, clerkUser, body, id, at, audit }) {
  if (!claims?.sub) shopTeamError(401, 'unauthorized');
  if (!body || typeof body !== 'object' || Array.isArray(body)) shopTeamError(400, 'invalid_shop_invite_claim');
  if (!clerkUser || clerkUser.id !== claims.sub) shopTeamError(502, 'clerk_unavailable');
  const invite = typeof body.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.token)
    ? store.shopInvites.find(row => row.tokenHash === inviteHash(body.token))
    : typeof body.inviteId === 'string' ? store.shopInvites.find(row => row.id === body.inviteId && ['email', 'phone','owner'].includes(row.kind)) : null;
  inviteAvailable(invite, at);
  if (['email', 'phone','owner'].includes(invite.kind) && !verifiedIdentities(clerkUser)[invite.kind==='owner'?'phone':invite.kind].includes(invite.identity)) shopTeamError(403, 'shop_invite_identity_mismatch');
  let user = store.users.find(row => row.clerkUserId === claims.sub);
  if (user && (user.accountStatus || 'active') !== 'active') shopTeamError(403, 'forbidden');
  if (body.choice!==undefined && !(invite.kind==='owner' && body.choice==='not_right')) shopTeamError(400,'invalid_shop_invite_claim');
  if(invite.kind==='owner') {
    const signup=signupForShop(store,invite.shopId);
    if(signup?.clerkUserId===claims.sub)shopTeamError(403,'shop_owner_separate_account_required');
    if(!signup || signup.steps.eligibility.registrantRole!=='manager' || signup.steps.shop.ownerPhone!==invite.identity
      || store.shopMemberships.some(m=>m.shopId===invite.shopId&&m.role==='owner'&&m.status==='active')) shopTeamError(409,'shop_owner_already_claimed');
    if(body.choice==='not_right') {
      const profile=store.supplierProfiles.find(p=>p.userId===invite.shopId);
      profile.isClosed=true;profile.version=(profile.version||1)+1;profile.updatedAt=at;
      signup.steps.ownerClaim={status:'disputed',at};signup.updatedAt=at;signup.version++;
      invite.revokedAt=at;
      audit(store,{actor:store.users.find(u=>u.clerkUserId===claims.sub)||null,action:'shop_team.ownership_disputed',entityType:'shop_invite',entityId:invite.id,detail:{shopId:invite.shopId}});
      for(const recipient of [{userId:invite.shopId,appRole:'supplier'},...privilegedAdminMemberships(store).map(m=>({userId:m.userId,appRole:m.role}))]) {
        store.notifications.push({id:id('ntf'),...recipient,type:'shop_ownership_disputed',shopId:invite.shopId,title:'Shop ownership needs review',body:'The invited owner reported that the shop details are not right. New jobs are paused.',at,read:false});
      }
      queueInvalidate(store,{resource:'catalog',userIds:[invite.shopId]});
      return {paused:true,shopId:invite.shopId};
    }
  }
  if (!user) {
    if (['link','qr'].includes(invite.kind) && !verifiedIdentities(clerkUser).phone.length) shopTeamError(403,'shop_mobile_verification_required');
    if (body.name !== undefined && (typeof body.name!=='string' || !body.name.trim() || body.name.trim().length>100)) shopTeamError(400,'invalid_shop_member_name');
    const profile = clerkClientProfile(clerkUser);
    // Phone-only Clerk accounts have no email. This private sentinel is never
    // used as verification evidence; invite matching always uses verified BAPI fields.
    const email = profile.email || `phone-${inviteHash(claims.sub)}@identity.invalid`;
    if (store.users.some(row => row.email.toLowerCase() === email.toLowerCase())) shopTeamError(409, 'email_already_registered');
    user = { id: id('user'), clerkUserId: claims.sub, email, name: body.name?.trim() || profile.name || profile.phone || 'Shop staff', phone: profile.phone,
      role: 'staff', accountStatus: 'active', createdAt: at };
    store.users.push(user);
  }
  ensureShopOwners(store);
  const existing = store.shopMemberships.find(row => row.shopId === invite.shopId && row.userId === user.id);
  if (existing && existing.status !== 'removed' && invite.kind!=='owner') shopTeamError(409, 'shop_member_exists');
  const member = existing || { shopId: invite.shopId, userId: user.id, createdAt: at };
  Object.assign(member, { role: invite.kind==='owner'?'owner':'staff', status: invite.kind==='owner'?'active':'pending', updatedAt: at, decidedBy: null });
  if (!existing) store.shopMemberships.push(member);
  const oldPreferences=memberPreferences(store,invite.shopId,user.id);if(oldPreferences) oldPreferences.manager=false;
  invite.claimedAt = at; invite.claimedBy = user.id;
  if(invite.kind==='owner') {
    const signup=signupForShop(store,invite.shopId);
    signup.steps.ownerClaim={status:'claimed',userId:user.id,at};signup.updatedAt=at;signup.version++;
    for(const pending of store.shopInvites)if(pending!==invite&&pending.shopId===invite.shopId&&pending.kind==='owner'&&!pending.claimedAt&&!pending.revokedAt)pending.revokedAt=at;
  }
  audit(store, { actor: user, action: 'shop_team.invite_claimed', entityType: 'shop_invite', entityId: invite.id, detail: { shopId: invite.shopId } });
  const recipients = [
    ...store.shopMemberships.filter(row => row.shopId === invite.shopId && row.role === 'owner' && row.status === 'active')
      .map(row => ({ userId: row.userId, appRole: 'supplier' })),
    ...privilegedAdminMemberships(store).map(row => ({ userId: row.userId, appRole: row.role })),
  ];
  for (const recipient of recipients) store.notifications.push({
    id: id('ntf'), ...recipient, type: 'shop_invite_claimed', shopId: invite.shopId,
    title: 'Shop invitation claimed', body: invite.kind==='owner'?'The invited owner has claimed the shop. The manager keeps Manager access.':'A teammate is waiting for owner approval in the shop team.',
    occurrenceKey: `shop-invite-claimed:${invite.id}:${recipient.userId}:${recipient.appRole}`, at, read: false,
  });
  queueInvalidate(store, { resource: 'identity', userIds: [invite.shopId, user.id] });
  return { member: publicMember(store, member), shop: shopSummary(store, member) };
}

export async function routeShopTeam({ req, url, store, user, readBody, id, now, audit }) {
  const path = url.pathname;
  const operations = /^\/ops\/shops\/([^/]+)\/team(?:\/([^/]+))?$/.exec(path);
  const own = /^\/me\/shop-team(?:\/(invites|members)(?:\/([^/]+))?)?$/.exec(path)
    || /^\/me\/shop-team\/(invites)\/([^/]+)\/(replace)$/.exec(path);
  if (!['/me/shop-memberships', '/me/shop-memberships/selected'].includes(path) && !operations && !own && !path.startsWith('/me/shop-team/')) return null;
  if (!user) shopTeamError(401, 'unauthorized');
  if ((user.accountStatus || 'active') !== 'active') shopTeamError(403, 'forbidden');
  const at = now();
  if (path === '/me/shop-memberships' && req.method === 'GET') {
    const members = shopMembershipsFor(store, user.id);
    const lastUsed = members.filter(row => row.status === 'active' && row.lastUsedAt)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || a.shopId.localeCompare(b.shopId))[0];
    return { status: 200, body: { shops: members.map(row => shopSummary(store, row)),
      lastUsedShopId: lastUsed?.shopId || null, onboardingRequired: !members.some(row => row.status !== 'removed') } };
  }
  ensureShopOwners(store);
  if (path === '/me/shop-memberships/selected') {
    if (req.method !== 'PATCH') shopTeamError(405, 'method_not_allowed');
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'shopId')
      || typeof body.shopId !== 'string' || !body.shopId) shopTeamError(400, 'invalid_shop_selection');
    const member = selectedShop(store, user, body.shopId);
    assertActiveShop(member);
    supplierShopActor(store, user, member);
    resolveShopWorker(store,req,user,member,at);
    for (const row of store.shopMemberships.filter(row => row.userId === user.id)) row.lastUsedAt = row === member ? at : null;
    audit(store, { actor: user, action: 'shop_team.shop_selected', entityType: 'shop_membership', entityId: user.id, detail: { shopId: member.shopId } });
    queueInvalidate(store, { resource: 'identity', userIds: [user.id] });
    return { status: 200, mutated: true, body: { shop: shopSummary(store, member), lastUsedShopId: member.shopId } };
  }
  const member = operations ? null : selectedShop(store, user, req.headers['x-gridgo-shop-id']);
  if (operations) {
    const role = req.headers['x-gridgo-role'];
    if (!ops(user) || (role && (!['ops_admin','super_admin'].includes(role) || !identityHasMembership(user, role)))) shopTeamError(403, 'forbidden');
  }
  else {
    assertActiveShop(member);
    supplierShopActor(store,user,member);
    const response = await routeTeamWork({req,url,store,user,member,readBody,id,now,audit,publicMember});
    if (response) {
      const worker = path === '/me/shop-team' ? resolveShopWorker(store,req,user,member,at) : null;
      if (path === '/me/shop-team' && ['owner','manager'].includes(worker?.role || effectiveShopRole(store,member))) response.body.invites=store.shopInvites.filter(r=>r.shopId===member.shopId).map(r=>publicInvite(r,at));
      return response;
    }
    const worker = resolveShopWorker(store,req,user,member,at);
    if (!['owner','manager'].includes(worker?.role || effectiveShopRole(store,member))) shopTeamError(403,'shop_owner_required');
  }
  const shopId = operations?.[1] || member.shopId;
  const manager = !operations && (resolveShopWorker(store,req,user,member,at)?.role || effectiveShopRole(store,member)) === 'manager';
  if (!store.shopMemberships.some(row => row.shopId === shopId)) shopTeamError(404, 'shop_not_found');
  const memberId = operations?.[2] || (own?.[1] === 'members' ? own[2] : null);
  if (req.method === 'GET' && !memberId && !own?.[2]) return { status: 200, body: {
    members: store.shopMemberships.filter(row => row.shopId === shopId).map(row => publicMember(store, row)),
    ...(!operations ? { invites: store.shopInvites.filter(row => row.shopId === shopId).map(row => publicInvite(row, at)) } : {}),
  } };
  if (!operations && own?.[1] === 'invites' && req.method === 'POST' && !own[2]) {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) shopTeamError(400, 'invalid_invite_kind');
    if (!['email', 'phone', 'qr', 'link','owner'].includes(body.kind)) shopTeamError(400, 'invalid_invite_kind');
    let identity = null;
    if(body.kind==='owner') {
      const signup=signupForShop(store,shopId);
      if(!signup||signup.steps.eligibility.registrantRole!=='manager'||!signup.steps.shop.ownerPhone
        ||store.shopMemberships.some(m=>m.shopId===shopId&&m.role==='owner'&&m.status==='active'))shopTeamError(409,'shop_owner_already_claimed');
      if(body.identity!==undefined&&body.identity!==signup.steps.shop.ownerPhone)shopTeamError(400,'invalid_invite_identity');
      identity=signup.steps.shop.ownerPhone;
      if((store.shopInvites||[]).some(i=>i.shopId===shopId&&i.kind==='owner'&&!i.claimedAt&&!i.revokedAt&&Date.parse(i.expiresAt)>Date.parse(at)))shopTeamError(409,'shop_owner_invite_exists');
    }
    if (body.kind === 'email') {
      identity = String(body.identity || '').trim().toLowerCase();
      if (identity.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity)) shopTeamError(400, 'invalid_invite_identity');
    }
    if (body.kind === 'phone') {
      identity = String(body.identity || '').trim();
      if (!/^\+[1-9][0-9]{7,14}$/.test(identity)) shopTeamError(400, 'invalid_invite_identity');
    }
    return issueShopInvite({ store, user, shopId, kind: body.kind, identity, at, id, audit });
  }
  if (!operations && own?.[1] === 'invites' && own[2]
    && ((!own[3] && req.method === 'DELETE') || (own[3] === 'replace' && req.method === 'POST'))) {
    const invite = store.shopInvites.find(row => row.id === own[2] && row.shopId === shopId);
    inviteAvailable(invite, at); invite.revokedAt = at;
    audit(store, { actor: user, action: 'shop_team.invite_revoked', entityType: 'shop_invite', entityId: invite.id, detail: { shopId } });
    // Both rows and their audit entries persist through the existing locked
    // HTTP transaction, shared with claims. Failed issuance rolls back revocation.
    if (own[3] === 'replace') return issueShopInvite({ store, user, shopId, kind: invite.kind, identity: invite.identity, at, id, audit });
    return { status: 200, mutated: true, body: { invite: publicInvite(invite, at) } };
  }
  if (memberId && (req.method === 'DELETE' || (!operations && req.method === 'PATCH'))) {
    const target = store.shopMemberships.find(row => row.shopId === shopId && row.userId === memberId);
    if (!target) shopTeamError(404, 'shop_member_not_found');
    const body = req.method === 'DELETE' ? { status: 'removed' } : await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) shopTeamError(400, 'invalid_shop_member_update');
    if (Object.keys(body).some(key => !['status', 'role', 'jobAlerts', 'photoFileId'].includes(key)) || (!body.status && !body.role && !Object.hasOwn(body,'jobAlerts') && !Object.hasOwn(body,'photoFileId'))
      || (body.status && !['active', 'removed'].includes(body.status)) || (body.role && !['owner', 'manager', 'staff'].includes(body.role))) shopTeamError(400, 'invalid_shop_member_update');
    if (manager && (effectiveShopRole(store,target) !== 'staff' || (body.role && body.role !== 'staff'))) shopTeamError(403,'shop_owner_required');
    if (Object.hasOwn(body,'jobAlerts') && typeof body.jobAlerts !== 'boolean') shopTeamError(400,'invalid_shop_member_update');
    if (target.status === 'removed' && body.status !== 'removed') shopTeamError(409, 'shop_invite_required');
    const status = body.status || target.status, role = body.role || effectiveShopRole(store,target);
    if (status === 'pending' && ['owner','manager'].includes(role)) shopTeamError(409, 'shop_approval_required');
    if (target.role === 'owner' && target.status === 'active' && (status !== 'active' || role !== 'owner')
      && !store.shopMemberships.some(row => row.shopId === shopId && row.userId !== target.userId && row.role === 'owner' && row.status === 'active')) shopTeamError(409, 'last_shop_owner');
    const before = { role: target.role, status: target.status };
    const preferences=memberPreferences(store,shopId,target.userId,true);
    preferences.manager=role==='manager';
    if(Object.hasOwn(body,'jobAlerts')) preferences.jobAlerts=body.jobAlerts;
    if(Object.hasOwn(body,'photoFileId')) {
      const file=store.files.find(f=>f.fileId===body.photoFileId);
      if(body.photoFileId!==null && (!file || file.purpose!=='shop_team_photo' || file.ownerId!==shopId || file.createdByUserId!==user.id || file.state!=='ready' || file.references?.length)) shopTeamError(400,'invalid_shop_team_photo');
      preferences.photoFileId=body.photoFileId;bindTeamPhoto(store,body.photoFileId,shopId,target.userId);
    }
    Object.assign(target, { status, role: role==='manager'?'staff':role, updatedAt: at, decidedBy: user.id });
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
    if (previous.has(notification.id) || !['shop_job_assigned', 'shop_express_offer'].includes(notification.type) || notification.shopTeamCopy) continue;
    const shopId = notification.shopId || notification.userId;
    if (notification.type === 'shop_express_offer') notification.shopId = shopId;
    const source = structuredClone(notification);
    const members = (store.shopMemberships || []).filter(member => member.shopId === shopId && member.status === 'active');
    const copyFor = member => {
      const copy = structuredClone(source);
      if (member.role !== 'owner' && copy.expressOffer) {
        delete copy.expressOffer.earningsMinor;
        Object.assign(copy, expressOfferCopy(copy.expressOffer, copy.at));
      }
      return copy;
    };
    // Keep the original inbox ID, but derive its Express copy from the person's
    // current role. Other Owners still need the original earnings-bearing source.
    const original = members.find(member => member.userId === notification.userId);
    if (notification.type === 'shop_express_offer' && original && original.role !== 'owner') {
      Object.assign(notification, copyFor(original));
    }
    for (const member of members) {
      if (member.userId === notification.userId || memberPreferences(store,shopId,member.userId)?.jobAlerts === false) continue;
      const occurrenceKey = `${source.occurrenceKey || source.id}:${member.userId}`;
      if (store.notifications.some(row => row.shopTeamCopy && row.shopId === shopId && row.userId === member.userId && row.occurrenceKey === occurrenceKey)) continue;
      store.notifications.push({ ...copyFor(member), id: id('ntf'), userId: member.userId, shopId, shopTeamCopy: true, occurrenceKey });
    }
  }
}
