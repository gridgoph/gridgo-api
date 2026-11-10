import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePromotion, promotionStatus } from '../src/home-promotions.js';
import { authorizeFileUpload, authorizeFileRead, validateUpload } from '../src/attachments.js';
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
