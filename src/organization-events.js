import { memberFail as fail, memberEvent, manilaDay } from './member-perks.js';
import { isReviewData } from './review-data.js';
import { sumMinor } from './refund-policy.js';
import { NOTICE, csvCell, statementOrder, statementPesos, isClosedOrder } from './organization-statements.js';
import { statementPdf } from './statement-pdf.js';

/**
 * Liquidation records: the officer groups the organization's own orders by event
 * and downloads one statement pack. It never replaces an official receipt.
 */
const ORDER_LIMIT = 200;
const EVENT_LIMIT = 500;
const ownOrder = (store, userId, orderId) => (store.orders || []).find(order => order.id === orderId && order.clientId === userId && !isReviewData(order));

function eventView(store, userId, event, orderIds, { withOrders = false } = {}) {
  const orders = orderIds.map(orderId => ownOrder(store, userId, orderId)).filter(order => order && order.state !== 'cancelled');
  const rows = orders.map(order => ({ order, row: statementOrder(store, order) }))
    .sort((a, b) => String(a.row.closedAt || a.order.createdAt).localeCompare(String(b.row.closedAt || b.order.createdAt)) || a.order.id.localeCompare(b.order.id));
  const complete = rows.length > 0 && orders.every(isClosedOrder);
  const last = rows.length ? rows.at(-1) : null;
  return { id: event.id, name: event.name, version: event.version, status: complete ? 'complete' : 'open', orderCount: rows.length,
    totalMinor: sumMinor(orders.map(order => order.totalMinor || 0)), month: manilaDay(last ? last.row.closedAt || last.order.createdAt : event.created_at).slice(0, 7),
    createdAt: event.created_at, updatedAt: event.updated_at,
    ...(withOrders ? { orders: rows.map(({ order, row }) => ({ ...row, state: order.state, closed: isClosedOrder(order) })) } : {}) };
}
async function load(database, userId, eventId = null) {
  const events = (await database.query(`SELECT * FROM organization_events WHERE organization_user_id = $1 AND ($2::text IS NULL OR id = $2) ORDER BY created_at DESC, id`, [userId, eventId])).rows;
  const links = (await database.query('SELECT event_id, order_id FROM organization_event_orders WHERE event_id = ANY($1::text[]) ORDER BY order_id', [events.map(row => row.id)])).rows;
  return events.map(event => ({ event, orderIds: links.filter(row => row.event_id === event.id).map(row => row.order_id) }));
}
export async function eventSummaries(database, store, userId) {
  return (await load(database, userId)).map(({ event, orderIds }) => eventView(store, userId, event, orderIds));
}
function nameInput(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 120 ? name : fail(400, 'invalid_event_name');
}
async function setOrders(database, store, userId, eventId, value) {
  if (!Array.isArray(value) || value.length > ORDER_LIMIT || new Set(value).size !== value.length) fail(400, 'invalid_event_orders');
  for (const orderId of value) {
    const order = typeof orderId === 'string' ? ownOrder(store, userId, orderId) : null;
    if (!order || order.state === 'cancelled') fail(404, 'event_order_not_found', undefined, { orderId });
  }
  const taken = (await database.query('SELECT order_id FROM organization_event_orders WHERE order_id = ANY($1::text[]) AND event_id <> $2', [value, eventId])).rows;
  if (taken.length) fail(409, 'event_order_already_recorded', undefined, { orderIds: taken.map(row => row.order_id) });
  await database.query('DELETE FROM organization_event_orders WHERE event_id = $1 AND NOT (order_id = ANY($2::text[]))', [eventId, value]);
  for (const orderId of value) await database.query('INSERT INTO organization_event_orders (order_id, event_id) VALUES ($1,$2) ON CONFLICT (order_id) DO NOTHING', [orderId, eventId]);
}
function packCsv(pack) {
  const rows = [[NOTICE], ['Event', pack.title], ['Status', pack.status, 'Month', pack.month],
    ['Total spend (PHP)', statementPesos(pack.totalSpendMinor), 'Orders', pack.orderCount, 'Discount earned (PHP)', statementPesos(pack.discountEarnedMinor)],
    ['Date', 'Order ID', 'Product', 'Amount (PHP)', 'Discount earned (PHP)', 'Invoice number', 'Officer of record'],
    ...pack.orders.map(row => [row.date, row.orderId, row.product, statementPesos(row.amountMinor), statementPesos(row.organizationDiscountMinor), row.invoiceNumber, row.officerOfRecord])];
  return Buffer.from('\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
}

export async function routeOrganizationEvents({ req, url, path, store, user, input, database, at, id }) {
  const result = (body, status = 200, mutated = true) => ({ status, body, mutated });
  const record = (type, entityId, detail) => memberEvent(store, type, { id, at, actor: user, entityType: 'organization_event', entityId, organizationUserId: user.id, detail,
    staffBody: 'An organization event record was updated.' });
  if (path === '/me/organization/events' && req.method === 'GET') return result({ events: await eventSummaries(database, store, user.id) }, 200, false);
  if (path === '/me/organization/events' && req.method === 'POST') {
    const body = await input(), name = nameInput(body.name);
    const count = (await database.query('SELECT count(*)::int AS count FROM organization_events WHERE organization_user_id = $1', [user.id])).rows[0].count;
    if (count >= EVENT_LIMIT) fail(409, 'event_limit_reached');
    const eventId = id('oev');
    await database.query('INSERT INTO organization_events (id, organization_user_id, name, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)', [eventId, user.id, name, at]);
    await setOrders(database, store, user.id, eventId, body.orderIds ?? []);
    record('organization_event.created', eventId, { orderCount: (body.orderIds ?? []).length });
    const [loaded] = await load(database, user.id, eventId);
    return result({ event: eventView(store, user.id, loaded.event, loaded.orderIds, { withOrders: true }) }, 201);
  }
  const item = /^\/me\/organization\/events\/([^/]+)(\/pack)?$/.exec(path);
  if (!item) fail(404, 'not_found');
  const [found] = await load(database, user.id, decodeURIComponent(item[1]));
  if (!found) fail(404, 'organization_event_not_found');
  const view = entry => eventView(store, user.id, entry.event, entry.orderIds, { withOrders: true });
  if (item[2] && req.method === 'GET') {
    const format = url.searchParams.get('format') || 'json';
    if (!['json', 'csv', 'pdf'].includes(format)) fail(400, 'invalid_statement_format');
    const event = view(found);
    // The pack lists closed orders only, like the period statement it is built from.
    const orders = event.orders.filter(row => row.closed).map(({ state: _state, closed: _closed, ...row }) => row);
    const pack = { notice: NOTICE, currency: 'PHP', title: event.name, status: event.status, month: event.month, orderCount: orders.length,
      totalSpendMinor: sumMinor(orders.map(row => row.amountMinor)), discountEarnedMinor: sumMinor(orders.map(row => row.organizationDiscountMinor)), orders };
    if (format === 'json') return result({ pack }, 200, false);
    return { status: 200, contentType: format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8', filename: `organization-event-${event.id}.${format}`,
      bytes: format === 'pdf' ? statementPdf(pack, statementPesos) : packCsv(pack) };
  }
  if (!item[2] && req.method === 'GET') return result({ event: view(found) }, 200, false);
  if (!item[2] && req.method === 'PATCH') {
    const body = await input();
    if (body.expectedVersion !== found.event.version) fail(409, 'organization_event_stale', undefined, { currentVersion: found.event.version });
    const name = body.name === undefined ? found.event.name : nameInput(body.name);
    if (body.orderIds !== undefined) await setOrders(database, store, user.id, found.event.id, body.orderIds);
    await database.query('UPDATE organization_events SET name = $2, version = version + 1, updated_at = $3 WHERE id = $1', [found.event.id, name, at]);
    const [updated] = await load(database, user.id, found.event.id);
    record('organization_event.updated', found.event.id, { orderCount: updated.orderIds.length });
    return result({ event: view(updated) });
  }
  if (!item[2] && req.method === 'DELETE') {
    const body = await input();
    if (body.expectedVersion !== found.event.version) fail(409, 'organization_event_stale', undefined, { currentVersion: found.event.version });
    await database.query('DELETE FROM organization_events WHERE id = $1', [found.event.id]);
    record('organization_event.deleted', found.event.id, { orderCount: found.orderIds.length });
    return result({ ok: true });
  }
  fail(404, 'not_found');
}
