import test from "node:test";
import assert from "node:assert/strict";
import {
  outboxVerdict,
  retryAt,
  deviceAcceptsNotification,
} from "../src/push-outbox.js";
test("retry is bounded exponentially and transient failures retain delivery", () => {
  assert.equal(retryAt(1, 0), 30000);
  assert.equal(retryAt(20, 0), 3600000);
  assert.equal(
    outboxVerdict(
      { attempts: 1, expiresAt: 100000 },
      [{ ok: false, prune: false }],
      0,
    ),
    "pending",
  );
  assert.equal(
    outboxVerdict({ attempts: 8, expiresAt: 100000 }, [{ ok: false }], 0),
    "failed",
  );
  assert.equal(outboxVerdict({ attempts: 1, expiresAt: 1 }, [], 2), "expired");
  assert.equal(
    outboxVerdict({ attempts: 1, expiresAt: 100000 }, [{ ok: true }], 0),
    "delivered",
  );
});
test("app-role routing and changed device ownership never widen notification access", () => {
  const s = {
    users: [{ id: "u" }],
    userRoleMemberships: [
      { userId: "u", role: "supplier" },
      { userId: "u", role: "rider" },
    ],
    approvalCases: [],
  };
  const n = { userId: "u", appRole: "supplier" };
  assert.equal(
    deviceAcceptsNotification(s, { userId: "u", appRole: "rider" }, n),
    false,
  );
  assert.equal(
    deviceAcceptsNotification(s, { userId: "u", appRole: "supplier" }, n),
    true,
  );
  assert.equal(deviceAcceptsNotification(s, { userId: "other" }, n), false);
});
test("safe own-account role-change push reaches the removed role app without reviving order access", () => {
  const s = {
    users: [{ id: "u" }],
    userRoleMemberships: [{ userId: "u", role: "client" }],
  };
  const d = { userId: "u", appRole: "rider" };
  assert.equal(
    deviceAcceptsNotification(s, d, { userId: "u", type: "role_changed" }),
    true,
  );
  assert.equal(
    deviceAcceptsNotification(s, d, {
      userId: "u",
      type: "role_changed",
      orderId: "private",
    }),
    false,
  );
});

function workerFixture(count) {
  const at = Date.parse("2026-09-15T00:00:00Z");
  const rows = Array.from({ length: count }, (_, i) => ({
    id: i, notification_id: `n${i}`, device_id: `d${i}`, user_id: "u",
    attempts: 1, expires_at: new Date(at + 3600000).toISOString(),
  }));
  const store = {
    users: [{ id: "u" }], userRoleMemberships: [{ userId: "u", role: "client" }],
    notifications: rows.map((r) => ({ id: r.notification_id, userId: "u", appRole: "client", type: "credit_updated", title: "Credit", at: new Date(at).toISOString() })),
    deviceTokens: rows.map((r) => ({ id: r.device_id, userId: "u", appRole: "client", token: `token-${r.id}` })),
  };
  const batches = [];
  for (let i = 0; i < rows.length; i += 25) batches.push(rows.slice(i, i + 25));
  const completed = new Map();
  const pruned = [];
  const lostLeases = new Set();
  let claims = 0;
  let domainMutation = Promise.resolve();
  const database = {
    transaction: async (mutation, { lockKey = "gridgo-domain-mutation" } = {}) => {
      if (lockKey === "gridgo-push-outbox-claim") {
        claims += 1;
        return { rows: batches.shift() || [] };
      }
      const previous = domainMutation;
      let release;
      domainMutation = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        return await mutation();
      } finally {
        release();
      }
    },
    query: async (_sql, values) => {
      if (!values) return { rowCount: 0, rows: [] };
      if (values.length === 2) return { rowCount: lostLeases.has(values[0]) ? 0 : 1 };
      if (values.length === 5) {
        const [id, status, nextAttemptAt, code, attempts] = values;
        completed.set(id, { status, nextAttemptAt, code, attempts });
        return { rowCount: 1 };
      }
      pruned.push(values);
      return { rowCount: 1 };
    },
  };
  return { database, store, batches, completed, pruned, lostLeases, clock: () => at, claims: () => claims };
}

test("outbox bounds concurrent sends and drains multiple batches in one invocation", async () => {
  const { createOutboxWorker } = await import("../src/push-outbox.js");
  const f = workerFixture(61);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let peak = 0;
  const sent = [];
  const drain = createOutboxWorker({
    ...f, loadStore: async () => f.store,
    delivery: { configured: true, send: async (_message, [device]) => {
      active += 1;
      peak = Math.max(peak, active);
      sent.push(device.id);
      await gate;
      active -= 1;
      return [{ deviceId: device.id, ok: true }];
    } },
  });
  const pending = drain();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(active, 10);
    assert.equal(f.claims(), 1);
    await drain();
    assert.equal(f.claims(), 1);
  } finally {
    release();
    await pending;
  }
  assert.equal(peak, 10);
  assert.equal(sent.length, 61);
  assert.equal(new Set(sent).size, 61);
  assert.equal(f.completed.size, 61);
  assert.ok([...f.completed.values()].every((r) => r.status === "delivered"));
  // Three batches, the empty claim that ends the pass, and one re-pass asked
  // for by the drain() that landed mid-flight.
  assert.equal(f.claims(), 5);
});

