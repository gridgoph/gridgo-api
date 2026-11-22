/** Independent destination/ownership holds apply to every shop payment. */
export function supplierPayoutStatus(store,supplierId,at=new Date().toISOString()) {
  const signup=(store?.supplierSignups||[]).find(s=>s.supplierId===supplierId);
  const ownerClaimRequired=signup?.steps?.eligibility?.registrantRole==='manager'
    && !(store?.shopMemberships||[]).some(m=>m.shopId===supplierId&&m.role==='owner'&&m.status==='active');
  const policy=(store?.supplierPayoutPolicies||[]).find(p=>p.supplierId===supplierId);
  const pausedUntil=policy?.pausedUntil||null;
  const account=(store?.supplierPayoutAccounts||[]).find(p=>p.supplierId===supplierId);
  const qrReady=account?.qrFileId&&(store?.files||[]).some(f=>f.fileId===account.qrFileId&&f.state==='ready'&&!f.deletedAt&&!f.deleteRequestedAt);
  const reason=ownerClaimRequired?'shop_owner_claim_required':Date.parse(pausedUntil)>Date.parse(at)?'supplier_payout_paused'
    :signup&&(!qrReady||!policy?.consent)?'supplier_payout_account_required':null;
  return {held:Boolean(reason),reason,ownerClaimRequired,pausedUntil};
}
export function assertSupplierPayoutAllowed(store,supplierId,at) {
  const status=supplierPayoutStatus(store,supplierId,at);
  if(status.held)throw Object.assign(new Error('Shop payouts are held until the owner has claimed the shop, saved its payout QR and any destination pause has ended.'),
    {status:409,code:status.reason,details:status});
}
