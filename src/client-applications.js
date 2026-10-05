// Application snapshots contain private personal details and opaque file IDs.
// Expose the full snapshot only through the staff approval-case projection.
export const CLIENT_APPLICATION_FIELDS = ['businessName', 'businessNature', 'accountType', 'businessType',
  'school', 'organizationEmail', 'officer', 'signatory', 'documents', 'facultyAdviserContact'];
const BASE_BUSINESS = ['government_id', 'payout_bank_proof', 'bir_2303'];
export const APPLICATION_DOCUMENTS = Object.freeze({
  organization: ['government_id', 'student_id', 'enrollment_document'],
  sole_proprietor: [...BASE_BUSINESS, 'dti_certificate'],
  partnership: [...BASE_BUSINESS, 'sec_certificate', 'articles_and_bylaws', 'general_information_sheet', 'signatory_authorization'],
  corporation: [...BASE_BUSINESS, 'sec_certificate', 'articles_and_bylaws', 'general_information_sheet', 'signatory_authorization'],
});
export function applicationError(status, code, details = {}) {
  throw Object.assign(new Error(code), { status, code, details });
}
const text = (value) => typeof value === 'string' ? value.trim() : '';
export const organizationKey = (value) => text(value).normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase();
export function currentApplication(store, approvalCase) {
  return (store.approvalCaseEvents || []).filter((event) => event.approvalCaseId === approvalCase?.id
    && event.actorKind === 'applicant' && event.snapshot?.accountType)
    .sort((a, b) => a.applicationRevision - b.applicationRevision || a.createdAt.localeCompare(b.createdAt)).at(-1)?.snapshot || {};
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validateClientApplication(store, user, body, at, { approvalCase, approval = false } = {}) {
  const fields = {};
  const accountType = body.accountType ?? 'business';
  const track = accountType === 'organization' ? 'organization' : body.businessType;
  if (!['organization', 'business'].includes(accountType)) fields.accountType = 'choose organization or business';
  const checklist = typeof track === 'string' && Object.hasOwn(APPLICATION_DOCUMENTS, track) ? APPLICATION_DOCUMENTS[track] : null;
  if (!checklist) fields.businessType = 'choose sole_proprietor, partnership or corporation';
  for (const field of ['businessName', 'businessNature']) {
    if (!text(body[field]) || text(body[field]).length > 200) fields[field] = 'required; maximum 200 characters';
  }
  const personField = accountType === 'organization' ? 'officer' : 'signatory';
  const person = body[personField] || {};
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(at));
  for (const key of ['fullName', 'address', 'phone']) {
    if (!text(person[key]) || text(person[key]).length > 500) fields[`${personField}.${key}`] = 'required; maximum 500 characters';
  }
  if (!validDate(person.dateOfBirth) || person.dateOfBirth >= today) fields[`${personField}.dateOfBirth`] = 'use a past YYYY-MM-DD date';
  if (!['philid', 'ephilid', 'passport', 'drivers_license', 'umid'].includes(person.governmentIdType)) fields[`${personField}.governmentIdType`] = 'choose a primary government ID';
  const noExpiry = ['philid', 'ephilid', 'umid'].includes(person.governmentIdType) && person.governmentIdHasNoExpiry === true;
  if (!noExpiry && (!validDate(person.governmentIdExpiresOn) || person.governmentIdExpiresOn < today)) fields[`${personField}.governmentIdExpiresOn`] = 'an unexpired ID is required';
  if (person.originalId !== true || person.detailsMatchId !== true) fields[personField] = 'confirm original ID and matching personal details';
  const cleanPerson = Object.fromEntries(['fullName', 'address', 'phone'].map((key) => [key, text(person[key])]));
  Object.assign(cleanPerson, { dateOfBirth: person.dateOfBirth, governmentIdType: person.governmentIdType,
    governmentIdExpiresOn: noExpiry ? null : person.governmentIdExpiresOn, governmentIdHasNoExpiry: noExpiry,
    originalId: true, detailsMatchId: true });
  const application = { schemaVersion: 1, businessName: text(body.businessName), businessNature: text(body.businessNature),
    accountType, [personField]: cleanPerson, documents: {} };
  if (accountType === 'organization') {
    if (!text(body.school) || text(body.school).length > 200) fields.school = 'required; maximum 200 characters';
    if (!validDate(person.studentIdExpiresOn) || person.studentIdExpiresOn < today) fields['officer.studentIdExpiresOn'] = 'an unexpired student ID is required';
    cleanPerson.studentIdExpiresOn = person.studentIdExpiresOn;
    application.school = text(body.school);
    application.organizationEmail = text(body.organizationEmail).toLowerCase();
    if (!application.organizationEmail || application.organizationEmail !== String(user.email || '').toLowerCase()) fields.organizationEmail = 'use the shared organization login email';
    if (body.facultyAdviserContact != null) {
      if (!text(body.facultyAdviserContact) || text(body.facultyAdviserContact).length > 500) fields.facultyAdviserContact = 'maximum 500 characters';
      application.facultyAdviserContact = text(body.facultyAdviserContact);
    }
  } else application.businessType = track;
  const required = [...(checklist || [])];
  if (approvalCase?.businessPermitRequired && accountType === 'business') required.push('business_permit');
  const allowed = new Set([...required, ...(accountType === 'organization' ? ['school_recognition_certificate'] : ['business_permit'])]);
  const documents = body.documents && typeof body.documents === 'object' && !Array.isArray(body.documents) ? body.documents : {};
  for (const key of new Set([...required, ...Object.keys(documents)])) {
    const fileId = documents[key];
    const file = (store.files || []).find((row) => row.fileId === fileId);
    if (!allowed.has(key) || !file || file.ownerId !== user.id || file.purpose !== 'client_verification_document' || file.state !== 'ready') {
      fields[`documents.${key}`] = 'upload your own ready client_verification_document';
    } else application.documents[key] = fileId;
  }
  if (new Set(Object.values(documents)).size !== Object.keys(documents).length) fields.documents = 'use a separate file for each checklist item';
  if (Object.keys(fields).length) applicationError(400, 'invalid_application', { fields });
  if (accountType === 'organization') {
    const duplicate = (store.organizationAccounts || []).some((row) => row.userId !== user.id
      && row.nameKey === organizationKey(application.businessName) && row.schoolKey === organizationKey(application.school));
    if (duplicate) applicationError(409, 'organization_already_exists');
    // Re-check file validity at approval, but an already consumed email challenge
    // is evidence on this immutable applicant revision, not a reusable token.
    if (!approval) {
      const challenge = (store.organizationEmailChallenges || []).find((row) => row.userId === user.id);
      if (!challenge?.verifiedAt || challenge.consumedAt || challenge.email !== application.organizationEmail
        || Date.parse(challenge.expiresAt) <= Date.parse(at)) applicationError(409, 'organization_email_verification_required');
      application.emailVerifiedAt = challenge.verifiedAt;
    } else if (!body.emailVerifiedAt) applicationError(409, 'organization_email_verification_required');
  }
  return application;
}
export function bindClientApplication(store, user, approvalCase, application, at) {
  for (const [key, fileId] of Object.entries(application.documents)) {
    const file = store.files.find((row) => row.fileId === fileId);
    delete file.clientApplicationRejectedAt;
    file.references ||= [];
    const field = `client_application:${approvalCase.id}:${approvalCase.applicationRevision}:${key}`;
    if (!file.references.some((ref) => ref.type === 'user' && ref.id === user.id && ref.field === field)) file.references.push({ type: 'user', id: user.id, field });
  }
  if (application.accountType !== 'organization') {
    store.organizationAccounts = (store.organizationAccounts || []).filter((row) => row.userId !== user.id || row.currentOfficer);
    return;
  }
  store.organizationAccounts ||= [];
  let account = store.organizationAccounts.find((row) => row.userId === user.id);
  if (!account) {
    account = { userId: user.id, history: [], currentOfficer: null, createdAt: at };
    store.organizationAccounts.push(account);
  }
  Object.assign(account, { nameKey: organizationKey(application.businessName), schoolKey: organizationKey(application.school),
    name: application.businessName, school: application.school, email: application.organizationEmail, updatedAt: at });
  const challenge = store.organizationEmailChallenges.find((row) => row.userId === user.id);
  challenge.consumedAt = at;
}
export function decideClientApplication(store, approvalCase, action, at, createId) {
  if (approvalCase.kind !== 'business_client') return;
  const application = currentApplication(store, approvalCase);
  // Pre-rollout cases must submit the checklist before their first approval.
  if (action === 'approve') {
    if (application.schemaVersion !== 1) applicationError(409, 'application_checklist_required');
    const user = store.users.find((row) => row.id === approvalCase.userId);
    validateClientApplication(store, user, application, at, { approvalCase, approval: true });
    for (const fileId of Object.values(application.documents)) {
      const file = store.files.find((row) => row.fileId === fileId);
      file.clientApplicationApprovedAt = at;
      delete file.clientApplicationRejectedAt;
    }
    if (application.accountType === 'organization') {
      const account = store.organizationAccounts.find((row) => row.userId === user.id);
      if (!account) applicationError(409, 'application_checklist_required');
      if (account.currentOfficer) account.history.find((row) => row.id === account.currentOfficer.id).endedAt = at;
      const officer = { id: createId('officer'), fullName: application.officer.fullName, startedAt: at,
        verifiedAt: at, endedAt: null, approvalCaseId: approvalCase.id, applicationRevision: approvalCase.applicationRevision };
      account.history.push(officer);
      account.currentOfficer = structuredClone(officer);
      account.confirmedAt = at;
      account.nextConfirmationAt = nextQuarter(at);
      account.confirmationRequestedAt = null;
      account.updatedAt = at;
    }
  }
  if (action === 'reject' && application.schemaVersion === 1) {
    // Mark this revision's rejected evidence independently of later reapplications.
    for (const fileId of Object.values(application.documents)) {
      const file = store.files.find((row) => row.fileId === fileId);
      if (file) file.clientApplicationRejectedAt = at;
    }
    const account = (store.organizationAccounts || []).find((row) => row.userId === approvalCase.userId);
    if (account && !account.currentOfficer) store.organizationAccounts = store.organizationAccounts.filter((row) => row !== account);
  }
}
export function nextQuarter(at) {
  const date = new Date(at);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 3);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString();
}
export function officerSnapshot(store, userId) {
  const current = (store.organizationAccounts || []).find((row) => row.userId === userId)?.currentOfficer;
  return current ? { id: current.id, fullName: current.fullName, verifiedAt: current.verifiedAt } : null;
}
