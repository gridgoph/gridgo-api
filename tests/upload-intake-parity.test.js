import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDatabase } from '../src/database.js';
import {
  loadStore,
  saveStore,
  loadUploadIntakeStore,
  loadClientSaveStore,
} from '../src/postgres-store.js';
import {
  setupSaveParity,
  saveParityApi,
  saveRows,
} from './fixtures/save-parity.js';
import { instrument } from './fixtures/order-reads.js';
const skip = !process.env.DATABASE_URL,
  baseline = 'd2c7e393f1add38f8a83066faa9d4a9f010e2dcc';
const bytes = await fs.readFile(
  new URL('./fixtures/artwork-check/pixel.jpg', import.meta.url)
);
const form = (save = false, purpose = 'artwork') => {
  const f = new FormData();
  f.append('purpose', purpose);
  f.append('saveToMyFiles', String(save));
  f.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'phone.jpg');
  return f;
};
export const uploadStorage = (req, res) => {
  if (req.method === 'PUT') {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { ETag: '"fixture"' });
      res.end();
    });
  } else if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Length': bytes.length, ETag: '"fixture"' });
    res.end();
  } else if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
  } else {
    res.writeHead(404);
    res.end();
  }
};
test(
  'client intake retains baseline HTTP and money/audit/inbox rows except membership-scoped purpose hints',
  { skip },
  async (t) => {
    const db = createDatabase(process.env);
    t.after(() => db.close());
    for (const input of [
      { who: 'client' },
      { who: 'client', save: true },
      { who: 'client', save: true, quota: 1 },
      { who: 'client', save: true, failSql: 'INSERT INTO audit_log' },
      { who: 'client', purpose: 'payment_proof' },
      { who: 'supplier', purpose: 'production_photo' },
      { who: 'client', purpose: 'invalid' },
    ]) {
      const answers = [];
      for (const old of [true, false]) {
        await setupSaveParity(db);
        if (input.quota)
          await db.transaction(async () => {
            const s = await loadStore(db);
            s.settings.savedFilesLimitBytes = input.quota;
            await saveStore(db, s);
          });
        const cleanup = [];
        t.after(async () => {
          for (const close of cleanup.splice(0).reverse()) await close();
        });
        const api = await saveParityApi(
          { after: (fn) => cleanup.push(fn) },
          false,
          {
            sourceRef: old ? baseline : null,
            storageHandler: uploadStorage,
            disableColour: true,
            failSql: input.failSql || null,
          }
        );
        const result = await api(
          input.who,
          'POST',
          '/files',
          form(input.save, input.purpose)
        );
        answers.push({
          status: result.status,
          body: result.body,
          rows: await saveRows(db),
        });
        for (const close of cleanup.splice(0).reverse()) await close();
      }
      if (input.purpose === 'invalid') {
        const clientPurposes = [
          'approval_signature', 'approval_sample_photo', 'artwork', 'mockup', 'payment_proof',
          'refund_qr', 'refund_evidence', 'client_verification_document', 'client_shop_chat_attachment',
          'support_chat_image', 'delivery_chat_image',
        ];
        assert.deepEqual(answers[1].body.allowedPurposes, clientPurposes);
        // The historical API advertised other roles' upload purposes. Only this
        // intentional hint change is exempt from full response and row parity.
        assert.ok(answers[0].body.allowedPurposes.includes('payment_qr'));
        answers[0].body.allowedPurposes = clientPurposes;
      }
      assert.deepEqual(answers[1], answers[0], JSON.stringify(input));
      assert.equal(
        answers[1].status,
        input.failSql
          ? 500
          : input.quota
            ? 409
            : input.purpose === 'invalid'
              ? 400
              : 201,
        JSON.stringify(answers[1].body)
      );
    }
  }
);
test(
  'upload intake and client save graphs avoid unrelated inbox, audit, ping and outbox history',
  { skip },
  async (t) => {
    const db = createDatabase(process.env);
    t.after(() => db.close());
    await setupSaveParity(db);
    const { db: probe, queries } = instrument(db);
    const intake = await loadUploadIntakeStore(probe, 'clerk_client');
    assert.equal(intake.users.find((r) => r.id === 'client').id, 'client');
    assert.ok(queries.length < 15);
    assert.ok(
      !queries.some((q) =>
        /FROM (orders|notifications|audit_log|location_pings|notification_push_outbox)\b/.test(
          q.sql
        )
      )
    );
    await db.transaction(async () => {
      const store = await loadClientSaveStore(
        probe,
        'clerk_client',
        '/files',
        {}
      );
      assert.ok(store);
      assert.ok(
        !queries.some((q) =>
          /FROM (audit_log|location_pings|notification_push_outbox)\b/.test(
            q.sql
          )
        )
      );
    });
  }
);
