import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDocumentPages } from '../src/document-pages.js';
import { priceLine } from '../src/pricing.js';

test('all pages, single pages, sorted ranges and duplicate overlaps', () => {
  assert.deepEqual(selectDocumentPages(10), { total: 10, range: null, printed: 10 });
  assert.deepEqual(selectDocumentPages(10, ' 8-10, 1-4, 3-6, 8 '), { total: 10, range: '1-6, 8-10', printed: 9 });
  assert.deepEqual(selectDocumentPages(10, '2, 2'), { total: 10, range: '2', printed: 1 });
});

test('invalid or out-of-file selections are refused, without expanding ranges', () => {
  for (const range of ['0', '-1', '3-2', '11', '1-11', '1.5', '1,,2', 'all', ' ', '1-', [], 3, '1'.repeat(1001)]) {
    assert.throws(() => selectDocumentPages(10, range), { code: 'invalid_page_range' });
  }
  assert.equal(selectDocumentPages(Number.MAX_SAFE_INTEGER, `1-${Number.MAX_SAFE_INTEGER}`).printed, Number.MAX_SAFE_INTEGER);
});

test('ranges preserve the existing copies, options, minimum and quantity-tier calculation', () => {
  const selection = selectDocumentPages(30, '1-4, 4');
  const input = { unit: 'per_page', basePriceMinor: 300, quantity: 3,
    measurement: { pages: selection.printed }, minimumOrderQuantity: 2,
    volumeTiers: [{ minQuantity: 3, unitPriceMinor: 200 }], options: [{ priceMultiplierBps: 20000 }] };
  assert.equal(priceLine(input).lineSubtotalMinor, 4800);
  assert.throws(() => priceLine({ ...input, quantity: 1 }), { code: 'below_minimum_quantity' });
});
