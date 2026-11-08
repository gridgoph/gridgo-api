import { assignmentTime } from './rider-tracking.js';
import { identityHasMembership, selectActorRole } from './authorization-context.js';
import { isTestOperationsUser } from './test-operations.js';
import { encodeCatalogListCursor } from './supplier-catalog.js';
import { foundingTesterEligible } from './founding-testers.js';
import { bugReportRewardAvailable } from './bug-report-rewards.js';
import { pricingRanges, PRICE_BRACKETS } from './pricing-dashboard.js';
import { readRetentionGraph } from './retention-reads.js';
import { activeOrderSql } from './order-removal.js';

// Exact GET registrations only: writes retain the complete transactional adapter.
const DESKS = new Set(['/credits/balance','/ops/catalog-items', '/approval-cases', '/supplier-services', '/supplier-payment-terms',
  '/ops/shops/hours', '/ops/shops/performance', '/ops/riders/locations', '/ops/special-instructions', '/ops/reschedule-requests',
  '/ops/hub', '/ops/hub/escalations', '/ops/hub/unclaimed', '/ops/hub/handouts', '/ops/hub/receipt-scans',
  '/staff/me', '/staff/hub', '/staff/hub/handouts', '/admin/staff', '/admin/staff/roles', '/admin/staff/invites',
  '/ops/organizations', '/ops/vouchers', '/admin/voucher-campaigns', '/admin/voucher-redemptions', '/admin/promotions',
  '/ops/tester-invites', '/ops/tester-rewards', '/admin/featured-prints', '/admin/season-windows', '/admin/season-windows/push-settings', '/ops/founding-testers', '/admin/survey-responses', '/admin/pricing-feedback', '/admin/checkout-exit-feedback',
  '/admin/files/retention', '/admin/shop-rankings', '/admin/pricing', '/ops/push/stats', '/ops/account-deletion-requests', '/ops/issue-reports',
  '/admin/legal/documents', '/admin/privacy-requests', '/admin/legal/acceptances', '/support-chat/threads', '/support-chat/people', '/support-chat/stream',
  '/ops/client-shop-chats', '/refund-requests']);
const DETAIL = /^\/(?:approval-cases\/[^/]+|supplier-services\/[^/]+|users\/[^/]+\/production-lapses|ops\/shops\/[^/]+\/(?:hours|performance)|ops\/orders\/[^/]+\/location-diagnostics|ops\/finance\/supplier-invoices(?:\/[^/]+)?|ops\/organizations\/[^/]+(?:\/statements)?|admin\/voucher-campaigns\/[^/]+|ops\/(?:account-deletion-requests|issue-reports)\/[^/]+|admin\/legal\/documents\/[^/]+|admin\/tracker(?:\/[^/]+\/[0-9]+|\/decisions\/[^/]+\/attachments\/[^/]+)?|support-chat\/threads\/[^/]+(?:\/messages)?|refund-requests\/[^/]+)$/;
export const isStaffDeskRead = path => DESKS.has(path) || DETAIL.test(path);
const text = value => value?.includes('\0') ? null : value;
// Stored IDs cannot contain NUL. For their binary `id > cursor` comparison,
// the prefix before the first NUL selects exactly the same IDs as JS does.
// Keep this separate from equality filters, where a NUL never matches an ID.
const binaryCursorPrefix = value => value?.split('\0', 1)[0] ?? null;
const unique = values => [...new Set(values.filter(Boolean))];

/** Only rows a desk projects or uses for authorization/aggregates. The unchanged
 * route owns errors, privacy and ordering. Legacy complete lists stay complete.
 */
