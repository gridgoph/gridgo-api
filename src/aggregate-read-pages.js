import {
  readStaffPage,
  STAFF_LIST_PAGE,
  parseStaffPage,
  encodeStaffCursor,
} from './staff-list-pages.js';
import { activeOrderSql } from './order-removal.js';
import { rankShops } from './shop-reviews.js';
import { onTimeRate } from './order-match.js';

const truthy = (expression) =>
  `(${expression} IS NOT NULL AND ${expression} NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb))`;
const unique = (values) => [...new Set(values.filter(Boolean))];
const safe = (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new RangeError('Aggregate money exceeds the safe integer range');
  return number;
};

/** The two promotion histories have independent cursors selected by section.
 * Budgets and slot counters always cover the entire launch population. */
export async function readPromotionPage(
  database,
  graph,
  actorIds,
  path,
  params,
  helpers
) {
  const { read, loaded } = graph,
    at = new Date().toISOString();
  const launch = "promotion_kind IN ('founding','friend_pass')";
  const slot = `(promotion_kind='founding' OR ${truthy("data->'upgradedAt'")})`;
  await readStaffPage(
    graph,
    path,
    params,
    params.get('section') === 'invites' ? '' : `WHERE ${launch} AND ${slot}`
  );
  if (graph.staffPage.error) return graph.finish();
  const page = graph.staffPage,
    section = params.get('section') || 'claims';
  const summary = (
    await database.query(
      `SELECT
    count(*) FILTER(WHERE ${slot} AND (status='used' OR status='available' AND expires_at>$1)) AS claimed,
    count(*) FILTER(WHERE ${slot} AND status='used') AS used,
    count(*) FILTER(WHERE ${slot} AND (status='expired' OR status='available' AND expires_at<=$1)) AS expired,
    coalesce(sum(value_minor) FILTER(WHERE status='used' OR status='available' AND expires_at>$1),0)::text AS committed
    FROM vouchers WHERE ${launch}`,
      [at]
    )
  ).rows[0];
  const redeemed = (
    await database.query(`SELECT coalesce(sum(amount_minor),0)::text AS amount FROM voucher_redemptions r
    WHERE status='consumed' AND voucher_id IN (SELECT id FROM vouchers WHERE ${launch})`)
  ).rows[0].amount;
  const issued = (
    await database.query(
      "SELECT count(*) AS n FROM promotion_invites WHERE coalesce(voucher_id,'')<>''"
    )
  ).rows[0].n;
  if (section === 'invites') {
    const invites = [...loaded.promotion_invites],
      emails = unique(invites.filter((r) => !r.client_id).map((r) => r.email));
    const owners = unique([
      ...actorIds,
      ...invites.flatMap((r) => [r.client_id, r.founder_id]),
    ]);
    await read(
      'users',
      `WHERE id=ANY($1::text[])${emails.length ? " OR lower(btrim(email))=ANY($2::text[]) OR email ~ '[^!-~]'" : ''}`,
      emails.length ? [owners, emails] : [owners]
    );
    const clientIds = loaded.users.map((r) => r.id);
    await read(
      'vouchers',
      `WHERE id=ANY($1::text[]) OR (client_id=ANY($2::text[]) AND ${launch})`,
      [invites.map((r) => r.voucher_id), clientIds]
    );
    // Attribution conflicts are policy context, never additional page rows.
    await read(
      'promotion_invites',
      'WHERE id=ANY($1::text[]) OR client_id=ANY($2::text[])',
      [page.ids, clientIds]
    );
  } else
    await helpers.readIdentity(
      graph,
      unique([...actorIds, ...loaded.vouchers.map((r) => r.client_id)])
    );
  await helpers.readIdentity(
    graph,
    loaded.users.map((r) => r.id)
  );
  for (const table of [
    'voucher_campaigns',
    'voucher_reservations',
    'voucher_redemptions',
  ]) {
    const column = table === 'voucher_campaigns' ? 'id' : 'voucher_id';
    await read(table, `WHERE ${column}=ANY($1::text[])`, [
      loaded.vouchers.map((r) =>
        table === 'voucher_campaigns' ? r.campaign_id : r.id
      ),
    ]);
  }
  const store = graph.finish();
  store[STAFF_LIST_PAGE] = {
    ...page,
    promotionSummary: {
      at,
      claimed: safe(summary.claimed),
      used: safe(summary.used),
      expired: safe(summary.expired),
      committed: safe(summary.committed),
      redeemed: safe(redeemed),
      issued: safe(issued),
      section,
    },
  };
  return store;
}

