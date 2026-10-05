import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, id, audit, AT } from './fixtures/reschedule.js';
import { routeHubHandover, prepareHandover, sweepHubReminders, verifyHandoverOtp } from '../src/hub-handover.js';
import { publicOrderFor } from '../src/operational-model.js';

function setup() {
  const store = fixture();
  store.settings.handoverOtpEnabled = true;
  store.staffRoles = [{ code: 'hub_staff', name: 'Hub staff', canHandout: true }];
  store.staffProfiles = [{ userId: 'other', roleCode: 'hub_staff', active: true, updatedAt: AT }];
  store.staffInvites = []; store.hubHandouts = [];
  store.userRoleMemberships.push({ userId: 'other', role: 'staff', createdAt: AT });
  const order = store.orders[0];
  Object.assign(order, { fulfillmentMode: 'pickup', state: 'awaiting_collection', awaitingCollectionAt: AT, riderId: 'rider' });
  prepareHandover(store, order, { at: AT });
  return store;
}
const call = (store, actor, path, body = {}, method = 'POST', at = AT) => routeHubHandover({
  req: { method }, url: new URL(path, 'http://test'), store,
  user: store.users.find(u => u.id === actor), readBody: async () => body, now: () => at, id, audit,
});
const rejects = (promise, code) => assert.rejects(promise, e => e.code === code);

test('hub claim requires staff permission and matching QR plus OTP; consumes once and opens the delivery issue window', async () => {
  const store = setup(), order = store.orders[0];
  const credentials = (await call(store, 'client', '/orders/order/handover', {}, 'GET')).body.handover;
  assert.match(credentials.otp, /^\d{6}$/);
  assert.ok(credentials.qrToken.length >= 32);
  await rejects(call(store, 'client', '/staff/hub/claims', { qrToken: credentials.qrToken, otp: credentials.otp }), 'forbidden');
  assert.equal((await call(store, 'other', '/staff/hub/claims', { qrToken: credentials.qrToken, otp: 'bad' })).body.error, 'handover_otp_mismatch');
  assert.equal(order.state, 'awaiting_collection');
  const result = await call(store, 'other', '/staff/hub/claims', credentials);
  assert.equal(result.status, 200);
  assert.equal(order.state, 'issue_window_open');
  assert.equal(order.issueWindowOpenedAt, AT);
  assert.equal(store.hubHandouts.length, 1);
  assert.equal(store.hubHandouts[0].staffId, 'other');
  assert.equal(store.hubHandouts[0].staffName, 'other');
  assert.ok(store.notifications.some(n => n.userId === 'admin'));
  assert.ok(store.notifications.some(n => n.userId === 'ops'));
  await rejects(call(store, 'other', '/staff/hub/claims', credentials), 'handover_already_completed');
  assert.equal(store.hubHandouts.length, 1);
  assert.equal(order.payoutMilestones.some(m => m.status === 'released'), false);
});

test('claim checks balance, staff suspension and custom roles without exposing credentials to suppliers or staff', async () => {
  const store = setup(), order = store.orders[0];
  const body = { qrToken: order.handover.qrToken, otp: order.handover.otp };
  order.payments.final_online = { amountMinor: 100, status: 'not_submitted' };
  await rejects(call(store, 'other', '/staff/hub/claims', body), 'final_payment_not_confirmed');
  order.payments.final_online = { amountMinor: 0, status: 'not_required' };
  store.staffProfiles[0].active = false;
  await rejects(call(store, 'other', '/staff/hub/claims', body), 'forbidden');
  store.staffProfiles[0].active = true;
  store.staffRoles[0].canHandout = false;
  await rejects(call(store, 'other', '/staff/hub/claims', body), 'forbidden');
  for (const actor of ['supplier', 'other', 'admin']) {
    const projected = publicOrderFor(order, store.users.find(u => u.id === actor), store);
    assert.equal(projected.handover, undefined);
  }
  await rejects(call(store, 'rider', '/orders/order/handover', {}, 'GET'), 'forbidden');
});

