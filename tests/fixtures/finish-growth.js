import assert from 'node:assert/strict';

/** Clone declared columns only, preserving generated columns and every domain
 * constraint. SQL sources/overrides come exclusively from test code. */
export async function cloneFixtureRows(
  database,
  table,
  source,
  from,
  to,
  overrides
) {
  const columns = (
    await database.query(
      `SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`,
      [table]
    )
  ).rows.map((row) => row.column_name);
  const result = await database.query(
    `INSERT INTO ${table} (${columns.join(',')})
    SELECT ${columns.map((column) => `copy.${column}`).join(',')}
    FROM (SELECT * FROM ${table} original WHERE ${source} LIMIT 1) original
    CROSS JOIN generate_series($1::int,$2::int) i
    CROSS JOIN LATERAL jsonb_populate_record(NULL::${table},to_jsonb(original)||jsonb_build_object(${overrides})) copy`,
    [from, to]
  );
  assert.equal(result.rowCount, to - from + 1, `${table}: fixture template`);
}

/** A whole two-group basket, including both immutable order and payment
 * snapshots, commits together under the real deferred basket constraints. */
export async function growBasketFixtures(database, from, to) {
  const basket = "'basket_growth_'||lpad(i::text,7,'0')";
  const first = "'basket_first_'||lpad(i::text,7,'0')";
  const second = "'basket_second_'||lpad(i::text,7,'0')";
  const old = "'2000-01-01T00:00:00.000Z'";
  await database.transaction(async () => {
    for (const [template, key, position] of [
      ['a_active', first, 300000],
      ['m_offer', second, 500000],
    ]) {
      await cloneFixtureRows(
        database,
        'orders',
        `original.id='${template}'`,
        from,
        to,
        `'id',${key},'position',${position}+i,'created_at',${old}`
      );
      for (const code of ['initial', 'final_online']) {
        await cloneFixtureRows(
          database,
          'order_payments',
          `original.order_id='${template}' AND original.code='${code}'`,
          from,
          to,
          `'order_id',${key}`
        );
      }
      // The database validates collection allocation and immutable payout shares
      // at commit, so copy the complete financial snapshot with each group.
      const allocations = (
        await database.query(
          'SELECT payment_code,component FROM order_payment_allocations WHERE order_id=$1',
          [template]
        )
      ).rows;
      for (const row of allocations) {
        await cloneFixtureRows(
          database,
          'order_payment_allocations',
          `original.order_id='${template}' AND original.payment_code='${row.payment_code}' AND original.component='${row.component}'`,
          from,
          to,
          `'order_id',${key}`
        );
      }
      const stages = (
        await database.query(
          'SELECT code FROM payout_milestones WHERE order_id=$1',
          [template]
        )
      ).rows;
      for (const row of stages) {
        await cloneFixtureRows(
          database,
          'payout_milestones',
          `original.order_id='${template}' AND original.code='${row.code}'`,
          from,
          to,
          `'order_id',${key}`
        );
      }
    }
    await cloneFixtureRows(
      database,
      'order_baskets',
      "original.id='basket_staff'",
      from,
      to,
      `'id',${basket},'receipt_order_id',${first},'created_at',${old}`
    );
    await database.query(
      `INSERT INTO order_basket_groups(basket_id,order_id,position)
      SELECT ${basket},${first},0 FROM generate_series($1::int,$2::int)i
      UNION ALL SELECT ${basket},${second},1 FROM generate_series($1::int,$2::int)i`,
      [from, to]
    );
  });
}
