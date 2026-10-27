import { identityHasMembership } from './authorization-context.js';
import { createInviteCode, publicTesterInvites } from './tester-invites.js';
import { voucherFail as fail } from './vouchers.js';
import { notifyAdmins } from './domain-events.js';
import { queueInvalidate } from './notifications.js';
import { isReviewData } from './review-data.js';
import { reminderReport } from './delivery-reminders.js';

const submitted = (store, order) => Boolean(store.orderSurveys?.some(s => s.orderId === order.id && s.submittedAt));
const delivered = order => Boolean(order.issueWindowOpenedAt || order.timeline?.some(e => e.state === 'delivered'))
  || ['delivered', 'issue_window_open', 'completed', 'payout_released'].includes(order.state);
const object = body => { if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request'); return body; };

export function shareView(store, order) {
  const client = store.users.find(user => user.id === order.clientId);
  const surveySubmitted = submitted(store, order);
  const available = !isReviewData(order) && !isReviewData(client) && (surveySubmitted || delivered(order));
  const state = store.orderShareCards?.find(row => row.orderId === order.id);
  const invites = publicTesterInvites(store, order.clientId);
  return { orderId: order.id, available, firstName: (client?.name || '').trim().split(/\s+/)[0] || '',
    foundingTester: Boolean(store.foundingTesters?.some(row => row.clientId === order.clientId && row.awardedAt)),
    inviteCode: invites.code, inviteLink: invites.link,
    card: { firstShownAt: state?.firstShownAt ?? null, dismissedAt: state?.dismissedAt ?? null,
      repeatShownAt: state?.repeatShownAt ?? null, closedAt: state?.closedAt ?? null,
      showAfterSurvey: available && surveySubmitted && !state?.firstShownAt && !state?.closedAt,
      showFromOrder: available && surveySubmitted && Boolean(state?.dismissedAt) && !state?.repeatShownAt && !state?.closedAt } };
}

function cardEvent(store, order, body, at) {
  if (!['after_survey', 'order_repeat'].includes(body.presentation)
    || !['shown', 'maybe_later', 'close'].includes(body.action)) fail(400, 'invalid_share_card_event');
  if (!submitted(store, order)) fail(409, 'share_card_not_available');
  store.orderShareCards ||= [];
  let row = store.orderShareCards.find(r => r.orderId === order.id);
  if (!row) {
    row = { orderId: order.id, clientId: order.clientId };
    store.orderShareCards.push(row);
  }
  if (row.closedAt) return false;
  const first = body.presentation === 'after_survey';
  // A retry is tied to its presentation, so a late initial dismissal cannot dismiss the repeat.
  if (body.action === 'shown') {
    const key = first ? 'firstShownAt' : 'repeatShownAt';
    if (row[key]) return false;
    if (!first && !row.dismissedAt) fail(409, 'share_card_transition_invalid');
    row[key] = at;
    return true;
  }
  if (!(first ? row.firstShownAt : row.repeatShownAt)) fail(409, 'share_card_transition_invalid');
  if (first && row.repeatShownAt) return false;
  if (first && body.action === 'maybe_later') {
    if (row.dismissedAt) return false;
    row.dismissedAt = at;
  } else row.closedAt = at;
  return true;
}

function reportOptions(params) {
  const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 100);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) fail(400, 'invalid_pagination');
  for (const key of ['from', 'to']) if (params.has(key) && !Number.isFinite(Date.parse(params.get(key)))) fail(400, 'invalid_share_filter');
  const from = params.has('from') ? Date.parse(params.get('from')) : -Infinity;
  const to = params.has('to') ? Date.parse(params.get('to')) : Infinity;
  if (from >= to) fail(400, 'invalid_share_filter');
  return { offset, limit, inRange: at => Date.parse(at) >= from && Date.parse(at) < to };
}
function missionShares(store, params, inRange) {
  const validOrders = new Set(store.orders.filter(order => !isReviewData(order)).map(order => order.id));
  const counts = new Map();
  for (const tap of store.orderShareTaps || []) {
    if (!inRange(tap.createdAt) || !validOrders.has(tap.orderId)) continue;
    if (!counts.has(tap.clientId)) counts.set(tap.clientId, { shareTaps: 0, sendToFriendTaps: 0 });
    counts.get(tap.clientId)[tap.action === 'share' ? 'shareTaps' : 'sendToFriendTaps']++;
  }
  const clients = new Set(store.userRoleMemberships.filter(m => m.role === 'client').map(m => m.userId));
  return store.users.filter(user => clients.has(user.id) && !isReviewData(user)
    && (!params.has('clientId') || params.get('clientId') === user.id))
    .map(user => ({ clientId: user.id, ...(counts.get(user.id) || { shareTaps: 0, sendToFriendTaps: 0 }) }))
    .sort((a, b) => a.clientId.localeCompare(b.clientId));
}

