import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import { createDatabase } from "../src/database.js";
import { loadStore, saveStore } from "../src/postgres-store.js";
import { seedReferenceData } from "../src/seed.js";
import { defaultTaxonomy } from "../src/taxonomy.js";
import {
  appendOrderLineSnapshot,
  catalogItemBlockers,
  createOrderLineSnapshot,
  effectiveAcceptedFormats,
  listingStartersFor,
  publicCatalogItem,
  publicSupplierShop,
  selectedCatalogPrice,
} from "../src/supplier-catalog.js";
import { routeSupplierCatalog } from "../src/catalog-routes.js";

const DATABASE_URL = process.env.DATABASE_URL;
const AT = "2026-08-16T00:00:00.000Z";
const ISSUER = "https://casual-crab-9.clerk.accounts.dev";
const AUTHORIZED_PARTY = "http://localhost:19006";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_KEY = publicKey.export({ type: "spki", format: "pem" });

function fixture({ approvalStatus = "approved", fileFormatMode = "inherit", subcategoryCode = "tarpaulins_outdoor_banners" } = {}) {
  return {
    taxonomy: defaultTaxonomy(),
    users: [{ id: "supplier", role: "supplier" }],
    userRoleMemberships: [{ userId: "supplier", role: "supplier" }],
    supplierProfiles: [{
      userId: "supplier", shopName: "Print Shop", contactName: "Supplier",
      shop: { lat: 7.1, lng: 125.6, label: "Davao" }, pickupAvailable: false, version: 1,
    }],
    supplierPaymentTerms: [{
      supplierId: "supplier", deliveryDownpaymentRateBps: 0,
      pickupFullOnlineEnabled: true, pickupDownpaymentStoreEnabled: false, version: 1,
    }],
    approvalCases: [{ id: "case_supplier", userId: "supplier", kind: "supplier", status: approvalStatus }],
    acceptedFileFormats: [
      { code: "pdf", displayName: "PDF", inputKind: "file", active: true },
      { code: "png", displayName: "PNG", inputKind: "file", active: true },
      { code: "retired", displayName: "Retired", inputKind: "file", active: false },
    ],
    supplierServices: [{
      id: "service", supplierId: "supplier", categoryCode: "marketing_collateral",
      state: "live", pricingBasis: "per_unit", standardTurnaroundHours: 24,
      turnaroundHours: 24, referenceRateMinor: 100000, rushEnabled: false, version: 1,
    }],
    supplierServiceFileFormats: [
      { supplierServiceId: "service", formatCode: "pdf" },
      { supplierServiceId: "service", formatCode: "retired" },
    ],
    catalogItems: [{
      id: "item", supplierId: "supplier", supplierServiceId: "service",
      name: "Tarpaulin", description: "Outdoor banner", basePriceMinor: 100,
      subcategoryCode, pricingUnit: "per_unit", packageQty: null,
      turnaroundMode: "inherit", turnaroundHours: null,
      fileFormatMode, active: true, sortOrder: 0, version: 3, createdAt: AT, updatedAt: AT,
    }],
    catalogItemFileFormats: fileFormatMode === "override"
      ? [{ catalogItemId: "item", formatCode: "png" }]
      : [],
    files: [{
      fileId: "photo", ownerId: "supplier", purpose: "catalog_item_photo",
      detectedContentType: "image/jpeg", size: 10, state: "ready",
      objectKey: "catalog/photo.jpg", createdAt: AT,
    }, {
      fileId: "logo", ownerId: "supplier", purpose: "supplier_shop_image",
      detectedContentType: "image/png", size: 10, state: "ready",
      objectKey: "catalog/logo.png", createdAt: AT,
    }],
    catalogItemPhotos: [{ catalogItemId: "item", fileId: "photo", sortOrder: 0, createdAt: AT }],
    supplierShopMedia: [{ supplierId: "supplier", slot: "logo", fileId: "logo", updatedAt: AT }],
    catalogOptionGroups: [
      { id: "size", catalogItemId: "item", name: "Size", kind: "spec", required: true, helpText: "Pick a size", sortOrder: 0, version: 1 },
      { id: "grommets", catalogItemId: "item", name: "Grommets", kind: "addon", required: false, helpText: null, sortOrder: 1, version: 1 },
    ],
    catalogOptions: [
      { id: "a3", optionGroupId: "size", label: "2x3", priceModifierMinor: -150, specBinding: { fieldCode: "size", value: "2x3" }, active: true, sortOrder: 0 },
      { id: "a4", optionGroupId: "size", label: "4x8", priceModifierMinor: 25, specBinding: { fieldCode: "size", value: "4x8" }, active: true, sortOrder: 1 },
      { id: "grommet", optionGroupId: "grommets", label: "Add grommets", priceModifierMinor: 20, active: true, sortOrder: 0 },
    ],
    listingStarters: [{
      id: "lst_tarpaulins_outdoor_banners",
      subcategoryCode: "tarpaulins_outdoor_banners",
      name: "Tarpaulin starter",
      defaultPricingUnit: "per_unit",
      defaultPackageQty: null,
      defaultTurnaroundHours: 24,
      defaultFormatCodes: ["pdf", "png", "jpeg", "psd", "canva_link"],
    }],
    listingStarterGroups: [
      { id: "lstg_tarp_size", starterId: "lst_tarpaulins_outdoor_banners", name: "Size", kind: "spec", required: true, helpText: "Finished size", sortOrder: 0 },
      { id: "lstg_tarp_grommets", starterId: "lst_tarpaulins_outdoor_banners", name: "Grommets", kind: "addon", required: false, helpText: null, sortOrder: 1 },
    ],
    listingStarterOptions: [
      { id: "lsto_tarp_2x3", starterGroupId: "lstg_tarp_size", label: "2x3", priceModifierMinor: 0, specBinding: { fieldCode: "size", value: "2x3" }, sortOrder: 0 },
      { id: "lsto_tarp_grommets", starterGroupId: "lstg_tarp_grommets", label: "Add grommets", priceModifierMinor: 1500, specBinding: null, sortOrder: 0 },
    ],
    orders: [{ id: "order", supplierId: "supplier" }],
    orderLineItems: [],
    orderLineItemOptions: [],
  };
}

