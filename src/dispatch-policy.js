import { operatingHours } from './operating-hours.js';
import { isOpenAt } from './availability.js';
import { isContainedPickup } from "./operational-model.js";
import { refundHold, refundSettlementFor } from "./refund-policy.js";
import { rescheduleHold } from "./order-reschedule-policy.js";
import { recoveryHeld } from "./shop-recovery.js";

export function dispatchWorkHeld(store, order) {
  return Boolean(refundHold(store, order) || refundSettlementFor(store, order)
    || recoveryHeld(order) || rescheduleHold(order));
}

/** The shared pool has no distance, zone, or vehicle restriction. */
export function availableDispatch(order, store, at = new Date().toISOString()) {
  return Boolean(order && (!order.operatingClock || isOpenAt(operatingHours(store.settings).schedule, at)) && order.state === "ready_for_dispatch" && !order.riderId
    && !isContainedPickup(order) && !dispatchWorkHeld(store, order));
}

/** Keep aligned with the rider app's ACTIVE_TRIP_STATES. */
export function riderHasActiveDelivery(store, userId) {
  return (store.orders || []).some(order => order.riderId === userId
    && ["rider_assigned", "picked_up", "out_for_delivery"].includes(order.state));
}
