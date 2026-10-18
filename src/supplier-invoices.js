import { isReviewData } from './review-data.js';
import { staffError as fail, hasMembership, activeAccount } from './staff-access.js';
import { notifyAdmins } from './domain-events.js';
import { queueOrderInvalidate } from './notifications.js';

export const SUPPLIER_INVOICE_REMINDER = 'Do not put your shop invoice inside the printed products or give it to the customer. GRIDGO buys from your shop and provides the customer with its own receipt. Upload your invoice scan here and keep the paper original for collection by GRIDGO.';
const monthAt = at => new Date(Date.parse(at) + 8 * 3600000).toISOString().slice(0, 7);
const approvedSupplier = (store, user) => hasMembership(store, user, 'supplier')
  && store.approvalCases.some(row => row.userId === user.id && row.kind === 'supplier' && row.status === 'approved');
const isOps = (store, user) => hasMembership(store, user, 'ops_admin') || hasMembership(store, user, 'super_admin');
function scanFiles(store, invoice) {
  return store.files.filter(file => file.ownerId === invoice.supplierId && file.purpose === 'supplier_invoice'
    && file.state === 'ready' && file.objectKey && file.size > 0
    && (file.references || []).some(ref => ref.type === 'order' && ref.id === invoice.orderId));
}
function publicInvoice(store, invoice) {
  const scanFileIds = scanFiles(store, invoice).map(file => file.fileId).sort();
  return { ...invoice, scanFileIds, received: Boolean(invoice.submittedAt && scanFileIds.includes(invoice.fileId)),
    collected: Boolean(invoice.collectedAt) };
}
function totals(invoices) {
  const received = invoices.filter(row => row.received).length;
  const collected = invoices.filter(row => row.collected).length;
  return { expected: invoices.length, received, missing: invoices.length - received, collected, toCollect: invoices.length - collected };
}
function event(store, invoice, action, { user, at, id, audit, detail, reason }) {
  const order = store.orders.find(row => row.id === invoice.orderId);
  audit(store, { actor: user, action: `supplier_invoice.${action}`, entityType: 'supplier_invoice', entityId: invoice.orderId,
    orderId: invoice.orderId, detail, reason });
  notifyAdmins(store, `supplier_invoice_${action}`, 'Supplier invoice collection updated', order,
    `supplier-invoice:${invoice.orderId}:${action}:${invoice.version}`, { createId: id, at });
  if (order) queueOrderInvalidate(store, order, ['orders', 'jobs']);
}

/** Called inside save(), so readiness, obligation, audit and alerts commit together. */
export function syncSupplierInvoiceExpectations(store, previous, { at, id, audit }) {
  const existing = new Set(store.supplierInvoices.map(row => row.orderId));
  const before = new Map((previous?.orders || []).map(order => [order.id, order]));
  for (const order of store.orders) {
    if (existing.has(order.id) || !order.supplierId || order.state !== 'ready_for_dispatch'
      || before.get(order.id)?.state === 'ready_for_dispatch') continue;
    const expectedAt = (order.timeline || []).filter(event => event.state === 'ready_for_dispatch'
      && Number.isFinite(Date.parse(event.at))).map(event => event.at).sort((a, b) => Date.parse(a) - Date.parse(b))[0] || at;
    const invoice = { orderId: order.id, supplierId: order.supplierId, expectedAt, month: monthAt(expectedAt),
      fileId: null, number: null, date: null, amountMinor: null, submittedAt: null, updatedAt: null,
      version: 0, collectedAt: null, collectedBy: null };
    store.supplierInvoices.push(invoice);
    event(store, invoice, 'expected', { user: { role: 'system' }, at, id, audit,
      detail: { supplierId: invoice.supplierId, expectedAt, month: invoice.month } });
  }
}
function validateDetails(body) {
  if (typeof body.number !== 'string' || !body.number.trim() || body.number.trim().length > 100 || /[\x00-\x1f\x7f]/.test(body.number)) fail(400, 'invalid_invoice_number');
  if (typeof body.date !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(body.date)
    || !Number.isFinite(Date.parse(`${body.date}T00:00:00Z`))
    || new Date(`${body.date}T00:00:00Z`).toISOString().slice(0, 10) !== body.date) fail(400, 'invalid_invoice_date');
  if (!Number.isSafeInteger(body.amountMinor) || body.amountMinor < 0) fail(400, 'invalid_invoice_amount');
  if (typeof body.fileId !== 'string' || !body.fileId) fail(400, 'invalid_invoice_file');
  return { fileId: body.fileId, number: body.number.trim(), date: body.date, amountMinor: body.amountMinor };
}
function checkVersion(body, invoice) {
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) fail(400, 'expected_version_required');
  if (body.expectedVersion !== invoice.version) fail(409, 'supplier_invoice_version_conflict');
}

