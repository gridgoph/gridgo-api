function spec(id, name, helpText, options) {
  return { id, name, kind: "spec", required: true, helpText, sortOrder: 0, options };
}

function orderedGroups(groups) {
  return groups.map((group, sortOrder) => ({
    ...group,
    sortOrder,
    options: group.options.map((option, optionOrder) => ({ ...option, sortOrder: optionOrder })),
  }));
}

function option(id, label, priceModifierMinor, specBinding = null) {
  return { id, label, priceModifierMinor, specBinding };
}

const PRINT_FILES = ["pdf", "png", "jpeg"];
const DESIGN_FILES = ["pdf", "png", "jpeg", "psd", "canva_link"];
const APPAREL_FILES = ["png", "jpeg", "psd"];
const MODEL_FILES = ["3mf", "stl"];

export function defaultListingStarters() {
  return [
    {
      id: "lst_tarpaulins_outdoor_banners",
      subcategoryCode: "tarpaulins_outdoor_banners",
      name: "Tarpaulin",
      defaultPricingUnit: "per_unit",
      defaultPackageQty: null,
      defaultTurnaroundHours: 24,
      defaultFormatCodes: DESIGN_FILES,
      groups: orderedGroups([
        spec("lstg_tarp_size", "Size", "Finished size", [
          option("lsto_tarp_2x3", "2x3 ft", 0, { fieldCode: "size", value: "2x3" }),
          option("lsto_tarp_3x5", "3x5 ft", 15000, { fieldCode: "size", value: "3x5" }),
          option("lsto_tarp_4x8", "4x8 ft", 35000, { fieldCode: "size", value: "4x8" }),
        ]),
        spec("lstg_tarp_material", "Material", "Vinyl weight", [
          option("lsto_tarp_10oz", "10oz tarpaulin", 0),
          option("lsto_tarp_13oz", "13oz tarpaulin", 2500, { fieldCode: "material", valueCode: "tarpaulin_13oz" }),
        ]),
        spec("lstg_tarp_finish", "Finish", "Surface", [
          option("lsto_tarp_matte", "Matte", 0),
          option("lsto_tarp_gloss", "Gloss", 500),
        ]),
        {
          id: "lstg_tarp_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: "Optional extras", options: [
            option("lsto_tarp_grommets", "Grommets", 1500, { fieldCode: "finish", valueCode: "hem_grommet" }),
            option("lsto_tarp_pole", "Pole pocket", 2000),
          ],
        },
      ]),
    },
    {
      id: "lst_flyers",
      subcategoryCode: "flyers",
      name: "Flyers",
      defaultPricingUnit: "per_package",
      defaultPackageQty: 100,
      defaultTurnaroundHours: 48,
      defaultFormatCodes: PRINT_FILES,
      groups: orderedGroups([
        spec("lstg_flyer_size", "Size", "Sheet size", [
          option("lsto_flyer_a5", "A5", 0, { fieldCode: "size", value: "A5" }),
          option("lsto_flyer_a4", "A4", 1500, { fieldCode: "size", value: "A4" }),
        ]),
        spec("lstg_flyer_paper", "Paper", "Stock", [
          option("lsto_flyer_matte", "Matte 150gsm", 0, { fieldCode: "material", valueCode: "matte_150gsm" }),
          option("lsto_flyer_gloss", "Gloss cardstock", 800, { fieldCode: "material", valueCode: "gloss_cardstock" }),
        ]),
        spec("lstg_flyer_sides", "Sides", null, [
          option("lsto_flyer_single", "Single-sided", 0),
          option("lsto_flyer_double", "Double-sided", 1200),
        ]),
        {
          id: "lstg_flyer_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_flyer_lamination", "Lamination", 2000, { fieldCode: "finish", valueCode: "lamination" })],
        },
      ]),
    },
    {
      id: "lst_brochures",
      subcategoryCode: "brochures",
      name: "Brochures",
      defaultPricingUnit: "per_package",
      defaultPackageQty: 100,
      defaultTurnaroundHours: 48,
      defaultFormatCodes: PRINT_FILES,
      groups: orderedGroups([
        spec("lstg_brochure_size", "Size", "Sheet size before fold", [
          option("lsto_brochure_a4", "A4", 0, { fieldCode: "size", value: "A4" }),
          option("lsto_brochure_a3", "A3", 2500, { fieldCode: "size", value: "A3" }),
        ]),
        spec("lstg_brochure_fold", "Fold", null, [
          option("lsto_brochure_bifold", "Bi-fold", 0),
          option("lsto_brochure_trifold", "Tri-fold", 800),
        ]),
        spec("lstg_brochure_paper", "Paper", "Stock", [
          option("lsto_brochure_matte", "Matte 150gsm", 0, { fieldCode: "material", valueCode: "matte_150gsm" }),
          option("lsto_brochure_gloss", "Gloss cardstock", 800, { fieldCode: "material", valueCode: "gloss_cardstock" }),
        ]),
        {
          id: "lstg_brochure_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_brochure_lamination", "Lamination", 2500, { fieldCode: "finish", valueCode: "lamination" })],
        },
      ]),
    },
    {
      id: "lst_business_cards",
      subcategoryCode: "business_cards",
      name: "Business cards",
      defaultPricingUnit: "per_package",
      defaultPackageQty: 100,
      defaultTurnaroundHours: 48,
      defaultFormatCodes: PRINT_FILES,
      groups: orderedGroups([
        spec("lstg_card_size", "Size", "Card size", [
          option("lsto_card_standard", "Standard", 0, { fieldCode: "size", value: "standard" }),
        ]),
        spec("lstg_card_paper", "Paper", "Stock", [
          option("lsto_card_matte", "Matte", 0, { fieldCode: "material", valueCode: "matte_150gsm" }),
          option("lsto_card_gloss", "Gloss cardstock", 500, { fieldCode: "material", valueCode: "gloss_cardstock" }),
        ]),
        spec("lstg_card_sides", "Sides", null, [
          option("lsto_card_single", "Single-sided", 0),
          option("lsto_card_double", "Double-sided", 800),
        ]),
        {
          id: "lstg_card_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_card_lamination", "Lamination", 1200, { fieldCode: "finish", valueCode: "lamination" })],
        },
      ]),
    },
    {
      id: "lst_posters_standees",
      subcategoryCode: "posters_standees",
      name: "Posters & standees",
      defaultPricingUnit: "per_unit",
      defaultPackageQty: null,
      defaultTurnaroundHours: 48,
      defaultFormatCodes: DESIGN_FILES,
      groups: orderedGroups([
        spec("lstg_poster_size", "Size", "Display size", [
          option("lsto_poster_a2", "A2 poster", 0, { fieldCode: "size", value: "A2" }),
          option("lsto_poster_pullup", "Pull-up banner", 85000, { fieldCode: "size", value: "pullup" }),
        ]),
        {
          id: "lstg_poster_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_poster_stand", "X-stand hardware", 25000)],
        },
      ]),
    },
    {
      id: "lst_stickers_packaging_labels",
      subcategoryCode: "stickers_packaging_labels",
      name: "Stickers & labels",
      defaultPricingUnit: "per_package",
      defaultPackageQty: 100,
      defaultTurnaroundHours: 48,
      defaultFormatCodes: PRINT_FILES,
      groups: orderedGroups([
        spec("lstg_sticker_material", "Material", "Face stock", [
          option("lsto_sticker_vinyl", "Vinyl sticker", 0, { fieldCode: "material", valueCode: "vinyl_sticker" }),
        ]),
        spec("lstg_sticker_cut", "Cut", null, [
          option("lsto_sticker_kiss", "Kiss cut", 0, { fieldCode: "finish", valueCode: "kiss_cut" }),
          option("lsto_sticker_die", "Die cut", 1500),
        ]),
        {
          id: "lstg_sticker_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_sticker_lamination", "Lamination", 800, { fieldCode: "finish", valueCode: "lamination" })],
        },
      ]),
    },
    {
      id: "lst_custom_apparel",
      subcategoryCode: "custom_apparel",
      name: "Custom apparel",
      defaultPricingUnit: "per_unit",
      defaultPackageQty: null,
      defaultTurnaroundHours: 72,
      defaultFormatCodes: APPAREL_FILES,
      groups: orderedGroups([
        spec("lstg_apparel_size", "Size", "Garment size", [
          option("lsto_apparel_s", "S", 0, { fieldCode: "size", value: "S" }),
          option("lsto_apparel_m", "M", 0, { fieldCode: "size", value: "M" }),
          option("lsto_apparel_l", "L", 0, { fieldCode: "size", value: "L" }),
          option("lsto_apparel_xl", "XL", 500, { fieldCode: "size", value: "XL" }),
          option("lsto_apparel_xxl", "XXL", 1000, { fieldCode: "size", value: "XXL" }),
        ]),
        spec("lstg_apparel_garment", "Garment", null, [
          option("lsto_apparel_shirt", "T-shirt", 0, { fieldCode: "material", valueCode: "cotton_tee" }),
          option("lsto_apparel_hoodie", "Hoodie", 18000),
        ]),
        spec("lstg_apparel_method", "Print method", "How the art is applied", [
          option("lsto_apparel_dtf", "DTF", 0),
          option("lsto_apparel_screen", "Screen print", 1500),
        ]),
        {
          id: "lstg_apparel_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_apparel_tag", "Tag print", 800)],
        },
      ]),
    },
    {
      id: "lst_lanyards_id_accessories",
      subcategoryCode: "lanyards_id_accessories",
      name: "Lanyards",
      defaultPricingUnit: "per_unit",
      defaultPackageQty: null,
      defaultTurnaroundHours: 72,
      defaultFormatCodes: APPAREL_FILES,
      groups: orderedGroups([
        spec("lstg_lanyard_width", "Width", null, [
          option("lsto_lanyard_15", "15 mm", 0),
          option("lsto_lanyard_20", "20 mm", 300),
        ]),
        {
          id: "lstg_lanyard_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_lanyard_clip", "Badge clip", 500)],
        },
      ]),
    },
    {
      id: "lst_drinkware",
      subcategoryCode: "drinkware",
      name: "Drinkware",
      defaultPricingUnit: "per_unit",
      defaultPackageQty: null,
      defaultTurnaroundHours: 72,
      defaultFormatCodes: APPAREL_FILES,
      groups: orderedGroups([
        spec("lstg_drink_item", "Item", null, [
          option("lsto_drink_mug", "Mug", 0),
          option("lsto_drink_tumbler", "Tumbler", 4500),
        ]),
        {
          id: "lstg_drink_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_drink_box", "Gift box", 800)],
        },
      ]),
    },
    {
      id: "lst_corporate_giveaways",
      subcategoryCode: "corporate_giveaways",
      name: "Giveaways",
      defaultPricingUnit: "per_unit",
      defaultPackageQty: null,
      defaultTurnaroundHours: 72,
      defaultFormatCodes: APPAREL_FILES,
      groups: orderedGroups([
        spec("lstg_giveaway_item", "Item", null, [
          option("lsto_giveaway_pen", "Pen", 0),
          option("lsto_giveaway_tote", "Tote bag", 3500),
        ]),
        {
          id: "lstg_giveaway_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_giveaway_wrap", "Individual wrap", 400)],
        },
      ]),
    },
    {
      id: "lst_certificates_diplomas",
      subcategoryCode: "certificates_diplomas",
      name: "Certificates",
      defaultPricingUnit: "per_unit",
      defaultPackageQty: null,
      defaultTurnaroundHours: 48,
      defaultFormatCodes: PRINT_FILES,
      groups: orderedGroups([
        spec("lstg_cert_paper", "Paper", "Certificate stock", [
          option("lsto_cert_specialty", "Specialty paper", 0),
          option("lsto_cert_foil", "Foil-stamped", 2500),
        ]),
        {
          id: "lstg_cert_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_cert_folder", "Presentation folder", 1500)],
        },
      ]),
    },
    {
      id: "lst_plaques_trophies",
      subcategoryCode: "plaques_trophies",
      name: "Plaques & trophies",
      defaultPricingUnit: "per_unit",
      defaultPackageQty: null,
      defaultTurnaroundHours: 96,
      defaultFormatCodes: DESIGN_FILES,
      groups: orderedGroups([
        spec("lstg_plaque_material", "Material", null, [
          option("lsto_plaque_wood", "Wooden plaque", 0),
          option("lsto_plaque_acrylic", "Acrylic", 3500),
        ]),
        {
          id: "lstg_plaque_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_plaque_box", "Presentation box", 2000)],
        },
      ]),
    },
    {
      id: "lst_medals_ribbons",
      subcategoryCode: "medals_ribbons",
      name: "Medals",
      defaultPricingUnit: "per_unit",
      defaultPackageQty: null,
      defaultTurnaroundHours: 96,
      defaultFormatCodes: APPAREL_FILES,
      groups: orderedGroups([
        spec("lstg_medal_finish", "Finish", null, [
          option("lsto_medal_metal", "Metal", 0),
          option("lsto_medal_acrylic", "Acrylic", 800),
        ]),
        {
          id: "lstg_medal_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_medal_ribbon", "Custom ribbon", 1200)],
        },
      ]),
    },
    {
      id: "lst_three_d_printing_scale_models",
      subcategoryCode: "three_d_printing_scale_models",
      name: "3D print",
      defaultPricingUnit: "per_unit",
      defaultPackageQty: null,
      defaultTurnaroundHours: 72,
      defaultFormatCodes: MODEL_FILES,
      groups: orderedGroups([
        spec("lstg_3d_material", "Material", "Print filament", [
          option("lsto_3d_pla", "PLA", 0),
          option("lsto_3d_petg", "PETG", 2500),
        ]),
        spec("lstg_3d_quality", "Quality", "Layer height", [
          option("lsto_3d_standard", "Standard", 0),
          option("lsto_3d_fine", "Fine", 2000),
        ]),
      ]),
    },
    {
      id: "lst_blueprint_cad_plotting",
      subcategoryCode: "blueprint_cad_plotting",
      name: "Blueprint plotting",
      defaultPricingUnit: "per_unit",
      defaultPackageQty: null,
      defaultTurnaroundHours: 24,
      defaultFormatCodes: ["pdf"],
      groups: orderedGroups([
        spec("lstg_plot_size", "Size", "Sheet size", [
          option("lsto_plot_a1", "A1", 0, { fieldCode: "size", value: "A1" }),
          option("lsto_plot_a0", "A0", 2500, { fieldCode: "size", value: "A0" }),
        ]),
        {
          id: "lstg_plot_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_plot_fold", "Folded delivery", 500)],
        },
      ]),
    },

    {
      id: "lst_business_store_signages",
      subcategoryCode: "business_store_signages",
      name: "Business & store signage",
      // Signage is surveyed, fabricated and installed. There is no per-piece
      // or per-foot figure that means anything until somebody has seen the
      // wall, so the shop quotes one price for the whole job.
      defaultPricingUnit: "whole_job",
      defaultPackageQty: null,
      defaultTurnaroundHours: 168,
      defaultFormatCodes: ["pdf", "psd", "canva_link"],
      groups: orderedGroups([
        spec("lstg_sign_material", "Material", "What the sign is made of", [
          option("lsto_sign_acrylic", "Acrylic build-up letters", 0, { fieldCode: "material", value: "Acrylic" }),
          option("lsto_sign_panaflex", "Panaflex lightbox", 0, { fieldCode: "material", value: "Panaflex" }),
        ]),
        {
          id: "lstg_sign_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_sign_led", "LED backlighting", 0)],
        },
      ]),
    },

    // 5. Documents & Publications -- Lovis's board, and the everyday work the
    // first four categories had no home for.
    {
      id: "lst_document_printing",
      subcategoryCode: "document_printing",
      name: "Document printing",
      // Priced by the page, so the client says how many pages and how many
      // copies. Those are two different numbers and the platform bills both.
      defaultPricingUnit: "per_page",
      defaultPackageQty: null,
      defaultTurnaroundHours: 4,
      defaultFormatCodes: ["pdf"],
      groups: orderedGroups([
        spec("lstg_doc_colour", "Colour", "Black and white, or full colour", [
          option("lsto_doc_bw", "Black and white", 0),
          // Colour is a flat PHP 4.00 at every size, against PHP 2.00 short.
          option("lsto_doc_colour", "Colour", 200),
        ]),
        spec("lstg_doc_size", "Paper size", "The sheet it prints on", [
          option("lsto_doc_short", "Short (8.5 x 11 in)", 0, { fieldCode: "size", value: "Short" }),
          option("lsto_doc_a4", "A4", 50, { fieldCode: "size", value: "A4" }),
          option("lsto_doc_long", "Long / Folio", 100, { fieldCode: "size", value: "Long" }),
        ]),
        spec("lstg_doc_paper", "Paper", "Bond paper weight", [
          option("lsto_doc_70", "70gsm bond", 0, { fieldCode: "material", value: "Bond 70gsm" }),
          option("lsto_doc_80", "80gsm bond", 0, { fieldCode: "material", value: "Bond 80gsm" }),
        ]),
        {
          id: "lstg_doc_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null,
          options: [
            // "x2 the price", which as a flat amount has to be re-entered by
            // hand every time the base price moves.
            { id: "lsto_doc_duplex", label: "Back-to-back", priceModifierMinor: 0, priceMultiplierBps: 20_000, specBinding: null },
          ],
        },
      ]),
    },
    {
      id: "lst_booklets",
      subcategoryCode: "booklets",
      name: "Booklets",
      defaultPricingUnit: "per_page",
      defaultPackageQty: null,
      defaultTurnaroundHours: 24,
      defaultFormatCodes: ["pdf"],
      groups: orderedGroups([
        spec("lstg_booklet_fold", "Fold", "How the sheet is folded", [
          option("lsto_booklet_bifold", "Bifold", 0, { fieldCode: "finish", value: "Bifold" }),
          option("lsto_booklet_trifold", "Trifold", 0, { fieldCode: "finish", value: "Trifold" }),
        ]),
        spec("lstg_booklet_paper", "Paper", "Bond paper weight", [
          option("lsto_booklet_70", "70gsm bond", 0, { fieldCode: "material", value: "Bond 70gsm" }),
          option("lsto_booklet_80", "80gsm bond", 0, { fieldCode: "material", value: "Bond 80gsm" }),
        ]),
        {
          id: "lstg_booklet_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null, options: [option("lsto_booklet_duplex", "Back-to-back", 500)],
        },
      ]),
    },
    {
      id: "lst_risograph",
      subcategoryCode: "risograph",
      name: "Risograph printing",
      // Sold by the ream. The shop's own baseline is 500 sheets front only,
      // and a client asking for "one" means one ream.
      defaultPricingUnit: "per_package",
      defaultPackageQty: 500,
      defaultTurnaroundHours: 24,
      defaultFormatCodes: ["pdf"],
      groups: orderedGroups([
        spec("lstg_riso_size", "Paper size", "The sheet it prints on", [
          option("lsto_riso_short", "Short (8.5 x 11 in)", 0, { fieldCode: "size", value: "Short" }),
          option("lsto_riso_a4", "A4", 5_000, { fieldCode: "size", value: "A4" }),
          option("lsto_riso_long", "Long / Folio", 10_000, { fieldCode: "size", value: "Long" }),
        ]),
      ]),
    },
    {
      id: "lst_binding_hardbound",
      subcategoryCode: "binding_hardbound",
      name: "Hardbound & binding",
      defaultPricingUnit: "per_unit",
      defaultPackageQty: null,
      // The slowest speed the shop sells, which is the one its base price
      // belongs to. A faster date picks a speed tier and its own price.
      defaultTurnaroundHours: 120,
      defaultFormatCodes: ["pdf"],
      groups: orderedGroups([
        spec("lstg_bind_size", "Size", "Trim size of the finished book", [
          option("lsto_bind_a4", "A4", 0, { fieldCode: "size", value: "A4" }),
          option("lsto_bind_short", "Short", 0, { fieldCode: "size", value: "Short" }),
          option("lsto_bind_long", "Long", 0, { fieldCode: "size", value: "Long" }),
        ]),
        spec("lstg_bind_foil", "Lettering", "Front page and spine, Times New Roman", [
          option("lsto_bind_gold", "Gold", 0, { fieldCode: "finish", value: "Gold foil" }),
          option("lsto_bind_silver", "Silver", 0, { fieldCode: "finish", value: "Silver foil" }),
        ]),
        spec("lstg_bind_method", "Finish", "How the cover is lettered", [
          option("lsto_bind_digital", "Digital", 0),
          option("lsto_bind_embossed", "Embossed", 0),
        ]),
      ]),
    },
    {
      id: "lst_id_photos",
      subcategoryCode: "id_photos",
      name: "ID photos",
      // A package, not a piece: the shop sells "3pcs 2x2 & 4pcs 1x1" as one
      // thing, and a client asking for one means one set.
      defaultPricingUnit: "per_unit",
      defaultPackageQty: null,
      defaultTurnaroundHours: 2,
      defaultFormatCodes: ["png", "jpeg"],
      groups: orderedGroups([
        spec("lstg_id_set", "What you need", "Single sizes and the usual sets", [
          option("lsto_id_set_2x2_1x1", "3pcs 2x2 & 4pcs 1x1", 0),
          option("lsto_id_set_1x1", "8pcs 1x1", -2_000),
          option("lsto_id_set_2x2", "4pcs 2x2", -1_000),
          option("lsto_id_set_passport", "5pcs passport", 1_000),
          option("lsto_id_set_mixed", "2pcs passport, 2pcs 2x2, 2pcs 1x1", 1_500),
          option("lsto_id_wallet", "Wallet size", -3_000),
          option("lsto_id_3r", "3R", -2_000),
          option("lsto_id_4r", "4R", -1_000),
          option("lsto_id_5r", "5R", -500),
          option("lsto_id_6r", "6R", 0),
          option("lsto_id_family", "Family size", 1_000),
        ]),
        spec("lstg_id_paper", "Printed on", "Photo paper, or PVC card", [
          option("lsto_id_photo_paper", "Photo paper", 0, { fieldCode: "material", value: "Photo paper" }),
          option("lsto_id_pvc", "PVC plastic", 5_000, { fieldCode: "material", value: "PVC" }),
        ]),
        {
          id: "lstg_id_addons", name: "Add-ons", kind: "addon", required: false,
          helpText: null,
          options: [
            option("lsto_id_collar", "With collar or name tag", 1_500),
            option("lsto_id_atm", "ATM size", 10_000),
          ],
        },
      ]),
    },
  ];
}
