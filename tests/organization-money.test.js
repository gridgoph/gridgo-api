import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedOrganization, organizationFeeMoney } from '../src/organization-money.js';
import { calculateOrderMoney, defaultOperationalSettings, validateOperationalSettings } from '../src/operational-model.js';

const settings = defaultOperationalSettings();
test('only Operations-approved organization memberships receive the discount', () => {
  const store = { users: [{ id: 'c', accountType: 'organization' }], userRoleMemberships: [{ userId: 'c', role: 'client' }],
    approvalCases: [{ userId: 'c', kind: 'business_client', status: 'approved' }] };
  assert.equal(approvedOrganization(store, 'c'), true);
  for (const status of ['pending', 'rejected', 'suspended']) {
    store.approvalCases[0].status = status;
    assert.equal(approvedOrganization(store, 'c'), false);
  }
  store.approvalCases[0].status = 'approved';
  for (const accountType of ['individual', 'business']) {
    store.users[0].accountType = accountType;
    assert.equal(approvedOrganization(store, 'c'), false);
  }
  store.users[0].accountType = 'organization';
  store.userRoleMemberships = [];
  assert.equal(approvedOrganization(store, 'c'), false);
});
test('fee floor rejects either direction, malformed rates and preserves equality', () => {
  for (const patch of [{ serviceFeeRateBps: 499 }, { organizationDiscountRateBps: 1001 }]) {
    assert.throws(() => validateOperationalSettings({ ...settings, ...patch }), { code: 'organization_discount_exceeds_service_fee' });
  }
  for (const organizationDiscountRateBps of [-1, 10001, 1.5, '500', null]) {
    assert.throws(() => validateOperationalSettings({ ...settings, organizationDiscountRateBps }), { code: 'invalid_organization_discount' });
  }
  assert.equal(organizationFeeMoney(10000, { ...settings, serviceFeeRateBps: 500 }, true).serviceFeeMinor, 0);
  assert.equal(organizationFeeMoney(9999, settings, false).organizationDiscountMinor, 0);
  assert.equal(organizationFeeMoney(9999, settings, true).organizationDiscountMinor, 500);
});
test('legacy quote commitment reduces only the initial service-fee collection', () => {
  const options = { supplierSubtotalMinor: 100000, fulfillmentMode: 'delivery', paymentPlan: 'delivery_online',
    supplierDownpaymentRateBps: 2500, distanceMeters: 0, settings };
  const regular = calculateOrderMoney(options);
  const org = calculateOrderMoney({ ...options, organizationEligible: true });
  assert.equal(org.totalMinor, 113900);
  assert.equal(org.initialOnlineMinor, 30000);
  assert.equal(org.organizationDiscountMinor, 5000);
  for (const field of ['supplierPlatformPayoutMinor', 'riderPayoutMinor', 'finalOnlineMinor']) assert.equal(org[field], regular[field]);
});
