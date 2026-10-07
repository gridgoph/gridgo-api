import { PricingError } from './pricing.js';

const invalidRange = () => new PricingError(400, 'invalid_page_range',
  'Choose pages in this file, for example 1-4, 7. Each page is printed once per copy.', { field: 'pageRange' });

/** Merge intervals without expanding potentially large documents into arrays. */
export function selectDocumentPages(total, range = null) {
  if (!Number.isSafeInteger(total) || total < 1) return null;
  if (range == null || range === '') return { total, range: null, printed: total };
  if (typeof range !== 'string' || range.length > 1000) throw invalidRange();
  const intervals = range.split(',').map(part => {
    const match = /^\s*([1-9]\d*)\s*(?:-\s*([1-9]\d*)\s*)?$/.exec(part);
    if (!match) throw invalidRange();
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end > total) throw invalidRange();
    return [start, end];
  }).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of intervals) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return {
    total,
    range: merged.map(([start, end]) => start === end ? String(start) : `${start}-${end}`).join(', '),
    printed: merged.reduce((sum, [start, end]) => sum + end - start + 1, 0),
  };
}

/** Only server-inspected upload metadata determines billable document pages. */
export function documentPagesFor(store, item, line, range = line.documentPages?.range ?? null, { required = false } = {}) {
  if (item.pricingUnit !== 'per_page') {
    if (range != null) throw new PricingError(400, 'page_range_not_accepted', 'This listing is not priced by the page.', { field: 'pageRange' });
    return null;
  }
  const file = (store.files || []).find(row => row.fileId === line.artworkFileId && row.state === 'ready' && row.purpose === 'artwork');
  const total = file?.detected?.pageCount;
  if (!Number.isSafeInteger(total) || total < 1) {
    if (required || range != null) throw new PricingError(409, 'document_page_count_required',
      'Upload a document with a readable page count. If needed, export it as a PDF and upload it again.', { field: 'artwork', lineId: line.id });
    return null;
  }
  return selectDocumentPages(total, range);
}
