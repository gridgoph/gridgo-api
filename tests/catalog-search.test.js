import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import { createDatabase } from "../src/database.js";
import { loadStore, saveStore, listOwnCatalogItems } from "../src/postgres-store.js";
import { seedReferenceData } from "../src/seed.js";
import { defaultTaxonomy } from "../src/taxonomy.js";
import { routeSupplierCatalog } from "../src/catalog-routes.js";

const DATABASE_URL = process.env.DATABASE_URL;
const AT = "2026-08-16T00:00:00.000Z";
const ISSUER = "https://casual-crab-9.clerk.accounts.dev";
const AUTHORIZED_PARTY = "http://localhost:19006";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_KEY = publicKey.export({ type: "spki", format: "pem" });

function huntStore() {
  return {
    taxonomy: defaultTaxonomy(),
    users: [
      { id: "supplier", role: "supplier", email: "shop@gridgo.test" },
      { id: "other", role: "supplier", email: "other@gridgo.test" },
    ],
    userRoleMemberships: [
      { userId: "supplier", role: "supplier" },
      { userId: "other", role: "supplier" },
    ],
    supplierServices: [
      {
        id: "service", supplierId: "supplier", categoryCode: "marketing_collateral",
        state: "live", pricingBasis: "per_unit", standardTurnaroundHours: 24,
        turnaroundHours: 24, referenceRateMinor: 100000, rushEnabled: false, version: 1,
      },
      {
        id: "other_service", supplierId: "other", categoryCode: "marketing_collateral",
        state: "live", pricingBasis: "per_unit", standardTurnaroundHours: 24,
        turnaroundHours: 24, referenceRateMinor: 100000, rushEnabled: false, version: 1,
      },
    ],
    acceptedFileFormats: [{ code: "pdf", displayName: "PDF", inputKind: "file", active: true }],
    catalogItems: [
      item("sci_tarp", "supplier", "Tarpaulin 10x10", "Heavy duty tarp", "tarpaulins_outdoor_banners", true, 0),
      item("sci_sheet", "supplier", "Outdoor sheet", "Plain vinyl", "tarpaulins_outdoor_banners", true, 1),
      item("sci_card", "supplier", "Business card", "Offset card", "flyers", true, 2),
      item("sci_hidden", "supplier", "Hidden tarp", "Warehouse tarp", "tarpaulins_outdoor_banners", false, 3),
      item("sci_rush", "supplier", "Rush flyer", "24 hour print", "flyers", true, 4),
      item("sci_other", "other", "Tarpaulin 8x8", "Rival shop tarp", "tarpaulins_outdoor_banners", true, 0),
    ],
    catalogOptionGroups: [
      { id: "finish", catalogItemId: "sci_card", name: "Finish", kind: "addon", required: false, sortOrder: 0, version: 1 },
    ],
    catalogOptions: [
      { id: "gold", optionGroupId: "finish", label: "Gold foil", priceModifierMinor: 1500, active: true, sortOrder: 0 },
    ],
    catalogPrepSteps: [
      { id: "cps_rush", catalogItemId: "sci_rush", sortOrder: 0, title: "Rush export", body: "", createdAt: AT, updatedAt: AT },
    ],
    catalogItemPhotos: [],
    catalogItemFileFormats: [],
  };
}

function item(id, supplierId, name, description, subcategoryCode, active, sortOrder) {
  return {
    id,
    supplierId,
    supplierServiceId: supplierId === "other" ? "other_service" : "service",
    name,
    description,
    basePriceMinor: 1000 + sortOrder,
    subcategoryCode,
    pricingUnit: "per_unit",
    packageQty: null,
    turnaroundMode: "inherit",
    turnaroundHours: null,
    fileFormatMode: "inherit",
    active,
    sortOrder,
    version: 1,
    createdAt: AT,
    updatedAt: AT,
  };
}

function list(store, search, userId = "supplier") {
  const url = new URL(`http://127.0.0.1/me/catalog-items${search || ""}`);
  return routeSupplierCatalog({
    req: { method: "GET", headers: {} },
    url,
    store,
    user: store.users.find((candidate) => candidate.id === userId),
    readBody: async () => ({}),
    id: (prefix) => prefix,
    now: () => AT,
    audit: () => {},
  });
}

function ids(response) {
  return response.body.items.map((entry) => entry.id);
}

test("empty q returns all of this shop's items and never another shop's", async () => {
  const store = huntStore();
  const listed = await list(store, "");
  assert.equal(listed.status, 200);
  assert.deepEqual(ids(listed).sort(), ["sci_card", "sci_hidden", "sci_rush", "sci_sheet", "sci_tarp"]);
  assert.equal(listed.body.total, 5);
  assert.equal(listed.body.nextCursor, undefined);
  assert.equal(listed.body.items.some((entry) => entry.supplierId === "other"), false);
});