test("a drain kicked mid-flight re-passes once and sends rows committed after the last claim", async () => {
  const { createOutboxWorker } = await import("../src/push-outbox.js");
  const f = workerFixture(26);
  // The fixture queues 25 + 1. Hold the last row back: it "commits" only after
  // the running drain's claim has already come back empty.
  const lateBatch = f.batches.pop();
  const claim = f.database.transaction;
  const kicks = [];
  let drain;
  f.database.transaction = async (mutation, options = {}) => {
    const result = await claim(mutation, options);
    if (options.lockKey === "gridgo-push-outbox-claim" && !result.rows.length && lateBatch.length) {
      f.batches.push(lateBatch.splice(0));
      // The committing request kicks while this drain is still busy.
      kicks.push(drain());
    }
    return result;
  };
  const sent = [];
  let loads = 0;
  drain = createOutboxWorker({
    ...f,
    loadStore: async () => { loads += 1; return f.store; },
    delivery: { configured: true, send: async (_message, [device]) => {
      sent.push(device.id);
      return [{ deviceId: device.id, ok: true }];
    } },
  });
  await drain();
  await Promise.all(kicks);
  assert.equal(kicks.length, 1);
  assert.equal(sent.length, 26);
  assert.equal(new Set(sent).size, 26, "no row is sent twice");
  // Batch of 25, empty claim (kick lands), re-pass claims the late row, empty.
  assert.equal(f.claims(), 4);
  // One store snapshot per claimed batch, never one per row.
  assert.equal(loads, 2);
});

test("the store is loaded once per claimed batch, not once per outbox row", async () => {
  const { createOutboxWorker } = await import("../src/push-outbox.js");
  const f = workerFixture(61);
  let loads = 0;
  const drain = createOutboxWorker({
    ...f,
    loadStore: async () => { loads += 1; return f.store; },
    delivery: { configured: true, send: async (_message, [device]) => [{ deviceId: device.id, ok: true }] },
  });
  await drain();
  assert.equal(f.completed.size, 61);
  assert.equal(loads, 3);
});

test("an idle drain() with push unconfigured neither loads the store nor claims", async () => {
  const { createOutboxWorker } = await import("../src/push-outbox.js");
  const f = workerFixture(3);
  let loads = 0;
  const drain = createOutboxWorker({
    ...f,
    loadStore: async () => { loads += 1; return f.store; },
    delivery: { configured: false, send: async () => assert.fail("must not send") },
  });
  await drain();
  assert.equal(loads, 0);
  assert.equal(f.claims(), 0);
});

test("concurrent outbox retries failed sends and rechecks ownership and leases", async () => {
  const { createOutboxWorker } = await import("../src/push-outbox.js");
  const f = workerFixture(30);
  f.store.deviceTokens[1].userId = "rebound-owner";
  f.lostLeases.add(2);
  const sent = [];
  const drain = createOutboxWorker({
    ...f, loadStore: async () => f.store,
    delivery: { configured: true, send: async (_message, [device]) => {
      sent.push(device.id);
      if (device.id === "d0") throw new Error("provider unavailable");
      if (device.id === "d3") return [{ deviceId: device.id, ok: false, prune: true, code: "BadDeviceToken" }];
      return [{ deviceId: device.id, ok: true }];
    } },
  });
  await drain();
  assert.equal(sent.length, 28);
  assert.equal(sent.includes("d1"), false);
  assert.equal(sent.includes("d2"), false);
  assert.deepEqual(f.completed.get(0), {
    status: "pending", nextAttemptAt: new Date(f.clock() + 30000).toISOString(), code: "transport_error", attempts: 1,
  });
  assert.equal(f.completed.get(1).status, "suppressed");
  assert.equal(f.completed.has(2), false);
  assert.equal(f.completed.get(3).status, "suppressed");
  assert.deepEqual(f.pruned, [["d3", "u", "token-3"]]);
  assert.equal(f.completed.get(29).status, "delivered");
  assert.equal(f.claims(), 3);
});

test("token pruning waits for an in-flight domain mutation to commit", async () => {
  const { createOutboxWorker } = await import("../src/push-outbox.js");
  const f = workerFixture(1);
  let releaseMutation;
  const gate = new Promise((resolve) => { releaseMutation = resolve; });
  let committed = false;
  let sent = false;
  const mutation = f.database.transaction(async () => {
    const device = f.store.deviceTokens[0];
    await gate;
    assert.equal(f.pruned.length, 0);
    assert.equal(device.id, "d0");
    committed = true;
  });
  const drain = createOutboxWorker({
    ...f,
    loadStore: async () => f.store,
    delivery: {
      configured: true,
      send: async () => {
        sent = true;
        return [{ deviceId: "d0", ok: false, prune: true, code: "BadDeviceToken" }];
      },
    },
  });
  const pending = drain();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent, true);
    assert.equal(committed, false);
    assert.deepEqual(f.pruned, []);
  } finally {
    releaseMutation();
    await Promise.all([mutation, pending]);
  }
  assert.equal(committed, true);
  assert.deepEqual(f.pruned, [["d0", "u", "token-0"]]);
});
