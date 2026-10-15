import test from 'node:test';
import assert from 'node:assert/strict';
import { specialInstructions } from '../src/special-instructions.js';
test('mask common contact formats without erasing ordinary print dimensions and quantities', () => {
  for (const value of ['+63 (917) 123-4567', '09171234567', 'me@example.com', 'www.example.com/a', 'example.ph', '@print_shop', 'FB: PrintShop', 'ｍｅ＠ｅｘａｍｐｌｅ．ｃｏｍ', '@my\u200bhandle']) {
    assert.equal(specialInstructions(value), '[masked]', value);
  }
  assert.equal(specialInstructions('A4, 300 dpi, 12 x 18 inches, 50 copies'), 'A4, 300 dpi, 12 x 18 inches, 50 copies');
  assert.equal(specialInstructions(null), '');
  assert.equal(specialInstructions('x'.repeat(300)).length, 300);
  assert.throws(() => specialInstructions('x'.repeat(301)), { code: 'invalid_special_instructions' });
  assert.throws(() => specialInstructions({ text: 'a' }), { code: 'invalid_special_instructions' });
});