test("blank and whitespace q are the same as omitting q", async () => {
  const store = huntStore();
  const omitted = await list(store, "");
  const blank = await list(store, "?q=");
  const spaces = await list(store, "?q=%20%20");
  assert.deepEqual(ids(blank), ids(omitted));
  assert.deepEqual(ids(spaces), ids(omitted));
  assert.equal(blank.body.total, omitted.body.total);
});

test("q=tarp hits name, description, and subcategory label", async () => {
  const store = huntStore();
  const listed = await list(store, "?q=tarp");
  assert.equal(listed.status, 200);
  assert.deepEqual(ids(listed).sort(), ["sci_hidden", "sci_sheet", "sci_tarp"]);
  assert.equal(ids(listed).includes("sci_card"), false);
  assert.equal(ids(listed).includes("sci_other"), false);
});

test("option label gold foil hits", async () => {
  const store = huntStore();
  const listed = await list(store, "?q=gold%20foil");
  assert.equal(listed.status, 200);
  assert.deepEqual(ids(listed), ["sci_card"]);
  assert.equal(listed.body.total, 1);
});

test("active=false intersect q stays shop-scoped", async () => {
  const store = huntStore();
  const hidden = await list(store, "?q=tarp&active=false");
  assert.deepEqual(ids(hidden), ["sci_hidden"]);
  assert.equal(hidden.body.total, 1);
  const live = await list(store, "?q=tarp&active=true");
  assert.deepEqual(ids(live).sort(), ["sci_sheet", "sci_tarp"]);
  assert.equal(ids(live).includes("sci_other"), false);
});