test('ready and missed-day reminders count completed open dates once, skip closures, warn at two and refer at three without forfeiting', () => {
  const store = setup();
  store.orders[0].handover.schedule.closures = [{ startDay: '2026-10-07', endDay: '2026-10-07' }];
  assert.equal(sweepHubReminders(store, { at: AT, id }), true);
  assert.equal(sweepHubReminders(store, { at: AT, id }), false);
  sweepHubReminders(store, { at: '2026-10-09T10:00:00.000Z', id });
  assert.equal(store.orders[0].handover.missedDays, 2);
  assert.ok(store.notifications.some(n => n.type === 'hub_unclaimed_warning' && n.userId === 'client'));
  sweepHubReminders(store, { at: '2026-10-12T10:00:00.000Z', id });
  assert.equal(store.orders[0].handover.missedDays, 3);
  assert.equal(store.orders[0].handover.operationsRequired, true);
  assert.equal(store.orders[0].state, 'awaiting_collection');
  assert.equal(store.orders[0].payoutMilestones.some(m => m.status === 'released'), false);
  const count = store.notifications.length;
  sweepHubReminders(store, { at: '2026-10-12T10:00:00.000Z', id });
  assert.equal(store.notifications.length, count);
});

test('delivery OTP is shared only with owning client and assigned rider and mismatch is a blocking error with escalation', async () => {
  const store = fixture(), order = store.orders[0];
  Object.assign(order, { state: 'out_for_delivery', riderId: 'rider' });
  store.settings.handoverOtpEnabled = true;
  prepareHandover(store, order, { at: AT });
  const client = (await call(store, 'client', '/orders/order/handover', {}, 'GET')).body.handover;
  const rider = (await call(store, 'rider', '/orders/order/handover', {}, 'GET')).body.handover;
  assert.equal(client.otp, rider.otp);
  assert.equal(rider.qrToken, undefined);
  assert.throws(() => verifyHandoverOtp(order, '000bad'), e => e.code === 'handover_otp_mismatch' && e.details.canEscalate);
  verifyHandoverOtp(order, client.otp);
  await call(store, 'rider', '/orders/order/handover/escalate', { reason: 'Codes do not match' });
  assert.equal(order.state, 'out_for_delivery');
  assert.ok(store.notifications.some(n => n.userId === 'ops' && n.type === 'handover_escalated'));
});

test('client redelivery choice records an Operations request without mutating original fees or payout', async () => {
  const store = setup(), order = store.orders[0];
  await rejects(call(store, 'client', '/orders/order/hub-redelivery', { reason: 'Deliver instead' }), 'redelivery_not_available');
  sweepHubReminders(store, { at: '2026-10-09T10:00:00.000Z', id });
  const total = order.totalMinor;
  const result = await call(store, 'client', '/orders/order/hub-redelivery', { reason: 'Deliver instead', costAccepted: true });
  assert.equal(result.body.request.status, 'pending_operations');
  assert.equal(order.totalMinor, total);
  assert.equal(order.fulfillmentMode, 'pickup');
});

test('only Super Admin creates configurable staff roles/invites and log scope is per staff unless Operations', async () => {
  const store = setup();
  await rejects(call(store, 'ops', '/admin/staff/invites', { roleCode: 'hub_staff' }), 'forbidden');
  await call(store, 'admin', '/admin/staff/roles', { code: 'counter_assistant', name: 'Counter assistant', canHandout: false });
  const invite = await call(store, 'admin', '/admin/staff/invites', { roleCode: 'counter_assistant' });
  assert.equal(invite.status, 201);
  assert.ok(invite.body.code.length >= 32);
  assert.equal(store.staffInvites[0].code, undefined);
  const list = await call(store, 'admin', '/admin/staff/invites', {}, 'GET');
  assert.equal(JSON.stringify(list).includes(invite.body.code), false);
});

test('OTP retry budget persists a cooldown and a valid code cannot bypass it; Unicode input is a normal mismatch', async () => {
  const store = setup(), h = store.orders[0].handover;
  for (let i = 0; i < 5; i++) {
    const result = await call(store, 'other', '/staff/hub/claims', { qrToken: h.qrToken, otp: 'éééééé' });
    assert.equal(result.body.error, 'handover_otp_mismatch');
    assert.equal(result.mutated, true);
  }
  const locked = await call(store, 'other', '/staff/hub/claims', { qrToken: h.qrToken, otp: h.otp });
  assert.equal(locked.status, 429);
  assert.equal(store.orders[0].state, 'awaiting_collection');
  const claimed = await call(store, 'other', '/staff/hub/claims', { qrToken: h.qrToken, otp: h.otp }, 'POST', '2026-10-05T00:16:00Z');
  assert.equal(claimed.status, 200);
});

