// A two-page PDF with an xref table; each page has a distinct colored rectangle.
export function previewPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >>',
    stream('1 0 0 rg 20 20 200 100 re f'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 6 0 R >>',
    stream('0 0 1 rg 20 20 100 200 re f'),
  ];
  let text = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.slice(1).map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('');
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
function stream(text) { return `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`; }