test("limit and nextCursor page without overlap", async () => {
  const store = huntStore();
  const first = await list(store, "?q=tarp&sort=board&limit=2");
  assert.equal(first.status, 200);
  assert.equal(first.body.items.length, 2);
  assert.equal(first.body.total, 3);
  assert.equal(typeof first.body.nextCursor, "string");
  const second = await list(store, `?q=tarp&sort=board&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
  assert.equal(second.body.items.length, 1);
  assert.equal(second.body.total, 3);
  assert.equal(second.body.nextCursor, undefined);
  const combined = [...ids(first), ...ids(second)];
  assert.deepEqual(combined, [...new Set(combined)]);
  assert.deepEqual(combined.sort(), ["sci_hidden", "sci_sheet", "sci_tarp"]);
});

test("q of 81 chars is 400 invalid_catalog_query", async () => {
  const store = huntStore();
  await assert.rejects(
    () => list(store, `?q=${"a".repeat(81)}`),
    (error) => error.status === 400 && error.code === "invalid_catalog_query",
  );
});

function token(subject) {
  const current = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "gridgo-test-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER, sub: subject, sid: `sess_${subject}`, azp: AUTHORIZED_PARTY,
    iat: current - 5, nbf: current - 5, exp: current + 300,
  })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startApi() {
  const port = await freePort();
  const api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      DATABASE_URL,
      CLERK_SECRET_KEY: "test-only-placeholder",
      CLERK_ISSUER: ISSUER,
      CLERK_AUTHORIZED_PARTIES: AUTHORIZED_PARTY,
      CLERK_JWT_KEY: JWT_KEY,
      HOST: "127.0.0.1",
      PORT: String(port),
      GRIDGO_BUILD_SHA: "catalog-search-test",
      GRIDGO_BUILD_TIME: AT,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`API exited before health:\n${output}`);
    try {
      const response = await fetch(`${api}/health`);
      if (response.ok) return { api, child, output: () => output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGTERM");
  throw new Error(`API did not become healthy:\n${output}`);
}

async function request(api, pathname, { method = "GET", subject } = {}) {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: subject ? { Authorization: `Bearer ${token(subject)}` } : {},
  });
  return { status: response.status, body: await response.json() };
}

async function clearCatalog(database) {
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, files,
    payout_milestones, order_payments, order_line_item_options, order_line_items, orders,
    supplier_catalog_prep_steps, supplier_catalog_item_photos, supplier_shop_media,
    supplier_catalog_item_file_formats, supplier_catalog_options, supplier_catalog_option_groups,
    supplier_catalog_items, supplier_service_file_formats, supplier_service_price_tiers, supplier_services,
    listing_starter_options, listing_starter_groups, listing_starters, accepted_file_formats,
    zones, taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
    taxonomy_category_aliases, taxonomy_categories, catalog_products, users,
    platform_settings RESTART IDENTITY CASCADE`);
}

function planMentions(plan, indexName) {
  return JSON.stringify(plan).includes(indexName);
}

test("Postgres hunt uses the search document, stays shop-scoped, and pages", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  t.after(async () => {
    await clearCatalog(database).catch(() => {});
    await database.close();
  });
  await clearCatalog(database);
  await seedReferenceData(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users.push(
      {
        id: "user_supplier", clerkUserId: "clerk_hunt_shop", email: "hunt@gridgo.test",
        name: "Shop", role: "supplier", verificationStatus: "approved", createdAt: AT,
      },
      {
        id: "user_other", clerkUserId: "clerk_hunt_other", email: "hunt-other@gridgo.test",
        name: "Other", role: "supplier", verificationStatus: "approved", createdAt: AT,
      },
    );
    store.userRoleMemberships.push(
      { userId: "user_supplier", role: "supplier", createdAt: AT },
      { userId: "user_other", role: "supplier", createdAt: AT },
    );
    store.supplierServices.push(
      {
        id: "svc_hunt", supplierId: "user_supplier", categoryCode: "marketing_collateral",
        state: "live", pricingBasis: "per_unit", referenceRateMinor: 1000, turnaroundHours: 24,
        standardTurnaroundHours: 24, version: 1, createdAt: AT, updatedAt: AT,
      },
      {
        id: "svc_other", supplierId: "user_other", categoryCode: "marketing_collateral",
        state: "live", pricingBasis: "per_unit", referenceRateMinor: 1000, turnaroundHours: 24,
        standardTurnaroundHours: 24, version: 1, createdAt: AT, updatedAt: AT,
      },
    );
    store.catalogItems.push(
      {
        id: "sci_tarp", supplierId: "user_supplier", supplierServiceId: "svc_hunt",
        subcategoryCode: "tarpaulins_outdoor_banners", name: "Tarpaulin 10x10",
        description: "Heavy duty tarp", basePriceMinor: 1000, pricingUnit: "per_unit",
        turnaroundMode: "inherit", fileFormatMode: "inherit", active: true, sortOrder: 0,
        version: 1, createdAt: AT, updatedAt: AT,
      },
      {
        id: "sci_sheet", supplierId: "user_supplier", supplierServiceId: "svc_hunt",
        subcategoryCode: "tarpaulins_outdoor_banners", name: "Outdoor sheet",
        description: "Plain vinyl", basePriceMinor: 1001, pricingUnit: "per_unit",
        turnaroundMode: "inherit", fileFormatMode: "inherit", active: true, sortOrder: 1,
        version: 1, createdAt: AT, updatedAt: AT,
      },
      {
        id: "sci_card", supplierId: "user_supplier", supplierServiceId: "svc_hunt",
        subcategoryCode: "flyers", name: "Business card", description: "Offset card",
        basePriceMinor: 1002, pricingUnit: "per_unit", turnaroundMode: "inherit",
        fileFormatMode: "inherit", active: true, sortOrder: 2, version: 1, createdAt: AT, updatedAt: AT,
      },
      {
        id: "sci_hidden", supplierId: "user_supplier", supplierServiceId: "svc_hunt",
        subcategoryCode: "tarpaulins_outdoor_banners", name: "Hidden tarp",
        description: "Warehouse tarp", basePriceMinor: 1003, pricingUnit: "per_unit",
        turnaroundMode: "inherit", fileFormatMode: "inherit", active: false, sortOrder: 3,
        version: 1, createdAt: AT, updatedAt: AT,
      },
      {
        id: "sci_other", supplierId: "user_other", supplierServiceId: "svc_other",
        subcategoryCode: "tarpaulins_outdoor_banners", name: "Tarpaulin 8x8",
        description: "Rival shop tarp", basePriceMinor: 2000, pricingUnit: "per_unit",
        turnaroundMode: "inherit", fileFormatMode: "inherit", active: true, sortOrder: 0,
        version: 1, createdAt: AT, updatedAt: AT,
      },
    );
    store.catalogOptionGroups.push({
      id: "cog_finish", catalogItemId: "sci_card", name: "Finish", kind: "addon",
      required: false, sortOrder: 0, version: 1, createdAt: AT, updatedAt: AT,
    });
    store.catalogOptions.push({
      id: "cop_gold", optionGroupId: "cog_finish", label: "Gold foil",
      priceModifierMinor: 1500, active: true, sortOrder: 0, createdAt: AT, updatedAt: AT,
    });
    await saveStore(database, store);
  });

  const document = (await database.query(
    "SELECT search_text FROM supplier_catalog_items WHERE id = $1",
    ["sci_card"],
  )).rows[0].search_text;
  assert.match(document, /Gold foil/i);
  assert.match(document, /Business card/i);

  const tarp = await listOwnCatalogItems(database, {
    supplierId: "user_supplier", q: "tarp", sort: "board", limit: 20, cursor: null,
    subcategoryCode: null, active: null,
  });
  assert.deepEqual(tarp.items.map((entry) => entry.id).sort(), ["sci_hidden", "sci_sheet", "sci_tarp"]);
  assert.equal(tarp.items.some((entry) => entry.id === "sci_other"), false);
  assert.equal(tarp.total, 3);

  const foil = await listOwnCatalogItems(database, {
    supplierId: "user_supplier", q: "gold foil", sort: "board", limit: 20, cursor: null,
    subcategoryCode: null, active: null,
  });
  assert.deepEqual(foil.items.map((entry) => entry.id), ["sci_card"]);

  const hidden = await listOwnCatalogItems(database, {
    supplierId: "user_supplier", q: "tarp", sort: "board", limit: 20, cursor: null,
    subcategoryCode: null, active: false,
  });
  assert.deepEqual(hidden.items.map((entry) => entry.id), ["sci_hidden"]);

  const first = await listOwnCatalogItems(database, {
    supplierId: "user_supplier", q: "tarp", sort: "board", limit: 2, cursor: null,
    subcategoryCode: null, active: null,
  });
  assert.equal(first.items.length, 2);
  assert.equal(typeof first.nextCursor, "string");
  const cursor = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"));
  const second = await listOwnCatalogItems(database, {
    supplierId: "user_supplier", q: "tarp", sort: "board", limit: 2, cursor,
    subcategoryCode: null, active: null,
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  const combined = [...first.items, ...second.items].map((entry) => entry.id);
  assert.deepEqual(combined, [...new Set(combined)]);
  assert.deepEqual(combined.sort(), ["sci_hidden", "sci_sheet", "sci_tarp"]);

  const { api, child } = await startApi();
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  });
  const live = await request(api, "/me/catalog-items?q=tarp", { subject: "clerk_hunt_shop" });
  assert.equal(live.status, 200);
  assert.deepEqual(live.body.items.map((entry) => entry.id).sort(), ["sci_hidden", "sci_sheet", "sci_tarp"]);
  assert.equal(live.body.total, 3);
  const tooLong = await request(api, `/me/catalog-items?q=${"a".repeat(81)}`, { subject: "clerk_hunt_shop" });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error, "invalid_catalog_query");

  const indexNames = new Set((await database.query(`
    SELECT indexname FROM pg_indexes WHERE tablename = 'supplier_catalog_items'
  `)).rows.map((row) => row.indexname));
  assert.equal(indexNames.has("supplier_catalog_items_search_tsv_idx"), true);
  assert.equal(indexNames.has("supplier_catalog_items_search_trgm_idx"), true);
  assert.equal(indexNames.has("supplier_catalog_items_supplier_active_sort_idx"), true);

  await database.query(`
    INSERT INTO supplier_catalog_items (
      id, supplier_id, supplier_service_id, subcategory_code, name, description,
      base_price_minor, pricing_unit, turnaround_mode, file_format_mode,
      active, sort_order, version, created_at, updated_at
    )
    SELECT 'sci_fill_' || g, 'user_supplier', 'svc_hunt', 'flyers',
           CASE WHEN g % 17 = 0 THEN 'Tarpaulin fill ' || g ELSE 'Filler ' || g END,
           '', 1000, 'per_unit', 'inherit', 'inherit',
           true, g + 10, 1, $1::timestamptz, $1::timestamptz
      FROM generate_series(1, 220) g
  `, [AT]);
  await database.query("ANALYZE supplier_catalog_items");

  const explained = await database.transaction(async () => {
    await database.query("SET LOCAL enable_seqscan = off");
    const fts = await database.query(`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM supplier_catalog_items
       WHERE search_tsv @@ websearch_to_tsquery('simple', $1)
    `, ["tarpaulin"]);
    const shopFts = await database.query(`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM supplier_catalog_items
       WHERE supplier_id = $1
         AND search_tsv @@ websearch_to_tsquery('simple', $2)
    `, ["user_supplier", "tarpaulin"]);
    const trgm = await database.query(`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM supplier_catalog_items
       WHERE search_text ILIKE '%' || $1 || '%'
    `, ["tarp"]);
    const board = await database.query(`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM supplier_catalog_items
       WHERE supplier_id = $1 AND active = true
       ORDER BY sort_order, id
    `, ["user_supplier"]);
    return {
      fts: fts.rows[0]["QUERY PLAN"],
      shopFts: shopFts.rows[0]["QUERY PLAN"],
      trgm: trgm.rows[0]["QUERY PLAN"],
      board: board.rows[0]["QUERY PLAN"],
    };
  });
  assert.equal(planMentions(explained.fts, "supplier_catalog_items_search_tsv_idx"), true);
  assert.equal(planMentions(explained.trgm, "supplier_catalog_items_search_trgm_idx"), true);
  assert.equal(/Seq Scan/i.test(JSON.stringify(explained.shopFts)), false);
  assert.equal(/Seq Scan/i.test(JSON.stringify(explained.board)), false);
});
