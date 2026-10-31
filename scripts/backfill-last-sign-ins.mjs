import { createDatabase } from '../src/database.js';
import { backfillLastSignIns } from '../src/last-sign-in.js';

const database = createDatabase();
try {
  console.log(JSON.stringify(await backfillLastSignIns(database)));
} finally {
  await database.close();
}
