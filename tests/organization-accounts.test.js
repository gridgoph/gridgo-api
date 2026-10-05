import test from 'node:test';
import assert from 'node:assert/strict';
import { applyForBusiness } from '../src/enrollment.js';
import { authorizeFileRead } from '../src/attachments.js';

const at = '2026-10-05T00:00:00.000Z';
export function fixture(track = 'organization') {
  const user = { id: 'client', role: 'client', email: 'organization@example.test', accountType: 'individual' };
  const store = { users: [user], userRoleMemberships: [{ userId: user.id, role: 'client' }], clientProfiles: [],
    approvalCases: [], approvalCaseEvents: [], notifications: [], auditLog: [], files: [] };
  const keys = track === 'organization' ? ['government_id', 'student_id', 'enrollment_document']
    : track === 'sole_proprietor' ? ['government_id', 'payout_bank_proof', 'bir_2303', 'dti_certificate']
      : ['government_id', 'payout_bank_proof', 'bir_2303', 'sec_certificate', 'articles_and_bylaws', 'general_information_sheet', 'signatory_authorization'];
  const documents = Object.fromEntries(keys.map((key) => [key, `file_${key}`]));
  store.files = Object.values(documents).map((fileId) => ({ fileId, ownerId: user.id, purpose: 'client_verification_document', state: 'ready', references: [] }));
  const person = { fullName: 'Officer One', dateOfBirth: '2000-01-01', address: 'Test address', phone: '+639000000000',
    governmentIdType: 'passport', governmentIdExpiresOn: '2030-01-01', originalId: true, detailsMatchId: true };
  const body = { businessName: 'Test organization', businessNature: 'Education', accountType: track === 'organization' ? track : 'business',
    documents, ...(track === 'organization' ? { school: 'Test school', organizationEmail: user.email, officer: { ...person, studentIdExpiresOn: '2030-01-01' } }
      : { businessType: track, signatory: person }) };
  let sequence = 0;
  return { store, user, body, idempotencyKey: 'apply-one', createId: (prefix) => `${prefix}_${++sequence}`, now: () => at };
}

test('legacy name-only submissions cannot bypass the document checklist', () => {
  const ctx = fixture('sole_proprietor');
  ctx.body = { businessName: 'Test business', businessNature: 'Printing' };
  assert.throws(() => applyForBusiness(ctx), (error) => error.code === 'invalid_application');
});

test('client verification files are private to Operations and Super Admin, including the owner', () => {
  const { store, user } = fixture();
  const file = store.files[0];
  assert.throws(() => authorizeFileRead(user, store, file), (error) => error.status === 403);
  assert.doesNotThrow(() => authorizeFileRead({ id: 'ops', role: 'ops_admin' }, store, file));
  assert.doesNotThrow(() => authorizeFileRead({ id: 'super', role: 'super_admin' }, store, file));
});

