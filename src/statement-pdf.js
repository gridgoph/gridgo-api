import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// Embedded Unicode font keeps exports independent of host fonts and PDF viewers.
const font = readFileSync(new URL('./assets/DejaVuSans.ttf', import.meta.url));
const tables = new Map();
for (let i = 0; i < font.readUInt16BE(4); i++) {
  const offset = 12 + i * 16;
  tables.set(font.toString('ascii', offset, offset + 4), font.readUInt32BE(offset + 8));
}
const units = font.readUInt16BE(tables.get('head') + 18);
const metrics = font.readUInt16BE(tables.get('hhea') + 34);
const cmap = tables.get('cmap');
let groups = 0;
for (let i = 0; i < font.readUInt16BE(cmap + 2); i++) {
  const offset = cmap + font.readUInt32BE(cmap + 4 + i * 8 + 4);
  if (font.readUInt16BE(offset) === 12) groups = offset;
}
if (!groups) throw new Error('Statement font requires a Unicode format-12 cmap');
function glyph(code) {
  for (let i = 0; i < font.readUInt32BE(groups + 12); i++) {
    const offset = groups + 16 + i * 12;
    const start = font.readUInt32BE(offset), end = font.readUInt32BE(offset + 4);
    if (code >= start && code <= end) return font.readUInt32BE(offset + 8) + code - start;
  }
  return 0;
}
const width = (code) => Math.round(font.readUInt16BE(tables.get('hmtx') + Math.min(glyph(code), metrics - 1) * 4) * 1000 / units);
const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');

export function statementPdf(statement, pesos) {
  const pages = [[]];
  let y = 792;
  const used = new Map();
  const encode = (text) => [...text].map((char) => {
    const code = char.codePointAt(0);
    if (!used.has(code)) used.set(code, used.size + 1);
    return used.get(code).toString(16).padStart(4, '0');
  }).join('');
  const line = (value, size = 10, color = '0.12 0.17 0.23') => {
    const text = clean(value);
    // Wrap by actual font advance, including long unbroken IDs.
    let part = '', advance = 0;
    for (const char of text) {
      const next = width(char.codePointAt(0)) * size / 1000;
      if (advance + next > 499 && part) { draw(part, size, color); part = ''; advance = 0; }
      part += char; advance += next;
    }
    draw(part, size, color);
  };
  const header = () => {
    draw('GRIDGO | Organization statement', 18);
    draw('Not a tax document. Official receipts are issued separately.', 10, '0.5 0.2 0.1');
    draw(`${statement.period.from} to ${statement.period.to} | Asia/Manila | PHP`, 10);
    y -= 10;
  };
  const draw = (text, size = 10, color = '0.12 0.17 0.23') => {
    if (y < 58) { pages.push([]); y = 792; header(); }
    pages.at(-1).push(`${color} rg BT /F1 ${size} Tf 1 0 0 1 48 ${y} Tm <${encode(text)}> Tj ET`);
    y -= size + 6;
  };
  header();
  line(`Total spend: PHP ${pesos(statement.totalSpendMinor)}`, 14);
  line(`Closed orders: ${statement.orderCount}    Discount earned: PHP ${pesos(statement.discountEarnedMinor)}`, 11);
  y -= 12;
  if (!statement.orders.length) line('No closed orders in this period.');
  for (const row of statement.orders) {
    if (y < 165) { pages.push([]); y = 792; header(); }
    line(`${row.date} | ${row.orderId}`, 11);
    line(`Product: ${row.product || '-'}`);
    line(`Amount: PHP ${pesos(row.amountMinor)}    Discount: PHP ${pesos(row.organizationDiscountMinor)}`);
    line(`Invoice: ${row.invoiceNumber || '-'}`);
    line(`Officer of record: ${row.officerOfRecord || ''}`);
    y -= 12;
  }
  pages.forEach((commands, index) => commands.push(`0.4 0.4 0.4 rg BT /F1 9 Tf 1 0 0 1 48 30 Tm <${encode(`Page ${index + 1} of ${pages.length}`)}> Tj ET`));
  const objects = [null];
  const reserve = () => (objects.push(null), objects.length - 1);
  const add = (value) => (objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value)), objects.length - 1);
  const stream = (bytes, extra = '') => {
    const compressed = deflateSync(bytes);
    return Buffer.concat([Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode ${extra} >>\nstream\n`), compressed, Buffer.from('\nendstream')]);
  };
  const catalog = reserve(), pageTree = reserve(), fontId = reserve();
  const fontFile = add(stream(font, `/Length1 ${font.length}`));
  const descriptor = add(`<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [-1021 -463 1794 1232] /ItalicAngle 0 /Ascent 928 /Descent -236 /CapHeight 729 /StemV 80 /FontFile2 ${fontFile} 0 R >>`);
  const mapping = Buffer.alloc((used.size + 1) * 2);
  for (const [code, cid] of used) mapping.writeUInt16BE(glyph(code), cid * 2);
  const mappingId = add(stream(mapping));
  const widths = [...used.keys()].map(width).join(' ');
  const descendant = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /CIDToGIDMap ${mappingId} 0 R /W [1 [${widths}]] >>`);
  const unicodeHex = (code) => {
    const bytes = Buffer.from(String.fromCodePoint(code), 'utf16le');
    bytes.swap16();
    return bytes.toString('hex');
  };
  const entries = [...used].map(([code, cid]) => `<${cid.toString(16).padStart(4, '0')}> <${unicodeHex(code)}>`);
  let cmapText = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /GridgoUnicode def /CMapType 2 def 1 begincodespacerange <0000> <ffff> endcodespacerange\n';
  for (let i = 0; i < entries.length; i += 100) { const batch = entries.slice(i, i + 100); cmapText += `${batch.length} beginbfchar\n${batch.join('\n')}\nendbfchar\n`; }
  cmapText += 'endcmap CMapName currentdict /CMap defineresource pop end end';
  const toUnicode = add(stream(Buffer.from(cmapText)));
  objects[fontId] = Buffer.from(`<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
  const pageIds = pages.map((commands) => {
    const content = add(stream(Buffer.from(commands.join('\n'))));
    return add(`<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[pageTree] = Buffer.from(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
  objects[catalog] = Buffer.from(`<< /Type /Catalog /Pages ${pageTree} 0 R >>`);
  const chunks = [Buffer.from('%PDF-1.7\n')], offsets = [0];
  let length = chunks[0].length;
  for (let i = 1; i < objects.length; i++) {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')]);
    chunks.push(chunk); length += chunk.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
