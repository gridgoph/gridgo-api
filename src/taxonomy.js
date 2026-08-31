/**
 * Platform product-category taxonomy.
 *
 * Source of truth for the *content* is the captain's "Product Category Mapping &
 * Chart": five categories, twenty-two subcategories, one "best for" audience line
 * per category and one examples line per subcategory.
 *
 * Model rule (one way to express one relationship):
 *   Every reference to a category is the category's `code`, held on the
 *   *referring* record. Categories never list their children.
 *     - subcategory.categoryCode   -> exactly one category
 *     - material.categoryCodes[]   -> zero or more categories (unchanged shape)
 *     - finish.categoryCodes[]     -> zero or more categories (unchanged shape)
 *     - categoryAlias.categoryCode -> the category a retired legacy code now means
 *   Nothing is nested in the store. The nested `categoryTree` that `GET /taxonomy`
 *   returns is derived at response time by buildCategoryTree() and never persisted.
 *
 * Legacy codes (`large_format`, `offset`, `apparel_sublimation`, `signage`) came
 * from a production-capability taxonomy that cross-cuts the captain's chart. They
 * are retired out of `categories` into `categoryAliases` so existing supplier
 * services keep resolving; stored `supplierServices[].categoryCode` is never
 * rewritten. See docs/TAXONOMY_API.md.
 */

const CATEGORIES = [
  {
    id: "taxc_marketing_collateral",
    code: "marketing_collateral",
    name: "Marketing & Promotional Collateral",
    bestFor:
      "Businesses, startups, and events looking to promote services or distribute physical marketing material.",
    sortOrder: 1,
    productFamilyIds: ["flyer", "card", "sticker", "banner"],
    active: true,
  },
  {
    id: "taxc_corporate_event_merch",
    code: "corporate_event_merch",
    name: "Corporate & Event Merchandise",
    bestFor: "Student orgs, HR teams, event organizers, and corporate branding.",
    sortOrder: 2,
    productFamilyIds: ["apparel"],
    active: true,
  },
  {
    id: "taxc_recognition_awards_signage",
    code: "recognition_awards_signage",
    name: "Recognition, Awards & Signage",
    bestFor: "Competitions, graduations, guest speakers, store branding, and office spaces.",
    sortOrder: 3,
    productFamilyIds: ["banner", "sticker"],
    active: true,
  },
  {
    id: "taxc_specialized_prototyping",
    code: "specialized_prototyping",
    name: "Specialized & Prototyping Services",
    bestFor: "Architecture students, engineers, industrial designers, and specialized builds.",
    sortOrder: 4,
    productFamilyIds: [],
    active: true,
  },
  {
    // The everyday work the first four categories had no home for. A student
    // printing a thesis, a teacher running a hundred handouts and an applicant
    // who needs ID photographs are not doing marketing, merchandise, awards or
    // prototyping, and Lovis's whole document board -- the largest single price
    // list in the master catalogue -- had nowhere to sit.
    id: "taxc_document_publication",
    code: "document_publication",
    name: "Documents & Publications",
    bestFor: "Students, teachers, offices, and anyone with paperwork to print, bind, or copy.",
    sortOrder: 5,
    productFamilyIds: [],
    active: true,
  },
];