import { decideApprovalCase } from '../src/approval-cases.js';
import { officerSnapshot } from '../src/client-applications.js';
import { retentionDecision } from '../src/file-retention-policy.js';
function verify(ctx) {
  ctx.store.organizationEmailChallenges = [{ userId: ctx.user.id, email: ctx.user.email, verifiedAt: at,
    expiresAt: '2026-10-05T01:00:00.000Z' }];
}
function approve(ctx, approvalCase, when = at) {
  return decideApprovalCase({ store: ctx.store, caseId: approvalCase.id, action: 'approve',
    input: { expectedVersion: approvalCase.version, requestId: `approve-${approvalCase.version}` },
    actor: { id: 'ops' }, actorRole: 'ops_admin', at: when, createId: ctx.createId });
}
for (const track of ['organization', 'sole_proprietor', 'partnership', 'corporation']) {
  test(`${track}: every checklist item is required and a complete application opens a review case`, () => {
    const ctx = fixture(track);
    verify(ctx);
    for (const key of Object.keys(ctx.body.documents)) {
      const body = structuredClone(ctx.body);
      delete body.documents[key];
      assert.throws(() => applyForBusiness({ ...ctx, body }), (error) => Boolean(error.details?.fields?.[`documents.${key}`]));
    }
    const result = applyForBusiness(ctx);
    assert.equal(result.approvalCase.status, 'pending');
    assert.equal(ctx.user.accountType, 'individual');
    assert.equal(ctx.store.files.every((file) => file.references.length === 1), true);
    approve(ctx, result.approvalCase);
    assert.equal(ctx.user.accountType, track === 'organization' ? 'organization' : 'business');
    if (track === 'organization') {
      assert.equal(officerSnapshot(ctx.store, ctx.user.id).fullName, 'Officer One');
      assert.equal(ctx.store.organizationAccounts[0].nextConfirmationAt, '2027-01-05T00:00:00.000Z');
    }
  });
}
test('organization email must be verified, fresh, unconsumed and bound to the shared login', () => {
  const ctx = fixture();
  assert.throws(() => applyForBusiness(ctx), { code: 'organization_email_verification_required' });
  verify(ctx);
  ctx.store.organizationEmailChallenges[0].consumedAt = at;
  assert.throws(() => applyForBusiness(ctx), { code: 'organization_email_verification_required' });
  verify(ctx);
  ctx.store.organizationEmailChallenges[0].expiresAt = at;
  assert.throws(() => applyForBusiness(ctx), { code: 'organization_email_verification_required' });
  verify(ctx);
  const first = applyForBusiness(ctx);
  assert.equal(applyForBusiness(ctx).approvalCase.id, first.approvalCase.id);
});
test('organization name and school pairs are reserved across whitespace and case changes', () => {
  const ctx = fixture(); verify(ctx);
  ctx.store.organizationAccounts = [{ userId: 'other', nameKey: 'test organization', schoolKey: 'test school' }];
  ctx.body.businessName = ' TEST  Organization ';
  assert.throws(() => applyForBusiness(ctx), { code: 'organization_already_exists' });
});
test('approval rechecks expired IDs and removed files', () => {
  const ctx = fixture('corporation');
  const { approvalCase } = applyForBusiness(ctx);
  ctx.store.files[0].state = 'deleted';
  assert.throws(() => approve(ctx, approvalCase), { code: 'invalid_application' });
  assert.equal(approvalCase.status, 'pending');
});
test('rejected application documents expire after one year independently of later case status', () => {
  const ctx = fixture('sole_proprietor');
  const { approvalCase } = applyForBusiness(ctx);
  decideApprovalCase({ store: ctx.store, caseId: approvalCase.id, action: 'reject', input: { expectedVersion: 1,
    requestId: 'reject', reason: 'Replace evidence' }, actor: { id: 'ops' }, actorRole: 'ops_admin', at, createId: ctx.createId });
  approvalCase.status = 'pending';
  assert.equal(retentionDecision(ctx.store, ctx.store.files[0], '2027-10-04T00:00:00.000Z').eligible, false);
  assert.equal(retentionDecision(ctx.store, ctx.store.files[0], '2027-10-05T00:00:00.000Z').eligible, true);
});

