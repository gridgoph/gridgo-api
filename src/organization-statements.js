import { identityHasMembership } from './authorization-context.js';
import { approvedOrganization, organizationMoneyError } from './organization-money.js';
import { statementPdf } from './statement-pdf.js';

const NOTICE = 'Not a tax document. Official receipts are issued separately.';
const fail = (code, message, status) => { throw organizationMoneyError(code, message, status); };
const day = (date) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
function parseDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().slice(0, 10) !== value) fail('invalid_statement_period', 'Use valid YYYY-MM-DD dates.');
  return Date.parse(`${value}T00:00:00+08:00`);
}
function periodFor(params, now) {
  let from = params.get('from'), to = params.get('to');
  const period = params.get('period');
  if (from || to) {
    if (period && period !== 'custom') fail('invalid_statement_period', 'Choose a preset or custom dates.');
  } else {
    if (period && !['this_month', 'this_quarter'].includes(period)) fail('invalid_statement_period', 'Choose this_month, this_quarter or custom dates.');
    const current = day(new Date(now));
    const year = Number(current.slice(0, 4)), month = Number(current.slice(5, 7));
    const start = period === 'this_quarter' ? Math.floor((month - 1) / 3) * 3 + 1 : month;
    from = `${year}-${String(start).padStart(2, '0')}-01`;
    to = new Date(Date.UTC(year, start - 1 + (period === 'this_quarter' ? 3 : 1), 0)).toISOString().slice(0, 10);
  }
  const start = parseDay(from), end = parseDay(to) + 86400000;
  if (end <= start || end - start > 366 * 86400000) fail('invalid_statement_period', 'Select at most 366 days in chronological order.');
  return { from, to, timezone: 'Asia/Manila', start, end };
}
function safeSum(values) {
  let total = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid_statement_money', 'An order has invalid statement money.', 409);
    total += BigInt(value);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail('statement_total_too_large', 'Select a shorter period.', 409);
  return Number(total);
}
export const statementPesos = (minor) => `${BigInt(minor) / 100n}.${String(BigInt(minor) % 100n).padStart(2, '0')}`;
function closedAt(order) {
  // The first completed transition is stable when payout or other metadata changes later.
  const events = (order.timeline || []).filter((entry) => ['completed', 'payout_released'].includes(entry.state) && Number.isFinite(Date.parse(entry.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events[0]?.at || order.closedAt || order.completedAt || null;
}
function officerFor(order, invoice) {
  // #164 owns the immutable order/receipt snapshot. Never use today's profile officer.
  const value = order.officerOfRecord ?? invoice?.officerOfRecord;
  return typeof value === 'string' ? value : typeof value?.name === 'string' ? value.name : '';
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function csv(statement) {
  const rows = [[NOTICE], ['Period start', statement.period.from, 'Period end', statement.period.to, 'Timezone', 'Asia/Manila'],
    ['Total spend (PHP)', statementPesos(statement.totalSpendMinor), 'Orders', statement.orderCount, 'Discount earned (PHP)', statementPesos(statement.discountEarnedMinor)],
    ['Date', 'Order ID', 'Product', 'Amount (PHP)', 'Discount earned (PHP)', 'Invoice number', 'Officer of record'],
    ...statement.orders.map((row) => [row.date, row.orderId, row.product, statementPesos(row.amountMinor), statementPesos(row.organizationDiscountMinor), row.invoiceNumber, row.officerOfRecord])];
  return Buffer.from('\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
}
export function routeOrganizationStatements({ req, url, store, user, now }) {
  const own = url.pathname === '/me/organization/statements';
  const staffRoute = /^\/ops\/organizations\/([^/]+)\/statements$/.exec(url.pathname);
  if (!own && !staffRoute) return null;
  if (!user) fail('unauthorized', 'Sign in to view statements.', 401);
  if (req.method !== 'GET') fail('not_found', 'Route not found.', 404);
  const staff = ['ops_admin', 'super_admin'].some((role) => identityHasMembership(user, role));
  if (own ? !identityHasMembership(user, 'client') : !staff) fail('forbidden', 'This account cannot access these statements.', 403);
  const clientId = own ? user.id : decodeURIComponent(staffRoute[1]);
  if (!approvedOrganization(store, clientId)) fail('organization_approval_required', 'Statements require an Operations-approved organization.', 403);
  const period = periodFor(url.searchParams, now());
  const format = url.searchParams.get('format') || 'json';
  if (!['json', 'csv', 'pdf'].includes(format)) fail('invalid_statement_format', 'Choose json, pdf or csv.');
  const orders = (store.orders || []).filter((order) => order.clientId === clientId && ['completed', 'payout_released'].includes(order.state))
    .flatMap((order) => {
      const at = closedAt(order), time = Date.parse(at);
      if (!Number.isFinite(time) || time < period.start || time >= period.end) return [];
      const invoice = (store.orderInvoices || []).find((row) => row.orderId === order.id)?.snapshot;
      return [{ date: day(new Date(time)), closedAt: at, orderId: order.id,
        product: (store.orderLineItems || []).filter((row) => row.orderId === order.id).map((row) => row.itemNameSnapshot || '').filter(Boolean).join('; ') || order.productName || '',
        amountMinor: order.totalMinor, organizationDiscountMinor: order.organizationDiscountMinor ?? 0,
        invoiceNumber: order.invoiceNumber || invoice?.invoiceNumber || '', officerOfRecord: officerFor(order, invoice) }];
    }).sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt) || a.orderId.localeCompare(b.orderId));
  const statement = { notice: NOTICE, currency: 'PHP', period: { from: period.from, to: period.to, timezone: period.timezone },
    orderCount: orders.length, totalSpendMinor: safeSum(orders.map((row) => row.amountMinor)),
    discountEarnedMinor: safeSum(orders.map((row) => row.organizationDiscountMinor)), orders };
  if (format === 'json') return { status: 200, body: { statement } };
  return { status: 200, contentType: format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8',
    filename: `organization-statement-${period.from}-${period.to}.${format}`,
    bytes: format === 'pdf' ? statementPdf(statement, statementPesos) : csv(statement) };
}