const SUBCATEGORIES = [
  // 1. Marketing & Promotional Collateral
  {
    id: "taxs_flyers",
    code: "flyers",
    name: "Flyers",
    categoryCode: "marketing_collateral",
    examples: ["Single sheets", "Event promos", "Product announcements"],
    sortOrder: 1,
    active: true,
  },
  {
    id: "taxs_brochures",
    code: "brochures",
    name: "Brochures",
    categoryCode: "marketing_collateral",
    examples: ["Bi-fold", "Tri-fold", "Company profiles"],
    sortOrder: 2,
    active: true,
  },
  {
    id: "taxs_posters_standees",
    code: "posters_standees",
    name: "Posters & Standees",
    categoryCode: "marketing_collateral",
    examples: ["Indoor event posters", "Pull-up banners", "X-stands"],
    sortOrder: 3,
    active: true,
  },
  {
    id: "taxs_business_cards",
    code: "business_cards",
    name: "Business Cards",
    categoryCode: "marketing_collateral",
    examples: ["Standard", "Matte", "Glossy", "Textured", "QR-code enabled"],
    sortOrder: 4,
    active: true,
  },
  {
    id: "taxs_stickers_packaging_labels",
    code: "stickers_packaging_labels",
    name: "Stickers & Packaging Labels",
    categoryCode: "marketing_collateral",
    examples: ["Die-cut product labels", "Vinyl stickers", "Sheet stickers"],
    sortOrder: 5,
    active: true,
  },
  {
    id: "taxs_tarpaulins_outdoor_banners",
    code: "tarpaulins_outdoor_banners",
    name: "Tarpaulins & Outdoor Banners",
    categoryCode: "marketing_collateral",
    examples: ["Event banners", "Billboards", "Temporary roadside signs"],
    sortOrder: 6,
    active: true,
  },

  // 2. Corporate & Event Merchandise
  {
    id: "taxs_lanyards_id_accessories",
    code: "lanyards_id_accessories",
    name: "Lanyards & ID Accessories",
    categoryCode: "corporate_event_merch",
    examples: ["Sublimation lanyards", "Custom ID laces", "Badge holders"],
    sortOrder: 1,
    active: true,
  },
  {
    id: "taxs_custom_apparel",
    code: "custom_apparel",
    name: "Custom Apparel",
    categoryCode: "corporate_event_merch",
    examples: ["T-shirts", "Hoodies", "Polo shirts", "Tote bags"],
    sortOrder: 2,
    active: true,
  },
  {
    id: "taxs_drinkware",
    code: "drinkware",
    name: "Drinkware",
    categoryCode: "corporate_event_merch",
    examples: ["Sublimation mugs", "Laser-engraved tumblers", "Water bottles"],
    sortOrder: 3,
    active: true,
  },
  {
    id: "taxs_corporate_giveaways",
    code: "corporate_giveaways",
    name: "Corporate Giveaways",
    categoryCode: "corporate_event_merch",
    examples: ["Eco-bags", "Umbrellas", "Customized pens", "Keychains", "Notebooks"],
    sortOrder: 4,
    active: true,
  },

  // 3. Recognition, Awards & Signage
  {
    id: "taxs_certificates_diplomas",
    code: "certificates_diplomas",
    name: "Certificates & Diplomas",
    categoryCode: "recognition_awards_signage",
    examples: ["Specialty paper", "Foil-stamped", "Embossed"],
    sortOrder: 1,
    active: true,
  },
  {
    id: "taxs_plaques_trophies",
    code: "plaques_trophies",
    name: "Plaques & Trophies",
    categoryCode: "recognition_awards_signage",
    examples: ["Custom acrylic cut", "Wooden plaques", "3D-printed awards"],
    sortOrder: 2,
    active: true,
  },
  {
    id: "taxs_medals_ribbons",
    code: "medals_ribbons",
    name: "Medals & Ribbons",
    categoryCode: "recognition_awards_signage",
    examples: ["Metal/acrylic medals with custom sublimation ribbons"],
    sortOrder: 3,
    active: true,
  },
  {
    id: "taxs_business_store_signages",
    code: "business_store_signages",
    name: "Business & Store Signages",
    categoryCode: "recognition_awards_signage",
    examples: ["Acrylic build-up letters", "Panaflex lightboxes", "LED neon flex"],
    sortOrder: 4,
    active: true,
  },

  // 4. Specialized & Prototyping Services
  {
    id: "taxs_three_d_printing_scale_models",
    code: "three_d_printing_scale_models",
    name: "3D Printing & Scale Models",
    categoryCode: "specialized_prototyping",
    examples: ["Rapid prototyping", "Architectural scale models", "Custom parts"],
    sortOrder: 1,
    active: true,
  },
  {
    id: "taxs_blueprint_cad_plotting",
    code: "blueprint_cad_plotting",
    name: "Blueprint & CAD Plotting",
    categoryCode: "specialized_prototyping",
    examples: ["Large-format architectural/engineering plans"],
    sortOrder: 2,
    active: true,
  },
  {
    id: "taxs_packaging_box_production",
    code: "packaging_box_production",
    name: "Packaging & Box Production",
    categoryCode: "specialized_prototyping",
    examples: ["Custom product boxes", "Mailer boxes", "Food-grade packaging"],
    sortOrder: 3,
    active: true,
  },

  // 5. Documents & Publications
  {
    id: "taxs_document_printing",
    code: "document_printing",
    name: "Document printing",
    categoryCode: "document_publication",
    examples: ["Black and white or colour", "Short, A4 and long", "Back-to-back"],
    sortOrder: 1,
    active: true,
  },
  {
    id: "taxs_booklets",
    code: "booklets",
    name: "Booklets",
    categoryCode: "document_publication",
    examples: ["Bifold and trifold", "Programmes", "Handouts"],
    sortOrder: 2,
    active: true,
  },
  {
    id: "taxs_risograph",
    code: "risograph",
    name: "Risograph printing",
    categoryCode: "document_publication",
    examples: ["High-volume handouts", "Exam papers", "Reviewers by the ream"],
    sortOrder: 3,
    active: true,
  },
  {
    id: "taxs_binding_hardbound",
    code: "binding_hardbound",
    name: "Binding & hardbound",
    categoryCode: "document_publication",
    examples: ["Thesis hardbound", "Ring and softcover binding", "Gold or silver spine"],
    sortOrder: 4,
    active: true,
  },
  {
    id: "taxs_id_photos",
    code: "id_photos",
    name: "ID photos",
    categoryCode: "document_publication",
    examples: ["1x1, 2x2 and passport", "Wallet and family size", "Photo paper or PVC"],
    sortOrder: 5,
    active: true,
  },
];

