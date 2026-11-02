/**
 * Row mapping for quote requests and Operations' shop replies
 * (docs/QUOTE_REQUESTS_API.md). Money and the fields queues filter on are
 * relational; the client's brief and the published option snapshots are jsonb.
 */
export const quoteRequestTables = [
  { name: 'quote_requests', keys: ['id'], columns: ['id', 'client_id', 'status', 'subcategory_code', 'quantity', 'budget_minor',
    'event_date', 'valid_until', 'version', 'created_at', 'updated_at', 'data'] },
  { name: 'quote_replies', keys: ['id'], columns: ['id', 'quote_request_id', 'supplier_id', 'status', 'price_minor', 'version',
    'created_at', 'updated_at', 'data'] },
];

const REQUEST_COLUMNS = new Set(['id', 'clientId', 'status', 'subcategoryCode', 'quantity', 'budgetMinor', 'eventDate', 'validUntil',
  'version', 'createdAt', 'updatedAt']);
const REPLY_COLUMNS = new Set(['id', 'quoteRequestId', 'supplierId', 'status', 'priceMinor', 'version', 'createdAt', 'updatedAt']);
const rest = (record, columns) => Object.fromEntries(Object.entries(record).filter(([key]) => !columns.has(key)));

function money(value, field) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value)) throw new RangeError(`${field} must be a JavaScript safe integer in minor units`);
  return value;
}

export function emptyQuoteRequestStore() {
  return { quoteRequests: [], quoteReplies: [] };
}

export function quoteRequestRows(store, rows) {
  rows.quote_requests = (store.quoteRequests || []).map(request => ({
    id: request.id, client_id: request.clientId, status: request.status, subcategory_code: request.subcategoryCode,
    quantity: request.quantity, budget_minor: money(request.budgetMinor ?? null, 'quoteRequest.budgetMinor'),
    event_date: request.eventDate ?? null, valid_until: request.validUntil ?? null, version: request.version || 1,
    created_at: request.createdAt, updated_at: request.updatedAt, data: rest(request, REQUEST_COLUMNS),
  }));
  rows.quote_replies = (store.quoteReplies || []).map(reply => ({
    id: reply.id, quote_request_id: reply.quoteRequestId, supplier_id: reply.supplierId, status: reply.status,
    price_minor: money(reply.priceMinor, 'quoteReply.priceMinor'), version: reply.version || 1,
    created_at: reply.createdAt, updated_at: reply.updatedAt, data: rest(reply, REPLY_COLUMNS),
  }));
}

export function loadQuoteRequestRows(store, rows) {
  store.quoteRequests = [...(rows.quote_requests || [])].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map(row => ({ ...(row.data || {}), id: row.id, clientId: row.client_id, status: row.status, subcategoryCode: row.subcategory_code,
      quantity: row.quantity, budgetMinor: row.budget_minor ?? null, eventDate: row.event_date ?? null, validUntil: row.valid_until ?? null,
      version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }));
  store.quoteReplies = [...(rows.quote_replies || [])].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map(row => ({ ...(row.data || {}), id: row.id, quoteRequestId: row.quote_request_id, supplierId: row.supplier_id,
      status: row.status, priceMinor: row.price_minor, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }));
}
