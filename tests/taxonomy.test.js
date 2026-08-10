import test from "node:test";
import assert from "node:assert/strict";

import {
  LEGACY_CATEGORY_CODES,
  backfillTaxonomy,
  buildCategoryTree,
  defaultTaxonomy,
  remapCategoryCodes,
  resolveCategoryCode,
} from "../src/taxonomy.js";

/** The captain's chart: four categories, seventeen subcategories. */
const CHART = {
  marketing_collateral: [
    "flyers",
    "brochures",
    "posters_standees",
    "business_cards",
    "stickers_packaging_labels",
    "tarpaulins_outdoor_banners",
  ],
  corporate_event_merch: ["lanyards_id_accessories", "custom_apparel", "drinkware", "corporate_giveaways"],
  recognition_awards_signage: [
    "certificates_diplomas",
    "plaques_trophies",
    "medals_ribbons",
    "business_store_signages",
  ],
  specialized_prototyping: [
    "three_d_printing_scale_models",
    "blueprint_cad_plotting",
    "packaging_box_production",
  ],
};

/** The pre-chart taxonomy exactly as shipped before this change. */
function legacyTaxonomy() {
  return {
    categories: [
      { id: "taxc_large_format", code: "large_format", name: "Large format", productFamilyIds: ["banner"], active: true },
      { id: "taxc_offset", code: "offset", name: "Offset / digital sheet", productFamilyIds: ["flyer", "card", "sticker"], active: true },
      { id: "taxc_apparel", code: "apparel_sublimation", name: "Apparel / sublimation", productFamilyIds: ["apparel"], active: true },
      { id: "taxc_signage", code: "signage", name: "Signage", productFamilyIds: ["banner", "sticker"], active: true },
    ],
    materials: [
      { id: "taxm_13oz", code: "tarpaulin_13oz", name: "13oz tarpaulin", categoryCodes: ["large_format", "signage"], active: true },
      { id: "taxm_mesh", code: "mesh_banner", name: "Mesh banner", categoryCodes: ["large_format"], active: true },
      { id: "taxm_vinyl", code: "vinyl_sticker", name: "Vinyl sticker", categoryCodes: ["offset", "signage"], active: true },
      { id: "taxm_matte150", code: "matte_150gsm", name: "Matte 150gsm", categoryCodes: ["offset"], active: true },
      { id: "taxm_gloss_card", code: "gloss_cardstock", name: "Gloss cardstock", categoryCodes: ["offset"], active: true },
      { id: "taxm_cotton", code: "cotton_tee", name: "Cotton tee", categoryCodes: ["apparel_sublimation"], active: true },
    ],
    finishes: [
      { id: "taxf_hem_grommet", code: "hem_grommet", name: "Hem + grommets", categoryCodes: ["large_format", "signage"], active: true },
      { id: "taxf_laminate", code: "lamination", name: "Lamination", categoryCodes: ["offset", "signage"], active: true },
      { id: "taxf_none", code: "none", name: "None", categoryCodes: ["large_format", "offset", "apparel_sublimation", "signage"], active: true },
      { id: "taxf_cut", code: "kiss_cut", name: "Kiss cut", categoryCodes: ["offset", "signage"], active: true },
    ],
  };
}

/** A store shaped like the captain's live demo: legacy taxonomy + real work. */
function legacyStore() {
  return {
    version: 2,
    users: [{ id: "user_supplier", email: "supplier@gridgo.local", role: "supplier" }],
    sessions: { tok_live: { userId: "user_supplier" } },
    catalog: [{ id: "prod_flyer", name: "Brochures / Flyers", family: "flyer" }],
    taxonomy: legacyTaxonomy(),
    zones: [{ id: "zone_central", code: "davao_central", deliveryFeeMinor: 15000, active: true }],
    supplierServices: [
      { id: "svc_demo_tarpaulin", supplierId: "user_supplier", categoryCode: "large_format", state: "live" },
      { id: "svc_c1ce6dcdf7b0", supplierId: "user_supplier", categoryCode: "offset", state: "withdrawn" },
    ],
    orders: [
      { id: "ord_demo_1", productId: "prod_flyer", state: "awaiting_payment", artworkFileIds: ["file_a"], artworkName: "x.pdf" },
    ],
    files: [{ fileId: "file_a", objectKey: "orders/ord_demo_1/x.pdf", state: "ready" }],
    credits: { user_client: { balanceMinor: 500000, ledger: [] } },
    claims: [],
    issues: [],
    auditLog: [{ id: "aud_1", action: "credits.grant" }],
    notifications: [{ id: "ntf_1", userId: "user_supplier" }],
    locationPings: [],
    proofs: [],
  };
}