function token(subject, claims = {}) {
  const current = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "gridgo-test-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER, sub: subject, sid: `sess_${subject}`, azp: AUTHORIZED_PARTY,
    iat: current - 5, nbf: current - 5, exp: current + 300, ...claims,
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

async function startApi(extraEnv = {}) {
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
      GRIDGO_BUILD_SHA: "supplier-catalog-test",
      GRIDGO_BUILD_TIME: AT,
      ...extraEnv,
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

async function request(api, pathname, { method = "GET", subject, body, headers = {} } = {}) {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: {
      ...(subject ? { Authorization: `Bearer ${token(subject)}` } : {}),
      ...(body == null ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test("effective accepted formats inherit service defaults and honor item overrides", () => {
  const inherited = fixture();
  assert.deepEqual(effectiveAcceptedFormats(inherited, inherited.catalogItems[0]).map((format) => format.code), ["pdf"]);

  const overridden = fixture({ fileFormatMode: "override" });
  assert.deepEqual(effectiveAcceptedFormats(overridden, overridden.catalogItems[0]).map((format) => format.code), ["png"]);
});

test("single-select modifiers use integer arithmetic and floor effective price at zero", () => {
  const store = fixture();
  assert.equal(selectedCatalogPrice(store, store.catalogItems[0], ["a3"]).effectiveUnitPriceMinor, 0);
  assert.equal(selectedCatalogPrice(store, store.catalogItems[0], ["a4", "grommet"]).effectiveUnitPriceMinor, 145);
});

test("from price uses the cheapest required spec plus optional cheaper add-ons", () => {
  const store = fixture();
  const item = publicCatalogItem(store, store.catalogItems[0]);
  assert.equal(item.fromPriceMinor, 0);
  assert.equal(item.subcategoryCode, "tarpaulins_outdoor_banners");
  assert.equal(item.pricingUnit, "per_unit");
  assert.equal(item.optionGroups[1].kind, "addon");
  assert.equal(item.optionGroups[0].helpText, "Pick a size");
});

test("pending suppliers stay private while approved complete catalog items publish", () => {
  const pending = fixture({ approvalStatus: "pending" });
  assert.equal(publicCatalogItem(pending, pending.catalogItems[0]), null);
  assert.equal(publicSupplierShop(pending, "supplier"), null);

  const approved = fixture();
  assert.equal(publicCatalogItem(approved, approved.catalogItems[0])?.id, "item");
  assert.equal(publicSupplierShop(approved, "supplier")?.shopName, "Print Shop");
});

test("public catalog requires a complete active item under a live service", () => {
  const store = fixture();
  store.catalogItemPhotos = [];
  assert.ok(catalogItemBlockers(store, store.catalogItems[0], { publicOnly: true }).includes("photo"));
  assert.equal(publicCatalogItem(store, store.catalogItems[0]), null);

  const draft = fixture();
  draft.supplierServices[0].state = "draft";
  assert.equal(publicCatalogItem(draft, draft.catalogItems[0]), null);
});

test("listing starters for a subcategory are platform copies, not shop records", () => {
  const store = fixture();
  const starters = listingStartersFor(store, "tarpaulins_outdoor_banners");
  assert.equal(starters.length, 1);
  assert.equal(starters[0].id, "lst_tarpaulins_outdoor_banners");
  assert.equal(starters[0].groups[0].name, "Size");
  assert.equal(starters[0].groups[1].kind, "addon");
  assert.equal(starters[0].defaultFormatCodes.includes("canva_link"), true);
});

test("creating from a starter copies groups and never stores the starter id", async () => {
  const store = fixture();
  store.catalogItems = [];
  store.catalogOptionGroups = [];
  store.catalogOptions = [];
  store.catalogItemPhotos = [];
  const user = store.users[0];
  const response = await routeSupplierCatalog({
    req: { method: "POST", headers: {} },
    url: new URL("http://127.0.0.1/me/catalog-items"),
    store,
    user,
    readBody: async () => ({
      supplierServiceId: "service",
      starterId: "lst_tarpaulins_outdoor_banners",
      name: "Shop tarp",
      description: "Our outdoor banner",
      basePriceMinor: 45000,
      subcategoryCode: "tarpaulins_outdoor_banners",
      pricingUnit: "per_unit",
      turnaroundMode: "inherit",
    }),
    id: (prefix) => `${prefix}_copied`,
    now: () => AT,
    audit: () => {},
  });
  assert.equal(response.status, 201);
  const item = response.body.item;
  assert.equal(item.starterId, undefined);
  assert.equal(item.subcategoryCode, "tarpaulins_outdoor_banners");
  assert.equal(item.optionGroups.length, 2);
  assert.equal(item.optionGroups[0].options[0].label, "2x3");
  assert.equal(item.optionGroups[1].kind, "addon");
  assert.equal(store.catalogItems[0].starterId, undefined);
});

test("create rejects a subcategory outside the owning service category", async () => {
  const store = fixture();
  store.catalogItems = [];
  await assert.rejects(
    () => routeSupplierCatalog({
      req: { method: "POST", headers: {} },
      url: new URL("http://127.0.0.1/me/catalog-items"),
      store,
      user: store.users[0],
      readBody: async () => ({
        supplierServiceId: "service",
        name: "Shirt",
        basePriceMinor: 28000,
        subcategoryCode: "custom_apparel",
        pricingUnit: "per_unit",
        turnaroundMode: "inherit",
      }),
      id: (prefix) => `${prefix}_bad`,
      now: () => AT,
      audit: () => {},
    }),
    (error) => error.code === "invalid_subcategory_code",
  );
});

test("order-line helper writes immutable catalog, option, format, price, and listing snapshots", () => {
  const store = fixture();
  const snapshot = createOrderLineSnapshot(store, {
    orderId: "order",
    catalogItemId: "item",
    optionIds: ["a4", "grommet"],
    quantity: 2,
    expectedVersion: 3,
    expectedServiceVersion: 1,
    acceptedFormatCode: "pdf",
    structuredSpec: {},
    createdAt: AT,
  }, (prefix) => `${prefix}_snap`);
  assert.equal(snapshot.lineItem.itemNameSnapshot, "Tarpaulin");
  assert.equal(snapshot.lineItem.pricingUnitSnapshot, "per_unit");
  assert.equal(snapshot.lineItem.packageQtySnapshot, null);
  assert.equal(snapshot.lineItem.turnaroundHoursSnapshot, 24);
  assert.equal(snapshot.lineItem.baseUnitPriceMinor, 100);
  assert.equal(snapshot.lineItem.effectiveUnitPriceMinor, 145);
  assert.equal(snapshot.lineItem.lineSubtotalMinor, 290);
  assert.deepEqual(snapshot.lineItem.acceptedFormatCodesSnapshot, ["pdf"]);
  assert.equal(snapshot.options[0].groupKindSnapshot, "spec");
  assert.equal(snapshot.options[1].groupKindSnapshot, "addon");
  assert.equal(snapshot.options[1].optionLabelSnapshot, "Add grommets");

  appendOrderLineSnapshot(store, {
    orderId: "order",
    catalogItemId: "item",
    optionIds: ["a4"],
    quantity: 1,
    expectedVersion: 3,
    expectedServiceVersion: 1,
    acceptedFormatCode: "pdf",
    structuredSpec: {},
    createdAt: AT,
  }, (prefix) => `${prefix}_appended`);
  assert.equal(store.orderLineItems.length, 1);
  assert.equal(store.orderLineItemOptions.length, 1);
});

test("GET /listing-starters and public shop browse answer on the live API", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  t.after(() => database.close());
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, proofs, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, files,
    payout_milestones, order_payments, order_line_item_options, order_line_items, orders,
    supplier_catalog_item_photos, supplier_shop_media, supplier_catalog_item_file_formats,
    supplier_catalog_options, supplier_catalog_option_groups, supplier_catalog_items,
    supplier_service_file_formats, supplier_service_price_tiers, supplier_services,
    listing_starter_options, listing_starter_groups, listing_starters, accepted_file_formats,
    zones, taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
    taxonomy_category_aliases, taxonomy_categories, catalog_products, users,
    platform_settings RESTART IDENTITY CASCADE`);
  await seedReferenceData(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users.push({
      id: "user_supplier", clerkUserId: "clerk_supplier", email: "supplier@gridgo.test",
      name: "Supplier", role: "supplier", verificationStatus: "approved", createdAt: AT,
    });
    store.userRoleMemberships.push({ userId: "user_supplier", role: "supplier", createdAt: AT });
    store.supplierProfiles.push({
      userId: "user_supplier", shopName: "Print Shop", contactName: "Supplier",
      shop: { lat: 7.064, lng: 125.6085, label: "Davao Shop" }, pickupAvailable: false, updatedAt: AT,
    });
    await saveStore(database, store);
  });

  const { api, child } = await startApi();
  t.after(() => child.kill("SIGTERM"));

  const shops = await request(api, "/catalog/shops");
  assert.equal(shops.status, 200);
  assert.deepEqual(shops.body.shops, []);

  const starters = await request(api, "/listing-starters?subcategoryCode=tarpaulins_outdoor_banners", {
    subject: "clerk_supplier",
  });
  assert.equal(starters.status, 200);
  assert.ok(starters.body.starters.some((starter) => starter.subcategoryCode === "tarpaulins_outdoor_banners"));
  assert.ok(starters.body.starters[0].groups.length > 0);
});
