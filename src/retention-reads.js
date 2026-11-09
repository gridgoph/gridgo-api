import { attachOrderRemovalContext } from './order-removal.js';

const unique = values => [...new Set(values.filter(Boolean))];
/** Read-only retention report. Inverse links are deliberately conservative:
 * policy recursively tests stored values, including legacy links absent from
 * file_references. No deletion uses this graph; execution still reloads under
 * the domain lock and repeats the complete policy/hold checks.
 */
export async function readRetentionGraph(database, graph, actorIds) {
  const { loaded, read } = graph;
  await read('files', `WHERE state IN ('ready','pending_upload','delete_pending') AND purpose<>'legal_document'
    AND NOT (purpose IN ('artwork','mockup') AND COALESCE(data->>'savedAt','')<>'')`);
  const files = loaded.files.map(r => r.file_id), owners = loaded.files.filter(r => r.purpose.endsWith('verification_document')).map(r => r.owner_id);
  await read('file_references', 'WHERE file_id = ANY($1::text[])', [files]);
  const refs = loaded.file_references;
  const referenceIds = type => refs.filter(r => r.reference_type === type).map(r => r.reference_id);
  const inverse = table => `jsonb_path_exists(to_jsonb(${table}), '$.** ? (@ == $ids[*])', jsonb_build_object('ids',$1::text[]))`;
  const cases = [['refund_requests','refund_request'], ['issues','issue'], ['claims','claim'], ['escalations','escalation']];
  for (const [table,type] of cases) await read(table, `WHERE ${inverse(table)} OR id = ANY($2::text[])`, [files,referenceIds(type)]);
  for (const table of ['order_payments','payout_milestones','platform_revenue_adjustments','order_line_items','order_jobs','refund_payments','refund_attempts','refund_supplier_payouts']) await read(table, `WHERE ${inverse(table)}`, [files]);
  // Attempts/payments reference requests, not orders.
  const requestIds = unique([...loaded.refund_requests.map(r => r.id), ...loaded.refund_payments.map(r => r.request_id), ...loaded.refund_attempts.map(r => r.request_id)]);
  await read('refund_requests', 'WHERE id = ANY($1::text[])', [requestIds]);
  const orderIds = unique([...referenceIds('order'), ...refs.map(r => r.data?.orderId),
    ...cases.flatMap(([table]) => loaded[table].map(r => r.order_id)),
    ...['order_payments','payout_milestones','platform_revenue_adjustments','order_line_items','order_jobs','refund_supplier_payouts'].flatMap(table => loaded[table].map(r => r.order_id))]);
  await read('orders', `WHERE ${inverse('orders')} OR id = ANY($2::text[])
    OR ((client_id = ANY($3::text[]) OR supplier_id = ANY($3::text[]) OR rider_id = ANY($3::text[])) AND (
      EXISTS (SELECT 1 FROM claims c WHERE c.order_id=orders.id AND c.status NOT IN ('released','resolved'))
      OR EXISTS (SELECT 1 FROM issues c WHERE c.order_id=orders.id AND c.status NOT IN ('resolved','dismissed'))
      OR EXISTS (SELECT 1 FROM refund_requests c WHERE c.order_id=orders.id AND c.status NOT IN ('paid','rejected','withdrawn'))
      OR EXISTS (SELECT 1 FROM escalations c WHERE c.order_id=orders.id AND c.status NOT IN ('resolved','dismissed'))))`, [files,orderIds,owners]);
  const orders = loaded.orders.map(r => r.id);
  for (const table of ['order_line_items','order_jobs','order_payments','payout_milestones',...cases.map(([table]) => table)]) {
    // Retain inverse matches without a parent: policy treats unresolved links as holds.
    const previous = loaded[table];
    await read(table, 'WHERE order_id = ANY($1::text[])', [orders]);
    const seen = new Set(loaded[table].map(r => r.id));
    loaded[table].push(...previous.filter(r => !seen.has(r.id)));
  }
  for (const table of ['users','supplier_services','supplier_payout_accounts','approval_cases']) {
    const ownerColumn = table === 'users' ? 'id' : table === 'supplier_services' || table === 'supplier_payout_accounts' ? 'supplier_id' : 'user_id';
    await read(table, `WHERE ${inverse(table)} OR ${ownerColumn} = ANY($2::text[])`, [files,unique([...actorIds,...owners])]);
  }
  await read('supplier_catalog_item_photos', 'WHERE file_id = ANY($1::text[])', [files]);
  await read('supplier_shop_media', 'WHERE file_id = ANY($1::text[])', [files]);
  await read('rider_documents', 'WHERE file_id = ANY($1::text[])', [files]);
  await read('client_cart_lines', `WHERE ${inverse('client_cart_lines')}`, [files]);
  await read('client_carts', 'WHERE id = ANY($1::text[])', [loaded.client_cart_lines.map(r => r.cart_id)]);
  await read('platform_settings', 'WHERE singleton');
  const imagePatterns = loaded.files.filter(r => r.purpose === 'announcement_image').map(r => `%/public/announcement-images/${r.file_id}%`);
  const images = imagePatterns.length ? (await database.query(`SELECT DISTINCT data->>'imageUrl' AS url FROM notifications
    WHERE data->>'imageUrl' IS NOT NULL AND data->>'imageUrl' LIKE ANY($1::text[])`, [imagePatterns])).rows : [];
  const store = graph.finish();
  store.notifications = images.map(row => ({ imageUrl: row.url }));
  await attachOrderRemovalContext(database, store, { retention: true });
  return store;
}
