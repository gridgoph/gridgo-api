import { loadStore, saveStore } from '../../src/postgres-store.js';
import { publicOrderFor } from '../../src/operational-model.js';
import { canAccessOrder, hasRole } from '../../src/notifications.js';
import { selectActorRole, identityHasMembership } from '../../src/authorization-context.js';
import { supplierArtworkReleased } from '../../src/artwork-gates.js';
import { isTestOperationsUser, testOperationsView } from '../../src/test-operations.js';
import { reviewReportView } from '../../src/review-data.js';
import { authorizeFileRead } from '../../src/attachments.js';
import { orderFileReadStore } from '../../src/order-file-access.js';
import { signProductionPhotos } from '../../src/production-progress.js';
import { signArtworkAttachments } from '../../src/artwork-attachments.js';
import { pickupChatUnread } from '../../src/pickup-chat.js';
import { resetDatabase } from './reset-database.js';
import { fixture, AT } from './reschedule.js';

export function instrument(database) {
  const queries = [];
  return { queries, db: { ...database, query: async (sql, values) => {
    const result = await database.query(sql, values);
    queries.push({ sql, values, rows: result.rowCount });
    return result;
  } } };
}

export async function setupOrders(database) {
  await resetDatabase(database, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  const base = structuredClone(store.orders[0]);
  const line = structuredClone(store.orderLineItems[0]);
  const job = structuredClone(store.orderJobs[0]);
  for (const [id, role, reviewData] of [['test_ops', 'ops_admin', true], ['review_client', 'client', true],
    ['review_supplier', 'supplier', true], ['review_rider', 'rider', true], ['suspended', 'supplier', false],
    ['dual', 'client', false], ['staff', 'staff', false]]) {
    store.users.push({ id, role, reviewData, email: `${id}@example.invalid`, name: `${id} Family`, clerkUserId: `clerk_${id}`,
      createdAt: AT, ...(role === 'client' ? { accountType: 'individual' } : {}),
      ...(['supplier', 'rider'].includes(role) ? { verificationStatus: 'approved' } : {}) });
    store.userRoleMemberships.push({ userId: id, role, createdAt: AT });
  }
  store.userRoleMemberships.push({ userId: 'dual', role: 'supplier', createdAt: AT }, { userId: 'dual', role: 'ops_admin', createdAt: AT });
  for (const userId of ['rider', 'review_supplier', 'review_rider', 'dual', 'suspended']) {
    const role = userId.includes('rider') ? 'rider' : 'supplier';
    store.approvalCases.push({ id: `case_${userId}`, userId, kind: role, status: userId === 'suspended' ? 'suspended' : 'approved',
      ...(userId === 'suspended' ? { suspensionReason: 'Fixture suspension' } : {}),
      version: 1, applicationRevision: 1, createdAt: AT, updatedAt: AT });
  }
  // Deliberately retain a different physical insertion/id/position order.
  const variants = [
    { id: 'z_history', state: 'cancelled', cancelledAt: AT, cancelledBy: 'ops', cancellationReason: 'Historical fixture', shopHandover: { arrivedPacked: [{ supplierId: 'supplier' }] } },
    { id: 'a_active', state: 'rider_assigned', riderId: 'rider' },
    { id: 'm_offer', state: 'ready_for_dispatch' },
    { id: 'held_offer', state: 'ready_for_dispatch' },
    { id: 'pickup_offer', state: 'ready_for_dispatch', fulfillmentMode: 'pickup', deliveryFeeMinor: 0 },
    { id: 'unreleased', fileCheck: { status: 'pending' } },
    { id: 'unrelated', clientId: 'other', supplierId: 'replacement' },
    { id: 'review', clientId: 'review_client', supplierId: 'review_supplier', riderId: 'review_rider', state: 'rider_assigned', reviewData: true },
    { id: 'review_offer', clientId: 'review_client', supplierId: 'review_supplier', state: 'ready_for_dispatch', reviewData: true },
    { id: 'dual_order', clientId: 'dual', supplierId: 'dual' },
    { id: 'multi', supplierId: null },
    { id: 'single_job', supplierId: null },
    { id: 'cancelled_job', supplierId: null },
    { id: 'legacy', payoutPlanVersion: 1, commercialCommittedAt: null, payoutMilestones: [] },
  ];
  for (const patch of variants) {
    const order = { ...structuredClone(base), ...patch };
    // Money remains consistent with the original fixture for every variant.
    if (order.deliveryFeeMinor === 0) {
      order.totalMinor = order.onlineDueMinor = 11000;
      order.payments.initial.amountMinor = 11000;
      order.paymentAllocations.find(row => row.component === 'delivery_pass_through').amountMinor = 0;
    }
    store.orders.push(order);
    store.orderJobs.push({ ...structuredClone(job), id: `job_${order.id}`, orderId: order.id,
      supplierId: order.supplierId || 'supplier', riderId: order.riderId, state: order.id === 'cancelled_job' ? 'cancelled' : order.state });
    store.orderLineItems.push({ ...structuredClone(line), id: `line_${order.id}`, orderId: order.id, jobId: `job_${order.id}`,
      artworkLinks: [], artworkFileId: `art_${order.id}`, specialInstructions: 'Keep the agreed colour',
      structuredSpecSnapshot: { material: 'Paper', size: 'A4' }, sortOrder: 0 });
    store.files.push({ fileId: `art_${order.id}`, ownerId: order.clientId, purpose: 'artwork', state: 'ready',
      objectKey: `private/art_${order.id}`, originalFilename: `${order.id}.pdf`, declaredContentType: 'application/pdf',
      detectedContentType: 'application/pdf', detected: { colors: { status: 'read', colors: [] } }, size: 100, createdAt: AT,
      references: [{ type: 'order', id: order.id, field: `line:line_${order.id}:artwork` }] });
    for (const purpose of ['production_photo', 'packing_photo', 'supplier_invoice']) {
      store.files.push({ fileId: `${purpose}_${order.id}`, ownerId: order.supplierId || 'supplier', purpose, state: 'ready',
        objectKey: `private/${purpose}_${order.id}`, originalFilename: `${purpose}.png`, declaredContentType: 'image/png',
        detectedContentType: 'image/png', size: 100, contentSha256: `${purpose}_${order.id}`, createdAt: AT,
        references: [{ type: 'order', id: order.id, field: purpose }] });
    }
  }
  for (const orderId of ['multi', 'cancelled_job']) {
    store.orderJobs.push({ ...structuredClone(job), id: `job_other_${orderId}`, orderId, supplierId: 'replacement' });
    store.orderLineItems.push({ ...structuredClone(line), id: `line_other_${orderId}`, orderId, jobId: `job_other_${orderId}`, sortOrder: 1 });
  }
  // A legacy reused artwork file can retain only its earlier order reference.
  store.files.find(file => file.fileId === 'art_a_active').references = [{ type: 'order', id: 'z_history', field: 'artworkFileIds' }];
  store.refundRequests.push({ id: 'refund_hold', orderId: 'held_offer', clientId: 'client', policyVersion: 'available_funds_v1', status: 'requested',
    version: 1, kind: 'cancellation', reason: 'Fixture', beforeProduction: false, late: false,
    filingDeadlineAt: AT, orderStateAtFiling: 'ready_for_dispatch', evidenceFileIds: [], destination: {}, createdAt: AT, updatedAt: AT });
  store.orderChanges.push({ id: 'change', orderId: 'a_active', supplierId: 'supplier', lineItemId: 'line_a_active', status: 'applied',
    version: 1, extraPrincipalMinor: 100, feeMinor: 20, totalMinor: 120, createdAt: AT,
    data: { originalPrincipalMinor: 10000, feeSchedule: { version: 1, rateBps: 2000 },
      payment: { proofFileId: 'supplement_proof', reference: 'SUPPLEMENT' }, proposedSpec: { material: 'Thicker paper' }, proposedReadyBy: base.readyBy, appliedAt: AT } });
  store.orderChangePayments.push({ id: 'change_payment', orderId: 'a_active', changeId: 'change', principalMinor: 100, feeMinor: 20,
    amountMinor: 120, reference: 'SUPPLEMENT', proofFileId: 'supplement_proof', confirmedBy: 'ops', createdAt: AT });
  store.files.push({ ...structuredClone(store.files.find(file => file.fileId === 'art_a_active')),
    fileId: 'supplement_proof', objectKey: 'private/supplement_proof', purpose: 'payment_proof', references: [] });
  store.zones.push({ id: 'zone_custom', code: 'custom', name: 'Custom historical zone', active: false });
  store.orders.find(row => row.id === 'a_active').zone = 'custom';
  // The detail's shop counter includes events on other orders, even another shop's order.
  store.orders.find(row => row.id === 'unrelated').shopHandover = { arrivedPacked: [{ supplierId: 'supplier' }, { supplierId: 'replacement' }] };
  store.orders.find(row => row.id === 'review').shopHandover = { arrivedPacked: [{ supplierId: 'supplier' }] };
  await database.transaction(() => saveStore(database, store));
  await database.query(`INSERT INTO shop_reviews (id,order_id,supplier_id,client_id,quality_stars,speed_stars,value_stars,comment,created_at)
    VALUES ('review_rating','z_history','supplier','client',5,4,5,'Fixture',$1)`, [AT]);
  return loadStore(database);
}

export function actorView(store, userId, pathname, { role, includeReviewData = false } = {}) {
  const raw = store.users.find(row => row.id === userId);
  const user = selectActorRole(store, raw, role || (pathname === '/jobs' && hasRole(store, userId, 'supplier') ? 'supplier' : raw.role),
    { restrictMemberships: Boolean(role) });
  if (isTestOperationsUser(store, userId)) store = testOperationsView(store, user);
  else if (['/orders', '/jobs'].includes(pathname) && ['ops_admin', 'super_admin'].some(role => identityHasMembership(user, role))) {
    store = reviewReportView(store, includeReviewData);
  }
  return { store, user };
}

export async function project(database, store, userId, pathname, options = {}) {
  const view = actorView(store, userId, pathname, options);
  store = view.store;
  const { user } = view;
  if (pathname === '/jobs' && user.role !== 'supplier') return { error: 'forbidden' };
  const visible = store.orders.filter(order => canAccessOrder(store, user.id, order, { role: user.role, offer: true }));
  const orders = pathname === '/jobs' ? store.orders.filter(order => order.supplierId === user.id && supplierArtworkReleased(order))
    : pathname === '/orders' ? visible : visible.filter(order => order.id === pathname.split('/')[2]);
  const records = await Promise.all(orders.map(async order => {
    const record = publicOrderFor(order, user, store);
    if (record.pickupChat) record.pickupChat.unread = await pickupChatUnread(database, order, user.id);
    const signing = { findFile: id => store.files.find(file => file.fileId === id),
      authorizeRead: file => authorizeFileRead(user, orderFileReadStore(store), file),
      presignGet: async key => ({ url: `https://storage.invalid/${key}`, expiresAt: '2099-01-01T00:00:00.000Z' }) };
    await signProductionPhotos(record, signing);
    await signProductionPhotos(record, signing, 'packingProgress');
    await signArtworkAttachments(record, signing);
    return record;
  }));
  return pathname === '/orders' ? { orders: records } : pathname === '/jobs' ? { jobs: records } : { order: records[0] };
}

