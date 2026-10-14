import { readFile } from 'node:fs/promises';
import { createDatabase } from '../src/database.js';
import { readProductionTimeBackup, runProductionTimeCorrection } from '../src/production-time-correction-runner.js';

const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--apply') options.apply = true;
  else if (arg === '--dry-run') options.dryRun = true;
  else if (['--deployed-at', '--manifest', '--backup-at'].includes(arg) && args[index + 1] && !args[index + 1].startsWith('--')) options[arg.slice(2)] = args[++index];
  else throw new Error('Usage: --deployed-at ISO [--backup-at ISO] [--manifest FILE] [--dry-run|--apply]');
}
if (options.apply && options.dryRun) throw new Error('Choose dry-run or apply');
if (!options['deployed-at'] || !Number.isFinite(Date.parse(options['deployed-at']))) throw new Error('Supply the verified deployment instant with --deployed-at');
if (process.env.BACKUP_DATABASE_URL && !options['backup-at']) throw new Error('Supply --backup-at for the pre-deploy restored backup');
if (options['backup-at'] && !process.env.BACKUP_DATABASE_URL) throw new Error('BACKUP_DATABASE_URL is required with --backup-at');
const manifest = options.manifest ? JSON.parse(await readFile(options.manifest, 'utf8')) : [];
const database = createDatabase();
const backupDatabase = process.env.BACKUP_DATABASE_URL ? createDatabase({ DATABASE_URL: process.env.BACKUP_DATABASE_URL }) : null;
try {
  const backup = backupDatabase ? await readProductionTimeBackup(backupDatabase, options['backup-at']) : null;
  const report = await runProductionTimeCorrection(database, { deployedAt: options['deployed-at'], backup, manifest, apply: options.apply });
  console.log(JSON.stringify(report, null, 2));
  const unresolved = [...report.durations, ...report.orders].some(row => !['ready', 'unchanged', 'already_applied', 'finished_list_only'].includes(row.status));
  if (unresolved) process.exitCode = 2;
} finally {
  await database.close();
  await backupDatabase?.close();
}
