import test from 'node:test';
import assert from 'node:assert/strict';
import { maskChatContacts } from '../src/chat-contact-masking.js';
import { clientShopChatWindow } from '../src/client-shop-chat.js';

for (const contact of ['09171234567', '+63 917 123 4567', '0917.123.4567', '0 9 1 7 1 2 3 4 5 6 7', '(+63) 917-123-4567',
  'hello@example.com', 'hello at example dot com', 'hello (at) example [dot] com', '@my_printshop', 'IG: printshop_24',
  'https://example.com/shop', 'www.example.com', 'example.com', 'example dot com', 'fb dot com/myshop', 'https : // example.com',
  'hello@example.travel', 'hello at example dot museum', 'https://example.travel/path', 'example.travel', 'https://127.0.0.1/path', '+1 202 555 0123', '０９１７１２３４５６７', '09\u200b171234567']) {
  test(`masks contact: ${contact}`, () => {
    const result = maskChatContacts(`Please use ${contact} thanks`);
    assert.equal(result.contactAttempt, true);
    assert.equal(result.text, 'Please use [contact hidden] thanks');
  });
}
for (const [contact, afterAt] of [
  ['facebook.com/sampleprints', '[contact hidden] thanks'],
  ['https://x.com/abc?y=1', 'page at [contact hidden] thanks'],
  ['fb.com/x', '[contact hidden] thanks'], ['m.me/x', '[contact hidden] thanks'],
  ['wa.me/639000000000', '[contact hidden] thanks'],
  ['facebook.com/sampleprints/photos?ref=chat#profile', '[contact hidden] thanks'],
  ['example.travel/profile?handle=sampleprints', '[contact hidden] thanks'],
  ['facebook dot com/sampleprints', '[contact hidden] thanks'],
  ['facebook.com:8443/sampleprints?ref=chat', '[contact hidden] thanks'],
  ['@sampleprints/profile?ref=chat', 'page at [contact hidden] thanks'],
  ['IG: sampleprints/profile#contact', 'page at [contact hidden] thanks'],
  ['@' + 'fixture'.repeat(20) + '/profile', 'page at [contact hidden] thanks'],
  ['https://x.com/abc?to=fixture@example.invalid&user=fixture-profile', 'page at [contact hidden] thanks'],
  ['example.com/path?to=fixture@example.invalid&user=fixture-profile', '[contact hidden] thanks'],
]) {
  for (const [prefix, expected] of [['Please use ', 'Please use [contact hidden] thanks'], ['page at ', afterAt]]) {
    test(`masks the entire contact token after ${prefix.trim()}: ${contact}`, () => {
      assert.deepEqual(maskChatContacts(`${prefix}${contact} thanks`), { text: expected, contactAttempt: true });
    });
  }
}
for (const body of ['Please print 1000 copies, size 8.5 x 11 inches.', 'Use 09 sheets for each of the 12 sets.',
  'The price is PHP 2,000.00 for 500 copies.', 'Finish by 2026-10-20 at 09:30.', 'Order 123456 needs 200 A4 sheets.',
  'Use 63 pieces in 9 packs.', 'The dot pattern should be red.', 'print 09 17 12 pieces', 'Thank you GRIDGO', 'The order is ready. Please collect it.', 'Meet at noon. Bring the invoice.']) {
  test(`preserves ordinary text: ${body}`, () => assert.deepEqual(maskChatContacts(body), { text: body, contactAttempt: false }));
}

test('accepted production through issue-window expiry, then permanently readable', () => {
  const at = '2026-10-17T12:00:00.000Z';
  const order = { supplierId: 'shop', state: 'production', shopAcceptance: { supplierId: 'shop', status: 'accepted' } };
  assert.equal(clientShopChatWindow(order, at).status, 'open');
  assert.equal(clientShopChatWindow({ ...order, shopAcceptance: { status: 'pending' } }, at).status, 'unavailable');
  assert.equal(clientShopChatWindow({ ...order, state: 'cancelled' }, at).status, 'read_only');
  assert.equal(clientShopChatWindow({ ...order, state: 'issue_window_open', issueWindowExpiresAt: at }, at).status, 'read_only');
  assert.equal(clientShopChatWindow({ ...order, state: 'issue_window_open', issueWindowExpiresAt: '2026-10-17T13:00:00Z' }, at).status, 'open');
  assert.equal(clientShopChatWindow({ ...order, state: 'completed' }, at).status, 'read_only');
  assert.equal(clientShopChatWindow({ supplierId: 'shop', state: 'production' }, at).status, 'open', 'legacy accepted production');
  assert.equal(clientShopChatWindow({ ...order, shopRecovery: { status: 'awaiting_client' } }, at).status, 'read_only');
});
