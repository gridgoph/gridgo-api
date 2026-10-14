import { createHash, randomUUID } from 'node:crypto';
import { productionStarted, refundHold } from './refund-policy.js';
import { notifyAdmins } from './domain-events.js';
import { queueOrderInvalidate } from './notifications.js';
import { displayProductionDayMinutes } from './production-days.js';

const ACTION = 'production_time.correct_39853344';
const PRE_PRODUCTION = new Set(['initial_payment_review', 'needs_qa', 'awaiting_payment', 'payment_pending', 'payment_authorized', 'supplier_assigned', 'client_correction', 'approved_for_production']);
const CLOSED = new Set(['cancelled', 'completed', 'delivered', 'ready_for_pickup', 'rider_assigned', 'picked_up', 'in_transit', 'ready_for_dispatch', 'awaiting_collection', 'out_for_delivery', 'issue_window_open', 'payout_released']);
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const validMinutes = value => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const keyFor = (kind, id, prefix) => `${kind}:${id}:${prefix}`;
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

function records(store) {
  const rows = [];
  const add = (kind, record, prefixes, owner = record) => {
    for (const prefix of prefixes) rows.push({ kind, id: record.id, prefix, record, owner,
      supplierId: owner.supplierId, key: keyFor(kind, record.id, prefix) });
  };
  for (const row of store.supplierServices || []) add('supplierServices', row, ['turnaround', 'standardTurnaround', 'rushTurnaround']);
  for (const row of store.catalogItems || []) {
    add('catalogItems', row, ['turnaround', 'minimumTurnaround']);
    if (row.approvedSnapshot?.item) add('approvedCatalogItems', { ...row.approvedSnapshot.item, id: row.id }, ['turnaround', 'minimumTurnaround'], row);
    for (const tier of row.approvedSnapshot?.catalogSpeedTiers || []) add('approvedSpeedTiers', tier, ['turnaround'], row);
  }
  for (const row of store.catalogSpeedTiers || []) add('catalogSpeedTiers', row, ['turnaround'], (store.catalogItems || []).find(item => item.id === row.catalogItemId) || row);
  for (const row of store.listingStarters || []) add('listingStarters', row, ['defaultTurnaround']);
  return rows;
}

