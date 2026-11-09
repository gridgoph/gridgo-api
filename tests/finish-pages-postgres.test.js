import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { setupStaffDesks } from './fixtures/staff-desks.js';
import { parityApiForTest } from './fixtures/read-parity.js';
import {
  loadHotReadStore,
  loadStore,
  saveStore,
} from '../src/postgres-store.js';
import { instrument } from './fixtures/order-reads.js';
import { STAFF_LIST_PAGE } from '../src/staff-list-pages.js';
const skip = !process.env.DATABASE_URL;
const baseline = 'd2c7e393f1add38f8a83066faa9d4a9f010e2dcc';
const paths = [
  '/orders',
  '/baskets',
  '/issues',
  '/credits/balance',
  '/admin/promotions',
  '/admin/shop-rankings',
  '/ops/shops/supplier/performance',
];
const add = (path, args) => {
  const u = new URL(path, 'http://test');
  for (const [k, v] of Object.entries(args)) u.searchParams.set(k, v);
  return u.pathname + u.search;
};
const sorted = (rows) =>
  [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const list = (body, route) => {
  const path = new URL(route, 'http://test').pathname;
  return path.includes('promotions')
    ? body.founding.claims
    : path.includes('performance')
      ? body.performance.events
      : body[
          path.includes('rankings')
            ? 'rows'
            : path.includes('balance')
              ? 'ledger'
              : path.slice(1)
        ];
};
async function fixture(db) {
  const store = await setupStaffDesks(db);
  const template = store.supplierPerformanceEvents.find(
    (row) => row.supplierId === 'supplier'
  );
  for (const [i, days] of [80, 55, 50, 20, 3, 2, 1, -1].entries())
    store.supplierPerformanceEvents.push({
      ...structuredClone(template),
      id: `finish_event_${i}`,
      sourceKey: `fixture:${i}`,
      kind: i % 2 ? 'timed_out' : 'late_finish',
      at: new Date(Date.now() - days * 86400000).toISOString(),
    });
  for (const [i, id] of [
    'finish_shop_z',
    'finish_shop_a',
    'finish_shop_é',
  ].entries()) {
    store.users.push({
      ...structuredClone(store.users.find((row) => row.id === 'supplier')),
      id,
      clerkUserId: `clerk_${id}`,
      email: `${i}@finish.test`,
      name: 'Same shop',
    });
    store.userRoleMemberships.push({
      userId: id,
      role: 'supplier',
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    if (i !== 1)
      store.supplierProfiles.push({
        ...structuredClone(store.supplierProfiles[0]),
        userId: id,
        shopName: 'Same shop',
      });
  }
  store.credits.client = {
    balanceMinor: 12345,
    ledger: Array.from({ length: 7 }, (_, i) => ({
      id: `finish_credit_${i}`,
      at: '2026-11-01T00:00:00.000Z',
      type: 'grant',
      amountMinor: 100,
      balanceAfterMinor: 100 * (i + 1),
    })),
  };
  await db.transaction(() => saveStore(db, store));
}
test(
  'finish lists retain actual-dev unpaged HTTP bytes across roles and review scopes',
  { skip },
  async (t) => {
    const db = createDatabase(process.env);
    t.after(() => db.close());
    await fixture(db);
    const at = Date.now() + 120000,
      old = await parityApiForTest(t, false, at, {
        sourceRef: baseline,
        stableFixture: true,
      }),
      current = await parityApiForTest(t, false, at, { stableFixture: true });
    let comparisons = 0;
    for (const who of [
      null,
      'client',
      'supplier',
      'rider',
      'ops',
      'admin',
      'test_ops',
      'dual',
      'staff',
    ])
      for (const path of [
        ...paths,
        '/orders?includeReviewData=1',
        '/admin/shop-rankings?categoryCode=printing',
        '/credits/balance?clientId=client',
      ]) {
        const a = await old(who, 'GET', path, null, { raw: true }),
          b = await current(who, 'GET', path, null, { raw: true });
        assert.equal(b.status, a.status, `${who} ${path}`);
        assert.equal(b.body, a.body, `${who} ${path}`);
        comparisons++;
      }
    t.diagnostic(`${comparisons} exact legacy HTTP comparisons`);
  }
);
test(
  'mixed and aggregate cursors cover complete projected lists and preserve all summaries',
  { skip },
  async (t) => {
    const db = createDatabase(process.env);
    t.after(() => db.close());
    await fixture(db);
    const api = await parityApiForTest(t, false, Date.now() + 120000, {
      stableFixture: true,
    });
    for (const who of [
      'client',
      'supplier',
      'rider',
      'ops',
      'admin',
      'test_ops',
    ])
      for (const path of [
        ...paths,
        '/orders?includeReviewData=1',
        '/admin/shop-rankings?categoryCode=marketing_collateral',
        '/admin/shop-rankings?includeReviewData=1',
        '/issues?status=open',
        '/credits/balance?clientId=client',
      ]) {
        const full = await api(who, 'GET', path);
        if (full.status !== 200) continue;
        let cursor,
          rows = [],
          count = 0;
        do {
          const page = await api(
            who,
            'GET',
            add(path, { limit: '2', ...(cursor ? { cursor } : {}) })
          );
          assert.equal(
            page.status,
            200,
            `${who} ${path}: ${JSON.stringify(page.body)}`
          );
          const values = list(page.body, path);
          assert.ok(
            Array.isArray(values),
            `${who} ${path}: ${JSON.stringify(page.body)}`
          );
          assert.ok(values.length <= 2, `${who} ${path}`);
          rows.push(...values);
          if (path.includes('balance'))
            assert.equal(page.body.balanceMinor, full.body.balanceMinor);
          if (path.includes('rankings'))
            assert.equal(page.body.rankedCount, full.body.rankedCount);
          if (path.includes('performance'))
            for (const key of ['counts', 'rosterReview', 'topPick', 'onTime'])
              assert.deepEqual(
                page.body.performance[key],
                full.body.performance[key],
                key
              );
          if (path.includes('promotions')) {
            for (const key of [
              'slots',
              'claimed',
              'available',
              'used',
              'expiredUnused',
            ])
              assert.equal(
                page.body.founding[key],
                full.body.founding[key],
                key
              );
            assert.deepEqual(page.body.budget, full.body.budget);
            assert.equal(
              page.body.friendPass.issued,
              full.body.friendPass.issued
            );
          }
          cursor = page.body.nextCursor;
          assert.ok(++count < 100, `${who} ${path}`);
        } while (cursor);
        assert.deepEqual(
          sorted(rows),
          sorted(list(full.body, path)),
          `${who} ${path}`
        );
        for (const bad of ['limit=0', 'limit=51', 'cursor=bad', 'cursor=']) {
          const result = await api(
            who,
            'GET',
            `${path}${path.includes('?') ? '&' : '?'}${bad}`
          );
          assert.equal(
            result.status,
            400,
            `${who} ${path} ${bad}: ${JSON.stringify(result.body)}`
          );
        }
      }
    const invites = await api('admin', 'GET', '/admin/promotions');
    let cursor,
      rows = [];
    do {
      const result = await api(
        'admin',
        'GET',
        add('/admin/promotions', {
          section: 'invites',
          limit: '1',
          ...(cursor ? { cursor } : {}),
        })
      );
      assert.equal(result.status, 200, JSON.stringify(result.body));
      rows.push(...result.body.friendPass.invites);
      cursor = result.body.nextCursor;
    } while (cursor);
    assert.deepEqual(sorted(rows), sorted(invites.body.friendPass.invites));
    for (const path of [
      '/admin/promotions/claims',
      '/admin/promotions/invites',
    ])
      assert.equal((await api('admin', 'GET', path + '?limit=1')).status, 404);
  }
);
test(
  'maintained request totals track bulk changes, reassignment, removals and rollback',
  { skip },
  async (t) => {
    const db = createDatabase(process.env);
    t.after(() => db.close());
    await fixture(db);
    const verify = async () => {
      const rows = (
        await db.query(`SELECT coalesce(to_jsonb(data#>>'{rescheduleRequest,supplierId}'),'null'::jsonb) AS key,review_data,count(*)::int AS n FROM orders
      WHERE data->'rescheduleRequest' IS NOT NULL AND data->'rescheduleRequest' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
      AND NOT EXISTS(SELECT 1 FROM order_removals r WHERE r.order_id=orders.id) GROUP BY 1,2`)
      ).rows;
      const all = new Map();
      for (const row of rows) {
        const k = JSON.stringify([row.key, row.review_data]);
        all.set(k, row.n);
        const global = JSON.stringify([{ all: true }, row.review_data]);
        all.set(global, (all.get(global) || 0) + row.n);
      }
      const counts = (
        await db.query(
          'SELECT supplier_key AS key,review_data,request_count::int AS n FROM reschedule_request_counts WHERE request_count>0'
        )
      ).rows;
      assert.deepEqual(
        new Map(
          counts.map((r) => [JSON.stringify([r.key, r.review_data]), r.n])
        ),
        all
      );
    };
    await verify();
    await db.query(
      "UPDATE orders SET supplier_id='replacement' WHERE id='a_active'"
    );
    await verify();
    await db.query(
      "UPDATE orders SET updated_at=now() WHERE id IN ('a_active','m_offer')"
    );
    await verify();
    await assert.rejects(
      db.transaction(async () => {
        await db.query('UPDATE orders SET updated_at=now()');
        throw new Error('rollback');
      }),
      /rollback/
    );
    await verify();
    await db.query(
      "INSERT INTO order_removals(order_id,removed_at,removed_by,reason) VALUES('a_active',now(),'admin','fixture')"
    );
    await verify();
    await assert.rejects(
      db.query("DELETE FROM order_removals WHERE order_id='a_active'"),
      /order removals are immutable/
    );
    await verify();
    await assert.rejects(
      db.query('UPDATE orders SET review_data=NOT review_data'),
      /review_data_snapshot_immutable/
    );
    await verify();
  }
);

test(
  'performance SQL summaries retain exemptions, Unicode reasons, microseconds and exact incident windows',
  { skip },
  async (t) => {
    const db = createDatabase(process.env);
    t.after(() => db.close());
    await fixture(db);
    const at = Date.now() + 120000,
      iso = new Date(at).toISOString();
    await db.transaction(async () => {
      const store = await loadStore(db),
        base = store.orders.find((row) => row.id === 'a_active'),
        line = store.orderLineItems.find((row) => row.orderId === 'a_active');
      const cases = [
        { kind: 'late_finish', minutes: 599 },
        { kind: 'late_finish', minutes: 600 },
        { kind: 'late_finish', minutes: 30, days: 2 },
        { kind: 'late_finish', express: true },
        { kind: 'declined', tight: true, reason: '\u2003' },
        { kind: 'declined', tight: true, reason: '\u2003valid\u2003' },
        { kind: 'late_finish', exemption: 'snapshot' },
        { kind: 'timed_out', noFault: true },
        { kind: 'late_finish', daysAgo: 30 },
        { kind: 'on_time_finish', daysAgo: 30, millisecond: 1 },
        { kind: 'timed_out', daysAgo: 2 },
        { kind: 'timed_out', daysAgo: 1 },
        { kind: 'timed_out', daysAgo: 0 },
        { kind: 'arrived_packed', daysAgo: 2 },
        { kind: 'arrived_packed', daysAgo: 1 },
        { kind: 'cancelled', daysAgo: 0 },
      ];
      for (const [i, value] of cases.entries()) {
        const id = `summary_order_${i}`;
        store.orders.push({
          ...structuredClone(base),
          id,
          ...(value.express ? { express: true } : {}),
          ...(value.tight ? { scheduling: { tightDeadline: true } } : {}),
        });
        store.orderLineItems.push({
          ...structuredClone(line),
          id: `summary_line_${i}`,
          orderId: id,
          jobId: null,
          turnaroundMinutesSnapshot: value.minutes ?? 1440,
          ...(value.days
            ? {
                turnaroundDaysSnapshot: value.days,
                productionDayMinutesSnapshot: 600,
              }
            : { turnaroundDaysSnapshot: undefined }),
        });
        store.supplierPerformanceEvents.push({
          id: `summary_event_${i}`,
          orderId: id,
          supplierId: 'supplier',
          sourceKey: 'summary',
          kind: value.kind,
          at: new Date(
            at - (value.daysAgo ?? 3) * 86400000 + (value.millisecond || 0)
          ).toISOString(),
          recordedAt: iso,
          reason: value.reason || 'Fixture',
          warningCodes: ['fixture'],
          exemption: value.exemption || null,
        });
        if (value.noFault)
          store.supplierPerformanceEvents.push({
            id: 'summary_future_no_fault',
            orderId: id,
            supplierId: 'supplier',
            sourceKey: 'no_fault',
            kind: 'no_fault',
            at: new Date(at + 86400000).toISOString(),
            recordedAt: iso,
            reason: 'Future record retained for legacy exemption parity',
          });
      }
      await saveStore(db, store);
    });
    await db.query(
      "INSERT INTO supplier_performance_events(id,order_id,supplier_id,source_key,kind,occurred_at,recorded_at,data) VALUES('summary_microsecond','summary_order_12','supplier','microsecond','timed_out',$1::timestamptz+interval '0.0009 second',$1,'{}')",
      [iso]
    );
    const api = await parityApiForTest(t, false, at, { stableFixture: true });
    const path = '/ops/shops/supplier/performance',
      full = await api('admin', 'GET', path);
    assert.equal(full.status, 200);
    let cursor,
      events = [],
      notices = [],
      warnings = [];
    do {
      const page = await api(
        'admin',
        'GET',
        add(path, { limit: '3', ...(cursor ? { cursor } : {}) })
      );
      assert.equal(page.status, 200, JSON.stringify(page.body));
      for (const key of ['counts', 'topPick', 'onTime', 'rosterReview'])
        assert.deepEqual(
          page.body.performance[key],
          full.body.performance[key],
          key
        );
      events.push(...page.body.performance.events);
      notices.push(...page.body.performance.notices);
      warnings.push(...page.body.performance.warnings);
      cursor = page.body.nextCursor;
    } while (cursor);
    assert.deepEqual(sorted(events), sorted(full.body.performance.events));
    assert.deepEqual(sorted(notices), sorted(full.body.performance.notices));
    assert.deepEqual(sorted(warnings), sorted(full.body.performance.warnings));
  }
);

test(
  'ranked pages retain global rounded scores, ties, category subjects, prices and on-time rates',
  { skip },
  async (t) => {
    const db = createDatabase(process.env);
    t.after(() => db.close());
    await fixture(db);
    await db.transaction(async () => {
      const store = await loadStore(db),
        base = store.orders.find((row) => row.id === 'a_active'),
        line = store.orderLineItems.find((row) => row.orderId === 'a_active');
      const reviews = [];
      const suppliers = [
        'supplier',
        'replacement',
        'finish_shop_z',
        'finish_shop_é',
        'finish_shop_a',
      ];
      for (const [shop, supplierId] of suppliers.entries())
        for (let i = 0; i < (shop < 2 ? 7 : 3); i++) {
          const orderId = `ranked_order_${shop}_${i}`;
          store.orders.push({
            ...structuredClone(base),
            id: orderId,
            supplierId,
            state: 'completed',
            readyAt:
              i % 2 ? '2026-10-11T00:00:00.000Z' : '2026-10-09T00:00:00.000Z',
            completedAt: '2026-10-12T00:00:00.000Z',
          });
          // Full decoding compares sort order as strings. The first resolved
          // catalogue item must remain the subject, even with a leading null.
          for (const [position, source] of [
            [0, null],
            [10, 'item_supplier'],
            [2, 'item_replacement'],
          ])
            store.orderLineItems.push({
              ...structuredClone(line),
              id: `ranked_line_${shop}_${i}_${position}`,
              orderId,
              jobId: null,
              sourceCatalogItemId: source,
              sortOrder: position,
            });
          reviews.push({
            id: `ranked_review_${shop}_${i}`,
            orderId,
            supplierId,
            clientId: 'client',
            qualityStars: shop < 2 ? 5 - (i % 3) : 4,
            speedStars: shop < 2 ? 3 + (i % 2) : 4,
            valueStars: 4,
            createdAt: '2026-10-12T00:00:00.000Z',
          });
        }
      await saveStore(db, store);
      store.shopReviews.push(...reviews);
      await saveStore(db, store);
    });
    const api = await parityApiForTest(t, false, Date.now() + 120000, {
      stableFixture: true,
    });
    for (const who of ['admin', 'ops'])
      for (const query of [
        '',
        '?categoryCode=marketing_collateral',
        '?includeReviewData=1',
      ]) {
        const path = '/admin/shop-rankings' + query,
          full = await api(who, 'GET', path);
        assert.equal(full.status, 200, JSON.stringify(full.body));
        let cursor,
          rows = [];
        do {
          const page = await api(
            who,
            'GET',
            add(path, { limit: '2', ...(cursor ? { cursor } : {}) })
          );
          assert.equal(page.status, 200, JSON.stringify(page.body));
          assert.equal(page.body.rankedCount, full.body.rankedCount);
          rows.push(...page.body.rows);
          cursor = page.body.nextCursor;
        } while (cursor);
        assert.deepEqual(rows, full.body.rows, `${who} ${path}`);
        if (who !== 'test_ops') assert.ok(full.body.rankedCount >= 5);
      }
    assert.equal(
      (await api('test_ops', 'GET', '/admin/shop-rankings?limit=2')).status,
      403
    );
    const first = await api('admin', 'GET', '/admin/shop-rankings?limit=2');
    assert.equal(
      (
        await api(
          'admin',
          'GET',
          add('/admin/shop-rankings', {
            limit: '2',
            categoryCode: 'marketing_collateral',
            cursor: first.body.nextCursor,
          })
        )
      ).body.error,
      'invalid_cursor'
    );
  }
);

test(
  'invalid order page parameters reject before selecting any candidate orders',
  { skip },
  async (t) => {
    const db = createDatabase(process.env);
    t.after(() => db.close());
    await fixture(db);
    for (const limit of ['', '0', 'abc', '51']) {
      const { db: traced, queries } = instrument(db);
      const store = await loadHotReadStore(traced, 'clerk_client', '/orders', {
        searchParams: new URLSearchParams({ limit }),
      });
      assert.equal(store[STAFF_LIST_PAGE].error.code, 'invalid_limit');
      assert.ok(!queries.some((query) => /FROM orders\b/.test(query.sql)));
    }
  }
);
