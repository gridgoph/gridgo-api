export const performanceTable = { name: 'supplier_performance_events', keys: ['id'], appendOnly: true,
  columns: ['id', 'order_id', 'supplier_id', 'kind', 'source_key', 'occurred_at', 'recorded_at', 'data'] };
export function performanceRows(store, rows) {
  rows.supplier_performance_events = (store.supplierPerformanceEvents || []).map(event => {
    const { id, orderId, supplierId, kind, sourceKey, at, recordedAt, ...data } = event;
    return { id, order_id: orderId, supplier_id: supplierId, kind, source_key: sourceKey, occurred_at: at, recorded_at: recordedAt, data };
  });
}
export function loadPerformanceRows(store, rows) {
  store.supplierPerformanceEvents = rows.supplier_performance_events.map(row => ({ ...row.data,
    id: row.id, orderId: row.order_id, supplierId: row.supplier_id, kind: row.kind, sourceKey: row.source_key,
    at: row.occurred_at, recordedAt: row.recorded_at }));
}
