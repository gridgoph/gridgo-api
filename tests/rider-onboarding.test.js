import test from 'node:test';
import assert from 'node:assert/strict';
import { riderVerification, requestRiderReupload, assertRiderDocumentsComplete, recordRiderConsent, RIDER_CONSENT } from '../src/rider-onboarding.js';
const at='2026-11-27T05:00:00.000Z';
let n=0; const createId=p=>`${p}_${++n}`;
function fixture() {
 const kinds=['drivers_license','drivers_license_back','or_cr','motorcycle_photo','resume'];
 return {users:[{id:'r',role:'rider'}], userRoleMemberships:[{userId:'r',role:'rider'}],
 riderProfiles:[{userId:'r',vehicleType:'motorcycle',plateNumber:'TEST 123',licenseNumber:'TEST-LICENSE'}],
 approvalCases:[{id:'c',userId:'r',kind:'rider',status:'pending',submittedAt:at,version:1,applicationRevision:1}],
 riderDocuments:kinds.map(kind=>({id:kind,riderId:'r',kind,fileId:kind,isCurrent:true,expiresOn:kind==='drivers_license'?'2030-01-01':undefined,...(kind==='motorcycle_photo'?{description:'Blue motorcycle, side view'}:{})})),
 files:kinds.map(kind=>({fileId:kind,ownerId:'r',purpose:'rider_verification_document',state:'ready'})),approvalCaseEvents:[],notifications:[],auditLog:[]};
}
test('all five current ready documents and a motorcycle description are required',()=>{
 const s=fixture(); assertRiderDocumentsComplete(s,'r',at);
 s.riderDocuments.find(d=>d.kind==='drivers_license_back').isCurrent=false;
 assert.throws(()=>assertRiderDocumentsComplete(s,'r',at),e=>e.code==='rider_documents_incomplete'&&e.details.missing.includes('drivers_license_back'));
 s.riderDocuments[1].isCurrent=true; s.riderDocuments[3].description='';
 assert.throws(()=>assertRiderDocumentsComplete(s,'r',at),e=>e.code==='rider_documents_incomplete');
});
test('consent uses fixed wording and server time',()=>{
 const c=fixture().approvalCases[0];
 assert.throws(()=>recordRiderConsent(c,{},at),e=>e.code==='consent_required');
 recordRiderConsent(c,{accepted:true,version:1},at);
 assert.deepEqual(c.riderReview.consent,{acceptedAt:at,version:1,wording:RIDER_CONSENT});
});
test('re-upload is versioned, document-specific, audited and notifies once on replay',()=>{
 const s=fixture(), c=s.approvalCases[0]; recordRiderConsent(c,{accepted:true,version:1},at);
 const args={store:s,approvalCase:c,body:{expectedVersion:1,requestId:'review-one',documents:[{kind:'or_cr',reason:'Plate is unreadable'}]},actor:{id:'ops'},actorRole:'ops_admin',at,createId};
 requestRiderReupload(args);
 assert.equal(c.status,'pending'); assert.equal(c.version,2);
 assert.equal(riderVerification(s,c).status,'needs_reupload');
 assert.equal(s.riderDocuments.find(d=>d.kind==='or_cr').reuploadReason,'Plate is unreadable');
 assert.equal(s.riderDocuments.find(d=>d.kind==='resume').reuploadReason,undefined);
 assert.throws(()=>assertRiderDocumentsComplete(s,'r',at),e=>e.code==='rider_documents_incomplete');
 assert.equal(s.notifications.filter(n=>n.userId==='r').length,1); assert.equal(s.auditLog.length,1);
 requestRiderReupload(args); assert.equal(s.notifications.filter(n=>n.userId==='r').length,1);
 assert.throws(()=>requestRiderReupload({...args,body:{...args.body,documents:[{kind:'resume',reason:'Unreadable'}]}}),e=>e.code==='request_id_conflict');
});
test('existing approval retains work eligibility without new documents',()=>{
 const s=fixture(),c=s.approvalCases[0]; c.status='approved'; s.riderDocuments=[];
 assert.equal(riderVerification(s,c).status,'approved');
});
