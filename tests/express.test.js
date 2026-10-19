import test from "node:test";
import assert from "node:assert/strict";

import { createDatabase } from "../src/database.js";
import { listOwnCatalogItems, loadStore, saveStore } from "../src/postgres-store.js";
import { deadlineDays, MatchError, matchShop } from "../src/order-match.js";
import { resetDatabase } from "./fixtures/reset-database.js";
import { fixture as persistedFixture } from "./fixtures/reschedule.js";

import { fixture } from './fixtures/scheduling.js';
const NOW = '2026-09-23T01:00:00.000Z';
const TODAY_18 = '2026-09-23T10:00:00.000Z';
const RANKING = ['speed', 'quality', 'cost', 'distance'];
const notMet = (error) => error instanceof MatchError && error.code === "deadline_not_met";

test("Express switch remains visible but cannot make a three-day listing same-day", () => {
  const { store } = fixture({ express: true });
  const answer = deadlineDays(store, { subcategoryCode: "flyers", now: NOW, days: 8 });
  assert.equal(answer.days[0].state, "cannot");
  assert.equal(answer.expressAvailable, true);
  assert.throws(() => matchShop(store, { subcategoryCode: "flyers", ranking: RANKING, deadline: TODAY_18, now: NOW }), notMet);
  const ordinary = matchShop(store, { subcategoryCode: "flyers", ranking: RANKING, now: NOW });
  assert.equal(ordinary.expressPromise, false);
});

test("the Express switch persists per listing and defaults to off", { skip: !process.env.DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL: process.env.DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, "TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE");
  const store = persistedFixture();
  store.catalogItems.find((row) => row.id === "item_supplier").express = true;
  await db.transaction(() => saveStore(db, store));
  const loaded = await db.transaction(() => loadStore(db));
  assert.equal(loaded.catalogItems.find((row) => row.id === "item_supplier").express, true);
  assert.equal(loaded.catalogItems.find((row) => row.id === "item_replacement").express, false);
  // The shop's own board list reads its rows straight from SQL.
  const page = await listOwnCatalogItems(db, { supplierId: "supplier", q: null, subcategoryCode: null, active: null, sort: "board", limit: 20, cursor: null });
  assert.equal(page.items.find((row) => row.id === "item_supplier").express, true);
});
