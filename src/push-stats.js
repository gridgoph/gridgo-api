/**
 * `GET /ops/push/stats`: push reach and delivery for Operations / Super Admin.
 *
 * Aggregates only. No token, token tail, user id, or notification id leaves
 * this function, so the route cannot be used to ask "is this phone
 * registered?" or "whose phone is this?".
 *
 * `seen` is `device_tokens.updated_at`, which every re-registration moves (the
 * apps re-register on each launch). Outbox windows are by the row's
 * `updated_at`, the time of its latest attempt or status change.
 */
export const OUTBOX_STATUSES = ["pending", "sending", "delivered", "suppressed", "expired", "failed"];

const WINDOWS = [
  ["last24h", "24 hours"],
  ["last7d", "7 days"],
];

export async function pushStats(database) {
  return database.snapshot(async () => {
    const generatedAt = (await database.query("SELECT now() AS at")).rows[0].at;
    const deviceRows = (
      await database.query(
        `SELECT d.data->>'appRole' AS app_role,
                (d.user_id IS NULL) AS unclaimed,
                count(*)::int AS total,
                count(*) FILTER (WHERE d.updated_at > now() - interval '7 days')::int AS seen7,
                count(*) FILTER (WHERE d.updated_at > now() - interval '30 days')::int AS seen30
           FROM device_tokens d
          GROUP BY 1, 2`,
      )
    ).rows;
    const byRole = new Map();
    const devices = { total: 0, claimed: 0, unclaimed: 0, seenLast7Days: 0, seenLast30Days: 0 };
    for (const row of deviceRows) {
      const appRole = row.app_role || null;
      const entry =
        byRole.get(appRole) ||
        { appRole, total: 0, claimed: 0, unclaimed: 0, seenLast7Days: 0, seenLast30Days: 0 };
      for (const target of [entry, devices]) {
        target.total += row.total;
        target[row.unclaimed ? "unclaimed" : "claimed"] += row.total;
        target.seenLast7Days += row.seen7;
        target.seenLast30Days += row.seen30;
      }
      byRole.set(appRole, entry);
    }
    // Registrations without an app role (unclaimed, or older app builds) last.
    devices.byAppRole = [...byRole.values()].sort((a, b) =>
      a.appRole === b.appRole ? 0 : a.appRole === null ? 1 : b.appRole === null ? -1 : a.appRole < b.appRole ? -1 : 1,
    );

    const check = (
      await database.query(
        `SELECT count(c.device_id)::int AS checked,
                count(*) FILTER (WHERE c.device_id IS NULL)::int AS never_checked,
                count(*) FILTER (WHERE c.checked_at > now() - interval '24 hours')::int AS checked24,
                count(*) FILTER (WHERE c.last_code IS NOT NULL)::int AS failing,
                max(c.checked_at) AS last_checked_at
           FROM device_tokens d
           LEFT JOIN device_token_checks c ON c.device_id = d.id
          WHERE COALESCE(d.data->>'tokenProvider', 'fcm') = 'fcm'`,
      )
    ).rows[0];
    devices.validation = {
      checkedLast24h: check.checked24,
      neverChecked: check.never_checked,
      lastCheckFailed: check.failing,
      lastCheckedAt: check.last_checked_at || null,
    };

    const outbox = {};
    for (const [key, span] of WINDOWS) {
      const rows = (
        await database.query(
          `SELECT status, last_code, count(*)::int AS count
             FROM notification_push_outbox
            WHERE updated_at > now() - $1::interval
            GROUP BY 1, 2`,
          [span],
        )
      ).rows;
      const byStatus = Object.fromEntries(OUTBOX_STATUSES.map((status) => [status, 0]));
      const codes = new Map();
      let total = 0;
      for (const row of rows) {
        byStatus[row.status] = (byStatus[row.status] || 0) + row.count;
        total += row.count;
        if (!row.last_code) continue;
        const k = `${row.status}\u0000${row.last_code}`;
        codes.set(k, { status: row.status, code: row.last_code, count: (codes.get(k)?.count || 0) + row.count });
      }
      outbox[key] = {
        total,
        byStatus,
        byLastCode: [...codes.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
      };
    }
    const last = (
      await database.query(
        "SELECT max(updated_at) FILTER (WHERE status='delivered') AS delivered_at FROM notification_push_outbox",
      )
    ).rows[0];
    outbox.lastDeliveredAt = last.delivered_at || null;
    return { generatedAt, devices, outbox };
  });
}
