import { expressPoint, expressShopList } from './express-orders.js';
import { distanceMetersBetween } from './operational-model.js';
import { queueInvalidate } from './notifications.js';
import { notifyAdmins } from './domain-events.js';
import { manilaDay } from './shop-availability.js';

/** Called only by authenticated client demand, inside the domain transaction. */
export function pingPrinterDemand(store, user, body, { at, id }) {
  const location = expressPoint(body?.location);
  const shops = expressShopList(store, user, { location, fulfillmentMode: body.fulfillmentMode || 'pickup' }, at);
  let changed = false;
  for (const shop of shops) {
    if (!shop.nightWindow || distanceMetersBetween(location, shop.location) > 5000) continue;
    const profile = store.supplierProfiles.find(p => p.userId === shop.supplierId);
    if (profile.availability?.printerDemandPings !== true) continue;
    const night = shop.nightWindow.night;
    // An hours edit can move this instant between today's and yesterday's
    // night. Keep both budgets until neither can be visited again.
    const today = manilaDay(at), previous = manilaDay(new Date(Date.parse(at) - 86400000).toISOString());
    const history = (profile.availability.demandPings || []).filter(p => p.night >= previous && p.night <= today);
    const pings = history.filter(p => p.night === night);
    if (pings.length >= 3 || pings.some(p => p.clientId === user.id)) continue;
    history.push({ night, clientId: user.id, at });
    profile.availability.demandPings = history;
    const occurrenceKey = `printer-demand:${profile.userId}:${night}:${pings.length + 1}`;
    const members = (store.shopMemberships || []).filter(m => m.shopId === profile.userId);
    const recipients = members.length ? members.filter(m => m.status === 'active' && m.role === 'owner').map(m => m.userId) : [profile.userId];
    for (const userId of recipients) (store.notifications ||= []).push({ id: id('ntf'), userId, appRole: 'supplier', shopId: profile.userId,
      type: 'printer_demand', title: 'A nearby client needs a printer',
      body: 'A client nearby is looking for Express document printing.', at, read: false, occurrenceKey,
      night, expiresAt: shop.nightWindow.endsAt });
    notifyAdmins(store, 'ops_printer_demand', 'Nearby night printing demand', null, occurrenceKey, { createId: id, at });
    queueInvalidate(store, { resource: 'notifications', userIds: [profile.userId] });
    changed = true;
  }
  return changed;
}
