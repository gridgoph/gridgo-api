import { catalogGroupsForItem } from "./supplier-catalog.js";
import { namePageSize, orientationOf } from "./artwork-inspection.js";
import { approvedCatalogView } from "./catalog-review-state.js";

/**
 * How a document or drawing is put on the paper, and whether it fits.
 *
 * A shop marks which layouts a listing can print. A client ordering from a
 * listing that marked any must pick one; nothing is preselected, because the
 * wrong guess on a construction drawing is a print at the wrong scale.
 *
 * The check here is advisory. A page bigger than the paper prints with its
 * edges cut off at actual size, and the client is told so with the smallest
 * paper the listing offers that would take it -- but the order still goes
 * through. Only a missing or unsupported layout is refused.
 *
 * Contract: docs/PRINT_LAYOUT_API.md.
 */

/** Canonical order. Listing reads and stored arrays always follow it. */
export const PRINT_LAYOUTS = Object.freeze(["fit_to_paper", "actual_size_centered", "actual_size_original_position"]);

const ACTUAL_SIZE = new Set(["actual_size_centered", "actual_size_original_position"]);

/** Thousandths of a millimetre, the artwork inspection's scale. */
const MILLI = 1000;
const MM_PER_INCH = 25.4;

/**
 * A page within a millimetre of the paper fits it. PDF points and Word twips
 * round to fractions of a millimetre, and an A4 PDF is 209.9 x 297.0 mm.
 */
const FIT_TOLERANCE_MILLI = 1 * MILLI;

/** Paper names the shops here quote, portrait, in mm. Short is US Letter; Long is 8.5 x 13 in. */
const PAPER_SIZES = Object.freeze({
  a0: [841, 1189], a1: [594, 841], a2: [420, 594], a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148],
  b4: [250, 353], b5: [176, 250],
  short: [215.9, 279.4], letter: [215.9, 279.4],
  long: [215.9, 330.2], folio: [215.9, 330.2],
  legal: [215.9, 355.6],
  tabloid: [279.4, 431.8], ledger: [279.4, 431.8],
});

/** Spec bindings that name the paper a size option prints on. */
const PAPER_BINDING_FIELDS = new Set(["size", "paper_size", "item_size", "dimensions"]);

const UNIT_MM = { mm: 1, cm: 10, in: MM_PER_INCH, inch: MM_PER_INCH, inches: MM_PER_INCH, '"': MM_PER_INCH, ft: 304.8, feet: 304.8, "'": 304.8 };

const round = value => Math.round(value);

export function isPrintLayout(value) {
  return PRINT_LAYOUTS.includes(value);
}

export function isActualSizeLayout(value) {
  return ACTUAL_SIZE.has(value);
}

/** What a listing supports, canonical and deduplicated. Old rows have none. */
export function listingPrintLayouts(item) {
  const marked = new Set(Array.isArray(item?.printLayouts) ? item.printLayouts : []);
  return PRINT_LAYOUTS.filter(code => marked.has(code));
}

/** A shop's write: a list of layout codes, possibly empty. */
export function parsePrintLayouts(value, fail) {
  if (!Array.isArray(value) || value.length > PRINT_LAYOUTS.length * 2) {
    fail(400, "invalid_print_layouts", "printLayouts must be a list of layout codes.", { field: "printLayouts", allowed: [...PRINT_LAYOUTS] });
  }
  for (const code of value) {
    if (!isPrintLayout(code)) {
      fail(400, "invalid_print_layouts", "Choose layouts from fit_to_paper, actual_size_centered and actual_size_original_position.", {
        field: "printLayouts", allowed: [...PRINT_LAYOUTS],
      });
    }
  }
  return PRINT_LAYOUTS.filter(code => value.includes(code));
}

/**
 * A client's layout on a cart line. Null clears it; a listing that supports
 * no layout takes none at all.
 */
export function parseCartPrintLayout(item, value, fail) {
  if (value == null) return null;
  if (!isPrintLayout(value)) {
    fail(400, "invalid_print_layout", "Choose a layout this product supports.", { field: "printLayout", allowed: [...PRINT_LAYOUTS] });
  }
  const supported = listingPrintLayouts(item);
  if (!supported.includes(value)) {
    fail(409, "print_layout_not_supported", supported.length
      ? "This shop does not print that layout for this product. Choose one of the layouts it offers."
      : "This product has no layout choice. Remove the layout and try again.", { field: "printLayout", supported });
  }
  return value;
}

