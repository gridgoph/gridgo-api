import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/database.js";
import {
  loadStore,
  saveStore,
  originalDomainStore,
} from "../src/postgres-store.js";
import { createRealtimeTransport } from "../src/realtime-transport.js";
import {
  createNotificationEvents,
  queueInvalidate,
} from "../src/notifications.js";
const url = process.env.DATABASE_URL;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
test(
  "separate PostgreSQL listeners receive committed events once and never rollback notifications",
  { skip: !url },
  async () => {
    const db = createDatabase({ DATABASE_URL: url });
    const userId = `transport_${Date.now()}`;
    const at = new Date().toISOString();
    const eventsA = createNotificationEvents(),
      eventsB = createNotificationEvents();
    let rejectNextRead = false;
    const a = createRealtimeTransport({
        database: db,
        loadStore,
        events: eventsA,
        connectionString: url,
      }),
      b = createRealtimeTransport({
        database: db,
        loadStore: async (...args) => {
          if (rejectNextRead) {
            rejectNextRead = false;
            throw new Error("transient read failure");
          }
          return loadStore(...args);
        },
        logger: { warn() {} },
        events: eventsB,
        connectionString: url,
      });
    const seenA = [],
      seenB = [],
      hints = [];
    eventsA.subscribe(userId, (n) => seenA.push(n));
    eventsB.subscribe(userId, (n) => seenB.push(n));
    eventsB.subscribeInvalidate(userId, (hint) => hints.push(hint));
    try {
      await a.start();
      await b.start();
      await db.transaction(async () => {
        const s = await loadStore(db);
        s.users.push({
          id: userId,
          clerkUserId: userId,
          email: userId + "@test.invalid",
          name: "Transport",
          role: "client",
          accountType: "individual",
          createdAt: at,
        });
        s.userRoleMemberships.push({ userId, role: "client", createdAt: at });
        s.clientProfiles.push({
          userId,
          clientKind: "personal",
          updatedAt: at,
        });
        await saveStore(db, s);
      });
      await db.transaction(async () => {
        const s = await loadStore(db);
        const n = {
          id: userId + "n",
          userId,
          type: "general",
          title: "Committed",
          body: "safe",
          at,
          read: false,
        };
        s.notifications.push(n);
        queueInvalidate(s, { resource: "notifications", userIds: [userId] });
        await saveStore(db, s);
        await a.enqueue(s, [n]);
        assert.equal(seenA.length, 0);
        assert.equal(seenB.length, 0);
      });
      for (let i = 0; i < 100 && (!seenB.length || !hints.length); i++)
        await delay(20);
      assert.equal(seenA.length, 1);
      assert.equal(seenB.length, 1);
      assert.equal(seenB[0].title, "Committed");
      assert.deepEqual(hints, [{ resource: "notifications" }]);
      hints.length = 0;
      rejectNextRead = true;
      await db.transaction(async () => {
        const s = await loadStore(db);
        queueInvalidate(s, {
          resource: "orders",
          id: "private_pointer",
          userIds: [userId],
        });
        await a.enqueue(s, []);
      });
      for (
        let i = 0;
        i < 200 && !hints.some((h) => h.resource === "orders");
        i++
      )
        await delay(20);
      assert.ok(
        hints.some((h) => h.resource === "orders"),
        "failed remote reads recover even while subscribers stay connected",
      );
      assert.ok(
        hints.every((h) => !h.id),
        "recovery carries no stale private pointers",
      );
      await assert.rejects(
        db.transaction(async () => {
          const s = await loadStore(db);
          const n = {
            id: userId + "rollback",
            userId,
            type: "general",
            title: "Rollback",
            body: "safe",
            at,
            read: false,
          };
          s.notifications.push(n);
          await saveStore(db, s);
          await a.enqueue(s, [n]);
          throw new Error("abort");
        }),
      );
      await delay(100);
      assert.equal(seenA.length, 1);
      assert.equal(seenB.length, 1);
    } finally {
      await a.close();
      await b.close();
      await db.transaction(async () => {
        for (const table of [
          "notifications",
          "device_tokens",
          "client_profiles",
          "user_role_memberships",
        ])
          await db.query(`DELETE FROM ${table} WHERE user_id=ANY($1)`, [
            [userId],
          ]);
        await db.query("DELETE FROM users WHERE id=ANY($1)", [[userId]]);
      });
      await db.close();
    }
  },
);
