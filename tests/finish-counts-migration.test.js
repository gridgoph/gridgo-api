import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { up } from '../migrations/1794217000000_reschedule_request_counts.js';
const skip = !process.env.DATABASE_URL;

test(
  'request counts initialize populated data and track all source DML, cascades, truncates and rollback',
  { skip },
  async (t) => {
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL,
    });
    await client.connect();
    const schema = `finish_counts_${process.pid}`;
    t.after(async () => {
      await client.query('ROLLBACK');
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    });
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
    CREATE TABLE orders(id text PRIMARY KEY,data jsonb NOT NULL,review_data boolean NOT NULL);
    CREATE TABLE order_removals(order_id text PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE);
    INSERT INTO orders VALUES
      ('a','{"rescheduleRequest":{"supplierId":"supplier","status":"pending"}}',false),
      ('b','{"rescheduleRequest":{"supplierId":"supplier","status":"accepted"}}',true),
      ('removed','{"rescheduleRequest":{"supplierId":"replacement"}}',false),
      ('falsy','{"rescheduleRequest":false}',false),('empty','{}',false),
      ('number','{"rescheduleRequest":{"supplierId":123}}',false),
      ('unknown','{"rescheduleRequest":{}}',false);
    INSERT INTO order_removals VALUES('removed');`);
    const statements = [];
    await up({ sql: (sql) => statements.push(sql) });
    await client.query('BEGIN');
    for (const sql of statements) await client.query(sql);
    await client.query('COMMIT');
    const verify = async () => {
      const expected = (
        await client.query(`SELECT coalesce(to_jsonb(data#>>'{rescheduleRequest,supplierId}'),'null'::jsonb) AS key,review_data,count(*)::int AS n
      FROM orders WHERE data->'rescheduleRequest' IS NOT NULL
        AND data->'rescheduleRequest' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
        AND NOT EXISTS(SELECT 1 FROM order_removals r WHERE r.order_id=orders.id) GROUP BY 1,2`)
      ).rows;
      const all = new Map();
      for (const row of expected) {
        all.set(JSON.stringify([row.key, row.review_data]), row.n);
        const global = JSON.stringify([{ all: true }, row.review_data]);
        all.set(global, (all.get(global) || 0) + row.n);
      }
      const actual = (
        await client.query(
          'SELECT supplier_key AS key,review_data,request_count::int AS n FROM reschedule_request_counts WHERE request_count>0'
        )
      ).rows;
      assert.deepEqual(
        new Map(
          actual.map((row) => [
            JSON.stringify([row.key, row.review_data]),
            row.n,
          ])
        ),
        all
      );
    };
    await verify();
    await client.query(
      `INSERT INTO orders VALUES ('new_a','{"rescheduleRequest":{"supplierId":"supplier"}}',false),('new_b','{"rescheduleRequest":{"supplierId":"other"}}',true)`
    );
    await verify();
    await client.query(
      `UPDATE orders SET data=jsonb_set(data,'{rescheduleRequest,supplierId}','"changed"'),review_data=NOT review_data WHERE id IN ('a','b')`
    );
    await verify();
    await client.query(
      `UPDATE orders SET data=data-'rescheduleRequest' WHERE id='new_a'; DELETE FROM orders WHERE id='new_b'`
    );
    await verify();
    await client.query(
      `INSERT INTO order_removals VALUES('a'); UPDATE order_removals SET order_id='b' WHERE order_id='a'`
    );
    await verify();
    await client.query(
      `DELETE FROM order_removals WHERE order_id='b'; DELETE FROM orders WHERE id='removed'`
    );
    await verify();
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM orders; INSERT INTO orders VALUES ('rollback','{"rescheduleRequest":{}}',false)`
    );
    await verify();
    await client.query('ROLLBACK');
    await verify();
    await client.query(
      `INSERT INTO order_removals VALUES('a'); TRUNCATE order_removals`
    );
    await verify();
    await client.query('TRUNCATE orders CASCADE');
    await verify();
  }
);
