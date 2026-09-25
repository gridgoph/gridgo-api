import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createDatabase } from "../src/database.js";
import { loadStore, saveStore } from "../src/postgres-store.js";
import { createPushDelivery } from "../src/push.js";
import { createApnsDelivery, routePushDelivery } from "../src/apns.js";
import { createTokenValidator } from "../src/push-token-validation.js";

const url = process.env.DATABASE_URL;

/** A throwaway keypair and a fake Google: nothing leaves the process. */
function mockedFcm(verdictFor) {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credentials = {
    projectId: "gridgo-test",
    clientEmail: "push-test@gridgo-test.iam.gserviceaccount.com",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    tokenUri: "https://oauth2.example.test/token",
  };
  const bodies = [];
  const fetch = async (target, init) => {
    if (target === credentials.tokenUri)
      return { ok: true, status: 200, json: async () => ({ access_token: "ya29.test", expires_in: 3600 }) };
    const body = JSON.parse(init.body);
    bodies.push(body);
    const [status, payload] = verdictFor(body.message.token);
    return { ok: status < 300, status, json: async () => payload };
  };
  const fcm = createPushDelivery({}, { credentials, fetch, logger: { warn() {} } });
  return { delivery: routePushDelivery(fcm, createApnsDelivery({})), bodies, fcm };
}

const gone = [404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }];
const foreign = [403, { error: { status: "PERMISSION_DENIED", details: [{ errorCode: "SENDER_ID_MISMATCH" }] } }];
const payloadBug = [400, { error: { status: "INVALID_ARGUMENT", details: [{ fieldViolations: [{ field: "message.data" }] }] } }];
const accepted = [200, { name: "projects/gridgo-test/messages/fake" }];

test("stale-token sweep dry-runs FCM registrations, prunes the dead, records the rest, and rests until due",
  { skip: !url }, async () => {
    const db = createDatabase({ DATABASE_URL: url });
    const prefix = `check_${Date.now()}`;
    const at = new Date().toISOString();
    const userId = `${prefix}_user`;
    const tok = (name) => `${prefix}_${name}`;
    try {
      // The sweep reads every due registration, so start from none.
      await db.query("DELETE FROM device_tokens");
      await db.transaction(async () => {
        const s = await loadStore(db);
        s.users.push({ id: userId, clerkUserId: userId, email: `${userId}@test.invalid`, name: "Test", role: "client", accountType: "individual", createdAt: at });
        s.userRoleMemberships.push({ userId, role: "client", createdAt: at });
        s.clientProfiles.push({ userId, clientKind: "personal", updatedAt: at });
        const device = (name, extra = {}) => ({
          id: `${prefix}_${name}`, userId: null, token: tok(name), platform: "android",
          tokenProvider: "fcm", createdAt: at, updatedAt: at, ...extra,
        });
        s.deviceTokens.push(
          device("live", { userId, appRole: "client" }),
          device("gone", { userId, appRole: "client" }),
          device("foreign"),
          device("payload"),
          device("fresh"),
          device("apns", { platform: "ios", tokenProvider: "apns", token: "a".repeat(64) }),
        );
        await saveStore(db, s);
      });
      // Checked an hour ago: not due for another 23 hours.
      await db.query(
        "INSERT INTO device_token_checks(device_id, checked_at) VALUES ($1, now() - interval '1 hour')",
        [`${prefix}_fresh`],
      );
      const { delivery, bodies, fcm } = mockedFcm((token) =>
        token === tok("gone") ? gone : token === tok("foreign") ? foreign : token === tok("payload") ? payloadBug : accepted,
      );
      const infos = [];
      const sleeps = [];
      const validate = createTokenValidator({
        database: db,
        delivery,
        batchSize: 2,
        pauseMs: 250,
        sleep: async (ms) => { sleeps.push(ms); },
        logger: { info: (line) => infos.push(line), warn() {} },
      });
      const totals = await validate();
      assert.deepEqual(totals, { checked: 4, pruned: 2, failed: 1 });
      // Small bursts with a pause between them.
      assert.deepEqual(sleeps, [250, 250]);
      assert.equal(bodies.length, 4);
      assert.ok(bodies.every((b) => b.validate_only === true));
      assert.ok(bodies.every((b) => JSON.stringify(b.message.data) === '{"type":"announcement"}'));
      assert.deepEqual(bodies.map((b) => b.message.token).sort(), [tok("foreign"), tok("gone"), tok("live"), tok("payload")].sort());
      assert.deepEqual(infos, ["push token validation checked=4 pruned=2 failed=1"]);

      const remaining = (await db.query("SELECT id FROM device_tokens ORDER BY id")).rows.map((r) => r.id);
      assert.deepEqual(remaining, [`${prefix}_apns`, `${prefix}_fresh`, `${prefix}_live`, `${prefix}_payload`]);
      const checks = Object.fromEntries(
        (await db.query("SELECT device_id, last_code FROM device_token_checks")).rows.map((r) => [r.device_id, r.last_code]),
      );
      // A payload bug is not a dead phone: kept, with the code recorded.
      assert.deepEqual(checks, { [`${prefix}_live`]: null, [`${prefix}_payload`]: "INVALID_ARGUMENT", [`${prefix}_fresh`]: null });
      assert.equal(fcm.health().sentSinceBoot, false);

      // Nothing is due again until the age runs out.
      assert.deepEqual(await validate(), { checked: 0, pruned: 0, failed: 0 });
      assert.equal(bodies.length, 4);
      assert.equal(infos.length, 1);

      // A pass is bounded, and a whole batch of provider refusals stops it early.
      await db.query("UPDATE device_token_checks SET checked_at = now() - interval '2 days'");
      const down = mockedFcm(() => [503, { error: { status: "UNAVAILABLE" } }]);
      const warnings = [];
      const bounded = createTokenValidator({
        database: db, delivery: down.delivery, batchSize: 2, maxPerPass: 3, pauseMs: 0,
        logger: { info() {}, warn: (line) => warnings.push(line) },
      });
      assert.deepEqual(await bounded(), { checked: 2, pruned: 0, failed: 2 });
      assert.equal(down.bodies.length, 2);
      assert.match(warnings[0], /stopped early.*UNAVAILABLE/);
    } finally {
      await db.query("DELETE FROM device_tokens WHERE id LIKE $1", [`${prefix}_%`]);
      await db.transaction(async () => {
        for (const table of ["client_profiles", "user_role_memberships"])
          await db.query(`DELETE FROM ${table} WHERE user_id=$1`, [userId]);
        await db.query("DELETE FROM users WHERE id=$1", [userId]);
      });
      await db.close();
    }
  });

test("the sweep does nothing when push is not configured", async () => {
  const validate = createTokenValidator({
    database: { query: async () => assert.fail("must not read") },
    delivery: { configured: false, validate: async () => assert.fail("must not validate") },
  });
  assert.equal(await validate(), null);
});
