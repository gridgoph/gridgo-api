import zlib from "node:zlib";
import { cmykSwatchHex } from "./color-targets.js";

/**
 * The colours an uploaded artwork file uses, read from what the file states.
 *
 * Shown beside the client's exact colours so the shop and the GRIDGO Team can
 * compare what was asked for with what was sent. Only what can be read
 * without rendering:
 *
 * - PDF: the spot colours it names (`/Separation`, `/DeviceN`), with the
 *   alternate value the file gives for each when that is a plain number list,
 *   and the RGB, CMYK and grey values its page content sets.
 * - PNG: the most common colours of its pixels.
 *
 * Everything else -- JPEG, WebP and Photoshop pixels, Word documents, pictures
 * placed inside a PDF -- is reported as not read rather than guessed. The
 * result says which parts were read through `status` and `reasons`.
 *
 * Contract: docs/EXACT_COLOURS_API.md#colours-read-from-the-file.
 */

const MAX_SPOTS = 16;
const MAX_PROCESS = 12;
const MAX_PIXEL_COLORS = 8;
/** A colour under half a percent of the pixels is anti-aliasing or noise, not a colour the artwork uses. */
const MIN_SHARE_BPS = 50;

const MAX_STREAMS = 400;
/** Streams looked at, read or skipped; past this the file is not walked further. */
const MAX_STREAM_VISITS = 4000;
/** Deflate cannot expand more than about 1032 to 1, which bounds what a failed inflate produced. */
const MAX_DEFLATE_RATIO = 1032;
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
/** Raw scanline bytes decoded from one PNG: an A3 page at 300 DPI in RGB, with room. */
const MAX_PNG_RAW_BYTES = 96 * 1024 * 1024;
/** One scanline: 200,000 pixels of 16-bit RGBA, far past any print width. */
const MAX_PNG_ROW_BYTES = 1_600_000;
/** Pixels counted from one image, however it is stored. */
const MAX_SAMPLED_PIXELS = 4_000_000;

const PROCESS_SEPARATIONS = new Set(["Cyan", "Magenta", "Yellow", "Black", "All", "None"]);

function result(status, reasons, colors = []) {
  return { version: 1, status, reasons: [...new Set(reasons)].sort(), colors };
}

const hexByte = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
const rgbHex = (r, g, b) => `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`.toUpperCase();
const unit = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

/** A colour value from a PDF operand list, or null when it is out of range. */
function pdfColor(space, values) {
  if (!values.every(unit)) return null;
  if (space === "gray" && values.length === 1) return { space, cmyk: null, hex: rgbHex(values[0] * 255, values[0] * 255, values[0] * 255) };
  if (space === "rgb" && values.length === 3) return { space, cmyk: null, hex: rgbHex(...values.map((value) => value * 255)) };
  if (space === "cmyk" && values.length === 4) {
    const [c, m, y, k] = values.map((value) => Math.round(value * 100));
    return { space, cmyk: { c, m, y, k }, hex: cmykSwatchHex({ c, m, y, k }) };
  }
  return null;
}

