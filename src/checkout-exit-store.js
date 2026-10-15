const visitFields = { cart_id: 'cartId', client_id: 'clientId', first_reached_at: 'firstReachedAt', last_reached_at: 'lastReachedAt',
  cart_total_minor: 'cartTotalMinor', category_codes: 'categoryCodes' };
const promptFields = { id: 'id', client_id: 'clientId', cart_id: 'cartId', reached_at: 'reachedAt', asked_at: 'askedAt',
  cart_total_minor: 'cartTotalMinor', category_codes: 'categoryCodes', answered_at: 'answeredAt', skipped_at: 'skippedAt',
  reason: 'reason', other_text: 'otherText' };
export const checkoutExitTables = [
  { name: 'checkout_visits', keys: ['cart_id'], columns: Object.keys(visitFields) },
  { name: 'checkout_exit_prompts', keys: ['id'], columns: Object.keys(promptFields) },
];
const toRow = (fields, item) => Object.fromEntries(Object.entries(fields).map(([sql, js]) => [sql,
  js === 'categoryCodes' ? JSON.stringify(item[js] || []) : item[js] ?? null]));
const fromRow = (fields, row) => Object.fromEntries(Object.entries(fields).map(([sql, js]) => [js, row[sql]]));
export function checkoutExitRows(store, rows) {
  rows.checkout_visits = (store.checkoutVisits || []).map(item => toRow(visitFields, item));
  rows.checkout_exit_prompts = (store.checkoutExitPrompts || []).map(item => toRow(promptFields, item));
}
export function loadCheckoutExitRows(store, rows) {
  store.checkoutVisits = rows.checkout_visits.map(row => fromRow(visitFields, row));
  store.checkoutExitPrompts = rows.checkout_exit_prompts.map(row => fromRow(promptFields, row));
}
