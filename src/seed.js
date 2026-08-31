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

/**
 * Bring a reference row back into line with what this build ships.
 *
 * Appending only was making the seed inert as well as idempotent: a starter
 * template seeded once kept whatever it had, so a corrected price or a field
 * added by a later migration never reached it. Lovis's "back-to-back, x2 the
 * price" was seeded before the column that could hold a multiplier existed,
 * and re-running the seed left it silently free.
 *
 * Reference data is the platform's own to restate -- a starter is a template
 * this build defines, not something a shop wrote. Nothing a supplier or client
 * owns goes through here, which is why this is safe to run on every boot and
 * why the taxonomy, whose codes shops have already stored against, keeps the
 * append-only rule instead.
 */
function reconcile(target, definitions, key) {
  const byKey = new Map(target.map((record) => [record[key], record]));
  for (const definition of definitions) {
    const held = byKey.get(definition[key]);
    if (held) Object.assign(held, structuredClone(definition));
    else target.push(structuredClone(definition));
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
    store.acceptedFileFormats ||= [];
    store.listingStarters ||= [];
    store.listingStarterGroups ||= [];
    store.listingStarterOptions ||= [];
    appendMissing(store.acceptedFileFormats, reference.acceptedFileFormats, "code");
    reconcile(store.listingStarters, reference.listingStarters, "id");
    reconcile(store.listingStarterGroups, reference.listingStarterGroups, "id");
    reconcile(store.listingStarterOptions, reference.listingStarterOptions, "id");
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
