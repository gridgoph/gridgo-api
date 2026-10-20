const mappings = [
  ['tester_invite_codes', 'testerInviteCodes', ['client_id'], { client_id: 'clientId', code: 'code', created_at: 'createdAt' }, true],
  ['tester_installations', 'testerInstallations', ['client_id', 'installation_id'], { client_id: 'clientId', installation_id: 'installationId', created_at: 'createdAt' }, true],
  ['tester_tracking', 'testerTracking', ['client_id', 'order_id'], { client_id: 'clientId', order_id: 'orderId', created_at: 'createdAt' }, true],
  ['tester_invites', 'testerInvites', ['id'], { id: 'id', inviter_id: 'inviterId', code: 'code', email: 'email', client_id: 'clientId', created_at: 'createdAt', matched_at: 'matchedAt', completed_at: 'completedAt', unmatched_reason: 'unmatchedReason' }],
  ['tester_rewards', 'testerRewards', ['id'], { id: 'id', kind: 'kind', client_id: 'clientId', inviter_id: 'inviterId', invite_id: 'inviteId', amount_minor: 'amountMinor', status: 'status', created_at: 'createdAt', issued_at: 'issuedAt', voided_at: 'voidedAt', voucher_id: 'voucherId', inviter_voucher_id: 'inviterVoucherId', reason: 'reason', checks: 'checks', evidence: 'evidence' }],
];
export const testerProgramTables = mappings.map(([name, , keys, fields, appendOnly]) => ({ name, keys, columns: Object.keys(fields), appendOnly }));
export const emptyTesterProgram = () => Object.fromEntries(mappings.map(([, collection]) => [collection, []]));
export function testerProgramRows(store, rows) {
  for (const [table, collection, , fields] of mappings) rows[table] = (store[collection] || []).map(item => Object.fromEntries(Object.entries(fields).map(([sql, js]) => [sql, item[js] ?? null])));
}
export function loadTesterProgramRows(store, rows) {
  for (const [table, collection, , fields] of mappings) store[collection] = rows[table].map(item => Object.fromEntries(Object.entries(fields).map(([sql, js]) => [js, item[sql]])));
}
