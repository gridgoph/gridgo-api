import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, id, AT } from './fixtures/reschedule.js';
import { createInviteCode, submitTesterInvite, matchTesterInvites, reconcileTesterInvite, recordTesterInstallation } from '../src/tester-invites.js';
import { testerBudget, voidTesterReward } from '../src/tester-rewards.js';
const ctx = { id, at: AT };
function setup() {
  const s = fixture();
  s.orders[0].clientId = 'other'; s.orders[0].issueWindowOpenedAt = AT;
  s.orders[0].dropoff.label = '12 Example Street Davao';
  s.orderSurveys.push({ orderId: 'order', clientId: 'other', submittedAt: AT });
  s.testerTracking = [{ clientId: 'other', orderId: 'order', createdAt: AT }];
  const code = createInviteCode(s, 'client', ctx).code;
  const invite = submitTesterInvite(s, { code, email: 'other@example.invalid' }, ctx);
  matchTesterInvites(s, ctx);
  return { s, invite, code };
}
test('a form email matches one account; completion issues two 30-day vouchers once', () => {
  const { s, invite } = setup();
  assert.equal(invite.clientId, 'other'); assert.equal(s.vouchers.length, 0);
  assert.equal(reconcileTesterInvite(s, 'other', ctx), true);
  assert.equal(reconcileTesterInvite(s, 'other', ctx), false);
  assert.deepEqual(s.vouchers.map(v => v.clientId).sort(), ['client', 'other']);
  assert.ok(s.vouchers.every(v => v.valueMinor === 1500 && Date.parse(v.expiresAt) - Date.parse(v.issuedAt) === 30 * 86400000));
  assert.equal(s.testerRewards[0].checks.phone.status, 'missing');
});
for (const check of ['phone', 'device', 'address']) test(`positive ${check} evidence blocks both vouchers`, () => {
  const { s } = setup();
  if (check === 'phone') { s.users.find(u => u.id === 'client').phone = '+63 917 123 4567'; s.users.find(u => u.id === 'other').phone = '09171234567'; }
  if (check === 'device') for (const client of ['client', 'other']) recordTesterInstallation(s, client, '00000000-0000-4000-8000-000000000001', ctx);
  if (check === 'address') s.orders.push({ ...structuredClone(s.orders[0]), id: 'inviter-order', clientId: 'client' });
  reconcileTesterInvite(s, 'other', ctx);
  assert.equal(s.vouchers.length, 0);
  assert.equal(s.testerRewards[0].status, 'blocked');
  assert.equal(s.testerRewards[0].checks[check].status, 'match');
});
test('a shared hub is not personal address evidence and missing checks do not block', () => {
  const { s } = setup();
  s.orders[0].fulfillmentMode = 'pickup';
  s.orders.push({ ...structuredClone(s.orders[0]), id: 'inviter-order', clientId: 'client' });
  reconcileTesterInvite(s, 'other', ctx);
  assert.equal(s.vouchers.length, 2); assert.equal(s.testerRewards[0].checks.address.status, 'missing');
});
test('referral budget is atomic, paused rows require explicit resume, void does not free budget', () => {
  const { s } = setup(); s.settings.testerMonthlyBudgetMinor = 1500;
  reconcileTesterInvite(s, 'other', ctx);
  assert.equal(s.vouchers.length, 0); assert.equal(s.testerRewards[0].status, 'paused');
  s.settings.testerMonthlyBudgetMinor = 3000;
  reconcileTesterInvite(s, 'other', ctx); assert.equal(s.vouchers.length, 0);
  reconcileTesterInvite(s, 'other', { ...ctx, resume: true }); assert.equal(s.vouchers.length, 2);
  voidTesterReward(s, s.testerRewards[0], 'Duplicate tester', { ...ctx, actorId: 'admin' });
  assert.ok(s.vouchers.every(v => v.status === 'void'));
  assert.equal(testerBudget(s, AT).usedMinor, 3000);
  reconcileTesterInvite(s, 'other', { ...ctx, resume: true }); assert.equal(s.vouchers.length, 2);
});

test('a previously rewarded invitee remains a comparator after a phone edit and reward void', () => {
  const { s, code } = setup();
  s.users.find(u => u.id === 'other').phone = '+639171234567';
  reconcileTesterInvite(s, 'other', ctx);
  voidTesterReward(s, s.testerRewards[0], 'Review', ctx);
  s.users.find(u => u.id === 'other').phone = '+639181234567';
  s.users.push({ ...structuredClone(s.users.find(u => u.id === 'other')), id: 'third', email: 'third@example.invalid', phone: '09171234567' });
  s.userRoleMemberships.push({ userId: 'third', role: 'client', createdAt: AT });
  s.orders.push({ ...structuredClone(s.orders[0]), id: 'third-order', clientId: 'third', dropoff: { lat: 7.3, lng: 125.7, label: 'Third different home' } });
  s.orderLineItems.push({ ...structuredClone(s.orderLineItems[0]), id: 'third-line', orderId: 'third-order' });
  s.orderSurveys.push({ orderId: 'third-order', clientId: 'third', submittedAt: AT });
  s.testerTracking.push({ orderId: 'third-order', clientId: 'third', createdAt: AT });
  submitTesterInvite(s, { code, email: 'third@example.invalid' }, ctx); matchTesterInvites(s, ctx);
  reconcileTesterInvite(s, 'third', ctx);
  const blocked = s.testerRewards.find(r => r.clientId === 'third');
  assert.equal(blocked.status, 'blocked'); assert.ok(blocked.checks.phone.matchedClientIds.includes('other'));
  assert.equal(s.vouchers.length, 2);
});

