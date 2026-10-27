/** Read-only preflight. This command cannot issue rewards. */
import { promotionSettings } from './promotion-settings.js';
import { createDatabase } from './database.js';
import { loadStore } from './postgres-store.js';
import { foundingTesterEligible, testerProgress } from './founding-testers.js';

const database = createDatabase();
try {
  const store = await loadStore(database);
  const candidates = store.users.filter(u => foundingTesterEligible(store, u.id)
    && !store.foundingTesters.some(f => f.clientId === u.id && f.awardedAt)
    && !store.testerRewards.some(r => r.kind === 'mission' && r.clientId === u.id)
    && testerProgress(store, u.id).completedCount === 5);
  const reuse = candidates.filter(u => store.orderSurveys.some(s => s.clientId === u.id && s.rewardVoucherId)).length;
  console.log(JSON.stringify({ eligibleCompletedUnawarded: candidates.length, reuseSurveyVoucher: reuse,
    newVouchers: candidates.length - reuse, newFaceValueMinor: (BigInt(candidates.length - reuse) * BigInt(promotionSettings(store).rewards.missionMinor)).toString(),
    applied: false }));
} finally { await database.close(); }