import { requestOrganizationCode, verifyOrganizationCode } from '../src/organization-email.js';
test('email codes are hashed, rate limited, expire and are single use', async () => {
  const ctx = fixture(); let code;
  const params = { ...ctx, at, body: { email: ctx.user.email }, secret: 'test-secret',
    mailer: { configured: true, sendCode: async (_email, value) => { code = value; } } };
  await requestOrganizationCode(params);
  assert.equal(JSON.stringify(ctx.store).includes(code), false);
  await assert.rejects(requestOrganizationCode(params), { code: 'organization_code_rate_limited' });
  assert.equal(verifyOrganizationCode({ ...params, body: { code } }).status, 200);
  assert.equal(verifyOrganizationCode({ ...params, body: { code } }).status, 400);
  assert.equal(ctx.store.organizationEmailChallenges[0].codeHash, undefined);
});
test('five failed guesses lock the code and a resend replaces the old code', async () => {
  const ctx = fixture(); let code;
  const params = { ...ctx, at, body: { email: ctx.user.email }, secret: 'test-secret',
    mailer: { configured: true, sendCode: async (_email, value) => { code = value; } } };
  await requestOrganizationCode(params);
  for (let index = 0; index < 5; index++) assert.equal(verifyOrganizationCode({ ...params, body: { code: 'wrong' } }).status, 400);
  assert.equal(verifyOrganizationCode({ ...params, body: { code } }).status, 400);
  await requestOrganizationCode({ ...params, at: '2026-10-05T00:01:00.000Z' });
  assert.equal(verifyOrganizationCode({ ...params, at: '2026-10-05T00:11:00.000Z', body: { code } }).status, 400);
});

