import test from 'node:test';
import assert from 'node:assert/strict';
import { signProductionPhotos } from '../src/production-progress.js';
import { signArtworkAttachments } from '../src/artwork-attachments.js';
import { mapConcurrent } from '../src/concurrent-map.js';

function signer(files, concurrency) {
  const calls = new Map();
  let active = 0, peak = 0;
  return {
    peak: () => peak,
    calls,
    options: {
      concurrency,
      findFile: id => files.find(file => file.fileId === id),
      authorizeRead: file => { if (file.private) throw new Error('forbidden'); },
      presignGet: async key => {
        calls.set(key, (calls.get(key) || 0) + 1);
        active++; peak = Math.max(peak, active);
        try {
          await new Promise(resolve => setTimeout(resolve, key.endsWith('0') ? 20 : 5));
          if (key === 'retry' && calls.get(key) === 1) throw new Error('storage unavailable');
          return { url: `https://storage.invalid/${key}`, expiresAt: '2099-01-01T00:00:00.000Z' };
        } finally { active--; }
      },
    },
  };
}

test('list photo signing overlaps within its bound and preserves gallery order, authorization, failures and expiry', async () => {
  const files = Array.from({ length: 10 }, (_,i) => ({ fileId: `photo${i}`, objectKey: i === 4 ? 'retry' : `photo${i}`, private: i === 3 }));
  const original = { productionProgress: { status: 'photos_available', photos: files.map(file => ({ fileId: file.fileId, at: '2026-10-01T00:00:00Z' })) } };
  const serial = structuredClone(original), parallel = structuredClone(original);
  const baseline = signer(files,1), concurrent = signer(files,3);
  await signProductionPhotos(serial,baseline.options);
  await signProductionPhotos(parallel,concurrent.options);
  assert.deepEqual(parallel,serial);
  assert.equal(JSON.stringify(parallel),JSON.stringify(serial));
  assert.equal(baseline.peak(),1);
  assert.ok(concurrent.peak()>1,'independent photo presigns must overlap');
  assert.ok(concurrent.peak()<=3);
  assert.equal(parallel.productionProgress.photos.some(photo => photo.fileId === 'photo3'),false);
  assert.equal(parallel.productionProgress.photos.find(photo => photo.fileId === 'photo4').downloadUrl,undefined,'storage failure retains the unsigned evidence');
  assert.equal(concurrent.calls.has('photo3'),false);
  const packed = { packingProgress: structuredClone(original.productionProgress) };
  await signProductionPhotos(packed,signer(files,3).options,'packingProgress');
  assert.deepEqual(packed.packingProgress,parallel.productionProgress);
});

test('bounded projection workers preserve order and do no work for an empty list', async () => {
  let calls = 0;
  assert.deepEqual(await mapConcurrent([],4,async () => { calls++; }),[]);
  assert.equal(calls,0);
  assert.deepEqual(await mapConcurrent([3,2,1],2,async value => {
    await new Promise(resolve => setTimeout(resolve,value));
    return value * 2;
  }),[6,4,2]);
  await assert.rejects(mapConcurrent([1],0,async value => value),RangeError);
});

test('list artwork signing overlaps while preserving duplicate success reuse, failed-attempt retries and private purposes', async () => {
  const files = ['art0','art1','art2','art3','retry','private','wrong_purpose','deleted'].map(fileId => ({
    fileId, objectKey: fileId, purpose: fileId === 'wrong_purpose' ? 'production_photo' : 'artwork',
    state: 'ready', ...(fileId === 'private' ? { private: true } : {}), ...(fileId === 'deleted' ? { deletedAt: '2026-10-01' } : {}),
  }));
  const attachment = fileId => ({ kind: 'file', fileId });
  const original = { productionItems: [
    { artworkAttachments: ['art0','art1','art0','retry','private','wrong_purpose','deleted'].map(attachment) },
    { artworkAttachments: ['retry','art2'].map(attachment) },
  ], legacy: { artworkAttachments: [attachment('art3'),{kind:'link',url:'https://example.invalid/design'}] } };
  const serial = structuredClone(original), parallel = structuredClone(original);
  const baseline = signer(files,1), concurrent = signer(files,3);
  await signArtworkAttachments(serial,baseline.options);
  await signArtworkAttachments(parallel,concurrent.options);
  assert.deepEqual(parallel,serial);
  assert.equal(JSON.stringify(parallel),JSON.stringify(serial));
  assert.equal(baseline.peak(),1);
  assert.ok(concurrent.peak()>1,'independent artwork presigns must overlap');
  assert.ok(concurrent.peak()<=3);
  assert.equal(concurrent.calls.get('art0'),1,'successful signing is reused within this body');
  assert.equal(concurrent.calls.get('retry'),2,'a later duplicate can retry after failure');
  assert.equal(parallel.productionItems[0].artworkAttachments[3].downloadUrl,undefined);
  assert.equal(parallel.productionItems[1].artworkAttachments[0].downloadUrl,'https://storage.invalid/retry');
  for (const key of ['private','wrong_purpose','deleted']) assert.equal(concurrent.calls.has(key),false);
});
