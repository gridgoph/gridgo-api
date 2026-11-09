import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import {
  loadColourSourceStore,
  loadColourSaveStore,
  loadStore,
  saveStore,
  loadClientSaveStore,
} from '../src/postgres-store.js';
import { createColourWorker } from '../src/colour-worker.js';
import { routeOrderMatch } from '../src/order-match-routes.js';
import { Readable } from 'node:stream';
import { colourFixture } from './helpers/colour-fixture.mjs';
import { resetDatabase } from './fixtures/reset-database.js';
import {
  saveRows,
  SAVE_AT,
  setupSaveParity,
  saveParityApi,
} from './fixtures/save-parity.js';
import fs from 'node:fs/promises';
import { instrument } from './fixtures/order-reads.js';
const skip = !process.env.DATABASE_URL,
  at = new Date(SAVE_AT).toISOString();
async function fixture(db, missing) {
  await resetDatabase(
    db,
    'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE'
  );
  const value = colourFixture({ missing }),
    { store, line } = value;
  let sequence = 0;
  const id = (prefix) => `${prefix}_worker_${++sequence}`;
  const call = (pathname, body) =>
    routeOrderMatch({
      req: { method: 'POST', headers: {} },
      url: new URL(pathname, 'http://test'),
      store,
      user: store.users.find((row) => row.id === 'client'),
      readBody: async () => body,
      id,
      now: () => at,
    });
  const cart = await call('/me/carts', {
    fulfillmentMode: 'delivery',
    defaultDropoff: { lat: 7.07, lng: 125.61, label: 'Home' },
  });
  await call(`/me/carts/${cart.body.cart.id}/lines`, line);
  await db.transaction(() => saveStore(db, store));
  await db.transaction(async () => saveStore(db, await loadStore(db)));
  return value;
}
test(
  'targeted colour worker keeps file results, fee locks and staff notices byte-identical to full graphs',
  { skip },
  async (t) => {
    const db = createDatabase(process.env);
    t.after(() => db.close());
    for (const missing of [false, true]) {
      const results = [];
      for (const scoped of [false, true]) {
        const { bytes } = await fixture(db, missing);
        let sequence = 0;
        const { db: traced, queries } = instrument(db);
        const worker = createColourWorker({
          database: traced,
          load: () => loadStore(traced),
          ...(scoped
            ? {
                loadSource: (fileId) => loadColourSourceStore(traced, fileId),
                loadForSave: (file) => loadColourSaveStore(traced, file),
              }
            : {}),
          save: (store) => saveStore(traced, store),
          storage: {
            statObject: async () => ({ size: bytes.length }),
            getObject: async () => Readable.from(bytes),
          },
          render: async () => [
            {
              page: 1,
              strongColourBps: missing ? 2500 : 0,
              tier: missing ? 'up_to_25' : 'none',
              widthPixels: 600,
              heightPixels: 900,
            },
          ],
          now: () => at,
          id: (prefix) => `${prefix}_result_${++sequence}`,
        });
        await worker();
        results.push(await saveRows(db));
        if (scoped)
          assert.ok(
            !queries.some((query) =>
              /FROM (audit_log|location_pings|notification_push_outbox)\b/.test(
                query.sql
              )
            )
          );
      }
      assert.deepEqual(results[1], results[0], `missing price: ${missing}`);
      assert.equal(
        results[1].files.find((row) => row.file_id === 'colour_art').data
          .colourAnalyses[0].status,
        'ready'
      );
      if (missing)
        assert.ok(
          results[1].notifications.some(
            (row) => row.user_id === 'ops' && row.type === 'colour_price_check'
          )
        );
    }
  }
);
test(
  'upload and background colour completion use no full graph for an eligible client',
  { skip },
  async (t) => {
    const db = createDatabase(process.env);
    t.after(() => db.close());
    await setupSaveParity(db);
    const cleanup = [];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
    });
    let output = '';
    const bytes = await fs.readFile(
      new URL('./fixtures/artwork-check/pixel.jpg', import.meta.url)
    );
    const api = await saveParityApi(
      { after: (fn) => cleanup.push(fn) },
      false,
      {
        traceLoads: true,
        onOutput: (chunk) => {
          output += chunk;
        },
        storageHandler: (req, res) => {
          if (req.method === 'PUT') {
            req.resume();
            req.on('end', () => {
              res.writeHead(200, { ETag: '"fixture"' });
              res.end();
            });
          } else if (req.method === 'HEAD') {
            res.writeHead(200, {
              'Content-Length': bytes.length,
              ETag: '"fixture"',
            });
            res.end();
          } else {
            res.writeHead(404);
            res.end();
          }
        },
      }
    );
    output = '';
    const form = new FormData();
    form.append('purpose', 'artwork');
    form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'phone.jpg');
    const response = await api('client', 'POST', '/files', form);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    let result;
    for (let n = 0; n < 200; n++) {
      result = (
        await db.query('SELECT data FROM files WHERE file_id=$1', [
          response.body.file.fileId,
        ])
      ).rows[0].data;
      if (result.colourAnalyses?.[0]?.status !== 'pending') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(result.colourAnalyses[0].status, 'failed'); // the mock deliberately has no GET bytes
    assert.ok(!output.includes('benchmark_full_store_load'), output);
  }
);

test(
  'foreign draft originals and sparse file layouts retain the full colour writer',
  { skip },
  async (t) => {
    const db = createDatabase(process.env);
    t.after(() => db.close());
    await setupSaveParity(db);
    await db.transaction(async () => {
      const store = await loadStore(db),
        cart = store.carts.find((row) => row.id === 'save_cart'),
        line = store.cartLines.find((row) => row.id === 'save_line');
      store.carts.push({
        ...structuredClone(cart),
        id: 'foreign_colour_cart',
        clientId: 'other',
      });
      store.cartLines.push({
        ...structuredClone(line),
        id: 'foreign_colour_line',
        cartId: 'foreign_colour_cart',
        artworkFileId: 'art_a_active',
        artworkLinks: [],
        artworkAttachments: [{ kind: 'file', fileId: 'art_a_active' }],
      });
      await saveStore(db, store);
    });
    await db.transaction(async () => saveStore(db, await loadStore(db)));
    await db.transaction(async () => {
      const { db: traced, queries } = instrument(db),
        file = (await loadColourSourceStore(traced, 'art_a_active')).files.find(
          (row) => row.fileId === 'art_a_active'
        );
      await loadColourSaveStore(traced, file);
      assert.ok(queries.some((query) => /FROM audit_log\b/.test(query.sql)));
      assert.ok(
        !queries.some((query) =>
          query.sql.includes('SELECT dirty FROM store_production_normalization')
        ),
        'foreign references fall back before entering the partial writer'
      );
    });
    await db.query(
      "UPDATE files SET position=position+100 WHERE file_id='art_a_active'"
    );
    const { db: traced, queries } = instrument(db);
    await loadColourSourceStore(traced, 'art_a_active');
    assert.ok(queries.some((query) => /FROM audit_log\b/.test(query.sql)));
  }
);
