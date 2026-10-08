import { inflateRawSync } from 'node:zlib';

export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const DOCX_MAX_BYTES = 16 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 2048;
const MAX_RATIO = 200;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

// Only stored/deflated, single-disk ZIPs; no extraction, ZIP64, encryption or
// recursive archive expansion. Verify every entry, not just the Word parts.
// Layout reference: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
function wordParts(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > DOCX_MAX_BYTES) return null;
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  }
  if (end < Math.max(0, bytes.length - 65557)) return null;
  const count = bytes.readUInt16LE(end + 10), directory = bytes.readUInt32LE(end + 16);
  if (!count || count > MAX_ENTRIES || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0
      || bytes.readUInt16LE(end + 8) !== count || directory + bytes.readUInt32LE(end + 12) !== end) return null;
  let at = directory, expanded = 0;
  const entries = [], names = new Set();
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) return null;
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16), compressed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32);
    const offset = bytes.readUInt32LE(at + 42), next = at + 46 + nameLength + extra + comment;
    if (next > end || !nameLength || bytes.readUInt16LE(at + 34) !== 0 || (flags & ~0x080e)
        || ![0, 8].includes(method) || size > MAX_ENTRY_BYTES || size > Math.max(1, compressed) * MAX_RATIO) return null;
    expanded += size;
    if (expanded > MAX_EXPANDED_BYTES) return null;
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength), name = nameBytes.toString('utf8');
    if (names.has(name) || /[\\\x00-\x1f\ufffd]/u.test(name) || name.startsWith('/')
        || name.split('/').some(part => part === '..' || part === '.') || /(?:vbaProject\.bin)$/i.test(name)) return null;
    names.add(name);
    if (offset + 30 > directory || bytes.readUInt32LE(offset) !== 0x04034b50
        || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method
        || bytes.readUInt16LE(offset + 26) !== nameLength) return null;
    const data = offset + 30 + nameLength + bytes.readUInt16LE(offset + 28);
    let finish = data + compressed;
    if (finish > directory || !bytes.subarray(offset + 30, offset + 30 + nameLength).equals(nameBytes)) return null;
    if (flags & 8) {
      if (finish + 12 > directory) return null;
      if (bytes.readUInt32LE(finish) === 0x08074b50) finish += 4;
      if (finish + 12 > directory || bytes.readUInt32LE(finish) !== crc
          || bytes.readUInt32LE(finish + 4) !== compressed || bytes.readUInt32LE(finish + 8) !== size) return null;
      finish += 12;
    } else if (bytes.readUInt32LE(offset + 14) !== crc || bytes.readUInt32LE(offset + 18) !== compressed
        || bytes.readUInt32LE(offset + 22) !== size) return null;
    entries.push({ name, offset, data, finish, compressed, size, crc, method });
    at = next;
  }
  if (at !== end || !names.has('[Content_Types].xml') || !names.has('word/document.xml')) return null;
  entries.sort((a, b) => a.offset - b.offset);
  let previous = 0;
  const parts = new Map();
  for (const entry of entries) {
    // Disallow overlaps, hidden local entries, prepended executables and gaps.
    if (entry.offset !== previous) return null;
    previous = entry.finish;
    const compressed = bytes.subarray(entry.data, entry.data + entry.compressed);
    const result = entry.method === 8
      ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size), info: true }) : null;
    const content = result ? result.buffer : compressed;
    if (content.length !== entry.size || (result && result.engine.bytesWritten !== compressed.length)
        || crc32(content) !== entry.crc) return null;
    if (['[Content_Types].xml', 'word/document.xml', 'docProps/app.xml'].includes(entry.name)) {
      // These parts are text only. Never expand entities or resolve references.
      const xml = content.toString('utf8').replace(/^\uFEFF/, '').replace(/<!--[^]*?-->/g, '');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || xml.includes('\0')) return null;
      parts.set(entry.name, xml);
    }
  }
  return previous === directory ? parts : null;
}

/** Bounded package sniff and advisory metadata only; no layout or rendering. */
export function inspectDocx(bytes) {
  try {
    const parts = wordParts(bytes);
    if (!parts) return null;
    const types = parts.get('[Content_Types].xml'), document = parts.get('word/document.xml');
    const mainType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
    const overrides = types.match(/<(?:[\w.-]+:)?Override\b[^>]*\/>/g) || [];
    if (!overrides.some(tag => /\bPartName\s*=\s*['"]\/word\/document\.xml['"]/.test(tag)
        && new RegExp(`\\bContentType\\s*=\\s*['"]${mainType.replaceAll('.', '\\.').replaceAll('+', '\\+')}['"]`).test(tag))) return null;
    if (!/<(?:[\w.-]+:)?document\b[^>]*\bxmlns(?::[\w.-]+)?\s*=\s*['"](?:http:\/\/schemas.openxmlformats.org\/wordprocessingml\/2006\/main|http:\/\/purl.oclc.org\/ooxml\/wordprocessingml\/main)['"][^>]*>/.test(document)
        || !/<(?:[\w.-]+:)?body\b/.test(document) || !/<\/(?:[\w.-]+:)?document\s*>\s*$/.test(document)) return null;
    const raw = /<(?:[\w.-]+:)?Pages\b[^>]*>\s*([0-9]+)\s*<\/(?:[\w.-]+:)?Pages\s*>/.exec(parts.get('docProps/app.xml') || '')?.[1];
    const pages = Number(raw);
    return { pageCount: Number.isSafeInteger(pages) && pages > 0 ? pages : null };
  } catch {
    // Corrupt headers, truncated streams and bounded-inflate refusals all fail closed.
    return null;
  }
}
