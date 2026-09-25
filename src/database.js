import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

const { Pool, types } = pg;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

types.setTypeParser(20, (value) => {
  const parsed = BigInt(value);
  if (parsed > MAX_SAFE_BIGINT || parsed < MIN_SAFE_BIGINT) {
    throw new RangeError("PostgreSQL bigint is outside JavaScript's safe integer range");
  }
  return Number(parsed);
});
types.setTypeParser(1184, (value) => new Date(value).toISOString());
types.setTypeParser(1082, (value) => value);

/** The advisory lock every credentialed platform mutation serializes on. */
export const DOMAIN_MUTATION_LOCK = "gridgo-domain-mutation";

function configurationError(message) {
  return new Error(`${message} Set DATABASE_URL to a PostgreSQL connection string and restart.`);
}

export function requireDatabaseUrl(env = process.env) {
  const value = String(env.DATABASE_URL || "").trim();
  if (!value) throw configurationError("DATABASE_URL is required.");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw configurationError("DATABASE_URL must be a valid PostgreSQL connection string.");
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw configurationError("DATABASE_URL must use the postgres or postgresql scheme.");
  }
  return value;
}

export function createDatabase(env = process.env) {
  const connectionString = requireDatabaseUrl(env);
  const context = new AsyncLocalStorage();
  const pool = new Pool({
    connectionString,
    max: Number(env.DATABASE_POOL_MAX || 10),
    connectionTimeoutMillis: Number(env.DATABASE_CONNECT_TIMEOUT_MS || 5_000),
    idleTimeoutMillis: Number(env.DATABASE_IDLE_TIMEOUT_MS || 30_000),
  });
  pool.on("error", (error) => {
    console.error(`PostgreSQL idle client error: ${error?.code || "unknown"}`);
  });

  function current() {
    const active = context.getStore();
    return active && !active.finished ? active : null;
  }

  async function query(text, values) {
    const active = current();
    return (active?.client || pool).query(text, values);
  }

  async function transaction(fn, { lockKey = DOMAIN_MUTATION_LOCK } = {}) {
    const active = current();
    if (active?.readOnly) throw new Error("Cannot start a write transaction inside a read-only database snapshot");
    if (active) return fn();

    const client = await pool.connect();
    const state = { client, afterCommit: [], rollbackOnly: false, readOnly: false, finished: false };
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
      const result = await context.run(state, fn);
      if (state.rollbackOnly) {
        await client.query("ROLLBACK");
        state.finished = true;
        return result;
      }
      await client.query("COMMIT");
      state.finished = true;
      for (const callback of state.afterCommit) {
        try {
          await callback();
        } catch (error) {
          console.warn(`post-commit callback failed: ${error?.message || "unknown"}`);
        }
      }
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the triggering failure. The pool discards a broken client.
      }
      state.finished = true;
      throw error;
    } finally {
      state.finished = true;
      client.release();
    }
  }

  async function snapshot(fn) {
    if (current()) return fn();
    const client = await pool.connect();
    const state = { client, afterCommit: [], rollbackOnly: false, readOnly: true, finished: false };
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await context.run(state, fn);
      await client.query("COMMIT");
      state.finished = true;
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the triggering failure.
      }
      state.finished = true;
      throw error;
    } finally {
      state.finished = true;
      client.release();
    }
  }

  function afterCommit(callback) {
    const active = current();
    if (!active || active.readOnly) throw new Error("afterCommit requires an active write transaction");
    active.afterCommit.push(callback);
  }

  function markRollback() {
    const active = current();
    if (active) active.rollbackOnly = true;
  }

  async function assertReady() {
    let result;
    try {
      result = await pool.query("SELECT to_regclass('public.platform_settings') AS settings_table");
    } catch {
      throw new Error("Database connection failed. Check DATABASE_URL and PostgreSQL availability, then restart.");
    }
    if (!result.rows[0]?.settings_table) {
      throw new Error("Database schema is missing. Run `npm run migrate` with this DATABASE_URL, then restart.");
    }
  }

  async function health() {
    try {
      await pool.query("SELECT 1");
      return { status: "available" };
    } catch {
      return { status: "unavailable" };
    }
  }

  return {
    query,
    transaction,
    snapshot,
    afterCommit,
    markRollback,
    assertReady,
    health,
    close: () => pool.end(),
    inTransaction: () => Boolean(current()),
    inWriteTransaction: () => Boolean(current() && !current().readOnly),
  };
}