export async function readStaffDesk(database, graph, actorIds, path, params, helpers) {
  const { loaded, read, finish } = graph;
  const initial = finish(), raw = initial.users[0];
  if (!raw || (helpers.role && !initial.userRoleMemberships.some(m => m.userId === raw.id && m.role === helpers.role))) return initial;
  const actor = selectActorRole(initial, raw, helpers.role || raw.role, { restrictMemberships: Boolean(helpers.role) });
  const staff = ['ops_admin', 'super_admin'].some(r => identityHasMembership(actor, r));
  const reviewOnly = isTestOperationsUser(initial, raw.id);
  const orderScope = reviewOnly ? ' AND review_data' : params.get('includeReviewData') === '1' ? '' : ' AND NOT review_data';
  async function identities(extra = []) {
    const users = unique([...actorIds, ...loaded.users.map(r => r.id), ...extra]);
    await helpers.readIdentity(graph, users);
  }
  async function parents() {
    const ids = loaded.orders.map(r => r.id);
    for (const table of ['order_payments', 'order_line_items']) await read(table, 'WHERE order_id = ANY($1::text[])', [ids]);
  }
  async function relatedIdentity() {
    const keys = ['userId','clientId','supplierId','riderId','ownerId','staffId','partyUserId','originalSupplierId','redeemedBy','createdBy','decidedBy','actorUserId','founderId'];
    const ids = [];
    for (const rows of Object.values(finish())) if (Array.isArray(rows)) for (const row of rows) for (const key of keys) ids.push(row[key]);
    await identities(ids);
    return finish();
  }
  if (path === '/admin/files/retention') {
    if (actor.role !== 'super_admin') return initial;
    return readRetentionGraph(database, graph, actorIds);
  }
  if (path === '/credits/balance') {
    if (staff || actor.role==='client') {
      const clientId=text(params.get('clientId') || actor.id);
      await read('credit_accounts','WHERE user_id=$1',[clientId]);
      await read('credit_ledger','WHERE user_id=$1',[clientId]);
    }
    return finish();
  }
  if (path === '/ops/catalog-items' && !staff) return initial;
  if (path === '/ops/catalog-items') return readStaffCatalog(database, graph, actorIds, params, { ...helpers, reviewOnly });
  if (path.startsWith('/ops/issue-reports')) {
    // Fetch the exact reporters only after the SQL desk has selected its page.
    Object.defineProperty(initial, 'prepareIssueReporterFacts', { value: reporterIds => database.snapshot(async () => {
      const context=helpers.newGraph(), users=unique(reporterIds);
      await helpers.readIdentity(context,users);
      await context.read('platform_settings','WHERE singleton');
      await context.read('founding_testers','WHERE client_id = ANY($1::text[])',[users]);
      await context.read('tester_rewards',"WHERE client_id = ANY($1::text[]) AND kind='bug_report'",[users]);
      const facts=context.finish();
      return id=>({tester:foundingTesterEligible(facts,id),bugRewardAvailable:bugReportRewardAvailable(facts,id)});
    }) });
    return initial;
  }
  // These desks already query PostgreSQL (or GitHub) directly. Only their Clerk
  // identity graph was missing; never prefetch domain history for them.
  if (/^\/(?:admin\/(?:legal|privacy-requests|tracker)|ops\/(?:push|account-deletion-requests|issue-reports)|support-chat)(?:\/|$)/.test(path)) return initial;
  if (!staff && !path.startsWith('/staff/') && !path.startsWith('/supplier-services') && path !== '/supplier-payment-terms' && !path.startsWith('/refund-requests')) return initial;
  if (path.startsWith('/admin/season-windows')) {
    await read('platform_settings', 'WHERE singleton');
    await read('season_windows', '');
    return finish();
  }
  if (path === '/admin/featured-prints') {
    await read('platform_settings', 'WHERE singleton');
    await helpers.readCatalogueGraph(graph, actorIds, { itemIds: loaded.platform_settings[0]?.settings?.featuredPrints?.catalogItemIds || [], ratings: false });
    return relatedIdentity();
  }
  if (path.startsWith('/admin/staff') || path.startsWith('/staff/') || path.startsWith('/ops/hub')) {
    await read('platform_settings', 'WHERE singleton');
    await read('staff_roles', '');
    await read('staff_profiles', path === '/admin/staff' ? '' : 'WHERE user_id = ANY($1::text[])', path === '/admin/staff' ? [] : [actorIds]);
    if (path === '/admin/staff/invites') await read('staff_invites', '');
    if (path.endsWith('/handouts')) {
      await read('hub_handouts', path.startsWith('/staff/') ? 'WHERE staff_id = ANY($1::text[])' : '', path.startsWith('/staff/') ? [actorIds] : []);
      // Totals need all matching handouts; the handler retains its page/cursor.
      await read('orders', 'WHERE id = ANY($1::text[])', [loaded.hub_handouts.map(r => r.order_id)]);
    }
    if (path === '/ops/hub/escalations') await read('orders', `WHERE data#>'{handover,escalation}' IS NOT NULL${orderScope}`);
    if (path === '/ops/hub/unclaimed') await read('orders', `WHERE state='awaiting_collection' AND data#>>'{handover,qrToken}' IS NOT NULL${orderScope}`);
    if (path === '/ops/hub/receipt-scans') {
      const month = params.get('month') || null, owner = text(params.get('supplierId') || null);
      await read('files', `WHERE purpose='supplier_invoice' AND state='ready'
        AND ($1::text IS NULL OR owner_id=$1) AND ($2::text IS NULL OR to_char(created_at AT TIME ZONE 'UTC','YYYY-MM')=$2)`, [owner, text(month)]);
      await read('file_references', 'WHERE file_id = ANY($1::text[])', [loaded.files.map(r => r.file_id)]);
      await read('orders', 'WHERE id = ANY($1::text[])', [loaded.file_references.filter(r => r.reference_type === 'order').map(r => r.reference_id)]);
    }
    return relatedIdentity();
  }
  if (path.startsWith('/supplier-services') || path === '/supplier-payment-terms' || /^\/ops\/shops.*\/hours$/.test(path)) {
    await read('platform_settings', 'WHERE singleton');
    if (path === '/supplier-payment-terms') {
      const supplierId = staff ? params.get('supplierId') || actor.id : actor.id;
      await read('supplier_payment_terms', 'WHERE supplier_id=$1', [text(supplierId)]);
      await read('supplier_profiles', 'WHERE user_id=$1', [text(supplierId)]);
      return finish();
    }
    if (path.startsWith('/ops/shops')) {
      const id = /^\/ops\/shops\/([^/]+)\/hours$/.exec(path)?.[1];
      await read('supplier_profiles', id ? 'WHERE user_id=$1' : '', id ? [text(id)] : []);
    } else {
      const id = path.split('/')[2], supplierId = actor.role === 'supplier' ? actor.id : params.get('supplierId') || null;
      await read('supplier_services', id ? 'WHERE id=$1' : 'WHERE ($1::text IS NULL OR supplier_id=$1) AND ($2::text IS NULL OR state=$2)',
        id ? [text(id)] : [text(supplierId), text(params.get('state') || null)]);
      const services = loaded.supplier_services.map(r => r.id);
      for (const table of ['supplier_service_file_formats','supplier_service_price_tiers']) await read(table, 'WHERE supplier_service_id = ANY($1::text[])', [services]);
      await read('supplier_profiles', 'WHERE user_id = ANY($1::text[])', [loaded.supplier_services.map(r => r.supplier_id)]);
      for (const table of ['taxonomy_categories','taxonomy_category_aliases']) await read(table, '');
    }
    return relatedIdentity();
  }
  if (/production-lapses$/.test(path) || /\/performance$/.test(path)) {
    const supplierId = path.startsWith('/users/') ? path.split('/')[2] : /^\/ops\/shops\/([^/]+)\/performance$/.exec(path)?.[1];
    await read('supplier_profiles', supplierId ? 'WHERE user_id=$1' : '', supplierId ? [text(supplierId)] : []);
    const suppliers = supplierId ? [text(supplierId)] : loaded.supplier_profiles.map(r => r.user_id);
    await identities(suppliers);
    await read('platform_settings', 'WHERE singleton');
    if (path.endsWith('/production-lapses')) await read('production_lapses', 'WHERE supplier_id = ANY($1::text[])', [suppliers]);
    else await read('supplier_performance_events', 'WHERE supplier_id = ANY($1::text[])', [suppliers]);
    await read('orders', 'WHERE id = ANY($1::text[])', [[...loaded.supplier_performance_events, ...loaded.production_lapses].map(r => r.order_id)]);
    await read('order_line_items', 'WHERE order_id = ANY($1::text[])', [loaded.orders.map(r => r.id)]);
    const store = await relatedIdentity();
    if (path.endsWith('/production-lapses')) store.supplierPerformanceLaunchedAt = (await database.query('SELECT launched_at FROM supplier_performance_launch WHERE singleton')).rows[0]?.launched_at || null;
    return store;
  }
  if (path === '/ops/riders/locations' || path.endsWith('/location-diagnostics')) {
    const diagnostic = path.endsWith('/location-diagnostics');
    await read('platform_settings', 'WHERE singleton');
    await read('orders', diagnostic ? 'WHERE id=$1' : `WHERE rider_id IS NOT NULL AND state IN ('rider_assigned','picked_up','out_for_delivery')${orderScope}`, diagnostic ? [text(path.split('/')[3])] : []);
    // Per-order newest fix for the map. Diagnostics deliberately inspect this
    // assignment's history, never other riders/orders or past assignments.
    const orders = finish().orders;
    const pings = [];
    for (const order of orders) {
      const since = assignmentTime(order);
      const canonical = since && Number.isFinite(Date.parse(since)) && new Date(since).toISOString() === since;
      const values = [order.id, order.riderId || null, canonical ? since : null, canonical ? null : since || null];
      const where = `order_id=$1 AND rider_id=$2 AND ($3::timestamptz IS NULL OR at >= $3)
        AND ($4::text IS NULL OR to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') >= $4 COLLATE "C")`;
      const latest = await database.query(`SELECT * FROM location_pings WHERE ${where} ORDER BY at DESC,position ASC LIMIT 1`, values);
      pings.push(...latest.rows);
      if (diagnostic) {
        const samples = await database.query(`SELECT * FROM location_pings WHERE ${where} AND data->>'receivedAt' IS NOT NULL
          ORDER BY (data->>'receivedAt') COLLATE "en-x-icu" DESC,position DESC LIMIT 100`, values);
        pings.push(...samples.rows.filter(r => !pings.some(p => p.id === r.id)));
      }
    }
    loaded.location_pings = pings;
    await read('rider_profiles', 'WHERE user_id = ANY($1::text[])', [loaded.orders.map(r => r.rider_id)]);
    return relatedIdentity();
  }
  if (path === '/ops/reschedule-requests' || path === '/ops/special-instructions' || path === '/ops/client-shop-chats') {
    if (path === '/ops/reschedule-requests') await read('orders', `WHERE data->'rescheduleRequest' IS NOT NULL AND ($1::text IS NULL OR data#>>'{rescheduleRequest,supplierId}'=$1)${reviewOnly ? ' AND review_data' : ''}`, [text(params.get('supplierId') || null)]);
    else if (path === '/ops/special-instructions') {
      await read('orders', `WHERE (COALESCE(data->>'specialInstructions','')<>'' OR id IN (SELECT order_id FROM order_line_items WHERE COALESCE(special_instructions,'')<>'') OR id IN (SELECT order_id FROM order_change_requests))${reviewOnly ? ' AND review_data' : ''}`);
      await read('order_line_items', 'WHERE order_id = ANY($1::text[])', [loaded.orders.map(r => r.id)]);
      await read('order_change_requests', 'WHERE order_id = ANY($1::text[])', [loaded.orders.map(r => r.id)]);
    } else {
      await read('platform_settings', 'WHERE singleton');
      // The existing SQL thread list owns pagination and skips invisible parents.
      const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 50));
      const offset = /^\d+$/.test(params.get('offset') ?? '0') ? Number(params.get('offset') || 0) : 0;
      await read('orders', `WHERE id IN (SELECT order_id FROM client_shop_chat_threads WHERE ${activeOrderSql('client_shop_chat_threads.order_id')} AND ($1::boolean=false OR flagged_at IS NOT NULL) ORDER BY updated_at DESC,order_id LIMIT $2 OFFSET $3)`, [params.get('flagged') === '1', limit + 1, Math.min(offset, Number.MAX_SAFE_INTEGER)]);
      await read('order_jobs', 'WHERE order_id = ANY($1::text[])', [loaded.orders.map(r => r.id)]);
      await read('supplier_profiles', 'WHERE user_id = ANY($1::text[])', [unique([...loaded.orders.map(r => r.supplier_id), ...loaded.order_jobs.map(r => r.supplier_id)])]);
    }
    return relatedIdentity();
  }
  if (path.startsWith('/ops/finance/supplier-invoices')) {
    const id = path.split('/')[4];
    await read('supplier_invoices', id ? 'WHERE order_id=$1' : 'WHERE month=$1 AND ($2::text IS NULL OR supplier_id=$2)', id ? [text(id)] : [text(params.get('month')), text(params.get('supplierId') || null)]);
    await read('orders', 'WHERE id = ANY($1::text[])', [unique([id, ...loaded.supplier_invoices.map(r => r.order_id)])]);
    const orders = loaded.orders.map(r => r.id);
    await read('files', `WHERE purpose='supplier_invoice' AND owner_id = ANY($1::text[]) AND file_id IN (SELECT file_id FROM file_references WHERE reference_type='order' AND reference_id = ANY($2::text[]))`, [loaded.supplier_invoices.map(r => r.supplier_id), orders]);
    await read('file_references', 'WHERE file_id = ANY($1::text[])', [loaded.files.map(r => r.file_id)]);
    await read('supplier_profiles', 'WHERE user_id = ANY($1::text[])', [loaded.supplier_invoices.map(r => r.supplier_id)]);
    return relatedIdentity();
  }
  if (path.startsWith('/ops/organizations')) {
    let id = path.split('/')[3];
    if (path.endsWith('/statements')) { try { id = decodeURIComponent(id); } catch { return initial; } }
    if (id) await identities([id]);
    else {
      const rows = await database.query(`SELECT user_id FROM (SELECT user_id FROM organization_accounts UNION SELECT id FROM users WHERE account_type='organization') s WHERE user_id > $1 COLLATE "C" ORDER BY user_id COLLATE "C" LIMIT 51`, [binaryCursorPrefix(params.get('after') || '')]);
      await identities(rows.rows.map(r => r.user_id));
    }
    const users = loaded.users.map(r => r.id);
    for (const table of ['organization_accounts','client_profiles']) await read(table, 'WHERE user_id = ANY($1::text[])', [users]);
    await read('approval_case_events', 'WHERE approval_case_id = ANY($1::text[])', [loaded.approval_cases.map(r => r.id)]);
    if (path.endsWith('/statements')) {
      await read('orders', "WHERE client_id=$1 AND state IN ('completed','payout_released') AND NOT review_data", [text(id)]);
      await parents();
      await read('order_invoices', 'WHERE order_id = ANY($1::text[])', [loaded.orders.map(r => r.id)]);
    }
    return relatedIdentity();
  }
  if (path.startsWith('/approval-cases')) {
    const id = path.split('/')[2];
    const status = params.get('status') || 'pending', kind = params.get('kind') || null;
    let cursor;
    try { cursor = params.get('cursor') ? JSON.parse(Buffer.from(params.get('cursor'), 'base64url').toString()) : null; } catch { return initial; }
    if (cursor && (typeof cursor.submittedAt !== 'string' || !Number.isFinite(Date.parse(cursor.submittedAt)) || typeof cursor.id !== 'string' || !cursor.id)) return initial;
    await read('approval_cases', id ? 'WHERE id=$1' : `WHERE submitted_at IS NOT NULL AND status=$1 AND ($2::text IS NULL OR kind=$2)${reviewOnly ? ' AND user_id IN (SELECT id FROM users WHERE review_data)' : ''}
      AND ($3::text IS NULL OR to_char(submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') > $3 COLLATE "C" OR (to_char(submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=$3 AND id > $4 COLLATE "C"))
      ORDER BY submitted_at,id COLLATE "en-x-icu" LIMIT 51`, id ? [text(id)] : [text(status), text(kind), text(cursor?.submittedAt || null), binaryCursorPrefix(cursor?.id)]);
    const owners = unique([...actorIds, ...loaded.approval_cases.map(r => r.user_id)]);
    await identities(owners);
    for (const table of ['supplier_profiles','rider_profiles','client_profiles','organization_accounts']) await read(table, 'WHERE user_id = ANY($1::text[])', [owners]);
    await read('approval_case_events', 'WHERE approval_case_id = ANY($1::text[])', [loaded.approval_cases.map(r => r.id)]);
    if (id) {
      await read('supplier_services', 'WHERE supplier_id = ANY($1::text[])', [owners]);
      for (const table of ['supplier_service_file_formats','supplier_service_price_tiers']) await read(table, 'WHERE supplier_service_id = ANY($1::text[])', [loaded.supplier_services.map(r => r.id)]);
      await read('rider_documents', 'WHERE rider_id = ANY($1::text[])', [owners]);
      await read('files', 'WHERE file_id = ANY($1::text[])', [loaded.rider_documents.map(r => r.file_id)]);
      for (const table of ['taxonomy_categories','taxonomy_category_aliases']) await read(table, '');
      await read('platform_settings', 'WHERE singleton');
    }
    return relatedIdentity();
  }
  return readStaffReports(database, graph, actorIds, path, params, { ...helpers, relatedIdentity, parents, reviewOnly, orderScope });
}

