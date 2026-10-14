// Explicit columns keep invoice money and monthly collection queries relational.
const fields = { order_id: 'orderId', supplier_id: 'supplierId', expected_at: 'expectedAt', month: 'month',
  file_id: 'fileId', number: 'number', invoice_date: 'date', amount_minor: 'amountMinor', submitted_at: 'submittedAt',
  updated_at: 'updatedAt', version: 'version', collected_at: 'collectedAt', collected_by: 'collectedBy' };
export const supplierInvoiceTable = { name: 'supplier_invoices', keys: ['order_id'], columns: Object.keys(fields) };
export function supplierInvoiceRows(store, rows) {
  rows.supplier_invoices = (store.supplierInvoices || []).map(item => Object.fromEntries(
    Object.entries(fields).map(([sql, js]) => [sql, item[js] ?? (js === 'version' ? 0 : null)])));
}
export function loadSupplierInvoiceRows(store, rows) {
  store.supplierInvoices = rows.supplier_invoices.map(item => Object.fromEntries(
    Object.entries(fields).map(([sql, js]) => [js, item[sql]])));
}
