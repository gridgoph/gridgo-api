import { textDocumentPdf } from './text-document-pdf.js';
import { createHash } from 'node:crypto';
import { artworkFileIdsFor } from './artwork-attachments.js';
import { supplierArtworkReleased } from './artwork-gates.js';
import { notifyAdmins } from './domain-events.js';
import { queueOrderInvalidate } from './notifications.js';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, structuredClone(value[key])]));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const approvalSnapshotSha256 = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const hash = approvalSnapshotSha256;

// The taxonomy is a clean signal for custom merchandise. Legacy request orders
// are quoted jobs; their final quote always requires handwriting.
export function approvalPolicy(settings, { categories = [], quoted = false } = {}) {
  return { version: 1, required: settings?.approvalProofRequired === true,
    method: quoted || categories.includes('corporate_event_merch') ? 'drawn' : 'one_tap' };
}

export function canReadApprovalProof(store, order, user) {
  if (!user || !order) return false;
  if (['ops_admin', 'super_admin'].includes(user.role)) return true;
  if (user.role === 'client') return order.clientId === user.id;
  if (!store || user.role !== 'supplier' || order.supplierId !== user.id || !supplierArtworkReleased(order)) return false;
  // Never expose another shop's lines on a historical multi-shop order.
  return !(store.orderJobs || []).some(job => job.orderId === order.id && job.supplierId !== user.id);
}

export function approvalReviewSnapshot(store, order) {
  const lines = (store.orderLineItems || []).filter(line => line.orderId === order.id)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
  const fileIds = new Set(order.artworkFileIds || []);
  const items = lines.map(line => {
    for (const fileId of artworkFileIdsFor(line)) fileIds.add(fileId);
    if (line.mockupFileId) fileIds.add(line.mockupFileId);
    if (line.coverSpine?.coverFileId) fileIds.add(line.coverSpine.coverFileId);
    const item = pick(line, ['id', 'sourceCatalogItemId', 'itemNameSnapshot', 'descriptionSnapshot', 'quantity', 'quantityMode',
      'measurement', 'documentPages', 'structuredSpecSnapshot', 'artworkFileId', 'artworkAttachments', 'artworkLinks',
      'mockupFileId', 'printLayout', 'colorTargets', 'coverSpine', 'specialInstructions', 'artworkGuidance']);
    item.options = (store.orderLineItemOptions || []).filter(option => option.orderLineItemId === line.id)
      .map(option => pick(option, ['groupNameSnapshot', 'optionLabelSnapshot', 'groupKindSnapshot']));
    // Only the agreed tiers, never shop sheet prices or supplier principal.
    if (line.colourPricing) item.colourPricing = {
      ...pick(line.colourPricing, ['version', 'quantity', 'quantityMode', 'totalSheets', 'paperSize', 'tierSet', 'warning']),
      pages: (line.colourPricing.pages || []).map(page => pick(page, ['page', 'pageNumber', 'tier', 'coverageBps', 'strongColourBps', 'sourcePage', 'fileId'])),
    };
    return item;
  });
  for (const fileId of order.proofFileIds || []) fileIds.add(fileId);
  const artwork = [...fileIds].sort().map(fileId => {
    const file = (store.files || []).find(row => row.fileId === fileId);
    return { fileId, ...pick(file, ['contentSha256', 'originalFilename', 'detectedContentType', 'size']) };
  });
  // Legacy quoted order specs are already saved on the order. No live product,
  // profile, settings or catalogue data is consulted when reading a proof.
  const quote = order.pendingQuote || order.acceptedQuote;
  const quoteLines = (quote?.orderLines || []).map(line => pick(line, ['productId', 'label', 'quantity', 'size', 'material', 'finish', 'structuredSpecification', 'specialInstructions']));
  const specification = pick(order, ['productId', 'title', 'quantity', 'size', 'material', 'finish', 'specialInstructions',
    'structuredSpecification', 'optionSnapshots', 'artworkLinks', 'printLayout', 'colorTargets', 'coverSpine', 'artworkGuidance']);
  return { orderId: order.id, basketId: order.basketId ?? null, quoteVersion: quote?.version ?? order.quoteVersion ?? null,
    sampleRoundAt: (order.timeline || []).filter(event => event.state === 'proof_approval').at(-1)?.at ?? null,
    quoteLines, items, specification, artwork };
}

function evidenceFile(store, user, fileId, purpose) {
  const file = (store.files || []).find(row => row.fileId === fileId);
  if (!file || file.ownerId !== user.id || file.purpose !== purpose || !file.objectKey || !Number.isSafeInteger(file.size) || file.size <= 0) fail(400, 'invalid_approval_file');
  if (file.state !== 'ready' || file.deleteRequestedAt || file.deletedAt) fail(409, 'file_not_ready');
  return file;
}

