/**
 * Artwork guidance: the resolution and colour a category is normally printed
 * at, and what the client agreed to when their file falls short.
 *
 * Nothing here blocks. A file that cannot be read is refused by the structural
 * check in `artwork-file-check.js`; a file that reads fine but is soft or RGB is
 * the client's call. They either upload a better file or tick that they accept
 * the warning, and that tick travels with the order so the GRIDGO Team quality
 * check and the proof both show it.
 *
 * Resolution is judged at the size the client ordered, never the density the
 * file declares: a 72 DPI header on a 2480 x 3508 px image is still a sharp A4.
 * No ordered size, no pixels (a PDF), or no recommendation for the category
 * means no resolution warning rather than a guessed one.
 */

const MILLI = 1000;
const MM_PER_INCH = 25.4;

export const ARTWORK_WARNING_CODES = Object.freeze(["low_resolution", "color_mode"]);

const DPI_MIN = 50;
const DPI_MAX = 1200;
const MAX_ACCEPTANCES = 40;

/**
 * Starting values, keyed by taxonomy subcategory code.
 *
 * Documents and flyers 300, posters 200, apparel 150, tarpaulins and large
 * format 100. Paper, stickers, signage and keepsakes expect CMYK; apparel
 * accepts RGB. 3D printing takes model files, so it has neither a resolution
 * nor a colour expectation. A subcategory added later uses `default`.
 */
export function defaultArtworkGuidance() {
  const cmyk = (minimumDpi) => ({ minimumDpi, acceptsRgb: false });
  return {
    version: 1,
    default: cmyk(300),
    subcategories: {
      document_printing: cmyk(300),
      booklets: cmyk(300),
      risograph: cmyk(300),
      binding_hardbound: cmyk(300),
      id_photos: cmyk(300),
      flyers: cmyk(300),
      brochures: cmyk(300),
      business_cards: cmyk(300),
      stickers_packaging_labels: cmyk(300),
      certificates_diplomas: cmyk(300),
      corporate_giveaways: cmyk(300),
      drinkware: cmyk(300),
      lanyards_id_accessories: cmyk(300),
      plaques_trophies: cmyk(300),
      medals_ribbons: cmyk(300),
      packaging_box_production: cmyk(300),
      posters_standees: cmyk(200),
      custom_apparel: { minimumDpi: 150, acceptsRgb: true },
      tarpaulins_outdoor_banners: cmyk(100),
      business_store_signages: cmyk(100),
      blueprint_cad_plotting: cmyk(100),
      three_d_printing_scale_models: { minimumDpi: null, acceptsRgb: true },
    },
  };
}

export function artworkGuidanceSettings(settings) {
  return structuredClone(settings?.artworkGuidance ?? defaultArtworkGuidance());
}

function validEntry(entry) {
  return entry && typeof entry === "object" && !Array.isArray(entry)
    && Object.keys(entry).every((key) => ["minimumDpi", "acceptsRgb"].includes(key))
    && (entry.minimumDpi === null || (Number.isSafeInteger(entry.minimumDpi) && entry.minimumDpi >= DPI_MIN && entry.minimumDpi <= DPI_MAX))
    && typeof entry.acceptsRgb === "boolean";
}

/**
 * Super Admin replaces the whole value. Codes must be taxonomy subcategories,
 * retired ones included, so a stored target never names something unknown.
 */
export function validateArtworkGuidance(value, taxonomy, fail) {
  const message = `Send artworkGuidance as { version: 1, default, subcategories }, where each entry is { minimumDpi: ${DPI_MIN}-${DPI_MAX} or null, acceptsRgb: boolean }.`;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
      || !value.subcategories || typeof value.subcategories !== "object" || Array.isArray(value.subcategories)
      || Object.keys(value).some((key) => !["version", "default", "subcategories"].includes(key))) {
    fail(400, "invalid_artwork_guidance", message, { field: "artworkGuidance" });
  }
  if (!validEntry(value.default)) fail(400, "invalid_artwork_guidance", message, { field: "artworkGuidance.default" });
  const known = new Set((taxonomy?.subcategories || []).map((row) => row.code));
  for (const [code, entry] of Object.entries(value.subcategories)) {
    if (!known.has(code)) {
      fail(400, "unknown_artwork_guidance_subcategory", "Use a product type code from the taxonomy.", { field: `artworkGuidance.subcategories.${code}` });
    }
    if (!validEntry(entry)) fail(400, "invalid_artwork_guidance", message, { field: `artworkGuidance.subcategories.${code}` });
  }
  return {
    version: 1,
    default: { minimumDpi: value.default.minimumDpi, acceptsRgb: value.default.acceptsRgb },
    subcategories: Object.fromEntries(Object.entries(value.subcategories)
      .map(([code, entry]) => [code, { minimumDpi: entry.minimumDpi, acceptsRgb: entry.acceptsRgb }])),
  };
}

