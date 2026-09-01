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
 * this build defines, not something a shop wrote. A shop's own board is a
 * separate copy taken at the moment it added a listing, so nothing a supplier
 * or client owns is touched here. The taxonomy keeps the append-only rule
 * instead, because shops have already stored codes against it.
 */
function replaceAll(target, definitions) {
  // Wholesale rather than field-by-field. These rows carry unique orderings
  // among themselves, so patching them one at a time collides with the rows
  // not yet patched -- and a template the build has dropped should leave
  // rather than linger with a stale ordering around it.
  target.length = 0;
  for (const definition of definitions) target.push(structuredClone(definition));
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
    // The template orderings are unique among themselves, so a reshuffle has
    // to pass through itself before it settles. The constraints are deferrable
    // for exactly this; nothing else in the seed needs it.
    await database.query("SET CONSTRAINTS listing_starter_groups_starter_id_sort_order_key, listing_starter_options_starter_group_id_sort_order_key DEFERRED");
    replaceAll(store.listingStarters, reference.listingStarters);
    replaceAll(store.listingStarterGroups, reference.listingStarterGroups);
    replaceAll(store.listingStarterOptions, reference.listingStarterOptions);
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
