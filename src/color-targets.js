import { specialInstructions } from "./special-instructions.js";

/**
 * Exact colours a client asks for: a brand or school colour named as a
 * Pantone code, CMYK percentages or a hex value, each with a label.
 *
 * The API checks and normalises what was typed; it does not know what a
 * Pantone code looks like on paper. Pantone's colour data is licensed, so no
 * lookup table ships here: a Pantone target is text, with a swatch only when
 * the client supplied an approximate hex for it. CMYK gets a formula swatch,
 * marked approximate, because ink on paper is not the screen.
 *
 * Contract: docs/EXACT_COLOURS_API.md.
 */

/** Enough for a logo, a uniform and a background; more is a colour chart, not an order. */
export const MAX_COLOR_TARGETS = 8;
const MAX_LABEL = 40;
const MAX_PANTONE = 40;

/** Pantone guide suffixes: coated, uncoated, matte, the Pantone+ and fashion families. */
const PANTONE_SUFFIXES = new Set(["C", "U", "M", "CP", "UP", "XGC", "TCX", "TPX", "TPG", "TN", "TSX", "HC", "Q"]);

function invalid(field, message, reason) {
  throw Object.assign(new Error(message), { status: 400, code: "invalid_color_targets", details: { field, reason } });
}

/** `#RGB` or `#RRGGBB`, with or without the hash, any case. Returns `#RRGGBB` or null. */
export function parseHex(value) {
  if (typeof value !== "string") return null;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
  return `#${digits.toUpperCase()}`;
}

/**
 * CMYK as whole percentages, from `{ c, m, y, k }` or typed text.
 *
 * Text may be four numbers (`0 100 65 34`, `0,100,65,34`, `0/100/65/34`,
 * `cmyk(0%, 100%, 65%, 34%)`) or lettered (`C0 M100 Y65 K34`, `c:0 m:100 ...`)
 * in any order. Each value is a whole number from 0 to 100; a decimal is
 * refused rather than rounded, so what prints is what was asked for.
 */
export function parseCmyk(value) {
  const percent = (number) => (Number.isInteger(number) && number >= 0 && number <= 100 ? number : null);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 4 || !["c", "m", "y", "k"].every((key) => keys.includes(key))) return null;
    const result = Object.fromEntries(["c", "m", "y", "k"].map((key) => [key, typeof value[key] === "number" ? percent(value[key]) : null]));
    return Object.values(result).every((number) => number != null) ? result : null;
  }
  if (typeof value !== "string" || value.length > 80) return null;
  let body = value.trim().toLowerCase();
  const wrapped = /^cmyk\s*\((.*)\)$/.exec(body);
  if (wrapped) body = wrapped[1].trim();

  const NUMBER = "(\\d+(?:\\.\\d+)?)\\s*%?";
  const lettered = [...body.matchAll(new RegExp(`([cmyk])\\s*[:=]?\\s*${NUMBER}`, "g"))];
  if (lettered.length && body.replace(new RegExp(`([cmyk])\\s*[:=]?\\s*${NUMBER}`, "g"), "").replace(/[\s,;/]/g, "") === "") {
    if (lettered.length !== 4 || new Set(lettered.map((match) => match[1])).size !== 4) return null;
    const result = Object.fromEntries(lettered.map((match) => [match[1], percent(Number(match[2]))]));
    return Object.values(result).every((number) => number != null) ? { c: result.c, m: result.m, y: result.y, k: result.k } : null;
  }
  const plain = new RegExp(`^${NUMBER}(?:\\s*[,;/]\\s*|\\s+)${NUMBER}(?:\\s*[,;/]\\s*|\\s+)${NUMBER}(?:\\s*[,;/]\\s*|\\s+)${NUMBER}$`).exec(body);
  if (!plain) return null;
  const [c, m, y, k] = plain.slice(1).map((number) => percent(Number(number)));
  return [c, m, y, k].every((number) => number != null) ? { c, m, y, k } : null;
}

export function formatCmyk({ c, m, y, k }) {
  return `C${c} M${m} Y${y} K${k}`;
}

/**
 * The plain screen formula, for a swatch only. It ignores paper, ink and
 * profiles, which is why every CMYK swatch is marked approximate.
 */
