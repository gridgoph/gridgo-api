/** Destructive fixture benchmark. Only an isolated migrated *_test database. */
import './assert-test-database.mjs';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { parseStaffPage, encodeStaffCursor } from '../src/staff-list-pages.js';
import { loadHotReadStore } from '../src/postgres-store.js';
import { setupStaffDesks } from '../tests/fixtures/staff-desks.js';
import { parityApiForTest } from '../tests/fixtures/read-parity.js';
import { resetDatabase } from '../tests/fixtures/reset-database.js';
import { growBasketFixtures } from '../tests/fixtures/finish-growth.js';
import { instrument } from '../tests/fixtures/order-reads.js';
const database = createDatabase(process.env),
  cleanup = [];
const base = Number(process.env.PERF_BASE_ROWS || 10000),
  samples = Number(process.env.PERF_SAMPLES || 5);
assert.ok(
  Number.isSafeInteger(base) &&
    base >= 100 &&
    Number.isSafeInteger(samples) &&
    samples >= 3
);
const basketBase = Number(
  process.env.PERF_BASKET_BASE_ROWS || Math.min(base, 1000)
);
assert.ok(
  Number.isSafeInteger(basketBase) && basketBase >= 10 && basketBase <= base
);
const paths = [
  '/orders',
  '/baskets',
  '/issues',
  '/credits/balance?clientId=client',
  '/admin/promotions',
  '/admin/promotions?section=invites',
  '/admin/shop-rankings',
  '/ops/shops/supplier/performance',
  '/ops/reschedule-requests?supplierId=supplier',
];
const paged = (path) =>
  `${path}${path.includes('?') ? '&' : '?'}limit=${path.includes('/performance') ? 1 : 2}`;
const cases = paths.flatMap((path) => {
  const first = { label: path, path: paged(path) };
  if (path === '/admin/shop-rankings') return [first];
  const url = new URL(paged(path), 'http://test'),
    plan = parseStaffPage(url.pathname, url.searchParams);
  const prefix = path === '/baskets' ? 'basket_growth_' : 'finish_growth_';
  const id =
    prefix +
    String(Math.floor((path === '/baskets' ? basketBase : base) / 2)).padStart(
      7,
      '0'
    );
  url.searchParams.set(
    'cursor',
    encodeStaffCursor(plan, id, '2000-01-01T00:00:00.000Z')
  );
  return [first, { label: `${path} [deep]`, path: url.pathname + url.search }];
});
async function clone(table, source, from, to, overrides) {
  const columns = (
    await database.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position",
      [table]
    )
  ).rows.map((r) => r.column_name);
  const result = await database.query(
    `INSERT INTO ${table} (${columns.join(',')}) SELECT ${columns.map((c) => `copy.${c}`).join(',')} FROM
    (SELECT * FROM ${table} original WHERE ${source} LIMIT 1) original CROSS JOIN generate_series($1::int,$2::int)i
    CROSS JOIN LATERAL jsonb_populate_record(NULL::${table},to_jsonb(original)||jsonb_build_object(${overrides}))copy`,
    [from, to]
  );
  assert.equal(result.rowCount, to - from + 1, table);
}
const key = "'finish_growth_'||lpad(i::text,7,'0')",
  old = "'2000-01-01T00:00:00.000Z'";