/** Aggregate policy windows in SQL; only selected event/evidence rows cross
 * the wire. Eligibility mirrors performanceExemption/schedulingWarningOnly. */
async function performancePageFacts(
  database,
  supplierId,
  endpoints,
  at,
  reviewScope
) {
  const trim =
    ' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  const truth = (value) => `(${truthy(value)})`;
  const warningOnly = `(o.data->'express'='true'::jsonb OR ${truth("o.data#>'{scheduling,sameDay}'")} OR ${truth("o.data#>'{scheduling,tightDeadline}'")}
    OR (EXISTS(SELECT 1 FROM order_line_items l WHERE l.order_id=o.id)
      AND NOT EXISTS(SELECT 1 FROM order_line_items l WHERE l.order_id=o.id AND
        (l.turnaround_days_snapshot IS NOT NULL OR NOT (coalesce(l.turnaround_minutes_snapshot,l.turnaround_hours_snapshot*60,0)>0
          AND coalesce(l.turnaround_minutes_snapshot,l.turnaround_hours_snapshot*60,0)<600)))))`;
  const exemption = `(${truth("e.data->'exemption'")} OR EXISTS(SELECT 1 FROM supplier_performance_events n
      WHERE n.supplier_id=e.supplier_id AND n.order_id=e.order_id AND n.kind='no_fault')
    OR (e.kind='late_finish' AND ${warningOnly})
    OR (e.kind='declined' AND ${truth("o.data#>'{scheduling,tightDeadline}'")}
      AND jsonb_typeof(e.data->'reason')='string' AND btrim(e.data->>'reason',$4)<>''))`;
  // Supply the exact number of disjoint windows to the planner. A set-returning
  // multirange expression estimates 100 windows even when there is only one,
  // which can trigger JIT and a global parent hash for a tiny history page.
  const spans = [...new Set([at, ...endpoints])].map((end) => [
    Date.parse(end) - 30 * 86400000 + 1,
    Date.parse(end) + 1,
  ]);
  spans.push([Date.parse(at) - 37 * 86400000 + 1, Date.parse(at) + 1]);
  spans.sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span[0] <= previous[1])
      previous[1] = Math.max(previous[1], span[1]);
    else merged.push([...span]);
  }
  const args = [supplierId, [...new Set([at, ...endpoints])], at, trim];
  const windows = merged
    .map(
      (span) =>
        `(${span
          .map((value) => {
            args.push(new Date(value).toISOString());
            return `$${args.length}::timestamptz`;
          })
          .join(',')})`
    )
    .join(',');
  const result = (
    await database.query(
      `WITH endpoints AS (
    SELECT DISTINCT unnest($2::timestamptz[]) AS at
  ), ranges(start_at,end_at) AS (VALUES ${windows}), scoped AS MATERIALIZED (
    SELECT e.kind,date_trunc('milliseconds',e.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS at,
      coalesce(${exemption},false) AS exempt
    FROM ranges CROSS JOIN LATERAL (
      SELECT * FROM supplier_performance_events e WHERE e.supplier_id=$1
        AND e.occurred_at>=ranges.start_at AND e.occurred_at<ranges.end_at
    ) e JOIN LATERAL (SELECT o.* FROM orders o WHERE o.id=e.order_id
      AND ${activeOrderSql('o.id')} ${reviewScope} LIMIT 1) o ON true
  ), incident_counts AS (
    SELECT *,count(*) FILTER(WHERE NOT exempt AND kind='late_finish') OVER incident AS late_count,
      count(*) FILTER(WHERE NOT exempt AND kind='timed_out') OVER incident AS timeout_count
    FROM scoped WHERE at>$3::timestamptz-interval '37 days' AND at<=$3
      WINDOW incident AS (ORDER BY at RANGE BETWEEN
      (interval '30 days'-interval '1 millisecond') PRECEDING AND CURRENT ROW)
  ), counts AS (
    SELECT endpoint.at,jsonb_build_object(
      'declines',count(*) FILTER(WHERE e.kind='declined'),
      'timeouts',count(*) FILTER(WHERE e.kind='timed_out'),
      'lateFinishes',count(*) FILTER(WHERE e.kind='late_finish'),
      'cancellations',count(*) FILTER(WHERE e.kind='cancelled'),
      'arrivedPacked',count(*) FILTER(WHERE e.kind='arrived_packed')) AS value
    FROM endpoints endpoint LEFT JOIN scoped e ON NOT e.exempt AND e.at>endpoint.at-interval '30 days' AND e.at<=endpoint.at
    GROUP BY endpoint.at
  ) SELECT
    (SELECT jsonb_object_agg(to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),value) FROM counts) AS counts,
    (SELECT count(*)::int FROM scoped WHERE NOT exempt AND at>$3::timestamptz-interval '30 days' AND at<=$3
      AND kind IN ('on_time_finish','late_finish')) AS finishes,
    (SELECT count(*)::int FROM scoped WHERE NOT exempt AND at>$3::timestamptz-interval '30 days' AND at<=$3 AND kind='on_time_finish') AS on_time,
    (SELECT max(e.at+interval '7 days') FROM incident_counts e WHERE NOT e.exempt AND e.at>$3::timestamptz-interval '7 days' AND e.at<=$3
      AND ((e.kind='late_finish' AND e.late_count>=2) OR (e.kind='timed_out' AND e.timeout_count>=3))) AS hidden_until`,
      args
    )
  ).rows[0];
  return {
    supplierId,
    at,
    counts: result.counts || {},
    onTime: {
      completed: result.finishes,
      onTime: result.on_time,
      late: result.finishes - result.on_time,
      rate: result.finishes
        ? Number((result.on_time / result.finishes).toFixed(4))
        : null,
    },
    topPick: {
      hidden: Boolean(result.hidden_until),
      hiddenUntil: result.hidden_until || null,
      allHiddenFallback: true,
    },
  };
}

