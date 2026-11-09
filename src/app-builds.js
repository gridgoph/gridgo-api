import { riderPackingFlow } from './shop-handover.js';

const DEFAULT_MINIMUMS = Object.freeze({ client: 0, supplier: 0, rider: 161 });
const CUSTODY_TRANSITIONS = new Set(['rider_assigned', 'picked_up', 'out_for_delivery', 'delivered', 'issue_window_open']);
const CUSTODY_FILE_PURPOSES = ['packing_photo', 'handoff_signature', 'delivery_photo', 'delivery_package_photo', 'fulfilment_proof'];

/** Missing, legacy and malformed headers deliberately retain the released behavior. */
export function parseGridgoApp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(client|supplier|rider)\/(\d+\.\d+\.\d+)\+(\d+)$/.exec(value.trim());
  if (!match) return null;
  const build = Number(match[3]);
  return Number.isSafeInteger(build) ? { app: match[1], version: match[2], build } : null;
}

export function riderPacksMinimumBuilds(settings) {
  return { ...DEFAULT_MINIMUMS, ...settings?.riderPacksMinimumBuilds };
}

export function validateRiderPacksMinimumBuilds(value, fail) {
  const apps = Object.keys(DEFAULT_MINIMUMS);
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).length !== apps.length
    || !apps.every(app => Object.hasOwn(value, app) && Number.isSafeInteger(value[app]) && value[app] >= 0)) {
    fail(400, 'invalid_rider_packs_minimum_builds', 'Set client, supplier and rider to nonnegative safe integer build numbers.');
  }
}

/** Only custody entry points; ordinary reads, progress pings and uploads stay unchanged. */
export function isRiderCustodyRoute(method, pathname) {
  if (method === 'GET') return /^\/orders\/[^/]+\/handover$/.test(pathname);
  return method === 'POST' && (
    /^\/dispatch\/[^/]+\/(accept|arrived-packed|pickup-checklist|pickup-confirm|delivery)$/.test(pathname)
    || /^\/orders\/[^/]+\/(transition|handover\/escalate|acknowledgement-receipt)$/.test(pathname)
    || /^\/files\/[^/]+\/attach$/.test(pathname)
  );
}

/**
 * Read before opening a mutation transaction, legacy upkeep, domain refusals,
 * audit and storage work. Accepted requests recheck under the domain lock, so
 * a settings edit cannot race the custody write (including self-queued attaches).
 */
export async function riderPacksUpdateRequired(database, app, method, pathname, body) {
  if (app?.app !== 'rider' || !isRiderCustodyRoute(method, pathname)) return null;
  if (pathname.endsWith('/transition') && !CUSTODY_TRANSITIONS.has(body?.state)) return null;
  const fileId = pathname.startsWith('/files/') ? pathname.split('/')[2] : null;
  const orderId = fileId ? body?.orderId : pathname.split('/')[2];
  if (typeof orderId !== 'string') return null;
  const { rows: [order] } = await database.query(`
    SELECT o.payout_plan_version AS "payoutPlanVersion", o.data->'shopHandoverVersion' AS "shopHandoverVersion", s.settings
      FROM orders o LEFT JOIN platform_settings s ON s.singleton
     WHERE o.id = $1 AND ($2::text IS NULL OR EXISTS (
       SELECT 1 FROM files f WHERE f.file_id = $2 AND f.purpose = ANY($3::text[])
     ))`, [orderId, fileId, CUSTODY_FILE_PURPOSES]);
  if (!riderPackingFlow(order)) return null;
  const minimumBuild = riderPacksMinimumBuilds(order.settings).rider;
  return app.build < minimumBuild ? { error: 'app_update_required', minimumBuild, app: 'rider' } : null;
}