import { routeOrganization, sweepOfficerConfirmations } from '../src/organization-routes.js';
import { publicNotification } from '../src/notifications.js';
async function call(ctx, path, body = {}, user = ctx.user, method = 'POST', key = 'request-one', when = at) {
  return routeOrganization({ store: ctx.store, user, req: { method, headers: { 'idempotency-key': key } },
    url: new URL(path, 'http://test'), readBody: async () => body, now: () => when, createId: ctx.createId });
}
function verifiedOrganization() {
  const ctx = fixture(); verify(ctx);
  const { approvalCase } = applyForBusiness(ctx); approve(ctx, approvalCase);
  ctx.store.users.push({ id: 'ops', role: 'ops_admin' }, { id: 'super', role: 'super_admin' }, { id: 'past', role: 'client' });
  ctx.store.userRoleMemberships.push({ userId: 'ops', role: 'ops_admin' }, { userId: 'super', role: 'super_admin' });
  return ctx;
}
function newOfficerBody(ctx) {
  const body = { officer: { ...ctx.body.officer, fullName: 'Officer Two' }, documents: {}, expectedVersion: ctx.store.approvalCases[0].version };
  for (const [key, fileId] of Object.entries(ctx.body.documents)) {
    body.documents[key] = `${fileId}_new`;
    ctx.store.files.push({ ...ctx.store.files.find((file) => file.fileId === fileId), fileId: body.documents[key], references: [], clientApplicationApprovedAt: undefined });
  }
  verify(ctx);
  return body;
}
test('handover preserves the old officer until verification, then closes dated history; retries do not duplicate it', async () => {
  const ctx = verifiedOrganization();
  const before = officerSnapshot(ctx.store, ctx.user.id);
  const body = newOfficerBody(ctx);
  await call(ctx, '/me/organization/officer/handover', body);
  assert.deepEqual(officerSnapshot(ctx.store, ctx.user.id), before);
  assert.equal(ctx.user.accountType, 'organization');
  assert.equal(ctx.store.approvalCases[0].status, 'pending');
  assert.equal((await call(ctx, '/me/organization/officer/handover', body)).status, 200);
  approve(ctx, ctx.store.approvalCases[0], '2026-10-06T00:00:00.000Z');
  const account = ctx.store.organizationAccounts[0];
  assert.equal(account.currentOfficer.fullName, 'Officer Two');
  assert.equal(account.history.length, 2);
  assert.equal(account.history[0].endedAt, '2026-10-06T00:00:00.000Z');
  assert.equal(account.history[1].startedAt, account.history[0].endedAt);
  assert.equal(before.fullName, 'Officer One');
  await assert.rejects(call(ctx, '/me/organization/officer/confirm', { officerId: before.id }), { code: 'officer_changed' });
});
test('handover cannot reuse approved evidence or bypass verification using a name change', async () => {
  const ctx = verifiedOrganization(); verify(ctx);
  await assert.rejects(call(ctx, '/me/organization/officer/handover', { officer: ctx.body.officer,
    documents: ctx.body.documents, expectedVersion: 2 }), { code: 'new_officer_documents_required' });
  await assert.rejects(call(ctx, '/me/organization/officer/handover', { officer: { fullName: 'Officer Two' }, expectedVersion: 2 }), { code: 'invalid_application' });
  assert.equal(ctx.store.organizationAccounts[0].currentOfficer.fullName, 'Officer One');
});
test('quarterly sweep is durable and idempotent, exposes confirm/change actions and confirmation resets its clock', async () => {
  const ctx = verifiedOrganization();
  assert.equal(sweepOfficerConfirmations(ctx.store, { at: '2027-01-04T23:59:59.000Z', createId: ctx.createId }), 0);
  assert.equal(sweepOfficerConfirmations(ctx.store, { at: '2027-01-05T00:00:00.000Z', createId: ctx.createId }), 1);
  assert.equal(sweepOfficerConfirmations(ctx.store, { at: '2027-01-05T00:00:00.000Z', createId: ctx.createId }), 0);
  const notice = ctx.store.notifications.find((row) => row.type === 'organization_officer_confirmation' && row.userId === ctx.user.id);
  assert.deepEqual(publicNotification(notice).actions, ['confirm_officer', 'change_officer']);
  const confirmed = await call(ctx, '/me/organization/officer/confirm', { officerId: notice.officerId }, ctx.user, 'POST', 'confirm', '2027-01-06T00:00:00.000Z');
  assert.equal(confirmed.body.organization.nextConfirmationAt, '2027-04-06T00:00:00.000Z');
  assert.equal(confirmed.body.organization.confirmationRequestedAt, null);
  const count = ctx.store.notifications.length;
  await call(ctx, '/me/organization/officer/confirm', { officerId: notice.officerId });
  assert.equal(ctx.store.notifications.length, count);
});
test('staff notices reach the current shared login and staff inboxes, never historical officers', async () => {
  const ctx = verifiedOrganization();
  ctx.store.organizationAccounts[0].history.unshift({ id: 'past-officer', userId: 'past', fullName: 'Former Officer', endedAt: at });
  const body = { title: 'Test notice', body: 'Please review the ordering schedule.' };
  await assert.rejects(call(ctx, `/ops/organizations/${ctx.user.id}/notice`, body), { code: 'forbidden' });
  const ops = ctx.store.users.find((row) => row.id === 'ops');
  const result = await call(ctx, `/ops/organizations/${ctx.user.id}/notice`, body, ops);
  assert.equal(result.status, 201);
  const notices = ctx.store.notifications.filter((row) => row.type === 'organization_notice');
  assert.deepEqual(notices.map((row) => row.userId).sort(), ['client', 'ops', 'super']);
  const replay = await call(ctx, `/ops/organizations/${ctx.user.id}/notice`, body, ops);
  assert.equal(replay.body.notificationId, result.body.notificationId);
  await assert.rejects(call(ctx, `/ops/organizations/${ctx.user.id}/notice`, { ...body, title: 'Different' }, ops), { code: 'idempotency_conflict' });
});
test('staff can require a business permit before approval and applicants must resubmit it', async () => {
  const ctx = fixture('sole_proprietor');
  const { approvalCase } = applyForBusiness(ctx);
  await call(ctx, `/approval-cases/${approvalCase.id}/request-business-permit`, { expectedVersion: 1, reason: 'Permit needed for review' }, { id: 'ops', role: 'ops_admin' });
  assert.throws(() => approve(ctx, approvalCase), (error) => Boolean(error.details?.fields?.['documents.business_permit']));
});

