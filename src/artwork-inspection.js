import zlib from "node:zlib";

/**
 * What the artwork itself says it is.
 *
 * A client uploading a poster knows what they drew but not always what to call
 * it, and asking them to measure their own PDF is asking them to do the one
 * thing the file has already done. The bytes carry the answer: a PDF states its
 * page box in points, and a raster image states its pixels and, usually, the
 * density it was authored at.
 *
 * Everything here is a suggestion the client can overrule. Detection is right
 * often enough to save the typing and wrong often enough that it must never be
 * the last word -- a scan at 96 DPI and the same scan at 300 DPI are the same
 * pixels and different pieces of paper, and only the person who made it knows
 * which. So a returned measurement is offered as a default and the screen keeps
 * the field editable.
 *
 * A file that says nothing returns nulls rather than a guess. A PDF with no
 * declared density is common; inventing 72 DPI for it would put A4 artwork on
 * a business card and be believed.
 */

/** Thousandths of a millimetre, matching the catalogue's measurement scale. */
const MILLI = 1000;

/** A PDF point is 1/72 inch, so one point is 25.4/72 mm exactly. */
const MM_PER_POINT = 25.4 / 72;

const MM_PER_INCH = 25.4;

/**
 * The paper a Davao print shop actually cuts to, portrait, in whole mm.
 *
 * Letter and Legal are the ISO-adjacent sizes people here still ask for by
 * name, so they are matched even though the metric series dominates.
 */
const NAMED_SIZES = Object.freeze([
  { name: "A3", width: 297, height: 420 },
  { name: "A4", width: 210, height: 297 },
  { name: "A5", width: 148, height: 210 },
  { name: "A6", width: 105, height: 148 },
  { name: "B5", width: 176, height: 250 },
  { name: "Letter", width: 216, height: 279 },
  { name: "Legal", width: 216, height: 356 },
  { name: "Tabloid", width: 279, height: 432 },
]);

/**
 * How far off a measurement may be and still be called by a name.
 *
 * Two millimetres. Wider than the rounding error between points and mm, and
 * narrower than the gap between any two sizes in the list -- A4 and Letter are
 * six millimetres apart across and eighteen down, which is exactly the pair a
 * loose tolerance would confuse.
 */
const NAME_TOLERANCE_MILLI = 2 * MILLI;

