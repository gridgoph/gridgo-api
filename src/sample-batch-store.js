// Sample First batch drafts (docs/SAMPLE_FIRST_API.md). Keys, links, status and
// the hold clock are relational; the intended batch, the held pricing rules and
// the client's decision are immutable JSON documents.
const fields = {
  id: 'id', client_id: 'clientId', supplier_id: 'supplierId', catalog_item_id: 'catalogItemId',
  sample_order_id: 'sampleOrderId', batch_order_id: 'batchOrderId', previous_draft_id: 'previousDraftId',
  status: 'status', hold_days: 'holdDays', sample_delivered_at: 'sampleDeliveredAt', held_until: 'heldUntil',
  batch: 'batch', held_pricing: 'heldPricing', approval: 'approval', rejection: 'rejection',
  version: 'version', created_at: 'createdAt', updated_at: 'updatedAt',
};
export const sampleBatchTable = { name: 'sample_batch_drafts', keys: ['id'], columns: Object.keys(fields) };

export function sampleBatchRows(store, rows) {
  rows.sample_batch_drafts = (store.sampleBatchDrafts || []).map(draft => Object.fromEntries(
    Object.entries(fields).map(([sql, js]) => [sql, draft[js] ?? (js === 'version' ? 1 : null)])));
}

export function loadSampleBatchRows(store, rows) {
  store.sampleBatchDrafts = (rows.sample_batch_drafts || []).map(row => Object.fromEntries(
    Object.entries(fields).map(([sql, js]) => [js, row[sql] ?? null])));
}
