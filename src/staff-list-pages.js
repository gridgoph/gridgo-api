// Opt-in only. Legacy callers keep their complete response and ordering.
export const STAFF_LIST_PAGE = Symbol('staff list page');
export const staffPageRequested = params => params.has('limit') || params.has('cursor');
const time = column => `date_trunc('milliseconds', ${column} AT TIME ZONE 'UTC')`;
const plans = {
  '/admin/shop-rankings': ['supplier_profiles','user_id','rank',null,'rows','supplierId'],
  '/ops/shops/:id/performance': ['supplier_performance_events', 'id', time('occurred_at'), 'at', 'performance.events', 'id'],
  '/orders': ['orders', 'id', time('created_at'), 'createdAt', 'orders', 'id'],
  '/baskets': ['order_baskets', 'id', time('created_at'), 'createdAt', 'baskets', 'id'],
  '/issues': ['issues', 'id', time('created_at'), 'createdAt', 'issues', 'id'],
  '/credits/balance': ['credit_ledger', 'id', time('created_at'), 'createdAt', 'ledger', 'id'],
  '/admin/staff': ['staff_profiles', 'user_id', time('updated_at'), 'updatedAt', 'staff', 'userId'],
  '/admin/staff/invites': ['staff_invites', 'id', time('created_at'), 'createdAt', 'invites', 'id'],
  '/admin/staff/roles': ['staff_roles', 'code', null, null, 'roles', 'code'],
  '/admin/voucher-campaigns': ['voucher_campaigns', 'id', time('created_at'), 'createdAt', 'campaigns', 'id'],
  '/ops/vouchers': ['vouchers', 'id', time('issued_at'), 'issuedAt', 'vouchers', 'id'],
  '/ops/hub/escalations': ['orders', 'id', 'position', null, 'escalations', 'orderId'],
  '/ops/hub/unclaimed': ['orders', 'id', 'position', null, 'orders', 'orderId'],
  '/supplier-services': ['supplier_services', 'id', 'position', null, 'services', 'id'],
  '/ops/shops/hours': ['supplier_profiles', 'user_id', null, null, 'shops', 'supplierId'],
  '/ops/reschedule-requests': ['orders', 'id', `(data#>>'{rescheduleRequest,requestedAt}') COLLATE "C"`, 'requestedAt', 'requests', 'orderId'],
  '/refund-requests': ['refund_requests', 'id', null, null, 'refunds', 'id'],
  '/users': ['users', 'id', null, null, 'users', 'id'],
  '/claims': ['claims', 'id', time('created_at'), 'createdAt', 'claims', 'id'],
  '/escalations': ['escalations', 'id', time('created_at'), 'createdAt', 'escalations', 'id'],
  '/ops/shops/performance': ['supplier_profiles', 'user_id', null, null, 'shops', 'supplierId'],
  '/admin/season-windows': ['season_windows', 'id', null, null, 'windows', 'id'],
  '/users/:id/production-lapses': ['production_lapses', 'id', time('detected_at'), 'detectedAt', 'lapses', 'id'],
};
const fail = code => { throw Object.assign(new Error(code), { status: 400, code }); };
export function staffListPlan(path, params = new URLSearchParams()) {
  if (path === '/admin/promotions') {
    const section=params.get('section') || 'claims';
    if (!['claims','invites'].includes(section)) return null;
    const [table,id,sort,field,collection,publicId] = section === 'claims'
      ? ['vouchers','id',time('issued_at'),'claimedAt','founding.claims','voucherId']
      : ['promotion_invites','id',time('created_at'),'createdAt','friendPass.invites','id'];
    return { table,id,sort,field,collection,publicId,ascending:false,section };
  }
  const key = /^\/ops\/shops\/[^/]+\/performance$/.test(path) ? '/ops/shops/:id/performance' : /^\/users\/[^/]+\/production-lapses$/.test(path) ? '/users/:id/production-lapses' : path;
  const row = plans[key];
  if (!row) return null;
  const [table, id, sort, field, collection, publicId] = row;
  return { table, id, sort, field, collection, publicId, ascending: sort === 'position',
    // Keep new page indexes unavailable to the legacy basket enumeration.
    predicate: table === 'order_baskets' ? 'length(id) >= 0' : null };
}
export function parseStaffPage(path, params) {
  const plan = staffListPlan(path, params);
  if (!staffPageRequested(params)) return null;
  if (!plan && path === '/admin/promotions') fail('invalid_section');
  if (!plan) return null;
  const limit = params.has('limit') ? Number(params.get('limit')) : 50;
  if (!/^\d+$/.test(params.get('limit') ?? '50') || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail('invalid_limit');
  // Bind a cursor to its route and filters; a different limit is safe.
  const scope = JSON.stringify([...params].filter(([k]) => !['limit', 'cursor'].includes(k)).sort(([a], [b]) => a.localeCompare(b)));
  let cursor = null;
  if (params.has('cursor')) {
    const encoded = params.get('cursor');
    try {
      if (!encoded || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) fail('invalid_cursor');
      cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      if (cursor.v !== 1 || cursor.path !== path || cursor.scope !== scope
        || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 512 || cursor.id.includes('\0')
        || (plan.sort && (plan.ascending ? !Number.isInteger(cursor.k) || cursor.k < 0 || cursor.k > 2147483647 : typeof cursor.k !== 'string' || !cursor.k || cursor.k.includes('\0')))
        || (plan.field && !['requestedAt'].includes(plan.field) && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cursor.k)
          || cursor.k.startsWith('0000-') || !Number.isFinite(Date.parse(cursor.k)) || new Date(cursor.k).toISOString() !== cursor.k))) fail('invalid_cursor');
    } catch { fail('invalid_cursor'); }
  }
  return { ...plan, path, scope, limit, cursor };
}
export const encodeStaffCursor = (page, id, k) => Buffer.from(JSON.stringify({ v: 1, path: page.path, scope: page.scope, id, ...(page.sort ? { k } : {}) })).toString('base64url');

