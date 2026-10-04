/** Shop gates shared by matching and the supplier's operational diagnostics. */
export function supplierMatchBlockersFor(store) {
  const accountStatuses = new Map((store.users || []).map(row => [row.id, row.accountStatus]));
  const members = new Set((store.userRoleMemberships || []).filter(row => row.role === "supplier").map(row => row.userId));
  const approved = new Set((store.approvalCases || []).filter(row => row.kind === "supplier" && row.status === "approved").map(row => row.userId));
  return (supplierId, profile) => {
    const missing = [];
    if ((accountStatuses.get(supplierId) ?? "active") !== "active") missing.push("account_inactive");
    if (!profile) missing.push("supplier_profile");
    else {
      if (profile.isClosed === true) missing.push("shop_closed");
      if (!profile.shop) missing.push("shop_location");
    }
    if (!members.has(supplierId)) {
      missing.push("supplier_membership");
    }
    if (!approved.has(supplierId)) {
      missing.push("supplier_not_approved");
    }
    return missing;
  };
}
