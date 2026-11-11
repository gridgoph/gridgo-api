import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePromotion, promotionStatus } from '../src/home-promotions.js';
import { authorizeFileUpload, authorizeFileRead, validateUpload, resolveFileTarget } from '../src/attachments.js';
import { retentionDecision, assertEarlyFileDeletion } from '../src/file-retention-policy.js';

export const promotion = { name: 'DavaoGo', logo: { fileId: 'promo_logo' }, description: 'Our partner app in Davao. Tap to visit.',
  tag: 'partner', linkText: 'Visit DavaoGo', linkUrl: 'https://davaogo.app/', style: 'yellow',
  startsAt: '2026-11-10T00:00:00Z', enabled: true, displayOrder: 1 };

test('promotion validates dates, secure links, bounded text, media refs and enums', () => {
  assert.equal(validatePromotion(promotion).tapAction, 'sheet');
  assert.equal(validatePromotion(promotion).image, null);
  for (const patch of [{ name: '' }, { description: 'x'.repeat(141) }, { linkText: 'x'.repeat(81) }, { tag: 'other' },
    { style: 'red' }, { tapAction: 'other' }, { linkUrl: 'http://davaogo.app' }, { linkUrl: 'javascript:alert(1)' },
    { linkUrl: 'https://user:password@davaogo.app' }, { startsAt: '2026-02-30T00:00:00Z' }, { startsAt: '2026-11-10' },
    { endsAt: '2026-11-09T00:00:00Z' }, { endsAt: promotion.startsAt }, { enabled: 'yes' }, { displayOrder: -1 },
    { displayOrder: 0.5 }, { logo: { fileId: 'promo_logo', objectKey: 'private' } }, { logo: null }, { views: 10 }, { toString: 'unexpected' }, { startsAt: '0000-01-01T00:00:00Z' }]) {
    assert.throws(() => validatePromotion({ ...promotion, ...patch }), error => error.status === 400, JSON.stringify(patch));
  }
  assert.equal(validatePromotion({ tapAction: 'link' }, validatePromotion(promotion)).tapAction, 'link');
});

test('status is start inclusive, end exclusive, with disabled and removed off', () => {
  const row = { enabled: true, starts_at: '2026-11-10T00:00:00Z', ends_at: '2026-11-11T00:00:00Z' };
  assert.equal(promotionStatus(row, '2026-11-09T23:59:59Z'), 'scheduled');
  assert.equal(promotionStatus(row, row.starts_at), 'live');
  assert.equal(promotionStatus(row, row.ends_at), 'ended');
  assert.equal(promotionStatus({ ...row, enabled: false }, row.starts_at), 'off');
  assert.equal(promotionStatus({ ...row, removed_at: row.starts_at }, row.starts_at), 'off');
});

test('promotion media is staff uploaded, client readable and retained while bound', () => {
  const file = { fileId: 'logo', ownerId: 'ops', purpose: 'promotion_logo', state: 'ready', readyAt: '2026-01-01T00:00:00Z',
    references: [{ type: 'home_promotion', id: 'promo', field: 'logo' }] };
  for (const role of ['ops_admin', 'super_admin']) assert.doesNotThrow(() => authorizeFileUpload({ role }, file.purpose));
  for (const role of ['client', 'supplier', 'rider']) assert.throws(() => authorizeFileUpload({ role }, file.purpose), error => error.status === 403);
  for (const role of ['client', 'ops_admin', 'super_admin']) assert.doesNotThrow(() => authorizeFileRead({ role }, {}, file));
  for (const role of ['supplier', 'rider']) assert.throws(() => authorizeFileRead({ role }, {}, file), error => error.status === 403);
  assert.throws(() => validateUpload({ size: 6 * 1024 * 1024 }, 'promotion_logo'), error => error.status === 413);
  assert.equal(retentionDecision({}, file, '2026-11-10T00:00:00Z').eligible, false);
  assert.throws(() => assertEarlyFileDeletion({}, file, { role: 'super_admin' }, 'Remove'), error => error.code === 'file_in_use');
});


