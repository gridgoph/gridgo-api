import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { createDatabase } from '../src/database.js';
import { seedLegalDocuments, validateEnrollmentConsent, recordEnrollmentConsent, recordArtworkConsent, loadLegalPenaltyGate } from '../src/legal.js';
import { publicOrderFor } from '../src/operational-model.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://legal-test.clerk.accounts.dev', party = 'http://localhost:19006';
function jwt(sub) {
  const now = Math.floor(Date.now()/1000);
  const input = [ {alg:'RS256',typ:'JWT'}, {iss:issuer,sub,sid:'legal-session',azp:party,iat:now-5,exp:now+600} ].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${input}.${crypto.sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url')}`;
}
const consent = versionIds => ({accepted:true,versionIds,method:'checkbox',app:'client',device:'test-device'});

test('legal HTTP, immutable evidence, enrollment, artwork and privacy contracts', {skip:!DATABASE_URL}, async t => {
  const database = createDatabase({DATABASE_URL});
  const prefix = `legal_${crypto.randomUUID()}`;
  const people = ['client','supplier','rider','staff','ops_admin','super_admin'].map(role=>({id:`${prefix}_${role}`,role}));
  const user = role => people.find(p=>p.role===role);
  let child;
  try {
    await database.query('TRUNCATE legal_documents,legal_versions,legal_acceptances,privacy_requests CASCADE');
    await database.transaction(()=>seedLegalDocuments(database));
    for (const p of people) {
      await database.query(`INSERT INTO users(id,clerk_user_id,email,name,role,account_type,verification_status,created_at,position,data)
        VALUES($1,$1,$2,'Legal fixture',$3,CASE WHEN $3='client' THEN 'individual' ELSE NULL END,CASE WHEN $3 IN ('supplier','rider') THEN 'approved' ELSE NULL END,now(),0,'{}')`,[p.id,`${p.id}@test.invalid`,p.role === 'staff' ? 'client' : p.role]);
      await database.query('INSERT INTO user_role_memberships(user_id,role,created_at) VALUES($1,$2,now())',[p.id,p.role]);
    }
    const reservation = net.createServer(); reservation.listen(0,'127.0.0.1'); await once(reservation,'listening');
    const port = reservation.address().port; await new Promise(r=>reservation.close(r));
    child = spawn(process.execPath,['src/server.js'],{env:{...process.env,DATABASE_URL,HOST:'127.0.0.1',PORT:String(port),CLERK_SECRET_KEY:'test-only-placeholder',CLERK_ISSUER:issuer,CLERK_AUTHORIZED_PARTIES:party,CLERK_JWT_KEY:publicKey.export({type:'spki',format:'pem'}),GRIDGO_FCM_SERVICE_ACCOUNT_FILE:'',GRIDGO_APNS_KEY_FILE:''},stdio:['ignore','pipe','pipe']});
    let logs=''; child.stdout.on('data',d=>logs+=d); child.stderr.on('data',d=>logs+=d);
    const base=`http://127.0.0.1:${port}`;
    for (let i=0;i<200;i++) {
      if (child.exitCode != null) throw new Error(logs);
      try {if ((await fetch(`${base}/health`)).ok) break;} catch {}
      await new Promise(r=>setTimeout(r,25));
    }
    async function call(path,method='GET',role,body) {
      const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(role?{Authorization:`Bearer ${jwt(user(role).id)}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
      const text=await res.text();
      return {status:res.status,body:res.headers.get('content-type')?.includes('text/csv')?text:JSON.parse(text),headers:res.headers};
    }
    async function publish(id, changes={}) {
      const doc=(await call(`/admin/legal/documents/${id}`,'GET','super_admin')).body.documents[0];
      const edited=await call(`/admin/legal/documents/${id}`,'PATCH','super_admin',{expectedRevision:doc.revision,draft:{...changes}});
      assert.equal(edited.status,200,JSON.stringify(edited.body));
      const published=await call(`/admin/legal/documents/${id}/publish`,'POST','super_admin',{expectedRevision:edited.body.revision});
      assert.equal(published.status,201,JSON.stringify(published.body));
      return published.body.document;
    }
    await t.test('anonymous live library and database-backed role audiences',async()=>{
      const all=await call('/legal/documents'); assert.equal(all.status,200); assert.equal(all.body.documents.length,8);
      assert.ok(all.body.documents.every(d=>d.placeholder));
      assert.equal((await call('/legal/documents?audience=client')).body.documents.some(d=>d.documentId==='supplier-agreement'),false);
      assert.equal((await call('/me/legal/pending')).status,401);
      for (const role of ['client','supplier','rider','staff']) {
        const pending=(await call('/me/legal/pending','GET',role)).body.pending;
        assert.ok(pending.every(d=>d.audience==='all'||d.audience===role));
        if (role!=='client') assert.ok(pending.some(d=>d.documentId===({staff:'hub-staff-terms'}[role]||`${role}-agreement`)));
      }
      assert.equal((await call('/me/legal/accept','POST','client',consent(['supplier-agreement-1']))).status,403);
    });
    await t.test('first real publication is material; editorial updates preserve accepted material obligations',async()=>{
      assert.equal((await call('/admin/legal/documents/terms-of-service','PATCH','ops_admin',{})).status,403);
      const real=await publish('terms-of-service',{text:'Test-only reviewed text',placeholder:false,material:false});
      assert.equal(real.material,true);
      let pending=(await call('/me/legal/pending','GET','client')).body;
      assert.ok(pending.pending.some(d=>d.id===real.id));
      const accepted=await call('/me/legal/accept','POST','client',consent(pending.pending.map(d=>d.id)));
      assert.equal(accepted.status,200); assert.equal(accepted.body.blocking,false);
      const editorial=await publish('terms-of-service',{text:'Test-only editorial text',material:false});
      assert.equal(editorial.material,false);
      pending=(await call('/me/legal/pending','GET','client')).body;
      assert.equal(pending.blocking,false); assert.ok(pending.notices.some(d=>d.id===editorial.id));
      assert.ok((await call('/me/legal/pending','GET','rider')).body.pending.some(d=>d.id===editorial.id),'a skipped material version still blocks');
      const changed=await publish('terms-of-service',{material:true});
      assert.ok((await call('/me/legal/pending','GET','client')).body.pending.some(d=>d.id===changed.id));
      assert.equal((await call('/me/legal/accept','POST','client',consent([editorial.id]))).status,409);
      const first=await call('/me/legal/accept','POST','client',{...consent([changed.id]),method:'blocking_screen'});
      assert.equal(first.body.recorded,1);
      assert.equal((await call('/me/legal/accept','POST','client',consent([changed.id]))).body.recorded,0);
      const history=await call(`/admin/legal/acceptances?userId=${user('client').id}`,'GET','ops_admin');
      const row=history.body.acceptances[0];
      await assert.rejects(database.query('UPDATE legal_acceptances SET app=$2 WHERE id=$1',[row.id,'tampered']),e=>e.code==='23514');
      await assert.rejects(database.query('DELETE FROM legal_acceptances WHERE id=$1',[row.id]),e=>e.code==='23514');
      await assert.rejects(database.query('UPDATE legal_versions SET material=false WHERE id=$1',[changed.id]),e=>e.code==='23514');
      await assert.rejects(database.query('DELETE FROM legal_versions WHERE id=$1',[changed.id]),e=>e.code==='23514');
      assert.equal((await call('/admin/legal/documents/terms-of-service','DELETE','super_admin',{expectedRevision:7})).status,409);
      assert.ok((await database.query("SELECT 1 FROM audit_log WHERE action='legal.edited' AND actor_id=$1",[user('super_admin').id])).rows.length);
      assert.ok((await database.query("SELECT 1 FROM audit_log WHERE action='legal.published' AND actor_id=$1",[user('super_admin').id])).rows.length);
      for (const role of ['ops_admin','super_admin']) assert.ok((await database.query('SELECT 1 FROM notifications WHERE user_id=$1 AND type=$2',[user(role).id,'legal.published'])).rows.length);
    });
    await t.test('enrollment opt-in enforces terms/privacy, guardian, role agreement and optional marketing',async()=>{
      assert.equal(await validateEnrollmentConsent(database,{},'client'),null);
      await assert.rejects(validateEnrollmentConsent(database,{legalConsentVersion:1},'client'),e=>e.status===400);
      const docs=(await call('/legal/documents')).body.documents;
      const terms=docs.find(d=>d.documentId==='terms-of-service').id;
      const body={legalConsentVersion:1,legalConsent:{...consent([terms,'privacy-notice-1']),junior:false}};
      await assert.rejects(validateEnrollmentConsent(database,{...body,legalConsent:{...body.legalConsent,accepted:false}},'client'),e=>e.code==='legal_consent_required');
      await assert.rejects(validateEnrollmentConsent(database,{...body,legalConsent:{...body.legalConsent,junior:true}},'client'),e=>e.code==='legal_consent_required');
      await assert.rejects(validateEnrollmentConsent(database,body,'supplier'),e=>e.code==='legal_consent_required');
      const validated=await validateEnrollmentConsent(database,body,'client');
      await database.transaction(()=>recordEnrollmentConsent(database,user('client'),validated));
      const saved=(await database.query("SELECT * FROM legal_acceptances WHERE user_id=$1 AND purpose='enrollment'",[user('client').id])).rows;
      assert.equal(saved.length,2); assert.ok(saved.every(r=>r.marketing===false&&r.junior===false));
      assert.equal((await call('/auth/clerk/activate','POST','client',{legalConsentVersion:1})).status,400);
      assert.equal((await call('/auth/clerk/activate','POST','client',body)).status,200);
      const junior={...body,legalConsent:{...consent([terms,'privacy-notice-1','rider-agreement-1']),junior:true,guardian:true,marketing:true}};
      await database.transaction(async()=>recordEnrollmentConsent(database,user('rider'),await validateEnrollmentConsent(database,junior,'rider')));
      assert.equal((await database.query("SELECT marketing FROM legal_acceptances WHERE user_id=$1 AND purpose='enrollment' LIMIT 1",[user('rider').id])).rows[0].marketing,true);
    });
    await t.test('per-order artwork rights retain legacy compatibility and reject missing v1 consent',async()=>{
      const order={id:`${prefix}_order`,clientId:user('client').id};
      await database.query("INSERT INTO orders(id,client_id,state,dropoff_lat,dropoff_lng,dropoff_label,created_at,updated_at,position,data) VALUES($1,$2,'draft',7,125,'Delivery',now(),now(),0,'{}')",[order.id,order.clientId]);
      await recordArtworkConsent(database,user('client'),order,{});
      await assert.rejects(recordArtworkConsent(database,user('client'),order,{legalConsentVersion:1}),e=>e.code==='artwork_rights_required');
      const body={legalConsentVersion:1,artworkRights:consent(['acceptable-use-1'])};
      await database.transaction(()=>recordArtworkConsent(database,user('client'),order,body));
      await database.transaction(()=>recordArtworkConsent(database,user('client'),order,body));
      assert.equal((await database.query("SELECT * FROM legal_acceptances WHERE order_id=$1 AND purpose='artwork'",[order.id])).rows.length,1);
      await assert.rejects(recordArtworkConsent(database,user('supplier'),order,body),e=>e.status===403);
    });
    await t.test('penalty gate starts only with real agreement and follows accepted material version',async()=>{
      assert.equal(await loadLegalPenaltyGate(database),null);
      const real=await publish('supplier-agreement',{placeholder:false,text:'Test-only penalty terms',penalties:true});
      assert.deepEqual((await loadLegalPenaltyGate(database)).acceptedSupplierIds,[]);
      assert.equal((await call('/me/legal/accept','POST','supplier',consent([real.id]))).status,200);
      assert.ok((await loadLegalPenaltyGate(database)).acceptedSupplierIds.includes(user('supplier').id));
      await publish('supplier-agreement',{material:false,text:'Test-only editorial penalty terms'});
      assert.ok((await loadLegalPenaltyGate(database)).acceptedSupplierIds.includes(user('supplier').id));
      await publish('supplier-agreement',{material:true});
      assert.deepEqual((await loadLegalPenaltyGate(database)).acceptedSupplierIds,[]);
    });
    await t.test('draft CRUD, future publication, PDF validation and seed idempotence',async()=>{
      const draft={title:'Extra terms',audience:'client',text:'Draft text',pdfFileId:null,placeholder:false,material:false,penalties:false,changeSummary:'Initial',effectiveAt:'2026-01-01T00:00:00.000Z'};
      assert.equal((await call('/admin/legal/documents','POST','ops_admin',{id:'extra-terms',draft})).status,403);
      assert.equal((await call('/admin/legal/documents','POST','super_admin',{id:'extra-terms',draft})).status,201);
      assert.equal((await call('/legal/documents')).body.documents.some(d=>d.documentId==='extra-terms'),false);
      assert.equal((await call('/admin/legal/documents/extra-terms','DELETE','super_admin',{expectedRevision:1})).status,200);
      const future=await publish('cookie-notice',{placeholder:false,effectiveAt:'2099-01-01T00:00:00.000Z'});
      assert.equal((await call(`/legal/versions/${future.id}`)).status,404);
      assert.equal((await call('/legal/documents')).body.documents.find(d=>d.documentId==='cookie-notice').id,'cookie-notice-1');
      assert.equal((await call('/admin/legal/documents/privacy-notice','PATCH','super_admin',{expectedRevision:1,draft:{pdfFileId:'missing-file'}})).status,200);
      assert.equal((await call('/admin/legal/documents/privacy-notice/publish','POST','super_admin',{expectedRevision:2})).status,400);
      assert.equal((await call('/admin/legal/documents/privacy-notice','PATCH','super_admin',{expectedRevision:1,draft:{text:'stale'}})).status,409);
      const before=(await database.query('SELECT count(*)::int AS n FROM legal_versions')).rows[0].n;
      await database.transaction(()=>seedLegalDocuments(database));
      assert.equal((await database.query('SELECT count(*)::int AS n FROM legal_versions')).rows[0].n,before);
      assert.ok((await database.query("SELECT 1 FROM audit_log WHERE action='legal.deleted' AND actor_id=$1",[user('super_admin').id])).rows.length);
    });
    await t.test('privacy ownership, 15-day queue, manual handler/status and CSV access',async()=>{
      assert.equal((await call('/me/privacy-requests','POST',null,{kind:'access',confirmed:true})).status,401);
      assert.equal((await call('/admin/privacy-requests','GET','supplier')).status,403);
      const created=await call('/me/privacy-requests','POST','client',{kind:'access',confirmed:true,details:'My records'});
      assert.equal(created.status,201); const request=created.body.request;
      assert.equal(Date.parse(request.dueAt)-Date.parse(request.requestedAt),15*86400000);
      assert.equal((await call('/me/privacy-requests','GET','rider')).body.requests.length,0);
      assert.equal((await call('/admin/privacy-requests','GET','ops_admin')).body.requests.length,1);
      assert.equal((await call(`/admin/privacy-requests/${request.id}`,'PATCH','ops_admin',{expectedRevision:1,handlerId:user('supplier').id})).status,400);
      const updated=await call(`/admin/privacy-requests/${request.id}`,'PATCH','ops_admin',{expectedRevision:1,status:'completed',handlerId:user('ops_admin').id,resolution:'Manually provided',dueAt:new Date(Date.now()+86400000).toISOString()});
      assert.equal(updated.status,200); assert.equal(updated.body.request.revision,2);
      assert.equal((await call(`/admin/legal/acceptances?userId=${user('client').id}&format=csv`,'GET','client')).status,403);
      const csv=await call(`/admin/legal/acceptances?userId=${user('client').id}&format=csv`,'GET','super_admin');
      assert.equal(csv.status,200); assert.match(csv.headers.get('content-type'),/text\/csv/); assert.match(csv.body,/blocking_screen/); assert.match(csv.body,/artwork/);
      const artifact=await call('/me/legal/accept','POST','client',{...consent(['cookie-notice-1']),device:'=formula,"quoted"\nline'});
      assert.equal(artifact.status,200);
      const escaped=await call(`/admin/legal/acceptances?userId=${user('client').id}&format=csv`,'GET','super_admin');
      assert.ok(escaped.body.includes("'=formula,")); assert.ok(escaped.body.includes('""quoted""'));
    });
  } finally {
    if(child && child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
    await database.query('TRUNCATE legal_acceptances,legal_versions,legal_documents,privacy_requests CASCADE');
    await database.query('DELETE FROM orders WHERE id=$1',[`${prefix}_order`]);
    await database.query('DELETE FROM notifications WHERE user_id=ANY($1::text[])',[people.map(p=>p.id)]);
    await database.query('DELETE FROM audit_log WHERE actor_id=ANY($1::text[])',[people.map(p=>p.id)]);
    await database.query('DELETE FROM user_role_memberships WHERE user_id=ANY($1::text[])',[people.map(p=>p.id)]);
    await database.query('DELETE FROM client_profiles WHERE user_id=ANY($1::text[])',[people.map(p=>p.id)]);
    await database.query('DELETE FROM users WHERE id=ANY($1::text[])',[people.map(p=>p.id)]);
    await database.close();
  }
});

test('supplier has no structured client identity; rider receives delivery contact without billing or legal history',()=>{
  const order={id:'o',clientId:'c',supplierId:'s',riderId:'r',state:'out_for_delivery',timeline:[{state:'delivered',at:'2026-10-01T00:00:00.000Z',by:'ops',note:'Collected at GRIDGO Office by Private client'}],collection:{receivedBy:'Private client'},
    clientName:'Private client',clientPhone:'Private number',clientEmail:'private@example.test',
    clientProfile:{name:'Private client',phone:'Private number'},
    organizationOfficer:{name:'Private officer'},physicalInvoiceRequest:{recipient:'Private invoice'},
    dropoff:{lat:7,lng:125,label:'Delivery location',recipientName:'Receiver',phone:'Delivery number'},
    acceptedQuote:{clientName:'Private client',payments:{initial:{reference:'Private bank'}}},
    legalAcceptances:[{device:'Private device'}],artworkRights:{device:'Private device'}};
  const shop=publicOrderFor(order,{id:'s',role:'supplier'});
  assert.ok(!JSON.stringify(shop).includes('Private')); assert.equal(shop.dropoff.phone,undefined);assert.equal(shop.dropoff.recipientName,undefined);
  const rider=publicOrderFor(order,{id:'r',role:'rider'});
  assert.ok(!JSON.stringify(rider).includes('Private'));assert.equal(rider.dropoff.phone,'Delivery number');assert.equal(rider.dropoff.recipientName,'Receiver');
  assert.equal(rider.acceptedQuote,undefined); assert.equal(publicOrderFor(order,{id:'c',role:'client'}).clientName,'Private client');
});
