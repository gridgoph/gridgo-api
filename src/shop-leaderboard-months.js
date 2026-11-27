import { leaderboardPeriod, leaderboardSettings, leaderboardScores, localLeaderboard } from './shop-leaderboard.js';
import { appendAudit } from './audit.js';
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';

const iso = ms => new Date(ms).toISOString();
export function previousLeaderboardMonth(at) {
  const active = leaderboardPeriod('month',at);
  const period = leaderboardPeriod('month',iso(Date.parse(active.startAt)-1));
  return { month: iso(Date.parse(period.startAt)+8*3600000).slice(0,7), period, validFrom: active.startAt, validUntil: active.endAt };
}

/** Only monthly award metadata crosses the client boundary. */
export function topShopBadge(store,supplierId,at) {
  const month = previousLeaderboardMonth(at).month;
  const result = (store.shopLeaderboardMonths || []).find(row => row.month === month);
  if (!result || !(Date.parse(at) >= Date.parse(result.validFrom) && Date.parse(at) < Date.parse(result.validUntil))
    || !result.winners.some(row => row.supplierId === supplierId)) return null;
  return { type: 'top_shop', month, validFrom: result.validFrom, validUntil: result.validUntil };
}

/** Both names are aliases of the Nearest UI choice; no other matching sort changes. */
export function nearestTopShopOrder(sort,a,b) {
  return ['nearest','nearby'].includes(sort) ? Number(Boolean(b.topShopBadge))-Number(Boolean(a.topShopBadge)) : 0;
}

/** Called only under the domain transaction lock. Freeze one completed month,
 * including a zero-winner result, so retries and restarts cannot re-award it. */
export function closeLeaderboardMonth(store,{at,id}) {
  const window = previousLeaderboardMonth(at);
  if ((store.shopLeaderboardMonths || []).some(row => row.month === window.month)) return false;
  const policy = leaderboardSettings(store.settings);
  // Never credit facts from the following month, including a delayed answer.
  const cutoff = iso(Date.parse(window.period.endAt)-1);
  const scores = leaderboardScores(store,window.period,cutoff,policy);
  const winners = [];
  for (const score of scores) {
    const ranking = localLeaderboard(store,score.supplierId,scores,policy);
    const own = ranking.find(row => row.supplierId === score.supplierId);
    if (own && own.rank <= policy.monthlyTopCount) winners.push({ ...own, groupSize: ranking.length });
  }
  winners.sort((a,b) => a.supplierId.localeCompare(b.supplierId));
  const result = { ...window, closedAt: at, policy: structuredClone(policy), winners };
  (store.shopLeaderboardMonths ||= []).push(result);
  for (const winner of winners) (store.shopTopStickers ||= []).push({ month: window.month, supplierId: winner.supplierId, deliveredAt: null, deliveredBy: null });
  appendAudit(store,{action:'shop_leaderboard.month_closed',entityType:'shop_leaderboard_month',entityId:window.month,
    detail:{month:window.month,policy,winners:winners.map(row=>({supplierId:row.supplierId,rank:row.rank,score:row.score}))}},{at,id});
  const admins = privilegedAdminMemberships(store);
  for (const recipient of [...winners.map(row=>({userId:row.supplierId,role:'supplier'})),...admins]) {
    (store.notifications ||= []).push({ id:id('ntf'),at,userId:recipient.userId,appRole:recipient.role,type:'shop_top_award',
      title:'Monthly Top Shop awards',body:`The Top Shop awards for ${window.month} are ready.`,read:false });
  }
  queueInvalidate(store,{resource:'catalog',userIds:[...winners.map(row=>row.supplierId),...admins.map(row=>row.userId)]});
  return true;
}

/** Cheap lifecycle candidate probe. Reads never create or alter an award. */
export async function leaderboardMonthDue(database,at) {
  return !(await database.query('SELECT 1 FROM shop_leaderboard_months WHERE month=$1',[previousLeaderboardMonth(at).month])).rowCount;
}
