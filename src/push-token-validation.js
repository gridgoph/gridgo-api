import { announcementPushMessage } from "./push.js";

/**
 * Stale-token sweep. A registration FCM has forgotten (app uninstalled, data
 * wiped, token rotated while the phone was off) is otherwise pruned only when a
 * real push to it is attempted, so the device counts on `GET /ops/push/stats`
 * would overstate reach. Each pass dry-runs (`validate_only`) the registrations
 * least recently checked, in small sequential batches, and prunes the ones FCM
 * reports as gone with the same classification a real send uses.
 *
 * Bounded on every axis: one pass per process at a time, at most `maxPerPass`
 * tokens per pass, `batchSize` per request burst with `pauseMs` between bursts,
 * and a registration is re-checked only after `maxAgeMs`. A pass stops early
 * when a whole batch fails without a prune verdict (provider trouble).
 * Nothing reaches a handset, and a failure here never touches the outbox.
 */
export const TOKEN_CHECK_MESSAGE = announcementPushMessage({
  title: "GRIDGO",
  body: "GRIDGO registration check",
});

export function createTokenValidator({
  database,
  delivery,
  logger = console,
  batchSize = 20,
  maxPerPass = 200,
  maxAgeMs = 24 * 60 * 60 * 1000,
  pauseMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let busy = false;
  return async function validatePushTokens() {
    if (busy || !delivery.configured || typeof delivery.validate !== "function") return null;
    busy = true;
    const totals = { checked: 0, pruned: 0, failed: 0 };
    try {
      while (totals.checked < maxPerPass) {
        const due = await database.query(
          `SELECT d.id, d.user_id, d.token, d.platform, d.data
             FROM device_tokens d
             LEFT JOIN device_token_checks c ON c.device_id = d.id
            WHERE COALESCE(d.data->>'tokenProvider', 'fcm') = 'fcm'
              AND (c.checked_at IS NULL OR c.checked_at < now() - make_interval(secs => $1))
            ORDER BY c.checked_at ASC NULLS FIRST, d.id
            LIMIT $2`,
          [maxAgeMs / 1000, Math.min(batchSize, maxPerPass - totals.checked)],
        );
        if (!due.rows.length) break;
        const devices = due.rows.map((row) => ({
          ...row.data,
          id: row.id,
          userId: row.user_id,
          token: row.token,
          platform: row.platform,
        }));
        let results;
        try {
          results = await delivery.validate(TOKEN_CHECK_MESSAGE, devices);
        } catch {
          results = devices.map((d) => ({ deviceId: d.id, ok: false, prune: false, code: "transport_error" }));
        }
        const byId = new Map(results.map((result) => [result.deviceId, result]));
        let batchFailures = 0;
        for (const device of devices) {
          const result = byId.get(device.id) || { ok: false, prune: false, code: "not_checked" };
          totals.checked += 1;
          if (result.prune) {
            // Same guarded delete as the outbox: only this exact token row, and
            // under the domain lock so it never interleaves with a registration.
            await database.transaction(() =>
              database.query("DELETE FROM device_tokens WHERE id=$1 AND token=$2", [device.id, device.token]),
            );
            totals.pruned += 1;
            continue;
          }
          if (!result.ok) {
            totals.failed += 1;
            batchFailures += 1;
          }
          // INSERT ... SELECT: a registration removed since the batch was read
          // simply gets no check row instead of failing the foreign key.
          await database.query(
            `INSERT INTO device_token_checks(device_id, checked_at, last_code)
             SELECT id, now(), $2 FROM device_tokens WHERE id = $1
             ON CONFLICT (device_id) DO UPDATE SET checked_at = now(), last_code = EXCLUDED.last_code`,
            [device.id, result.ok ? null : result.code || "unknown"],
          );
        }
        if (batchFailures === devices.length) {
          logger.warn?.(`push token validation stopped early: provider refused a whole batch code=${results[0]?.code || "unknown"}`);
          break;
        }
        if (totals.checked < maxPerPass && pauseMs > 0) await sleep(pauseMs);
      }
      if (totals.checked > 0)
        logger.info?.(
          `push token validation checked=${totals.checked} pruned=${totals.pruned} failed=${totals.failed}`,
        );
      return totals;
    } finally {
      busy = false;
    }
  };
}
