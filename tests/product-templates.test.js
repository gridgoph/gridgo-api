import test from "node:test";
import assert from "node:assert/strict";
import { fixture, actors, id, audit, AT } from "./fixtures/reschedule.js";
import { defaultAcceptedFileFormats } from "../src/reference-data.js";
import { defaultProductTemplates } from "../src/product-template-data.js";
import {
  routeProductTemplates,
  convertPriceTable,
  migrationPlan,
} from "../src/product-templates.js";
import { routeSupplierCatalog } from "../src/catalog-routes.js";
import {
  createOrderLineSnapshot,
  selectedCatalogPrice,
  publicCatalogItem,
} from "../src/supplier-catalog.js";

function setup() {
  const s = fixture();
  s.productTemplates = defaultProductTemplates();
  s.productSetupRequests = [];
  s.acceptedFileFormats = defaultAcceptedFileFormats();
  return s;
}
const call = (s, actor, method, path, body = {}) =>
  routeProductTemplates({
    store: s,
    user: actors[actor] || actor,
    req: { method, headers: {} },
    url: new URL(path, "http://api.test"),
    readBody: async () => body,
    id,
    now: () => AT,
    audit,
  });
const product = (s) => ({
  templateId: s.productTemplates.find((t) => t.subcategoryCode === "flyers").id,
  supplierServiceId: "service_supplier",
  readyTime: "next_day",
  prices: [{ optionKey: "standard", priceMinor: 1200 }],
});
const approve = (s, item) =>
  routeSupplierCatalog({
    store: s,
    user: actors.ops,
    req: { method: "POST", headers: {} },
    url: new URL(`/ops/catalog-reviews/${item.id}/decision`, "http://api.test"),
    readBody: async () => ({
      expectedVersion: item.version,
      status: "approved",
    }),
    id,
    now: () => AT,
    audit,
  });

