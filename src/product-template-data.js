import { defaultListingStarters } from "./listing-starters.js";
import { defaultTaxonomy } from "./taxonomy.js";

// Recommended first list; seed appends missing IDs and never overwrites team edits.
const GROUPS = {
  document_printing: "documents",
  risograph: "documents",
  id_photos: "documents",
  binding_hardbound: "books_binding",
  booklets: "books_binding",
  flyers: "marketing",
  brochures: "marketing",
  business_cards: "marketing",
  posters_standees: "large_format",
  tarpaulins_outdoor_banners: "large_format",
  blueprint_cad_plotting: "large_format",
  stickers_packaging_labels: "stickers_labels",
  custom_apparel: "wearables",
  lanyards_id_accessories: "wearables",
  drinkware: "gifts",
  corporate_giveaways: "gifts",
  certificates_diplomas: "recognition",
  plaques_trophies: "recognition",
  medals_ribbons: "recognition",
};
export const READY_TIME_CHIPS = [
  {
    code: "same_day",
    label: "Same day",
    productionTime: { mode: "same_day", hours: 2 },
  },
  {
    code: "next_day",
    label: "Next working day",
    productionTime: { mode: "days", minDays: 1, maxDays: 1 },
  },
  {
    code: "2_3_days",
    label: "2–3 working days",
    productionTime: { mode: "days", minDays: 2, maxDays: 3 },
  },
  {
    code: "4_7_days",
    label: "4–7 working days",
    productionTime: { mode: "days", minDays: 4, maxDays: 7 },
  },
];
export function defaultProductTemplates() {
  const taxonomy = defaultTaxonomy();
  const templates = defaultListingStarters()
    .filter((s) => GROUPS[s.subcategoryCode])
    .map((s) => {
      const categoryCode = taxonomy.subcategories.find(
        (t) => t.code === s.subcategoryCode,
      ).categoryCode;
      const axes = structuredClone(s.groups.filter((g) => g.kind === "spec"));
      if (s.subcategoryCode === "document_printing")
        axes
          .find((g) => g.name === "Paper size")
          .options.push({
            label: "A3",
            specBinding: { fieldCode: "size", value: "A3" },
          });
      const combinations = axes.reduce(
        (rows, g) => rows.flatMap((row) => g.options.map((o) => [...row, o])),
        [[]],
      );
      const options = combinations.map((row, i) => ({
        key: i === 0 ? "standard" : `variant_${i}`,
        label: row.map((o) => o.label).join(" / "),
        specBinding:
          row.find((o) => o.specBinding?.fieldCode === "size")?.specBinding ||
          row.find((o) => o.specBinding)?.specBinding ||
          null,
      }));
      const unit =
        s.subcategoryCode === "tarpaulins_outdoor_banners"
          ? "sq_ft"
          : s.defaultPricingUnit === "per_page"
            ? "page"
            : s.subcategoryCode === "stickers_packaging_labels"
              ? "sheet"
              : "piece";
      return {
        id: `tpl_${s.subcategoryCode}`,
        name: s.name,
        description: `${s.name} made to your selected specifications.`,
        categoryCode,
        subcategoryCode: s.subcategoryCode,
        group: GROUPS[s.subcategoryCode],
        unit,
        options,
        optionLists: axes.map((g) => ({
          name: g.name,
          options: g.options.map((o) => o.label),
        })),
        stockPhotos: [
          { url: `/product-template-photos/${s.id}.jpg`, altText: s.name },
        ],
        fileTypes: s.defaultFormatCodes,
        clientTips: [
          "Send a clear, print-ready file. Confirm size and quantity before ordering.",
        ],
        express: s.subcategoryCode === "document_printing",
        machinesNeeded: [
          unit === "sq_ft" || s.subcategoryCode === "blueprint_cad_plotting"
            ? "large_format_printer"
            : GROUPS[s.subcategoryCode] === "documents"
              ? "document_printer"
              : "specialist_equipment",
        ],
        // Advisory launch ranges, editable by the team; never a price cap or a quote.
        priceRange:
          unit === "page"
            ? { minMinor: 50, maxMinor: 10000 }
            : unit === "sq_ft"
              ? { minMinor: 1000, maxMinor: 30000 }
              : { minMinor: 100, maxMinor: 500000 },
        active: true,
        version: 1,
      };
    });
  for (const [code, name, source] of [
    ["photocopies", "Photocopies", "document_printing"],
    ["photo_prints", "Photo prints", "id_photos"],
    ["lamination", "Lamination", "binding_hardbound"],
    ["pvc_cards", "PVC cards", "id_photos"],
    ["tote_bags", "Tote bags", "custom_apparel"],
    ["notebooks", "Notebooks", "corporate_giveaways"],
  ]) {
    const base = templates.find((t) => t.subcategoryCode === source);
    templates.push({
      ...structuredClone(base),
      id: `tpl_${code}`,
      name,
      description: `${name} made to your selected specifications.`,
      express: false,
    });
  }
  return templates;
}
