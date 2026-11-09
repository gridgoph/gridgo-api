/** Isolated synthetic phone-photo upload benchmark; no external identity/storage. */
import './assert-test-database.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDatabase } from '../src/database.js';
import {
  setupSaveParity,
  saveParityApi,
} from '../tests/fixtures/save-parity.js';
import {
  loadClientSaveStore,
  loadUploadIntakeStore,
} from '../src/postgres-store.js';
import { instrument } from '../tests/fixtures/order-reads.js';
import { AT } from '../tests/fixtures/reschedule.js';
const db = createDatabase(process.env);
const photoPath = process.env.PERF_PHOTO_PATH;
assert.ok(photoPath, 'Set PERF_PHOTO_PATH to a synthetic JPEG file');
const bytes = await fs.readFile(photoPath),
  base = Number(process.env.PERF_BASE_ROWS || 10000),
  samples = Number(process.env.PERF_SAMPLES || 5);
assert.ok(
  base >= 100 &&
    Number.isSafeInteger(base) &&
    samples >= 3 &&
    Number.isSafeInteger(samples)
);
const baseline = 'd2c7e393f1add38f8a83066faa9d4a9f010e2dcc';
const storageHandler = (req, res) => {
  if (req.method === 'PUT') {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { ETag: '"phone-test"' });
      res.end();
    });
  } else if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Length': bytes.length,
      ETag: '"phone-test"',
    });
    res.end();
  } else if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
  } else {
    res.writeHead(404);
    res.end();
  }
};
const form = () => {
  const body = new FormData();
  body.append('purpose', 'artwork');
  body.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'phone.jpg');
  return body;
};
async function grow(from, to) {
  await db.query(
    `INSERT INTO notifications(id,user_id,type,created_at,position,data)
    SELECT 'upload_notice_'||i,'other','history',$3,10000+i,'{}' FROM generate_series($1::int,$2::int)i`,
    [from, to, AT]
  );
  await db.query(
    `INSERT INTO audit_log(id,at,action,position,data)
    SELECT 'upload_audit_'||i,$3,'benchmark.history',10000+i,'{}' FROM generate_series($1::int,$2::int)i`,
    [from, to, AT]
  );
  await db.query(
    `INSERT INTO location_pings(id,order_id,rider_id,lat,lng,at,position)
    SELECT 'upload_ping_'||i,'unrelated','rider',7,125,$3,10000+i FROM generate_series($1::int,$2::int)i`,
    [from, to, AT]
  );
  await db.query(
    `INSERT INTO notification_push_outbox(notification_id,device_id,user_id,status)
    SELECT 'upload_notice_'||i,'upload_device','other','delivered' FROM generate_series($1::int,$2::int)i`,
    [from, to]
  );
  await db.query('VACUUM (ANALYZE)');
}
async function budgets() {
  const { db: traced, queries } = instrument(db);
  await loadUploadIntakeStore(traced, 'clerk_client');
  await db.transaction(async () =>
    assert.ok(await loadClientSaveStore(traced, 'clerk_client', '/files', {}))
  );
  assert.ok(
    !queries.some((q) =>
      /FROM (audit_log|location_pings|notification_push_outbox)\b/.test(q.sql)
    )
  );
  return {
    queries: queries.length,
    rows: queries.reduce((sum, q) => sum + q.rows, 0),
  };
}
try {
  const sources =
    process.env.PERF_SOURCE === 'scoped' ? [false] : [true, false];
  for (const old of sources) {
    const cleanup = [];
    let output = '';
    try {
      await setupSaveParity(db);
      await db.query(
        `INSERT INTO device_tokens(id,user_id,token,platform,created_at,updated_at,position,data)
        VALUES('upload_device','other','upload_fixture_token','android',$1,$1,0,'{"appRole":"client"}')`,
        [AT]
      );
      const api = await saveParityApi(
        { after: (fn) => cleanup.push(fn) },
        false,
        {
          sourceRef: old ? baseline : null,
          timing: true,
          storageHandler,
          traceLoads: true,
          onOutput: (chunk) => {
            output += chunk;
          },
        }
      );
      let previous;
      const scales =
        old && process.env.PERF_BASELINE_ONLY_1X === '1'
          ? [[1, 1, base]]
          : [
              [1, 1, base],
              [10, base + 1, base * 10],
            ];
      for (const [scale, from, to] of scales) {
        await grow(from, to);
        const budget = old ? null : await budgets();
        if (previous)
          assert.deepEqual(
            budget,
            previous,
            '10x history changed scoped upload read budget'
          );
        previous = budget;
        const warm = await api('client', 'POST', '/files', form());
        assert.equal(warm.status, 201, JSON.stringify(warm.body));
        await new Promise((resolve) => setTimeout(resolve, 50));
        output = '';
        const files = [];
        for (let i = 0; i < samples; i++) {
          const result = await api('client', 'POST', '/files', form());
          assert.equal(result.status, 201, JSON.stringify(result.body));
          files.push(result.body.file.fileId);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        const times = [
          ...output.matchAll(/\[gridgo-api\] POST \/files 201 (\d+)ms/g),
        ]
          .map((m) => Number(m[1]))
          .sort((a, b) => a - b);
        assert.equal(times.length, samples, output);
        const fullLoads = [...output.matchAll(/benchmark_full_store_load/g)]
          .length;
        if (!old)
          assert.equal(
            fullLoads,
            0,
            'Eligible uploads and colour work must not load the full store'
          );
        const ready = (
          await db.query(
            'SELECT file_id,state,size_bytes FROM files WHERE file_id=ANY($1::text[])',
            [files]
          )
        ).rows;
        assert.equal(ready.length, samples);
        assert.ok(
          ready.every(
            (row) => row.state === 'ready' && row.size_bytes === bytes.length
          )
        );
        console.log(
          JSON.stringify({
            source: old ? 'dev_baseline' : 'scoped',
            scale,
            historyRows: to,
            photoBytes: bytes.length,
            samples,
            budget,
            fullLoads,
            medianMs: times[Math.floor(samples / 2)],
            p95Ms: times[Math.ceil(samples * 0.95) - 1],
          })
        );
      }
    } finally {
      for (const close of cleanup.reverse()) await close();
    }
  }
} finally {
  await db.close();
}
