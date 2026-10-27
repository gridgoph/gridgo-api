import { issueVoucher, generatedVoucherCode, voucherFail as fail, voucherEvent, releaseVoucherReservations } from './vouchers.js';
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';

export function testerBudget(store, at) {
  // Philippine calendar month; money is issued face value, never redemption value.
  const month = new Date(Date.parse(at) + 8 * 3600000).toISOString().slice(0, 7);
  const campaigns = new Set(store.voucherCampaigns.filter(c => ['founding_tester', 'tester_referral'].includes(c.purpose)).map(c => c.id));
  const used = store.vouchers.filter(v => campaigns.has(v.campaignId)
    && new Date(Date.parse(v.issuedAt) + 8 * 3600000).toISOString().slice(0, 7) === month)
    .reduce((sum, v) => sum + BigInt(v.valueMinor), 0n);
  if (used > BigInt(Number.MAX_SAFE_INTEGER)) fail(409, 'tester_budget_overflow');
  const limitMinor = store.settings.testerMonthlyBudgetMinor ?? null;
  return { month, timezone: 'Asia/Manila', limitMinor, usedMinor: Number(used),
    remainingMinor: limitMinor == null ? null : Math.max(0, limitMinor - Number(used)), resumePolicy: 'super_admin_per_reward' };
}
export function testerEvent(store, reward, action, { id, at, actorId = null }, detail = {}) {
  store.auditLog.push({ id: id('aud'), at, actorId, actorRole: store.users.find(u => u.id === actorId)?.role || 'system',
    action: `tester_reward.${action}`, entityType: 'tester_reward', entityId: reward.id, detail });
  for (const member of privilegedAdminMemberships(store)) store.notifications.push({ id: id('not'), at, userId: member.userId,
    appRole: member.role, type: `tester_reward_${action}`, title: 'Tester reward update', body: `Tester reward ${action}.`, read: false });
  queueInvalidate(store, { resource: 'identity', userIds: [reward.clientId, reward.inviterId].filter(Boolean) });
}
export function createTesterReward(store, input, ctx) {
  store.testerRewards ||= [];
  let reward = store.testerRewards.find(r => r.kind === input.kind && r.clientId === input.clientId);
  if (reward) return reward;
  reward = { id: ctx.id('trwd'), ...input, status: 'paused', createdAt: ctx.at, issuedAt: null, voidedAt: null,
    voucherId: null, inviterVoucherId: null, reason: null, checks: {}, evidence: {} };
  store.testerRewards.push(reward);
  return reward;
}
export function issueTesterReward(store, reward, ctx, { reusedVoucher = null } = {}) {
  const budget = testerBudget(store, ctx.at);
  if (!reusedVoucher && BigInt(budget.usedMinor) + BigInt(reward.amountMinor) > BigInt(Number.MAX_SAFE_INTEGER)) fail(409, 'tester_budget_overflow');
  if (!reusedVoucher && budget.remainingMinor != null && budget.remainingMinor < reward.amountMinor) {
    if (reward.reason !== 'monthly_budget') { reward.reason = 'monthly_budget'; testerEvent(store, reward, 'paused', ctx); }
    return false;
  }
  const recipients = [reward.clientId, reward.inviterId].filter(Boolean);
  const vouchers = reusedVoucher ? [reusedVoucher] : recipients.map(clientId => {
    const campaign = { id: ctx.id('vcamp'), name: reward.kind === 'mission' ? 'Thank you, Founding Tester' : 'Founding Tester invite reward',
      purpose: reward.kind === 'mission' ? 'founding_tester' : 'tester_referral', code: generatedVoucherCode(), mode: 'assigned', status: 'active',
      valueMinor: Number(BigInt(reward.amountMinor) / BigInt(recipients.length)), totalLimit: 1, perAccountLimit: 1, validityDays: 30, endsAt: null, createdAt: ctx.at, updatedAt: ctx.at };
    store.voucherCampaigns.push(campaign);
    const voucher = issueVoucher(store, campaign, clientId, { ...ctx, adultConfirmed: false }).voucher;
    voucher.data.testerRewardId = reward.id;
    return voucher;
  });
  Object.assign(reward, { status: 'issued', issuedAt: ctx.at, reason: reusedVoucher ? 'existing_survey_reward' : null,
    voucherId: vouchers[0].id, inviterVoucherId: vouchers[1]?.id || null });
  testerEvent(store, reward, 'issued', ctx, { voucherIds: vouchers.map(v => v.id), reused: Boolean(reusedVoucher) });
  return true;
}
export function voidTesterReward(store, reward, reason, ctx) {
  if (reward.status === 'voided') return false;
  if (!['issued', 'paused'].includes(reward.status)) fail(409, 'tester_reward_not_voidable');
  const vouchers = [reward.voucherId, reward.inviterVoucherId].filter(Boolean).map(key => store.vouchers.find(v => v.id === key));
  if (vouchers.some(v => store.voucherReservations.some(r => r.voucherId === v.id && r.status === 'reserved' && r.data.orderIds?.length))) {
    fail(409, 'voucher_payment_reconciliation_required');
  }
  for (const voucher of vouchers) {
    // A used voucher remains a historical consumption, never becomes cash/debt.
    if (voucher.status === 'available') {
      releaseVoucherReservations(store, ctx, r => r.voucherId === voucher.id);
      voucher.status = 'void'; voucher.data.voidedAt = ctx.at;
      voucherEvent(store, voucher, 'void', { ...ctx, reason });
    }
    voucher.data.testerRewardVoided = true;
  }
  Object.assign(reward, { status: 'voided', voidedAt: ctx.at, reason });
  testerEvent(store, reward, 'voided', ctx, { reason });
  return true;
}
