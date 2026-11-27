import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { defaultTaxonomy } from '../src/taxonomy.js';
const skip=!process.env.DATABASE_URL;

test('review tags persist with atomic audit, score validation, safe display and client-only shop summaries', {skip}, async t => {
  const db=createDatabase();t.after(()=>db.close());
  await resetDatabase(db,'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store=fixture();store.taxonomy=defaultTaxonomy();store.orders[0].state='completed';
  store.users.find(row=>row.id==='client').name='Mira Hart';
  const template=structuredClone(store.orders[0]);
  for(let i=0;i<4;i++) {
    store.orders.push({...structuredClone(template),id:`previous${i}`});
    store.shopReviews.push({id:`r${i}`,orderId:`previous${i}`,supplierId:'supplier',clientId:'client',qualityStars:5,speedStars:4,valueStars:3,
      tags:['Clear print'],comment:'Tags: Clear print',createdAt:AT});
  }
  const reviews=store.shopReviews;store.shopReviews=[];
  await db.transaction(()=>saveStore(db,store));
  store.shopReviews=reviews;
  await db.transaction(()=>saveStore(db,store));
  const api=await apiForTest(t);
  const path='/shops/supplier/ratings';
  assert.equal((await api(null,'GET',path)).status,401);
  assert.equal((await api('supplier','GET',path)).status,403);
  assert.equal((await api('client','GET','/shops/missing/ratings')).status,404);
  assert.deepEqual((await api('client','GET',path)).body,{summary:null});
  const scores={qualityStars:5,speedStars:4,valueStars:3};
  for(const tags of [['Rude'],['Unknown'],'Clear print',null]) {
    const bad=await api('client','POST','/orders/order/review',{...scores,tags});
    assert.equal(bad.status,400,JSON.stringify(bad.body));assert.equal(bad.body.error,'invalid_rating_tags');
  }
  assert.equal((await db.query('SELECT count(*)::int n FROM shop_reviews')).rows[0].n,4);
  const comment='Clear print; call 09123456789. 42 Cedar Street.';
  const added=await api('client','POST','/orders/order/review',{...scores,tags:['Clear print','Accepted fast','Clear print'],comment});
  assert.equal(added.status,201,JSON.stringify(added.body));assert.deepEqual(added.body.review.tags,['Clear print','Accepted fast']);
  assert.equal(added.body.review.comment,null);
  const loaded=await loadStore(db),saved=loaded.shopReviews.find(row=>row.orderId==='order');
  assert.equal(saved.comment,comment);assert.deepEqual(saved.tags,['Clear print','Accepted fast']);
  assert.ok(loaded.auditLog.some(row=>row.action==='order.rated'&&row.orderId==='order'));
  assert.equal((await api('client','POST','/orders/order/review',scores)).body.error,'already_rated');
  const read=await api('client','GET',path);
  assert.equal(read.status,200,JSON.stringify(read.body));assert.equal(read.body.summary.count,5);
  assert.equal(read.body.summary.average,5);assert.equal(read.body.summary.latestReview.reviewer,'Mira H.');
  assert.equal(read.body.summary.latestReview.comment,null);
  assert.deepEqual(read.body.summary.topTags,[{tag:'Clear print',count:5},{tag:'Accepted fast',count:1}]);
  const own=await api('supplier','GET','/me/reviews');
  assert.equal(own.body.reviews.find(row=>row.orderId==='order').comment,null);
  assert.ok(!JSON.stringify(read.body).includes('Cedar'));assert.ok(!JSON.stringify(read.body).includes('clientId'));
  // A home printer uses the same endpoint and never exposes the private point.
  loaded.supplierProfiles.find(row=>row.userId==='supplier').homePrinter={startedAt:AT,starterApprovedAt:AT,online:true,pinConsent:{accepted:true},privacyAgreement:{accepted:true},street:'Secret Orchard',barangay:'Oakfield',pickupPoint:{description:'Red kiosk'}};
  for(const item of loaded.catalogItems) Object.assign(item,{subcategoryCode:'document_printing',pricingUnit:'per_page',express:true});
  for(const service of loaded.supplierServices) service.categoryCode='document_publication';
  saved.comment='Lovely at Secret Orchard';
  await db.transaction(()=>saveStore(db,loaded));
  const home=await api('client','GET',path);
  assert.equal(home.status,200,JSON.stringify(home.body));assert.equal(home.body.summary.count,5);
  assert.equal(home.body.summary.latestReview.comment,null);
  for(const term of ['Secret Orchard','Red kiosk','pickupPoint','lat','lng']) assert.ok(!JSON.stringify(home.body).includes(`"${term}"`));
});

test('forward tag migration copies only unambiguous tags and preserves every original rating fact', {skip}, async t=>{
  const {up}=await import('../migrations/1795792400000_structured_review_tags.js');
  const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
  const schema=`rating_migration_${process.pid}`;
  t.after(async()=>{await client.query('ROLLBACK');await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await client.end();});
  await client.query(`CREATE SCHEMA ${schema};SET search_path TO ${schema};
    CREATE TABLE shop_reviews(id text PRIMARY KEY,quality_stars smallint,speed_stars smallint,value_stars smallint,comment text,created_at timestamptz);`);
  for(const [id,quality,comment] of [['clean',5,'Nice work.\nTags: Accepted fast, Clear print'],['mixed',5,'Tags: Friendly, Mystery'],['negative',2,'Tags: Faded print · Wrong settings'],['wrong_group',1,'Tags: Friendly'],['plain',3,'Nice work.'],['trailing',5,'Tags: Clear print,'],['prefix',5,'Tags: Friendly\nMore words'],['multiple',5,'Tags: Friendly\nTags: Clear print'],['crlf',5,'Before\r\nTags: Clear print\r\nAfter']]) {
    await client.query('INSERT INTO shop_reviews VALUES($1,$2,3,4,$3,$4)',[id,quality,comment,AT]);
  }
  const before=(await client.query('SELECT * FROM shop_reviews ORDER BY id')).rows;
  const statements=[];await up({sql:s=>statements.push(s)});
  await client.query('BEGIN');for(const sql of statements)await client.query(sql);await client.query('COMMIT');
  const after=(await client.query('SELECT * FROM shop_reviews ORDER BY id')).rows;
  assert.deepEqual(after.map(({tags,...row})=>row),before);
  assert.deepEqual(Object.fromEntries(after.map(row=>[row.id,row.tags])),{clean:['Accepted fast','Clear print'],mixed:[],negative:['Faded print','Wrong settings'],wrong_group:[],plain:[],trailing:[],prefix:['Friendly'],multiple:[],crlf:['Clear print']});
  await assert.rejects(client.query("UPDATE shop_reviews SET tags=ARRAY['Rude'] WHERE id='clean'"),/shop_reviews_tags/);
  await assert.rejects(client.query("UPDATE shop_reviews SET tags=ARRAY['Friendly','Friendly'] WHERE id='clean'"),/shop_reviews_tags/);
});
