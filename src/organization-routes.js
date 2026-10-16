import { identityHasMembership } from "./authorization-context.js";
import { applyForBusiness, requireIdempotencyKey } from './enrollment.js';
import { APPLICATION_DOCUMENTS, applicationError as fail, clientApplicationView, currentApplication, nextQuarter } from './client-applications.js';
import { requestOrganizationCode, verifyOrganizationCode } from './organization-email.js';
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';

const staff = (user) => ['ops_admin', 'super_admin'].includes(user?.role);
function organizationAccount(store, userId) {
  const account = (store.organizationAccounts || []).find((row) => row.userId === userId);
  if (account) return account;
  const owner = (store.users || []).find((row) => row.id === userId && row.accountType === 'organization');
  return owner ? { userId, name: owner.orgName, school: null, email: owner.email, currentOfficer: null, history: [] } : null;
}
export function organizationProjection(store, userId, { includeHistory = false } = {}) {
  const account = organizationAccount(store, userId);
  if (!account) return null;
  const approvalCase = (store.approvalCases || []).find((row) => row.userId === userId && row.kind === 'business_client');
  return { userId, name: account.name, school: account.school, email: account.email,
    currentOfficer: account.currentOfficer, confirmedAt: account.confirmedAt || null,
    nextConfirmationAt: account.nextConfirmationAt || null, confirmationRequestedAt: account.confirmationRequestedAt || null,
    approvalCase: approvalCase ? { id: approvalCase.id, status: approvalCase.status, version: approvalCase.version,
      applicationRevision: approvalCase.applicationRevision } : null,
    actions: account.currentOfficer ? ['confirm_officer', 'change_officer'] : ['submit_application'],
    ...(includeHistory ? { officerHistory: account.history } : {}) };
}
function event(store, { account, type, title, body, at, createId, actorId = null, actorRole = null, eventKey, detail = {} }) {
  store.notifications ||= [];
  const recipients = [{ userId: account.userId, appRole: 'client' }, ...privilegedAdminMemberships(store).map((row) => ({ userId: row.userId, appRole: row.role }))];
  for (const recipient of recipients) {
    store.notifications.push({ id: createId('ntf'), ...recipient, type, title, body, read: false, at,
      organizationUserId: account.userId, officerId: account.currentOfficer?.id || null,
      domainEventKey: eventKey });
  }
  store.auditLog ||= [];
  store.auditLog.push({ id: createId('aud'), at, actorId, actorRole, action: type, entityType: 'organization',
    entityId: account.userId, detail });
  queueInvalidate(store, { resource: 'identity', id: account.userId });
}
export function sweepOfficerConfirmations(store, { at, createId }) {
  let changed = 0;
  for (const account of store.organizationAccounts || []) {
    const owner = (store.users || []).find((row) => row.id === account.userId);
    const approvalCase = (store.approvalCases || []).find((row) => row.userId === account.userId && row.kind === 'business_client');
    if (!owner || (owner.accountStatus && owner.accountStatus !== 'active') || approvalCase?.status === 'suspended'
      || !account.currentOfficer || !account.nextConfirmationAt || Date.parse(account.nextConfirmationAt) > Date.parse(at)) continue;
    const due = account.nextConfirmationAt;
    event(store, { account, type: 'organization_officer_confirmation', title: 'Confirm your organization officer',
      body: `Confirm ${account.currentOfficer.fullName} is still the officer, or start a change of officer.`,
      at, createId, eventKey: `organization-confirmation:${account.userId}:${due}` });
    account.confirmationRequestedAt = at;
    // Missed cycles coalesce into one notice; the next date stays on the schedule.
    do { account.nextConfirmationAt = nextQuarter(account.nextConfirmationAt); }
    while (Date.parse(account.nextConfirmationAt) <= Date.parse(at));
    account.updatedAt = at;
    changed++;
  }
  return changed;
}
export async function routeOrganization({ req, url, store, user, readBody, now, createId, mailer, emailSecret }) {
  const path = url.pathname;
  if (path === '/me/organization/statements') return null;
  const mine = path === '/me/client-application' || path === '/me/client-application/checklist' || path === '/me/organization' || path.startsWith('/me/organization/');
  const ops = /^\/ops\/organizations(?:\/[^/]+(?:\/notice)?)?$/.test(path);
  const permit = /^\/approval-cases\/([^/]+)\/request-business-permit$/.exec(path);
  if (!mine && !ops && !permit) return null;
  if (!user) fail(401, 'unauthorized');
  if (mine && !(store.userRoleMemberships || []).some((row) => row.userId === user.id && row.role === 'client')) fail(403, 'membership_required');
  if (ops && !staff(user)) fail(403, 'forbidden');
  if (permit && !identityHasMembership(user, 'super_admin')) fail(403, 'forbidden');
  const at = now();
  const input = async () => {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request');
    return body;
  };
  if (path === '/me/client-application' && req.method === 'GET') return { status: 200, body: clientApplicationView(store, user.id) };
  if (path === '/me/client-application/checklist' && req.method === 'GET') return { status: 200, body: {
    requiredDocuments: APPLICATION_DOCUMENTS, optionalDocuments: { organization: ['school_recognition_certificate'], business: ['business_permit'] },
    optionalFields: ['facultyAdviserContact'], filePurpose: 'client_verification_document',
    businessPermitRequired: Boolean(store.approvalCases?.find((row) => row.userId === user.id && row.kind === 'business_client')?.businessPermitRequired),
  } };
  if (path === '/me/organization/email-code' && req.method === 'POST') {
    const body = await requestOrganizationCode({ store, user, body: await input(), at, mailer, secret: emailSecret });
    return { status: 200, body, mutated: true };
  }
  if (path === '/me/organization/email-code/verify' && req.method === 'POST') {
    return verifyOrganizationCode({ store, user, body: await input(), at, secret: emailSecret });
  }
  if (path === '/me/organization' && req.method === 'GET') return { status: 200, body: { organization: organizationProjection(store, user.id) } };
  if (path === '/ops/organizations' && req.method === 'GET') {
    const after = url.searchParams.get('after') || '';
    const ids = [...new Set([...(store.organizationAccounts || []).map((row) => row.userId),
      ...(store.users || []).filter((row) => row.accountType === 'organization').map((row) => row.id)])];
    const accounts = ids.filter((id) => id > after).sort().slice(0, 51).map((userId) => ({ userId }));
    return { status: 200, body: { organizations: accounts.slice(0, 50).map((row) => organizationProjection(store, row.userId)),
      nextCursor: accounts.length > 50 ? accounts[49].userId : null } };
  }
  if (permit && req.method === 'POST') {
    const approvalCase = store.approvalCases.find((row) => row.id === permit[1] && row.kind === 'business_client');
    if (!approvalCase) fail(404, 'approval_case_not_found');
    const body = await input();
    if (approvalCase.status !== 'pending' || approvalCase.version !== body.expectedVersion) fail(409, 'approval_state_conflict');
    if (currentApplication(store, approvalCase).accountType === 'organization') fail(409, 'business_application_required');
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000) fail(400, 'reason_required');
    approvalCase.businessPermitRequired = true;
    approvalCase.version++;
    approvalCase.updatedAt = at;
    store.auditLog.push({ id: createId('aud'), at, actorId: user.id, actorRole: user.role, action: 'client_application.request_business_permit',
      entityType: 'approval_case', entityId: approvalCase.id, reason: body.reason.trim() });
    event(store, { account: { userId: approvalCase.userId }, type: 'client_application_document_requested', title: 'Business permit requested',
      body: body.reason.trim(), at, createId, actorId: user.id, actorRole: user.role, eventKey: `business-permit:${approvalCase.id}:${approvalCase.version}` });
    queueInvalidate(store, { resource: 'approvals', id: approvalCase.id });
    return { status: 200, body: { businessPermitRequired: true, version: approvalCase.version }, mutated: true };
  }
  const accountId = mine ? user.id : path.split('/')[3];
  const account = organizationAccount(store, accountId);
  if (!account) fail(404, 'organization_not_found');
  if (ops && req.method === 'GET' && path === `/ops/organizations/${accountId}`) {
    return { status: 200, body: { organization: organizationProjection(store, accountId, { includeHistory: true }) } };
  }
  if (path === '/me/organization/officer/handover' && req.method === 'POST') {
    if (!account.currentOfficer) fail(409, 'verified_officer_required');
    const body = await input();
    const approvalCase = store.approvalCases.find((row) => row.userId === user.id && row.kind === 'business_client');
    const previous = currentApplication(store, approvalCase);
    const result = applyForBusiness({ store, user, body: { businessName: account.name, businessNature: previous.businessNature,
      accountType: 'organization', school: account.school, organizationEmail: user.email,
      officer: body.officer, documents: body.documents, expectedVersion: body.expectedVersion },
      idempotencyKey: requireIdempotencyKey(req.headers['idempotency-key']), createId, now, handover: true });
    return { status: result.status, body: { organization: organizationProjection(store, user.id) }, mutated: result.status === 201 };
  }
  if (path === '/me/organization/officer/confirm' && req.method === 'POST') {
    const body = await input();
    if (!account.currentOfficer || account.currentOfficer.id !== body.officerId) fail(409, 'officer_changed');
    const approvalCase = store.approvalCases.find((row) => row.userId === user.id && row.kind === 'business_client');
    if (approvalCase?.status === 'pending') fail(409, 'officer_handover_pending');
    if (approvalCase?.status === 'suspended') fail(409, 'organization_suspended');
    if (!account.confirmationRequestedAt) return { status: 200, body: { organization: organizationProjection(store, user.id) } };
    event(store, { account, type: 'organization_officer_confirmed', title: 'Organization officer confirmed',
      body: 'The current officer has been confirmed.', at, createId, actorId: user.id, actorRole: user.role,
      eventKey: `officer-confirmed:${account.userId}:${account.confirmationRequestedAt}` });
    account.confirmedAt = at;
    account.nextConfirmationAt = nextQuarter(at);
    account.confirmationRequestedAt = null;
    account.updatedAt = at;
    return { status: 200, body: { organization: organizationProjection(store, user.id) }, mutated: true };
  }
  if (ops && req.method === 'POST' && path.endsWith('/notice')) {
    const body = await input();
    if (!account.currentOfficer && !(store.users || []).some((row) => row.id === accountId && row.accountType === 'organization')) fail(409, 'verified_officer_required');
    const key = requireIdempotencyKey(req.headers['idempotency-key']);
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 160
      || typeof body.body !== 'string' || !body.body.trim() || body.body.length > 2000) fail(400, 'invalid_notice');
    const eventKey = `organization-notice:${user.id}:${accountId}:${key}`;
    const previous = store.notifications.find((row) => row.userId === accountId && row.domainEventKey === eventKey);
    if (previous) {
      if (previous.title !== body.title.trim() || previous.body !== body.body.trim()) fail(409, 'idempotency_conflict');
      return { status: 200, body: { notificationId: previous.id } };
    }
    event(store, { account, type: 'organization_notice', title: body.title.trim(), body: body.body.trim(), at,
      createId, actorId: user.id, actorRole: user.role, eventKey, detail: { officerId: account.currentOfficer?.id || null } });
    return { status: 201, body: { notificationId: store.notifications.find((row) => row.userId === accountId && row.domainEventKey === eventKey).id }, mutated: true };
  }
  fail(404, 'not_found');
}
