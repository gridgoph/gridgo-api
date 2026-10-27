/** Client-visible discount; supplier and rider funding remain staff-only. */
export function clientVoucher(voucher) {
  const visible = structuredClone(voucher);
  for (const field of ['supplierMinor', 'gridgoSupplierTopupMinor', 'gridgoRiderTopupMinor']) delete visible[field];
  return visible;
}
