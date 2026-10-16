import { notifyAdmins } from './domain-events.js';
import { queueInvalidate } from './notifications.js';
import { identityHasMembership } from './authorization-context.js';
import { voucherFail as fail } from './vouchers.js';
import { SURVEY_OPTIONS, publicSurvey, submitSurvey, syncSurveys, surveyReport } from './surveys.js';

export async function routeSurveys({ req, url, store, user, readBody, id, now }) {
  const path = url.pathname;
  const match = /^\/orders\/([^/]+)\/survey(?:\/(dismiss))?$/.exec(path);
  if (!match && path !== '/me/surveys' && path !== '/admin/survey-responses') return null;
  if (!user) fail(401, 'unauthorized');
  const at = now();
  if (path === '/admin/survey-responses') {
    if (!identityHasMembership(user, 'super_admin')) fail(403, 'forbidden');
    if (req.method !== 'GET') fail(404, 'not_found');
    const result = surveyReport(store, url.searchParams);
    return result.bytes ? { status: 200, ...result, contentType: 'text/csv; charset=utf-8', filename: 'survey-responses.csv' }
      : { status: 200, body: { ...result, serverTime: at } };
  }
  if (!identityHasMembership(user, 'client')) fail(403, 'forbidden');
  if (path === '/me/surveys' && req.method === 'GET') {
    return { status: 200, body: { serverTime: at, options: SURVEY_OPTIONS,
      surveys: store.orders.filter(o => o.clientId === user.id).map(o => publicSurvey(store, o, at)).filter(s => s?.status === 'open') } };
  }
  if (!match) fail(404, 'not_found');
  const order = store.orders.find(o => o.id === match[1] && o.clientId === user.id);
  if (!order) fail(404, 'order_not_found');
  if (req.method === 'GET' && !match[2]) return { status: 200, body: { serverTime: at, survey: publicSurvey(store, order, at), options: SURVEY_OPTIONS } };
  if (req.method === 'POST' && !match[2]) {
    const replay = store.orderSurveys?.some(s => s.orderId === order.id && s.submittedAt);
    return { status: 200, body: { serverTime: at, survey: submitSurvey(store, order, await readBody(req), { id, at }) }, mutated: !replay };
  }
  if (req.method === 'POST' && match[2] === 'dismiss') {
    const view = publicSurvey(store, order, at);
    if (!view || view.status !== 'open') fail(409, 'survey_closed');
    const changed = syncSurveys(store, { id, at });
    const record = store.orderSurveys.find(s => s.orderId === order.id), prior = record.dismissedAt;
    record.dismissedAt ||= at;
    if (!prior) {
      store.auditLog.push({ id: id('aud'), at, actorId: user.id, actorRole: 'client', action: 'survey.dismissed', entityType: 'order_survey', entityId: order.id, orderId: order.id });
      notifyAdmins(store, 'order_survey_dismissed', 'Order survey dismissed', order, `survey-dismiss:${order.id}`, { createId: id, at });
      queueInvalidate(store, { resource: 'orders', id: order.id, userIds: [user.id] });
    }
    return { status: 200, body: { serverTime: at, survey: publicSurvey(store, order, at) }, mutated: changed || !prior };
  }
  fail(404, 'not_found');
}
