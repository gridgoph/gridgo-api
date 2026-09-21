import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { inspectArtwork, namePageSize, orientationOf } from "../src/artwork-inspection.js";

/** A minimal but structurally real PDF: a page tree with a box and a count. */
function pdf({ box = "0 0 595.276 841.89", count = 1 } = {}) {
  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj",
      `2 0 obj<</Type /Pages /Kids [3 0 R] /Count ${count} /MediaBox [${box}]>>endobj`,
      "3 0 obj<</Type /Page /Parent 2 0 R>>endobj",
      "trailer<</Root 1 0 R>>",
      "%%EOF",
    ].join("\n"),
    "latin1",
  );
}

/** The same page tree, hidden in a deflated stream the way real producers write it. */
function compressedPdf({ count = 12 } = {}) {
  const hidden = zlib.deflateSync(
    Buffer.from("<</Type /Pages /Count " + count + " /MediaBox [0 0 841.89 1190.55]>>", "latin1"),
  );
  return Buffer.concat([
    Buffer.from("%PDF-1.5\n4 0 obj<</Filter/FlateDecode/Length 99>>stream\n", "latin1"),
    hidden,
    Buffer.from("\nendstream endobj\ntrailer<<>>\n%%EOF", "latin1"),
  ]);
}

/**
 * A 30-page tree whose `/Kids` array pushes `/Count` far from `/Type /Pages`.
 *
 * The old scanner only looked 512 characters either side of the type, which
 * is shorter than a real Kids list, so a thirty-page document reported
 * nothing and was billed as one page.
 */
function wideKidsPdf({ count = 30 } = {}) {
  const kids = Array.from({ length: count }, (_, i) => `                    ${10 + i} 0 R`).join("");
  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj",
      `2 0 obj<</Type /Pages /Kids [${kids}] /Count ${count} /MediaBox [0 0 595.276 841.89]>>endobj`,
      "trailer<</Root 1 0 R>>",
      "%%EOF",
    ].join("\n"),
    "latin1",
  );
}

/** PNG Up predictor, the usual `/Predictor 12` object-stream shape. */
function encodePngUp(plain, columns) {
  const padded = Buffer.alloc(Math.ceil(plain.length / columns) * columns);
  plain.copy(padded);
  const rows = [];
  let prior = Buffer.alloc(columns);
  for (let i = 0; i < padded.length; i += columns) {
    const row = padded.subarray(i, i + columns);
    const out = Buffer.alloc(1 + columns);
    out[0] = 2;
    for (let x = 0; x < columns; x += 1) {
      out[1 + x] = (row[x] - prior[x]) & 0xff;
    }
    prior = Buffer.from(row);
    rows.push(out);
  }
  return Buffer.concat(rows);
}

/**
 * A page tree inside a predicted Flate stream.
 *
 * Inflating alone leaves filter bytes and deltas. Without undoing the
 * predictor this file has no readable `/Count`, which is how a Word export
 * used to land as an unread page count.
 */
function predictedPdf({ count = 30 } = {}) {
  const columns = 16;
  const hidden = Buffer.from(
    `<</Type /Pages /Count ${count} /MediaBox [0 0 595.276 841.89]>>`,
    "latin1",
  );
  const deflated = zlib.deflateSync(encodePngUp(hidden, columns));
  const dict =
    `<</Filter/FlateDecode/DecodeParms<</Predictor 12/Columns ${columns}` +
    `/Colors 1/BitsPerComponent 8>>/Length ${deflated.length}>>`;
  return Buffer.concat([
    Buffer.from(`%PDF-1.5\n4 0 obj${dict}stream\n`, "latin1"),
    deflated,
    Buffer.from("\nendstream endobj\ntrailer<<>>\n%%EOF", "latin1"),
  ]);
}

/** `/Count` is an indirect reference. The object number is not a page count. */
function indirectCountPdf() {
  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj",
      "2 0 obj<</Type /Pages /Kids [3 0 R] /Count 4 0 R /MediaBox [0 0 595.276 841.89]>>endobj",
      "4 0 obj\n30\nendobj",
      "trailer<</Root 1 0 R>>",
      "%%EOF",
    ].join("\n"),
    "latin1",
  );
}

function png({ width, height, perMetre = null }) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  const chunks = [signature, ihdr];
  if (perMetre != null) {
    const phys = Buffer.alloc(21);
    phys.writeUInt32BE(9, 0);
    phys.write("pHYs", 4, "latin1");
    phys.writeUInt32BE(perMetre, 8);
    phys.writeUInt32BE(perMetre, 12);
    phys[16] = 1;
    chunks.push(phys);
  }
  const idat = Buffer.alloc(12);
  idat.write("IDAT", 4, "latin1");
  chunks.push(idat);
  return Buffer.concat(chunks);
}

function jpeg({ width, height, unit = 1, density = 300 }) {
  const jfif = Buffer.alloc(18);
  jfif.writeUInt16BE(0xffe0, 0);
  jfif.writeUInt16BE(16, 2);
  jfif.write("JFIF\0", 4, "latin1");
  jfif[11] = unit;
  jfif.writeUInt16BE(density, 12);
  jfif.writeUInt16BE(density, 14);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, sof, Buffer.from([0xff, 0xd9])]);
}

