import { homePrinterStatus } from './home-printers.js';
import { shopPaused } from './shop-availability.js';
import {shopMoneyPaused} from './shop-money-policy.js';
import { supplierVerified, supplierCanWork, verificationSummary } from "./supplier-verification.js";
/** Missing standing retains the legacy active-account default. */
export function supplierAccountIsActive(accountStatus) {
  return (accountStatus ?? "active") === "active";
}

/** Shop gates shared by matching and the supplier's operational diagnostics. */
export function supplierMatchBlockersFor(store, clock = new Date().toISOString()) {
  const at = typeof clock === "string" ? clock : clock?.at ?? new Date().toISOString();
  const accountStatuses = new Map((store.users || []).map(row => [row.id, row.accountStatus]));
  const members = new Set((store.userRoleMemberships || []).filter(row => row.role === "supplier").map(row => row.userId));
  return (supplierId, profile) => {
    const missing = [];
    if(shopMoneyPaused(store,supplierId,at))missing.push('shop_payment_overdue');
    if (!supplierAccountIsActive(accountStatuses.get(supplierId))) missing.push("account_inactive");
    if (!profile) missing.push("supplier_profile");
    else {
      if (profile.isClosed === true || shopPaused(profile, at)) missing.push("shop_closed");
      if (!profile.shop) missing.push("shop_location");
    }
    if (!members.has(supplierId)) {
      missing.push("supplier_membership");
    }
    if(profile?.homePrinter && !supplierCanWork(store,supplierId))missing.push('supplier_not_approved');
    if(profile?.homePrinter) { const status=homePrinterStatus(store,profile,at);if(status.reason)missing.push(status.reason); }
    if (!supplierVerified(store,supplierId)) {
      if (!supplierCanWork(store,supplierId)) missing.push("supplier_not_approved");
      const hasDocumentService=(store.supplierServices||[]).some(service=>service.supplierId===supplierId
        && !["withdrawn","suspended"].includes(service.state) && (["documents","document_publication"].includes(service.categoryCode)
          || (store.catalogItems||[]).some(item=>item.supplierServiceId===service.id&&item.subcategoryCode==="document_printing")));
      if (!hasDocumentService) missing.push("document_service");
      const account=(store.supplierPayoutAccounts||[]).find(row=>row.supplierId===supplierId);
      if (!account?.qrFileId || !(store.files||[]).some(f=>f.fileId===account.qrFileId&&f.ownerId===supplierId&&f.purpose==="supplier_payout_qr"&&f.state==="ready"&&!f.deleteRequestedAt&&!f.deletedAt)) missing.push("payout_qr");
      const summary=verificationSummary(store,supplierId,at);
      if (!profile?.homePrinter && (!summary.deadlineAt || Date.parse(at)>=Date.parse(summary.deadlineAt))) missing.push("verification_deadline");
    }
    if (!supplierVerified(store,supplierId) && verificationSummary(store,supplierId,at).recoveryDueMinor>0) missing.push("verification_recovery");
    return missing;
  };
}
