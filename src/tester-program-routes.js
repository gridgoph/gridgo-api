import { identityHasMembership } from './authorization-context.js';
import { voucherFail as fail } from './vouchers.js';
import { publicFoundingTester, testerOrderFacts, testerProgress, reconcileFoundingTester, recordTesterCartStep, foundingTesterEligible } from './founding-testers.js';
import { createInviteCode, recordTesterInstallation, submitTesterInvite, matchTesterInvites, reconcileTesterInvite, publicTesterInvites } from './tester-invites.js';
import { testerBudget, voidTesterReward, testerEvent } from './tester-rewards.js';

const object = body => { if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request'); return body; };
const publicReward = ({ evidence, ...reward }) => reward;
function page(rows, params) {
  const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 100);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) fail(400, 'invalid_pagination');
  return { total: rows.length, rows: rows.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(offset, offset + limit) };
}
export async function routeTesterProgram({ req, url, store, user, readBody, now, id }) {
  const path = url.pathname;
  const tracking = /^\/orders\/([^/]+)\/tester-tracking$/.exec(path);
  if (!tracking && !/^\/(me\/founding-tester(?:\/|$)|ops\/tester-(?:invites|rewards)(?:\/|$)|admin\/tester-rewards\/)/.test(path)) return null;
  if (!user) fail(401, 'unauthorized');
  const superAdmin = identityHasMembership(user, 'super_admin');
  const ops = superAdmin || identityHasMembership(user, 'ops_admin');
  const clientRoute = Boolean(tracking) || path.startsWith('/me/');
  if (clientRoute ? !identityHasMembership(user, 'client') : path.startsWith('/admin/') ? !superAdmin : !ops) fail(403, 'forbidden');
  const at = now(), ctx = { id, at, actorId: user.id };
  const result = (body, mutated = false) => ({ status: 200, body, mutated });
  const clientView = () => ({ serverTime: at, foundingTester: publicFoundingTester(store, user.id, at), invites: publicTesterInvites(store, user.id) });
  if (path === '/me/founding-tester' && req.method === 'GET') return result(clientView());
  if (clientRoute && req.method === 'POST') {
    if (tracking) {
      const order = store.orders.find(o => o.id === tracking[1] && o.clientId === user.id);
      if (!order) fail(404, 'order_not_found');
      if (!testerOrderFacts(store, order).placed) fail(409, 'tester_order_not_placed');
      const body = object(await readBody(req));
      if (body.installationId != null) recordTesterInstallation(store, user.id, body.installationId, ctx);
      if (!store.testerTracking.some(t => t.orderId === order.id && t.clientId === user.id)) store.testerTracking.push({ clientId: user.id, orderId: order.id, createdAt: at });
    } else if (['/me/founding-tester/invite', '/me/founding-tester/installation'].includes(path)) {
      const body = object(await readBody(req));
      if (path.endsWith('/installation') || body.installationId != null) recordTesterInstallation(store, user.id, body.installationId, ctx);
      if (path.endsWith('/invite')) createInviteCode(store, user.id, ctx);
    } else fail(404, 'not_found');
    recordTesterCartStep(store, user.id, at);
    matchTesterInvites(store, ctx);
    reconcileFoundingTester(store, user.id, ctx);
    reconcileTesterInvite(store, user.id, ctx);
    return result(clientView(), true);
  }
  if (path === '/ops/tester-invites' && req.method === 'POST') {
    const invite = submitTesterInvite(store, object(await readBody(req)), ctx);
    matchTesterInvites(store, ctx);
    return result({ invite }, true);
  }
  if (path === '/ops/tester-invites/match' && req.method === 'POST') {
    const changed = matchTesterInvites(store, ctx);
    return result({ matched: store.testerInvites.filter(i => i.clientId).length, unmatched: store.testerInvites.filter(i => !i.clientId).length }, changed);
  }
  if (path === '/ops/tester-invites' && req.method === 'GET') {
    const status = url.searchParams.get('status');
    if (status && !['unmatched', 'joined', 'completed'].includes(status)) fail(400, 'invalid_tester_invite_status');
    const list = store.testerInvites.map(i => ({ ...i, status: i.completedAt ? 'completed' : i.clientId ? 'joined' : 'unmatched' }))
      .filter(i => (!status || i.status === status) && (!url.searchParams.has('inviterId') || i.inviterId === url.searchParams.get('inviterId')));
    const { total, rows } = page(list, url.searchParams);
    return result({ serverTime: at, total, invites: rows });
  }
  if (path === '/ops/tester-rewards' && req.method === 'GET') {
    const status = url.searchParams.get('status');
    if (status && !['issued', 'paused', 'voided', 'blocked'].includes(status)) fail(400, 'invalid_tester_reward_status');
    const list = store.testerRewards.filter(r => (!status || r.status === status)
      && (!url.searchParams.has('clientId') || [r.clientId, r.inviterId].includes(url.searchParams.get('clientId'))));
    const { total, rows } = page(list, url.searchParams);
    return result({ serverTime: at, total, rewards: rows.map(publicReward), budget: testerBudget(store, at) });
  }
  const action = /^\/admin\/tester-rewards\/([^/]+)\/(void|resume)$/.exec(path);
  if (action && req.method === 'POST') {
    const reward = store.testerRewards.find(r => r.id === action[1]);
    if (!reward) fail(404, 'tester_reward_not_found');
    const body = object(await readBody(req));
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000) fail(400, 'tester_reason_required');
    if (action[2] === 'void') voidTesterReward(store, reward, body.reason.trim(), ctx);
    else {
      if (reward.status !== 'paused') fail(409, 'tester_reward_not_paused');
      if (!foundingTesterEligible(store, reward.clientId) || testerProgress(store, reward.clientId, { preserveAward: reward.kind === 'mission' }).completedCount !== 5) fail(409, 'tester_reward_not_ready');
      const reconciler = reward.kind === 'mission' ? reconcileFoundingTester : reconcileTesterInvite;
      reconciler(store, reward.clientId, { ...ctx, resume: true });
      testerEvent(store, reward, 'resume_requested', ctx, { reason: body.reason.trim() });
    }
    return result({ reward: publicReward(reward), budget: testerBudget(store, at) }, true);
  }
  fail(404, 'not_found');
}
