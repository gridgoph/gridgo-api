// Eligibility comes from the database membership and Operations decision, never JWT metadata.
export function approvedOrganization(store, userId) {
  const user = (store.users || []).find((row) => row.id === userId);
  return Boolean(user && user.accountType === 'organization'
    && !['suspended', 'removed'].includes(user.accountStatus)
    && (store.userRoleMemberships || []).some((row) => row.userId === userId && row.role === 'client')
    && (store.approvalCases || []).some((row) => row.userId === userId && row.kind === 'business_client' && row.status === 'approved'));
}

export function organizationMoneyError(code, message, status = 400) {
  return Object.assign(new Error(message), { status, code });
}

export function validateOrganizationFee(settings) {
  const rate = Object.hasOwn(settings, 'organizationDiscountRateBps') ? settings.organizationDiscountRateBps : 500;
  if (!Number.isInteger(rate) || rate < 0 || rate > 10000) {
    throw organizationMoneyError('invalid_organization_discount', 'Organization discount must be integer basis points from 0 to 10000.');
  }
  if (settings.serviceFeeRateBps < rate) {
    throw organizationMoneyError('organization_discount_exceeds_service_fee', 'The service fee must cover the organization discount.');
  }
  return rate;
}

export function organizationFeeMoney(subtotalMinor, settings, eligible = false) {
  const configured = validateOrganizationFee(settings);
  if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor < 0) throw organizationMoneyError('invalid_money', 'Invalid printing subtotal.');
  const round = (rate) => Number((BigInt(subtotalMinor) * BigInt(rate) + 5000n) / 10000n);
  const grossServiceFeeMinor = round(settings.serviceFeeRateBps);
  if (BigInt(subtotalMinor) + BigInt(grossServiceFeeMinor) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw organizationMoneyError('invalid_money', 'Printing including the service fee exceeds the safe-integer range.');
  }
  const organizationDiscountRateBps = eligible ? configured : 0;
  const organizationDiscountMinor = round(organizationDiscountRateBps);
  return { grossServiceFeeMinor, organizationDiscountRateBps, organizationDiscountMinor,
    serviceFeeMinor: grossServiceFeeMinor - organizationDiscountMinor };
}

export function publicOrganizationDiscount(money) {
  return { organizationDiscountMinor: money.organizationDiscountMinor ?? 0,
    organizationDiscountLabel: 'Organization discount' };
}
