import { createNotificationEvents } from './notifications.js';
import { loadStore, saveStore, originalNotificationIds } from './postgres-store.js';
import { enqueueNotificationPushes } from './push-outbox.js';
import { createRealtimeTransport } from './realtime-transport.js';
import { planProductionTimeCorrection, applyProductionTimeCorrection } from './production-time-correction.js';

/** The backup must already be restored to an isolated database; read it only. */
export async function readProductionTimeBackup(database, capturedAt) {
  return database.snapshot(async () => {
    const sources = [];
    for (const [table, kind, fields] of [
      ['supplier_services', 'supplierServices', ['turnaround', 'standardTurnaround', 'rushTurnaround']],
      ['supplier_catalog_items', 'catalogItems', ['turnaround', 'minimumTurnaround']],
      ['supplier_catalog_speed_tiers', 'catalogSpeedTiers', ['turnaround']],
      ['listing_starters', 'listingStarters', ['defaultTurnaround']],
    ]) {
      const column = field => field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`) + '_hours';
      const rows = (await database.query(`SELECT id, ${fields.map(column).join(', ')} FROM ${table}`)).rows;
      for (const row of rows) for (const prefix of fields) sources.push({ kind, id: row.id, prefix, hours: row[column(prefix)] });
    }
    for (const row of (await database.query('SELECT id, approved_snapshot FROM supplier_catalog_items WHERE approved_snapshot IS NOT NULL')).rows) {
      for (const prefix of ['turnaround', 'minimumTurnaround']) sources.push({ kind: 'approvedCatalogItems', id: row.id, prefix, hours: row.approved_snapshot.item?.[`${prefix}Hours`] ?? null });
      for (const tier of row.approved_snapshot.catalogSpeedTiers || []) sources.push({ kind: 'approvedSpeedTiers', id: tier.id, prefix: 'turnaround', hours: tier.turnaroundHours });
    }
    return { capturedAt, sources };
  });
}

export async function runProductionTimeCorrection(database, options = {}) {
  const execute = async () => {
    const store = await loadStore(database);
    const report = planProductionTimeCorrection(store, options);
    if (options.apply) {
      const before = originalNotificationIds(store);
      applyProductionTimeCorrection(store, report, { at: options.at || new Date().toISOString() });
      const created = (store.notifications || []).filter(row => !before.has(row.id));
      await saveStore(database, store);
      await enqueueNotificationPushes(database, store, created);
      // Enqueue only: the live API owns delivery and retries after this commit.
      await createRealtimeTransport({ database, events: createNotificationEvents() }).enqueue(store, created);
    }
    return { ...report, dryRun: !options.apply };
  };
  return options.apply ? database.transaction(execute) : database.snapshot(execute);
}
