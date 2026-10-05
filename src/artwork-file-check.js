import fs from 'node:fs/promises';
import { inspectArtwork } from './artwork-inspection.js';

const MAX_HEAD = 16 * 1024 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crcUpdate(crc, bytes) {
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return crc >>> 0;
}
function pngChunks(bytes) {
  let at = 8, hasData = false;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    if (at + 12 + length > bytes.length) return false;
    const type = bytes.subarray(at + 4, at + 8).toString();
    const crc = (crcUpdate(0xffffffff, bytes.subarray(at + 4, at + 8 + length)) ^ 0xffffffff) >>> 0;
    if (crc !== bytes.readUInt32BE(at + 8 + length)) return false;
    if (type === 'IDAT' && length > 0) hasData = true;
    at += 12 + length;
    if (type === 'IEND') return hasData && length === 0 && at === bytes.length;
  }
  return false;
}
function webpImage(head, size) {
  let offset = 12, image = false;
  while (offset + 8 <= head.length && offset + 8 <= size) {
    const type = head.subarray(offset, offset + 4).toString();
    const length = head.readUInt32LE(offset + 4);
    if (offset + 8 + length > size) return false;
    if (type === 'VP8 ' && length >= 10 && offset + 18 <= head.length) {
      image ||= head.subarray(offset + 11, offset + 14).equals(Buffer.from('9d012a', 'hex'))
        && (head.readUInt16LE(offset + 14) & 0x3fff) > 0 && (head.readUInt16LE(offset + 16) & 0x3fff) > 0;
    }
    if (type === 'VP8L' && length >= 5 && head[offset + 8] === 0x2f) image = true;
    // Animated images contain their frame bitstreams inside ANMF.
    if (type === 'ANMF' && length >= 32 && offset + 32 <= head.length) {
      const frameType = head.subarray(offset + 24, offset + 28).toString();
      image ||= ['VP8 ', 'VP8L'].includes(frameType);
    }
    offset += 8 + length + (length & 1);
  }
  return image && offset === size;
}
const FIX = 'Export the original design again as a supported file, then upload and replace this artwork.';

// A bounded structural check, independent of advisory print measurements.
// Operations still opens the actual file and checks print readiness after payment.
export function checkArtworkBytes(head, tail, size, type, at, { pngStructure = null } = {}) {
  let valid = false;
  const detected = inspectArtwork(head, type);
  if (type === 'application/pdf') {
    valid = head.subarray(0, 5).toString() === '%PDF-' && /%%EOF\s*$/.test(tail.toString('latin1'))
      && detected?.pageCount > 0 && !/\/Encrypt\b/.test(head.toString('latin1'))
      && /startxref\s+(\d+)\s+%%EOF\s*$/.test(tail.toString('latin1'))
      && Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail.toString('latin1'))?.[1]) < size;
  } else if (type === 'image/png') {
    valid = head.length >= 33 && head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      && head.readUInt32BE(8) === 13 && head.subarray(12, 16).toString() === 'IHDR'
      && detected?.pixelWidth > 0 && detected?.pixelHeight > 0
      && tail.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))
      && (pngStructure ?? (head.length === size && pngChunks(head)));
  } else if (type === 'image/jpeg') {
    valid = head[0] === 0xff && head[1] === 0xd8 && detected?.pixelWidth > 0 && detected?.pixelHeight > 0
      && head.includes(Buffer.from([0xff, 0xda])) && tail.at(-2) === 0xff && tail.at(-1) === 0xd9;
  } else if (type === 'image/webp') {
    valid = head.length >= 30 && head.subarray(0, 4).toString() === 'RIFF'
      && head.subarray(8, 12).toString() === 'WEBP' && head.readUInt32LE(4) + 8 === size
      && webpImage(head, size);
  } else if (type === 'image/vnd.adobe.photoshop') {
    valid = head.length >= 26 && head.subarray(0, 4).toString() === '8BPS' && head.readUInt16BE(4) === 1
      && head.subarray(6, 12).every(byte => byte === 0) && head.readUInt16BE(12) > 0
      && head.readUInt32BE(14) > 0 && head.readUInt32BE(18) > 0 && [1, 8, 16, 32].includes(head.readUInt16BE(22));
    let offset = 26;
    for (let section = 0; valid && section < 3; section++) {
      if (offset + 4 > head.length) { valid = false; break; }
      offset += 4 + head.readUInt32BE(offset);
    }
    valid &&= offset + 2 < size && offset + 2 <= head.length && head.readUInt16BE(offset) <= 3;
    if (valid && head.readUInt16BE(offset) === 0) {
      const rawSize = head.readUInt16BE(12) * head.readUInt32BE(14) * Math.ceil(head.readUInt32BE(18) * head.readUInt16BE(22) / 8);
      valid = Number.isSafeInteger(rawSize) && offset + 2 + rawSize === size;
    }
  }
  return { status: valid ? 'passed' : 'failed', checkedAt: at,
    reason: valid ? null : 'artwork_file_unreadable',
    message: valid ? 'The file passed its automatic structural check. Operations will check print readiness.' : `The artwork is incomplete, protected, or could not be read. ${FIX}` };
}

export async function checkArtworkUpload(file, type, at) {
  let handle;
  try {
    handle = await fs.open(file.tempPath, 'r');
    const size = (await handle.stat()).size;
    const head = Buffer.alloc(Math.min(size, MAX_HEAD));
    const tail = Buffer.alloc(Math.min(size, 4096));
    await handle.read(head, 0, head.length, 0);
    await handle.read(tail, 0, tail.length, size - tail.length);
    let pngStructure = null;
    if (type === 'image/png' && size > head.length) {
      let offset = 8, hasData = false;
      pngStructure = false;
      const chunk = Buffer.alloc(64 * 1024);
      for (let count = 0; count < 100_000 && offset + 12 <= size; count++) {
        const header = Buffer.alloc(8);
        await handle.read(header, 0, 8, offset);
        const length = header.readUInt32BE(0);
        const kind = header.subarray(4).toString();
        if (offset + 12 + length > size) break;
        let crc = crcUpdate(0xffffffff, header.subarray(4));
        for (let position = 0; position < length;) {
          const wanted = Math.min(chunk.length, length - position);
          const { bytesRead } = await handle.read(chunk, 0, wanted, offset + 8 + position);
          if (bytesRead !== wanted) throw new Error('incomplete_artwork');
          crc = crcUpdate(crc, chunk.subarray(0, bytesRead));
          position += bytesRead;
        }
        const checksum = Buffer.alloc(4);
        await handle.read(checksum, 0, 4, offset + 8 + length);
        if (((crc ^ 0xffffffff) >>> 0) !== checksum.readUInt32BE(0)) break;
        if (kind === 'IDAT' && length > 0) hasData = true;
        offset += 12 + length;
        if (kind === 'IEND') { pngStructure = hasData && length === 0 && offset === size; break; }
      }
    }
    return checkArtworkBytes(head, tail, size, type, at, { pngStructure });
  } catch {
    return { status: 'failed', checkedAt: at, reason: 'artwork_file_unreadable', message: `The artwork could not be checked. ${FIX}` };
  } finally { await handle?.close(); }
}
