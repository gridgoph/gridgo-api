/** Shared dependency-free, paginated PDF format used by immutable order documents. */
export function textDocumentPdf(sourceLines, title) {
  const lines = sourceLines.flatMap(line => {
    let rest = String(line).replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const wrapped = [];
    while (rest.length > 100) {
      const space = rest.lastIndexOf(' ', 100);
      const end = space > 10 ? space : 100;
      wrapped.push(rest.slice(0, end)); rest = `  ${rest.slice(end).trimStart()}`;
    }
    return [...wrapped, rest];
  });
  const pages = Array.from({ length: Math.ceil(lines.length / 60) }, (_, index) => lines.slice(index * 60, (index + 1) * 60));
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'];
  const kids = [];
  for (const [pageIndex, page] of pages.entries()) {
    const number = objects.length + 1;
    kids.push(`${number} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${number + 1} 0 R >>`);
    const content = `BT /F1 9 Tf 12 TL 30 810 Td\n${page.map(line => `(${line.replace(/[\\()]/g, char => `\\${char}`)}) Tj T*`).join('\n')}\nET\nBT /F1 8 Tf 30 30 Td (${title} - Page ${pageIndex + 1} of ${pages.length}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
