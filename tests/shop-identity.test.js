import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, AT, id, audit } from './fixtures/reschedule.js';
import { routeShopTeam, claimShopInvite, selectedShop, inviteHash } from '../src/shop-team.js';
import { enrollSupplier } from '../src/enrollment.js';
import { clientEmailAvailable } from '../src/auth.js';
import { notificationVisible } from '../src/notifications.js';

const call = (store, userId, method, path, body) => routeShopTeam({
  store, user: store.users.find(row => row.id === userId),
  req: { method, headers: {} }, url: new URL(path, 'http://local'),
  readBody: async () => body, id, now: () => AT, audit,
});

test('an existing client enrolls a shop under the same identity and keeps client orders', () => {
  const store = fixture(), before = structuredClone(store.orders);
  const result = enrollSupplier({ store, clerkUserId: 'clerk_client', clerkUser: null,
    body: { jobsHandledBy:'me_and_staff', profile: { shopName: 'Shop', contactName: 'Contact', phone: '+639170000001',
      location: { lat: 7.06, lng: 125.6, label: 'Pickup' } }, serviceCategories: ['marketing_collateral'] },
    idempotencyKey: 'same-person', createId: id, now: () => AT });
  assert.equal(result.user.id, 'client');
  assert.equal(store.shopTeamSettings.find(s=>s.shopId==='client').jobsHandledBy,'me_and_staff');
  assert.equal(result.user.role, 'client');
  assert.equal(store.users.filter(row => row.clerkUserId === 'clerk_client').length, 1);
  assert.ok(store.userRoleMemberships.some(row => row.userId === 'client' && row.role === 'client'));
  assert.ok(store.shopMemberships.some(row => row.shopId === 'client' && row.userId === 'client' && row.role === 'owner'));
  assert.deepEqual(store.orders, before);
});

test('an existing client claims an invite once and owners receive a durable notification', () => {
  const store = fixture(), orders = structuredClone(store.orders), user = structuredClone(store.users.find(row => row.id === 'client'));
  const token = 'a'.repeat(43);
  store.shopInvites.push({ id: 'invite', shopId: 'supplier', kind: 'link', tokenHash: inviteHash(token),
    createdAt: AT, expiresAt: '2026-10-06T00:00:00.000Z' });
  const args = { store, claims: { sub: 'clerk_client' }, clerkUser: { id: 'clerk_client' }, body: { token }, id, at: AT, audit };
  const result = claimShopInvite(args);
  assert.equal(result.member.userId, 'client');
  assert.equal(result.member.status, 'pending');
  assert.deepEqual(store.users.find(row => row.id === 'client'), user);
  assert.deepEqual(store.orders, orders);
  assert.equal(store.notifications.filter(row => row.type === 'shop_invite_claimed' && row.userId === 'supplier').length, 1);
  assert.ok(store.notifications.some(row => row.type === 'shop_invite_claimed' && row.userId === 'ops'));
  assert.ok(store.notifications.some(row => row.type === 'shop_invite_claimed' && row.userId === 'admin'));
  const notice = store.notifications.find(row => row.type === 'shop_invite_claimed' && row.userId === 'supplier');
  assert.equal(notificationVisible(store, notice, 'supplier', 'supplier', {shopId:'supplier'}), true);
  assert.equal(notificationVisible(store, notice, 'supplier', 'supplier', {shopId:'replacement'}), false);
  store.shopMemberships.find(row => row.shopId === 'supplier' && row.userId === 'supplier').role = 'staff';
  assert.equal(notificationVisible(store, notice, 'supplier', 'supplier', {shopId:'supplier'}), false);
  assert.throws(() => claimShopInvite(args), { code: 'shop_invite_used' });
});

test('new shop invitations expire at the 24 hour boundary and can be cancelled', async () => {
  const store = fixture();
  const created = await call(store, 'supplier', 'POST', '/me/shop-team/invites', { kind: 'qr' });
  const args = { store, claims: { sub: 'clerk_client' }, clerkUser: { id: 'clerk_client' }, body: { token: created.body.token }, id, audit };
  assert.throws(() => claimShopInvite({ ...args, at: '2026-10-06T00:00:00.000Z' }), { code: 'shop_invite_expired' });
  await call(store, 'supplier', 'DELETE', `/me/shop-team/invites/${created.body.invite.id}`);
  assert.throws(() => claimShopInvite({ ...args, at: AT }), { code: 'shop_invite_revoked' });
});

test('saved shop selection takes precedence over own shop and ignores removed memberships', async () => {
  const store = fixture();
  store.shopMemberships.push({ shopId: 'replacement', userId: 'supplier', role: 'staff', status: 'active', createdAt: AT, updatedAt: AT });
  const response = await call(store, 'supplier', 'PATCH', '/me/shop-memberships/selected', { shopId: 'replacement' });
  assert.equal(response?.status, 200);
  assert.equal(selectedShop(store, { id: 'supplier' }).shopId, 'replacement');
  assert.equal(selectedShop(store, { id: 'supplier' }, 'supplier').role, 'owner');
  const listing = await call(store, 'supplier', 'GET', '/me/shop-memberships');
  assert.equal(listing.body.lastUsedShopId, 'replacement');
  await assert.rejects(call(store, 'client', 'PATCH', '/me/shop-memberships/selected', { shopId: 'replacement' }), { code: 'shop_membership_required' });
  store.shopMemberships.find(row => row.shopId === 'replacement' && row.userId === 'supplier').status = 'removed';
  assert.equal(selectedShop(store, { id: 'supplier' }).shopId, 'supplier');
});

test('supplier onboarding is available without a shop and email availability does not exclude other roles', async () => {
  const store = fixture();
  const result = await call(store, 'client', 'GET', '/me/shop-memberships');
  assert.deepEqual(result.body.shops, []);
  assert.equal(result.body.onboardingRequired, true);
  for (const user of store.users) assert.equal(clientEmailAvailable(store, user.email), true);
  assert.equal(clientEmailAvailable(store, 'invalid'), false);
});
