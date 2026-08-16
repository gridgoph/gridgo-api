import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

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

test("async work inherited from a completed transaction cannot reuse its released client", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  const deferred = Promise.withResolvers();
  let inheritedContext;

  await database.transaction(async () => {
    inheritedContext = deferred.promise.then(() => database.inTransaction());
  });

  deferred.resolve();
  assert.equal(await inheritedContext, false);
  await database.close();
});

test("an idle PostgreSQL connection loss is contained by the pool", { skip: !DATABASE_URL }, async () => {
  const script = `
    import pg from "pg";
    import { createDatabase } from "./src/database.js";
    const database = createDatabase(process.env);
    const killer = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const pid = (await database.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await killer.query("SELECT pg_terminate_backend($1)", [pid]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await database.query("SELECT 1");
    await Promise.all([database.close(), killer.end()]);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0, output);
});