async function readStaffCatalog(database, graph, ids, params, helpers) {
  let query;
  try { query = helpers.parseStaffCatalogQuery({ searchParams: params }); } catch { return graph.finish(); }
  const values = [], filters = ['i.quote_request_id IS NULL'];
  const bind = value => { values.push(value); return `$${values.length}`; };
  const review = helpers.reviewOnly ? ' AND i.supplier_id IN (SELECT id FROM users WHERE review_data)' : '';
  if (query.supplierId) filters.push(`i.supplier_id=${bind(query.supplierId)}`);
  if (query.subcategoryCode) filters.push(`i.subcategory_code=${bind(query.subcategoryCode)}`);
  if (query.minPriceMinor != null) filters.push(`i.base_price_minor>=${bind(query.minPriceMinor)}`);
  if (query.maxPriceMinor != null) filters.push(`i.base_price_minor<=${bind(query.maxPriceMinor)}`);
  if (query.productionTimeReview) {
    filters.push(`(cardinality(i.production_time_review_reasons)>0 OR (i.express AND COALESCE(
      CASE WHEN i.turnaround_mode='override' THEN COALESCE(i.turnaround_minutes,i.turnaround_hours*60,i.turnaround_days)
        WHEN s.standard_turnaround_minutes IS NOT NULL OR s.standard_turnaround_hours IS NOT NULL OR s.standard_turnaround_days IS NOT NULL
          THEN COALESCE(s.standard_turnaround_minutes,s.standard_turnaround_hours*60,s.standard_turnaround_days)
        ELSE COALESCE(s.turnaround_minutes,s.turnaround_hours*60,s.turnaround_days) END,0)<=0))`);
  }
  if (query.q) {
    // The legacy staff index is token containment OR literal substring, not the
    // supplier board's websearch/fuzzy ranking. Assemble its exact text/order;
    // ICU full lowercasing matches JS (including dotted I and final sigma).
    const trim = bind(' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff');
    const part = expression => `NULLIF(btrim(${expression},${trim}),'')`;
    const search = `lower(concat_ws(' ',${part('i.name')},${part('i.description')},${part('sub.name')},
      (SELECT string_agg(${part('o.label')},' ' ORDER BY o.option_group_id COLLATE "en-x-icu",o.sort_order,o.id COLLATE "en-x-icu")
        FROM supplier_catalog_options o JOIN supplier_catalog_option_groups g ON g.id=o.option_group_id WHERE g.catalog_item_id=i.id),
      (SELECT string_agg(${part('step.title')},' ' ORDER BY step.sort_order,step.id COLLATE "en-x-icu") FROM supplier_catalog_prep_steps step WHERE step.catalog_item_id=i.id),
      ${part('p.shop_name')}) COLLATE "en-x-icu")`;
    filters.push(`(regexp_split_to_array(${search} COLLATE "C",'[^a-z0-9]+') @> ${bind(query.q.split(/\s+/).map(t => t.toLowerCase()))}::text[]
      OR strpos(${search},${bind(query.q.toLowerCase())})>0)`);
  }
  const cte = `WITH hits AS (SELECT i.id,i.updated_at FROM supplier_catalog_items i
    LEFT JOIN supplier_profiles p ON p.user_id=i.supplier_id
    LEFT JOIN supplier_services s ON s.id=i.supplier_service_id
    LEFT JOIN taxonomy_subcategories sub ON sub.code=i.subcategory_code
    WHERE ${filters.join(' AND ')}${review})`;
  const total = (await database.query(`${cte} SELECT count(*)::bigint AS total FROM hits`, values)).rows[0].total;
  let cursor = '';
  if (query.cursor) {
    // A cursor is opaque caller input. JS binary date comparison can accept
    // NUL (below every ISO timestamp character); PostgreSQL text cannot.
    const cursorAt=String(query.cursor.at || '').replaceAll('\0','\u0001');
    const cursorId=String(query.cursor.id).replaceAll('\0',''); // ICU ignores NUL.
    const at=bind(cursorAt),id=bind(cursorId);
    // Deterministic ICU adds a byte tie-break for ignorable characters, unlike
    // localeCompare. Keep normal generated-ID cursors on the page index.
    const collation=/^[a-zA-Z0-9_-]*$/.test(cursorId) ? '"en-x-icu"' : 'gridgo_staff_cursor';
    const iso = `COALESCE(to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'')`;
    cursor = `WHERE (${iso} < ${at} COLLATE "C" OR (${iso}=${at} AND id COLLATE ${collation} > ${id}))`;
  }
  const page = (await database.query(`${cte} SELECT id,updated_at FROM hits ${cursor}
    ORDER BY date_trunc('milliseconds',updated_at AT TIME ZONE 'UTC') DESC NULLS LAST,id COLLATE "en-x-icu" LIMIT ${bind(query.limit + 1)}`, values)).rows;
  const more = page.length > query.limit;
  if (more) page.pop();
  const facets = (await database.query(`SELECT DISTINCT i.supplier_id,p.shop_name FROM supplier_catalog_items i
    LEFT JOIN supplier_profiles p ON p.user_id=i.supplier_id WHERE i.quote_request_id IS NULL${review}`)).rows;
  const shops = facets.map(r => ({ supplierId: r.supplier_id, shopName: r.shop_name?.trim() || null }))
    .sort((a,b) => String(a.shopName || a.supplierId).localeCompare(String(b.shopName || b.supplierId)) || a.supplierId.localeCompare(b.supplierId));
  await graph.read('supplier_catalog_items', 'WHERE id = ANY($1::text[])', [page.map(r => r.id)]);
  await helpers.readCatalogItemContext(graph, ids);
  const store = graph.finish(), byId = new Map(store.catalogItems.map(r => [r.id, r]));
  const last = page.at(-1);
  // Review-only parent filtering precedes the legacy graph adapter. Capturing
  // the SQL result in a callback would bypass that filtering (including facets).
  if (helpers.reviewOnly) return store;
  Object.defineProperty(store, 'listStaffCatalogItems', { value: async () => ({
    items: page.map(r => byId.get(r.id)), shops, total,
    nextCursor: more ? encodeCatalogListCursor({ at: last.updated_at ?? null, id: last.id }) : null,
  }) });
  return store;
}

