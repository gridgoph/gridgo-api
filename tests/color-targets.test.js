import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import {
  MAX_COLOR_TARGETS, artworkColorsFor, cmykSwatchHex, colorTargetsSnapshot, parseCmyk, parseColorTarget, parseColorTargets, parseHex, parsePantone,
} from "../src/color-targets.js";
import { readArtworkColors, readPdfColors, readPngColors } from "../src/artwork-colors.js";
import { readArtworkMeasurements } from "../src/attachments.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const invalid = (field, reason) => (error) => error.status === 400 && error.code === "invalid_color_targets"
  && error.details.field === field && (!reason || error.details.reason === reason);

test("hex: three or six digits, any case, with or without the hash, become #RRGGBB", () => {
  assert.equal(parseHex("#1a5fb4"), "#1A5FB4");
  assert.equal(parseHex("1A5FB4"), "#1A5FB4");
  assert.equal(parseHex(" #abc "), "#AABBCC");
  assert.equal(parseHex("fff"), "#FFFFFF");
  for (const bad of ["#1A5FB", "#1A5FB4FF", "#GGGGGG", "rgb(1,2,3)", "", "#", 0x1a5fb4, null]) assert.equal(parseHex(bad), null, String(bad));
});

test("CMYK: an object or typed text of four whole percentages", () => {
  const maroon = { c: 0, m: 100, y: 65, k: 34 };
  assert.deepEqual(parseCmyk(maroon), maroon);
  for (const typed of ["0 100 65 34", "0,100,65,34", "0, 100, 65, 34", "0/100/65/34", "0% 100% 65% 34%", "cmyk(0%, 100%, 65%, 34%)",
    "C0 M100 Y65 K34", "c:0 m:100 y:65 k:34", "K34 C0 Y65 M100", "C=0 M=100 Y=65 K=34"]) {
    assert.deepEqual(parseCmyk(typed), maroon, typed);
  }
  for (const bad of ["0 100 65", "0 100 65 34 10", "0 101 65 34", "0 100 65 -1", "0 99.5 65 34", "C0 M100 Y65", "C0 M100 Y65 Y34",
    "C0 M100 Y65 K34 extra", "cyan", { c: 0, m: 100, y: 65 }, { c: 0, m: 100, y: 65, k: 34, extra: 1 }, { c: "0", m: 100, y: 65, k: 34 },
    { c: 0.5, m: 100, y: 65, k: 34 }, [0, 100, 65, 34], null]) {
    assert.equal(parseCmyk(bad), null, JSON.stringify(bad));
  }
  // The formula swatch, for the screen only.
  assert.equal(cmykSwatchHex({ c: 0, m: 0, y: 0, k: 0 }), "#FFFFFF");
  assert.equal(cmykSwatchHex({ c: 0, m: 0, y: 0, k: 100 }), "#000000");
  assert.equal(cmykSwatchHex({ c: 100, m: 0, y: 100, k: 0 }), "#00FF00");
  assert.equal(cmykSwatchHex(maroon), "#A8003B");
});

test("Pantone: prefixes, run-together suffixes and named colours normalise to PANTONE <code>", () => {
  const cases = {
    "185 C": "PANTONE 185 C", "185C": "PANTONE 185 C", "pantone 185c": "PANTONE 185 C", "PMS 185 C": "PANTONE 185 C",
    "PMS185C": "PANTONE 185 C", "Pantone® 286 U": "PANTONE 286 U", "  PANTONE   7621  C ": "PANTONE 7621 C",
    "warm red c": "PANTONE Warm Red C", "REFLEX BLUE C": "PANTONE Reflex Blue C", "Cool Gray 11 C": "PANTONE Cool Gray 11 C",
    "18-1663 TCX": "PANTONE 18-1663 TCX", "18-1663tpx": "PANTONE 18-1663 TPX", "P 115-8 C": "PANTONE P 115-8 C", "871 C": "PANTONE 871 C",
  };
  for (const [typed, expected] of Object.entries(cases)) assert.equal(parsePantone(typed), expected, typed);
  for (const bad of ["", "PANTONE", "C", "pms", "#185C00", "E4002B", "185 <C>", "185; DROP", "a".repeat(41), 185, null]) {
    assert.equal(parsePantone(bad), null, String(bad));
  }
});

