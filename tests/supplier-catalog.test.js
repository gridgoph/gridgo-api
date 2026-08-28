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
  privateCatalogItem,
  publicCatalogItem,
  publicSupplierShop,
  selectedCatalogPrice,
} from "../src/supplier-catalog.js";
import { routeSupplierCatalog } from "../src/catalog-routes.js";
import { UNOPENED_FILE_MESSAGE } from "../src/file-formats.js";
import { defaultAcceptedFileFormats } from "../src/reference-data.js";

const DATABASE_URL = process.env.DATABASE_URL;
const AT = "2026-08-16T00:00:00.000Z";
const ISSUER = "https://casual-crab-9.clerk.accounts.dev";
const AUTHORIZED_PARTY = "http://localhost:19006";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_KEY = publicKey.export({ type: "spki", format: "pem" });

function fixture({ approvalStatus = "approved", fileFormatMode = "inherit", subcategoryCode = "tarpaulins_outdoor_banners" } = {}) {
  return {
    taxonomy: defaultTaxonomy(),
    users: [{ id: "supplier", role: "supplier", email: "shop@gridgo.test", phone: "+639171234567" }],
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

test("from price uses cheapest required specs and ignores add-ons until selected", () => {
  const store = fixture();
  store.catalogItems[0].basePriceMinor = 10000;
  store.catalogOptions.find((option) => option.id === "a3").priceModifierMinor = 500;
  store.catalogOptions.find((option) => option.id === "a4").priceModifierMinor = 2500;
  store.catalogOptions.find((option) => option.id === "grommet").priceModifierMinor = -4000;
  const item = publicCatalogItem(store, store.catalogItems[0]);
  assert.equal(item.fromPriceMinor, 10500);
  assert.equal(item.acceptedFormats[0].inputKind, "file");
  assert.equal(item.subcategoryCode, "tarpaulins_outdoor_banners");
  assert.equal(item.optionGroups[1].kind, "addon");
  assert.deepEqual(item.prepSteps, []);
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

test("the platform registry lists uploadable types and resolves a plus query", async () => {
  const store = fixture();
  store.acceptedFileFormats = defaultAcceptedFileFormats();
  const listed = await routeSupplierCatalog({
    req: { method: "GET", headers: {} },
    url: new URL("http://127.0.0.1/accepted-file-formats"),
    store,
    user: null,
    readBody: async () => ({}),
    id: (prefix) => prefix,
    now: () => AT,
    audit: () => {},
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.formats.find((format) => format.code === "webp").uploadable, true);
  assert.equal(listed.body.formats.find((format) => format.code === "3mf").uploadable, false);
  assert.equal(listed.body.resolution, undefined);

  const found = await routeSupplierCatalog({
    req: { method: "GET", headers: {} },
    url: new URL("http://127.0.0.1/accepted-file-formats?q=AI"),
    store,
    user: null,
    readBody: async () => ({}),
    id: (prefix) => prefix,
    now: () => AT,
    audit: () => {},
  });
  assert.equal(found.status, 200);
  assert.equal(found.body.resolution.status, "unknown");
  assert.equal(found.body.resolution.message, UNOPENED_FILE_MESSAGE);

  const jpeg = await routeSupplierCatalog({
    req: { method: "GET", headers: {} },
    url: new URL("http://127.0.0.1/accepted-file-formats?q=.jpg"),
    store,
    user: null,
    readBody: async () => ({}),
    id: (prefix) => prefix,
    now: () => AT,
    audit: () => {},
  });
  assert.equal(jpeg.body.resolution.status, "matched");
  assert.equal(jpeg.body.resolution.format.code, "jpeg");
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

test("POST option-groups accepts expectedVersion and an empty options array", async () => {
  const store = fixture();
  const response = await routeSupplierCatalog({
    req: { method: "POST", headers: {} },
    url: new URL("http://127.0.0.1/me/catalog-items/item/option-groups"),
    store,
    user: store.users[0],
    readBody: async () => ({ expectedVersion: 3, name: "Rush", kind: "addon" }),
    id: (prefix) => `${prefix}_empty`,
    now: () => AT,
    audit: () => {},
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.group.name, "Rush");
  assert.deepEqual(response.body.group.options, []);
  assert.ok(catalogItemBlockers(store, store.catalogItems[0]).some((blocker) => blocker.startsWith("option_group:")));
});

test("DELETE listing with If-Match removes a never-ordered item from the list", async () => {
  const store = fixture();
  const created = await routeSupplierCatalog({
    req: { method: "POST", headers: {} },
    url: new URL("http://127.0.0.1/me/catalog-items"),
    store,
    user: store.users[0],
    readBody: async () => ({
      supplierServiceId: "service",
      name: "Draft flyer",
      basePriceMinor: 1200,
      subcategoryCode: "flyers",
      pricingUnit: "per_unit",
      turnaroundMode: "inherit",
    }),
    id: (prefix) => `${prefix}_remove`,
    now: () => AT,
    audit: () => {},
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.item.id, "sci_remove");
  const deleted = await routeSupplierCatalog({
    req: { method: "DELETE", headers: { "if-match": String(created.body.item.version) } },
    url: new URL("http://127.0.0.1/me/catalog-items/sci_remove"),
    store,
    user: store.users[0],
    readBody: async () => ({}),
    id: (prefix) => prefix,
    now: () => AT,
    audit: () => {},
  });
  assert.equal(deleted.status, 200);
  const listed = await routeSupplierCatalog({
    req: { method: "GET", headers: {} },
    url: new URL("http://127.0.0.1/me/catalog-items"),
    store,
    user: store.users[0],
    readBody: async () => ({}),
    id: (prefix) => prefix,
    now: () => AT,
    audit: () => {},
  });
  assert.equal(listed.body.items.some((item) => item.id === "sci_remove"), false);
  assert.equal(listed.body.total, listed.body.items.length);
  assert.equal(listed.body.nextCursor, undefined);
});

test("GET /me/catalog-items is shop-scoped and answers total", async () => {
  const store = fixture();
  store.users.push({ id: "other", role: "supplier" });
  store.catalogItems.push({
    ...store.catalogItems[0],
    id: "other_item",
    supplierId: "other",
    name: "Other tarp",
    sortOrder: 1,
  });
  const listed = await routeSupplierCatalog({
    req: { method: "GET", headers: {} },
    url: new URL("http://127.0.0.1/me/catalog-items"),
    store,
    user: store.users[0],
    readBody: async () => ({}),
    id: (prefix) => prefix,
    now: () => AT,
    audit: () => {},
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.items.length, 1);
  assert.equal(listed.body.items[0].id, "item");
  assert.equal(listed.body.nextCursor, undefined);
});

test("GET /me/catalog-items q hunts this shop's name and subcategory", async () => {
  const store = fixture();
  store.catalogItems.push({
    id: "card",
    supplierId: "supplier",
    supplierServiceId: "service",
    name: "Business card",
    description: "Calling card",
    basePriceMinor: 500,
    subcategoryCode: "flyers",
    pricingUnit: "per_unit",
    packageQty: null,
    turnaroundMode: "inherit",
    turnaroundHours: null,
    fileFormatMode: "inherit",
    active: true,
    sortOrder: 1,
    version: 1,
    createdAt: AT,
    updatedAt: AT,
  });
  const listed = await routeSupplierCatalog({
    req: { method: "GET", headers: {} },
    url: new URL("http://127.0.0.1/me/catalog-items?q=tarp"),
    store,
    user: store.users[0],
    readBody: async () => ({}),
    id: (prefix) => prefix,
    now: () => AT,
    audit: () => {},
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.length, 1);
  assert.equal(listed.body.items[0].id, "item");
  assert.equal(listed.body.total, 1);
});

test("GET item includes persisted photos after postgres round-trip", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, proofs, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, files,
    payout_milestones, order_payments, order_line_item_options, order_line_items, orders,
    supplier_catalog_prep_steps, supplier_catalog_item_photos, supplier_shop_media,
    supplier_catalog_item_file_formats, supplier_catalog_options, supplier_catalog_option_groups,
    supplier_catalog_items, supplier_service_file_formats, supplier_service_price_tiers, supplier_services,
    listing_starter_options, listing_starter_groups, listing_starters, accepted_file_formats,
    zones, taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
    taxonomy_category_aliases, taxonomy_categories, catalog_products, users,
    platform_settings RESTART IDENTITY CASCADE`);
  await seedReferenceData(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users.push({
      id: "user_supplier", clerkUserId: "clerk_supplier_photos", email: "photos@gridgo.test",
      name: "Supplier", role: "supplier", verificationStatus: "approved", createdAt: AT,
    });
    store.userRoleMemberships.push({ userId: "user_supplier", role: "supplier", createdAt: AT });
    store.supplierProfiles.push({
      userId: "user_supplier", shopName: "Photo Shop", contactName: "Supplier",
      shop: { lat: 7.064, lng: 125.6085, label: "Davao Shop" }, pickupAvailable: false, updatedAt: AT,
    });
    store.supplierServices.push({
      id: "svc_photo", supplierId: "user_supplier", categoryCode: "marketing_collateral",
      state: "live", pricingBasis: "per_unit", referenceRateMinor: 1000, turnaroundHours: 24,
      version: 1, createdAt: AT, updatedAt: AT,
    });
    store.catalogItems.push({
      id: "sci_photo", supplierId: "user_supplier", supplierServiceId: "svc_photo",
      subcategoryCode: "flyers", name: "Flyer", description: "", basePriceMinor: 1000,
      pricingUnit: "per_unit", turnaroundMode: "inherit", fileFormatMode: "inherit",
      active: true, sortOrder: 0, version: 1, createdAt: AT, updatedAt: AT,
    });
    store.files.push({
      fileId: "file_sample", ownerId: "user_supplier", purpose: "catalog_item_photo",
      originalFilename: "sample.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg",
      size: 12, state: "ready", objectKey: "catalog/sample.jpg", references: [], createdAt: AT,
    });
    store.catalogItemPhotos.push({
      catalogItemId: "sci_photo", fileId: "file_sample", sortOrder: 0, altText: "Board sample", createdAt: AT,
    });
    await saveStore(database, store);
  });
  const reloaded = await loadStore(database);
  const item = privateCatalogItem(reloaded, reloaded.catalogItems.find((candidate) => candidate.id === "sci_photo"));
  assert.equal(item.id, "sci_photo");
  assert.equal(item.photos.length, 1);
  assert.equal(item.photos[0].fileId, "file_sample");
  assert.equal(item.photos[0].sortOrder, 0);
  assert.equal(item.photos[0].altText, "Board sample");
  await database.close();
});

test("creating from a GRIDGO starter persists its file types", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, proofs, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, files,
    payout_milestones, order_payments, order_line_item_options, order_line_items, orders,
    supplier_catalog_prep_steps, supplier_catalog_item_photos, supplier_shop_media,
    supplier_catalog_item_file_formats, supplier_catalog_options, supplier_catalog_option_groups,
    supplier_catalog_items, supplier_service_file_formats, supplier_service_price_tiers, supplier_services,
    listing_starter_options, listing_starter_groups, listing_starters, accepted_file_formats,
    zones, taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
    taxonomy_category_aliases, taxonomy_categories, catalog_products, users,
    platform_settings RESTART IDENTITY CASCADE`);
  await seedReferenceData(database);
  let itemId = "";
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users.push({
      id: "user_supplier", clerkUserId: "clerk_supplier_starter", email: "starter@gridgo.test",
      name: "Supplier", role: "supplier", verificationStatus: "approved", createdAt: AT,
    });
    store.userRoleMemberships.push({ userId: "user_supplier", role: "supplier", createdAt: AT });
    store.supplierServices.push({
      id: "svc_starter", supplierId: "user_supplier", categoryCode: "marketing_collateral",
      state: "live", pricingBasis: "per_unit", referenceRateMinor: 1000, turnaroundHours: 24,
      version: 1, createdAt: AT, updatedAt: AT,
    });
    const response = await routeSupplierCatalog({
      req: { method: "POST", headers: {} },
      url: new URL("http://127.0.0.1/me/catalog-items"),
      store,
      user: store.users.find((candidate) => candidate.id === "user_supplier"),
      readBody: async () => ({
        supplierServiceId: "svc_starter",
        subcategoryCode: "flyers",
        name: "Test",
        starterId: "lst_flyers",
        active: false,
      }),
      id: (prefix) => `${prefix}_starter_save`,
      now: () => AT,
      audit: () => {},
    });
    assert.equal(response.status, 201);
    itemId = response.body.item.id;
    assert.ok(response.body.item.optionGroups.length >= 1);
    await saveStore(database, store);
  });
  const reloaded = await loadStore(database);
  const item = privateCatalogItem(reloaded, reloaded.catalogItems.find((candidate) => candidate.id === itemId));
  assert.equal(item.name, "Test");
  assert.equal(item.fileFormatMode, "override");
  assert.deepEqual(item.acceptedFormats.map((format) => format.code).sort(), ["jpeg", "pdf", "png"]);
  await database.close();
});

test("prep steps persist on private and public item projections", async () => {
  const store = fixture();
  const created = await routeSupplierCatalog({
    req: { method: "POST", headers: {} },
    url: new URL("http://127.0.0.1/me/catalog-items/item/prep-steps"),
    store,
    user: store.users[0],
    readBody: async () => ({ expectedVersion: 3, title: "Flatten PNG", body: "Export art as a flattened PNG." }),
    id: (prefix) => `${prefix}_guide`,
    now: () => AT,
    audit: () => {},
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.prepStep.title, "Flatten PNG");
  const got = await routeSupplierCatalog({
    req: { method: "GET", headers: {} },
    url: new URL("http://127.0.0.1/me/catalog-items/item"),
    store,
    user: store.users[0],
    readBody: async () => ({}),
    id: (prefix) => prefix,
    now: () => AT,
    audit: () => {},
  });
  assert.equal(got.body.item.id, "item");
  assert.equal(got.body.item.prepSteps[0].title, "Flatten PNG");
  const published = publicCatalogItem(store, store.catalogItems[0]);
  assert.equal(published.prepSteps[0].body, "Export art as a flattened PNG.");
});

function supplierProfileCall(store, { method, body = {}, headers = {}, audit = () => {} } = {}) {
  return routeSupplierCatalog({
    req: { method, headers },
    url: new URL("http://127.0.0.1/me/supplier-profile"),
    store,
    user: store.users[0],
    readBody: async () => body,
    id: (prefix) => prefix,
    now: () => AT,
    audit,
  });
}

test("a shop changes its own phone number and reads it back with its email", async () => {
  const store = fixture();
  const actions = [];
  const patched = await supplierProfileCall(store, {
    method: "PATCH",
    body: { expectedVersion: 1, phone: "0917 765 4321" },
    audit: (_store, entry) => actions.push(entry.action),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.profile.phone, "+639177654321");
  assert.equal(patched.body.profile.email, "shop@gridgo.test");
  assert.equal(patched.body.profile.version, 2);
  assert.equal(patched.body.profile.updatedAt, AT);
  assert.deepEqual(actions, ["supplier_profile.update"]);
  assert.equal(store.users[0].phone, "+639177654321");

  const got = await supplierProfileCall(store, { method: "GET" });
  assert.equal(got.status, 200);
  assert.equal(got.body.profile.phone, "+639177654321");
  assert.equal(got.body.profile.email, "shop@gridgo.test");
  assert.equal(got.body.profile.shopName, "Print Shop");
  assert.equal(got.body.profile.version, 2);
});

test("a shop that never gave a number reads back an empty phone", async () => {
  const store = fixture();
  delete store.users[0].phone;
  const got = await supplierProfileCall(store, { method: "GET" });
  assert.equal(got.body.profile.phone, null);
  assert.equal(got.body.profile.email, "shop@gridgo.test");
});

test("a phone edit from a stale screen still loses to the current record", async () => {
  const store = fixture();
  await supplierProfileCall(store, { method: "PATCH", body: { expectedVersion: 1, phone: "09177654321" } });
  await assert.rejects(
    () => supplierProfileCall(store, { method: "PATCH", body: { expectedVersion: 1, phone: "09170001111" } }),
    (error) => error.status === 409 && error.code === "supplier_profile_stale",
  );
  assert.equal(store.users[0].phone, "+639177654321");
  assert.equal(store.supplierProfiles[0].version, 2);
});

test("saving shop name also writes the account supplierName Account already reads", async () => {
  const store = fixture();
  store.users[0].supplierName = "Lovis Printshop";
  const patched = await supplierProfileCall(store, {
    method: "PATCH",
    body: { expectedVersion: 1, shopName: "Lovis Print Shop" },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.profile.shopName, "Lovis Print Shop");
  assert.equal(patched.body.profile.version, 2);
  assert.equal(store.supplierProfiles[0].shopName, "Lovis Print Shop");
  assert.equal(store.users[0].supplierName, "Lovis Print Shop");
});

test("saved shop name persists as users.supplierName", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, proofs, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, files,
    payout_milestones, order_payments, order_line_item_options, order_line_items, orders,
    supplier_catalog_prep_steps, supplier_catalog_item_photos, supplier_shop_media,
    supplier_catalog_item_file_formats, supplier_catalog_options, supplier_catalog_option_groups,
    supplier_catalog_items, supplier_service_file_formats, supplier_service_price_tiers, supplier_services,
    listing_starter_options, listing_starter_groups, listing_starters, accepted_file_formats,
    zones, taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
    taxonomy_category_aliases, taxonomy_categories, catalog_products, users,
    platform_settings RESTART IDENTITY CASCADE`);
  await seedReferenceData(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users.push({
      id: "user_lovis", clerkUserId: "clerk_lovis", email: "lovis@gridgo.test",
      name: "Lovis", role: "supplier", supplierName: "Lovis Printshop",
      verificationStatus: "pending", createdAt: AT,
    });
    store.userRoleMemberships.push({ userId: "user_lovis", role: "supplier", createdAt: AT });
    store.supplierProfiles.push({
      userId: "user_lovis", shopName: "Lovis Printshop", contactName: "Lovis",
      shop: { lat: 7.064, lng: 125.6085, label: "Davao Shop" }, pickupAvailable: false, version: 1, updatedAt: AT,
    });
    await saveStore(database, store);
  });
  await database.transaction(async () => {
    const store = await loadStore(database);
    const patched = await supplierProfileCall(store, {
      method: "PATCH",
      body: { expectedVersion: 1, shopName: "Lovis Print Shop" },
    });
    assert.equal(patched.status, 200);
    await saveStore(database, store);
  });
  const reloaded = await loadStore(database);
  assert.equal(reloaded.users.find((user) => user.id === "user_lovis").supplierName, "Lovis Print Shop");
  assert.equal(reloaded.supplierProfiles.find((profile) => profile.userId === "user_lovis").shopName, "Lovis Print Shop");
  await database.close();
});

test("email is refused because the GRIDGO sign-in owns it", async () => {
  const store = fixture();
  await assert.rejects(
    () => supplierProfileCall(store, {
      method: "PATCH",
      body: { expectedVersion: 1, email: "new@gridgo.test", contactName: "New Contact" },
    }),
    (error) => error.status === 400 && error.code === "email_not_editable",
  );
  assert.equal(store.users[0].email, "shop@gridgo.test");
  assert.equal(store.supplierProfiles[0].contactName, "Supplier");
  assert.equal(store.supplierProfiles[0].version, 1);
});

test("a mistyped phone saves nothing at all, not even the fields beside it", async () => {
  const store = fixture();
  await assert.rejects(
    () => supplierProfileCall(store, {
      method: "PATCH",
      body: { expectedVersion: 1, shopName: "Renamed Shop", phone: "0917" },
    }),
    (error) => error.status === 400 && error.code === "invalid_supplier_profile" && error.details.field === "phone",
  );
  assert.equal(store.supplierProfiles[0].shopName, "Print Shop");
  assert.equal(store.supplierProfiles[0].version, 1);
  assert.equal(store.supplierProfiles[0].updatedAt, undefined);
  assert.equal(store.users[0].phone, "+639171234567");
});

test("GET /listing-starters and public shop browse answer on the live API", { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  t.after(() => database.close());
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, proofs, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, files,
    payout_milestones, order_payments, order_line_item_options, order_line_items, orders,
    supplier_catalog_prep_steps, supplier_catalog_item_photos, supplier_shop_media,
    supplier_catalog_item_file_formats, supplier_catalog_options, supplier_catalog_option_groups,
    supplier_catalog_items,
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
