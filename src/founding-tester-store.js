const fields = { client_id: 'clientId', awarded_at: 'awardedAt', reward_voucher_id: 'rewardVoucherId', reward_reused: 'rewardReused', reminded_2_at: 'reminded2At', reminded_5_at: 'reminded5At' };
export const foundingTesterTable = { name: 'founding_testers', keys: ['client_id'], columns: Object.keys(fields) };
export function foundingTesterRows(store, rows) {
  rows.founding_testers = (store.foundingTesters || []).map(item => Object.fromEntries(Object.entries(fields).map(([sql, js]) => [sql, item[js] ?? (js === 'rewardReused' ? false : null)])));
}
export function loadFoundingTesterRows(store, rows) {
  store.foundingTesters = rows.founding_testers.map(item => Object.fromEntries(Object.entries(fields).map(([sql, js]) => [js, item[sql]])));
}