test("an A4 PDF is read as A4 from its own page box", () => {
  const read = inspectArtwork(pdf(), "application/pdf");
  assert.equal(read.pageSize, "A4");
  assert.equal(read.orientation, "portrait");
  assert.equal(read.measureUnit, "mm");
  assert.equal(read.pageCount, 1);
  // 595.276pt at 25.4/72 mm per point, in thousandths of a millimetre.
  assert.equal(read.widthMilli, 210000);
  assert.equal(read.heightMilli, 297000);
});

test("a landscape page is still named by its size", () => {
  const read = inspectArtwork(pdf({ box: "0 0 841.89 595.276" }), "application/pdf");
  assert.equal(read.pageSize, "A4");
  assert.equal(read.orientation, "landscape");
});

test("the page count comes from the page tree, not from every /Count in the file", () => {
  // An outline with more entries than the document has pages. Counting every
  // /Count would report 99 pages for a three-page booklet.
  const withOutline = Buffer.concat([
    pdf({ count: 3 }),
    Buffer.from("\n9 0 obj<</Type /Outlines /Count 99>>endobj\n", "latin1"),
  ]);
  assert.equal(inspectArtwork(withOutline, "application/pdf").pageCount, 3);
});

test("a page tree inside a compressed stream is still read", () => {
  // The shape Word and LibreOffice produce. Without inflating, this file
  // reports nothing at all and the client types their own page size.
  const read = inspectArtwork(compressedPdf({ count: 12 }), "application/pdf");
  assert.equal(read.pageCount, 12);
  assert.equal(read.pageSize, "A3");
});

test("a long Kids array does not hide the page count", () => {
  const read = inspectArtwork(wideKidsPdf({ count: 30 }), "application/pdf");
  assert.equal(read.pageCount, 30);
  assert.equal(read.pageSize, "A4");
});

test("a predicted object stream still yields its page count", () => {
  const read = inspectArtwork(predictedPdf({ count: 30 }), "application/pdf");
  assert.equal(read.pageCount, 30);
  assert.equal(read.pageSize, "A4");
});

test("an indirect /Count is not treated as a page count", () => {
  // Resolving `4 0 R` to 30 would be guessing; reading the object number 4
  // as the count would be worse. Leave it unread.
  const read = inspectArtwork(indirectCountPdf(), "application/pdf");
  assert.equal(read.pageCount, null);
  assert.equal(read.pageSize, "A4");
});

test("a PNG at 300 DPI works out to the paper it fills", () => {
  // 2480x3508 at 300 DPI is A4, which is the single most common artwork upload.
  const read = inspectArtwork(png({ width: 2480, height: 3508, perMetre: 11811 }), "image/png");
  assert.equal(read.dpi, 300);
  assert.equal(read.pageSize, "A4");
  assert.equal(read.pixelWidth, 2480);
});

test("a raster with no declared density reports pixels and no size", () => {
  // Pixels are not a size. Assuming 72 DPI here would hand back an A4 default
  // for a small logo and it would be believed.
  const read = inspectArtwork(png({ width: 400, height: 400 }), "image/png");
  assert.equal(read.pixelWidth, 400);
  assert.equal(read.dpi, null);
  assert.equal(read.widthMilli, null);
  assert.equal(read.pageSize, null);
  assert.equal(read.measureUnit, null);
});

test("a JPEG's frame and JFIF density are both read", () => {
  const read = inspectArtwork(jpeg({ width: 1200, height: 1800, density: 150 }), "image/jpeg");
  assert.equal(read.dpi, 150);
  assert.equal(read.pixelWidth, 1200);
  assert.equal(read.widthMilli, 203200);
  assert.equal(read.pageCount, 1);
});

test("JFIF's aspect-ratio unit is not mistaken for a density", () => {
  // Unit 0 means the two numbers are a pixel aspect ratio. Reading it as DPI
  // is how a 1:1 image acquires a physical size it never claimed.
  const read = inspectArtwork(jpeg({ width: 800, height: 600, unit: 0, density: 1 }), "image/jpeg");
  assert.equal(read.dpi, null);
  assert.equal(read.widthMilli, null);
});

test("A4 and Letter are not confused for each other", () => {
  // Six millimetres apart across, eighteen down. A loose tolerance collapses
  // the two sizes a Davao shop is most often asked for.
  assert.equal(namePageSize(210000, 297000), "A4");
  assert.equal(namePageSize(215900, 279400), "Letter");
});

test("an unrecognised size is left unnamed rather than rounded to the nearest", () => {
  assert.equal(namePageSize(500000, 700000), null);
  assert.equal(orientationOf(300000, 300000), "square");
});

test("a file that cannot be read is not an upload failure", () => {
  assert.equal(inspectArtwork(Buffer.from("not a document at all"), "application/pdf"), null);
  assert.equal(inspectArtwork(Buffer.alloc(4), "image/png"), null);
  assert.equal(inspectArtwork(png({ width: 10, height: 10 }), "image/webp"), null);
});
