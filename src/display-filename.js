/** Decode once for display only. Never change stored names, keys or download paths. */
export function displayFilename(value) {
  if (typeof value !== 'string') return value;
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* Preserve malformed percent escapes. */ }
  return decoded.replace(/[\u0000-\u001f\u007f]/g, '');
}
