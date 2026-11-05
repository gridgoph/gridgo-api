import { setupReadParity } from './read-parity.js';
import { listingSnapshot } from '../../src/catalog-review-state.js';
import { saveStore } from '../../src/postgres-store.js';
import { createTesterReward, issueTesterReward } from '../../src/tester-rewards.js';
import { AT, id } from './reschedule.js';

export async function setupOperationsReads(database) {
  const store = await setupReadParity(database);
  const item = store.catalogItems.find(row => row.id === 'item_supplier');
  store.catalogOptionGroups.push({ id: 'ops_group', catalogItemId: item.id, name: 'Paper', kind: 'spec',
    required: true, selectionMode: 'single', sortOrder: 0, version: 1, createdAt: AT, updatedAt: AT });
  for (const [id, active, sortOrder, priceModifierMinor, priceMultiplierBps] of [['ops_option_z', false, 1, 0, 15000], ['ops_option_a', true, 0, 100, null]]) {
    store.catalogOptions.push({ id, optionGroupId: 'ops_group', label: id, priceModifierMinor,
      priceMultiplierBps, active, sortOrder, createdAt: AT, updatedAt: AT });
  }
  store.catalogPriceTiers.push({ id: 'ops_price', catalogItemId: item.id, minQuantity: 100, unitPriceMinor: 900, createdAt: AT, updatedAt: AT });
  store.catalogSpeedTiers.push({ id: 'ops_speed', catalogItemId: item.id, label: 'Express', turnaroundHours: 1,
    surchargeMinor: 500, sortOrder: 0, createdAt: AT, updatedAt: AT });
  store.catalogPrepSteps.push({ id: 'ops_prep', catalogItemId: item.id, title: 'Prepare PDF', body: 'Keep margins', sortOrder: 0, createdAt: AT, updatedAt: AT });
  item.fileFormatMode = 'override';
  store.catalogItemFileFormats.push({ catalogItemId: item.id, formatCode: 'pdf' });
  item.approvedSnapshot = listingSnapshot(store, item);
  item.reviewStatus = 'pending'; item.name = 'Private draft name';
  for (const [i, orderId] of ['a_active', 'unrelated', 'review', 'unreleased', 'multi', 'order'].entries()) {
    const order = store.orders.find(row => row.id === orderId);
    const claimId = `claim_${orderId}`;
    store.claims.push({ id: claimId, orderId, status: i % 2 ? 'released' : 'payout_held', reason: `Claim ${i}`,
      raisedBy: order.clientId, createdAt: AT, updatedAt: AT, timeline: [{ at: AT, action: 'raised' }] });
    store.issues.push({ id: `issue_${orderId}`, orderId, clientId: order.clientId, claimId,
      kind: 'material', status: i % 2 ? 'resolved' : 'open', description: `Issue ${i}`, createdAt: AT, updatedAt: AT,
      photoFileIds: [`art_${orderId}`], evidenceSnapshot: { private: true }, faultDecisionHistory: [{ note: 'staff only' }],
      faultDecision: { id: `decision_${i}`, status: 'approved', fault: 'shop', recordedAt: AT, reason: 'Fixture', internal: true } });
    store.escalations.push({ id: `escalation_${orderId}`, orderId, riderId: order.riderId || 'rider', supplierId: order.supplierId,
      status: i % 2 ? 'resolved' : 'open', createdAt: AT, updatedAt: AT, counts: [{ expected: 10, actual: 9 }] });
  }
  // Test-operations views must inspect related claim and creator marks too.
  store.claims.push({ ...structuredClone(store.claims.find(row => row.id === 'claim_order')), id: 'hidden_claim_reference' });
  store.issues.push({ ...structuredClone(store.issues.find(row => row.id === 'issue_review')),
    id: 'review_hidden_claim', claimId: 'hidden_claim_reference' });
  store.claims.push({ id: 'review_hidden_creator', orderId: 'review', createdBy: 'client', status: 'open', createdAt: AT, updatedAt: AT });
  store.riderProfiles.push({ userId: 'rider', vehicleType: 'motorcycle', plateNumber: 'TEST123', licenseNumber: 'TEST', updatedAt: AT });
  store.users.find(row => row.id === 'supplier').verificationDocumentFileIds = ['verification', 'bad_verification', 'foreign_verification'];
  const file = store.files[0];
  for (const [fileId, fields] of Object.entries({ verification: {}, bad_verification: { state: 'delete_pending' }, foreign_verification: { ownerId: 'replacement' }, payout_qr: { purpose: 'supplier_payout_qr' } })) {
    store.files.push({ ...structuredClone(file), fileId, ownerId: 'supplier', purpose: 'verification_document',
      objectKey: `private/${fileId}`, references: [{ type: 'user', id: 'supplier', field: 'verificationDocumentFileIds' }], ...fields });
  }
  store.supplierPayoutAccounts.push({ supplierId: 'supplier', provider: 'gcash', accountName: 'Printer', accountNumber: '09123456789', qrFileId: 'payout_qr', version: 2, updatedAt: AT });
  const reward = createTesterReward(store, { kind: 'mission', clientId: 'client', amountMinor: 1500 }, { id, at: AT });
  issueTesterReward(store, reward, { id, at: AT });
  store.foundingTesters.push({ clientId: 'client', awardedAt: AT, addedAt: AT, rewardVoucherId: reward.voucherId });
  for (let i = 0; i < 65; i++) store.auditLog.push({ id: `ops_audit_${String(i).padStart(3, '0')}`, at: AT, actorId: 'ops', actorRole: 'ops_admin', action: i % 2 ? 'order.production_override' : 'user.role_change',
    entityType: i % 2 ? 'order' : 'user', entityId: i % 2 ? 'a_active' : 'supplier', orderId: i % 3 ? 'a_active' : 'review', detail: { reason: 'Fixture' } });
  await database.transaction(() => saveStore(database, store));
  // Authentication telemetry is independent of reads; keep directory timestamps
  // stable while the two child processes adopt their test sessions.
  await database.query("UPDATE users SET last_authenticated_at = '2099-01-01'::timestamptz");
  return store;
}
