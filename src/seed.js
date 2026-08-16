import { fileURLToPath } from "node:url";

import { createDatabase } from "./database.js";
import { loadStore, saveStore } from "./postgres-store.js";
import { referenceData } from "./reference-data.js";

function appendMissing(target, definitions, key) {
  const existing = new Set(target.map((record) => record[key]));
  for (const definition of definitions) {
    if (!existing.has(definition[key])) target.push(structuredClone(definition));
  }
}

export async function seedReferenceData(database) {
  await database.transaction(async () => {
    const store = await loadStore(database);
    const reference = referenceData();
    appendMissing(store.catalog, reference.catalog, "id");
    for (const key of ["categories", "categoryAliases", "subcategories", "materials", "finishes"]) {
      appendMissing(store.taxonomy[key], reference.taxonomy[key], "code");
    }
    store.settings ||= {};
    for (const [key, value] of Object.entries(reference.settings)) {
      if (!Object.hasOwn(store.settings, key)) store.settings[key] = structuredClone(value);
    }
    appendMissing(store.zones, reference.zones, "code");
    await saveStore(database, store);
  });
}

async function main() {
  if (process.argv.includes("--reset")) {
    throw new Error("--reset was removed. The PostgreSQL seed is idempotent and never deletes user or operational data.");
  }
  const database = createDatabase(process.env);
  try {
    await database.assertReady();
    await seedReferenceData(database);
    console.log("Seeded GRIDGO platform reference data (no users or operational records).\n");
  } finally {
    await database.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
