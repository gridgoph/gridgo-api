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