test("a target has a label and exactly one format, normalised with its swatch", () => {
  assert.deepEqual(parseColorTarget({ label: " School maroon ", pantone: "201c", approximateHex: "#9d2235" }), {
    label: "School maroon", format: "pantone", value: "PANTONE 201 C", cmyk: null, hex: null, swatchHex: "#9D2235", swatchApproximate: true,
  });
  // GRIDGO has no Pantone table, so without the client's hex there is no swatch.
  assert.deepEqual(parseColorTarget({ label: "Gold", pantone: "871 C" }), {
    label: "Gold", format: "pantone", value: "PANTONE 871 C", cmyk: null, hex: null, swatchHex: null, swatchApproximate: null,
  });
  assert.deepEqual(parseColorTarget({ label: "Brand red", cmyk: "C0 M100 Y65 K34" }), {
    label: "Brand red", format: "cmyk", value: "C0 M100 Y65 K34", cmyk: { c: 0, m: 100, y: 65, k: 34 }, hex: null, swatchHex: "#A8003B", swatchApproximate: true,
  });
  assert.deepEqual(parseColorTarget({ label: "Logo blue", hex: "1a5fb4" }), {
    label: "Logo blue", format: "hex", value: "#1A5FB4", cmyk: null, hex: "#1A5FB4", swatchHex: "#1A5FB4", swatchApproximate: false,
  });

  assert.throws(() => parseColorTarget({ label: "Two", hex: "#fff", cmyk: "0 0 0 0" }, 2), invalid("colorTargets[2]", "one_format_required"));
  assert.throws(() => parseColorTarget({ label: "None" }), invalid("colorTargets[0]", "one_format_required"));
  assert.throws(() => parseColorTarget({ hex: "#fff" }), invalid("colorTargets[0].label", "label_required"));
  assert.throws(() => parseColorTarget({ label: "   ", hex: "#fff" }), invalid("colorTargets[0].label", "label_required"));
  assert.throws(() => parseColorTarget({ label: "x".repeat(41), hex: "#fff" }), invalid("colorTargets[0].label", "label_too_long"));
  assert.throws(() => parseColorTarget({ label: "Tab\there", hex: "#fff" }), invalid("colorTargets[0].label", "label_invalid"));
  assert.throws(() => parseColorTarget({ label: "Blue", hex: "#12345" }), invalid("colorTargets[0].hex", "hex_invalid"));
  assert.throws(() => parseColorTarget({ label: "Red", cmyk: "0 100 65" }), invalid("colorTargets[0].cmyk", "cmyk_invalid"));
  assert.throws(() => parseColorTarget({ label: "Red", pantone: "C" }), invalid("colorTargets[0].pantone", "pantone_invalid"));
  assert.throws(() => parseColorTarget({ label: "Red", pantone: "185 C", approximateHex: "red" }), invalid("colorTargets[0].approximateHex", "hex_invalid"));
  assert.throws(() => parseColorTarget({ label: "Red", hex: "#f00", approximateHex: "#f00" }), invalid("colorTargets[0].approximateHex", "approximate_hex_not_allowed"));
  assert.throws(() => parseColorTarget({ label: "Red", hex: "#f00", rgb: "255 0 0" }), invalid("colorTargets[0].rgb", "unknown_field"));
  assert.throws(() => parseColorTarget("red"), invalid("colorTargets[0]", "not_an_object"));
  // Contact details in a label are masked like special instructions.
  assert.equal(parseColorTarget({ label: "call 09171234567", hex: "#fff" }).label, "call [masked]");
});

test("a line takes at most eight targets; null or [] means none", () => {
  assert.deepEqual(parseColorTargets(null), []);
  assert.deepEqual(parseColorTargets([]), []);
  const eight = Array.from({ length: MAX_COLOR_TARGETS }, (_, index) => ({ label: `Colour ${index + 1}`, hex: "#123456" }));
  assert.equal(parseColorTargets(eight).length, 8);
  assert.throws(() => parseColorTargets([...eight, { label: "Ninth", hex: "#000" }]), invalid("colorTargets", "too_many"));
  assert.throws(() => parseColorTargets({ label: "Not a list", hex: "#000" }), invalid("colorTargets", "not_a_list"));
  assert.throws(() => parseColorTargets([{ label: "Fine", hex: "#000" }, { label: "Bad", hex: "#00" }]), invalid("colorTargets[1].hex"));
  assert.equal(colorTargetsSnapshot({}), null);
  assert.deepEqual(colorTargetsSnapshot({ colorTargets: parseColorTargets([{ label: "Logo", hex: "#000" }]) }).version, 1);
});

