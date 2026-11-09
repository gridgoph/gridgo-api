import { loadClientBootstrapStore, loadSaveUpkeepProbe } from './postgres-store.js';
import { activeOrderSql } from './order-removal.js';
import { matchTesterInvites } from './tester-invites.js';
import { reconcilePromotionInvites } from './promotions.js';
import { syncSurveys } from './surveys.js';
import { closeUnavailableChanges } from './order-changes.js';

/** Candidate probes only. Actual upkeep rechecks under the domain lock and
 * uses the same save/audit/outbox boundary as the former incidental work. */
export async function saveUpkeepNeeded(database, at) {
  if ((await database.query('SELECT dirty FROM store_production_normalization WHERE singleton')).rows[0]?.dirty !== false) return true;
  const direct = await database.query(`SELECT 1 FROM files f JOIN users u ON u.id=f.owner_id
    WHERE u.account_status='removed' AND f.purpose IN ('artwork','mockup')
      AND f.state IN ('pending_upload','ready','delete_pending')
      AND ((f.data->'savedAt' IS NOT NULL AND f.data->'savedAt' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb))
        OR (f.data->'saveToMyFilesRequestedAt' IS NOT NULL AND f.data->'saveToMyFilesRequestedAt' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)))
    UNION ALL SELECT 1 FROM voucher_reservations r WHERE r.status='reserved' AND EXISTS (
      SELECT 1 FROM orders o WHERE ${activeOrderSql('o.id')} AND o.state='cancelled' AND r.data->'orderIds' @> jsonb_build_array(o.id)) LIMIT 1`);
  if (direct.rowCount) return true;
  let sequence = 0;
  const ctx = { at, id: prefix => `${prefix}_upkeep_probe_${++sequence}` };
  const invites = await database.query("SELECT 1 FROM tester_invites WHERE client_id IS NULL UNION ALL SELECT 1 FROM promotion_invites WHERE status='invited' LIMIT 1");
  if (invites.rowCount) {
    const probe = await loadClientBootstrapStore(database, null);
    if (matchTesterInvites(probe, ctx) || reconcilePromotionInvites(probe, ctx)) return true;
  }
  const domain = await database.query(`SELECT 1 FROM order_change_requests WHERE status IN ('pending','pending_payment')
    UNION ALL SELECT 1 FROM orders WHERE ${activeOrderSql('orders.id')}
      AND jsonb_array_length(CASE WHEN jsonb_typeof(data->'shopFailureEvents')='array' THEN data->'shopFailureEvents' ELSE '[]'::jsonb END)>0
      AND NOT EXISTS (SELECT 1 FROM order_surveys s WHERE s.order_id=orders.id)
    UNION ALL SELECT 1 FROM issues WHERE ${activeOrderSql('issues.order_id')} AND data#>>'{faultDecision,status}'='approved'
      AND NOT EXISTS (SELECT 1 FROM order_surveys s WHERE s.order_id=issues.order_id) LIMIT 1`);
  if (!domain.rowCount) return false;
  const probe = await loadSaveUpkeepProbe(database);
  if (syncSurveys(probe, ctx)) return true;
  const before = JSON.stringify(probe.orderChanges);
  for (const order of probe.orders) closeUnavailableChanges(probe, order, { ...ctx, audit: () => {} });
  return JSON.stringify(probe.orderChanges) !== before;
}

/** Match-token expiry formerly ran only when somebody requested a match. */
export async function pruneMatchSelections(database, at) {
  const candidate = await database.query("SELECT 1 FROM client_match_selections WHERE expires_at <= $1::timestamptz - interval '24 hours' LIMIT 1", [at]);
  if (!candidate.rowCount) return;
  await database.transaction(() => database.query("DELETE FROM client_match_selections WHERE expires_at <= $1::timestamptz - interval '24 hours'", [at]));
}
