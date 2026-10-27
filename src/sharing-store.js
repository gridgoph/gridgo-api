const mappings = [
  ['order_share_cards', 'orderShareCards', ['order_id'], {
    order_id: 'orderId', client_id: 'clientId', first_shown_at: 'firstShownAt',
    dismissed_at: 'dismissedAt', repeat_shown_at: 'repeatShownAt', closed_at: 'closedAt',
  }],
  ['order_share_taps', 'orderShareTaps', ['client_id', 'event_id'], {
    client_id: 'clientId', event_id: 'eventId', order_id: 'orderId', action: 'action', created_at: 'createdAt',
  }, true],
  ['delivery_reminders', 'deliveryReminders', ['order_id'], {
    order_id: 'orderId', client_id: 'clientId', rider_id: 'riderId', delivered_at: 'deliveredAt',
    protocol_version: 'protocolVersion', reminded_client: 'remindedClient',
    client_agreed_to_photo: 'clientAgreedToPhoto', package_photo_file_id: 'packagePhotoFileId',
  }, true],
];
export const sharingTables = mappings.map(([name, , keys, fields, appendOnly]) => ({ name, keys, columns: Object.keys(fields), appendOnly }));
export const emptySharingStore = () => Object.fromEntries(mappings.map(([, collection]) => [collection, []]));
export function sharingRows(store, rows) {
  for (const [table, collection, , fields] of mappings) rows[table] = (store[collection] || []).map(item =>
    Object.fromEntries(Object.entries(fields).map(([sql, js]) => [sql, item[js] ?? null])));
}
export function loadSharingRows(store, rows) {
  for (const [table, collection, , fields] of mappings) store[collection] = rows[table].map(item =>
    Object.fromEntries(Object.entries(fields).map(([sql, js]) => [js, item[sql]])));
}
