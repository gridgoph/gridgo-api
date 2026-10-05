// Complete synthetic checklist for tests that exercise client application callers.
export function businessApplication(store, userId) {
  const documents = Object.fromEntries(['government_id', 'payout_bank_proof', 'bir_2303', 'dti_certificate']
    .map((key) => [key, `application_${userId}_${key}`]));
  store.files ||= [];
  for (const fileId of Object.values(documents)) {
    if (store.files.some((file) => file.fileId === fileId)) continue;
    store.files.push({ fileId, ownerId: userId, purpose: 'client_verification_document', state: 'ready', references: [],
      objectKey: `test/${fileId}.pdf`, originalFilename: 'document.pdf', declaredContentType: 'application/pdf',
      detectedContentType: 'application/pdf', size: 10, createdAt: '2026-01-01T00:00:00.000Z' });
  }
  return { businessType: 'sole_proprietor', documents, signatory: { fullName: 'Test Signatory', dateOfBirth: '2000-01-01',
    address: 'Test address', phone: '+639000000000', governmentIdType: 'philid', governmentIdHasNoExpiry: true,
    originalId: true, detailsMatchId: true } };
}