/** Called under the caller's domain transaction, after final line snapshots. */
export function recordApprovalProof({ store, order, user, approval, phase = 'checkout', at, id, req, cartVersion }) {
  const policy = order.approvalPolicy || { required: false, method: 'drawn' };
  const method = phase === 'sample' ? 'drawn' : policy.method;
  if (!approval && policy.required) fail(409, 'approval_proof_required');
  if (approval && (approval.accepted !== true || !['drawn', 'one_tap'].includes(approval.method)
    || (method === 'drawn' && approval.method !== 'drawn'))) fail(400, 'invalid_approval');
  if (approval && cartVersion !== undefined && approval.expectedCartVersion !== cartVersion) fail(409, 'approval_cart_stale');
  if (approval && (!approval.device || ['id', 'platform', 'appVersion'].some(key =>
    typeof approval.device[key] !== 'string' || !approval.device[key].trim() || approval.device[key].length > 160))) fail(400, 'approval_device_required');
  const files = [];
  if (approval?.method === 'drawn') files.push(evidenceFile(store, user, approval.signatureFileId, 'approval_signature'));
  if (approval && phase === 'sample') files.push(evidenceFile(store, user, approval.samplePhotoFileId, 'approval_sample_photo'));
  const snapshot = approvalReviewSnapshot(store, order);
  if (approval && cartVersion === undefined && approval.expectedSnapshotSha256 !== hash(snapshot)) fail(409, 'approval_snapshot_stale');
  const proof = { id: id('apr'), version: 1, phase, status: approval ? 'approved' : 'legacy_unrecorded',
    method: approval?.method ?? null, at, account: pick(user, ['id', 'name', 'email', 'accountType']),
    device: approval ? pick(approval.device, ['id', 'platform', 'appVersion']) : null,
    userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 512),
    signatureFileId: approval?.method === 'drawn' ? approval.signatureFileId : null,
    samplePhotoFileId: phase === 'sample' ? approval?.samplePhotoFileId ?? null : null,
    statement: approval ? 'I approve this order' : null,
    sampleRoundAt: phase === 'sample' ? (order.timeline || []).filter(event => event.state === 'proof_approval').at(-1)?.at ?? null : null,
    evidence: files.map(file => pick(file, ['fileId', 'purpose', 'contentSha256', 'detectedContentType', 'size'])), snapshot, snapshotSha256: hash(snapshot) };
  for (const file of files) {
    file.references ||= [];
    file.references.push({ type: 'order', id: order.id, field: `approval:${proof.id}` });
  }
  (order.approvalProofs ||= []).push(proof);
  store.auditLog ||= [];
  store.auditLog.push({ id: id('aud'), at, actorId: user.id, actorRole: user.role, action: 'order.approval_recorded',
    entityType: 'order', entityId: order.id, orderId: order.id,
    detail: { proofId: proof.id, phase, status: proof.status, snapshotSha256: proof.snapshotSha256 } });
  notifyAdmins(store, 'order_approval_recorded', 'Order approval recorded', order, proof.id, { createId: id, at });
  queueOrderInvalidate(store, order, ['orders', 'jobs']);
  return proof;
}

export function assertApprovalBeforeProceeding(order) {
  if (order.approvalPolicy?.required && !(order.approvalProofs || []).some(proof => proof.phase === 'checkout'
    && proof.status === 'approved' && (order.approvalPolicy.method !== 'drawn' || proof.method === 'drawn')
    && proof.snapshot.quoteVersion === (order.quoteVersion ?? null))) fail(409, 'approval_proof_required');
}

export function approveSample(context) {
  const { store, order, approval } = context;
  const latest = (order.approvalProofs || []).filter(proof => proof.phase === 'sample').at(-1);
  if (!approval && latest?.status === 'approved' && latest.sampleRoundAt === ((order.timeline || []).filter(event => event.state === 'proof_approval').at(-1)?.at ?? null)
    && latest.snapshotSha256 === hash(approvalReviewSnapshot(store, order))) return latest;
  return recordApprovalProof({ ...context, phase: 'sample' });
}

export function approvalProofSummary(order) {
  return { requirement: structuredClone(order.approvalPolicy ?? null),
    records: (order.approvalProofs || []).map(proof => pick(proof, ['id', 'phase', 'status', 'method', 'at', 'snapshotSha256'])),
    readUrl: `/orders/${order.id}/approval-proof`, downloadUrl: `/orders/${order.id}/approval-proof/download` };
}

function approvalProofFor(proof, order, user) {
  if (['ops_admin', 'super_admin'].includes(user.role) || (user.role === 'client' && user.id === order.clientId)) {
    return structuredClone(proof);
  }
  // Explicit fields keep client identity/device evidence private as the stored
  // record evolves. Never mutate the immutable proof to build a shop read.
  return pick(proof, ['id', 'version', 'phase', 'status', 'method', 'at', 'statement', 'signatureFileId',
    'samplePhotoFileId', 'sampleRoundAt', 'evidence', 'snapshot', 'snapshotSha256']);
}

