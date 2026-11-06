import { approvedCatalogView } from './catalog-review-state.js';
import { shopFinishProjector, schedulingCalendar, calendarProbeProjector } from './order-match.js';
import { effectiveProductionTime, productionTimeFields } from './production-time.js';
import { shopProductionDayMinutes } from './production-days.js';
import { clientSpeedTiersFor } from './supplier-catalog.js';

export function previewProductionTime(store, item, choice, { now, days }) {
  const proposed = { ...item, ...productionTimeFields(choice, shopProductionDayMinutes(store, item.supplierId)) };
  const approved = approvedCatalogView(store);
  const listing = approved.catalogItems.find(row => row.id === item.id) || item;
  const timing = effectiveProductionTime(store, proposed);
  const project = (maximum, minimum = maximum) => shopFinishProjector(store, { supplierId: item.supplierId,
    turnaroundHours: maximum / 60, minimumTurnaroundHours: minimum / 60, units: listing.minimumOrderQuantity ?? 1 });
  const ordinary = project(timing.maximum, timing.minimum);
  const rushProjects = listing.pricedByColour ? [] : clientSpeedTiersFor(approved, item.id)
    .filter(tier => tier.turnaroundHours * 60 < timing.minimum).map(tier => {
      const projectFast = project(tier.turnaroundHours * 60);
      return at => {
        const fast = projectFast(at).projection;
        fast.scheduling.rushTier = tier;
        return fast;
      };
    });
  const projectAt = calendarProbeProjector(ordinary, rushProjects);
  const projection = ordinary(now).projection, rushChoices = rushProjects.map(project => project(now));
  return { productionTime: timing.choice, scheduling: projection.scheduling,
    calendar: schedulingCalendar(store, [{ projection, rushChoices, projectAt, listing: { express: false } }], { now, days }) };
}
