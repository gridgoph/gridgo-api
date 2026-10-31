import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadHotReadStore, saveStore, isHotReadPath } from '../src/postgres-store.js';
import { instrument } from './fixtures/order-reads.js';
import { parityApiForTest, setupReadParity } from './fixtures/read-parity.js';
import { AT } from './fixtures/reschedule.js';
const skip = !process.env.DATABASE_URL;
async function setup(database) {
  const store = await setupReadParity(database);
  const base = store.files.find(row => row.fileId === 'art_a_active');
  for (const purpose of ['tracker_decision','support_chat_image','delivery_chat_image','pickup_chat_image','client_shop_chat_attachment',
    'approval_signature','approval_sample_photo','client_verification_document','refund_qr','refund_receipt','refund_evidence',
    'payment_proof','verification_document','supplier_payout_qr','rider_verification_document','payout_receipt','handoff_signature','mockup']) {
    const references = ['refund_qr','refund_receipt','refund_evidence'].includes(purpose)
      ? [{ type: 'refund_request', id: store.refundRequests[0].id }]
      : purpose === 'support_chat_image' ? [{type:'support_chat_message',id:'message',partyUserId:'client',partyRole:'client'}]
      : ['delivery_chat_image','pickup_chat_image','client_shop_chat_attachment'].includes(purpose)
        ? [{type: purpose === 'client_shop_chat_attachment' ? 'client_shop_chat_message' : purpose.replace('_image','_message'), id:'message', orderId:'a_active',riderId:'rider',supplierId:'supplier'}]
        : [{type:'order',id:'a_active',field:purpose}];
    store.files.push({...structuredClone(base),fileId:`file_${purpose}`,objectKey:`private/file_${purpose}`,purpose,ownerId:'client',references:references.map(ref => ({field:purpose,...ref}))});
  }
  store.files.push({...structuredClone(base),fileId:'not_ready',objectKey:'private/not_ready',state:'pending_upload',references:[]});
  store.files.push({...structuredClone(base),fileId:'unattached',objectKey:'private/unattached',references:[]});
  // An owner must not regain supplier artwork held behind fileCheck.
  store.files.find(row => row.fileId === 'art_unreleased').ownerId = 'supplier';
  store.files.find(row => row.fileId === 'photo_supplier').references = [{type:'supplier_catalog_item',id:'item_supplier',field:'photos'}];
  store.files.push({...structuredClone(base),fileId:'service_file',objectKey:'private/service_file',purpose:'catalog_item_photo',ownerId:'other',references:[{type:'supplier_service',id:'service_supplier',field:'sample'}]});
  store.files.push({...structuredClone(base),fileId:'shop_file',objectKey:'private/shop_file',purpose:'supplier_shop_image',ownerId:'other',references:[{type:'supplier_shop_media',id:'supplier',field:'cover'}]});
  await database.transaction(() => saveStore(database,store));
  return store;
}

test('file metadata and signed downloads preserve every role and purpose policy byte for byte', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  const store = await setup(database);
  const at = Date.now() + 120000;
  const storageHandler = (req,res) => {res.writeHead(200,{'Content-Length':'100','Content-Type':'image/png',ETag:'test'});res.end(req.method==='HEAD'?undefined:Buffer.alloc(100,65));};
  const baseline = await parityApiForTest(t,true,at,{storageHandler});
  const targeted = await parityApiForTest(t,false,at,{storageHandler});
  const ids = ['missing','not_ready','unattached','shop_file','service_file','photo_supplier','art_a_active','art_unreleased','art_multi','art_legacy','art_review',
    'production_photo_a_active','packing_photo_a_active','supplier_invoice_a_active',...store.files.filter(row => row.fileId.startsWith('file_')).map(row => row.fileId)];
  for (const who of [null,'client','other','supplier','replacement','rider','ops','admin','staff','test_ops','review_client','review_supplier','dual','suspended']) {
    for (const fileId of ids) for (const suffix of ['', '/download-url']) {
      const path = `/files/${fileId}${suffix}`;
      const old = await baseline(who,'GET',path,null,{raw:true});
      const current = await targeted(who,'GET',path,null,{raw:true});
      assert.equal(current.status,old.status,`${who} ${path}`);
      assert.deepEqual(JSON.parse(current.body),JSON.parse(old.body),`${who} ${path}`);
      assert.equal(current.body,old.body,`${who} ${path}: bytes`);
    }
    for (const fileId of ['file_payment_proof','file_payout_receipt','file_refund_receipt','art_a_active']) {
      const path = `/files/${fileId}/content`;
      const old = await baseline(who,'GET',path,null,{raw:true});
      const current = await targeted(who,'GET',path,null,{raw:true});
      assert.equal(current.status,old.status,`${who} ${path}`);
      assert.equal(current.body,old.body,`${who} ${path}: content bytes`);
    }
  }
  for (const api of [baseline, targeted]) {
    assert.equal((await api('client','GET','/files/file_delivery_package_photo')).status,200);
    assert.equal((await api('client','GET','/files/file_delivery_package_photo/download-url')).status,200);
    assert.equal((await api('other','GET','/files/file_delivery_package_photo')).status,403);
    assert.equal((await api('supplier','GET','/files/file_delivery_package_photo')).status,403);
  }
  assert.equal((await targeted('client','GET','/files/art_a_active/download-url')).status,200);
  assert.equal((await targeted('supplier','GET','/files/art_unreleased')).status,403);
});

test('file graphs only hydrate requested file references and keep a fixed query budget', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setup(database);
  assert.ok(isHotReadPath('/files/art_a_active'));
  assert.equal(isHotReadPath('/files/art_a_active/preview-url'),false);
  const sample = async () => {
    const {db,queries} = instrument(database);
    const store = await loadHotReadStore(db,'clerk_supplier','/files/art_a_active');
    assert.equal(store.files.length,1);
    assert.equal(store.orders.length,1);
    assert.ok(queries.length <= 18,`queries=${queries.length}`);
    assert.ok(!queries.some(q => /FROM (audit_log|notifications|location_pings|notification_push_outbox|order_payments)\b/.test(q.sql)));
    await assert.rejects(database.transaction(() => saveStore(database,store)),/read-only/);
    return queries;
  };
  for (const suffix of ['', '/download-url','/content']) {
    const path = `/files/art_a_active${suffix}`;
    const { db, queries } = instrument(database);
    await loadHotReadStore(db,'clerk_client',path);
    assert.ok(isHotReadPath(path),path);
    assert.ok(queries.length <= 16,`${path}: ${queries.length} queries`);
  }
  const catalogueFile = instrument(database);
  await loadHotReadStore(catalogueFile.db,'clerk_client','/files/shop_file');
  assert.ok(catalogueFile.queries.length <= 50);
  const before = await sample();
  t.diagnostic('/files/art_a_active: ' + before.length + ' queries, ' + before.reduce((sum, q) => sum + q.rows, 0) + ' rows');
  await database.query(`INSERT INTO files(file_id,owner_id,purpose,state,object_key,original_filename,declared_content_type,size_bytes,created_at,position)
    SELECT 'growth_'||i,'other','artwork','pending_upload','private/growth_'||i,'growth.pdf','application/pdf',100,$1,1000+i FROM generate_series(1,1000) i`,[AT]);
  assert.deepEqual(await sample(),before);
});
