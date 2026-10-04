import crypto from 'node:crypto';
import { createDatabase } from './database.js';
import { loadStore, saveStore } from './postgres-store.js';
import { createObjectStorage } from './object-storage.js';
import { createFileRetention } from './file-retention.js';

const args = process.argv.slice(2);
if (args.some((arg) => !['--dry-run', '--execute'].includes(arg)) || args.length > 1) {
  console.error('Usage: npm run files:retention -- [--dry-run|--execute]');
  process.exit(1);
}
const database = createDatabase();
try {
  await database.assertReady();
  const worker = createFileRetention({ database, load: () => loadStore(database),
    save: (store) => saveStore(database, store), storage: createObjectStorage(process.env),
    enabled: process.env.GRIDGO_FILE_RETENTION_DELETE_ENABLED === 'true',
    id: (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}` });
  const report = await worker.run({ dryRun: !args.includes('--execute') });
  console.log(JSON.stringify(report, null, 2));
  if (report.failed) process.exitCode = 1;
} finally { await database.close(); }
