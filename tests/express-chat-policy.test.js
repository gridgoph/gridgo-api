import test from 'node:test';
import assert from 'node:assert/strict';
import { clientShopChatWindow, clientShopChatProjection } from '../src/client-shop-chat.js';
import { maskOrderChat } from '../src/chat-contact-masking.js';
import { fixture, actors, AT } from './fixtures/reschedule.js';

const sent = { id: 'order', orderType: 'express', supplierId: 'supplier', clientId: 'client', state: 'supplier_assigned',
  expressOrder: { acceptFlow: 2, events: [{ state: 'sending', at: AT }] }, shopAcceptance: { supplierId: 'supplier', status: 'pending' } };
test('Express chat opens at Send and stays open until the configured pickup deadline', () => {
  assert.equal(clientShopChatWindow(sent, AT).status, 'open');
  assert.equal(clientShopChatWindow({ ...sent, expressOrder: { events: [] } }, AT).status, 'unavailable');
  const picked = { ...sent, state: 'completed', issueWindowExpiresAt: AT, expressOrder: { ...sent.expressOrder, pickedUpAt: AT } };
  assert.deepEqual(clientShopChatWindow(picked, '2026-10-05T23:59:59Z'), { status: 'open', closesAt: '2026-10-06T00:00:00.000Z' });
  assert.equal(clientShopChatWindow(picked, '2026-10-06T00:00:00Z').status, 'read_only');
  assert.equal(clientShopChatWindow(picked, '2026-10-05T02:00:00Z', { orderChatCloseAfterPickupHours: 1 }).status, 'read_only');
  assert.equal(clientShopChatWindow({ ...sent, state: 'cancelled' }, AT).status, 'read_only');
});
test('Express chat returns the fixed note, role quick replies and disabled calling capability', () => {
  const store = fixture();
  const chat = clientShopChatProjection(sent, actors.client, store, AT);
  assert.equal(chat.note, 'Keep the chat about the job. Call the shop with the call button.');
  assert.deepEqual(chat.quickReplies.map(row => row.text), ['Can you staple it?', 'Colour cover only', 'Is it ready?']);
  assert.deepEqual(chat.calling, { available: false, reason: 'calling_service_not_configured' });
  store.approvalCases.find(c => c.userId === 'supplier').status = 'pending';
  assert.equal(clientShopChatProjection(sent, actors.supplier, store, AT).status, 'open', 'assigned pending shops retain operational chat access');
  store.approvalCases.find(c => c.userId === 'supplier').status = 'rejected';
  assert.equal(clientShopChatProjection(sent, actors.supplier, store, AT), null);
});
test('Express masking hides contact/payment/address details and preserves production quantities', () => {
  const order = { ...sent, homePrinter: { supplierId: 'supplier', pickupPoint: { description: 'Cedar gate' } } };
  assert.equal(maskOrderChat('Call 09171234567; wallet number: 1234 5678 9012', order).text, 'Call [number hidden]; wallet number: [number hidden]');
  assert.equal(maskOrderChat('Meet at 18 Cedar Street, by the gate', order).text, 'Meet at [number hidden]');
  assert.equal(maskOrderChat('Cedar gate', order).text, '[number hidden]');
  assert.equal(maskOrderChat('cedar GATE', order).text, '[number hidden]');
  assert.equal(maskOrderChat('wallet 1234 5678 9012', order).text, 'wallet [number hidden]');
  assert.equal(maskOrderChat('Payment is PHP 1200 for 12 pages.', order).text, 'Payment is PHP 1200 for 12 pages.');
  assert.equal(maskOrderChat('12 pages, 3 sets, staple at 2 cm; ready at 5 PM', order).text, '12 pages, 3 sets, staple at 2 cm; ready at 5 PM');
  assert.equal(maskOrderChat('18 Cedar Street', { ...order, shopAcceptance: { status: 'accepted' } }).text, '18 Cedar Street');
  assert.equal(maskOrderChat('000201010212 payment payload 6304ABCD', order).text, '[number hidden]');
});
