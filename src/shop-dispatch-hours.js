import { AvailabilityError, addOpeningMilliseconds, isOpenAt } from './availability.js';
import { dispatchReadyAt } from './operating-hours.js';

// Only new order clocks containing overrides opt in. Historical dispatch and
// the no-override path keep their existing platform-hours behavior.
export const hasWeekdayOverrides = schedule => Boolean(schedule?.weekdayOverrides?.length);
export const shopDispatchOpen = (order, at) => !hasWeekdayOverrides(order?.shopClock?.schedule)
  || isOpenAt(order.shopClock.schedule, at);

/** First overlap of shop opening and GRIDGO's dispatch window. */
export function nextShopDispatchAt(settings, schedule, at) {
  let cursor = at;
  for (let day = 0; day < 366; day++) {
    const shopOpening = addOpeningMilliseconds(schedule, cursor, 0);
    const next = dispatchReadyAt(settings, shopOpening);
    if (isOpenAt(schedule, next)) return next;
    cursor = next;
  }
  throw new AvailabilityError(409, 'dispatch_unavailable', 'No shop opening overlaps GRIDGO dispatch hours.');
}

export function requireShopDispatchHours(order, settings, at) {
  if (!shopDispatchOpen(order, at)) {
    throw new AvailabilityError(409, 'outside_shop_hours', 'Dispatch resumes when the shop and GRIDGO are open.', {
      nextDispatchAt: nextShopDispatchAt(settings, order.shopClock.schedule, at),
    });
  }
}
