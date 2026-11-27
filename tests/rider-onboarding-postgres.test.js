import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { up } from '../migrations/1795793000000_rider_document_review.js';

test('rider migration expands slots and exempts only existing approved riders', {skip:!process.env.DATABASE_URL}, async()=>{
  const client=new pg.Client({connectionString:process.env.DATABASE_URL}); await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA rider_migration_test;
      SET LOCAL search_path TO rider_migration_test;
      CREATE TABLE rider_documents (id text, kind text CONSTRAINT rider_documents_kind_check CHECK(kind IN ('drivers_license','or_cr','selfie')));
      CREATE TABLE approval_cases (id text, kind text, status text);
      INSERT INTO approval_cases VALUES ('old-approved','rider','approved'),('pending','rider','pending'),('suspended','rider','suspended'),('shop','supplier','approved');`);
    await up({sql:sql=>client.query(sql)});
    const rows=(await client.query('SELECT id,rider_review FROM approval_cases ORDER BY id')).rows;
    assert.deepEqual(rows.find(r=>r.id==='old-approved').rider_review,{legacyApproved:true});
    assert.ok(rows.filter(r=>r.id!=='old-approved').every(r=>JSON.stringify(r.rider_review)==='{}'));
    for(const kind of ['drivers_license_back','motorcycle_photo','resume']) await client.query('INSERT INTO rider_documents (id,kind) VALUES ($1,$1)',[kind]);
    await client.query("UPDATE rider_documents SET description='Blue motorcycle, side view', reupload_reason='Please retake the photo' WHERE kind='motorcycle_photo'");
    assert.equal((await client.query("SELECT description FROM rider_documents WHERE kind='motorcycle_photo'")).rows[0].description,'Blue motorcycle, side view');
  } finally {await client.query('ROLLBACK');await client.end();}
});