/** A shared cursor pages events and their warning/notice subsets. Counts,
 * on-time totals and incident-time demotion windows remain global summaries. */
export async function readPerformancePage(
  database,
  graph,
  actorIds,
  path,
  params,
  helpers
) {
  const supplierId = path.split('/')[3],
    { read, loaded } = graph,
    at = new Date().toISOString();
  const review = helpers.reviewOnly
    ? 'AND FALSE'
    : params.get('includeReviewData') === '1'
      ? ''
      : 'AND NOT o.review_data';
  await helpers.readIdentity(graph, unique([...actorIds, supplierId]));
  await readStaffPage(
    graph,
    path,
    params,
    `WHERE supplier_id=$1 AND order_id IN
    (SELECT o.id FROM orders o WHERE ${activeOrderSql('o.id')} ${review})
    AND date_trunc('milliseconds',occurred_at AT TIME ZONE 'UTC')<=$2::timestamptz AT TIME ZONE 'UTC'`,
    [supplierId, at]
  );
  if (graph.staffPage.error) return graph.finish();
  const selected = [...loaded.supplier_performance_events],
    page = graph.staffPage,
    orderIds = unique(selected.map((row) => row.order_id));
  const facts = await performancePageFacts(
    database,
    supplierId,
    // Fixed warnings (late finish/cancellation) do not depend on historical
    // counts. Only repeated declines/timeouts/packed incidents need that window.
    selected
      .filter((row) =>
        ['declined', 'timed_out', 'arrived_packed'].includes(row.kind)
      )
      .map((row) => row.occurred_at),
    at,
    review
  );
  await read(
    'supplier_performance_events',
    "WHERE supplier_id=$1 AND kind='no_fault' AND order_id=ANY($2::text[])",
    [supplierId, orderIds]
  );
  loaded.supplier_performance_events = [
    ...new Map(
      [...selected, ...loaded.supplier_performance_events].map((row) => [
        row.id,
        row,
      ])
    ).values(),
  ];
  await read('orders', 'WHERE id=ANY($1::text[])', [orderIds]);
  await read('order_line_items', 'WHERE order_id=ANY($1::text[])', [orderIds]);
  await read('supplier_profiles', 'WHERE user_id=$1', [supplierId]);
  await helpers.readIdentity(
    graph,
    unique([
      ...actorIds,
      supplierId,
      ...loaded.orders.flatMap((row) => [
        row.client_id,
        row.supplier_id,
        row.rider_id,
      ]),
    ])
  );
  await read('platform_settings', 'WHERE singleton');
  const store = graph.finish();
  store[STAFF_LIST_PAGE] = { ...page, asOf: at, performanceFacts: facts };
  return store;
}

