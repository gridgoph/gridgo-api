import { productionPhotoFiles } from './production-progress.js';
import { packingPhotoFiles } from './packing-progress.js';
import { assertRefundWorkAllowed } from './refund-policy.js';

export const PACKAGING_STATES = ['supplier_self_qc', 'ready_for_dispatch'];
const requirement = (code, message) => ({ code, message });

/** Shared preflight and write-time evidence policy. Receipt scans remain optional. */
export function productionTransitionReadiness(store, order, next, { operations = false, reason = '' } = {}) {
  const missing = [];
  const fromAllowed = order.state === 'production'
    || (order.state === 'supplier_self_qc' && next === 'ready_for_dispatch');
  if (!fromAllowed) missing.push(requirement('transition_not_allowed',
    'This order cannot move to the requested state from its current step. Refresh the order and use an available action.'));
  try { assertRefundWorkAllowed(store, order); }
  catch (error) {
    if (!error.code || error.status !== 409) throw error;
    missing.push(requirement(error.code, error.message));
  }
  if (order.payoutHold || (store?.claims || []).some(claim => claim.orderId === order.id && ['open', 'payout_held'].includes(claim.status))) {
    missing.push(requirement('claim_hold_active',
      'This order cannot be packaged for pickup while a claim holds payouts. Operations must clear the claim first.'));
  }
  if (operations) {
    if (typeof reason !== 'string' || !reason.trim()) missing.push(requirement('production_override_reason_required',
      'Explain why Operations is correcting this production step.'));
  } else {
    if (!productionPhotoFiles(store, order).length) missing.push(requirement('production_photo_required',
      'Attach at least one production progress photo before marking this job packed or ready for dispatch. A start-of-production photo counts.'));
    if (next === 'ready_for_dispatch' && !packingPhotoFiles(store, order).length) missing.push(requirement('packing_photo_required',
      'Add a photo of the finished prints packed and ready before marking Ready for dispatch.'));
  }
  const receiptAttached = (store?.files || []).some(file => file.purpose === 'supplier_invoice' && file.state === 'ready'
    && file.ownerId === order.supplierId && file.objectKey
    && (file.references || []).some(ref => ref.type === 'order' && ref.id === order.id));
  return { allowed: missing.length === 0, missing, receiptScan: { required: false, attached: receiptAttached } };
}

const ZONES = { nearby: 'Nearby', away: 'Away', long_distance: 'Long Distance', out_of_zone: 'Out of Zone' };
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;

/** Display-only values from order/line snapshots, never today's listing or fee bands. */
export function supplierJobDetails(order, productionItems = [], store = null) {
  const materialFor = item => text(item.structuredSpec?.material)
    || (item.options || []).filter(option => /^materials?$/i.test(option.groupName?.trim() || ''))
      .map(option => text(option.label)).filter(Boolean).join(', ') || null;
  const materials = [...new Set(productionItems.map(materialFor).filter(Boolean))];
  const values = {
    material: productionItems.length ? materials.join(', ') || null : text(order.material),
    zone: text(order.distanceZone?.label) || ZONES[order.zone]
      || text((store?.zones || []).find(zone => zone.code === order.zone)?.name),
    promisedDate: text(order.readyBy) || text(order.promisedDate) || text(order.deadline),
  };
  const missing = Object.keys(values).filter(key => !values[key]);
  if (productionItems.some(item => !materialFor(item)) && !missing.includes('material')) missing.push('material');
  return { ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value || 'Not specified'])), missing };
}
