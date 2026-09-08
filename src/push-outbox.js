import { notificationVisible } from "./notifications.js";
import { pushMessageFor } from "./push.js";
export function retryAt(attempts, at) {
  return at + Math.min(3600000, 30000 * 2 ** Math.max(0, attempts - 1));
}
export function outboxVerdict(row, results, at) {
  if (Number(new Date(row.expiresAt)) <= at) return "expired";
  if (results.some((r) => r.ok)) return "delivered";
  if (results.some((r) => r.prune)) return "suppressed";
  return row.attempts >= 8 ? "failed" : "pending";
}
export function deviceAcceptsNotification(store, device, notification) {
  // A removed membership must not strand the only installed app without the
  // generic access-change notice. This exception never carries an order/case.
  if (
    device.userId === notification.userId &&
    notification.type === "role_changed" &&
    !notification.orderId &&
    !notification.approvalCaseId
  )
    return notificationVisible(store, notification, notification.userId);
  return (
    device.userId === notification.userId &&
    (!device.appRole ||
      !notification.appRole ||
      device.appRole === notification.appRole) &&
    notificationVisible(
      store,
      notification,
      notification.userId,
      device.appRole,
    )
  );
}
/** Written inside the domain mutation, after notification rows exist. No token material is copied. */
export async function enqueueNotificationPushes(
  database,
  store,
  notifications,
) {
  for (const n of notifications) {
    if (n.push === false || !notificationVisible(store, n, n.userId)) continue;
    for (const d of store.deviceTokens || [])
      if (deviceAcceptsNotification(store, d, n))
        await database.query(
          `INSERT INTO notification_push_outbox(notification_id,device_id,user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [n.id, d.id, n.userId],
        );
  }
}
/** Multi-process lease; a crash is retried after the lease, bounded at-least-once transport. */
export function createOutboxWorker({
  database,
  loadStore,
  delivery,
  clock = () => Date.now(),
}) {
  let busy = false;
  return async function drain() {
    if (busy) return;
    busy = true;
    try {
      await database.query(
        `UPDATE notification_push_outbox SET status='expired',updated_at=now() WHERE status IN ('pending','sending') AND expires_at<=now()`,
      );
      if (!delivery.configured) return;
      const claimed = await database.transaction(
        () =>
          database.query(
            `WITH due AS (SELECT id FROM notification_push_outbox WHERE status IN ('pending','sending') AND next_attempt_at<=now() AND expires_at>now() ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED) UPDATE notification_push_outbox o SET status='sending',attempts=attempts+1,next_attempt_at=now()+interval '5 minutes',updated_at=now() FROM due WHERE o.id=due.id RETURNING o.*`,
          ),
        { lockKey: "gridgo-push-outbox-claim" },
      );
      for (const row of claimed.rows) {
        // A slow earlier send may outlive a batch lease. Renew only if this
        // attempt still owns the row; another worker's newer claim wins.
        const lease = await database.query(
          "UPDATE notification_push_outbox SET next_attempt_at=now()+interval '5 minutes' WHERE id=$1 AND status='sending' AND attempts=$2 RETURNING id",
          [row.id, row.attempts],
        );
        if (!lease.rowCount) continue;
        const store = await loadStore(database);
        const n = store.notifications.find((n) => n.id === row.notification_id);
        const d = store.deviceTokens.find((d) => d.id === row.device_id);
        let results = [];
        let status = "suppressed";
        if (
          n &&
          d &&
          d.userId === row.user_id &&
          n.push !== false &&
          deviceAcceptsNotification(store, d, n)
        ) {
          results = await delivery.send(pushMessageFor(n), [d]);
          status = outboxVerdict(
            { attempts: row.attempts, expiresAt: row.expires_at },
            results,
            clock(),
          );
        }
        await database.query(
          `UPDATE notification_push_outbox SET status=$2,next_attempt_at=$3,updated_at=now(),last_code=$4 WHERE id=$1 AND status='sending' AND attempts=$5`,
          [
            row.id,
            status,
            new Date(retryAt(row.attempts, clock())).toISOString(),
            results[0]?.code || null,
            row.attempts,
          ],
        );
        if (results.some((r) => r.prune))
          await database.query(
            "DELETE FROM device_tokens WHERE id=$1 AND user_id=$2 AND token=$3",
            [d.id, row.user_id, d.token],
          );
      }
    } finally {
      busy = false;
    }
  };
}
