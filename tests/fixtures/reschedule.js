import crypto from 'node:crypto';
import { emptyStore } from '../../src/postgres-store.js';
import { createPayoutMilestones, defaultOperationalSettings } from '../../src/operational-model.js';
import { createOrderLineSnapshot } from '../../src/supplier-catalog.js';
import { routeOrderReschedule } from '../../src/order-reschedule.js';
export const AT = '2026-10-05T00:00:00.000Z';
export const ORIGINAL = '2026-10-10T00:00:00.000Z';
export const PROPOSED = '2026-10-12T00:00:00.000Z';
export const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
export const actors = { client: { id: 'client', role: 'client' }, supplier: { id: 'supplier', role: 'supplier' },
  replacement: { id: 'replacement', role: 'supplier' }, other: { id: 'other', role: 'client' },
  ops: { id: 'ops', role: 'ops_admin' }, admin: { id: 'admin', role: 'super_admin' }, rider: { id: 'rider', role: 'rider' } };
export function fixture() {
  const store = emptyStore();
  store.settings = { ...defaultOperationalSettings(), promiseAllowanceMinutes: 60 };
  store.taxonomy.categories = [{ id: 'category', code: 'marketing_collateral', name: 'Marketing', active: true }];
  store.taxonomy.subcategories = [{ id: 'family', code: 'flyers', categoryCode: 'marketing_collateral', name: 'Flyers', active: true }];
  store.acceptedFileFormats = [{ code: 'pdf', displayName: 'PDF', inputKind: 'file', extensions: ['pdf'], mimeTypes: ['application/pdf'], active: true }];
  store.acceptedFileFormats.push({ code: 'canva_link', displayName: 'Design link', inputKind: 'url', extensions: [], mimeTypes: [], active: true });
  for (const actor of Object.values(actors)) {
    store.users.push({ ...actor, email: [actor.id, 'example.invalid'].join('@'), name: actor.id,
      clerkUserId: `clerk_${actor.id}`, createdAt: AT, ...(actor.role === 'client' ? { accountType: 'individual' } : {}),
      ...(['supplier', 'rider'].includes(actor.role) ? { verificationStatus: 'approved' } : {}) });
    store.userRoleMemberships.push({ userId: actor.id, role: actor.role, createdAt: AT });
    if (actor.role === 'client') store.clientProfiles.push({ userId: actor.id, clientKind: 'personal', updatedAt: AT });
  }
  for (const supplierId of ['supplier', 'replacement']) {
    store.approvalCases.push({ id: `case_${supplierId}`, userId: supplierId, kind: 'supplier', status: 'approved', version: 1,
      applicationRevision: 1, submittedAt: AT, decidedAt: AT, createdAt: AT, updatedAt: AT });
    store.supplierProfiles.push({ userId: supplierId, shopName: 'Fixture shop', contactName: 'Printer',
      shop: { lat: 7.06, lng: 125.6, label: 'Pickup' }, pickupAvailable: true, updatedAt: AT });
    store.supplierServices.push({ id: `service_${supplierId}`, supplierId, categoryCode: 'marketing_collateral',
      state: 'live', referenceRateMinor: 1000, pricingBasis: 'per_unit', standardTurnaroundHours: 2, turnaroundHours: 2, version: 1, createdAt: AT, updatedAt: AT });
    store.files.push({ fileId: `photo_${supplierId}`, ownerId: supplierId, purpose: 'catalog_item_photo', state: 'ready', objectKey: `private/${supplierId}`, originalFilename: 'photo.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT });
    store.catalogItemPhotos.push({ catalogItemId: `item_${supplierId}`, fileId: `photo_${supplierId}`, sortOrder: 0, createdAt: AT });
    for (const formatCode of ['pdf', 'canva_link']) store.supplierServiceFileFormats.push({ supplierServiceId: `service_${supplierId}`, formatCode });
    store.catalogItems.push({ id: `item_${supplierId}`, supplierId, supplierServiceId: `service_${supplierId}`, subcategoryCode: 'flyers',
      name: 'Standard flyer', description: 'Single-sided flyer', basePriceMinor: 1000, pricingUnit: 'per_unit',
      turnaroundMode: 'inherit', fileFormatMode: 'inherit', active: true, sortOrder: 0, version: 1, createdAt: AT, updatedAt: AT });
  }
  const order = { id: 'order', clientId: 'client', supplierId: 'supplier', state: 'production',
    readyBy: ORIGINAL, promiseBy: '2026-10-10T01:00:00.000Z', promisedDate: '2026-10-10T01:00:00.000Z',
    commercialCommittedAt: AT, moneyModelVersion: 3, payoutPlanVersion: 2, quoteVersion: 1,
    supplierSubtotalMinor: 10000, subtotalMinor: 10000, serviceFeeRateBps: 1000, serviceFeeMinor: 1000,
    deliveryFeeMinor: 1000, riderCommissionBps: 8500, totalMinor: 12000, onlineDueMinor: 12000,
    directStoreDueMinor: 0, supplierPlatformPayoutMinor: 10000, fulfillmentMode: 'delivery',
    paymentPlan: 'order_match_qr_75_25', downpaymentPercent: 100,
    pickup: { lat: 7.06, lng: 125.6, label: 'Pickup' }, dropoff: { lat: 7.07, lng: 125.61, label: 'Dropoff' },
    payments: { initial: { amountMinor: 12000, method: 'qr_manual', status: 'confirmed' },
      final_online: { amountMinor: 0, method: 'qr_manual', status: 'not_required' } },
    paymentAllocations: [{ paymentCode: 'initial', component: 'supplier_principal', amountMinor: 10000 },
      { paymentCode: 'initial', component: 'service_fee', amountMinor: 1000 },
      { paymentCode: 'initial', component: 'delivery_pass_through', amountMinor: 1000 }],
    timeline: [{ at: AT, state: 'production', by: 'supplier' }], createdAt: AT, updatedAt: AT };
  order.payoutMilestones = createPayoutMilestones(order, { version: 2 });
  store.orders.push(order);
  const snapshot = createOrderLineSnapshot(store, { orderId: 'order', lineItemId: 'line', catalogItemId: 'item_supplier',
    optionIds: [], expectedVersion: 1, expectedServiceVersion: 1, quantity: 10, structuredSpec: {}, createdAt: AT }, id);
  snapshot.lineItem.jobId = 'job';
  snapshot.lineItem.artworkLinks = [{ url: 'https://www.canva.com/design/fixture/view', formatCode: 'canva_link' }];
  store.orderLineItems.push(snapshot.lineItem);
  store.orderJobs.push({ id: 'job', orderId: 'order', supplierId: 'supplier', state: 'production', fulfillmentMode: 'delivery',
    pickup: order.pickup, dropoff: order.dropoff, supplierSubtotalMinor: 10000, deliveryFeeMinor: 1000,
    riderCommissionBps: 8500, estimatedHours: 2, createdAt: AT, updatedAt: AT });
  return store;
}
export function audit(store, entry) {
  store.auditLog.push({ id: id('aud'), at: AT, actorId: entry.actor?.id || null, actorRole: entry.actor?.role || 'system',
    action: entry.action, entityId: entry.entityId, entityType: entry.entityType, orderId: entry.orderId, detail: entry.detail });
}
export const call = (store, actor, action = '', body = {}, options = {}) => routeOrderReschedule({
  req: { method: options.method || 'POST', headers: { 'idempotency-key': options.key || id('key') } },
  url: new URL(options.path || `/orders/order/reschedule-request${action ? `/${action}` : ''}`, 'http://api.test'),
  store, user: actors[actor] || actor, readBody: async () => body, now: () => options.at || AT, id, audit,
});
export const request = (store) => call(store, 'supplier', '', { reason: 'Equipment repair', proposedReadyBy: PROPOSED });
export const answer = (store, value, options = {}) => call(store, 'client', 'answer', { requestId: store.orders[0].rescheduleRequest.id, answer: value }, options);