/* ---------------------------------------------------------------------------
 * Colours read from the file.
 * ------------------------------------------------------------------------- */

/** A one-page PDF with the given objects after the catalog, page tree and page. */
function pdf({ content, resources = "<< >>", objects = [], deflate = false }) {
  const stream = deflate ? zlib.deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const parts = [
    Buffer.from("%PDF-1.7\n1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj\n2 0 obj<</Type /Pages /Kids [3 0 R] /Count 1>>endobj\n"
      + `3 0 obj<</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents 4 0 R>>endobj\n`
      + `4 0 obj<</Length ${stream.length}${deflate ? " /Filter /FlateDecode" : ""}>>stream\n`, "latin1"),
    stream,
    Buffer.from(`\nendstream\nendobj\n${objects.join("\n")}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, "latin1"),
  ];
  return Buffer.concat(parts);
}

const byKind = (result, kind) => result.colors.filter((color) => color.kind === kind);

test("PDF: a named spot colour with a type 2 alternate, and the process colours the page sets", () => {
  const file = pdf({
    resources: "<< /ColorSpace << /CS0 5 0 R /CS1 [/ICCBased 7 0 R] >> >>",
    content: "/CS0 cs 1 scn 0 0 100 100 re f\n0 0.5 1 0 k 0 100 100 100 re f\n0.102 0.373 0.706 rg 100 0 50 50 re f\n0.2 G 1 w 0 0 m 10 10 l S\n/CS1 cs 0 1 0.65 0.34 scn 5 5 5 5 re f\n0 0.5 1 0 k 1 1 1 1 re f",
    objects: [
      "5 0 obj[/Separation /PANTONE#20185#20C /DeviceCMYK 6 0 R]endobj",
      "6 0 obj<</FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.91 0.76 0.06] /N 1>>endobj",
      "7 0 obj<</N 4 /Length 0>>stream\n\nendstream\nendobj",
    ],
    deflate: true,
  });
  const read = readPdfColors(file);
  assert.equal(read.status, "read");
  assert.deepEqual(read.reasons, []);
  assert.deepEqual(byKind(read, "spot"), [
    { kind: "spot", name: "PANTONE 185 C", space: "cmyk", cmyk: { c: 0, m: 91, y: 76, k: 6 }, hex: "#F0163A", uses: 1, shareBps: null },
  ]);
  assert.deepEqual(byKind(read, "process").map(({ space, cmyk, hex, uses }) => ({ space, cmyk, hex, uses })), [
    // Most used first; ties by hex so the order is stable.
    { space: "cmyk", cmyk: { c: 0, m: 50, y: 100, k: 0 }, hex: "#FF8000", uses: 2 },
    { space: "rgb", cmyk: null, hex: "#1A5FB4", uses: 1 },
    { space: "gray", cmyk: null, hex: "#333333", uses: 1 },
    { space: "cmyk", cmyk: { c: 0, m: 100, y: 65, k: 34 }, hex: "#A8003B", uses: 1 },
  ]);
});

test("PDF: a calculator tint function is evaluated for the spot alternate; one with branches is not", () => {
  const calculator = (program) => pdf({
    resources: "<< /ColorSpace << /CS0 [/Separation /Varnish /DeviceCMYK 6 0 R] >> >>",
    content: "/CS0 cs 1 scn 0 0 10 10 re f",
    objects: [`6 0 obj<</FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1 0 1] /Length ${program.length}>>stream\n${program}\nendstream\nendobj`],
  });
  const evaluated = byKind(readPdfColors(calculator("{0.0 exch dup 0.91 mul exch dup 0.76 mul exch 0.06 mul}")), "spot")[0];
  assert.deepEqual(evaluated.cmyk, { c: 0, m: 91, y: 76, k: 6 });
  const branching = byKind(readPdfColors(calculator("{dup 0.5 gt {pop 1} {pop 0} ifelse 0 0 0}")), "spot")[0];
  assert.equal(branching.name, "Varnish");
  assert.equal(branching.space, "cmyk");
  assert.equal(branching.cmyk, null);
  assert.equal(branching.hex, null);
});

test("PDF: spot colours declared inside a compressed object stream and through DeviceN are found", () => {
  const objects = "5 0 [/Separation /CutContour /DeviceRGB << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [1 0 1] /N 1 >>]";
  const header = "5 0 ";
  const body = Buffer.from(`${header}${objects.slice(header.length)}`, "latin1");
  const packed = zlib.deflateSync(body);
  const file = Buffer.concat([
    pdf({ resources: "<< /ColorSpace << /CS0 5 0 R /N0 [/DeviceN [/PANTONE#20286#20C /Black] /DeviceCMYK 9 0 R] >> >>", content: "/CS0 cs 1 scn 0 0 1 1 re f" }),
    Buffer.from(`8 0 obj<</Type /ObjStm /N 1 /First ${header.length} /Length ${packed.length} /Filter /FlateDecode>>stream\n`, "latin1"),
    packed,
    Buffer.from("\nendstream\nendobj\n", "latin1"),
  ]);
  const spots = byKind(readPdfColors(file), "spot");
  assert.deepEqual(spots.map(({ name, hex, uses }) => ({ name, hex, uses })), [
    { name: "CutContour", hex: "#FF00FF", uses: 1 },
    { name: "PANTONE 286 C", hex: null, uses: 0 },
  ]);
});

test("PDF: text painted before any colour is set is black, as every page starts", () => {
  const read = readPdfColors(pdf({ content: "BT /F1 12 Tf 72 720 Td (Hello 1 0 0 rg) Tj ET" }));
  assert.equal(read.status, "read");
  assert.deepEqual(read.colors.map(({ space, hex }) => ({ space, hex })), [{ space: "gray", hex: "#000000" }]);
});

test("PDF: placed pictures and unresolved colour spaces make the read partial, never guessed", () => {
  const withImage = readPdfColors(Buffer.concat([
    pdf({ content: "0.5 g 0 0 1 1 re f q 10 0 0 10 0 0 cm /Im0 Do Q" }),
    Buffer.from("9 0 obj<</Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3>>stream\nÿ\u0000\u0000\nendstream\nendobj\n", "latin1"),
  ]));
  assert.equal(withImage.status, "partial");
  assert.deepEqual(withImage.reasons, ["embedded_images_not_read"]);
  assert.deepEqual(withImage.colors.map((color) => color.hex), ["#808080"]);

  // Inline image bytes are stepped over, not read as operators.
  const inline = readPdfColors(pdf({ content: "1 0 0 rg 0 0 1 1 re f BI /W 4 /H 1 /CS /RGB /BPC 8 ID \n0 0 1 rg 0 1 0 rg  EI 0 0 1 RG 0 0 m 1 1 l S" }));
  assert.equal(inline.status, "partial");
  assert.deepEqual(inline.colors.map((color) => color.hex), ["#0000FF", "#FF0000"]);

  const lab = readPdfColors(pdf({ resources: "<< /ColorSpace << /CS0 [/Lab << /WhitePoint [0.95 1 1.09] >>] >> >>", content: "/CS0 cs 50 20 30 scn 0 0 1 1 re f 1 g 0 0 1 1 re f" }));
  assert.equal(lab.status, "partial");
  assert.deepEqual(lab.reasons, ["colour_space_not_read"]);
  assert.deepEqual(lab.colors.map((color) => color.hex), ["#FFFFFF"]);
});

test("PDF: a file that names no colour and paints nothing is unknown", () => {
  const read = readPdfColors(pdf({ content: "q Q" }));
  assert.deepEqual(read, { version: 1, status: "unknown", reasons: ["no_colours_declared"], colors: [] });
  const truncated = readPdfColors(pdf({ content: "1 0 0 rg 0 0 1 1 re f" }), { complete: false });
  assert.equal(truncated.status, "partial");
  assert.deepEqual(truncated.reasons, ["file_larger_than_inspection_window"]);
});

/** CRC-32 for PNG chunks. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])));
  return Buffer.concat([head, data, crc]);
}

/** Encode raw scanlines with one filter type per row, so every unfilter path is exercised. */
function png({ width, height, type = 2, depth = 8, rows, filters = [0], plte = null, trns = null }) {
  const bpp = Math.max(1, Math.ceil(({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type] * depth) / 8));
  let prior = Buffer.alloc(rows[0].length);
  const encoded = rows.map((row, y) => {
    const filter = filters[y % filters.length];
    const out = Buffer.alloc(row.length + 1);
    out[0] = filter;
    for (let i = 0; i < row.length; i += 1) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prior[i];
      const upLeft = i >= bpp ? prior[i - bpp] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      if (filter === 2) predicted = up;
      if (filter === 3) predicted = (left + up) >> 1;
      if (filter === 4) {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[i + 1] = (row[i] - predicted) & 0xff;
    }
    prior = row;
    return out;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = type;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(plte ? [chunk("PLTE", plte)] : []),
    ...(trns ? [chunk("tRNS", trns)] : []),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(encoded))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A deterministic scatter of three brand colours, so every filter predicts from differing neighbours. */
function scatter(width, height) {
  const palette = [[0x9d, 0x22, 0x35], [0x1a, 0x5f, 0xb4], [0xff, 0xff, 0xff]];
  const counts = [0, 0, 0];
  let seed = 7;
  const rows = Array.from({ length: height }, () => Buffer.from(Array.from({ length: width }, () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const index = seed % 10 < 5 ? 0 : seed % 10 < 8 ? 1 : 2;
    counts[index] += 1;
    return palette[index];
  }).flat()));
  return { rows, counts, total: width * height };
}

test("PNG: every scanline filter decodes to the same dominant colours", async () => {
  const { rows, counts, total } = scatter(37, 23);
  const expected = [["#9D2235", counts[0]], ["#1A5FB4", counts[1]], ["#FFFFFF", counts[2]]]
    .sort((a, b) => b[1] - a[1]).map(([hex, count]) => ({ hex, shareBps: Math.floor((count * 10_000) / total) }));
  for (const filters of [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4]]) {
    const read = await readPngColors(png({ width: 37, height: 23, rows, filters }));
    assert.equal(read.status, "read", String(filters));
    assert.deepEqual(read.colors.map(({ hex, shareBps }) => ({ hex, shareBps })), expected, `filters ${filters}`);
    assert.ok(read.colors.every((color) => color.kind === "pixels" && color.space === "rgb"));
  }
});

test("PNG: palette, grey, 16-bit and transparency are read; transparent pixels do not count", async () => {
  // Two-bit palette, four pixels per byte: index 0 maroon, 1 blue, 2 fully transparent.
  const palette = await readPngColors(png({
    width: 8, height: 2, type: 3, depth: 2, plte: Buffer.from([0x9d, 0x22, 0x35, 0x1a, 0x5f, 0xb4, 0, 0, 0]), trns: Buffer.from([255, 255, 0]),
    rows: [Buffer.from([0b00000001, 0b10101010]), Buffer.from([0b00000000, 0b01010101])],
  }));
  assert.deepEqual(palette.colors.map(({ hex, shareBps }) => ({ hex, shareBps })), [{ hex: "#9D2235", shareBps: 5833 }, { hex: "#1A5FB4", shareBps: 4166 }]);

  const grey16 = await readPngColors(png({ width: 2, height: 1, type: 0, depth: 16, rows: [Buffer.from([0x80, 0x00, 0x80, 0xff])] }));
  assert.deepEqual(grey16.colors.map(({ hex, shareBps }) => ({ hex, shareBps })), [{ hex: "#808080", shareBps: 10_000 }]);

  const rgba = await readPngColors(png({ width: 2, height: 1, type: 6, rows: [Buffer.from([255, 0, 0, 255, 0, 0, 255, 0])] }));
  assert.deepEqual(rgba.colors.map(({ hex, shareBps }) => ({ hex, shareBps })), [{ hex: "#FF0000", shareBps: 10_000 }]);

  const clear = await readPngColors(png({ width: 2, height: 1, type: 6, rows: [Buffer.from([255, 0, 0, 0, 0, 0, 255, 0])] }));
  assert.deepEqual(clear, { version: 1, status: "unknown", reasons: ["no_opaque_pixels"], colors: [] });
});

test("PNG: an Adam7-interlaced file is read pass by pass", async () => {
  // 3 x 3 image, interlaced: pass 1 (0,0); pass 4 (2,0); pass 5 (0,2),(2,2); pass 6 (1,0) and (1,2) as two rows; pass 7 row 1.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(3, 0);
  ihdr.writeUInt32BE(3, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  ihdr[12] = 1;
  const passes = [[0, 10], [0, 10], [0, 10, 10], [0, 10], [0, 10], [0, 200, 200, 200]];
  const file = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from(passes.flat()))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const read = await readPngColors(file);
  assert.deepEqual(read.colors.map(({ hex, shareBps }) => ({ hex, shareBps })), [{ hex: "#0A0A0A", shareBps: 6666 }, { hex: "#C8C8C8", shareBps: 3333 }]);
});

test("PNG: a file cut off by the inspection window reads the rows it has, as partial", async () => {
  const { rows } = scatter(64, 64);
  const whole = png({ width: 64, height: 64, rows, filters: [4] });
  const read = await readPngColors(whole.subarray(0, whole.length - 400), { complete: false });
  assert.equal(read.status, "partial");
  assert.deepEqual(read.reasons, ["file_larger_than_inspection_window"]);
  assert.ok(read.colors.length >= 1);
});

test("types the API cannot read honestly say unknown", async () => {
  for (const type of ["image/jpeg", "image/webp", "image/vnd.adobe.photoshop", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]) {
    assert.deepEqual(await readArtworkColors(Buffer.from("not decoded"), type), { version: 1, status: "unknown", reasons: ["not_read_for_this_file_type"], colors: [] }, type);
  }
  assert.deepEqual((await readArtworkColors(Buffer.from("%PDF-1.4 garbage"), "application/pdf")).status, "unknown");
  assert.deepEqual((await readArtworkColors(Buffer.from("\x89PNG\r\n\x1a\n garbage"), "image/png")).status, "unknown");
});

test("files uploaded before colours were read say so beside the targets", () => {
  const store = { files: [
    { fileId: "new", detected: { colors: { version: 1, status: "read", reasons: [], colors: [{ kind: "pixels", hex: "#FFFFFF" }] } } },
    { fileId: "old", detected: { kind: "pdf" } },
  ] };
  assert.deepEqual(artworkColorsFor(store, ["new", "old", "new"]), [
    { fileId: "new", colors: { version: 1, status: "read", reasons: [], colors: [{ kind: "pixels", hex: "#FFFFFF" }] } },
    { fileId: "old", colors: { version: 1, status: "unknown", reasons: ["not_read_at_upload"], colors: [] } },
  ]);
});

test("the upload read stores the file's colours beside its measurements", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gridgo-colours-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tempPath = path.join(directory, "logo.png");
  const { rows } = scatter(16, 16);
  const bytes = png({ width: 16, height: 16, rows, filters: [4] });
  await fs.writeFile(tempPath, bytes);
  const detected = await readArtworkMeasurements({ tempPath, size: bytes.length }, "image/png", "artwork");
  assert.equal(detected.pixelWidth, 16);
  assert.equal(detected.colors.status, "read");
  assert.equal(detected.colors.colors[0].hex, "#9D2235");
  // Only artwork is read; a payment screenshot's colours are nobody's business.
  assert.equal(await readArtworkMeasurements({ tempPath, size: bytes.length }, "image/png", "payment_proof"), null);
});

test("hostile files cost bounded work and say why they stopped", async () => {
  const hostileStarted = Date.now();
  // A header claiming a row wider than any print file is refused before allocating it.
  const huge = png({ width: 1, height: 1, rows: [Buffer.from([1, 2, 3])] });
  huge.writeUInt32BE(0x7fffffff, 16);
  assert.deepEqual(await readPngColors(huge), { version: 1, status: "unknown", reasons: ["inspection_limit"], colors: [] });

  // Millions of colour operators: the walk stops at its token budget, reported as partial.
  const started = Date.now();
  const busy = readPdfColors(pdf({ content: "0.1 0.2 0.3 rg 0 0 1 1 re f ".repeat(200_000) }));
  assert.equal(busy.status, "partial");
  assert.deepEqual(busy.reasons, ["inspection_limit"]);
  assert.ok(Date.now() - started < 5_000);

  // Streams that each inflate to the limit and fail are charged for the attempt.
  const bomb = zlib.deflateSync(Buffer.alloc(32 * 1024 * 1024, 0x20));
  const bombs = Buffer.concat([pdf({ content: "1 0 0 rg 0 0 1 1 re f" }), ...Array.from({ length: 30 }, (_, index) => Buffer.concat([
    Buffer.from(`${20 + index} 0 obj<</Length ${bomb.length} /Filter /FlateDecode>>stream\n`, "latin1"), bomb, Buffer.from("\nendstream\nendobj\n", "latin1"),
  ]))]);
  const bombStarted = Date.now();
  const bombed = readPdfColors(bombs);
  assert.ok(bombed.reasons.includes("inspection_limit"));
  assert.ok(Date.now() - bombStarted < 3_000, `${Date.now() - bombStarted} ms`);

  // A file of tiny skipped streams stops at its visit budget.
  const tiny = Buffer.from(`%PDF-1.4\n${"1 0 obj<</Subtype /Image>>stream\nx\nendstream\n".repeat(300_000)}`, "latin1");
  const tinyStarted = Date.now();
  assert.ok(readPdfColors(tiny).reasons.includes("inspection_limit"));
  assert.ok(Date.now() - tinyStarted < 3_000, `${Date.now() - tinyStarted} ms`);

  // One large resource dictionary referenced from every page is walked once;
  // unclosed inline ones share a single scan budget.
  const shared = `5 0 obj<<${" /K [".repeat(3000)}>>endobj`;
  const references = readPdfColors(Buffer.from(`%PDF-1.4\n${shared}\n${"/ColorSpace 5 0 R ".repeat(200_000)}`, "latin1"));
  const inline = readPdfColors(Buffer.from(`%PDF-1.4\n${`/ColorSpace <<${" /K [".repeat(1000)} >> `.repeat(1000)}`, "latin1"));
  // The same object reached through differently written references, each key
  // pointing at one large array: resolved once, charged, and cut off.
  const big = `6 0 obj[/Indexed${" 0".repeat(7000)}]endobj`;
  const keys = `5 0 obj<<${Array.from({ length: 2500 }, (_, i) => ` /K${i} 6 0 R`).join("")}>>endobj`;
  const spellings = Array.from({ length: 1000 }, (_, i) => `/ColorSpace ${"0".repeat(i % 7)}5 ${i} R `).join("");
  const differential = Date.now();
  const respelled = readPdfColors(Buffer.from(`%PDF-1.4\n${big}\n${keys}\n${spellings}`, "latin1"));
  assert.equal(respelled.status, "unknown");
  assert.ok(Date.now() - differential < 3_000, `${Date.now() - differential} ms`);
  for (const read of [references, inline]) assert.equal(read.status, "unknown");
  assert.ok(inline.reasons.includes("inspection_limit"), inline.reasons.join());

  // An ASCII85 run of "z" (four zero bytes each) stops at the decode budget instead of growing without bound.
  const zeros = "z".repeat(15 * 1024 * 1024);
  const a85Started = Date.now();
  const a85 = readPdfColors(Buffer.from(`%PDF-1.4\n4 0 obj<</Length ${zeros.length} /Filter /ASCII85Decode>>stream\n${zeros}~>\nendstream\nendobj\n`, "latin1"));
  assert.ok(a85.reasons.includes("inspection_limit"), a85.reasons.join());
  assert.ok(Date.now() - a85Started < 3_000, `${Date.now() - a85Started} ms`);

  // A huge interlaced 1-bit image stops once enough pixels are sampled.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(40_000, 0);
  ihdr.writeUInt32BE(40_000, 4);
  ihdr[8] = 1;
  ihdr[9] = 0;
  ihdr[12] = 1;
  const rows = [];
  for (const [x0, dx, y0, dy] of [[0, 8, 0, 8], [4, 8, 0, 8], [0, 4, 4, 8], [2, 4, 0, 4]]) {
    const pixels = Math.ceil((40_000 - x0) / dx);
    const count = Math.ceil((40_000 - y0) / dy);
    const row = Buffer.alloc(1 + Math.ceil(pixels / 8), 0xff);
    row[0] = 0;
    for (let y = 0; y < count; y += 1) rows.push(row);
  }
  const interlaced = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)),
  ]);
  const pngStarted = Date.now();
  const sampled = await readPngColors(interlaced, { complete: true });
  assert.deepEqual(sampled.colors.map(({ hex, shareBps }) => ({ hex, shareBps })), [{ hex: "#FFFFFF", shareBps: 10_000 }]);
  assert.ok(Date.now() - pngStarted < 5_000, `${Date.now() - pngStarted} ms`);
  assert.ok(Date.now() - hostileStarted < 15_000, `${Date.now() - hostileStarted} ms in all`);
});
