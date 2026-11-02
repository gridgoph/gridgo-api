/**
 * The one-time bug-report voucher (gridgo-client#335, decided 26 Oct 2026): a
 * tester earns PHP 15 once, only when Operations or Super Admin confirm that one
 * of their in-app issue reports is a real bug. Contract: docs/CLIENT_HOME_API.md.
 *
 * A tester is a client the Founding Tester programme already counts as eligible
 * (`foundingTesterEligible`). The entitlement is a `tester_rewards` row of kind
 * `bug_report`; PostgreSQL's UNIQUE(kind, client_id) makes it once per tester ever,
 * including after expiry or void. Issuance reuses the tester wallet hook and the
 * shared monthly tester budget: with no room the entitlement is stored `paused`
 * and waits for the existing Super Admin resume.
 */
import { foundingTesterEligible } from './founding-testers.js';
import { createTesterReward, issueTesterReward } from './tester-rewards.js';

export const BUG_REPORT_REWARD_MINOR = 1500;
export const BUG_REWARD_OUTCOMES = Object.freeze(['granted', 'paused', 'already_rewarded', 'not_tester', 'no_reporter']);

export const bugReportRewardFor = (store, clientId) =>
  (store.testerRewards || []).find(reward => reward.kind === 'bug_report' && reward.clientId === clientId) || null;

/** Whether a confirmed report from this client would still earn the voucher. */
export function bugReportRewardAvailable(store, clientId) {
  return Boolean(clientId) && foundingTesterEligible(store, clientId) && !bugReportRewardFor(store, clientId);
}

/** Caller holds the domain lock and saves the store with the report update. */
export function grantBugReportReward(store, reporterId, ctx) {
  if (!reporterId) return { outcome: 'no_reporter', reward: null };
  if (!foundingTesterEligible(store, reporterId)) return { outcome: 'not_tester', reward: null };
  if (bugReportRewardFor(store, reporterId)) return { outcome: 'already_rewarded', reward: null };
  const reward = createTesterReward(store, { kind: 'bug_report', clientId: reporterId, inviterId: null, inviteId: null,
    amountMinor: BUG_REPORT_REWARD_MINOR }, ctx);
  return { outcome: issueTesterReward(store, reward, ctx) ? 'granted' : 'paused', reward };
}