test('a refund work hold blocks a correct hub OTP; staff membership cannot read rider job offers', async () => {
  const { canAccessOrder } = await import('../src/notifications.js');
  const store = setup(), order = store.orders[0], h = order.handover;
  store.refundRequests.push({ id: 'refund', orderId: order.id, status: 'requested' });
  await rejects(call(store, 'other', '/staff/hub/claims', { qrToken: h.qrToken, otp: h.otp }), 'refund_fulfillment_stopped');
  assert.equal(order.state, 'awaiting_collection');
  order.state = 'ready_for_dispatch'; order.riderId = null;
  assert.equal(canAccessOrder(store, 'other', order, { role: 'staff', offer: true }), false);
});

test('Clerk invite redemption creates only staff, never links by email or assigns privileged roles', async () => {
  const { redeemStaffInvite } = await import('../src/staff-access.js');
  const store = setup();
  const make = async () => (await call(store, 'admin', '/admin/staff/invites', { roleCode: 'hub_staff' })).body.code;
  const code = await make();
  const primaryEmailAddress = { emailAddress: store.users.find(u => u.id === 'client').email };
  assert.throws(() => redeemStaffInvite({ store, claims: { sub: 'new_subject' }, clerkUser: { username: 'Staff profile', primaryEmailAddress }, code, id, at: AT, audit }), e => e.code === 'email_already_registered');
  primaryEmailAddress.emailAddress = ['invited', 'example.invalid'].join('@');
  const result = redeemStaffInvite({ store, claims: { sub: 'new_subject' }, clerkUser: { username: 'Staff profile', primaryEmailAddress }, code, id, at: AT, audit });
  assert.equal(result.staff.role, 'hub_staff');
  const memberships = store.userRoleMemberships.filter(m => m.userId === result.staff.id);
  assert.deepEqual(memberships.map(m => m.role), ['staff']);
  const expired = await make();
  assert.throws(() => redeemStaffInvite({ store, claims: { sub: 'new_subject_2' }, code: expired, id, at: '2026-11-01T00:00:00Z', audit }), e => e.code === 'staff_invite_invalid');
});

test('supplier invoice scans stay private to the owner and Operations, and feed metadata excludes private storage keys', async () => {
  const { authorizeFileUpload, authorizeFileAttach, attachFileReference, authorizeFileRead, resolveFileTarget } = await import('../src/attachments.js');
  const store = setup(), order = store.orders[0], supplier = store.users.find(u => u.id === 'supplier');
  const file = { fileId: 'scan', purpose: 'supplier_invoice', state: 'ready', ownerId: supplier.id, objectKey: 'private/scan', size: 100, detectedContentType: 'image/png', originalFilename: 'invoice.png', createdAt: AT, references: [] };
  store.files.push(file);
  authorizeFileUpload(supplier, 'supplier_invoice');
  const target = resolveFileTarget(store, 'supplier_invoice', { orderId: order.id }, supplier);
  authorizeFileAttach(supplier, file, target); attachFileReference(file, target);
  authorizeFileRead(supplier, store, file);
  authorizeFileRead(store.users.find(u => u.id === 'ops'), store, file);
  for (const actor of ['client', 'rider', 'other']) assert.throws(() => authorizeFileRead(store.users.find(u => u.id === actor), store, file), e => e.status === 403);
  const feed = await call(store, 'ops', '/ops/hub/receipt-scans', {}, 'GET');
  assert.equal(feed.body.scans[0].fileId, 'scan');
  assert.equal(feed.body.scans[0].orderId, order.id);
  assert.equal(JSON.stringify(feed).includes('private/scan'), false);
  assert.equal(publicOrderFor(order, store.users.find(u => u.id === 'client'), store).supplierInvoiceFileIds, undefined);
});

test('disabled rollout preserves released-app handovers; disabling after issuance cannot weaken the OTP gate', () => {
  const store = fixture(), order = store.orders[0];
  order.state = 'ready_for_dispatch';
  assert.equal(prepareHandover(store, order, { at: AT }), false);
  assert.equal(order.handover, undefined);
  store.settings.handoverOtpEnabled = true;
  assert.equal(prepareHandover(store, order, { at: AT }), true);
  const original = structuredClone(order.handover);
  store.settings.handoverOtpEnabled = false;
  assert.equal(prepareHandover(store, order, { at: AT }), false);
  assert.deepEqual(order.handover, original);
  assert.throws(() => verifyHandoverOtp(order, undefined), e => e.code === 'handover_otp_mismatch');
});

test('malformed staff role input is rejected before any role is created', async () => {
  const store = setup();
  await rejects(call(store, 'admin', '/admin/staff/roles', { name: 'Desk', canHandout: true }), 'invalid_staff_role');
  assert.equal(store.staffRoles.length, 1);
});