export async function routeSupplierInvoices({ req, url, store, user, readBody, now, id, audit, storage }) {
  const path = url.pathname;
  const match = path.match(/^\/(me|ops\/finance)\/supplier-invoices(?:\/([^/]+)(\/collect)?)?$/);
  if (!match) return null;
  if (!user) fail(401, 'unauthorized');
  if (!activeAccount(user)) fail(403, 'forbidden');
  const staff = match[1] === 'ops/finance';
  if (staff ? !isOps(store, user) : !approvedSupplier(store, user)) fail(403, 'forbidden');
  const response = (invoice, mutated = false) => ({ status: 200, body: { invoice: publicInvoice(store, invoice), reminder: SUPPLIER_INVOICE_REMINDER }, mutated });
  if (!match[2] && req.method === 'GET') {
    const month = url.searchParams.get('month');
    if (!month || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) fail(400, 'invalid_month');
    const supplierId = staff ? url.searchParams.get('supplierId') : user.id;
    const limitValue = url.searchParams.get('limit') || '50';
    if (!/^\d+$/.test(limitValue) || Number(limitValue) < 1 || Number(limitValue) > 100) fail(400, 'invalid_limit');
    const limit = Number(limitValue), after = url.searchParams.get('after');
    const invoices = store.supplierInvoices.filter(row => !isReviewData(store.orders.find(o => o.id === row.orderId)) && row.month === month && (!supplierId || row.supplierId === supplierId))
      .map(row => publicInvoice(store, row)).sort((a, b) => a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0);
    const shops = [...new Set(invoices.map(row => row.supplierId))].sort().map(id => ({ supplierId: id,
      shopName: store.supplierProfiles.find(row => row.userId === id)?.shopName || store.users.find(row => row.id === id)?.name || '',
      ...totals(invoices.filter(row => row.supplierId === id)) }));
    const remaining = invoices.filter(row => !after || row.orderId > after), page = remaining.slice(0, limit);
    return { status: 200, body: { month, reminder: SUPPLIER_INVOICE_REMINDER, totals: totals(invoices), shops,
      invoices: page, nextCursor: remaining.length > limit ? page.at(-1).orderId : null } };
  }
  const invoice = store.supplierInvoices.find(row => row.orderId === match[2]);
  // An owning shop can distinguish an order not ready yet; other shops cannot.
  const order = store.orders.find(row => row.id === match[2]);
  if (!staff && (invoice?.supplierId || order?.supplierId) !== user.id) fail(403, 'forbidden');
  if (!invoice) fail(409, 'supplier_invoice_not_expected');
  if (req.method === 'GET' && !match[3]) return response(invoice);
  if (!(req.method === 'PUT' && !staff && !match[3]) && !(req.method === 'POST' && staff && match[3])) return null;
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_body');
  const at = now();
  if (req.method === 'PUT') {
    const details = validateDetails(body);
    const same = invoice.submittedAt && Object.entries(details).every(([key, value]) => invoice[key] === value);
    if (same) return response(invoice);
    if (invoice.collectedAt) fail(409, 'supplier_invoice_collected');
    checkVersion(body, invoice);
    const file = scanFiles(store, invoice).find(file => file.fileId === details.fileId);
    if (!file) fail(409, 'supplier_invoice_scan_required');
    const stat = await storage.statObject(file.objectKey);
    if (stat.size !== file.size) fail(409, 'storage_object_mismatch');
    const previous = invoice.submittedAt ? { fileId: invoice.fileId, number: invoice.number, date: invoice.date, amountMinor: invoice.amountMinor } : null;
    let reason = null;
    if (previous) {
      if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 1000) fail(400, 'reason_required');
      reason = body.reason.trim();
    }
    Object.assign(invoice, details, { submittedAt: invoice.submittedAt || at, updatedAt: at, version: invoice.version + 1 });
    event(store, invoice, previous ? 'corrected' : 'submitted', { user, at, id, audit, detail: { previous, current: details }, reason });
  } else {
    if (invoice.collectedAt) return response(invoice);
    checkVersion(body, invoice);
    if (!publicInvoice(store, invoice).received) fail(409, 'supplier_invoice_scan_required');
    Object.assign(invoice, { collectedAt: at, collectedBy: user.id, updatedAt: at, version: invoice.version + 1 });
    event(store, invoice, 'collected', { user, at, id, audit, detail: { fileId: invoice.fileId, number: invoice.number } });
  }
  return response(invoice, true);
}
