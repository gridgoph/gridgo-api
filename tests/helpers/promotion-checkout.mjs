import { fixture, id } from '../fixtures/reschedule.js';
import { defaultPromotionSettings } from '../../src/promotion-settings.js';
import { claimFounding } from '../../src/promotions.js';
import { routeOrderMatch } from '../../src/order-match-routes.js';
export const AT = '2026-10-27T01:00:00.000Z';
export function checkoutFixture({ percent = 100, amount = 20000 } = {}) {
  const store = fixture();
  store.settings.downpaymentPercent = percent;
  store.settings.serviceFeeSchedule = { version: 2, rounding: 'half_up_once', brackets: [{ upToMinor: 200000, rateBps: 4500 }, { upToMinor: 2000000, rateBps: 2500 }, { upToMinor: null, rateBps: 1500 }] };
  store.promotionSettings = [{ id: 'launch', version: 1, settings: defaultPromotionSettings() }];
  store.promotionSettings[0].settings.founding.amountMinor = amount;
  for (const [fileId, purpose] of [['artwork', 'artwork'], ['receipt', 'payment_proof']]) store.files.push({ fileId, purpose, ownerId: 'client', state: 'ready', objectKey: `private/${fileId}`, originalFilename: `${fileId}.pdf`, size: 100,
    declaredContentType: 'application/pdf', detectedContentType: 'application/pdf', artworkCheck: { status: 'passed', checkedAt: AT }, createdAt: AT, references: [] });
  claimFounding(store, 'client', { id, at: AT });
  return store;
}
export function cartCaller(store) {
  return (method, path, body = {}) => routeOrderMatch({ store, user: store.users.find(u => u.id === 'client'), req: { method, headers: {} }, url: new URL(path, 'http://test'), readBody: async () => body, id, now: () => AT });
}
export async function makeCart(store, quantities = [1]) {
  const call = cartCaller(store);
  const made = await call('POST', '/me/carts', { fulfillmentMode: 'delivery', defaultDropoff: store.orders[0].dropoff });
  const path = `/me/carts/${made.body.cart.id}`;
  for (const [index, quantity] of quantities.entries()) await call('POST', `${path}/lines`, { catalogItemId: `item_${index ? 'replacement' : 'supplier'}`, quantity, optionIds: [], artworkFileId: 'artwork', deadline: '2026-10-30T10:00:00.000Z' });
  return { call, path };
}
