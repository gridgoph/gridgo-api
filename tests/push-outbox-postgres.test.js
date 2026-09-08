import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/database.js";
import { loadStore, saveStore } from "../src/postgres-store.js";
import {
  enqueueNotificationPushes,
  createOutboxWorker,
} from "../src/push-outbox.js";
const url = process.env.DATABASE_URL;
test(
  "PostgreSQL outbox commits atomically, retries transient send, and suppresses rebound devices",
  { skip: !url },
  async () => {
    const db = createDatabase({ DATABASE_URL: url });
    const prefix = `outbox_${Date.now()}`;
    const now = new Date().toISOString();
    let deviceId, notificationId;
    try {
      await db.transaction(async () => {
        const s = await loadStore(db);
        for (const suffix of ["a", "b"]) {
          const userId = prefix + suffix;
          s.users.push({
            id: userId,
            clerkUserId: userId,
            email: userId + "@test.invalid",
            name: "Test",
            role: "client",
            accountType: "individual",
            createdAt: now,
          });
          s.userRoleMemberships.push({
            userId,
            role: "client",
            createdAt: now,
          });
          s.clientProfiles.push({
            userId,
            clientKind: "personal",
            updatedAt: now,
          });
        }
        deviceId = prefix + "d";
        notificationId = prefix + "n";
        s.deviceTokens.push({
          id: deviceId,
          userId: prefix + "a",
          token: prefix + "token",
          platform: "android",
          appRole: "client",
          createdAt: now,
          updatedAt: now,
        });
        s.notifications.push({
          id: notificationId,
          userId: prefix + "a",
          type: "credit_updated",
          appRole: "client",
          title: "Credit changed",
          body: "private reason",
          at: now,
          read: false,
        });
        await saveStore(db, s);
        await enqueueNotificationPushes(db, s, [s.notifications.at(-1)]);
      });
      assert.equal(
        (
          await db.query(
            "SELECT status FROM notification_push_outbox WHERE notification_id=$1",
            [notificationId],
          )
        ).rows[0].status,
        "pending",
      );
      let calls = 0;
      const drain = createOutboxWorker({
        database: db,
        loadStore,
        delivery: {
          configured: true,
          send: async (message, devices) => {
            calls++;
            assert.equal(message.body, "Open GRIDGO for the latest update.");
            assert.equal(devices[0].id, deviceId);
            return [
              {
                ok: calls > 1,
                prune: false,
                code: calls === 1 ? "transport_error" : null,
              },
            ];
          },
        },
      });
      await drain();
      let row = (
        await db.query(
          "SELECT * FROM notification_push_outbox WHERE notification_id=$1",
          [notificationId],
        )
      ).rows[0];
      assert.equal(row.status, "pending");
      assert.equal(row.attempts, 1);
      await db.query(
        "UPDATE notification_push_outbox SET next_attempt_at=now() WHERE notification_id=$1",
        [notificationId],
      );
      await drain();
      row = (
        await db.query(
          "SELECT * FROM notification_push_outbox WHERE notification_id=$1",
          [notificationId],
        )
      ).rows[0];
      assert.equal(row.status, "delivered");
      assert.equal(calls, 2);
      // Simulate a dead worker's expired lease; a fresh worker retries from durable SQL.
      await db.query(
        "UPDATE notification_push_outbox SET status='sending',next_attempt_at=now()-interval '1 second' WHERE notification_id=$1",
        [notificationId],
      );
      const restarted = createOutboxWorker({
        database: db,
        loadStore,
        delivery: {
          configured: true,
          send: async () => {
            calls++;
            return [{ ok: true }];
          },
        },
      });
      await restarted();
      assert.equal(calls, 3);
      await db.query(
        "UPDATE notification_push_outbox SET status='pending',next_attempt_at=now() WHERE notification_id=$1",
        [notificationId],
      );
      await db.query("UPDATE device_tokens SET user_id=$2 WHERE id=$1", [
        deviceId,
        prefix + "b",
      ]);
      await drain();
      assert.equal(
        (
          await db.query(
            "SELECT status FROM notification_push_outbox WHERE notification_id=$1",
            [notificationId],
          )
        ).rows[0].status,
        "suppressed",
      );
      assert.equal(calls, 3);
      await assert.rejects(
        db.transaction(async () => {
          const s = await loadStore(db);
          const n = {
            id: prefix + "rollback",
            userId: prefix + "b",
            type: "general",
            title: "Test",
            body: "Test",
            at: now,
            read: false,
          };
          s.notifications.push(n);
          await saveStore(db, s);
          await enqueueNotificationPushes(db, s, [n]);
          throw new Error("rollback test");
        }),
      );
      assert.equal(
        (
          await db.query("SELECT 1 FROM notifications WHERE id=$1", [
            prefix + "rollback",
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await db.query(
            "SELECT 1 FROM notification_push_outbox WHERE notification_id=$1",
            [prefix + "rollback"],
          )
        ).rowCount,
        0,
      );
    } finally {
      await db.transaction(async () => {
        for (const table of [
          "notifications",
          "device_tokens",
          "client_profiles",
          "user_role_memberships",
        ])
          await db.query(`DELETE FROM ${table} WHERE user_id=ANY($1)`, [
            [prefix + "a", prefix + "b"],
          ]);
        await db.query("DELETE FROM users WHERE id=ANY($1)", [
          [prefix + "a", prefix + "b"],
        ]);
      });
      await db.close();
    }
  },
);
