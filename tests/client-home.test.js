import test from 'node:test';
import assert from 'node:assert/strict';
import { activeOrders, clientHomeSummary, HOME_ORDER_STEP_BY_STATE, HOME_ORDER_STEPS } from '../src/client-home.js';

const AT = '2026-11-02T00:00:00.000Z';
function store(extra = {}) {
  return {
    settings: { foundingTesterLaunchAt: null },
    users: [{ id: 'client', role: 'client', createdAt: '2026-01-01T00:00:00.000Z' }],
    userRoleMemberships: [{ userId: 'client', role: 'client' }],
    orders: [], orderLineItems: [], carts: [], cartLines: [], issues: [], refundSettlements: [], orderSurveys: [],
    foundingTesters: [], testerRewards: [], testerTracking: [], vouchers: [], voucherCampaigns: [], voucherReservations: [],
    ...extra,
  };
}
const order = (id, state, extra = {}) => ({ id, clientId: 'client', state, createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z', timeline: [{ state, at: '2026-10-03T00:00:00.000Z' }], ...extra });

test('every order state maps to one of the four steps or is not active', () => {
  assert.deepEqual(HOME_ORDER_STEPS, ['placed', 'printing', 'on_the_way', 'delivered']);
  const byStep = Object.groupBy(Object.entries(HOME_ORDER_STEP_BY_STATE), ([, step]) => step);
  assert.deepEqual(byStep[2].map(([state]) => state), ['production', 'supplier_self_qc']);
  assert.deepEqual(byStep[3].map(([state]) => state), ['ready_for_dispatch', 'rider_assigned', 'picked_up', 'out_for_delivery', 'awaiting_collection']);
  assert.deepEqual(byStep[4].map(([state]) => state), ['delivered', 'issue_window_open']);
  for (const state of ['draft', 'cancelled', 'completed', 'payout_released']) {
    assert.equal(HOME_ORDER_STEP_BY_STATE[state], undefined);
    assert.equal(activeOrders(store({ orders: [order('o', state)] }), 'client').length, 0);
  }
});

test('in-progress orders rank by soonest promise; a delivered order only when nothing is in progress', () => {
  const s = store({ orders: [
    order('delivered', 'issue_window_open', { issueWindowOpenedAt: '2026-10-05T00:00:00.000Z' }),
    order('late', 'production', { promiseBy: '2026-11-09T00:00:00.000Z' }),
    order('soon', 'awaiting_checkout', { promiseBy: '2026-11-04T00:00:00.000Z' }),
    order('open', 'out_for_delivery'),
    order('foreign', 'production', { clientId: 'other', promiseBy: '2026-11-03T00:00:00.000Z' }),
  ] });
  const rows = activeOrders(s, 'client');
  assert.deepEqual(rows.map(row => row.orderId), ['soon', 'late', 'open', 'delivered']);
  assert.deepEqual(rows[0], { orderId: 'soon', state: 'awaiting_checkout', step: 1, stepKey: 'placed', stepCount: 4,
    fulfillmentMode: null, basketId: null, awaitingPayment: true, promisedAt: '2026-11-04T00:00:00.000Z',
    statusAt: '2026-10-03T00:00:00.000Z', time: { kind: 'promised', at: '2026-11-04T00:00:00.000Z' } });
  assert.deepEqual(rows[2].time, { kind: 'since', at: '2026-10-03T00:00:00.000Z' });
  assert.deepEqual(rows[3].time, { kind: 'delivered', at: '2026-10-05T00:00:00.000Z' });
  assert.equal(activeOrders(store({ orders: [order('d', 'delivered')] }), 'client')[0].stepKey, 'delivered');
});

test('the tile shows the first state that applies', () => {
  const s = store({ orders: [order('o', 'production')] });
  let home = clientHomeSummary(s, 'client', AT);
  assert.equal(home.tile, 'missions');
  assert.equal(home.missions.completedCount, 0, 'no paid order, cart or order line yet');
  assert.equal(home.missions.total, 5);
  assert.deepEqual(home.bugReport, { rewardAvailable: true, amountMinor: 1500 });

  s.settings.foundingTesterLaunchAt = '2025-01-01T00:00:00.000Z';
  home = clientHomeSummary(s, 'client', AT);
  assert.equal(home.missions.eligible, false);
  assert.equal(home.bugReport.rewardAvailable, false, 'only testers can earn the bug-report voucher');
  assert.equal(home.tile, 'active_order');
  assert.equal(home.activeOrder.stepKey, 'printing');

  s.orders[0].state = 'completed';
  s.voucherCampaigns.push({ id: 'camp', name: 'Thank you for reporting a bug', purpose: 'tester_bug_report', status: 'active', code: 'BUGCODE' });
  s.vouchers.push({ id: 'vch', campaignId: 'camp', clientId: 'client', status: 'available', valueMinor: 1500,
    issuedAt: '2026-10-30T00:00:00.000Z', expiresAt: '2026-11-29T00:00:00.000Z', data: {} });
  s.testerRewards.push({ id: 'trwd', kind: 'bug_report', clientId: 'client', voucherId: 'vch', status: 'issued' });
  home = clientHomeSummary(s, 'client', AT);
  assert.equal(home.tile, 'tester_voucher');
  assert.deepEqual(home.testerVoucher, { voucherId: 'vch', kind: 'bug_report', valueMinor: 1500, code: 'BUGCODE',
    expiresAt: '2026-11-29T00:00:00.000Z', secondsRemaining: 27 * 86400, daysLeft: 27, redeemable: true, reserved: false });

  s.vouchers[0].status = 'used';
  assert.equal(clientHomeSummary(s, 'client', AT).tile, 'invite');
  s.vouchers[0].status = 'available';
  s.vouchers[0].expiresAt = '2026-11-01T00:00:00.000Z';
  assert.equal(clientHomeSummary(s, 'client', AT).tile, 'invite', 'an expired voucher is not unused');
});

test('referral vouchers count for the inviter; another client voucher never does', () => {
  const s = store({ settings: { foundingTesterLaunchAt: '2025-01-01T00:00:00.000Z' } });
  s.voucherCampaigns.push({ id: 'camp', purpose: 'tester_referral', status: 'active', code: 'INV' });
  s.vouchers.push({ id: 'mine', campaignId: 'camp', clientId: 'client', status: 'available', valueMinor: 1500, issuedAt: AT,
    expiresAt: '2026-11-20T00:00:00.000Z', data: {} },
  { id: 'theirs', campaignId: 'camp', clientId: 'friend', status: 'available', valueMinor: 1500, issuedAt: AT,
    expiresAt: '2026-11-10T00:00:00.000Z', data: {} });
  s.testerRewards.push({ id: 'r', kind: 'referral', clientId: 'friend', inviterId: 'client', voucherId: 'theirs', inviterVoucherId: 'mine' });
  const home = clientHomeSummary(s, 'client', AT);
  assert.equal(home.testerVoucher.voucherId, 'mine');
  assert.equal(home.testerVoucher.kind, 'referral');
});