const mean = (values) =>
  values.length
    ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) /
      100
    : null;
const score = (row) => {
  const count = Number(row.n);
  if (!count)
    return { count: 0, quality: null, speed: null, value: null, overall: null };
  const quality = mean([Number(row.q) / count]),
    speed = mean([Number(row.s) / count]),
    value = mean([Number(row.v) / count]);
  return {
    count,
    quality,
    speed,
    value,
    overall: mean([quality, speed, value]),
  };
};
const rankCompare = (a, b) =>
  Boolean(b.count) - Boolean(a.count) ||
  (a.count && b.count
    ? b.overall - a.overall ||
      b.count - a.count ||
      (b.quality ?? 0) - (a.quality ?? 0)
    : 0) ||
  a.shopName.localeCompare(b.shopName) ||
  a.group - b.group ||
  a.supplierId.localeCompare(b.supplierId);

/** Aggregate stars in PostgreSQL, preserving JS rounding/ranking in one compact
 * row per shop. Only page shops hydrate finished-order clock inputs. */
export async function readRankingPage(
  database,
  graph,
  actorIds,
  path,
  params,
  helpers
) {
  const { read, loaded } = graph;
  for (const table of [
    'taxonomy_categories',
    'taxonomy_category_aliases',
    'taxonomy_subcategories',
  ])
    await read(table, '');
  const categories = graph
    .finish()
    .taxonomy.categories.filter((r) => r.active !== false)
    .map(({ code, name }) => ({ code, name }));
  const categoryCode = String(params.get('categoryCode') || '').trim() || null;
  let page;
  try {
    page = parseStaffPage(path, params);
  } catch (error) {
    graph.staffPage = { error, rankTable: { categories } };
    return graph.finish();
  }
  if (categoryCode && !categories.some((row) => row.code === categoryCode)) {
    graph.staffPage = { rankTable: { categories } };
    return graph.finish();
  }
  const review = helpers.reviewOnly
    ? 'AND o.review_data'
    : params.get('includeReviewData') === '1'
      ? ''
      : 'AND NOT o.review_data';
  const marked = helpers.reviewOnly ? 'AND u.review_data' : '';
  const summaries = (
    await database.query(
      `WITH supplier_ids AS (
    SELECT user_id AS id,0 AS priority FROM supplier_profiles
    UNION ALL SELECT user_id,1 FROM user_role_memberships WHERE role='supplier'
    UNION ALL SELECT id,2 FROM users WHERE role='supplier'
  ), suppliers AS (SELECT id,min(priority) AS priority FROM supplier_ids GROUP BY id),
  rated AS (
    SELECT r.* FROM shop_reviews r JOIN orders o ON o.id=r.order_id
    LEFT JOIN LATERAL (
      SELECT i.subcategory_code FROM order_line_items l JOIN supplier_catalog_items i ON i.id=l.source_catalog_item_id AND i.quote_request_id IS NULL
      WHERE l.order_id=r.order_id ORDER BY l.sort_order::text COLLATE "en-x-icu",l.id COLLATE "en-x-icu" LIMIT 1
    ) subject ON true
    LEFT JOIN taxonomy_subcategories sub ON sub.code=subject.subcategory_code
    LEFT JOIN taxonomy_categories cat ON cat.code=sub.category_code
    WHERE ${helpers.reviewOnly ? 'FALSE AND' : ''} ${activeOrderSql('r.order_id')} ${review} AND ($1::text IS NULL OR cat.code=$1)
    ${helpers.reviewOnly ? 'AND r.client_id IN (SELECT id FROM users WHERE review_data) AND r.supplier_id IN (SELECT id FROM users WHERE review_data)' : ''}
  ) SELECT ids.id,ids.priority,coalesce(nullif(p.shop_name,''),nullif(u.data->>'supplierName',''),nullif(u.name,''),'Unnamed shop') AS name,
    count(r.id) AS n,coalesce(sum(r.quality_stars),0) AS q,coalesce(sum(r.speed_stars),0) AS s,coalesce(sum(r.value_stars),0) AS v
    FROM suppliers ids JOIN users u ON u.id=ids.id LEFT JOIN supplier_profiles p ON p.user_id=ids.id
    LEFT JOIN rated r ON r.supplier_id=ids.id WHERE true ${marked}
    GROUP BY ids.id,ids.priority,p.shop_name,u.data,u.name`,
      [categoryCode]
    )
  ).rows;
  // The legacy stable tie order starts with profiles, then memberships, then
  // legacy supplier rows. Locale comparisons match the compatibility decoder.
  summaries.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const shops = summaries.map((row) => ({
    supplierId: row.id,
    shopName: row.name,
    overall: score(row),
    byCategory: categoryCode ? { [categoryCode]: score(row) } : {},
    onTime: null,
  }));
  const table = rankShops({ shops }, categoryCode),
    groups = new Map(summaries.map((r) => [r.id, Number(r.priority)]));
  let boundary = null;
  if (page.cursor) {
    try {
      boundary = JSON.parse(page.cursor.k);
      if (
        typeof boundary.shopName !== 'string' ||
        typeof boundary.supplierId !== 'string' ||
        boundary.supplierId !== page.cursor.id ||
        !Number.isSafeInteger(boundary.count) ||
        boundary.count < 0 ||
        ![0, 1, 2].includes(boundary.group) ||
        (boundary.count > 0 &&
          ![boundary.overall, boundary.quality].every(Number.isFinite))
      )
        throw new Error();
    } catch {
      graph.staffPage = {
        error: Object.assign(new Error('invalid_cursor'), {
          status: 400,
          code: 'invalid_cursor',
        }),
        rankTable: { categories },
      };
      return graph.finish();
    }
  }
  const candidates = table.rows
    .map((row) => ({ ...row, group: groups.get(row.supplierId) }))
    .filter((row) => !boundary || rankCompare(row, boundary) > 0);
  const selected = candidates.slice(0, page.limit),
    ids = selected.map((r) => r.supplierId),
    last = selected.at(-1);
  await read(
    'orders',
    `WHERE supplier_id=ANY($1::text[]) AND ready_by IS NOT NULL
    AND (ready_at IS NOT NULL OR data#>'{shopHandover,finished}' IS NOT NULL) ${review.replaceAll('o.', '')}`,
    [ids]
  );
  const clockStore = graph.finish();
  if (params.get('includeReviewData') === '1')
    clockStore.reviewDataReportsIncluded = true;
  let prices = [];
  if (categoryCode)
    prices = (
      await database.query(
        `SELECT supplier_id,min(base_price_minor) AS price FROM supplier_catalog_items
    WHERE supplier_id=ANY($1::text[]) AND quote_request_id IS NULL AND base_price_minor>=0
    AND subcategory_code IN (SELECT code FROM taxonomy_subcategories WHERE category_code=$2) GROUP BY supplier_id`,
        [ids, categoryCode]
      )
    ).rows;
  const priceMap = new Map(prices.map((r) => [r.supplier_id, r.price]));
  const rows = selected.map(({ group, ...row }) => ({
    ...row,
    onTime: onTimeRate(clockStore, row.supplierId),
    fromPriceMinor: categoryCode
      ? (priceMap.get(row.supplierId) ?? null)
      : null,
  }));
  const nextCursor =
    candidates.length > page.limit
      ? encodeStaffCursor(page, last.supplierId, JSON.stringify(last))
      : null;
  const store = graph.finish();
  store[STAFF_LIST_PAGE] = {
    ids,
    rankTable: {
      categories,
      categoryCode,
      rankedCount: table.rankedCount,
      rows,
      nextCursor,
    },
  };
  return store;
}