export function cmykSwatchHex({ c, m, y, k }) {
  const channel = (ink) => Math.round((255 * (100 - ink) * (100 - k)) / 10_000);
  return `#${[c, m, y].map((ink) => channel(ink).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/**
 * A Pantone code as Pantone writes it: `PANTONE 185 C`, `PANTONE Warm Red C`,
 * `PANTONE 18-1663 TCX`.
 *
 * Accepts the prefixes people type (`Pantone`, `PMS`, none at all) and a
 * suffix run into the number (`185C`). The code is not looked up: GRIDGO has
 * no Pantone list, so any well-formed code is kept as text.
 */
export function parsePantone(value) {
  if (typeof value !== "string" || value.length > 80) return null;
  let body = value.normalize("NFKC").replace(/[®™]/g, " ").trim().replace(/\s+/g, " ");
  body = body.replace(/^(?:pantone|pms)(?![a-z])\.?\s*/i, "");
  if (!body || body.length > MAX_PANTONE || !/^[A-Za-z0-9][A-Za-z0-9 \-./]*$/.test(body)) return null;
  // A hex value typed in the wrong box is not a Pantone code.
  if (/^(?=.*[a-f])[0-9a-f]{6}$/i.test(body)) return null;
  // A suffix written against the number: 185C, 18-1663TCX.
  body = body.replace(/^([\d][\d\-]*)([A-Za-z]+)$/, "$1 $2");
  const words = body.split(" ").map((word) => {
    if (PANTONE_SUFFIXES.has(word.toUpperCase())) return word.toUpperCase();
    if (/^[A-Za-z]+$/.test(word)) return word[0].toUpperCase() + word.slice(1).toLowerCase();
    return word.toUpperCase();
  });
  // A code is more than a guide letter: "C" alone names no colour.
  if (!words.some((word) => /\d/.test(word) || (/^[A-Za-z]+$/.test(word) && !PANTONE_SUFFIXES.has(word.toUpperCase())))) return null;
  return `PANTONE ${words.join(" ")}`;
}

function label(value, field) {
  if (typeof value !== "string" || !value.trim()) invalid(field, "Give each colour a short label, such as Logo red.", "label_required");
  if ([...value.trim()].length > MAX_LABEL) invalid(field, `Colour labels are at most ${MAX_LABEL} characters.`, "label_too_long");
  if (/[\u0000-\u001f\u007f]/.test(value)) invalid(field, "Colour labels are plain text.", "label_invalid");
  const masked = specialInstructions(value);
  if ([...masked].length > MAX_LABEL) invalid(field, `Colour labels are at most ${MAX_LABEL} characters.`, "label_too_long");
  return masked;
}

/** One target, normalised. Throws `400 invalid_color_targets` naming the field. */
export function parseColorTarget(value, index = 0) {
  const at = `colorTargets[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(at, "Each colour is an object with a label and one value.", "not_an_object");
  const allowed = new Set(["label", "pantone", "cmyk", "hex", "approximateHex"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) invalid(`${at}.${unknown}`, "Each colour has a label and one of pantone, cmyk or hex.", "unknown_field");
  const formats = ["pantone", "cmyk", "hex"].filter((key) => value[key] != null);
  if (formats.length !== 1) invalid(at, "Give each colour exactly one of a Pantone code, CMYK values or a hex value.", "one_format_required");
  const [format] = formats;
  const name = label(value.label, `${at}.label`);
  if (value.approximateHex != null && format !== "pantone") {
    invalid(`${at}.approximateHex`, "Only a Pantone colour takes an approximate hex; CMYK and hex already have a swatch.", "approximate_hex_not_allowed");
  }

  if (format === "pantone") {
    const code = parsePantone(value.pantone);
    if (!code) invalid(`${at}.pantone`, "Type a Pantone code, such as 185 C or PANTONE 18-1663 TCX.", "pantone_invalid");
    let swatchHex = null;
    if (value.approximateHex != null) {
      swatchHex = parseHex(value.approximateHex);
      if (!swatchHex) invalid(`${at}.approximateHex`, "Type the approximate colour as a hex value, such as #E4002B.", "hex_invalid");
    }
    return { label: name, format, value: code, cmyk: null, hex: null, swatchHex, swatchApproximate: swatchHex ? true : null };
  }
  if (format === "cmyk") {
    const cmyk = parseCmyk(value.cmyk);
    if (!cmyk) invalid(`${at}.cmyk`, "Type CMYK as four whole percentages from 0 to 100, such as C0 M100 Y65 K34.", "cmyk_invalid");
    return { label: name, format, value: formatCmyk(cmyk), cmyk, hex: null, swatchHex: cmykSwatchHex(cmyk), swatchApproximate: true };
  }
  const hex = parseHex(value.hex);
  if (!hex) invalid(`${at}.hex`, "Type a hex colour, such as #1A5FB4.", "hex_invalid");
  return { label: name, format, value: hex, cmyk: null, hex, swatchHex: hex, swatchApproximate: false };
}

/**
 * A cart line's `colorTargets`: an array of at most eight, or `null`/`[]` to
 * clear. Returns the normalised list (`[]` for none).
 */
export function parseColorTargets(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) invalid("colorTargets", "colorTargets is a list of colours.", "not_a_list");
  if (value.length > MAX_COLOR_TARGETS) invalid("colorTargets", `Name at most ${MAX_COLOR_TARGETS} exact colours.`, "too_many");
  return value.map((target, index) => parseColorTarget(target, index));
}

/** The targets a line or order line carries, as every read returns them. */
export function colorTargetsFor(line) {
  const targets = Array.isArray(line?.colorTargets) ? line.colorTargets
    : Array.isArray(line?.colorTargets?.targets) ? line.colorTargets.targets : [];
  return structuredClone(targets);
}

/** The immutable order-line record, or null when the client named no colours. */
export function colorTargetsSnapshot(line) {
  const targets = Array.isArray(line?.colorTargets) ? line.colorTargets : [];
  return targets.length ? { version: 1, targets: structuredClone(targets) } : null;
}

/** What a file read before colour reading existed says about its colours. */
const NOT_READ = Object.freeze({ version: 1, status: "unknown", reasons: ["not_read_at_upload"], colors: [] });

/**
 * The colours each uploaded artwork file uses, beside the targets. Read from
 * the upload (`file.detected.colors`); a file uploaded before colours were
 * read says unknown rather than being read again.
 */
export function artworkColorsFor(store, fileIds) {
  return [...new Set(fileIds || [])].map((fileId) => {
    const file = (store?.files || []).find((row) => row.fileId === fileId);
    return { fileId, colors: structuredClone(file?.detected?.colors ?? NOT_READ) };
  });
}