test('promotion color is strict hex, uppercase, authoritative, and compatible with legacy style patches', () => {
  const { style, ...colorOnly } = promotion;
  const custom = validatePromotion({ ...colorOnly, color: '#abcdef' });
  assert.equal(custom.color, '#ABCDEF');
  assert.equal(custom.style, 'light');
  assert.equal(validatePromotion(promotion).color, '#FFDE58');
  assert.equal(validatePromotion({ style: 'light' }, custom).color, '#FFFFFF');
  assert.equal(validatePromotion({ style: 'yellow' }, custom).color, '#FFDE58');
  assert.equal(validatePromotion({ name: 'Preserved' }, custom).color, '#ABCDEF');
  assert.equal(validatePromotion({ color: '#ffde58', style: 'light' }, custom).style, 'yellow');
  for (const color of [null, 123456, '', '#fff', 'FFFFFF', '#12345678', '#GGGGGG', ' #123456', '#123456 ', '#123456\n']) {
    assert.throws(() => validatePromotion({ ...promotion, color }), error => error.status === 400 && error.details.field === 'color');
  }
});


test('card image is optional, strictly referenced, preserved by omission and independently clearable', () => {
  assert.equal(validatePromotion(promotion).cardImage, null);
  const current = validatePromotion({ ...promotion, cardImage: { fileId: 'card' }, image: { fileId: 'cover' } });
  assert.deepEqual(validatePromotion({ name: 'Edited' }, current).cardImage, { fileId: 'card' });
  const cleared = validatePromotion({ cardImage: null }, current);
  assert.equal(cleared.cardImage, null);
  assert.deepEqual(cleared.image, { fileId: 'cover' });
  for (const cardImage of ['', [], {}, { fileId: '' }, { fileId: 1 }, { fileId: 'x', downloadUrl: 'url' }]) {
    assert.throws(() => validatePromotion({ ...promotion, cardImage }), e => e.code === 'invalid_promotion' && e.details.field === 'cardImage');
  }
});

test('card image upload policy and bound retention match cover images', () => {
  const purpose = 'promotion_card_image';
  const file = { fileId: 'card', ownerId: 'ops', purpose, state: 'ready', readyAt: '2026-01-01T00:00:00Z',
    references: [{ type: 'home_promotion', id: 'promo', field: 'cardImage' }] };
  for (const role of ['ops_admin', 'super_admin']) assert.doesNotThrow(() => authorizeFileUpload({ role }, purpose));
  for (const role of ['client', 'supplier', 'rider', 'staff']) assert.throws(() => authorizeFileUpload({ role }, purpose), e => e.status === 403);
  for (const role of ['client', 'ops_admin', 'super_admin']) assert.doesNotThrow(() => authorizeFileRead({ role }, {}, file));
  for (const role of ['supplier', 'rider', 'staff']) assert.throws(() => authorizeFileRead({ role }, {}, file), e => e.status === 403);
  assert.throws(() => validateUpload({ size: 15 * 1024 * 1024 + 1 }, purpose), e => e.status === 413);
  for (const [hex, type] of [['89504e470d0a1a0a', 'image/png'], ['ffd8ff', 'image/jpeg'], ['524946460000000057454250', 'image/webp']]) {
    const bytes = Buffer.from(hex, 'hex');
    assert.doesNotThrow(() => validateUpload({ size: 15 * 1024 * 1024, sniffBytes: bytes, declaredContentType: type, originalFilename: `card.${type.split('/')[1]}` }, purpose));
  }
  assert.throws(() => validateUpload({ size: 8, sniffBytes: Buffer.from('%PDF-1.7'), declaredContentType: 'application/pdf', originalFilename: 'card.pdf' }, purpose), e => e.status === 415);
  assert.throws(() => resolveFileTarget({}, purpose, {}), e => e.code === 'promotion_attachment_route_required');
  assert.equal(retentionDecision({}, file, '2026-11-11T00:00:00Z').eligible, false);
  assert.throws(() => assertEarlyFileDeletion({}, file, { role: 'super_admin' }, 'Remove'), e => e.code === 'file_in_use');
  assert.equal(retentionDecision({}, { ...file, references: [] }, '2026-11-11T00:00:00Z').eligible, true);
});