const NON_TAXONOMY_KEYS = [
  "version",
  "users",
  "sessions",
  "catalog",
  "zones",
  "supplierServices",
  "orders",
  "files",
  "credits",
  "claims",
  "issues",
  "auditLog",
  "notifications",
  "locationPings",
  "proofs",
];

function nonTaxonomyFingerprint(store) {
  return JSON.stringify(Object.fromEntries(NON_TAXONOMY_KEYS.map((key) => [key, store[key]])));
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test("default taxonomy is the captain's four categories in chart order", () => {
  const { categories } = defaultTaxonomy();
  assert.deepEqual(
    categories.map((c) => c.code),
    Object.keys(CHART),
  );
  assert.deepEqual(
    categories.map((c) => c.sortOrder),
    [1, 2, 3, 4],
  );
  for (const category of categories) {
    assert.equal(typeof category.name, "string");
    assert.ok(category.name.length > 0, `${category.code} needs a display name`);
    assert.equal(typeof category.bestFor, "string");
    assert.ok(category.bestFor.length > 0, `${category.code} needs a "best for" line`);
    assert.equal(category.id, `taxc_${category.code}`);
    assert.equal(category.active, true);
    assert.ok(Array.isArray(category.productFamilyIds));
    assert.ok(!("subcategories" in category), "categories must not nest their children");
  }
});

test("default taxonomy is the captain's seventeen subcategories, each owned by one category", () => {
  const { categories, subcategories } = defaultTaxonomy();
  assert.equal(subcategories.length, 17);

  const categoryCodes = new Set(categories.map((c) => c.code));
  for (const subcategory of subcategories) {
    assert.equal(subcategory.id, `taxs_${subcategory.code}`);
    assert.ok(categoryCodes.has(subcategory.categoryCode), `${subcategory.code} points at a real category`);
    assert.ok(subcategory.name.length > 0);
    assert.ok(Array.isArray(subcategory.examples) && subcategory.examples.length > 0, `${subcategory.code} needs examples`);
    assert.ok(Number.isFinite(subcategory.sortOrder));
    assert.equal(subcategory.active, true);
    assert.ok(!("categoryCodes" in subcategory), "subcategories belong to exactly one category");
  }

  for (const [categoryCode, expected] of Object.entries(CHART)) {
    const own = subcategories.filter((s) => s.categoryCode === categoryCode);
    assert.deepEqual(own.map((s) => s.code), expected, categoryCode);
    assert.deepEqual(
      own.map((s) => s.sortOrder),
      expected.map((_, index) => index + 1),
      `${categoryCode} sortOrder is 1..n within its category`,
    );
  }
});

test("codes are unique across categories, subcategories and aliases", () => {
  const { categories, subcategories, categoryAliases } = defaultTaxonomy();
  const categoryCodes = categories.map((c) => c.code);
  const aliasCodes = categoryAliases.map((a) => a.code);
  const subcategoryCodes = subcategories.map((s) => s.code);
  assert.equal(new Set(categoryCodes).size, categoryCodes.length);
  assert.equal(new Set(subcategoryCodes).size, subcategoryCodes.length);
  assert.equal(new Set(aliasCodes).size, aliasCodes.length);
  for (const alias of aliasCodes) {
    assert.ok(!categoryCodes.includes(alias), `${alias} is retired, not a live category`);
  }
});

test("chart wording is carried verbatim for a category and a subcategory", () => {
  const { categories, subcategories } = defaultTaxonomy();
  const marketing = categories.find((c) => c.code === "marketing_collateral");
  assert.equal(marketing.name, "Marketing & Promotional Collateral");
  assert.equal(
    marketing.bestFor,
    "Businesses, startups, and events looking to promote services or distribute physical marketing material.",
  );
  const signages = subcategories.find((s) => s.code === "business_store_signages");
  assert.equal(signages.name, "Business & Store Signages");
  assert.deepEqual(signages.examples, ["Acrylic build-up letters", "Panaflex lightboxes", "LED neon flex"]);
});

// ---------------------------------------------------------------------------
// Derived tree (the one-request picker payload)
// ---------------------------------------------------------------------------

test("category tree nests every subcategory under its category in sort order", () => {
  const taxonomy = defaultTaxonomy();
  const tree = buildCategoryTree(taxonomy);
  assert.deepEqual(tree.map((node) => node.code), Object.keys(CHART));
  for (const node of tree) {
    assert.deepEqual(node.subcategories.map((s) => s.code), CHART[node.code]);
    assert.equal(node.bestFor, taxonomy.categories.find((c) => c.code === node.code).bestFor);
  }
  assert.equal(tree.reduce((total, node) => total + node.subcategories.length, 0), 17);
});

test("category tree is derived, not stored, and skips inactive records", () => {
  const taxonomy = defaultTaxonomy();
  taxonomy.categories.find((c) => c.code === "specialized_prototyping").active = false;
  taxonomy.subcategories.find((s) => s.code === "drinkware").active = false;

  const tree = buildCategoryTree(taxonomy);
  assert.deepEqual(tree.map((node) => node.code), [
    "marketing_collateral",
    "corporate_event_merch",
    "recognition_awards_signage",
  ]);
  const merch = tree.find((node) => node.code === "corporate_event_merch");
  assert.deepEqual(merch.subcategories.map((s) => s.code), [
    "lanyards_id_accessories",
    "custom_apparel",
    "corporate_giveaways",
  ]);
  // The store itself keeps the flat collections untouched.
  assert.equal(taxonomy.subcategories.length, 17);
  for (const category of taxonomy.categories) {
    assert.ok(!("subcategories" in category));
  }
});

test("category tree honours sortOrder rather than array position", () => {
  const taxonomy = defaultTaxonomy();
  taxonomy.categories.find((c) => c.code === "specialized_prototyping").sortOrder = 0;
  assert.equal(buildCategoryTree(taxonomy)[0].code, "specialized_prototyping");
});

// ---------------------------------------------------------------------------
// Legacy mapping
// ---------------------------------------------------------------------------

test("every legacy category code stays resolvable through an alias", () => {
  const taxonomy = defaultTaxonomy();
  const expected = {
    large_format: "marketing_collateral",
    offset: "marketing_collateral",
    apparel_sublimation: "corporate_event_merch",
    signage: "recognition_awards_signage",
  };
  assert.deepEqual([...LEGACY_CATEGORY_CODES].sort(), Object.keys(expected).sort());
  for (const [legacyCode, canonical] of Object.entries(expected)) {
    assert.equal(resolveCategoryCode(taxonomy, legacyCode).code, canonical, legacyCode);
  }
  for (const category of taxonomy.categories) {
    assert.equal(resolveCategoryCode(taxonomy, category.code).code, category.code);
  }
  assert.equal(resolveCategoryCode(taxonomy, "not_a_code"), null);
  assert.equal(resolveCategoryCode(taxonomy, null), null);
});

test("ambiguous legacy codes are flagged as ambiguous with a note, not silently guessed", () => {
  const { categoryAliases } = defaultTaxonomy();
  const ambiguous = categoryAliases.filter((a) => a.ambiguous).map((a) => a.code);
  assert.deepEqual(ambiguous, ["large_format", "offset"]);
  for (const alias of categoryAliases) {
    assert.ok(alias.note.length > 0, `${alias.code} needs a mapping note`);
    assert.equal(alias.active, true);
  }
});

test("mapping the legacy materials and finishes reproduces the shipped defaults exactly", () => {
  const legacy = legacyTaxonomy();
  const expected = defaultTaxonomy();
  for (const kind of ["materials", "finishes"]) {
    const mapped = legacy[kind].map((record) => ({ ...record, categoryCodes: remapCategoryCodes(kind, record) }));
    assert.deepEqual(mapped, expected[kind], kind);
  }
});

test("mapping keeps a record that spanned two legacy codes in both chart categories", () => {
  assert.deepEqual(
    remapCategoryCodes("materials", { code: "tarpaulin_13oz", categoryCodes: ["large_format", "signage"] }),
    ["marketing_collateral", "recognition_awards_signage"],
  );
  // ...without over-broadening one that only listed large_format.
  assert.deepEqual(remapCategoryCodes("materials", { code: "mesh_banner", categoryCodes: ["large_format"] }), [
    "marketing_collateral",
  ]);
});

test("the `none` finish reaches specialized_prototyping, which has no legacy equivalent", () => {
  assert.deepEqual(
    remapCategoryCodes("finishes", {
      code: "none",
      categoryCodes: ["large_format", "offset", "apparel_sublimation", "signage"],
    }),
    ["marketing_collateral", "corporate_event_merch", "recognition_awards_signage", "specialized_prototyping"],
  );
});

test("mapping leaves already-canonical and ops-invented codes alone", () => {
  const record = { code: "matte_150gsm", categoryCodes: ["marketing_collateral", "ops_invented"] };
  assert.equal(remapCategoryCodes("materials", record), record.categoryCodes, "no legacy code means no rewrite");
  assert.deepEqual(
    remapCategoryCodes("materials", { code: "x", categoryCodes: ["offset", "ops_invented"] }),
    ["marketing_collateral", "ops_invented"],
  );
  assert.deepEqual(
    remapCategoryCodes("materials", { code: "x", categoryCodes: ["offset", "marketing_collateral"] }),
    ["marketing_collateral"],
    "duplicates collapse",
  );
});

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

test("backfill migrates a legacy store onto the chart taxonomy", () => {
  const store = legacyStore();
  assert.equal(backfillTaxonomy(store), true);

  assert.deepEqual(store.taxonomy.categories.map((c) => c.code), Object.keys(CHART));
  assert.equal(store.taxonomy.subcategories.length, 17);
  assert.deepEqual(store.taxonomy.categoryAliases.map((a) => a.code), LEGACY_CATEGORY_CODES);
  for (const kind of ["materials", "finishes"]) {
    for (const record of store.taxonomy[kind]) {
      for (const code of record.categoryCodes) {
        assert.ok(
          !LEGACY_CATEGORY_CODES.includes(code),
          `${kind}/${record.code} still points at legacy code ${code}`,
        );
      }
    }
  }
});

test("a migrated store's taxonomy is identical to a freshly seeded one", () => {
  const store = legacyStore();
  backfillTaxonomy(store);
  assert.deepEqual(store.taxonomy, defaultTaxonomy());
});

test("backfill is idempotent: the second run changes nothing", () => {
  const store = legacyStore();
  assert.equal(backfillTaxonomy(store), true);
  const afterFirst = JSON.stringify(store);

  assert.equal(backfillTaxonomy(store), false, "second run must report no change");
  assert.equal(JSON.stringify(store), afterFirst, "second run must not mutate the store");

  assert.equal(backfillTaxonomy(store), false);
  assert.equal(JSON.stringify(store), afterFirst);
});

test("backfill on an already-seeded store is a no-op", () => {
  const store = { taxonomy: defaultTaxonomy() };
  assert.equal(backfillTaxonomy(store), false);
});

test("backfill never touches a non-taxonomy collection", () => {
  const store = legacyStore();
  const before = nonTaxonomyFingerprint(store);
  backfillTaxonomy(store);
  backfillTaxonomy(store);
  assert.equal(nonTaxonomyFingerprint(store), before);
});

test("supplier services keep their stored legacy code and stay resolvable", () => {
  const store = legacyStore();
  backfillTaxonomy(store);
  const service = store.supplierServices.find((s) => s.id === "svc_demo_tarpaulin");
  assert.equal(service.categoryCode, "large_format", "captain-owned service records are never rewritten");
  assert.equal(resolveCategoryCode(store.taxonomy, service.categoryCode).code, "marketing_collateral");
  for (const stored of store.supplierServices) {
    assert.ok(resolveCategoryCode(store.taxonomy, stored.categoryCode), `${stored.id} is not an orphan`);
  }
});

test("backfill fills what is missing but never overwrites an ops edit", () => {
  const store = legacyStore();
  backfillTaxonomy(store);
  const marketing = store.taxonomy.categories.find((c) => c.code === "marketing_collateral");
  marketing.bestFor = "Ops rewrote this line";
  marketing.active = false;
  const flyers = store.taxonomy.subcategories.find((s) => s.code === "flyers");
  flyers.examples = ["Only this"];
  delete flyers.sortOrder;

  assert.equal(backfillTaxonomy(store), true, "the deleted sortOrder is refilled");
  assert.equal(marketing.bestFor, "Ops rewrote this line");
  assert.equal(marketing.active, false);
  assert.deepEqual(flyers.examples, ["Only this"]);
  assert.equal(flyers.sortOrder, 1);
  assert.equal(backfillTaxonomy(store), false);
});

test("backfill leaves ops-created categories and subcategories alone", () => {
  const store = legacyStore();
  store.taxonomy.categories.push({ id: "taxc_ops", code: "ops_special", name: "Ops special", active: true });
  store.taxonomy.subcategories = [{ id: "taxs_ops", code: "ops_sub", name: "Ops sub", categoryCode: "ops_special", examples: [], sortOrder: 1, active: true }];

  backfillTaxonomy(store);
  assert.ok(store.taxonomy.categories.some((c) => c.code === "ops_special"));
  assert.equal(store.taxonomy.subcategories.length, 18);
  assert.equal(backfillTaxonomy(store), false);
});

test("backfill builds the whole taxonomy when the store has none", () => {
  const store = {};
  assert.equal(backfillTaxonomy(store), true);
  assert.deepEqual(store.taxonomy, defaultTaxonomy());
  assert.equal(backfillTaxonomy(store), false);
});
