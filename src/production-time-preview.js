import { approvedCatalogView } from './catalog-review-state.js';
import { projectShopFinish, schedulingCalendar } from './order-match.js';
import { effectiveProductionTime, productionTimeFields } from './production-time.js';
import { shopProductionDayMinutes } from './production-days.js';
import { clientSpeedTiersFor } from './supplier-catalog.js';

export function previewProductionTime(store, item, choice, { now, days }) {
  const proposed = { ...item, ...productionTimeFields(choice, shopProductionDayMinutes(store, item.supplierId)) };
  const approved = approvedCatalogView(store);
  const listing = approved.catalogItems.find(row => row.id === item.id) || item;
  const timing = effectiveProductionTime(store, proposed);
  const project = (maximum, minimum = maximum) => projectShopFinish(store, { supplierId: item.supplierId,
    turnaroundHours: maximum / 60, minimumTurnaroundHours: minimum / 60, units: listing.minimumOrderQuantity ?? 1, now }).projection;
  const projection = project(timing.maximum, timing.minimum);
  const rushChoices = listing.pricedByColour ? [] : clientSpeedTiersFor(approved, item.id)
    .filter(tier => tier.turnaroundHours * 60 < timing.minimum).map(tier => {
      const fast = project(tier.turnaroundHours * 60);
      fast.scheduling.rushTier = tier;
      return fast;
    });
  return { productionTime: timing.choice, scheduling: projection.scheduling,
    calendar: schedulingCalendar(store, [{ projection, rushChoices, listing: { express: false } }], { now, days }) };
}
