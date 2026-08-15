import test from "node:test";
import assert from "node:assert/strict";

import {
  LEGACY_CATEGORY_CODES,
  buildCategoryTree,
  defaultTaxonomy,
  resolveCategoryCode,
} from "../src/taxonomy.js";

test("platform taxonomy is the flat four-category, seventeen-subcategory contract", () => {
  const taxonomy = defaultTaxonomy();
  assert.equal(taxonomy.categories.length, 4);
  assert.equal(taxonomy.subcategories.length, 17);
  assert.deepEqual(taxonomy.categoryAliases.map((item) => item.code), LEGACY_CATEGORY_CODES);

  const codes = new Set(taxonomy.categories.map((item) => item.code));
  for (const item of taxonomy.subcategories) assert.ok(codes.has(item.categoryCode), item.code);
  for (const collection of [taxonomy.materials, taxonomy.finishes]) {
    for (const item of collection) {
      assert.ok(item.categoryCodes.length > 0, item.code);
      for (const code of item.categoryCodes) assert.ok(codes.has(code), `${item.code} references missing category ${code}`);
    }
  }
});

test("retired input aliases resolve without rewriting stored supplier services", () => {
  const taxonomy = defaultTaxonomy();
  const expected = {
    large_format: "marketing_collateral",
    offset: "marketing_collateral",
    apparel_sublimation: "corporate_event_merch",
    signage: "recognition_awards_signage",
  };
  for (const [alias, canonical] of Object.entries(expected)) {
    assert.equal(resolveCategoryCode(taxonomy, alias)?.code, canonical);
  }
  assert.equal(resolveCategoryCode(taxonomy, "missing"), null);
});

test("categoryTree is derived, sorted, and does not mutate flat taxonomy", () => {
  const taxonomy = defaultTaxonomy();
  const before = structuredClone(taxonomy);
  const tree = buildCategoryTree(taxonomy);
  assert.equal(tree.length, 4);
  assert.equal(tree.reduce((count, item) => count + item.subcategories.length, 0), 17);
  assert.deepEqual(taxonomy, before);
  assert.equal(Object.hasOwn(taxonomy.categories[0], "subcategories"), false);
});
