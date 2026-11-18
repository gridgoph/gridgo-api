import test from 'node:test';
import assert from 'node:assert/strict';
import { listCashEvidence } from '../src/cash-evidence.js';

const AT='2026-10-05T00:00:00.000Z';
const order={id:'order',riderId:'rider',riderAssignedAt:AT};
const file=(fileId,purpose='cash_shop_return',extra={})=>({fileId,purpose,ownerId:'rider',state:'ready',
  createdAt:AT,objectKey:`private/${fileId}`,size:100,references:[],...extra});
const storeFor=files=>({files,users:[{id:'rider',role:'rider'},{id:'ops',role:'ops_admin'}]});
const storage={statObject:async()=>({size:100}),presignGet:async(key,options)=>{
  assert.deepEqual(options,{privateFinancial:true});
  return {url:`https://storage.invalid/${key}?signed=1`,expiresAt:'2026-10-05T00:05:00.000Z'};
}};

test('cash evidence lists order-bound purposes and unused rider candidates, excluding unrelated or unavailable files',async()=>{
  const purposes=['cash_shop_receipt','cash_no_show_photo','cash_return_photo','cash_remedy_receipt',
    'cash_reprint_receipt','cash_remedy_qr','cash_repayment_proof','cash_incident_photo','cash_shop_return'];
  const bound=purposes.map(purpose=>file(`bound-${purpose}`,purpose,{references:[{type:'cash',orderId:'order',id:'order:action'}]}));
  const store=storeFor([...bound,file('candidate-return'),file('candidate-incident','cash_incident_photo'),
    file('old',undefined,{createdAt:'2026-10-04T23:59:59.000Z'}),
    file('other-rider',undefined,{ownerId:'another-rider'}),
    file('other-order',undefined,{references:[{type:'cash',orderId:'other',id:'other:action'}]}),
    file('mixed-orders',undefined,{references:[{type:'cash',orderId:'order'},{type:'order',id:'other'}]}),
    file('topup','cash_topup_proof',{references:[{type:'cash',orderId:'order'}]}),
    file('private-document','rider_verification_document',{references:[{type:'order',id:'order'}]}),
    file('unused-receipt','cash_shop_receipt'),file('staff-candidate','cash_incident_photo',{ownerId:'ops'}),
    file('pending',undefined,{state:'pending_upload'}),file('deleted',undefined,{state:'deleted'}),
    file('other-binding',undefined,{references:[{type:'cash',id:'topup'}]})]);
  const result=await listCashEvidence({store,order,storage});
  assert.deepEqual(result.files.map(f=>f.fileId).sort(),[...bound.map(f=>f.fileId),'candidate-return','candidate-incident'].sort());
  for (const entry of result.files) {
    assert.equal(entry.ownerRole,'rider');assert.equal(entry.uploadedAt,AT);
    assert.equal(entry.used,entry.fileId.startsWith('bound-'));
    assert.match(entry.previewUrl,/signed=1/);assert.equal(entry.expiresAt,'2026-10-05T00:05:00.000Z');
    assert.equal(Object.hasOwn(entry,'objectKey'),false);assert.equal(Object.hasOwn(entry,'references'),false);
  }
  assert.deepEqual((await listCashEvidence({store,order:{...order,id:'another',riderId:'another-rider'},storage})).files.map(f=>f.fileId),['other-rider']);
});

test('cash evidence includes recorded riders after assignment changes, and fails closed without an assignment time',async()=>{
  const store=storeFor([file('return')]);
  for (const cashProgress of [{noShowRiderId:'rider'},{incident:{riderId:'rider'}},{redelivery:{riderId:'rider',assignedAt:AT}}]) {
    assert.equal((await listCashEvidence({store,order:{...order,riderId:null,cashProgress},storage})).files.length,1);
  }
  assert.deepEqual(await listCashEvidence({store,order:{id:'order',riderId:'rider'},storage}),{files:[]});
  assert.deepEqual(await listCashEvidence({store:storeFor([]),order,storage}),{files:[]});
});

test('cash evidence keeps metadata visible with null preview when storage is missing, mismatched or unavailable',async()=>{
  for (const code of ['storage_object_missing','minio_unavailable','storage_object_mismatch']) {
    const broken={...storage,statObject:async()=>{
      if (code==='storage_object_mismatch') return {size:999};
      throw Object.assign(new Error(code),{code});
    },presignGet:async()=>assert.fail('must not sign an unverified object')};
    const {files:[entry]}=await listCashEvidence({store:storeFor([file('return')]),order,storage:broken});
    assert.equal(entry.unavailable,true);assert.equal(entry.error,code);
    assert.equal(entry.previewUrl,null);assert.equal(entry.expiresAt,null);
  }
});
