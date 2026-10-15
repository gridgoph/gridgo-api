import test from 'node:test';
import assert from 'node:assert/strict';
import { artworkAttachmentsFor, artworkFileIdsFor, artworkPreviewFileId, writeArtworkAttachments, signArtworkAttachments } from '../src/artwork-attachments.js';
import { publicOrderFor } from '../src/operational-model.js';
import { canReadOrderArtwork } from '../src/order-file-access.js';
import { retentionDecision } from '../src/file-retention-policy.js';

const formats = [{ code: 'canva_link', inputKind: 'url' }];
const link = { kind: 'link', formatCode: 'canva_link', url: 'https://www.canva.com/design/ABC/view', label: 'Design' };
const file = { kind: 'file', fileId: 'front', label: 'Front' };

test('ordered attachment updates enforce total limits and keep released payloads usable', () => {
  const line = {};
  writeArtworkAttachments(line, { artworkAttachments: [link, file, { kind: 'file', fileId: 'back' }] }, formats);
  assert.equal(line.artworkFileId, 'front');
  assert.deepEqual(line.artworkLinks, [{ formatCode: link.formatCode, url: link.url, label: link.label }]);
  writeArtworkAttachments(line, { quantity: 2 }, []);
  assert.deepEqual(artworkAttachmentsFor(line), [link, file, { kind: 'file', fileId: 'back' }]);
  writeArtworkAttachments(line, { artworkFileId: null }, formats);
  assert.equal(line.artworkFileId, 'back');
  assert.deepEqual(artworkAttachmentsFor(line), [link, { kind: 'file', fileId: 'back' }]);
  writeArtworkAttachments(line, { artworkLinks: [] }, formats);
  assert.deepEqual(artworkAttachmentsFor(line), [{ kind: 'file', fileId: 'back' }]);
  writeArtworkAttachments(line, { artworkAttachments: Array(10).fill(file) }, formats);
  assert.equal(artworkAttachmentsFor(line).length, 10);
  assert.throws(() => writeArtworkAttachments(line, { artworkLinks: [link] }, formats), { code: 'artwork_attachment_limit_exceeded' });
  for (const artworkAttachments of [null, {}, [null], [{ kind: 'file', fileId: 'a', label: 'x'.repeat(81) }], [{ ...link, fileId: 'a' }]]) {
    assert.throws(() => writeArtworkAttachments({}, { artworkAttachments }, formats), { code: 'invalid_artwork_attachments' });
  }
  assert.throws(() => writeArtworkAttachments({}, { artworkAttachments: [], artworkFileId: 'a' }, formats), { code: 'invalid_artwork_attachments' });
  writeArtworkAttachments(line, { artworkAttachments: [] }, formats);
  assert.deepEqual(artworkAttachmentsFor(line), []);
  assert.deepEqual(artworkFileIdsFor({ artworkFileId: 'old', artworkLinks: [link] }), ['old']);
});

test('preview source is first image/PDF and secondary files keep retention holds', () => {
  const line = { cartId: 'cart', artworkAttachments: [{ kind: 'file', fileId: 'doc' }, link, file, { kind: 'file', fileId: 'back' }] };
  const store = { cartLines: [line], carts: [{ id: 'cart', state: 'draft' }], files: [
    { fileId: 'doc', state: 'ready', detectedContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { fileId: 'front', state: 'ready', detectedContentType: 'application/pdf' },
    { fileId: 'back', state: 'ready', detectedContentType: 'image/png', purpose: 'artwork' },
  ] };
  assert.equal(artworkPreviewFileId(store, line), 'front');
  assert.equal(retentionDecision(store, store.files[2], '2026-10-15T00:00:00Z').reason, 'active_cart');
});

test('secondary attachments are scoped by job and do not bypass the staff handoff', async () => {
  const order = { id: 'order', clientId: 'client', state: 'production', fileCheck: { status: 'passed' } };
  const store = { orders: [order], orderJobs: [{ id: 'job-a', orderId: order.id, supplierId: 'shop-a' }, { id: 'job-b', orderId: order.id, supplierId: 'shop-b' }],
    orderLineItems: [{ id: 'a', orderId: order.id, jobId: 'job-a', artworkFileId: 'front', artworkAttachments: [file, { kind: 'file', fileId: 'back' }, link] },
      { id: 'b', orderId: order.id, jobId: 'job-b', artworkFileId: 'private' }], files: [], orderLineItemOptions: [] };
  const user = { id: 'shop-a', role: 'supplier' };
  for (const fileId of ['front', 'back', 'private']) store.files.push({ fileId, purpose: 'artwork', state: 'ready', objectKey: `secret/${fileId}`,
    references: [{ type: 'order', id: order.id, field: `line:${fileId === 'private' ? 'b' : 'a'}:artwork` }] });
  assert.equal(canReadOrderArtwork(user, store, order, 'back', 'artwork'), true);
  assert.equal(canReadOrderArtwork(user, store, order, 'private', 'artwork'), false);
  const view = publicOrderFor(order, user, store);
  assert.deepEqual(view.artworkFileIds, ['front', 'back']);
  assert.equal(view.productionItems.length, 1);
  await signArtworkAttachments(view, {
    findFile: id => store.files.find(row => row.fileId === id),
    authorizeRead: file => { assert.ok(canReadOrderArtwork(user, store, order, file.fileId, 'artwork')); },
    presignGet: async key => ({ url: `signed:${key}`, expiresAt: 'later' }),
  });
  assert.equal(view.productionItems[0].artworkAttachments[1].downloadUrl, 'signed:secret/back');
  assert.equal(store.orderLineItems[0].artworkAttachments[1].downloadUrl, undefined);
  order.fileCheck.status = 'pending';
  assert.equal(canReadOrderArtwork(user, store, order, 'back', 'artwork'), false);
  assert.deepEqual(publicOrderFor(order, user, store).productionItems, []);
});
