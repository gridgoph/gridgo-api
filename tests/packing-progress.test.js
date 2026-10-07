import test from 'node:test';
import assert from 'node:assert/strict';
import { packingPhotoFiles, packingProgressFor } from '../src/packing-progress.js';
import { publicOrderFor } from '../src/operational-model.js';
import { signProductionPhotos } from '../src/production-progress.js';
const order = { id: 'order', supplierId: 'shop', clientId: 'client', riderId: 'rider', state: 'production' };
const file = { fileId: 'packed', ownerId: 'shop', state: 'ready', purpose: 'packing_photo', detectedContentType: 'image/jpeg', objectKey: 'private/key', references: [{ type: 'order', id: 'order' }] };

test('packing accepts only a ready image attached by this shop to this order', () => {
  assert.equal(packingPhotoFiles({files:[file]}, order).length, 1);
  for (const change of [{purpose:'production_photo'}, {purpose:'fulfilment_proof'}, {ownerId:'other'}, {state:'pending_upload'}, {state:'deleted'}, {state:'delete_pending'}, {detectedContentType:'application/pdf'}, {objectKey:null}, {references:[]}, {references:[{type:'order',id:'other'}]}]) {
    assert.equal(packingPhotoFiles({files:[{...file,...change}]}, order).length, 0);
  }
});
test('packing projection and signed URLs exclude riders and unrelated clients', async () => {
  const store = {files:[file]};
  for (const actor of [{id:'shop',role:'supplier'}, {id:'client',role:'client'}, {id:'ops',role:'ops_admin'}]) {
    const projected = publicOrderFor({...order, packingPhotoFileIds:['packed']},actor,store);
    assert.deepEqual(projected.packingProgress,packingProgressFor(store,order));
    assert.equal(projected.packingPhotoFileIds,undefined);
    await signProductionPhotos(projected,{findFile:()=>file,authorizeRead:()=>{},presignGet:async()=>({url:'signed',expiresAt:'later'})},'packingProgress');
    assert.equal(projected.packingProgress.photos[0].downloadUrl,'signed');
  }
  for (const actor of [{id:'rider',role:'rider'},{id:'other',role:'client'}]) {
    assert.equal(publicOrderFor({...order,packingPhotoFileIds:['packed']},actor,store).packingProgress,undefined);
  }
});