/** A pure report: no graph mutation, no inferred historical scheduling. */
export function planProductionTimeCorrection(store, { deployedAt, backup = null, manifest = [] }) {
  if (!iso(deployedAt)) throw new Error('deployedAt must be the verified deployment instant');
  if (backup && (!iso(backup.capturedAt) || Date.parse(backup.capturedAt) >= Date.parse(deployedAt) || !Array.isArray(backup.sources))) {
    throw new Error('Backup evidence must predate the deployment');
  }
  if (!Array.isArray(manifest) || new Set(manifest.map(row => row.orderId)).size !== manifest.length) throw new Error('Manifest order IDs must be unique');
  const original = new Map();
  for (const source of backup?.sources || []) {
    const key = keyFor(source.kind, source.id, source.prefix);
    if (original.has(key)) throw new Error('Duplicate backup duration evidence');
    original.set(key, { hours: source.hours, evidence: `backup:${backup.capturedAt}` });
  }
  const historic = new Map();
  for (const line of [...(store.orderLineItems || [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id))) {
    if (!line.sourceCatalogItemId || !iso(line.createdAt) || Date.parse(line.createdAt) >= Date.parse(deployedAt) || historic.has(line.sourceCatalogItemId)) continue;
    historic.set(line.sourceCatalogItemId, { hours: line.turnaroundHoursSnapshot, evidence: `order_line:${line.id}` });
  }
  const applied = new Map((store.auditLog || []).filter(row => row.action === ACTION && row.detail?.correctionKey)
    .map(row => [row.detail.correctionKey, row.detail]));
  const durations = [];
  for (const { kind, id, prefix, record, owner, supplierId, key } of records(store)) {
    const oldMinutes = record[`${prefix}Minutes`] ?? (record[`${prefix}Hours`] == null ? null : record[`${prefix}Hours`] * 60);
    if (oldMinutes == null) continue;
    if (applied.has(key)) {
      durations.push({ kind, id, prefix, supplierId, key, ...applied.get(key).duration, status: 'already_applied' });
      continue;
    }
    // New minute/hour records and post-deploy creations are not migration casualties.
    if (record[`${prefix}Days`] == null || (owner.createdAt && Date.parse(owner.createdAt) >= Date.parse(deployedAt))) continue;
    const row = { kind, id, prefix, supplierId, key, name: record.name || record.label || owner.name || id,
      shop: (store.supplierProfiles || []).find(profile => profile.userId === supplierId)?.shopName ?? null,
      oldMinutes, status: 'missing_evidence' };
    const source = original.get(key) || (['catalogItems', 'approvedCatalogItems'].includes(kind) && prefix === 'turnaround' ? historic.get(id) : null);
    if (source) {
      row.correctedMinutes = source.hours * 60;
      row.evidence = source.evidence;
      const dayMinutes = kind === 'listingStarters' ? 600 : displayProductionDayMinutes(store, supplierId);
      if (!validMinutes(row.correctedMinutes)) row.status = 'invalid_evidence';
      else if (row.correctedMinutes === oldMinutes) row.status = 'unchanged';
      else if (row.correctedMinutes > oldMinutes || dayMinutes == null
        || Math.ceil(row.correctedMinutes / dayMinutes) * dayMinutes !== oldMinutes) row.status = 'conversion_mismatch';
      else if (owner.updatedAt && Date.parse(owner.updatedAt) >= Date.parse(deployedAt)) row.status = 'changed_since_deploy';
      else row.status = 'ready';
    }
    durations.push(row);
  }
  // Do not restore one bound if it would make a listing's range impossible.
  for (const kind of ['catalogItems', 'approvedCatalogItems']) for (const row of durations.filter(row => row.kind === kind && row.prefix === 'turnaround' && row.status === 'ready')) {
    const minimum = durations.find(other => other.kind === kind && other.id === row.id && other.prefix === 'minimumTurnaround');
    const value = minimum?.status === 'ready' ? minimum.correctedMinutes : minimum?.oldMinutes;
    if (value != null && value > row.correctedMinutes) { row.status = 'unresolved_minimum'; if (minimum?.status === 'ready') minimum.status = 'unresolved_minimum'; }
  }
  const recovered = new Map();
  for (const item of store.catalogItems || []) {
    const duration = durations.find(row => row.kind === 'catalogItems' && row.id === item.id && row.prefix === 'turnaround');
    const source = original.get(keyFor('catalogItems', item.id, 'turnaround')) || historic.get(item.id);
    const service = (store.supplierServices || []).find(row => row.id === item.supplierServiceId);
    const inherited = item.turnaroundMode !== 'override' && service
      ? original.get(keyFor('supplierServices', service.id, service.standardTurnaroundHours == null ? 'turnaround' : 'standardTurnaround')) : null;
    const minutes = duration?.correctedMinutes ?? ((source?.hours ?? inherited?.hours) * 60);
    if (validMinutes(minutes)) recovered.set(item.id, { minutes, evidence: duration?.evidence || source?.evidence || inherited?.evidence });
  }
  const orders = [];
  for (const order of store.orders || []) {
    const lines = (store.orderLineItems || []).filter(line => line.orderId === order.id);
    const postDeploy = lines.filter(line => line.turnaroundDaysSnapshot != null && Date.parse(line.createdAt) >= Date.parse(deployedAt));
    if (!postDeploy.length) continue;
    const affected = postDeploy.filter(line => !recovered.has(line.sourceCatalogItemId)
      || recovered.get(line.sourceCatalogItemId).minutes < (line.turnaroundMinutesSnapshot ?? line.turnaroundDaysSnapshot * line.productionDayMinutesSnapshot));
    if (!affected.length && !order.productionTimeCorrection) continue;
    const jobs = (store.orderJobs || []).filter(job => job.orderId === order.id);
    const correctedLines = lines.map(line => {
      const originalMinutes = line.turnaroundMinutesSnapshot ?? (line.turnaroundDaysSnapshot != null
        ? line.turnaroundDaysSnapshot * line.productionDayMinutesSnapshot : line.turnaroundHoursSnapshot * 60);
      const recovery = affected.includes(line) ? recovered.get(line.sourceCatalogItemId) : null;
      return { lineId: line.id, jobId: line.jobId, originalMinutes, correctedMinutes: recovery?.minutes ?? originalMinutes, evidence: recovery?.evidence ?? null };
    });
    const row = { orderId: order.id, reference: order.reference || order.id,
      shop: (store.supplierProfiles || []).find(profile => profile.userId === order.supplierId)?.shopName || order.supplierId,
      clientAccountType: (store.users || []).find(user => user.id === order.clientId)?.accountType ?? null,
      open: !order.readyAt && !CLOSED.has(order.state), oldReadyBy: order.readyBy, oldPromiseBy: order.promiseBy,
      lines: correctedLines, jobs: jobs.map(job => ({ jobId: job.id, oldMinutes: job.estimatedProductionMinutes ?? job.estimatedHours * 60,
        correctedMinutes: Math.max(...correctedLines.filter(line => line.jobId === job.id).map(line => line.correctedMinutes)) })),
      status: 'needs_manifest' };
    const entry = manifest.find(entry => entry.orderId === order.id);
    row.correctedReadyBy = entry?.readyBy ?? null;
    row.correctedPromiseBy = entry?.promiseBy ?? null;
    row.basisHash = hash({ order, lines, jobs, recovered: correctedLines,
      shop: (store.supplierProfiles || []).find(profile => profile.userId === order.supplierId),
      queue: (store.orderJobs || []).filter(job => job.supplierId === order.supplierId),
      services: (store.supplierServices || []).filter(service => service.supplierId === order.supplierId), settings: store.settings });
    if (order.productionTimeCorrection) row.status = 'already_applied';
    else if (!row.open) row.status = 'finished_list_only';
    else if (affected.some(line => !recovered.has(line.sourceCatalogItemId))) row.status = 'missing_evidence';
    else if (affected.some(line => Math.ceil(recovered.get(line.sourceCatalogItemId).minutes / line.productionDayMinutesSnapshot) !== line.turnaroundDaysSnapshot)) row.status = 'conversion_mismatch';
    else if (!PRE_PRODUCTION.has(order.state) || jobs.some(job => !PRE_PRODUCTION.has(job.state) || job.scheduledFor)
      || order.scheduledFor || productionStarted(order) || order.productionStartedAt || order.rescheduleRequest || order.shopRecovery || refundHold(store, order)) row.status = 'scheduling_conflict';
    else if (!jobs.length || row.jobs.some(job => !validMinutes(job.correctedMinutes)) || correctedLines.some(line => !line.jobId || !validMinutes(line.correctedMinutes))) row.status = 'incomplete_job_evidence';
    else if (entry) {
      if (entry.expectedBasisHash !== row.basisHash) row.status = 'stale_manifest';
      else if (entry.noScheduledOrStartedConflict !== true || typeof entry.schedulingBasis !== 'string' || !entry.schedulingBasis.trim()
        || typeof entry.reviewedBy !== 'string' || !entry.reviewedBy.trim() || !iso(entry.reviewedAt)
        || !iso(entry.readyBy) || !iso(entry.promiseBy) || !iso(order.readyBy) || !iso(order.promiseBy)
        || Date.parse(entry.readyBy) < Date.parse(order.createdAt) || Date.parse(entry.readyBy) >= Date.parse(order.readyBy)
        || Date.parse(entry.promiseBy) < Date.parse(entry.readyBy) || Date.parse(entry.promiseBy) > Date.parse(order.promiseBy)) row.status = 'invalid_manifest';
      else { row.status = 'ready'; row.review = structuredClone(entry); }
    }
    orders.push(row);
  }
  return { report: '39853344', deployedAt, durations, orders };
}

/** Caller holds the domain lock; only a fresh plan may be applied. */
export function applyProductionTimeCorrection(store, plan, { at }) {
  if (!iso(at)) throw new Error('Correction time is required');
  const audit = (entityType, entityId, correctionKey, detail, orderId = null) => {
    store.auditLog.push({ id: `aud_${randomUUID()}`, at, actorId: null, actorRole: 'system', action: ACTION,
      entityType, entityId, orderId, reason: 'Restore production time rounded by the working-day conversion (39853344)',
      detail: { correctionKey, deployedAt: plan.deployedAt, ...detail } });
    notifyAdmins(store, 'production_time_corrected', 'Production time corrected',
      orderId ? store.orders.find(order => order.id === orderId) : null, correctionKey,
      { createId: prefix => `${prefix}_${randomUUID()}`, at });
  };
  for (const row of plan.durations.filter(row => row.status === 'ready')) {
    if (store.auditLog.some(event => event.action === ACTION && event.detail?.correctionKey === row.key)) continue;
    const target = records(store).find(record => record.key === row.key);
    const patch = { [`${row.prefix}Days`]: null, [`${row.prefix}Minutes`]: row.correctedMinutes, [`${row.prefix}Hours`]: row.correctedMinutes / 60 };
    if (row.kind === 'approvedCatalogItems') Object.assign(target.owner.approvedSnapshot.item, patch);
    else Object.assign(target.record, patch);
    if (target.owner.version != null) target.owner.version++;
    if (target.owner.updatedAt) target.owner.updatedAt = at;
    audit(row.kind, row.id, row.key, { duration: row });
  }
  for (const row of plan.orders.filter(row => row.status === 'ready')) {
    const order = store.orders.find(order => order.id === row.orderId);
    if (order.productionTimeCorrection) continue;
    order.productionTimeCorrection = { report: '39853344', at, reason: 'Working-day conversion recovery',
      penaltyExempt: true, originalReadyBy: order.readyBy, originalPromiseBy: order.promiseBy,
      originalPromisedDate: order.promisedDate ?? null, ...structuredClone(row) };
    order.readyBy = row.correctedReadyBy;
    order.promiseBy = row.correctedPromiseBy;
    if (order.promisedDate != null) order.promisedDate = row.correctedPromiseBy;
    order.updatedAt = at;
    for (const correction of row.jobs) {
      const job = store.orderJobs.find(job => job.id === correction.jobId);
      job.estimatedProductionMinutes = correction.correctedMinutes;
      job.estimatedHours = correction.correctedMinutes / 60;
      job.updatedAt = at;
    }
    queueOrderInvalidate(store, order, ['orders', 'jobs']);
    audit('order', order.id, `order:${order.id}`, { correction: order.productionTimeCorrection }, order.id);
  }
  return plan;
}