async function readStaffReports(database, graph, actorIds, path, params, helpers) {
  const { read, loaded, finish } = graph;
  const ids = rows => rows.map(r => r.id);
  if (path === '/ops/tester-invites' || path === '/ops/tester-rewards') {
    const table = path.endsWith('/tester-invites') ? 'tester_invites' : 'tester_rewards';
    const values = [], clauses = [];
    const add = (sql, value) => { values.push(text(value)); clauses.push(sql.replaceAll('?', `$${values.length}`)); };
    if (table === 'tester_rewards') {
      if (params.get('status')) add('status=?', params.get('status'));
      if (params.has('clientId')) add('(client_id=? OR inviter_id=?)', params.get('clientId'));
    } else {
      if (params.has('inviterId')) add('inviter_id=?', params.get('inviterId'));
      const status = params.get('status');
      if (status === 'completed') clauses.push('completed_at IS NOT NULL');
      if (status === 'joined') clauses.push('completed_at IS NULL AND client_id IS NOT NULL');
      if (status === 'unmatched') clauses.push('completed_at IS NULL AND client_id IS NULL');
    }
    await read(table, clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values);
    if (table === 'tester_rewards') {
      await read('platform_settings', 'WHERE singleton');
      await read('voucher_campaigns', "WHERE purpose IN ('founding_tester','tester_referral','tester_bug_report')");
      await read('vouchers', 'WHERE campaign_id = ANY($1::text[])', [ids(loaded.voucher_campaigns)]);
    }
    return helpers.relatedIdentity();
  }
  if (path.startsWith('/refund-requests')) {
    const initial = finish(), actor = selectActorRole(initial, initial.users.find(u => actorIds.includes(u.id)), helpers.role || initial.users[0]?.role, { restrictMemberships: Boolean(helpers.role) });
    const staff = ['ops_admin','super_admin'].some(r => identityHasMembership(actor, r));
    const id = path.split('/')[2];
    await read('refund_requests', id ? 'WHERE id=$1' : `WHERE ($1::text IS NULL OR status=$1)${staff ? '' : ' AND client_id=$2'}`, id ? [text(id)] : staff ? [text(params.get('status') || null)] : [text(params.get('status') || null), actor.id]);
    const orders = loaded.refund_requests.map(r => r.order_id);
    await read('orders', 'WHERE id = ANY($1::text[])', [orders]);
    for (const table of ['order_payments','order_payment_allocations','payout_milestones','refund_settlements','refund_supplier_payouts','order_change_requests','order_change_payments','delivery_pin_payments','voucher_redemptions']) {
      if (table === 'voucher_redemptions') await read(table, 'WHERE data @> ANY($1::jsonb[])', [orders.map(id => JSON.stringify({ orderIds: [id] }))]);
      else await read(table, 'WHERE order_id = ANY($1::text[])', [orders]);
    }
    for (const table of ['refund_attempts','refund_payments','refund_events']) await read(table, 'WHERE request_id = ANY($1::text[])', [ids(loaded.refund_requests)]);
    await read('supplier_payout_accounts', 'WHERE supplier_id = ANY($1::text[])', [loaded.orders.map(r => r.supplier_id)]);
    await read('supplier_profiles', 'WHERE user_id = ANY($1::text[])', [loaded.orders.map(r => r.supplier_id)]);
    await read('files', 'WHERE file_id = ANY($1::text[])', [loaded.supplier_payout_accounts.map(r => r.qr_file_id)]);
    return helpers.relatedIdentity();
  }
  if (path.startsWith('/admin/voucher-campaigns')) {
    const id = path.split('/')[3];
    await read('voucher_campaigns', id ? 'WHERE id=$1' : '', id ? [text(id)] : []);
    return finish();
  }
  if (path === '/ops/vouchers' || path === '/admin/promotions' || path === '/ops/founding-testers') {
    await read('platform_settings', 'WHERE singleton');
    await read('promotion_settings', "WHERE id='launch'");
    if (path === '/ops/vouchers') await read('vouchers', 'WHERE client_id=$1', [text(params.get('clientId'))]);
    else if (path === '/admin/promotions') {
      await read('vouchers', "WHERE promotion_kind IN ('founding','friend_pass')");
      await read('promotion_invites', '');
      const emails=unique(loaded.promotion_invites.filter(r=>!r.client_id).map(r=>r.email));
      const owners=unique([...actorIds,...loaded.vouchers.map(r=>r.client_id),...loaded.promotion_invites.flatMap(r=>[r.client_id,r.founder_id])]);
      // Reuse bootstrap's indexed email candidates plus its Unicode fallback;
      // the unchanged JS policy still decides eligibility/ambiguous matches.
      await read('users', `WHERE id = ANY($1::text[])${emails.length ? " OR lower(btrim(email)) = ANY($2::text[]) OR email ~ '[^!-~]'" : ''}`,emails.length?[owners,emails]:[owners]);
    } else {
      await read('users', 'WHERE id = ANY($1::text[]) OR id IN (SELECT user_id FROM user_role_memberships WHERE role=\'client\')', [actorIds]);
      const clients = loaded.users.map(r => r.id);
      for (const table of ['founding_testers','tester_rewards','tester_invites','tester_tracking','tester_installations']) {
        await read(table, 'WHERE client_id = ANY($1::text[])' + (table === 'tester_rewards' || table === 'tester_invites' ? ' OR inviter_id = ANY($1::text[])' : ''), [clients]);
      }
      await read('tester_invite_codes', 'WHERE client_id = ANY($1::text[])', [clients]);
      await read('vouchers', 'WHERE client_id = ANY($1::text[])', [clients]);
      await read('orders', 'WHERE client_id = ANY($1::text[])', [clients]);
      await helpers.parents();
      for (const table of ['order_surveys','issues','refund_settlements']) await read(table, 'WHERE order_id = ANY($1::text[])', [ids(loaded.orders)]);
      await read('client_carts', 'WHERE client_id = ANY($1::text[])', [clients]);
      await read('client_cart_lines', 'WHERE cart_id = ANY($1::text[])', [ids(loaded.client_carts)]);
    }
    const vouchers = ids(loaded.vouchers);
    await read('voucher_campaigns', `WHERE id = ANY($1::text[])${path === '/ops/founding-testers' ? " OR purpose IN ('founding_tester','tester_referral','tester_bug_report')" : ''}`, [loaded.vouchers.map(r => r.campaign_id)]);
    if (path === '/ops/founding-testers') {
      // The budget includes earned vouchers even after a client membership is
      // removed; it cannot be restricted to today's directory page/roles.
      await read('vouchers', 'WHERE id = ANY($1::text[]) OR campaign_id = ANY($2::text[])', [vouchers,loaded.voucher_campaigns.filter(r=>['founding_tester','tester_referral','tester_bug_report'].includes(r.purpose)).map(r=>r.id)]);
    }
    for (const table of ['voucher_reservations','voucher_redemptions']) await read(table, 'WHERE voucher_id = ANY($1::text[])', [ids(loaded.vouchers)]);
    return helpers.relatedIdentity();
  }
  if (path === '/admin/voucher-redemptions') {
    const values = [], clauses = [];
    for (const [key, column] of [['campaignId','campaign_id'],['clientId','client_id'],['kind','kind']]) if (params.has(key)) { values.push(text(params.get(key))); clauses.push(`${column}=$${values.length}`); }
    for (const [key, op] of [['from','>='],['to','<=']]) if (params.has(key) && Number.isFinite(Date.parse(params.get(key)))) { values.push(new Date(params.get(key)).toISOString()); clauses.push(`at${op}$${values.length}`); }
    await read('voucher_ledger', clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values);
    const orders = unique(loaded.voucher_ledger.flatMap(r => r.data?.orderIds || []));
    await read('orders', 'WHERE id = ANY($1::text[])', [orders]);
    return helpers.relatedIdentity();
  }
  if (['/admin/survey-responses','/admin/pricing-feedback','/admin/checkout-exit-feedback'].includes(path)) {
    const values = [], dateClauses = [];
    for (const [key, op] of [['from','>='],['to','<=']]) if (params.has(key) && Number.isFinite(Date.parse(params.get(key)))) { values.push(new Date(params.get(key)).toISOString()); dateClauses.push(`DATE_FIELD${op}$${values.length}`); }
    if (path !== '/admin/checkout-exit-feedback') await read('order_surveys', `WHERE submitted_at IS NOT NULL${dateClauses.map(c => ` AND ${c.replace('DATE_FIELD','submitted_at')}`).join('')}`, values);
    if (path !== '/admin/survey-responses') await read('checkout_exit_prompts', dateClauses.length ? `WHERE ${dateClauses.map(c => c.replace('DATE_FIELD','asked_at')).join(' AND ')}` : '', values);
    await read('orders', 'WHERE id = ANY($1::text[])', [loaded.order_surveys.map(r => r.order_id)]);
    await read('order_line_items', 'WHERE order_id = ANY($1::text[])', [ids(loaded.orders)]);
    await read('supplier_catalog_items', 'WHERE id = ANY($1::text[])', [loaded.order_line_items.map(r => r.source_catalog_item_id)]);
    await read('supplier_services', 'WHERE id = ANY($1::text[])', [unique([...loaded.order_line_items.map(r => r.source_supplier_service_id), ...loaded.supplier_catalog_items.map(r => r.supplier_service_id)])]);
    for (const table of ['taxonomy_categories','taxonomy_category_aliases','taxonomy_subcategories']) await read(table, '');
    return helpers.relatedIdentity();
  }
  if (path === '/admin/shop-rankings') {
    // Rankings intentionally compare every rated shop. No inbox, ping or audit
    // history participates; only the rated parents and listing category facts.
    await read('users', "WHERE id = ANY($1::text[]) OR role='supplier' OR id IN (SELECT user_id FROM user_role_memberships WHERE role='supplier')", [actorIds]);
    await helpers.readIdentity(graph, loaded.users.map(r => r.id));
    await read('shop_reviews', '');
    await read('orders', "WHERE id = ANY($1::text[]) OR (ready_by IS NOT NULL AND (ready_at IS NOT NULL OR data#>'{shopHandover,finished}' IS NOT NULL))", [loaded.shop_reviews.map(r => r.order_id)]);
    await read('order_line_items', 'WHERE order_id = ANY($1::text[])', [ids(loaded.orders)]);
    await read('supplier_catalog_items', 'WHERE quote_request_id IS NULL');
    await read('supplier_profiles', '');
    await read('supplier_services', 'WHERE id = ANY($1::text[])', [unique([...loaded.supplier_catalog_items.map(r => r.supplier_service_id), ...loaded.order_line_items.map(r => r.source_supplier_service_id)])]);
    for (const table of ['taxonomy_categories','taxonomy_category_aliases','taxonomy_subcategories']) await read(table, '');
    return helpers.relatedIdentity();
  }
  if (path === '/admin/pricing') {
    let ranges;
    const query = Object.fromEntries(params), now = new Date().toISOString();
    try { ranges = pricingRanges(query, now); } catch { return finish(); }
    const bounds = [ranges.period, ranges.compare].filter(Boolean), values = [];
    const clauses = bounds.map(range => { values.push(range.from, range.to); return `(created_at BETWEEN $${values.length-1} AND $${values.length})`; });
    values.push(now.slice(0,7));
    const month = `$${values.length}`;
    clauses.push(`(state IN ('completed','payout_released') AND to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM')=${month})`);
    clauses.push(`(data @? '$.timeline[*] ? (@.state == "completed" || @.state == "payout_released")') AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'timeline')='array' THEN data->'timeline' ELSE '[]'::jsonb END) e
      WHERE e->>'state' IN ('completed','payout_released') AND left(e->>'at',7)=${month})`);
    await read('orders', `WHERE NOT review_data AND (${clauses.join(' OR ')})`, values);
    // Global cohort/funnel facts are aggregates and IDs, not hydrated orders.
    const firstRows = (query.cohort ? (await database.query(`SELECT client_id,min(created_at) AS first_at FROM orders
      WHERE NOT review_data AND ${activeOrderSql('orders.id')} GROUP BY client_id`)).rows : []);
    const firstOrderAt = query.cohort ? new Map(firstRows.map(r => [r.client_id,r.first_at])) : null;
    const scope = {};
    if (firstOrderAt) scope.firstOrderAt = firstOrderAt;
    if (query.accountType) {
      const typed = (await database.query("SELECT id,account_type FROM users WHERE account_type IN ('business','organization')")).rows;
      if (['business','organization'].includes(query.accountType)) scope.accountIds=typed.filter(r=>r.account_type===query.accountType).map(r=>r.id);
      if (query.accountType==='individual') scope.nonIndividualIds=typed.map(r=>r.id);
    }
    if (query.category || query.bracket) {
      const filters = ['NOT o.review_data',activeOrderSql('o.id')], binds = [];
      const add = value => { binds.push(value); return `$${binds.length}`; };
      if (query.category) filters.push(`COALESCE(
        CASE WHEN jsonb_typeof(l.structured_spec_snapshot->'subcategoryCode')='string' THEN NULLIF(l.structured_spec_snapshot->>'subcategoryCode','') END,
        CASE WHEN jsonb_typeof(l.structured_spec_snapshot->'categoryCode')='string' THEN NULLIF(l.structured_spec_snapshot->>'categoryCode','') END,
        NULLIF(i.subcategory_code,''),CASE WHEN jsonb_typeof(o.data->'subcategoryCode')='string' THEN NULLIF(o.data->>'subcategoryCode','') END,'unspecified')=${add(query.category)}`);
      if (query.bracket) {
        const band=PRICE_BRACKETS.find(r=>r.id===query.bracket);
        filters.push(band ? `o.supplier_subtotal_minor>=${add(band.min)}${band.max==null?'':` AND o.supplier_subtotal_minor<${add(band.max)}`}` : 'FALSE');
      }
      if (query.accountType) filters.push(`COALESCE(CASE WHEN u.account_type IN ('business','organization') THEN u.account_type END,'individual')=${add(query.accountType)}`);
      if (query.cohort) filters.push(`CASE WHEN o.created_at=(SELECT min(first.created_at) FROM orders first WHERE first.client_id=o.client_id AND NOT first.review_data AND ${activeOrderSql('first.id')}) THEN 'new' ELSE 'repeat' END=${add(query.cohort)}`);
      const selected = await database.query(`SELECT o.id FROM orders o LEFT JOIN users u ON u.id=o.client_id
        LEFT JOIN LATERAL (SELECT * FROM order_line_items line WHERE line.order_id=o.id ORDER BY line.sort_order,line.id COLLATE "en-x-icu" LIMIT 1) l ON true
        LEFT JOIN supplier_catalog_items i ON i.id=l.source_catalog_item_id AND i.quote_request_id IS NULL
        WHERE ${filters.join(' AND ')}`,binds);
      scope.orderIds=selected.rows.map(r=>r.id);
    }
    const readContext={ firstOrderAt,scope };
    await helpers.parents();
    await read('supplier_catalog_items', 'WHERE id = ANY($1::text[]) AND quote_request_id IS NULL', [loaded.order_line_items.map(r => r.source_catalog_item_id)]);
    for (const table of ['refund_requests','refund_settlements']) await read(table, 'WHERE order_id = ANY($1::text[])', [ids(loaded.orders)]);
    await read('platform_settings', 'WHERE singleton');
    // The dashboard only consumes per-order count/first-time, never audit rows.
    const activity = await database.query(`SELECT order_id, count(*)::bigint AS count, min(at) AS at FROM audit_log WHERE order_id = ANY($1::text[]) AND actor_role IN ('ops_admin','super_admin') GROUP BY order_id`, [ids(loaded.orders)]);
    const store = await helpers.relatedIdentity();
    Object.defineProperty(store, 'pricingAuditActivity', { enumerable: true, value: activity.rows });
    Object.defineProperty(store, 'pricingReadContext', { enumerable: true, value: readContext });
    return store;
  }
  throw new Error(`Missing staff desk graph: ${path}`);
}