/** The recommendation for one product type, and whether it was set or inherited. */
export function guidanceFor(settings, subcategoryCode) {
  const guidance = artworkGuidanceSettings(settings);
  const entry = subcategoryCode ? guidance.subcategories?.[subcategoryCode] : null;
  const resolved = entry || guidance.default;
  return {
    subcategoryCode: subcategoryCode ?? null,
    minimumDpi: resolved.minimumDpi,
    acceptsRgb: resolved.acceptsRgb,
    expectedColorMode: resolved.acceptsRgb ? "rgb_accepted" : "cmyk",
    source: entry ? "subcategory" : "default",
  };
}

const NAMED_SIZES = {
  a0: [841, 1189], a1: [594, 841], a2: [420, 594], a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148],
  b5: [176, 250], dl: [99, 210], letter: [216, 279], legal: [216, 356], tabloid: [279, 432],
};
const SIZE_ALIASES = { short: "8.5x11 in", long: "8.5x13 in", folio: "8.5x13 in", "30x40": "30x40 in" };
const SUBCATEGORY_SIZE_ALIASES = { business_cards: { standard: "3.5x2 in" }, posters_standees: { pullup: "85x200 cm" } };
const UNIT_MM = { mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, inches: 25.4, '"': 25.4, ft: 304.8, foot: 304.8, feet: 304.8 };
const SIZE_FIELDS = new Set(["size", "item_size", "dimensions"]);

/**
 * The physical size a size label names, in thousandths of a millimetre.
 *
 * The same reading the client app uses: a paper name ("A5", "A4 portrait"), a
 * shop alias ("Standard" business card), or a measured pair ("3 x 6 ft").
 * Anything else is null; a custom size nobody measured is not a size.
 */
export function physicalSizeMilli(label, subcategoryCode = null) {
  if (typeof label !== "string") return null;
  const text = label.trim().toLowerCase();
  if (!text) return null;
  const alias = SUBCATEGORY_SIZE_ALIASES[subcategoryCode ?? ""]?.[text] ?? SIZE_ALIASES[text];
  if (alias) return physicalSizeMilli(alias);
  const named = NAMED_SIZES[text.split(/\s+/)[0]];
  if (named) return { widthMilli: named[0] * MILLI, heightMilli: named[1] * MILLI };
  const pair = /^(\d+(?:\.\d+)?)\s*([a-z"]*)\s*[x×]\s*(\d+(?:\.\d+)?)\s*([a-z"]*)/.exec(text);
  if (!pair) return null;
  const [, first, firstUnit, second, secondUnit] = pair;
  const scale = UNIT_MM[secondUnit || firstUnit];
  if (!scale || (firstUnit && secondUnit && firstUnit !== secondUnit)) return null;
  const widthMilli = Math.round(Number(first) * scale * MILLI);
  const heightMilli = Math.round(Number(second) * scale * MILLI);
  return widthMilli > 0 && heightMilli > 0 ? { widthMilli, heightMilli } : null;
}

/**
 * The size this line was ordered at, in thousandths of a millimetre.
 *
 * First a measured line (thousandths of the listing's unit), then a selected
 * size option, then a size the client stated in the spec. Null when none says.
 */
export function orderedSizeMilli(store, item, line) {
  const measurement = line?.measurement;
  const scale = UNIT_MM[String(item?.measureUnit ?? "").toLowerCase()];
  if (scale && Number.isSafeInteger(measurement?.width) && Number.isSafeInteger(measurement?.height)
      && measurement.width > 0 && measurement.height > 0) {
    return { widthMilli: Math.round(measurement.width * scale), heightMilli: Math.round(measurement.height * scale) };
  }
  const subcategoryCode = item?.subcategoryCode ?? null;
  const optionIds = new Set((line?.optionIds || []).map(String));
  for (const option of (store?.catalogOptions || [])) {
    if (!optionIds.has(String(option.id))) continue;
    const binding = option.specBinding;
    const bound = binding && SIZE_FIELDS.has(binding.fieldCode)
      ? physicalSizeMilli(String(binding.value ?? binding.valueCode ?? ""), subcategoryCode) : null;
    const size = bound ?? physicalSizeMilli(option.label, subcategoryCode);
    if (size) return size;
  }
  const spec = line?.structuredSpec || {};
  for (const key of ["size", "dimensions"]) {
    const size = physicalSizeMilli(typeof spec[key] === "string" ? spec[key] : null, subcategoryCode);
    if (size) return size;
  }
  return null;
}

/**
 * The resolution a file prints at on that size, judged on the limiting side.
 *
 * Long side against long side, so a landscape file on a portrait size is not
 * reported ten times off; the fit check is a separate question.
 */
export function effectiveDpi(file, size) {
  const width = file?.detected?.pixelWidth;
  const height = file?.detected?.pixelHeight;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || !size) return null;
  const longInches = Math.max(size.widthMilli, size.heightMilli) / MILLI / MM_PER_INCH;
  const shortInches = Math.min(size.widthMilli, size.heightMilli) / MILLI / MM_PER_INCH;
  if (!(longInches > 0) || !(shortInches > 0)) return null;
  return Math.round(Math.min(Math.max(width, height) / longInches, Math.min(width, height) / shortInches));
}

