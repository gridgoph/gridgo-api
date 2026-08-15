import test from "node:test";
import assert from "node:assert/strict";

import { createDatabase } from "../src/database.js";

const DATABASE_URL = process.env.DATABASE_URL;

test("database transactions rollback and publish after commit only", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await database.assertReady();
  await database.query("DELETE FROM catalog_products WHERE id = $1", ["prod_transaction_test"]);

  const callbacks = [];
  await assert.rejects(
    database.transaction(async () => {
      await database.query(
        `INSERT INTO catalog_products
          (id, name, family, base_price_minor, unit, position, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["prod_transaction_test", "Rollback", "test", 1250, "each", 0, {}],
      );
      database.afterCommit(() => callbacks.push("rolled-back"));
      throw new Error("force rollback");
    }),
    /force rollback/,
  );

  assert.equal(
    Number((await database.query("SELECT count(*) AS count FROM catalog_products WHERE id = $1", ["prod_transaction_test"])).rows[0].count),
    0,
  );
  assert.deepEqual(callbacks, []);

  await database.transaction(async () => {
    await database.query(
      `INSERT INTO catalog_products
        (id, name, family, base_price_minor, unit, position, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["prod_transaction_test", "Committed", "test", 1250, "each", 0, {}],
    );
    database.afterCommit(() => callbacks.push("committed"));
  });

  assert.deepEqual(callbacks, ["committed"]);
  assert.equal(
    (await database.query("SELECT base_price_minor FROM catalog_products WHERE id = $1", ["prod_transaction_test"])).rows[0].base_price_minor,
    1250,
  );
  await database.query("DELETE FROM catalog_products WHERE id = $1", ["prod_transaction_test"]);
  await database.close();
});

test("mutation transactions serialize credit updates across database clients", { skip: !DATABASE_URL }, async () => {
  const first = createDatabase({ DATABASE_URL });
  const second = createDatabase({ DATABASE_URL });
  await first.assertReady();

  await first.query(
    `INSERT INTO users (id, clerk_user_id, email, name, role, account_type, created_at, position, data)
     VALUES ('user_concurrency_test', 'clerk_concurrency_test', 'concurrency@gridgo.test', 'Concurrency', 'client', 'individual', now(), 0, '{}')
     ON CONFLICT (id) DO NOTHING`,
  );
  await first.query(
    `INSERT INTO credit_accounts (user_id, balance_minor, data)
     VALUES ('user_concurrency_test', 0, '{}')
     ON CONFLICT (user_id) DO UPDATE SET balance_minor = 0`,
  );

  async function add(database, amount) {
    await database.transaction(async () => {
      const row = (await database.query(
        "SELECT balance_minor FROM credit_accounts WHERE user_id = 'user_concurrency_test'",
      )).rows[0];
      await new Promise((resolve) => setTimeout(resolve, 30));
      await database.query(
        "UPDATE credit_accounts SET balance_minor = $1 WHERE user_id = 'user_concurrency_test'",
        [row.balance_minor + amount],
      );
    });
  }

  await Promise.all([add(first, 100), add(second, 250)]);
  assert.equal(
    (await first.query("SELECT balance_minor FROM credit_accounts WHERE user_id = 'user_concurrency_test'")).rows[0].balance_minor,
    350,
  );

  await first.query("DELETE FROM credit_accounts WHERE user_id = 'user_concurrency_test'");
  await first.query("DELETE FROM users WHERE id = 'user_concurrency_test'");
  await Promise.all([first.close(), second.close()]);
});