test("full option prices become one base and exact modifiers, never zero or empty", () => {
  const t = {
    options: [
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ],
  };
  assert.deepEqual(
    convertPriceTable(t, [
      { optionKey: "a", priceMinor: 150 },
      { optionKey: "b", priceMinor: 399 },
    ]),
    {
      basePriceMinor: 150,
      rows: [
        { optionKey: "a", label: "A", priceMinor: 150, priceModifierMinor: 0 },
        {
          optionKey: "b",
          label: "B",
          priceMinor: 399,
          priceModifierMinor: 249,
        },
      ],
    },
  );
  for (const value of [
    0,
    "",
    null,
    undefined,
    -1,
    1.1,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(
      () => convertPriceTable(t, [{ optionKey: "a", priceMinor: value }]),
      { code: "template_price_required" },
    );
  assert.throws(() => convertPriceTable(t, []));
  assert.throws(() =>
    convertPriceTable(t, [
      { optionKey: "a", priceMinor: 1 },
      { optionKey: "a", priceMinor: 2 },
    ]),
  );
});
test("first catalogue has eight groups, positive configured ranges, stock photos and A3", () => {
  const ts = defaultProductTemplates();
  assert.ok(ts.length >= 24 && ts.length <= 27);
  assert.equal(new Set(ts.map((t) => t.group)).size, 8);
  for (const t of ts) {
    assert.ok(t.stockPhotos.length);
    assert.ok(t.options.length);
    assert.ok(t.priceRange.minMinor > 0);
  }
  assert.ok(ts.some((t) => t.options.some((o) => o.label.includes("A3"))));
});
test("template product needs price review only, goes live on approval, flags unusual prices", async () => {
  const s = setup();
  const result = await call(
    s,
    "supplier",
    "POST",
    "/me/template-products",
    product(s),
  );
  const item = s.catalogItems.find((i) => i.id === result.body.item.id);
  assert.equal(item.reviewStatus, "pending");
  assert.equal(publicCatalogItem(s, item), null);
  assert.equal(result.body.item.template.priceCheck.required, true);
  await approve(s, item);
  assert.ok(publicCatalogItem(s, item));
  assert.ok(
    s.notifications.some(
      (n) => n.userId === "supplier" && n.type === "template_product_live",
    ),
  );
  const other = setup();
  const b = product(other);
  b.prices[0].priceMinor = 99999999;
  const high = await call(
    other,
    "supplier",
    "POST",
    "/me/template-products",
    b,
  );
  assert.equal(
    high.body.item.template.priceCheck.flags[0].code,
    "outside_usual_range",
  );
});
test("approved price remains current until new price check, accepted order snapshot never changes", async () => {
  const s = setup();
  const res = await call(
    s,
    "supplier",
    "POST",
    "/me/template-products",
    product(s),
  );
  let item = s.catalogItems.find((i) => i.id === res.body.item.id);
  await approve(s, item);
  const opt = s.catalogOptions.find((o) =>
    s.catalogOptionGroups.some(
      (g) => g.id === o.optionGroupId && g.catalogItemId === item.id,
    ),
  );
  const saved = createOrderLineSnapshot(
    s,
    {
      orderId: "order",
      catalogItemId: item.id,
      optionIds: [opt.id],
      expectedVersion: item.version,
      expectedServiceVersion: 1,
      quantity: 2,
      createdAt: AT,
    },
    id,
  );
  await call(s, "supplier", "PUT", `/me/template-products/${item.id}`, {
    ...product(s),
    expectedVersion: item.version,
    prices: [{ optionKey: "standard", priceMinor: 2000 }],
  });
  assert.equal(
    selectedCatalogPrice(s, item, [opt.id]).effectiveUnitPriceMinor,
    1200,
  );
  await approve(s, item);
  const next = s.catalogOptions.find((o) =>
    s.catalogOptionGroups.some(
      (g) => g.id === o.optionGroupId && g.catalogItemId === item.id,
    ),
  );
  assert.equal(
    selectedCatalogPrice(s, item, [next.id]).effectiveUnitPriceMinor,
    2000,
  );
  assert.equal(saved.lineItem.effectiveUnitPriceMinor, 1200);
});
test("admin-assisted products cannot pass price check before versioned shop confirmation", async () => {
  const s = setup();
  const res = await call(
    s,
    "ops",
    "POST",
    "/ops/shops/supplier/template-products",
    product(s),
  );
  const item = s.catalogItems.find((i) => i.id === res.body.item.id);
  await assert.rejects(approve(s, item), {
    code: "shop_confirmation_required",
  });
  await assert.rejects(
    call(s, "supplier", "POST", `/me/template-products/${item.id}/confirm`, {
      expectedVersion: 999,
    }),
    { code: "catalog_item_stale" },
  );
  await call(
    s,
    "supplier",
    "POST",
    `/me/template-products/${item.id}/confirm`,
    { expectedVersion: item.version },
  );
  await approve(s, item);
  assert.ok(publicCatalogItem(s, item));
});
test("dry run and apply refuse every operation on open-order listings and preserve originals", async () => {
  const s = setup();
  const before = structuredClone(s.catalogItems[0]);
  const plan = migrationPlan(s, "supplier");
  assert.ok(
    plan.manual.some(
      (r) => r.itemId === before.id && r.reason === "open_orders",
    ),
  );
  await call(s, "ops", "POST", "/ops/shops/supplier/template-migration", {
    dryRun: false,
    expectedVersions: { [before.id]: before.version },
  });
  assert.deepEqual(s.catalogItems[0], before);
});
test("migration hides zero prices, matches template and merges duplicate variants without deleting history", async () => {
  const s = setup();
  s.orders = [];
  s.orderJobs = [];
  s.orderLineItems = [];
  const a = s.catalogItems[0];
  a.name = "Flyers";
  const b = structuredClone(a);
  b.id = "duplicate";
  b.name = "Flyers";
  b.sortOrder = 2;
  s.catalogItems.push(b);
  const zero = structuredClone(a);
  zero.id = "zero";
  zero.basePriceMinor = 0;
  zero.sortOrder = 3;
  s.catalogItems.push(zero);
  const plan = migrationPlan(s, "supplier");
  assert.ok(plan.actions.length);
  const before = structuredClone(s.catalogItems);
  await call(s, "ops", "POST", "/ops/shops/supplier/template-migration", {});
  assert.deepEqual(s.catalogItems, before);
  await call(s, "ops", "POST", "/ops/shops/supplier/template-migration", {
    dryRun: false,
    expectedVersions: Object.fromEntries(
      s.catalogItems.map((i) => [i.id, i.version]),
    ),
  });
  assert.equal(s.catalogItems.find((i) => i.id === "zero").active, false);
  assert.equal(s.catalogItems.find((i) => i.id === "duplicate").active, false);
  assert.equal(s.catalogItems.length, before.length);
  assert.ok(s.catalogItems[0].templateData.templateId);
  assert.equal(
    selectedCatalogPrice(s, s.catalogItems[0], []).effectiveUnitPriceMinor,
    1000,
  );
});
test("template and setup request paths enforce roles, owner privacy and ready evidence", async () => {
  const s = setup();
  await assert.rejects(call(s, "client", "GET", "/me/product-templates"), {
    code: "forbidden",
  });
  const r = await call(s, "supplier", "POST", "/me/product-setup-requests", {
    kind: "setup",
    message: "Please use this price list.",
  });
  assert.equal(r.body.request.status, "pending");
  const other = await call(
    s,
    "replacement",
    "GET",
    "/me/product-setup-requests",
  );
  assert.equal(other.body.requests.length, 0);
  await assert.rejects(
    call(s, "supplier", "POST", "/me/product-setup-requests", {
      kind: "setup",
      fileIds: ["missing"],
    }),
    { code: "invalid_setup_file" },
  );
});

test("template options include complete combinations rather than a partial specification", () => {
  const ts = defaultProductTemplates();
  const flyer = ts.find((t) => t.subcategoryCode === "flyers");
  assert.equal(flyer.options.length, 8);
  assert.ok(
    flyer.options.every(
      (o) => o.label.includes("/") && o.specBinding?.fieldCode === "size",
    ),
  );
  const apparel = ts.find((t) => t.id === "tpl_custom_apparel");
  assert.equal(apparel.options.length, 180);
});
test("admin can edit the recommended templates with governed bindings", async () => {
  const s = setup(),
    t = s.productTemplates.find((t) => t.subcategoryCode === "flyers");
  const edited = await call(s, "ops", "PUT", `/ops/product-templates/${t.id}`, {
    expectedVersion: t.version,
    template: { ...t, name: "Flyer printing" },
  });
  assert.equal(edited.body.template.version, 2);
  assert.equal(edited.body.template.name, "Flyer printing");
});

test("explicit legacy variant merge preserves each full price and refuses an entire group with any open order", async () => {
  const s = setup();
  s.orders = [];
  s.orderJobs = [];
  s.orderLineItems = [];
  const a = s.catalogItems[0];
  a.name = "A4 flyer";
  const b = {
    ...structuredClone(a),
    id: "large",
    name: "A3 flyer",
    basePriceMinor: 2200,
    sortOrder: 2,
  };
  s.catalogItems.push(b);
  const body = {
    mergeGroups: [{ keepId: a.id, sourceIds: [b.id] }],
    expectedVersions: { [a.id]: a.version, [b.id]: b.version },
    dryRun: false,
  };
  const result = await call(
    s,
    "ops",
    "POST",
    "/ops/shops/supplier/template-migration",
    body,
  );
  assert.ok(result.body.actions.some((a) => a.action === "merge_variants"));
  const g = s.catalogOptionGroups.find((g) => g.catalogItemId === a.id);
  const opts = s.catalogOptions.filter((o) => o.optionGroupId === g.id);
  assert.deepEqual(
    opts.map((o) => selectedCatalogPrice(s, a, [o.id]).effectiveUnitPriceMinor),
    [1000, 2200],
  );
  assert.equal(b.active, false);
  const guarded = setup();
  const source = guarded.catalogItems[0];
  guarded.catalogItems.push({ ...source, id: "guarded", sortOrder: 2 });
  const original = structuredClone(guarded.catalogItems);
  const blocked = await call(
    guarded,
    "ops",
    "POST",
    "/ops/shops/supplier/template-migration",
    {
      ...body,
      mergeGroups: [{ keepId: "guarded", sourceIds: [source.id] }],
      expectedVersions: { guarded: 1, [source.id]: 1 },
    },
  );
  assert.ok(
    blocked.body.manual.some((r) => r.reason === "merge_has_open_orders"),
  );
  assert.deepEqual(guarded.catalogItems, original);
});

test("existing editing endpoints cannot publish unconfirmed or zero-priced template products", async () => {
  const s = setup();
  const res = await call(
    s,
    "ops",
    "POST",
    "/ops/shops/supplier/template-products",
    product(s),
  );
  const item = s.catalogItems.find((i) => i.id === res.body.item.id);
  const legacy = (body) =>
    routeSupplierCatalog({
      store: s,
      user: actors.supplier,
      req: { method: "PATCH", headers: {} },
      url: new URL(`/me/catalog-items/${item.id}`, "http://api.test"),
      readBody: async () => ({ expectedVersion: item.version, ...body }),
      id,
      now: () => AT,
      audit,
    });
  await assert.rejects(legacy({ active: true }), {
    code: "shop_confirmation_required",
  });
  item.active = false;
  await assert.rejects(legacy({ basePriceMinor: 0 }), {
    code: "template_price_required",
  });
});

test("stock photos seed only governed reference bytes into MinIO and sign on every catalogue surface", async () => {
  const { seedProductTemplatePhotos, templatePhotoKey } = await import(
    "../src/product-template-media.js"
  );
  const { decorateCatalogPhotoUrls } = await import(
    "../src/catalog-photo-urls.js"
  );
  const written = [];
  await seedProductTemplatePhotos({
    ensureBucket: async () => {},
    statObject: async () => {
      throw Object.assign(new Error(), { code: "storage_object_missing" });
    },
    putObject: async (row) => written.push(row),
  });
  assert.ok(written.length >= 21);
  assert.ok(
    written.every(
      (r) =>
        r.key.startsWith("reference/product-templates/") &&
        r.body.length > 100 &&
        r.contentType === "image/jpeg",
    ),
  );
  assert.equal(templatePhotoKey("/product-template-photos/../../.env"), null);
  const stock = defaultProductTemplates()[0].stockPhotos;
  const body = {
    templates: [{ stockPhotos: structuredClone(stock) }],
    listings: [{ photos: structuredClone(stock) }],
  };
  await decorateCatalogPhotoUrls({}, body, {
    findFile: () => null,
    presignGet: async (key) => ({
      url: "https://storage.test/" + key,
      expiresAt: AT,
    }),
  });
  assert.match(
    body.templates[0].stockPhotos[0].downloadUrl,
    /https:\/\/storage.test/,
  );
  assert.equal(
    body.templates[0].stockPhotos[0].downloadUrl,
    body.listings[0].photos[0].downloadUrl,
  );
});

test("legacy merge never conflates minimum measurements, machine width, option activity or rush durations", () => {
  const s = setup();
  s.orders = [];
  s.orderJobs = [];
  s.orderLineItems = [];
  const a = s.catalogItems[0];
  for (const [field, value] of [
    ["minimumLengthMilli", 123],
    ["printerMaxWidthFeet", 12],
    ["minimumTurnaroundMinutes", 120],
  ]) {
    const copy = { ...a, id: "distinct", sortOrder: 3, [field]: value };
    s.catalogItems = [a, copy];
    assert.ok(
      migrationPlan(s, "supplier").actions.every(
        (action) => action.action !== "merge_duplicate",
      ),
      field,
    );
  }
});
test("template references produce a reviewable taxonomy deletion refusal", async () => {
  const { taxonomyEntryUsage, usageBlocksDelete } = await import(
    "../src/taxonomy-delete.js"
  );
  const s = setup();
  const usage = taxonomyEntryUsage(s, "subcategories", { code: "flyers" });
  assert.equal(usage.productTemplates, 1);
  assert.equal(usageBlocksDelete(usage), true);
});

test("the final screen previews ready time and client-visible product without saving or notifying", async () => {
  const s = setup(),
    before = structuredClone(s);
  const preview = await call(
    s,
    "supplier",
    "POST",
    "/me/template-products/preview",
    product(s),
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.mutated, undefined);
  assert.ok(preview.body.scheduling);
  assert.equal(preview.body.item.basePriceMinor, 1200);
  assert.deepEqual(s, before);
});

test("a zero base with a positive required option remains priced during migration", () => {
  const s = setup();
  s.orders = [];
  s.orderJobs = [];
  s.orderLineItems = [];
  const item = s.catalogItems[0];
  item.basePriceMinor = 0;
  s.catalogOptionGroups.push({
    id: "priced",
    catalogItemId: item.id,
    name: "Size",
    kind: "spec",
    required: true,
    sortOrder: 0,
  });
  s.catalogOptions.push({
    id: "paid",
    optionGroupId: "priced",
    label: "A4",
    priceModifierMinor: 1200,
    active: true,
    sortOrder: 0,
  });
  const plan = migrationPlan(s, "supplier");
  assert.ok(
    plan.actions.some((a) => a.itemId === item.id && a.action === "match"),
  );
  assert.ok(
    !plan.actions.some(
      (a) => a.itemId === item.id && a.action === "hide_unpriced",
    ),
  );
});

test("legacy variant merges with bulk or rush overrides require manual configuration", () => {
  const s = setup();
  s.orders = [];
  s.orderJobs = [];
  s.orderLineItems = [];
  const a = s.catalogItems[0];
  a.name = "A4";
  const b = { ...a, id: "a3", name: "A3", sortOrder: 3, basePriceMinor: 2000 };
  s.catalogItems.push(b);
  s.catalogPriceTiers.push(
    ...[a, b].map((i) => ({
      id: "bulk_" + i.id,
      catalogItemId: i.id,
      minQuantity: 100,
      unitPriceMinor: 500,
    })),
  );
  const plan = migrationPlan(s, "supplier", {
    mergeGroups: [{ keepId: a.id, sourceIds: [b.id] }],
  });
  assert.equal(plan.actions.length, 0);
  assert.ok(
    plan.manual.every(
      (r) => r.reason === "merge_requires_manual_configuration",
    ),
  );
});
test("legacy colour-tier products cannot silently ignore a replacement full price table", async () => {
  const s = setup(),
    a = s.catalogItems[0];
  a.templateData = { templateId: "tpl_flyers", shopConfirmed: true };
  a.pricedByColour = true;
  await assert.rejects(
    call(s, "supplier", "PUT", `/me/template-products/${a.id}`, {
      ...product(s),
      expectedVersion: a.version,
    }),
    { code: "template_manual_conversion_required" },
  );
});
