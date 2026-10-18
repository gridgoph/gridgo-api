import { pathToFileURL } from 'node:url';
import { createDatabase } from './database.js';
import { loadStore, saveStore } from './postgres-store.js';
import { setReviewData } from './review-data.js';

export async function runReviewDataCommand(args, database) {
  const [userId, mode, flag, ...reasonParts] = args;
  if (!userId || !['--on', '--off'].includes(mode) || flag !== '--reason' || !reasonParts.join(' ').trim()) {
    throw new Error('Usage: npm run review-data:set -- <userId> --on|--off --reason <reason>');
  }
  return database.transaction(async () => {
    const store = await loadStore(database);
    const target = store.users.find(row => row.id === userId);
    const user = setReviewData(store, { role: 'system', name: 'Review data operator' }, userId, {
      reviewData: mode === '--on', expectedVersion: target?.version || 1, reason: reasonParts.join(' '),
    });
    await saveStore(database, store);
    return { userId: user.id, reviewData: user.reviewData, version: user.version };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let database;
  try { database = createDatabase(); console.log(JSON.stringify(await runReviewDataCommand(process.argv.slice(2), database))); }
  catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
  finally { await database?.close(); }
}
