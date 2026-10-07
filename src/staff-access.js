import { notifyAdmins } from './domain-events.js';
import { authorizationContextFor, contextHasMembership } from './authorization-context.js';
import { createHash, randomBytes } from 'node:crypto';
import { clerkClientProfile } from './auth.js';

export function staffError(status, code, message = code, details = {}) {
  throw Object.assign(new Error(message), { status, code, details });
}
export function hasMembership(store, user, role) {
  const context = authorizationContextFor(user);
  if (context) return contextHasMembership(context, role);
  return Boolean(user && (store.userRoleMemberships || []).some(m => m.userId === user.id && m.role === role));
}
export const activeAccount = user => user && !['suspended', 'removed'].includes(user.accountStatus);
export const staffHash = value => createHash('sha256').update(String(value)).digest('hex');
// Operations and Super Admin hold every hub staff capability through their own
// membership: no invite or staff profile, selected with their own role header.
const ADMIN_STAFF_ROLES = ['super_admin', 'ops_admin'];
const ADMIN_STAFF_ROLE_NAMES = { super_admin: 'Super Admin', ops_admin: 'Operations' };
export function staffAccess(store, user) {
  if (!activeAccount(user)) return null;
  if (hasMembership(store, user, 'staff')) {
    const profile = (store.staffProfiles || []).find(p => p.userId === user.id && p.active);
    const role = (store.staffRoles || []).find(r => r.code === profile?.roleCode);
    if (role) return { id: user.id, name: user.name, role: role.code, roleName: role.name, canHandout: role.canHandout };
  }
  const adminRole = ADMIN_STAFF_ROLES.find(role => hasMembership(store, user, role));
  return adminRole ? { id: user.id, name: user.name, role: adminRole, roleName: ADMIN_STAFF_ROLE_NAMES[adminRole], canHandout: true } : null;
}
export function redeemStaffInvite({ store, claims, clerkUser, code, id, at, audit }) {
  if (!claims?.sub) staffError(401, 'unauthorized');
  const invite = (store.staffInvites || []).find(i => i.codeHash === staffHash(code));
  if (!invite || invite.revokedAt || Date.parse(invite.expiresAt) <= Date.parse(at)) staffError(409, 'staff_invite_invalid');
  let user = store.users.find(u => u.clerkUserId === claims.sub);
  if (user && !activeAccount(user)) staffError(403, 'forbidden');
  if (invite.redeemedBy) {
    if (invite.redeemedBy !== user?.id) staffError(409, 'staff_invite_used');
    return { staff: staffAccess(store, user), mutated: false };
  }
  if (!user) {
    if (!clerkUser) staffError(502, 'clerk_unavailable');
    const profile = clerkClientProfile(clerkUser);
    if (!profile.email || !profile.name) staffError(400, 'staff_profile_required');
    if (store.users.some(u => u.email.toLowerCase() === profile.email)) staffError(409, 'email_already_registered');
    user = { id: id('user'), clerkUserId: claims.sub, email: profile.email, name: profile.name, role: 'staff', accountStatus: 'active', createdAt: at };
    store.users.push(user);
  }
  if (hasMembership(store, user, 'staff')) staffError(409, 'staff_already_enrolled');
  store.userRoleMemberships.push({ userId: user.id, role: 'staff', createdAt: at, createdBy: invite.createdBy });
  store.staffProfiles.push({ userId: user.id, roleCode: invite.roleCode, active: true, updatedAt: at });
  invite.redeemedBy = user.id; invite.redeemedAt = at;
  audit(store, { actor: user, action: 'staff.invite_redeemed', entityType: 'staff_invite', entityId: invite.id, detail: { roleCode: invite.roleCode } });
  return { staff: staffAccess(store, user), mutated: true };
}