/** Checkout's gate: required when the listing offers any, and still offered. */
export function assertCheckoutPrintLayout(item, line, fail) {
  const supported = listingPrintLayouts(item);
  if (!supported.length) {
    if (line.printLayout != null) {
      fail(409, "print_layout_not_supported", "This product no longer has a layout choice. Remove the layout from the cart item and try again.", {
        lineId: line.id, field: "printLayout", supported,
      });
    }
    return;
  }
  if (line.printLayout == null) {
    fail(409, "print_layout_required", "Choose how the file is placed on the paper before checkout.", { lineId: line.id, field: "printLayout", supported });
  }
  if (!supported.includes(line.printLayout)) {
    fail(409, "print_layout_not_supported", "The shop no longer prints the chosen layout. Choose one of the layouts it offers.", {
      lineId: line.id, field: "printLayout", supported,
    });
  }
}

/**
 * A paper size from what a shop typed: a name (A4, Short, Long, Legal), or
 * width x height with an optional unit. A bare "24x36" is inches, the unit
 * plotting and poster sizes are quoted in here.
 */
export function parsePaperSize(text) {
  if (typeof text !== "string" && typeof text !== "number") return null;
  const value = String(text).trim().toLowerCase();
  if (!value || value.length > 120) return null;
  const named = /^([a-z]+\d?)\b/.exec(value)?.[1];
  if (named && PAPER_SIZES[named]) return namedPaper(named);
  const unit = '(mm|cm|inches|inch|in|feet|ft|"|\')?';
  const match = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}`).exec(value);
  if (match) {
    const scale = UNIT_MM[match[4] || match[2] || "in"];
    const width = Number(match[1]) * scale;
    const height = Number(match[3]) * scale;
    if (width > 0 && height > 0 && width <= 20_000 && height <= 20_000) return paper(width, height);
  }
  // "Short (8.5 x 11 in)" is caught above by its name; a label that only
  // names a size somewhere after other words still counts.
  for (const word of value.split(/[^a-z0-9]+/)) {
    if (PAPER_SIZES[word]) return namedPaper(word);
  }
  return null;
}

function namedPaper(name) {
  const [width, height] = PAPER_SIZES[name];
  return paper(width, height, /^[ab]\d$/.test(name) ? name.toUpperCase() : name[0].toUpperCase() + name.slice(1));
}

function paper(widthMm, heightMm, name = null) {
  const widthMilli = round(widthMm * MILLI);
  const heightMilli = round(heightMm * MILLI);
  return { widthMilli, heightMilli, pageSize: name ?? namePageSize(widthMilli, heightMilli) };
}

/**
 * The paper an option prints on, if it is a paper option at all.
 *
 * The spec binding wins over the label: the plotting starter's "24x36 / A1"
 * is bound to A1, and the binding is the governed value.
 */
export function optionPaperSize(option) {
  const binding = option?.specBinding;
  if (binding && PAPER_BINDING_FIELDS.has(binding.fieldCode)) {
    const bound = parsePaperSize(binding.value ?? binding.valueCode);
    if (bound) return bound;
    return parsePaperSize(option.label);
  }
  return null;
}

/** The listing's paper choices: active options bound to a paper size that can be read. */
function offeredPapers(store, item) {
  return catalogGroupsForItem(store, item.id, { includeInactiveOptions: false }).flatMap(group => group.options.flatMap(option => {
    const size = optionPaperSize(option);
    return size ? [{ groupId: group.id, optionId: option.id, label: option.label, ...size }] : [];
  }));
}

const shortSide = size => Math.min(size.widthMilli, size.heightMilli);
const longSide = size => Math.max(size.widthMilli, size.heightMilli);

/** Either way round: the shop feeds the paper whichever way the page needs. */
function fits(envelope, size) {
  return envelope.shortSideMilli <= shortSide(size) + FIT_TOLERANCE_MILLI
    && envelope.longSideMilli <= longSide(size) + FIT_TOLERANCE_MILLI;
}

function samePaper(page, size) {
  return Math.abs(shortSide(page) - shortSide(size)) <= FIT_TOLERANCE_MILLI
    && Math.abs(longSide(page) - longSide(size)) <= FIT_TOLERANCE_MILLI;
}

/**
 * The file's page, from its upload inspection.
 *
 * `pageEnvelope` covers every page of a mixed-size document. Files inspected
 * before it existed fall back to the first page's size, which is what they
 * stored.
 */
export function filePage(file) {
  const detected = file?.detected;
  if (!detected || !(detected.widthMilli > 0) || !(detected.heightMilli > 0)) return null;
  const envelope = detected.pageEnvelope?.shortSideMilli > 0 && detected.pageEnvelope?.longSideMilli > 0
    ? detected.pageEnvelope
    : { shortSideMilli: shortSide(detected), longSideMilli: longSide(detected), mixed: false };
  return {
    widthMilli: detected.widthMilli,
    heightMilli: detected.heightMilli,
    pageSize: detected.pageSize ?? namePageSize(detected.widthMilli, detected.heightMilli),
    orientation: detected.orientation ?? orientationOf(detected.widthMilli, detected.heightMilli),
    largestShortSideMilli: envelope.shortSideMilli,
    largestLongSideMilli: envelope.longSideMilli,
    mixedPageSizes: envelope.mixed === true,
  };
}

const publicPaper = row => row ? { optionId: row.optionId, label: row.label, widthMilli: row.widthMilli, heightMilli: row.heightMilli, pageSize: row.pageSize } : null;

/**
 * Everything the app needs to warn and preview, for one product, its chosen
 * options, its uploaded files and a layout (which may still be unchosen).
 *
 * Null when the listing supports no layout: those products show nothing.
 */
export function printLayoutCheck(store, item, { optionIds = [], fileIds = [], layout = null } = {}) {
  store = approvedCatalogView(store);
  item = (store.catalogItems || []).find(row => row.id === item.id) || item;
  const supported = listingPrintLayouts(item);
  if (!supported.length) return null;
  const offered = offeredPapers(store, item);
  const selected = new Set(optionIds || []);
  const chosen = offered.find(row => selected.has(row.optionId)) || null;
  // Suggest from the same choice the client is making: the paper group the
  // chosen option sits in, or every paper option when none is chosen yet.
  const candidates = chosen ? offered.filter(row => row.groupId === chosen.groupId) : offered;
  const unknown = [];
  if (!chosen) unknown.push({ code: "paper_size_unknown" });
  if (!fileIds.length) unknown.push({ code: "no_artwork_file" });

  const files = fileIds.map(fileId => {
    const file = (store.files || []).find(row => row.fileId === fileId);
    const page = filePage(file);
    if (!page) unknown.push({ code: "page_size_unknown", fileId });
    const envelope = page && { shortSideMilli: page.largestShortSideMilli, longSideMilli: page.largestLongSideMilli };
    return {
      fileId, page,
      exceedsPaper: page && chosen ? !fits(envelope, chosen) : null,
      envelope,
    };
  });

  const measured = files.filter(row => row.page);
  const exceedsPaper = !chosen || !files.length ? null
    : files.some(row => row.exceedsPaper === true) ? true
      : measured.length === files.length ? false : null;
  // The smallest offered paper every measured page fits, when the chosen one is too small.
  const suggestedPaper = exceedsPaper ? publicPaper(candidates
    .filter(row => measured.every(file => fits(file.envelope, row)))
    .sort((left, right) => left.widthMilli * left.heightMilli - right.widthMilli * right.heightMilli
      || left.optionId.localeCompare(right.optionId))[0]) : null;
  const actual = isActualSizeLayout(layout);
  const scaleChanges = layout == null ? null
    : actual ? false
      : !chosen || measured.length !== files.length || !files.length ? null
        : measured.some(row => row.page.mixedPageSizes || !samePaper(row.page, chosen));

  return {
    supportedLayouts: supported,
    layout: isPrintLayout(layout) ? layout : null,
    paper: publicPaper(chosen),
    files: files.map(({ fileId, page, exceedsPaper: over }) => ({ fileId, page, exceedsPaper: over })),
    exceedsPaper,
    cutOff: layout == null ? null : actual ? exceedsPaper : false,
    scaleChanges,
    suggestedPaper,
    unknown,
  };
}