function warningsFor(file, guidance, size) {
  const warnings = [];
  const dpi = effectiveDpi(file, size);
  if (guidance.minimumDpi != null && dpi != null && dpi < guidance.minimumDpi) {
    warnings.push({ code: "low_resolution", effectiveDpi: dpi, minimumDpi: guidance.minimumDpi });
  }
  const colorMode = file?.detected?.colorMode ?? null;
  if (!guidance.acceptsRgb && ["rgb", "mixed"].includes(colorMode)) {
    warnings.push({ code: "color_mode", colorMode, expectedColorMode: "cmyk" });
  }
  return { dpi, colorMode, warnings };
}

/** An acceptance covers a warning only while the file and the figure it saw are unchanged. */
function acceptanceFor(line, fileId, warning) {
  return (line?.artworkWarningAcceptances || []).find((row) => row.fileId === fileId && row.code === warning.code
    && (warning.code === "low_resolution" ? row.effectiveDpi === warning.effectiveDpi : row.colorMode === warning.colorMode)) ?? null;
}

/**
 * What the line's uploaded artwork looks like against its product type.
 *
 * Links (Canva, Drive) are not inspected and do not appear.
 */
export function evaluateLineArtwork(store, item, line, fileIds) {
  const guidance = guidanceFor(store?.settings, item?.subcategoryCode);
  const size = orderedSizeMilli(store, item, line);
  const files = fileIds.map((fileId) => {
    const file = (store?.files || []).find((row) => row.fileId === fileId);
    const { dpi, colorMode, warnings } = warningsFor(file, guidance, size);
    return {
      fileId,
      colorMode,
      pixelWidth: file?.detected?.pixelWidth ?? null,
      pixelHeight: file?.detected?.pixelHeight ?? null,
      effectiveDpi: dpi,
      warnings: warnings.map((warning) => {
        const accepted = acceptanceFor(line, fileId, warning);
        return { ...warning, acceptedAt: accepted?.acceptedAt ?? null };
      }),
    };
  });
  return {
    subcategoryCode: guidance.subcategoryCode,
    minimumDpi: guidance.minimumDpi,
    acceptsRgb: guidance.acceptsRgb,
    expectedColorMode: guidance.expectedColorMode,
    orderedSize: size,
    files,
    openWarningCount: files.reduce((sum, file) => sum + file.warnings.filter((warning) => !warning.acceptedAt).length, 0),
  };
}

/**
 * Replace the line's acceptances with the warnings the client ticked.
 *
 * Every entry must name a warning the line has right now, so an acceptance
 * always records the figures the client was actually shown. An empty list
 * withdraws every acceptance.
 */
export function acceptArtworkWarnings(store, item, line, fileIds, body, at, fail) {
  const accept = body?.accept;
  if (!Array.isArray(accept) || accept.length > MAX_ACCEPTANCES) {
    fail(400, "invalid_artwork_warning_acceptance", "Send accept as an array of { fileId, code } for the warnings the client accepts.", { field: "accept" });
  }
  const current = evaluateLineArtwork(store, item, { ...line, artworkWarningAcceptances: [] }, fileIds);
  const next = [];
  for (const [index, entry] of accept.entries()) {
    if (!entry || typeof entry !== "object" || typeof entry.fileId !== "string" || !ARTWORK_WARNING_CODES.includes(entry.code)) {
      fail(400, "invalid_artwork_warning_acceptance", "Each accepted warning needs a fileId and a code of low_resolution or color_mode.", { field: `accept[${index}]` });
    }
    const warning = current.files.find((file) => file.fileId === entry.fileId)?.warnings.find((row) => row.code === entry.code);
    if (!warning) {
      fail(409, "artwork_warning_not_found", "That file no longer has this warning. Refresh the cart and check the artwork again.",
        { field: `accept[${index}]`, fileId: entry.fileId, code: entry.code });
    }
    if (next.some((row) => row.fileId === entry.fileId && row.code === entry.code)) continue;
    const previous = acceptanceFor(line, entry.fileId, warning);
    const { acceptedAt: _ignored, ...figures } = warning;
    next.push({ fileId: entry.fileId, ...figures, acceptedAt: previous?.acceptedAt ?? at });
  }
  line.artworkWarningAcceptances = next;
  return next;
}

/**
 * The immutable record checkout keeps on the order line.
 *
 * Null when the line has no uploaded files to judge. Unaccepted warnings are
 * kept too: a released app that never asks still places the order, and the
 * GRIDGO Team sees that nobody accepted it.
 */
export function artworkGuidanceSnapshot(store, item, line, fileIds, at) {
  if (!fileIds.length) return null;
  const evaluated = evaluateLineArtwork(store, item, line, fileIds);
  return { version: 1, evaluatedAt: at, ...evaluated };
}

/** Riders never see artwork; everyone else on the order sees the same record. */
export function publicArtworkGuidance(snapshot, user) {
  if (!snapshot || !["client", "supplier", "ops_admin", "super_admin"].includes(user?.role)) return null;
  return structuredClone(snapshot);
}