export async function routeOrderSharing({ req, url, store, user, readBody, now, id }) {
  const path = url.pathname;
  const match = /^\/orders\/([^/]+)\/share(?:\/(prepare|card|taps))?$/.exec(path);
  const staffRoute = ['/ops/mission-shares', '/ops/delivery-reminders'].includes(path);
  if (!match && !staffRoute) return null;
  if (!user) fail(401, 'unauthorized');
  const at = now();
  if (staffRoute) {
    if (!['ops_admin', 'super_admin'].some(role => identityHasMembership(user, role))) fail(403, 'forbidden');
    if (req.method !== 'GET') fail(404, 'not_found');
    const { offset, limit, inRange } = reportOptions(url.searchParams);
    const rows = path === '/ops/mission-shares' ? missionShares(store, url.searchParams, inRange) : reminderReport(store, url.searchParams, inRange);
    return { status: 200, body: { serverTime: at, ...(path.endsWith('delivery-reminders') ? { timezone: 'Asia/Manila' } : {}),
      total: rows.length, [path.endsWith('mission-shares') ? 'clients' : 'weeks']: rows.slice(offset, offset + limit) } };
  }
  if (!identityHasMembership(user, 'client')) fail(403, 'forbidden');
  const order = store.orders.find(o => o.id === match[1] && o.clientId === user.id);
  if (!order) fail(404, 'order_not_found');
  const response = (mutated = false, extra = {}) => ({ status: 200, body: { serverTime: at, share: shareView(store, order), ...extra }, mutated });
  if (req.method === 'GET' && !match[2]) return response();
  if (req.method !== 'POST' || !match[2]) fail(404, 'not_found');
  if (!shareView(store, order).available) fail(409, 'order_share_not_available');
  if (match[2] === 'prepare') {
    const prior = store.testerInviteCodes?.some(row => row.clientId === user.id);
    createInviteCode(store, user.id, { at });
    return response(!prior);
  }
  const body = object(await readBody(req));
  let changed, eventId;
  if (match[2] === 'card') changed = cardEvent(store, order, body, at);
  else {
    if (typeof body.eventId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.eventId)
      || !['share', 'send_to_friend'].includes(body.action)) fail(400, 'invalid_share_tap');
    eventId = body.eventId.toLowerCase();
    store.orderShareTaps ||= [];
    const prior = store.orderShareTaps.find(tap => tap.clientId === user.id && tap.eventId === eventId);
    if (prior && (prior.orderId !== order.id || prior.action !== body.action)) fail(409, 'share_tap_conflict');
    changed = !prior;
    if (changed) store.orderShareTaps.push({ clientId: user.id, orderId: order.id, eventId, action: body.action, createdAt: at });
  }
  if (changed) {
    const action = match[2] === 'taps' ? 'tapped' : `card_${body.presentation}_${body.action}`;
    store.auditLog.push({ id: id('aud'), at, actorId: user.id, actorRole: 'client', action: `order_share.${action}`,
      entityType: 'order', entityId: order.id, orderId: order.id, detail: { action: body.action, ...(eventId ? { eventId } : { presentation: body.presentation }) } });
    notifyAdmins(store, `order_share_${action}`, 'Order sharing update', order,
      `order-share:${order.id}:${eventId || action}`, { createId: id, at });
    queueInvalidate(store, { resource: 'orders', id: order.id, userIds: [user.id] });
  }
  return response(changed, eventId ? { eventId, recorded: true, replay: !changed } : {});
}
