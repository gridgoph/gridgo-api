import { schoolYear } from '../../src/member-perks.js';

// Invented organizations only: one verified partner per call, with an officer of record.
export function addPartner(store, { orgId = 'org', label = 'Sample Guild', at, perk = null, override = null } = {}) {
  for (const key of ['auditLog', 'notifications', 'memberPerkUses', 'clientProfiles', 'approvalCases', 'userRoleMemberships']) store[key] ||= [];
  store.users.push({ id: orgId, role: 'client', email: `${orgId}@example.invalid`, name: `${label} account`, clerkUserId: `clerk_${orgId}`, accountType: 'organization', orgName: label, createdAt: at });
  store.userRoleMemberships.push({ userId: orgId, role: 'client', createdAt: at });
  store.clientProfiles.push({ userId: orgId, clientKind: 'business', businessName: label, businessNature: 'Student organization', updatedAt: at });
  store.approvalCases.push({ id: `case_${orgId}`, userId: orgId, kind: 'business_client', status: 'approved', version: 1, applicationRevision: 1, submittedAt: at, decidedAt: at, createdAt: at, updatedAt: at });
  (store.organizationAccounts ||= []).push({ userId: orgId, nameKey: `${orgId}-key`, schoolKey: 'sample-school', name: label, school: 'Sample School', email: `${orgId}@example.invalid`,
    currentOfficer: { id: `officer_${orgId}`, fullName: 'Officer One', startedAt: at }, history: [], updatedAt: at });
  (store.organizationPartners ||= []).push({ userId: orgId, label, status: 'active', partnerSince: '2026-06-01', version: 1, createdAt: at, updatedAt: at, data: { benefits: { badge: true } } });
  store.memberPerkSettings ||= [];
  if (perk) setPerk(store, null, perk, at);
  if (override) setPerk(store, orgId, override, at);
}
export function setPerk(store, orgId, perk, at) {
  store.memberPerkSettings = store.memberPerkSettings.filter(row => row.organizationUserId !== orgId);
  store.memberPerkSettings.push({ id: orgId || 'standard', organizationUserId: orgId, enabled: true, amountMinor: 1000, maxOrdersPerTerm: 5, endsAt: '2027-03-31T16:00:00.000Z',
    budgetCapMinor: 100000, version: 1, updatedAt: at, updatedBy: null, ...perk });
}
export function addMember(store, clientId, { orgId = 'org', at, status = 'active', id = `mem_${orgId}_${clientId}`, ...rest } = {}) {
  const term = schoolYear(at);
  (store.organizationMemberships ||= []).push({ id, organizationUserId: orgId, clientId, status, source: 'qr', term: term.code, termEndsAt: term.endsAt, memberSince: '2024-08-01', requestedAt: at,
    version: 1, createdAt: at, updatedAt: at, data: { terms: [{ term: term.code, approvedAt: at, approvedBy: orgId }] }, ...rest });
  return store.organizationMemberships.at(-1);
}