/**
 * Retired pre-chart category codes. They stay resolvable so nothing that already
 * references them becomes an orphan. `ambiguous: true` means the legacy code spans
 * more than one chart category and `categoryCode` is only its dominant home — such
 * a code is deliberately *not* auto-rewritten anywhere it is stored.
 */
const CATEGORY_ALIASES = [
  {
    code: "large_format",
    name: "Large format",
    categoryCode: "marketing_collateral",
    ambiguous: true,
    note:
      "Pre-chart production-capability code. Work under it now spans marketing_collateral (tarpaulins & outdoor banners, posters & standees), recognition_awards_signage (business & store signages) and specialized_prototyping (blueprint & CAD plotting). marketing_collateral is the dominant home; the alias is kept so stored references still resolve.",
    active: true,
  },
  {
    code: "offset",
    name: "Offset / digital sheet",
    categoryCode: "marketing_collateral",
    ambiguous: true,
    note:
      "Pre-chart production-capability code. Sheet printing spans marketing_collateral (flyers, brochures, business cards, stickers) and recognition_awards_signage (certificates & diplomas). marketing_collateral is the dominant home; the alias is kept so stored references still resolve.",
    active: true,
  },
  {
    code: "apparel_sublimation",
    name: "Apparel / sublimation",
    categoryCode: "corporate_event_merch",
    ambiguous: false,
    note: "Maps onto corporate_event_merch (custom apparel, drinkware, lanyards & ID accessories).",
    active: true,
  },
  {
    code: "signage",
    name: "Signage",
    categoryCode: "recognition_awards_signage",
    ambiguous: false,
    note: "Maps onto recognition_awards_signage (business & store signages).",
    active: true,
  },
];

