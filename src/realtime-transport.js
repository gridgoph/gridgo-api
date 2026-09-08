import crypto from "node:crypto";
import pg from "pg";
import {
  takeQueuedInvalidates,
  invalidateAudienceIds,
  notificationVisible,
  INVALIDATE_RESOURCES,
} from "./notifications.js";
const CHANNEL = "gridgo_realtime_v1";
/** NOTIFY is issued in the domain transaction: PostgreSQL releases it only on commit. */
export function createRealtimeTransport({
  database,
  loadStore,
  events,
  connectionString,
  logger = console,
}) {
  const origin = crypto.randomUUID();
  let client = null;
  let timer = null;
  let stopped = false;
  let chain = Promise.resolve();
  let connectedBefore = false;
  async function receive(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      message.origin === origin ||
      !["notification", "invalidate"].includes(message.kind) ||
      !message.userId
    )
      return;
    if (!events.userIds().includes(message.userId)) return;
    const store = await loadStore(database);
    if (message.kind === "notification") {
      const n = store.notifications.find(
        (n) => n.id === message.notificationId,
      );
      if (notificationVisible(store, n, message.userId))
        events.publish(n, store);
    } else if (message.payload?.resource)
      events.publishInvalidate(message.userId, message.payload, store);
  }
  function reconnect() {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void start();
    }, 1000);
    timer.unref();
  }
  async function start() {
    if (stopped) return;
    const next = new pg.Client({
      connectionString,
      connectionTimeoutMillis: 5000,
    });
    client = next;
    next.on("notification", (message) => {
      chain = chain
        .then(() => receive(message.payload))
        .catch(async () => {
          logger.warn?.("realtime delivery could not refresh committed state");
          // Reconnect coalesces failed deliveries into a current-state collection
          // refresh, using the same bounded backoff as a lost LISTEN connection.
          // Never replay a private pointer from a projection that failed to load.
          await next.end().catch(() => {});
          reconnect();
        });
    });
    next.on("error", () => {
      void next.end().catch(() => {});
      reconnect();
    });
    next.on("end", reconnect);
    try {
      await next.connect();
      await next.query(`LISTEN ${CHANNEL}`);
      if (connectedBefore) {
        const store = await loadStore(database);
        for (const userId of events.userIds())
          for (const resource of INVALIDATE_RESOURCES)
            events.publishInvalidate(userId, { resource }, store);
      }
      connectedBefore = true;
    } catch {
      void next.end().catch(() => {});
      reconnect();
    }
  }
  async function enqueue(store, notifications) {
    const rows = notifications
      .filter((n) => n.push !== false)
      .map((n) => ({
        kind: "notification",
        userId: n.userId,
        notificationId: n.id,
      }));
    for (const event of takeQueuedInvalidates(store)) {
      const payload = {
        resource: event.resource,
        ...(event.id ? { id: event.id } : {}),
      };
      for (const userId of invalidateAudienceIds(store, event))
        rows.push({ kind: "invalidate", userId, payload });
    }
    for (const row of rows)
      await database.query("SELECT pg_notify($1,$2)", [
        CHANNEL,
        JSON.stringify({ ...row, origin }),
      ]);
    database.afterCommit(() => {
      for (const row of rows) {
        if (row.kind === "notification") {
          const n = notifications.find((n) => n.id === row.notificationId);
          if (notificationVisible(store, n, row.userId))
            events.publish(n, store);
        } else events.publishInvalidate(row.userId, row.payload, store);
      }
    });
  }
  async function close() {
    stopped = true;
    clearTimeout(timer);
    if (client) await client.end().catch(() => {});
    await chain;
  }
  return { start, enqueue, close };
}
