import { approvedCatalogView } from "./catalog-review-state.js";

import { rescheduleHold } from './order-reschedule-policy.js';
import { addOpeningMilliseconds, defaultShopSchedule } from './availability.js';
import { matchShop, MatchError, projectShopFinish } from './order-match.js';
import { catalogGroupsForItem, publicCatalogItem, selectedCatalogPrice, priceCatalogSelection, listingFitsPrinterCap } from './supplier-catalog.js';
import { privilegedAdminMemberships, queueOrderInvalidate } from './notifications.js';
import { writeDraft } from './client-order-notifications.js';
import { assessProductionLapses } from './production-penalties.js';
import { refundHold, refundSettlementFor } from './refund-policy.js';

export const CANCELLABLE_SHOP_STATES = new Set(['supplier_assigned', 'awaiting_checkout', 'awaiting_initial_payment',
  'payment_authorized', 'production', 'supplier_self_qc', 'ready_for_dispatch', 'rider_assigned']);
export const recoveryHeld = (order) => Boolean(order.shopRecovery && order.shopRecovery.status !== 'accepted');
export const paidShopShare = (store, order) => (order.payoutMilestones || []).some((stage) => stage.status === 'released')
  || (store.refundSupplierPayouts || []).some((row) => row.orderId === order.id && row.status === 'released');
const fail = (code) => { throw Object.assign(new Error(code), { status: 409, code }); };
const normalized = (value) => String(value || '').trim().toLowerCase();

export function startShopAcceptance(store, order, at) {
  const schedule = structuredClone(order.operatingClock?.schedule || store.supplierProfiles?.find((row) => row.userId === order.supplierId)?.schedule || defaultShopSchedule());
  order.shopAcceptance = { supplierId: order.supplierId, assignedAt: at, deadlineAt: addOpeningMilliseconds(schedule, at, 3600000),
    workingMinutes: 60, schedule, status: 'pending' };
}

/** Match every immutable line and selected spec, never a subcategory price floor. */
function compatibleLines(store, order, supplierId) {
  const lines = (store.orderLineItems || []).filter((line) => line.orderId === order.id);
  if (!lines.length) return null;
  const selections = [];
  for (const line of lines) {
    const source = store.catalogItems.find((item) => item.id === line.sourceCatalogItemId);
    if (!source) return null;
    const options = (store.orderLineItemOptions || []).filter((option) => option.orderLineItemId === line.id);
    let selected = null;
    for (const item of store.catalogItems.filter((item) => item.supplierId === supplierId && item.subcategoryCode === source.subcategoryCode)) {
      if (normalized(item.name) !== normalized(line.itemNameSnapshot)
          || (item.pricingUnit || 'per_unit') !== line.pricingUnitSnapshot
          || (item.packageQty ?? null) !== (line.packageQtySnapshot ?? null)
          || (item.measureUnit || null) !== (line.structuredSpecSnapshot?.measureUnit || null)) continue;
      const listing = publicCatalogItem(store, item);
      if (!listing || (line.acceptedFormatCodesSnapshot || []).some((code) => !(listing.acceptedFormats || []).some((format) => (format.code || format) === code)) || !listingFitsPrinterCap(listing, { line, measurement: line.measurement, structuredSpec: line.structuredSpecSnapshot }, store)) continue;
      const groups = catalogGroupsForItem(store, item.id, { includeInactiveOptions: false });
      const ids = options.map((option) => groups.find((group) => normalized(group.name) === normalized(option.groupNameSnapshot)
        && (group.kind || 'spec') === (option.groupKindSnapshot || 'spec'))?.options.find((row) => normalized(row.label) === normalized(option.optionLabelSnapshot))?.id);
      if (ids.some((id) => !id)) continue;
      // Free-form specs must be represented by the matched option labels; otherwise require Operations review.
      if (Object.entries(line.structuredSpecSnapshot || {}).some(([key, value]) => ['size', 'material', 'finish'].includes(key)
        && value && !options.some((option) => normalized(option.optionLabelSnapshot) === normalized(value)))) continue;
      try {
        const { selectedOptions } = selectedCatalogPrice(store, item, ids);
        const price = priceCatalogSelection(store, item, { selectedOptions, quantity: line.quantity, measurement: line.measurement || null });
        if (price.lineSubtotalMinor > line.lineSubtotalMinor) continue;
        selected = { lineId: line.id, catalogItemId: item.id, optionIds: ids, version: item.version,
          turnaroundHours: listing.turnaroundHours || line.turnaroundHoursSnapshot || 24 };
        break;
      } catch (error) {
        if (!error.status) throw error;
      }
    }
    if (!selected) return null;
    selections.push(selected);
  }
  return selections;
}