async function grow(from, to) {
  // Each launch voucher has its own person, just as production requires.
  await clone(
    'users',
    "original.id='client'",
    from,
    to,
    `'id',${key},'clerk_user_id',${key},'email',${key}||'@example.test','position',20000+i,'created_at',${old}`
  );
  await database.query(
    `INSERT INTO user_role_memberships(user_id,role,created_at)
    SELECT ${key},'client',${old} FROM generate_series($1::int,$2::int)i`,
    [from, to]
  );
  await clone(
    'orders',
    "original.id='pickup_offer'",
    from,
    to,
    `'id',${key},'position',10000+i,'created_at',${old},'data',original.data||jsonb_build_object('rescheduleRequest',jsonb_build_object('supplierId','supplier','requestedAt',${old},'status','pending'))`
  );
  await clone(
    'issues',
    "original.id='issue_a_active'",
    from,
    to,
    `'id',${key},'order_id',${key},'claim_id',NULL,'position',10000+i,'created_at',${old}`
  );
  await clone(
    'supplier_performance_events',
    "original.supplier_id='supplier'",
    from,
    to,
    `'id',${key},'order_id',${key},'occurred_at',${old},'recorded_at',${old}`
  );
  await clone(
    'voucher_campaigns',
    "original.purpose='founding_tester'",
    from,
    to,
    `'id',${key},'code',${key},'created_at',${old}`
  );
  await clone(
    'vouchers',
    "original.promotion_kind='founding'",
    from,
    to,
    `'id',${key},'campaign_id',${key},'client_id',${key},'issued_at',${old},'status','used'`
  );
  await database.query(
    `INSERT INTO promotion_invites(id,founder_id,email,status,created_at)
    SELECT ${key},${key},'friend_'||${key}||'@example.test','invited',${old} FROM generate_series($1::int,$2::int)i`,
    [from, to]
  );
  await database.query(
    `INSERT INTO credit_ledger(id,user_id,amount_minor,balance_after_minor,created_at,position,data)
    SELECT ${key},'client',1,i,${old},10000+i,'{}' FROM generate_series($1::int,$2::int)i`,
    [from, to]
  );
  for (const [table, sql] of [
    [
      'notifications',
      `INSERT INTO notifications(id,user_id,type,created_at,position,data) SELECT ${key},'other','fixture',${old},10000+i,'{}'`,
    ],
    [
      'audit_log',
      `INSERT INTO audit_log(id,at,action,position,data) SELECT ${key},${old},'benchmark',10000+i,'{}'`,
    ],
    [
      'location_pings',
      `INSERT INTO location_pings(id,order_id,rider_id,lat,lng,at,position,data) SELECT ${key},'z_history','rider',7,125,${old},10000+i,'{}'`,
    ],
  ])
    await database.query(`${sql} FROM generate_series($1::int,$2::int)i`, [
      from,
      to,
    ]);
  await growBasketFixtures(
    database,
    Math.floor(((from - 1) / base) * basketBase) + 1,
    Math.floor((to / base) * basketBase)
  );
  await database.query(
    "UPDATE credit_accounts SET balance_minor=$1 WHERE user_id='client'",
    [to]
  );
  await database.query(
    `INSERT INTO notification_push_outbox(notification_id,device_id,user_id,status)
    SELECT ${key},'finish_device','other','delivered' FROM generate_series($1::int,$2::int)i`,
    [from, to]
  );
  await database.query('VACUUM (ANALYZE)');
}
async function budgets() {
  const result = {};
  for (const { label, path } of cases) {
    const url = new URL(path, 'http://test'),
      { db, queries } = instrument(database);
    await loadHotReadStore(db, 'clerk_admin', url.pathname, {
      searchParams: url.searchParams,
    });
    assert.ok(
      !queries.some((q) =>
        /FROM (notifications|audit_log|location_pings|notification_push_outbox)\b/.test(
          q.sql
        )
      ),
      path
    );
    result[label] = {
      queries: queries.length,
      rows: queries.reduce((n, q) => n + q.rows, 0),
    };
  }
  return result;
}
async function measure(api, readOutput) {
  const result = {};
  for (const { label, path } of cases) {
    const url = path;
    assert.equal((await api('admin', 'GET', url)).status, 200, path);
    await new Promise((resolve) => setTimeout(resolve, 50));
    readOutput();
    for (let i = 0; i < samples; i++)
      assert.equal((await api('admin', 'GET', url)).status, 200, path);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const times = [
      ...readOutput().matchAll(/\[gridgo-api\] GET (\S+) 200 (\d+)ms/g),
    ]
      .filter((m) => m[1] === path.split('?')[0])
      .map((m) => Number(m[2]))
      .sort((a, b) => a - b);
    assert.equal(times.length, samples, label);
    result[label] = {
      medianMs: times[Math.floor(samples / 2)],
      p95Ms: times[Math.ceil(samples * 0.95) - 1],
    };
  }
  return result;
}
const existingScale = Number(process.env.PERF_EXISTING_SCALE || 0);
try {
  if (!existingScale) {
    await resetDatabase(
      database,
      'TRUNCATE voucher_campaigns, staff_roles, season_windows, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE'
    );
    await setupStaffDesks(database);
    await database.query(
      "INSERT INTO credit_accounts(user_id,balance_minor,data) VALUES('client',0,'{}') ON CONFLICT DO NOTHING"
    );
    await database.query(`INSERT INTO device_tokens(id,user_id,token,platform,created_at,updated_at,position,data)
    VALUES('finish_device','other','finish_test_token','android',now(),now(),0,'{"appRole":"client"}')`);
  }
  let output = '';
  const api = await parityApiForTest(
    { after: (fn) => cleanup.push(fn) },
    false,
    Date.now() + 120000,
    {
      stableFixture: true,
      timing: true,
      onOutput: (chunk) => {
        output += chunk;
      },
    }
  );
  const readOutput = () => {
    const s = output;
    output = '';
    return s;
  };
  let before;
  const scales = existingScale
    ? [[existingScale, null, base * existingScale]]
    : process.env.PERF_MAX_SCALE === '1'
      ? [[1, 1, base]]
      : [
          [1, 1, base],
          [10, base + 1, base * 10],
        ];
  for (const [scale, from, to] of scales) {
    if (from !== null) await grow(from, to);
    const budget = await budgets();
    if (before)
      assert.deepEqual(
        budget,
        before,
        '10x history must keep all reader transfer/query budgets flat'
      );
    else before = budget;
    console.log(
      JSON.stringify({
        scale,
        historyRows: to,
        basketRows: scale * basketBase,
        samples,
        budget,
        timings: await measure(api, readOutput),
      })
    );
  }
} finally {
  for (const close of cleanup.reverse()) await close();
  await database.close();
}