/** Select a bounded keyset before hydrating any child/identity graph. `where`
 * includes the complete caller/filter scope; identifiers are static plans.
 */
export async function readStaffPage(graph, path, params, where = '', values = []) {
  const table = staffListPlan(path,params)?.table || (path === '/admin/promotions' ? 'vouchers' : null);
  if (!table) throw new Error('Unsupported staff list page');
  let page;
  try { page = parseStaffPage(path, params); } catch (error) {
    graph.staffPage = { error };
    await graph.read(table, 'LIMIT 0');
    return;
  }
  if (!page) {
    return graph.read(table, where, values);
  }
  if (page.predicate) where += `${where ? ' AND' : 'WHERE'} ${page.predicate}`;
  const args = [...values], bind = value => { args.push(value); return `$${args.length}`; };
  const id = `${page.id} COLLATE "C"`;
  let boundary = '';
  if (page.cursor) {
    const cursorId = bind(page.cursor.id);
    if (page.sort) {
      const k = bind(page.cursor.k);
      boundary = `(${page.sort}, ${id}) ${page.ascending ? '>' : '<'} (${k}, ${cursorId})`;
    } else boundary = `${id} > ${cursorId}`;
  }
  const key = page.field && page.field !== 'requestedAt' ? `(${page.sort}) AT TIME ZONE 'UTC'` : page.sort;
  await graph.read(page.table, `${where}${boundary ? `${where ? ' AND' : 'WHERE'} ${boundary}` : ''}
    ORDER BY ${page.sort ? `${page.sort} ${page.ascending ? 'ASC' : 'DESC'},` : ''} ${id} ${page.sort && !page.ascending ? 'DESC' : 'ASC'} LIMIT ${bind(page.limit + 1)}`, args,
    { select: [page.id, ...(key ? [`${key} AS staff_page_key`] : [])] });
  const rows = graph.loaded[page.table], selected = rows.slice(0, page.limit), last = selected.at(-1);
  graph.staffPage = { ids: selected.map(row => row[page.id]), nextCursor: rows.length > page.limit ? encodeStaffCursor(page, last[page.id], last.staff_page_key) : null };
  // Hydrate only selected parents, in the same repeatable-read snapshot. The
  // key query never sorts/transfers wide order JSON or private invitation data.
  if (selected.length) await graph.read(page.table, `WHERE ${page.id} = ANY($1::text[])`, [graph.staffPage.ids]);
  else graph.loaded[page.table] = [];
}

/** The existing handler still authorizes and projects every field. The page
 * metadata only orders those projections and adds the staff desk nextCursor.
 */
export function staffPageBody(store, url, body) {
  const page = parseStaffPage(url.pathname, url.searchParams);
  if (!page) return body;
  const selected = store[STAFF_LIST_PAGE];
  if (selected?.error) throw selected.error;
  if (!selected) throw new Error('Staff list page was not selected');
  const keys=page.collection.split('.'), parent=keys.length>1 ? body[keys[0]] : body, name=keys.at(-1);
  const byId = new Map(parent[name].map(row => [row[page.publicId], row]));
  const rows=selected.ids.map(id => byId.get(id)).filter(Boolean);
  return { ...body, ...(keys.length>1 ? { [keys[0]]: { ...parent, [name]: rows } } : { [name]: rows }), nextCursor: selected.nextCursor };
}