function proofDocumentLines(proofs) {
  const label = key => key.replace(/([a-z\d])([A-Z])/g, '$1 $2').replaceAll('_', ' ')
    .replace(/^./, char => char.toUpperCase());
  const lines = ['GRIDGO APPROVAL PROOF', 'The agreed print specification and the client approval record.', ''];
  const append = (key, value, depth = 0) => {
    const prefix = '  '.repeat(Math.min(depth, 5));
    if (value && typeof value === 'object') {
      if (!Object.keys(value).length) { lines.push(`${prefix}${label(key)}: None`); return; }
      lines.push(`${prefix}${label(key)}:`);
      Object.entries(value).forEach(([child, item]) => append(Array.isArray(value) ? `Entry ${Number(child) + 1}` : child, item, depth + 1));
    } else {
      const text = value == null ? 'Not provided' : String(value);
      lines.push(`${prefix}${label(key)}: ${text}`);
    }
  };
  for (const [index, proof] of proofs.entries()) {
    lines.push(`RECORD ${index + 1} - ${proof.phase === 'sample' ? 'SAMPLE APPROVAL' : 'CHECKOUT APPROVAL'}`);
    if (proof.status === 'legacy_unrecorded') lines.push('NO APPROVAL COLLECTED - compatibility snapshot only.');
    append('approval status', proof.status === 'approved' ? 'Approved by the client' : 'Not recorded');
    append('approval method', proof.method === 'drawn' ? 'Drawn signature' : proof.method === 'one_tap' ? 'One-tap approval' : null);
    append('record reference', proof.id); append('recorded at (UTC)', proof.at);
    if (proof.account !== undefined) append('account', proof.account);
    if (proof.device !== undefined) append('device and app', proof.device);
    append('statement accepted', proof.statement); append('signature file reference', proof.signatureFileId);
    append('received sample photo reference', proof.samplePhotoFileId);
    append('evidence', proof.evidence); append('agreed specification', proof.snapshot);
    append('specification fingerprint (SHA-256)', proof.snapshotSha256);
    append('sample round', proof.sampleRoundAt);
    if (proof.userAgent !== undefined) append('app user agent', proof.userAgent);
    lines.push('');
  }
  lines.push('Evidence files are private. View them through the order in GRIDGO.',
    'File availability follows the published retention policy.');
  // Standard PDF fonts lack full Unicode coverage. Escaping code units preserves
  // exact spelling without silently replacing names or instructions with '?'.
  return lines.flatMap(line => {
    let rest = line.replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const wrapped = [];
    while (rest.length > 100) {
      const space = rest.lastIndexOf(' ', 100);
      const end = space > 10 ? space : 100;
      wrapped.push(rest.slice(0, end)); rest = `  ${rest.slice(end).trimStart()}`;
    }
    return [...wrapped, rest];
  });
}

/** Dependency-free PDF of the frozen record; file bytes remain private. */
export function approvalProofPdf(proofs) {
  return textDocumentPdf(proofDocumentLines(proofs), 'GRIDGO Approval Proof');
}

export async function routeApprovalProof({ req, url, store, user, readBody, now, id }) {
  const match = url.pathname.match(/^\/orders\/([^/]+)\/approval-proof(\/download)?$/);
  if (!match) return null;
  if (!user) fail(401, 'unauthorized');
  const order = store.orders.find(row => row.id === match[1]);
  if (!order) fail(404, 'order_not_found');
  if (!canReadApprovalProof(store, order, user)) fail(403, 'forbidden');
  if (req.method === 'POST' && !match[2]) {
    if (user.role !== 'client' || order.clientId !== user.id) fail(403, 'forbidden');
    if (order.state !== 'proof_approval') fail(409, 'sample_approval_not_allowed');
    const body = await readBody(req);
    // Explicit approval is required even while rollout enforcement is off.
    if (!body.approval) fail(400, 'invalid_approval');
    approveSample({ store, order, user, approval: body.approval, at: now(), id, req });
    return { status: 200, mutated: true, body: { approvalProofs: order.approvalProofs } };
  }
  if (req.method !== 'GET') return { status: 404, body: { error: 'not_found' } };
  if (match[2] && !order.approvalProofs?.length) fail(404, 'approval_proof_not_found');
  const approvalProofs = (order.approvalProofs || []).map(proof => approvalProofFor(proof, order, user));
  if (match[2]) return { status: 200, pdf: approvalProofPdf(approvalProofs) };
  const reviewSnapshot = approvalReviewSnapshot(store, order);
  return { status: 200, body: { approvalProofs, requirement: order.approvalPolicy ?? null,
    review: { snapshot: reviewSnapshot, snapshotSha256: hash(reviewSnapshot) } } };
}