test('rejecting a handover retains the active officer documents and expires only rejected incoming evidence', async () => {
  const ctx = verifiedOrganization();
  const body = newOfficerBody(ctx);
  await call(ctx, '/me/organization/officer/handover', body);
  const approvalCase = ctx.store.approvalCases[0];
  decideApprovalCase({ store: ctx.store, caseId: approvalCase.id, action: 'reject', input: { expectedVersion: approvalCase.version,
    requestId: 'reject-handover', reason: 'Replace incoming evidence' }, actor: { id: 'ops' }, actorRole: 'ops_admin', at, createId: ctx.createId });
  const oldFile = ctx.store.files.find((row) => row.fileId === ctx.body.documents.government_id);
  const newFile = ctx.store.files.find((row) => row.fileId === body.documents.government_id);
  assert.equal(retentionDecision(ctx.store, oldFile, '2028-10-05T00:00:00.000Z').eligible, false);
  assert.equal(retentionDecision(ctx.store, newFile, '2028-10-05T00:00:00.000Z').eligible, true);
  assert.equal(ctx.store.organizationAccounts[0].currentOfficer.fullName, 'Officer One');
});

test('staff can list and notify a legacy organization while its first officer is awaiting verification', async () => {
  const ctx = fixture();
  ctx.user.accountType = 'organization'; ctx.user.orgName = 'Legacy organization';
  const ops = { id: 'ops', role: 'ops_admin' };
  const list = await call(ctx, '/ops/organizations', {}, ops, 'GET');
  assert.equal(list.body.organizations[0].currentOfficer, null);
  assert.equal((await call(ctx, '/ops/organizations/client/notice', { title: 'Review', body: 'Please complete officer verification.' }, ops)).status, 201);
});
test('malformed organization JSON is a client error', async () => {
  const ctx = fixture();
  await assert.rejects(call(ctx, '/me/organization/email-code', null), { status: 400, code: 'invalid_request' });
});

test('quarter boundaries clamp the day and inactive organizations receive no reminders', async () => {
  const ctx = verifiedOrganization();
  const { nextQuarter } = await import('../src/client-applications.js');
  assert.equal(nextQuarter('2026-01-31T12:00:00.000Z'), '2026-04-30T12:00:00.000Z');
  assert.equal(nextQuarter('2027-11-30T12:00:00.000Z'), '2028-02-29T12:00:00.000Z');
  ctx.user.accountStatus = 'removed';
  assert.equal(sweepOfficerConfirmations(ctx.store, { at: '2030-01-01T00:00:00.000Z', createId: ctx.createId }), 0);
});
test('corrected rejected applications retain prior revisions and enforce requested permits', () => {
  const ctx = fixture('sole_proprietor');
  const first = applyForBusiness(ctx);
  decideApprovalCase({ store: ctx.store, caseId: first.approvalCase.id, action: 'reject', input: { expectedVersion: 1,
    requestId: 'reject-for-correction', reason: 'Replace evidence' }, actor: { id: 'ops' }, actorRole: 'ops_admin', at, createId: ctx.createId });
  ctx.body.expectedVersion = 2;
  ctx.idempotencyKey = 'corrected';
  const next = applyForBusiness(ctx);
  assert.equal(next.approvalCase.id, first.approvalCase.id);
  assert.equal(next.approvalCase.applicationRevision, 2);
  assert.equal(ctx.store.approvalCaseEvents.filter((row) => row.actorKind === 'applicant').length, 2);
  assert.equal(ctx.store.files[0].clientApplicationRejectedAt, undefined);
  approve(ctx, next.approvalCase);
  assert.equal(ctx.user.accountType, 'business');
});

test('unknown business tracks, including object prototype keys, are validation errors', () => {
  const ctx = fixture('sole_proprietor');
  for (const businessType of ['invalid', 'toString', '__proto__']) {
    assert.throws(() => applyForBusiness({ ...ctx, body: { ...ctx.body, businessType } }), { code: 'invalid_application' });
  }
});

test('a business cannot select the organization checklist to omit bank and registration evidence', () => {
  const ctx = fixture();
  ctx.body = { accountType: 'business', businessType: 'organization', businessName: 'Test business', businessNature: 'Printing',
    signatory: ctx.body.officer, documents: ctx.body.documents };
  assert.throws(() => applyForBusiness(ctx), { code: 'invalid_application' });
});