const MATERIALS = [
  {
    id: "taxm_13oz",
    code: "tarpaulin_13oz",
    name: "13oz tarpaulin",
    categoryCodes: ["marketing_collateral", "recognition_awards_signage"],
    active: true,
  },
  { id: "taxm_mesh", code: "mesh_banner", name: "Mesh banner", categoryCodes: ["marketing_collateral"], active: true },
  {
    id: "taxm_vinyl",
    code: "vinyl_sticker",
    name: "Vinyl sticker",
    categoryCodes: ["marketing_collateral", "recognition_awards_signage"],
    active: true,
  },
  { id: "taxm_matte150", code: "matte_150gsm", name: "Matte 150gsm", categoryCodes: ["marketing_collateral"], active: true },
  { id: "taxm_gloss_card", code: "gloss_cardstock", name: "Gloss cardstock", categoryCodes: ["marketing_collateral"], active: true },
  { id: "taxm_cotton", code: "cotton_tee", name: "Cotton tee", categoryCodes: ["corporate_event_merch"], active: true },
];

const FINISHES = [
  {
    id: "taxf_hem_grommet",
    code: "hem_grommet",
    name: "Hem + grommets",
    categoryCodes: ["marketing_collateral", "recognition_awards_signage"],
    active: true,
  },
  {
    id: "taxf_laminate",
    code: "lamination",
    name: "Lamination",
    categoryCodes: ["marketing_collateral", "recognition_awards_signage"],
    active: true,
  },
  {
    id: "taxf_none",
    code: "none",
    name: "None",
    categoryCodes: [
      "marketing_collateral",
      "corporate_event_merch",
      "recognition_awards_signage",
      "specialized_prototyping",
    ],
    active: true,
  },
  {
    id: "taxf_cut",
    code: "kiss_cut",
    name: "Kiss cut",
    categoryCodes: ["marketing_collateral", "recognition_awards_signage"],
    active: true,
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function defaultTaxonomy() {
  return {
    categories: clone(CATEGORIES),
    subcategories: clone(SUBCATEGORIES),
    categoryAliases: clone(CATEGORY_ALIASES),
    materials: clone(MATERIALS),
    finishes: clone(FINISHES),
  };
}

export const LEGACY_CATEGORY_CODES = CATEGORY_ALIASES.map((alias) => alias.code);

/**
 * Canonical category for a code, accepting a retired legacy code through
 * `categoryAliases`. Returns the category record or null. Callers that care about
 * availability must still check `active`.
 */
export function resolveCategoryCode(taxonomy, code) {
  if (code == null) return null;
  const categories = taxonomy?.categories || [];
  const direct = categories.find((c) => c.code === code);
  if (direct) return direct;
  const alias = (taxonomy?.categoryAliases || []).find((a) => a.code === code && a.active !== false);
  if (!alias) return null;
  return categories.find((c) => c.code === alias.categoryCode) || null;
}

function byOrder(a, b) {
  const oa = Number.isFinite(a.sortOrder) ? a.sortOrder : Number.POSITIVE_INFINITY;
  const ob = Number.isFinite(b.sortOrder) ? b.sortOrder : Number.POSITIVE_INFINITY;
  if (oa !== ob) return oa - ob;
  return String(a.code).localeCompare(String(b.code));
}

/**
 * Derived picker projection: active categories in sort order, each with its active
 * subcategories nested under `subcategories`. Never stored — recomputed per request
 * so the flat store stays the single source of truth.
 */
export function buildCategoryTree(taxonomy) {
  const subcategories = (taxonomy?.subcategories || []).filter((s) => s.active !== false);
  return (taxonomy?.categories || [])
    .filter((c) => c.active !== false)
    .slice()
    .sort(byOrder)
    .map((category) => ({
      ...category,
      subcategories: subcategories.filter((s) => s.categoryCode === category.code).sort(byOrder),
    }));
}