export function findReplacementShop(store, order, at, reserve = true) {
  store = approvedCatalogView(store);
  const expiresAt = new Date(Date.parse(at) + 15 * 60000).toISOString();
  const projectionAt = reserve ? expiresAt : at;
  const lines = (store.orderLineItems || []).filter((line) => line.orderId === order.id);
  const source = store.catalogItems?.find((item) => item.id === lines[0]?.sourceCatalogItemId);
  if (!source?.subcategoryCode) return null;
  const excluded = [...new Set([order.supplierId, ...(order.declinedBy || [])].filter(Boolean))];
  const ranking = store.clientPreferences?.find((row) => row.userId === order.clientId)?.ranking || ['quality', 'speed', 'cost', 'distance'];
  for (let attempt = 0; attempt < (store.supplierProfiles || []).length; attempt++) {
    let match;
    try {
      match = matchShop(store, { subcategoryCode: source.subcategoryCode, ranking, dropoff: order.requestFulfillment?.dropoff ?? order.dropoff ?? null,
        excludedSupplierIds: excluded, units: lines.reduce((sum, line) => sum + line.quantity, 0), now: at });
    } catch (error) { if (error instanceof MatchError) return null; throw error; }
    const supplierId = match.shop.supplierId;
    const selections = compatibleLines(store, order, supplierId);
    if (selections) {
      const { projection } = projectShopFinish(store, { supplierId, now: projectionAt,
        turnaroundHours: Math.max(...selections.map((row) => row.turnaroundHours)), units: lines.reduce((sum, line) => sum + line.quantity, 0) });
      return { supplierId, pickup: structuredClone(store.supplierProfiles.find((row) => row.userId === supplierId).shop),
        readyBy: projection.readyBy, promiseBy: projection.promiseBy, expiresAt, selections };
    }
    excluded.push(supplierId);
  }
  return null;
}

export function notifyRecovery(store, order, kind, at, createId) {
  const recovery = order.shopRecovery;
  const recipients = [{ userId: order.clientId, role: 'client' },
    { userId: recovery.originalSupplierId, role: 'supplier' }, ...privilegedAdminMemberships(store)];
  if (kind === 'accepted') recipients.push({ userId: order.supplierId, role: 'supplier' });
  for (const recipient of recipients) writeDraft(store, { userId: recipient.userId, appRole: recipient.role,
    type: 'shop_recovery', occurrenceKey: `${recovery.id}:${kind}`, orderId: order.id, title: 'Order fulfilment update',
    body: kind === 'accepted' ? 'The client accepted a replacement match.' : kind === 'refund_requested'
      ? 'The client chose a full refund. Operations will arrange the transfer.'
      : recovery.status === 'ops_review' ? 'The shop cannot fulfil this order. Operations is reviewing the next step.'
      : recovery.proposal ? 'The original shop could not fulfil your order. A vetted replacement is available. Accept the revised date or choose a full refund.'
      : 'The original shop could not fulfil your order. No replacement is available. You can choose a full refund.', read: false }, { id: createId('ntf'), at });
  queueOrderInvalidate(store, order, ['orders', 'jobs', 'dispatch', 'payouts']);
}

export function recordShopFailure(store, order, { kind, reason, at, createId, actorId = null }) {
  if (rescheduleHold(order)) fail('reschedule_fulfillment_stopped');
  if (recoveryHeld(order)) fail('shop_recovery_pending');
  if (!CANCELLABLE_SHOP_STATES.has(order.state)) fail('shop_cancel_not_available');
  if (refundHold(store, order) || refundSettlementFor(store, order)) fail('refund_fulfillment_stopped');
  assessProductionLapses(store, { at, createId, orderId: order.id });
  const event = { id: createId('shop_event'), supplierId: order.supplierId, kind, stage: order.state, reason, at, actorId };
  (order.shopFailureEvents ||= []).push(event);
  order.declinedBy = [...new Set([...(order.declinedBy || []), order.supplierId])];
  if (order.shopAcceptance) order.shopAcceptance.status = kind;
  const jobs = (store.orderJobs || []).filter((job) => job.orderId === order.id);
  const requiresOps = paidShopShare(store, order) || jobs.some((job) => job.supplierId !== order.supplierId);
  order.shopRecovery = { id: event.id, status: requiresOps ? 'ops_review' : 'awaiting_client', originalSupplierId: order.supplierId,
    stage: order.state, createdAt: at, originalSnapshot: { pickup: structuredClone(order.pickup || null), readyBy: order.readyBy || null, promiseBy: order.promiseBy || null }, proposal: requiresOps ? null : findReplacementShop(store, order, at) };
  order.updatedAt = at;
  store.auditLog.push({ id: createId('aud'), at, actorId, actorRole: actorId ? 'supplier' : 'system',
    action: `order.shop_${kind}`, entityType: 'order', entityId: order.id, orderId: order.id, detail: event, reason });
  notifyRecovery(store, order, 'offered', at, createId);
  return event;
}

export function expireShopAcceptances(store, { at, createId }) {
  let changed = false;
  for (const order of store.orders || []) {
    if (!order.supplierId || order.state !== 'supplier_assigned' || recoveryHeld(order) || refundHold(store, order) || refundSettlementFor(store, order)) continue;
    // Existing assignments receive a full window on rollout, never a retroactive penalty.
    if (!order.shopAcceptance || order.shopAcceptance.supplierId !== order.supplierId) { startShopAcceptance(store, order, at); changed = true; }
    if (order.shopAcceptance.status === 'pending' && Date.parse(at) >= Date.parse(order.shopAcceptance.deadlineAt)) {
      recordShopFailure(store, order, { kind: 'timed_out', reason: 'No response within one opening hour.', at, createId }); changed = true;
    }
  }
  return changed;
}