export async function routeStaffAccess({ req, url, store, user, readBody, now, id, audit }) {
  const path = url.pathname;
  if (!path.startsWith('/admin/staff') && path !== '/staff/me') return null;
  if (!user) staffError(401, 'unauthorized');
  if (!activeAccount(user)) staffError(403, 'forbidden');
  if (path === '/staff/me' && req.method === 'GET') {
    const staff = staffAccess(store, user);
    if (!staff) staffError(403, 'staff_membership_required');
    return { status: 200, body: { staff } };
  }
  if (!hasMembership(store, user, 'super_admin')) staffError(403, 'forbidden');
  const at = now();
  const record = (action, entityId, detail) => {
    audit(store, { actor: user, action, entityId, entityType: 'staff', detail });
    notifyAdmins(store, action.replaceAll('.', '_'), 'Staff access updated', null, id('staff_event'), { createId: id, at });
  };
  if (path === '/admin/staff/roles') {
    if (req.method === 'GET') return { status: 200, body: { roles: store.staffRoles } };
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.code !== 'string' || !/^[a-z][a-z0-9_]{1,39}$/.test(body.code) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80 || typeof body.canHandout !== 'boolean') staffError(400, 'invalid_staff_role');
      if (store.staffRoles.some(r => r.code === body.code)) staffError(409, 'staff_role_exists');
      const role = { code: body.code, name: body.name.trim(), canHandout: body.canHandout };
      store.staffRoles.push(role); record('staff.role_created', role.code, role);
      return { status: 201, body: { role }, mutated: true };
    }
  }
  if (path === '/admin/staff/invites') {
    if (req.method === 'GET') return { status: 200, body: { invites: store.staffInvites.map(({ codeHash, ...row }) => row) } };
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!store.staffRoles.some(r => r.code === body.roleCode)) staffError(400, 'invalid_staff_role');
      const days = body.expiresInDays ?? 7;
      if (!Number.isInteger(days) || days < 1 || days > 30) staffError(400, 'invalid_invite_expiry');
      const code = randomBytes(24).toString('base64url');
      const invite = { id: id('invite'), codeHash: staffHash(code), roleCode: body.roleCode, createdBy: user.id, createdAt: at, expiresAt: new Date(Date.parse(at) + days * 86400000).toISOString(), redeemedBy: null, redeemedAt: null, revokedAt: null };
      store.staffInvites.push(invite); record('staff.invite_created', invite.id, { roleCode: invite.roleCode });
      const { codeHash, ...publicInvite } = invite;
      return { status: 201, body: { invite: publicInvite, code }, mutated: true };
    }
  }
  const revoke = path.match(/^\/admin\/staff\/invites\/([^/]+)\/revoke$/);
  if (revoke && req.method === 'POST') {
    const invite = store.staffInvites.find(i => i.id === revoke[1]);
    if (!invite) staffError(404, 'staff_invite_not_found');
    if (!invite.revokedAt) { invite.revokedAt = at; record('staff.invite_revoked', invite.id, {}); }
    return { status: 200, body: { ok: true }, mutated: true };
  }
  if (path === '/admin/staff' && req.method === 'GET') return { status: 200, body: { staff: store.staffProfiles.map(p => ({ ...p, name: store.users.find(u => u.id === p.userId)?.name })) } };
  const profilePath = path.match(/^\/admin\/staff\/([^/]+)$/);
  if (profilePath && req.method === 'PATCH') {
    const profile = store.staffProfiles.find(p => p.userId === profilePath[1]);
    if (!profile) staffError(404, 'staff_not_found');
    const body = await readBody(req);
    if (typeof body.active !== 'boolean' || !store.staffRoles.some(r => r.code === body.roleCode)) staffError(400, 'invalid_staff_profile');
    Object.assign(profile, { active: body.active, roleCode: body.roleCode, updatedAt: at });
    record('staff.profile_updated', profile.userId, { active: profile.active, roleCode: profile.roleCode });
    return { status: 200, body: { profile }, mutated: true };
  }
  return { status: 404, body: { error: 'not_found' } };
}
