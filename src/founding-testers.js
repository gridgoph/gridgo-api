import { issueVoucher, publicVoucher, generatedVoucherCode } from './vouchers.js';
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';
import { isReviewData } from './review-data.js';

const DAY = 86400000;
const account = (store, clientId) => store.foundingTesters?.find(row => row.clientId === clientId);
export function foundingTesterEligible(store, clientId) {
  const user = store.users.find(row => row.id === clientId);
  if (!user || isReviewData(user) || !store.userRoleMemberships?.some(m => m.userId === clientId && m.role === 'client')) return false;
  return Boolean(account(store, clientId)?.awardedAt) || !store.settings?.foundingTesterLaunchAt
    || Date.parse(user.createdAt) < Date.parse(store.settings.foundingTesterLaunchAt);
}

// Only recorded operational facts count. Unattributed cancellations/refunds do not
// manufacture a successful handover. Client fault takes precedence over exceptions.
export function testerOrderFacts(store, order) {
  const decisions = (store.issues || []).filter(i => i.orderId === order.id).map(i => i.faultDecision).filter(d => d?.status === 'approved');
  const settlements = (store.refundSettlements || []).filter(s => s.orderId === order.id && s.disposition !== 'delivery_adjustment');
  const clientFault = decisions.some(d => d.fault === 'client') || settlements.some(s => s.snapshot?.clientCaused === true);
  const failureAt = [...(order.shopFailureEvents || []).map(e => e.at), ...decisions.filter(d => ['shop', 'gridgo'].includes(d.fault)).map(d => d.approvedAt || d.recordedAt)]
    .filter(at => Number.isFinite(Date.parse(at))).sort()[0] || null;
  const excluded = isReviewData(order) || clientFault || (!failureAt && (order.state === 'cancelled' || settlements.length > 0));
  const placed = !excluded && (Boolean(failureAt) || order.payments?.initial?.status === 'confirmed');
  const completedAt = order.issueWindowOpenedAt || order.timeline?.find(e => e.state === 'delivered')?.at || null;
  const received = placed && (Boolean(failureAt) || Boolean(completedAt));
  const rated = received && (store.orderSurveys || []).some(s => s.orderId === order.id && s.submittedAt);
  return { placed, received, rated, failureAt: excluded ? null : failureAt };
}
export function testerProgress(store, clientId) {
  const orders = store.orders.filter(o => o.clientId === clientId);
  const facts = orders.map(o => ({ orderId: o.id, ...testerOrderFacts(store, o) }));
  const missions = Object.fromEntries(['placed', 'received', 'rated'].map(key => [key, facts.some(f => f[key])]));
  return { missions, completedCount: Object.values(missions).filter(Boolean).length };
}
export function publicFoundingTester(store, clientId, at) {
  const row = account(store, clientId), eligible = foundingTesterEligible(store, clientId);
  const reward = row?.rewardVoucherId && store.vouchers.find(v => v.id === row.rewardVoucherId);
  return { eligible, label: row?.awardedAt ? 'Founding Tester' : null, awardedAt: row?.awardedAt || null,
    ...(row?.awardedAt ? { missions: { placed: true, received: true, rated: true }, completedCount: 3 } : testerProgress(store, clientId)), reward: reward ? publicVoucher(store, reward, at) : null,
    rewardStatus: row?.awardedAt ? (row.rewardReused ? 'existing_survey_reward' : 'issued') : eligible ? 'pending' : 'ineligible' };
}
function rowFor(store, clientId) {
  store.foundingTesters ||= [];
  let row = account(store, clientId);
  if (!row) { row = { clientId }; store.foundingTesters.push(row); }
  return row;
}
function notify(store, clientId, type, title, body, { id, at }, push = true) {
  for (const recipient of [{ userId: clientId, role: 'client' }, ...privilegedAdminMemberships(store)]) {
    store.notifications.push({ id: id('not'), userId: recipient.userId, appRole: recipient.role, type, title, body, at, read: false,
      ...(recipient.role === 'client' && !push ? { push: false } : {}) });
  }
  queueInvalidate(store, { resource: 'identity', userIds: [clientId] });
  queueInvalidate(store, { resource: 'notifications', userIds: [clientId] });
}
/** One account at a time inside the domain transaction. No background bulk award. */
export function reconcileFoundingTester(store, clientId, { id, at }) {
  if (!foundingTesterEligible(store, clientId) || account(store, clientId)?.awardedAt || testerProgress(store, clientId).completedCount !== 3) return false;
  const row = rowFor(store, clientId);
  const prior = (store.orderSurveys || []).filter(s => s.clientId === clientId && s.rewardVoucherId).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))[0];
  let voucher = prior && store.vouchers.find(v => v.id === prior.rewardVoucherId);
  row.rewardReused = Boolean(voucher);
  if (!voucher) {
    const campaign = { id: id('vcamp'), name: 'Thank you, Founding Tester', purpose: 'founding_tester', code: generatedVoucherCode(),
      mode: 'assigned', status: 'active', valueMinor: 1500, totalLimit: 1, perAccountLimit: 1,
      validityDays: 30, endsAt: null, createdAt: at, updatedAt: at };
    store.voucherCampaigns.push(campaign);
    voucher = issueVoucher(store, campaign, clientId, { id, at, actorId: clientId, adultConfirmed: false }).voucher;
  }
  Object.assign(row, { awardedAt: at, rewardVoucherId: voucher.id });
  store.auditLog.push({ id: id('aud'), at, actorId: null, actorRole: 'system', action: 'founding_tester.awarded',
    entityType: 'user', entityId: clientId, detail: { voucherId: voucher.id, rewardReused: row.rewardReused } });
  notify(store, clientId, 'founding_tester_awarded', 'You are a Founding Tester',
    'You completed all three missions. View your label and reward in your account.', { id, at }, false);
  return true;
}
export function remindFoundingTesters(store, { id, at }) {
  let changed = false;
  for (const user of store.users) {
    if (!foundingTesterEligible(store, user.id) || account(store, user.id)?.awardedAt
      || user.accountStatus === 'suspended' || user.accountStatus === 'removed'
      || store.orders.some(o => o.clientId === user.id)) continue;
    const age = Date.parse(at) - Date.parse(user.createdAt);
    // Skip missed windows, never send two nudges together after downtime.
    const day = age >= 5 * DAY && age < 6 * DAY ? 5 : age >= 2 * DAY && age < 5 * DAY ? 2 : null;
    if (!day || account(store, user.id)?.[`reminded${day}At`] || account(store, user.id)?.reminded5At) continue;
    rowFor(store, user.id)[`reminded${day}At`] = at;
    notify(store, user.id, 'founding_tester_reminder', 'Try your first GRIDGO order',
      'Your Founding Tester missions are waiting. Place, receive and rate an order to complete them.', { id, at });
    changed = true;
  }
  return changed;
}