test('Manila month boundary, zero budget, and voided paused entitlements cannot issue', () => {
  const { s } = setup();
  reconcileTesterInvite(s, 'other', { ...ctx, at: '2026-10-31T15:59:59.000Z' });
  assert.equal(testerBudget(s, '2026-10-31T15:59:59.000Z').usedMinor, 3000);
  assert.equal(testerBudget(s, '2026-10-31T16:00:00.000Z').usedMinor, 0);
  const { s: paused } = setup(); paused.settings.testerMonthlyBudgetMinor = 0;
  reconcileTesterInvite(paused, 'other', ctx);
  voidTesterReward(paused, paused.testerRewards[0], 'Cancelled entitlement', ctx);
  paused.settings.testerMonthlyBudgetMinor = null;
  reconcileTesterInvite(paused, 'other', { ...ctx, resume: true });
  assert.equal(paused.vouchers.length, 0);
});

test('unmatched form retries match only one client and first attribution never changes', () => {
  const { s, code } = setup();
  const row = submitTesterInvite(s, { code, email: 'new@example.invalid' }, ctx);
  assert.equal(matchTesterInvites(s, ctx), false); assert.equal(row.unmatchedReason, 'no_client_account');
  s.users.push({ id: 'new', email: 'new@example.invalid' }); s.userRoleMemberships.push({ userId: 'new', role: 'client' });
  assert.equal(matchTesterInvites(s, ctx), true); assert.equal(row.clientId, 'new');
  const otherCode = createInviteCode(s, 'other', ctx).code;
  assert.throws(() => submitTesterInvite(s, { code: otherCode, email: 'new@example.invalid' }, ctx), { code: 'tester_invite_already_attributed' });
  assert.equal(submitTesterInvite(s, { code, email: ' NEW@example.invalid ' }, ctx).id, row.id);
  s.users.find(u => u.id === 'new').email = 'changed@example.invalid';
  matchTesterInvites(s, ctx); assert.equal(row.clientId, 'new');
  const self = submitTesterInvite(s, { code, email: 'client@example.invalid' }, ctx);
  matchTesterInvites(s, ctx); assert.equal(self.unmatchedReason, 'self_invite');
});

test('a paused referral rechecks new evidence before issue, with no override for a block', () => {
  const { s } = setup(); s.settings.testerMonthlyBudgetMinor = 0;
  reconcileTesterInvite(s, 'other', ctx);
  for (const user of s.users.filter(u => ['client', 'other'].includes(u.id))) user.phone = '+639171234567';
  s.settings.testerMonthlyBudgetMinor = null;
  reconcileTesterInvite(s, 'other', { ...ctx, resume: true });
  assert.equal(s.testerRewards[0].status, 'blocked'); assert.equal(s.vouchers.length, 0);
});

test('voiding preserves submitted-payment holds and prevents later refund restoration of used vouchers', async () => {
  const { restoreVoucherForRefund } = await import('../src/vouchers.js');
  const { s } = setup(); reconcileTesterInvite(s, 'other', ctx);
  const reward = s.testerRewards[0], voucher = s.vouchers.find(v => v.id === reward.voucherId);
  s.voucherReservations.push({ id: 'reservation', voucherId: voucher.id, status: 'reserved', data: { orderIds: ['order'] } });
  assert.throws(() => voidTesterReward(s, reward, 'Review', ctx), { code: 'voucher_payment_reconciliation_required' });
  assert.equal(reward.status, 'issued'); assert.ok(s.vouchers.every(v => v.status === 'available'));
  s.voucherReservations[0].status = 'consumed'; voucher.status = 'used';
  s.voucherRedemptions.push({ id: 'redemption', voucherId: voucher.id, amountMinor: 1500, status: 'consumed', data: { orderIds: ['order'] } });
  s.orders[0].voucher = { id: voucher.id };
  voidTesterReward(s, reward, 'Confirmed duplicate', ctx);
  restoreVoucherForRefund(s, s.orders[0], { ...ctx, clientCaused: false, reason: 'Shop failure' });
  assert.equal(voucher.status, 'used'); assert.equal(reward.status, 'voided');
  assert.ok(voucher.data.testerRewardVoided);
});

test('generic destination labels and the GRIDGO office pin are missing personal-address evidence', async () => {
  const { GRIDGO_OFFICE } = await import('../src/gridgo-office.js');
  for (const point of [{ lat: 7.1, lng: 125.6, label: 'Office' }, GRIDGO_OFFICE]) {
    const { s } = setup(); s.orders[0].dropoff = { ...point };
    s.orders.push({ ...structuredClone(s.orders[0]), id: 'inviter-order', clientId: 'client' });
    reconcileTesterInvite(s, 'other', ctx);
    assert.equal(s.testerRewards[0].checks.address.status, 'missing'); assert.equal(s.vouchers.length, 2);
  }
});

test('an earned label cannot bypass current client-fault exclusions for a new referral reward', () => {
  const { s } = setup();
  s.foundingTesters.push({ clientId: 'other', awardedAt: AT });
  s.refundSettlements.push({ orderId: 'order', snapshot: { clientCaused: true } });
  assert.equal(reconcileTesterInvite(s, 'other', ctx), false);
  assert.equal(s.vouchers.length, 0);
});
