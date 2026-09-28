// Relational compatibility adapter: JSON is limited to destination/evidence snapshots.
export const REFUND_TABLES = [
  ['refund_requests', 'refundRequests', false, ['id', 'orderId', 'clientId', 'policyVersion', 'status', 'version', 'kind', 'reason', 'beforeProduction', 'late', 'filingDeadlineAt', 'orderStateAtFiling', 'evidenceFileIds', 'destination', 'createdAt', 'updatedAt']],
  ['refund_settlements', 'refundSettlements', true, ['id', 'requestId', 'orderId', 'sequence', 'createdBy', 'createdAt', 'reason', 'shopAgreement', 'deliveryEvidence', 'disposition', 'shopEntitlementMinor', 'riderEntitlementMinor', 'principalMinor', 'feeMinor', 'deliveryMinor', 'platformDeliveryMinor', 'totalMinor', 'snapshot']],
  ['refund_supplier_payouts', 'refundSupplierPayouts', false, ['id', 'settlementId', 'orderId', 'supplierId', 'amountMinor', 'status', 'reference', 'receiptFileId', 'releasedAt', 'releasedBy', 'createdAt']],
  ['refund_attempts', 'refundAttempts', false, ['id', 'requestId', 'settlementId', 'payerId', 'status', 'destination', 'amountMinor', 'provider', 'sourceWallet', 'createdAt', 'updatedAt']],
  ['refund_payments', 'refundPayments', true, ['id', 'requestId', 'attemptId', 'provider', 'sourceWallet', 'reference', 'receiptFileId', 'amountMinor', 'paidAt', 'recordedBy', 'createdAt']],
  ['refund_events', 'refundEvents', true, ['id', 'requestId', 'requestVersion', 'actorId', 'kind', 'reason', 'createdAt', 'data']],
  ['refund_commands', 'refundCommands', true, ['id', 'actorId', 'requestKey', 'route', 'bodyHash', 'response', 'createdAt']],
];

const column = (field) => field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
export const refundTableDefinitions = REFUND_TABLES.map(([name, , appendOnly, fields]) =>
  ({ name, keys: ['id'], columns: fields.map(column), appendOnly }));

export function writeRefundRows(store, rows) {
  for (const [table, collection, , fields] of REFUND_TABLES) {
    rows[table] = (store[collection] || []).map((record) => Object.fromEntries(fields.map((field) => {
      const value = record[field] ?? null;
      if (field.endsWith('Minor') && !Number.isSafeInteger(value)) throw new RangeError(`${field} must be safe integer centavos`);
      return [column(field), field === 'evidenceFileIds' ? JSON.stringify(value) : value];
    })));
  }
}

export function readRefundRows(store, rows) {
  for (const [table, collection, , fields] of REFUND_TABLES) {
    store[collection] = rows[table].map((row) => Object.fromEntries(fields.map((field) => [field, row[column(field)]])))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
}