/** Round half away from zero, so no float reaches a stored measurement. */
function round(value) {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/**
 * The name for a physical size, if it has one.
 *
 * Matched against both orientations: A4 landscape is still A4, and a client
 * who drew a landscape flyer should not be told their page is unrecognised.
 */
export function namePageSize(widthMilli, heightMilli) {
  if (!Number.isFinite(widthMilli) || !Number.isFinite(heightMilli)) return null;
  const short = Math.min(widthMilli, heightMilli);
  const long = Math.max(widthMilli, heightMilli);
  for (const size of NAMED_SIZES) {
    if (
      Math.abs(short - size.width * MILLI) <= NAME_TOLERANCE_MILLI &&
      Math.abs(long - size.height * MILLI) <= NAME_TOLERANCE_MILLI
    ) {
      return size.name;
    }
  }
  return null;
}

export function orientationOf(widthMilli, heightMilli) {
  if (!Number.isFinite(widthMilli) || !Number.isFinite(heightMilli)) return null;
  if (widthMilli === heightMilli) return "square";
  return widthMilli > heightMilli ? "landscape" : "portrait";
}

/**
 * Everything a PDF will admit without being rendered.
 *
 * Modern producers -- Word, LibreOffice, most browsers -- put the page tree
 * inside compressed object streams, so a plain scan of the file finds neither
 * the page box nor the count. Those streams are inflated here before scanning,
 * which is the difference between detecting most real uploads and detecting
 * only the ones written by hand.
 */
function inspectPdf(bytes) {
  const texts = [bytes.toString("latin1"), ...inflatedStreams(bytes)];

  let mediaBox = null;
  let pageCount = null;
  for (const text of texts) {
    mediaBox = mediaBox || firstMediaBox(text);
    const counted = pageTreeCount(text);
    if (counted != null && (pageCount == null || counted > pageCount)) pageCount = counted;
  }

  // A PDF that yielded neither a page box nor a count told us nothing, and an
  // object of nulls reads downstream as "inspected, no measurements" when the
  // truth is that nothing was read at all.
  if (!mediaBox && pageCount == null) return null;

  const dimensions = mediaBox
    ? {
        widthMilli: round(mediaBox.width * MM_PER_POINT * MILLI),
        heightMilli: round(mediaBox.height * MM_PER_POINT * MILLI),
      }
    : { widthMilli: null, heightMilli: null };

  return {
    kind: "pdf",
    pageCount,
    ...dimensions,
    // A PDF's page box is a physical size already, so there is no density to
    // report and nothing downstream should ask for one.
    dpi: null,
    pixelWidth: null,
    pixelHeight: null,
  };
}

/**
 * The first page box in a PDF, in points.
 *
 * The first one is the right one: a page tree states MediaBox on the root node
 * and children inherit it, so the earliest occurrence is the document's own
 * size unless a later page deliberately differs -- and a mixed-size document
 * has no single answer to autofill anyway.
 */
function firstMediaBox(text) {
  const match = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(text);
  if (!match) return null;
  const [, x0, y0, x1, y1] = match.map(Number);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { width, height };
}

/**
 * How many pages the page tree claims.
 *
 * Read from a `/Type /Pages` node rather than by counting `/Count`, because an
 * outline also carries `/Count` and a document with a long table of contents
 * would otherwise report more pages than it has. Nested page-tree nodes each
 * carry their own subtotal, so the largest is the root's.
 *
 * The count is taken from the node's own dictionary, not a fixed window: a
 * long `/Kids` array — the shape a 30-page tree actually has — used to push
 * `/Count` more than 512 bytes from `/Type /Pages`, and we reported nothing.
 * An indirect `/Count 4 0 R` is not a page count, and treating the object
 * number as one would be guessing.
 */
function pageTreeCount(text) {
  let best = null;
  const nodes = /\/Type\s*\/Pages\b/g;
  let node;
  while ((node = nodes.exec(text)) !== null) {
    const dict = enclosingDictionary(text, node.index) ?? text.slice(
      Math.max(0, node.index - 8192),
      node.index + 8192,
    );
    const counted = directPageCount(dict);
    if (counted != null && (best == null || counted > best)) best = counted;
  }
  if (best != null) return best;

  // No page tree in reach -- fall back to counting leaf pages. `/Type /Page`
  // must not match `/Type /Pages`, hence the boundary.
  const leaves = text.match(/\/Type\s*\/Page(?![s\w])/g);
  return leaves?.length ? leaves.length : null;
}

/** The `<< ... >>` that contains this offset, or null when the file is too broken to pair. */
function enclosingDictionary(text, at) {
  let from = at;
  while (from >= 0) {
    const start = text.lastIndexOf("<<", from);
    if (start === -1) return null;
    const dict = dictionaryFrom(text, start);
    if (dict && start + dict.length > at) return dict;
    from = start - 1;
  }
  return null;
}

function dictionaryFrom(text, start) {
  let depth = 0;
  for (let i = start; i < text.length - 1; i += 1) {
    if (text[i] === "<" && text[i + 1] === "<") {
      depth += 1;
      i += 1;
      continue;
    }
    if (text[i] === ">" && text[i + 1] === ">") {
      depth -= 1;
      i += 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** A `/Count` that is a bare integer, never an indirect reference. */
function directPageCount(dict) {
  const counted = /\/Count\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
  if (!counted) return null;
  const value = Number(counted[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** How many compressed streams to inflate before giving up on a large file. */
const MAX_STREAMS = 40;

/** How much inflated text to keep. Page trees are small; content streams are not. */
const MAX_INFLATED_BYTES = 4 * 1024 * 1024;

/**
 * Inflate the deflated streams a PDF's structure may be hiding in.
 *
 * Bounded on both sides: a fixed number of streams, and a fixed total of
 * inflated bytes, so a hostile or merely enormous file cannot turn one upload
 * into an unbounded decompression.
 */
function inflatedStreams(bytes) {
  const out = [];
  let total = 0;
  let from = 0;
  for (let seen = 0; seen < MAX_STREAMS && total < MAX_INFLATED_BYTES; seen += 1) {
    const start = bytes.indexOf("stream", from);
    if (start === -1) break;
    const end = bytes.indexOf("endstream", start);
    if (end === -1) break;
    from = end + 9;

    // Only the streams whose dictionary says they are deflated. Anything else
    // is image data or already-readable text the plain scan has covered.
    const dictionary = bytes.toString("latin1", Math.max(0, start - 512), start);
    if (!dictionary.includes("FlateDecode")) continue;

    let body = start + 6;
    if (bytes[body] === 0x0d) body += 1;
    if (bytes[body] === 0x0a) body += 1;

    try {
      const inflated = zlib.inflateSync(bytes.subarray(body, end), {
        // A stream sliced at `endstream` can end mid-block; a sync flush
        // returns what did inflate instead of throwing the lot away.
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
        maxOutputLength: MAX_INFLATED_BYTES - total,
      });
      if (!inflated.length) continue;
      let readable = inflated;
      try {
        readable = undoPredictor(inflated, dictionary);
      } catch {
        // A predictor we cannot undo is still scanned as inflated bytes.
        // Guessing a page count from the leftovers is worse than missing it.
      }
      if (!readable.length) continue;
      total += readable.length;
      out.push(readable.toString("latin1"));
    } catch {
      // A stream that will not inflate tells us nothing and is not an error:
      // the file is still a perfectly good upload.
    }
  }
  return out;
}

/** A dictionary integer, or null when the name is absent or not a number. */
function dictInt(dictionary, name) {
  const match = new RegExp(`/${name}\\s+(\\d+)`).exec(dictionary);
  return match ? Number(match[1]) : null;
}

/**
 * Undo a Flate predictor so object-stream bytes become text again.
 *
 * Common producers write `/DecodeParms << /Predictor 12 /Columns N >>`.
 * Inflating without this leaves a filter byte and a delta on every row, and
 * `/Count` never appears. A predictor we do not know is left as inflated
 * bytes — guessing a page count from the leftovers is how a damaged stream
 * becomes a wrong invoice.
 */
function undoPredictor(inflated, dictionary) {
  const predictor = dictInt(dictionary, "Predictor");
  if (predictor == null || predictor <= 1) return inflated;
  const columns = dictInt(dictionary, "Columns") ?? 1;
  const colors = dictInt(dictionary, "Colors") ?? 1;
  const bits = dictInt(dictionary, "BitsPerComponent") ?? 8;
  if (columns < 1 || colors < 1 || bits < 1) return inflated;
  const rowSize = Math.ceil((columns * colors * bits) / 8);
  if (rowSize < 1) return inflated;
  const bpp = Math.max(1, Math.ceil((colors * bits) / 8));
  if (predictor === 2) return undoTiffPredictor(inflated, rowSize, bpp);
  if (predictor >= 10 && predictor <= 15) return undoPngPredictor(inflated, rowSize, bpp);
  return inflated;
}

function undoTiffPredictor(bytes, rowSize, sampleBytes) {
  const out = Buffer.from(bytes);
  for (let i = 0; i < out.length; i += rowSize) {
    const end = Math.min(i + rowSize, out.length);
    for (let x = i + sampleBytes; x < end; x += 1) {
      out[x] = (out[x] + out[x - sampleBytes]) & 0xff;
    }
  }
  return out;
}

function undoPngPredictor(bytes, rowSize, bpp) {
  const stride = rowSize + 1;
  if (bytes.length < stride) return bytes;
  const rows = Math.floor(bytes.length / stride);
  const out = Buffer.alloc(rows * rowSize);
  let prior = Buffer.alloc(rowSize);
  for (let r = 0; r < rows; r += 1) {
    const filter = bytes[r * stride];
    const filt = bytes.subarray(r * stride + 1, r * stride + 1 + rowSize);
    const recon = Buffer.alloc(rowSize);
    for (let x = 0; x < rowSize; x += 1) {
      const left = x >= bpp ? recon[x - bpp] : 0;
      const up = prior[x];
      const upLeft = x >= bpp ? prior[x - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = left;
      else if (filter === 2) pred = up;
      else if (filter === 3) pred = Math.floor((left + up) / 2);
      else if (filter === 4) pred = paeth(left, up, upLeft);
      recon[x] = (filt[x] + pred) & 0xff;
    }
    recon.copy(out, r * rowSize);
    prior = recon;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** PNG: the pixel dimensions are fixed at the front, the density is a chunk. */
function inspectPng(bytes) {
  if (bytes.length < 24) return null;
  const pixelWidth = bytes.readUInt32BE(16);
  const pixelHeight = bytes.readUInt32BE(20);
  if (!pixelWidth || !pixelHeight) return null;
  return { pixelWidth, pixelHeight, dpi: pngDensity(bytes) };
}

/**
 * A PNG's declared density, in dots per inch.
 *
 * `pHYs` states pixels per metre, which is the honest unit and not the one
 * anybody prints in. Only the metre unit is meaningful -- unit 0 means the
 * numbers are an aspect ratio and carry no physical size at all.
 */
function pngDensity(bytes) {
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (type === "pHYs" && length >= 9 && at + 8 + 9 <= bytes.length) {
      const perMetreX = bytes.readUInt32BE(at + 8);
      const unit = bytes[at + 16];
      if (unit === 1 && perMetreX > 0) return round(perMetreX * 0.0254);
      return null;
    }
    if (type === "IDAT" || type === "IEND") return null;
    at += 12 + length;
  }
  return null;
}

/** Frame markers that carry the image's size; C4, C8 and CC are tables, not frames. */
function isFrameMarker(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** JPEG: walk the segment chain for the frame header and the JFIF density. */
function inspectJpeg(bytes) {
  let at = 2;
  let dpi = null;
  let size = null;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2) break;

    if (isFrameMarker(marker) && at + 9 <= bytes.length) {
      size = { pixelHeight: bytes.readUInt16BE(at + 5), pixelWidth: bytes.readUInt16BE(at + 7) };
    } else if (marker === 0xe0 && dpi == null && at + 16 <= bytes.length) {
      if (bytes.toString("latin1", at + 4, at + 9) === "JFIF\0") {
        const unit = bytes[at + 11];
        const densityX = bytes.readUInt16BE(at + 12);
        // Unit 0 is an aspect ratio, not a density, and printing from it would
        // be inventing a size the file never claimed.
        if (unit === 1 && densityX > 0) dpi = densityX;
        else if (unit === 2 && densityX > 0) dpi = round(densityX * 2.54);
      }
    }

    if (size && dpi != null) break;
    at += 2 + length;
  }
  if (!size?.pixelWidth || !size?.pixelHeight) return null;
  return { ...size, dpi };
}

/**
 * What a raster image works out to on paper.
 *
 * Only when it declared a density. Pixels alone are not a size, and the common
 * default of 72 DPI would turn a 1200x1800 photo into an A4 page it was never
 * meant to fill.
 */
function rasterPhysicalSize({ pixelWidth, pixelHeight, dpi }) {
  if (!dpi || dpi <= 0) return { widthMilli: null, heightMilli: null };
  return {
    widthMilli: round((pixelWidth / dpi) * MM_PER_INCH * MILLI),
    heightMilli: round((pixelHeight / dpi) * MM_PER_INCH * MILLI),
  };
}

/**
 * Read an uploaded artwork file for the measurements it already carries.
 *
 * `contentType` is the sniffed type, not the declared one -- the same rule the
 * rest of the upload path follows, because a client's device names a type by
 * extension and is regularly wrong.
 *
 * Returns null for anything it cannot read, which is not a failure: the upload
 * stands, and the client fills the measurement in themselves.
 */
export function inspectArtwork(bytes, contentType) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16) return null;

  let read = null;
  if (contentType === "application/pdf") {
    read = inspectPdf(bytes);
  } else if (contentType === "image/png") {
    const raster = inspectPng(bytes);
    if (raster) read = { kind: "raster", pageCount: 1, ...raster, ...rasterPhysicalSize(raster) };
  } else if (contentType === "image/jpeg") {
    const raster = inspectJpeg(bytes);
    if (raster) read = { kind: "raster", pageCount: 1, ...raster, ...rasterPhysicalSize(raster) };
  }
  if (!read) return null;

  const { widthMilli, heightMilli } = read;
  const known = Number.isFinite(widthMilli) && Number.isFinite(heightMilli) && widthMilli > 0 && heightMilli > 0;
  return {
    kind: read.kind,
    pageCount: read.pageCount ?? null,
    pixelWidth: read.pixelWidth ?? null,
    pixelHeight: read.pixelHeight ?? null,
    dpi: read.dpi ?? null,
    measureUnit: known ? "mm" : null,
    widthMilli: known ? widthMilli : null,
    heightMilli: known ? heightMilli : null,
    pageSize: known ? namePageSize(widthMilli, heightMilli) : null,
    orientation: known ? orientationOf(widthMilli, heightMilli) : null,
  };
}
