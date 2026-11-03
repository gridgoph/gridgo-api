import { createDatabase } from './database.js';
import { backfillLastSignIns } from './last-sign-in.js';

const database = createDatabase();
try {
  console.log(JSON.stringify(await backfillLastSignIns(database)));
} finally {
  await database.close();
}