/** `/PANTONE#20185#20C` -> `PANTONE 185 C`. */
function pdfName(token) {
  return token.slice(1).replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

const TOKEN = /[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z'"*]+|\/(?:[^\s/[\]()<>{}%]|#[0-9A-Fa-f]{2})*|\((?:\\[\s\S]|[^\\()])*\)|<<|>>|<[0-9A-Fa-f\s]*>|%[^\r\n]*|\S/g;

/** How far one dictionary or array may run; a structure that never closes is not read. */
const MAX_STRUCTURE = 16 * 1024;

/** `obj` keywords visited while indexing objects for references. */
const MAX_OBJECTS = 200_000;

/** Distinct colours counted before ranking; past this, new ones are not counted. */
const MAX_TRACKED = 4096;

/** How many declarations of one kind are read, so a file repeating one cannot multiply the work. */
const MAX_DECLARATIONS = 1000;

/** Content tokens walked across the whole file: a detailed vector poster fits, and a hostile one costs well under a second. */
const MAX_TOKENS = 750_000;

/** The `<< ... >>` starting at `start`, or null. */
function dictionaryAt(text, start) {
  let depth = 0;
  for (let i = start, stop = Math.min(text.length - 1, start + MAX_STRUCTURE); i < stop; i += 1) {
    if (text[i] === "<" && text[i + 1] === "<") {
      depth += 1;
      i += 1;
    } else if (text[i] === ">" && text[i + 1] === ">") {
      depth -= 1;
      i += 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** The `[ ... ]` starting at `start`, nesting included, or null. */
function arrayAt(text, start) {
  let depth = 0;
  for (let i = start, stop = Math.min(text.length, start + MAX_STRUCTURE); i < stop; i += 1) {
    if (text[i] === "[") depth += 1;
    else if (text[i] === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Every stream in the file, with the dictionary in front of it, decoded when
 * it is plain or Flate-compressed. Bounded in count and in decoded bytes, so a
 * hostile file costs no more than a large honest one.
 */
function pdfStreams(bytes, text, notes) {
  const streams = [];
  let decodedTotal = 0;
  const STREAM = /\bstream(?:\r\n|\n|\r)/g;
  let match;
  let visits = 0;
  while ((match = STREAM.exec(text)) !== null) {
    if (streams.length >= MAX_STREAMS || ++visits > MAX_STREAM_VISITS) {
      notes.add("inspection_limit");
      break;
    }
    const bodyStart = match.index + match[0].length;
    const end = text.indexOf("endstream", bodyStart);
    if (end === -1) break;
    STREAM.lastIndex = end + 9;
    const windowStart = Math.max(0, match.index - 2048);
    const local = text.slice(windowStart, match.index).lastIndexOf(" obj");
    const objectStart = local === -1 ? -1 : windowStart + local;
    const dictionary = text.slice(objectStart === -1 ? Math.max(0, match.index - 1024) : objectStart, match.index);
    const kind = streamKind(dictionary);
    const number = objectStart === -1 ? null : Number(/(\d+)\s+\d+$/.exec(text.slice(Math.max(0, objectStart - 24), objectStart))?.[1] ?? NaN);
    if (kind === "image") {
      notes.add("embedded_images_not_read");
      continue;
    }
    if (kind === "skip") continue;
    const filters = [...dictionary.matchAll(/\/(FlateDecode|LZWDecode|ASCII85Decode|ASCIIHexDecode|RunLengthDecode|DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|Crypt)\b/g)].map((entry) => entry[1]);
    // Text encodings may wrap one Flate layer; anything else (LZW, images
    // codecs, predictors) is not read.
    const supported = filters.every((filter, index) => (filter === "FlateDecode" ? index === filters.length - 1 : ["ASCII85Decode", "ASCIIHexDecode"].includes(filter)))
      && !/\/Predictor\s+(?:[2-9]|1\d)/.test(dictionary);
    if (!supported) {
      if (kind === "content") notes.add("stream_filter_not_supported");
      continue;
    }
    if (decodedTotal >= MAX_CONTENT_BYTES) {
      notes.add("inspection_limit");
      continue;
    }
    let data = bytes.subarray(bodyStart, end);
    const remaining = MAX_CONTENT_BYTES - decodedTotal;
    try {
      for (const filter of filters) {
        if (filter === "ASCII85Decode") data = ascii85(data);
        else if (filter === "ASCIIHexDecode") data = asciiHex(data);
        else {
          data = zlib.inflateSync(data, {
            finishFlush: zlib.constants.Z_SYNC_FLUSH,
            maxOutputLength: MAX_CONTENT_BYTES - decodedTotal,
          });
        }
      }
    } catch (error) {
      // A failed inflate still did its work: charge what it could have
      // produced, so a file of streams that each fail cannot multiply the cost.
      decodedTotal += error?.code === "ERR_BUFFER_TOO_LARGE" ? remaining : Math.min(remaining, (end - bodyStart) * MAX_DEFLATE_RATIO);
      notes.add(error?.code === "ERR_BUFFER_TOO_LARGE" ? "inspection_limit" : kind === "content" ? "content_not_readable" : "inspection_limit");
      continue;
    }
    decodedTotal += data.length;
    streams.push({ kind, number, dictionary, body: data.toString("latin1") });
  }
  return streams;
}

/** ASCII85 (`<~ ... ~>`), as PDF writes it. */
function ascii85(data) {
  const text = data.toString("latin1").replace(/\s+/g, "").replace(/^<~/, "");
  const stop = text.indexOf("~>");
  const body = stop === -1 ? text : text.slice(0, stop);
  const out = [];
  let group = [];
  for (const char of body) {
    if (char === "z" && !group.length) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = char.charCodeAt(0) - 33;
    if (code < 0 || code > 84) throw new Error("ascii85");
    group.push(code);
    if (group.length === 5) {
      const value = group.reduce((sum, digit) => sum * 85 + digit, 0);
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group = [];
    }
  }
  if (group.length) {
    const count = group.length - 1;
    while (group.length < 5) group.push(84);
    const value = group.reduce((sum, digit) => sum * 85 + digit, 0);
    out.push(...[(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].slice(0, count));
  }
  return Buffer.from(out);
}

function asciiHex(data) {
  const text = data.toString("latin1").replace(/\s+/g, "");
  const stop = text.indexOf(">");
  const digits = stop === -1 ? text : text.slice(0, stop);
  if (/[^0-9A-Fa-f]/.test(digits)) throw new Error("asciihex");
  return Buffer.from(digits.length % 2 ? `${digits}0` : digits, "hex");
}

function streamKind(own) {
  if (/\/Subtype\s*\/Image\b/.test(own)) return "image";
  if (/\/Type\s*\/ObjStm\b/.test(own)) return "objects";
  if (/\/Subtype\s*\/Form\b/.test(own)) return "form";
  if (/\/FunctionType\s+4\b/.test(own)) return "function";
  if (/\/Type\s*\/(?:XRef|Metadata|EmbeddedFile|CMap)\b|\/Length[123]\b|\/Subtype\s*\/(?:Type1C|CIDFontType0C|OpenType|XML)\b|\/FunctionType\b|\/N\s+[134]\b|\/ShadingType\b/.test(own)) return "skip";
  return "content";
}

/**
 * A type 4 (PostScript calculator) tint function at full tint.
 *
 * Only the stack and arithmetic operators producers write for a spot colour's
 * alternate (`{dup 0.91 mul exch ...}`); a function with branches or any other
 * operator is not evaluated, so its alternate stays unknown.
 */
function calculatorAtFullTint(body) {
  const program = /^\s*\{([^{}]*)\}\s*$/.exec(body)?.[1];
  if (program == null) return null;
  const stack = [1];
  for (const word of program.trim().split(/\s+/).filter(Boolean)) {
    if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(word)) stack.push(Number(word));
    else if (word === "dup" && stack.length) stack.push(stack.at(-1));
    else if (word === "exch" && stack.length >= 2) stack.push(stack.pop(), stack.pop());
    else if (word === "pop" && stack.length) stack.pop();
    else if (["mul", "add", "sub", "div"].includes(word) && stack.length >= 2) {
      const right = stack.pop();
      const left = stack.pop();
      if (word === "div" && right === 0) return null;
      stack.push(word === "mul" ? left * right : word === "add" ? left + right : word === "sub" ? left - right : left / right);
    } else if (word === "neg" && stack.length) stack.push(-stack.pop());
    else if (word === "index" && stack.length) {
      const n = stack.pop();
      if (!Number.isInteger(n) || n < 0 || n >= stack.length) return null;
      stack.push(stack[stack.length - 1 - n]);
    } else return null;
    if (stack.length > 16) return null;
  }
  return stack;
}

/** Objects by number, from the file text and from inside object streams. */
function pdfObjects(text, streams) {
  const objects = new Map();
  const ends = [];
  for (let at = text.indexOf("endobj"); at !== -1; at = text.indexOf("endobj", at + 6)) ends.push(at);
  // Find each `obj` keyword, then read its `N G` header just before it: one
  // pass over the file rather than a pattern tried at every digit.
  const HEADER = /(?:^|[^\d.])(\d+)\s+\d+\s+$/;
  const starts = [];
  for (let at = text.indexOf("obj"), visits = 0; at !== -1 && visits < MAX_OBJECTS; at = text.indexOf("obj", at + 3), visits += 1) {
    if (/\w/.test(text[at + 3] || "")) continue;
    const before = Math.max(0, at - 32);
    const header = HEADER.exec(text.slice(before, at));
    if (header) starts.push({ number: Number(header[1]), from: at + 3, at: before + header.index });
  }
  // Each body stops at its endobj or the next object, so the file is scanned once.
  let next = 0;
  for (const [index, { number, from }] of starts.entries()) {
    while (next < ends.length && ends[next] < from) next += 1;
    const end = Math.min(next < ends.length ? ends[next] : text.length, starts[index + 1]?.at ?? text.length, from + MAX_STRUCTURE);
    const body = text.slice(from, end);
    const stream = /\bstream(?:\r\n|\n|\r)/.exec(body);
    objects.set(number, (stream ? body.slice(0, stream.index) : body).trim());
  }
  for (const stream of streams.filter((entry) => entry.kind === "objects")) {
    const first = Number(/\/First\s+(\d+)/.exec(stream.dictionary)?.[1]);
    if (!Number.isInteger(first) || first <= 0 || first > stream.body.length) continue;
    const header = stream.body.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i + 1 < header.length; i += 2) {
      const start = first + header[i + 1];
      const stop = i + 3 < header.length ? first + header[i + 3] : stream.body.length;
      if (Number.isInteger(header[i]) && start >= first && stop >= start) objects.set(header[i], stream.body.slice(start, stop).trim());
    }
  }
  return objects;
}

/** Follow `12 0 R` to the object's own text; anything else is returned as it is. */
function resolve(objects, value) {
  const ref = /^(\d+)\s+\d+\s+R$/.exec(value?.trim() || "");
  return ref ? objects.get(Number(ref[1])) ?? null : value;
}

/** The next PDF value in `text` from `at`: a name, number, array, dictionary or reference. */
function valueAt(text, at) {
  const space = /\s*/y;
  space.lastIndex = at;
  space.exec(text);
  const start = space.lastIndex;
  if (text.startsWith("<<", start)) return dictionaryAt(text, start);
  if (text[start] === "[") return arrayAt(text, start);
  const simple = /\d+\s+\d+\s+R|\/(?:[^\s/[\]()<>{}%]|#[0-9A-Fa-f]{2})*|[-+]?[\d.]+/y;
  simple.lastIndex = start;
  return simple.exec(text)?.[0] ?? null;
}

const DEVICE = { "/DeviceGray": "gray", "/G": "gray", "/CalGray": "gray", "/DeviceRGB": "rgb", "/RGB": "rgb", "/CalRGB": "rgb", "/DeviceCMYK": "cmyk", "/CMYK": "cmyk" };

/** What a colour space value is: `{ space }`, `{ spot }` or null when it cannot be told. */
function colorSpaceOf(objects, value, depth = 0) {
  const text = resolve(objects, value)?.trim();
  if (!text || depth > 3) return null;
  if (DEVICE[text]) return { space: DEVICE[text] };
  if (!text.startsWith("[")) return null;
  const tokens = text.slice(1, -1).match(TOKEN) || [];
  const family = tokens[0];
  if (DEVICE[family]) return { space: DEVICE[family] };
  if (family === "/ICCBased") {
    const profile = resolve(objects, tokens.slice(1, 4).join(" "));
    const components = /\/N\s+([134])\b/.exec(profile || "")?.[1];
    return components ? { space: { 1: "gray", 3: "rgb", 4: "cmyk" }[components] } : null;
  }
  if (family === "/Separation" && tokens[1]?.startsWith("/")) return { spot: pdfName(tokens[1]) };
  return null;
}

/**
 * Spot colours the file declares, with the alternate value it states for the
 * full tint when that is a type 2 function with a plain `/C1` list.
 */
function declaredSpots(objects, functions, sources) {
  const spots = new Map();
  for (const source of sources) {
    const SEPARATION = /\/Separation\b/g;
    let match;
    for (let seen = 0; seen < MAX_DECLARATIONS && (match = SEPARATION.exec(source)) !== null; seen += 1) {
      const tokens = [];
      let at = match.index + match[0].length;
      for (let i = 0; i < 3; i += 1) {
        const value = valueAt(source, at);
        if (!value) break;
        tokens.push(value);
        const space = /\s*/y;
        space.lastIndex = at;
        space.exec(source);
        at = space.lastIndex + value.length;
      }
      const [nameToken, alternateValue, tintValue] = tokens;
      if (!nameToken?.startsWith("/")) continue;
      const name = pdfName(nameToken);
      if (PROCESS_SEPARATIONS.has(name) || !name.trim()) continue;
      const alternate = alternateValue ? colorSpaceOf(objects, alternateValue)?.space ?? null : null;
      const tint = tintValue ? resolve(objects, tintValue) : null;
      let color = null;
      if (alternate && tint && /\/FunctionType\s+2\b/.test(tint)) {
        const c1 = /\/C1\s*\[([^\]]*)\]/.exec(tint)?.[1].trim().split(/\s+/).map(Number);
        if (c1) color = pdfColor(alternate, c1);
      } else if (alternate && tint && /\/FunctionType\s+4\b/.test(tint)) {
        const ref = /^(\d+)\s+\d+\s+R$/.exec(tintValue.trim());
        const program = ref && functions.get(Number(ref[1]));
        const values = program ? calculatorAtFullTint(program) : null;
        if (values) color = pdfColor(alternate, values);
      }
      const known = spots.get(name);
      if (!known && spots.size >= MAX_TRACKED) continue;
      if (!known || (!known.hex && color)) {
        spots.set(name, { kind: "spot", name, space: color?.space ?? alternate, cmyk: color?.cmyk ?? null, hex: color?.hex ?? null, uses: known?.uses ?? 0, shareBps: null });
      }
    }
    const DEVICE_N = /\/DeviceN\s*\[/g;
    for (let seen = 0; seen < MAX_DECLARATIONS && (match = DEVICE_N.exec(source)) !== null; seen += 1) {
      const names = arrayAt(source, match.index + match[0].length - 1)?.match(/\/(?:[^\s/[\]()<>{}%]|#[0-9A-Fa-f]{2})+/g) || [];
      for (const token of names) {
        const name = pdfName(token);
        if (!PROCESS_SEPARATIONS.has(name) && !spots.has(name) && spots.size < MAX_TRACKED) {
          spots.set(name, { kind: "spot", name, space: null, cmyk: null, hex: null, uses: 0, shareBps: null });
        }
      }
    }
  }
  return spots;
}

/** Resource names (`/CS0`) to the colour space each one stands for; a name used two ways is dropped. */
function resourceSpaces(objects, sources) {
  const spaces = new Map();
  const conflicted = new Set();
  for (const source of sources) {
    const RESOURCE = /\/ColorSpace\s*(<<|\d+\s+\d+\s+R)/g;
    let match;
    for (let seen = 0; seen < MAX_DECLARATIONS && (match = RESOURCE.exec(source)) !== null; seen += 1) {
      const dict = match[1] === "<<" ? dictionaryAt(source, match.index + match[0].length - 2) : resolve(objects, match[1]);
      if (!dict?.trim().startsWith("<<")) continue;
      const inner = dict.trim().slice(2, -2);
      const KEY = /\/((?:[^\s/[\]()<>{}%]|#[0-9A-Fa-f]{2})+)/g;
      let key;
      while ((key = KEY.exec(inner)) !== null) {
        const space = /\s*/y;
        space.lastIndex = key.index + key[0].length;
        space.exec(inner);
        const value = valueAt(inner, space.lastIndex);
        if (!value) continue;
        KEY.lastIndex = space.lastIndex + value.length;
        const name = `/${key[1]}`;
        const resolved = colorSpaceOf(objects, value);
        const known = spaces.get(name);
        if (known !== undefined && JSON.stringify(known) !== JSON.stringify(resolved)) conflicted.add(name);
        spaces.set(name, resolved);
      }
    }
  }
  for (const name of conflicted) spaces.set(name, null);
  return spaces;
}

/**
 * The colour values a page content stream sets, by walking its operators.
 * Inline images (`BI ... ID ... EI`) are stepped over, not read.
 */
function scanContent(stream, spaces, spots, process, notes, budget) {
  const OPERANDS = { gray: 1, rgb: 3, cmyk: 4 };
  const record = (color) => {
    if (!color) return;
    const key = `${color.space}:${color.cmyk ? JSON.stringify(color.cmyk) : color.hex}`;
    const known = process.get(key);
    if (known) known.uses += 1;
    else if (process.size < MAX_TRACKED) process.set(key, { kind: "process", name: null, ...color, uses: 1, shareBps: null });
  };
  const space = { fill: { space: "gray" }, stroke: { space: "gray" } };
  const set = { fill: false, stroke: false };
  const numbers = [];
  let lastName = null;
  const text = stream.body;
  TOKEN.lastIndex = 0;
  let token;
  while ((token = TOKEN.exec(text)) !== null) {
    if (--budget.tokens < 0) {
      notes.add("inspection_limit");
      return;
    }
    const value = token[0];
    const first = value.charCodeAt(0);
    // Digits, sign or point: an operand.
    if ((first >= 48 && first <= 57) || first === 45 || first === 43 || first === 46) {
      numbers.push(Number(value));
      if (numbers.length > 32) numbers.shift();
      continue;
    }
    if (first === 47) {
      lastName = value;
      continue;
    }
    switch (value) {
      case "g": case "G":
        record(pdfColor("gray", numbers.slice(-1)));
        set[value === "g" ? "fill" : "stroke"] = true;
        break;
      case "rg": case "RG":
        record(pdfColor("rgb", numbers.slice(-3)));
        set[value === "rg" ? "fill" : "stroke"] = true;
        break;
      case "k": case "K":
        record(pdfColor("cmyk", numbers.slice(-4)));
        set[value === "k" ? "fill" : "stroke"] = true;
        break;
      case "cs": case "CS": {
        const which = value === "cs" ? "fill" : "stroke";
        const named = lastName && (DEVICE[lastName] ? { space: DEVICE[lastName] } : lastName === "/Pattern" ? { pattern: true } : spaces.get(lastName));
        space[which] = named ?? null;
        break;
      }
      case "sc": case "scn": case "SC": case "SCN": {
        const which = value.startsWith("s") ? "fill" : "stroke";
        set[which] = true;
        const current = space[which];
        if (current?.spot) {
          const spot = spots.get(current.spot);
          if (spot) spot.uses += 1;
        } else if (current?.space) {
          record(pdfColor(current.space, numbers.slice(-OPERANDS[current.space])));
        } else {
          // Patterns, gradients and spaces we could not resolve paint colours
          // this read does not see.
          notes.add("colour_space_not_read");
        }
        break;
      }
      case "sh":
        notes.add("colour_space_not_read");
        break;
      case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*": case "Tj": case "TJ": case "'": case "\"": case "S": case "s": {
        // A page starts in black: paint before any colour is set is black ink.
        const paints = ["S", "s"].includes(value) ? ["stroke"] : ["B", "B*", "b", "b*"].includes(value) ? ["fill", "stroke"] : ["fill"];
        for (const which of paints) {
          if (!set[which] && stream.kind === "content") record(pdfColor("gray", [0]));
          set[which] = true;
        }
        break;
      }
      case "ID": {
        notes.add("embedded_images_not_read");
        const end = /\sEI(?=[\s]|$)/g;
        end.lastIndex = TOKEN.lastIndex;
        const found = end.exec(text);
        TOKEN.lastIndex = found ? found.index + found[0].length : text.length;
        break;
      }
      default:
        break;
    }
    // Operands belong to the operator that follows them, and to no other.
    numbers.length = 0;
    lastName = null;
  }
}

export function readPdfColors(bytes, { complete = true } = {}) {
  const notes = new Set();
  if (!complete) notes.add("file_larger_than_inspection_window");
  const text = bytes.toString("latin1");
  const streams = pdfStreams(bytes, text, notes);
  const objects = pdfObjects(text, streams);
  const definitions = [text, ...streams.filter((stream) => stream.kind === "objects").map((stream) => stream.body)];
  const functions = new Map(streams.filter((stream) => stream.kind === "function" && Number.isInteger(stream.number)).map((stream) => [stream.number, stream.body]));
  const spots = declaredSpots(objects, functions, definitions);
  const spaces = resourceSpaces(objects, definitions);
  const process = new Map();
  const contents = streams.filter((stream) => stream.kind === "content" || stream.kind === "form");
  const budget = { tokens: MAX_TOKENS };
  for (const stream of contents) {
    if (budget.tokens <= 0) break;
    scanContent(stream, spaces, spots, process, notes, budget);
  }

  const colors = [
    ...[...spots.values()].sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)).slice(0, MAX_SPOTS),
    ...[...process.values()].sort((a, b) => b.uses - a.uses || a.hex.localeCompare(b.hex)).slice(0, MAX_PROCESS),
  ];
  if (spots.size > MAX_SPOTS || process.size > MAX_PROCESS) notes.add("more_colours_than_listed");
  if (!colors.length) {
    if (!contents.length) notes.add("content_not_readable");
    else notes.add("no_colours_declared");
    return result("unknown", [...notes]);
  }
  const partial = [...notes].some((note) => note !== "more_colours_than_listed");
  return result(partial ? "partial" : "read", [...notes], colors);
}

/** Undo one PNG scanline filter in place against the row above it. */
function unfilter(filter, row, prior, bpp) {
  const length = row.length;
  if (filter === 1) {
    for (let i = bpp; i < length; i += 1) row[i] += row[i - bpp];
  } else if (filter === 2) {
    for (let i = 0; i < length; i += 1) row[i] += prior[i];
  } else if (filter === 3) {
    for (let i = 0; i < bpp; i += 1) row[i] += prior[i] >> 1;
    for (let i = bpp; i < length; i += 1) row[i] += (row[i - bpp] + prior[i]) >> 1;
  } else if (filter === 4) {
    for (let i = 0; i < bpp; i += 1) row[i] += prior[i];
    for (let i = bpp; i < length; i += 1) {
      const left = row[i - bpp];
      const up = prior[i];
      const upLeft = prior[i - bpp];
      const pa = Math.abs(up - upLeft);
      const pb = Math.abs(left - upLeft);
      const pc = Math.abs(left + up - 2 * upLeft);
      row[i] += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
    }
  }
}

/** Adam7: each pass's start and step, as column offset/step and row offset/step. */
const ADAM7 = [[0, 8, 0, 8], [4, 8, 0, 8], [0, 4, 4, 8], [2, 4, 0, 4], [0, 2, 2, 4], [1, 2, 0, 2], [0, 1, 1, 2]];
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function pngChunks(bytes) {
  const chunks = { idat: [], truncated: false };
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const data = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length));
    if (at + 8 + length > bytes.length) chunks.truncated = true;
    if (type === "IHDR") chunks.ihdr = data;
    else if (type === "PLTE") chunks.plte = data;
    else if (type === "tRNS") chunks.trns = data;
    else if (type === "IDAT") chunks.idat.push(data);
    else if (type === "IEND") return chunks;
    at += 12 + length;
  }
  chunks.truncated = true;
  return chunks;
}

/**
 * The most common colours of a PNG's pixels.
 *
 * Decoded row by row as the data inflates, so memory stays at two rows
 * whatever the image size. Pixels are grouped into 4096 bins (16 levels per
 * channel) and each bin reports the mean of its pixels, so a flat brand colour
 * comes back as itself. Transparent pixels do not count.
 */
export async function readPngColors(bytes, { complete = true } = {}) {
  const chunks = pngChunks(bytes);
  const ihdr = chunks.ihdr;
  if (!ihdr || ihdr.length < 13 || !chunks.idat.length) return result("unknown", ["content_not_readable"]);
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const type = ihdr[9];
  const interlaced = ihdr[12] === 1;
  const channels = PNG_CHANNELS[type];
  if (!width || !height || !channels || ![1, 2, 4, 8, 16].includes(depth) || (type === 3 && !chunks.plte)) {
    return result("unknown", ["content_not_readable"]);
  }
  // A row wider than any print file is a crafted header, not artwork.
  if (Math.ceil((width * channels * depth) / 8) > MAX_PNG_ROW_BYTES) return result("unknown", ["inspection_limit"]);
  const notes = new Set();
  if (!complete || chunks.truncated) notes.add("file_larger_than_inspection_window");

  const counts = new Uint32Array(4096);
  const sums = new Float64Array(4096 * 3);
  let opaque = 0;
  const max = (1 << depth) - 1;
  const palette = chunks.plte;
  const trns = chunks.trns;
  const sample = (row, index) => {
    if (depth === 16) return row.readUInt16BE(index * 2);
    if (depth === 8) return row[index];
    const bit = index * depth;
    return (row[bit >> 3] >> (8 - depth - (bit & 7))) & max;
  };
  const toByte = (value) => (depth === 16 ? value >> 8 : depth === 8 ? value : Math.round((value * 255) / max));
  // tRNS on a grey or RGB image names one exact sample value as transparent.
  const clear = trns && (type === 0 || type === 2) && trns.length >= (type === 0 ? 2 : 6)
    ? [trns.readUInt16BE(0), type === 2 ? trns.readUInt16BE(2) : -1, type === 2 ? trns.readUInt16BE(4) : -1] : null;

  // A fixed grid of about four million pixels is plenty to rank colours that
  // each cover half a percent or more, and keeps a poster-sized file cheap.
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / MAX_SAMPLED_PIXELS)));
  // Interlaced passes use the same grid within each pass, so the sample stays
  // even across the image whichever pass it comes from.
  const rowStep = step;
  const columnStep = step;
  const countRow = (row, pixels) => {
    for (let x = 0; x < pixels; x += columnStep) {
      let r; let g; let b; let alpha = 255;
      if (type === 3) {
        const index = sample(row, x);
        if (index * 3 + 2 >= palette.length) continue;
        r = palette[index * 3];
        g = palette[index * 3 + 1];
        b = palette[index * 3 + 2];
        if (trns && index < trns.length) alpha = trns[index];
      } else if (type === 0 || type === 4) {
        const grey = sample(row, x * channels);
        if (clear && type === 0 && grey === clear[0]) continue;
        r = g = b = toByte(grey);
        if (type === 4) alpha = toByte(sample(row, x * channels + 1));
      } else {
        const red = sample(row, x * channels);
        const green = sample(row, x * channels + 1);
        const blue = sample(row, x * channels + 2);
        if (clear && red === clear[0] && green === clear[1] && blue === clear[2]) continue;
        r = toByte(red);
        g = toByte(green);
        b = toByte(blue);
        if (type === 6) alpha = toByte(sample(row, x * channels + 3));
      }
      if (alpha < 128) continue;
      const bin = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      counts[bin] += 1;
      sums[bin * 3] += r;
      sums[bin * 3 + 1] += g;
      sums[bin * 3 + 2] += b;
      opaque += 1;
    }
  };

  const bpp = Math.max(1, Math.ceil((channels * depth) / 8));
  const passes = (interlaced ? ADAM7 : [[0, 1, 0, 1]])
    .map(([x0, dx, y0, dy]) => ({ pixels: Math.ceil(Math.max(0, width - x0) / dx), rows: Math.ceil(Math.max(0, height - y0) / dy) }))
    .filter((pass) => pass.pixels > 0 && pass.rows > 0);
  let passIndex = 0;
  let rowInPass = 0;
  let stride = 0;
  let prior = null;
  let spare = null;
  let current = null;
  let filled = 0;
  const startPass = () => {
    const pass = passes[passIndex];
    stride = Math.ceil((pass.pixels * channels * depth) / 8) + 1;
    spare = Buffer.alloc(stride);
    prior = spare.subarray(1);
    current = Buffer.alloc(stride);
    filled = 0;
    rowInPass = 0;
  };
  startPass();
  const finishRow = () => {
    const row = current.subarray(1);
    unfilter(current[0], row, prior, bpp);
    if (rowInPass % rowStep === 0) countRow(row, passes[passIndex].pixels);
    // The row just decoded is the next row's "up"; swap rather than copy.
    const decoded = current;
    current = spare;
    spare = decoded;
    prior = row;
    filled = 0;
    rowInPass += 1;
    if (rowInPass >= passes[passIndex].rows) {
      passIndex += 1;
      if (passIndex < passes.length) startPass();
    }
  };

  const done = await new Promise((resolveRead) => {
    const inflate = zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    let total = 0;
    let stopped = false;
    const stop = (state) => {
      if (stopped) return;
      stopped = true;
      inflate.removeAllListeners("data");
      inflate.destroy();
      resolveRead(state);
    };
    inflate.on("data", (chunk) => {
      total += chunk.length;
      for (let at = 0; at < chunk.length && passIndex < passes.length;) {
        const take = Math.min(stride - filled, chunk.length - at);
        chunk.copy(current, filled, at, at + take);
        filled += take;
        at += take;
        if (filled === stride) finishRow();
      }
      if (passIndex >= passes.length) stop("complete");
      else if (total >= MAX_PNG_RAW_BYTES) stop("limit");
    });
    inflate.on("end", () => stop(passIndex >= passes.length ? "complete" : "short"));
    inflate.on("error", () => stop("error"));
    inflate.end(Buffer.concat(chunks.idat));
  });
  if (done === "limit") notes.add("inspection_limit");
  else if (done !== "complete") notes.add(complete && !chunks.truncated ? "content_not_readable" : "file_larger_than_inspection_window");
  if (!opaque) return result("unknown", [...notes, ...(done === "complete" ? ["no_opaque_pixels"] : [])]);

  const colors = [...counts.keys()]
    .filter((bin) => counts[bin] && Math.floor((counts[bin] * 10_000) / opaque) >= MIN_SHARE_BPS)
    .sort((a, b) => counts[b] - counts[a] || a - b)
    .slice(0, MAX_PIXEL_COLORS)
    .map((bin) => ({
      kind: "pixels", name: null, space: "rgb", cmyk: null,
      hex: rgbHex(sums[bin * 3] / counts[bin], sums[bin * 3 + 1] / counts[bin], sums[bin * 3 + 2] / counts[bin]),
      uses: null, shareBps: Math.floor((counts[bin] * 10_000) / opaque),
    }));
  if (!colors.length) return result("unknown", [...notes, "no_dominant_colours"]);
  return result(notes.size ? "partial" : "read", [...notes], colors);
}

/**
 * The colours an artwork upload uses. Never throws: a file that cannot be
 * read returns `status: "unknown"` with the reason.
 */
export async function readArtworkColors(bytes, contentType, { complete = true } = {}) {
  try {
    if (contentType === "application/pdf") return readPdfColors(bytes, { complete });
    if (contentType === "image/png") return await readPngColors(bytes, { complete });
    return result("unknown", ["not_read_for_this_file_type"]);
  } catch {
    return result("unknown", ["content_not_readable"]);
  }
}
