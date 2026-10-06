import { isContainedPickup } from "./operational-model.js";
import { recoveryHeld } from "./shop-recovery.js";

/** The shared pool has no distance, zone, or vehicle restriction. */
export function availableDispatch(order) {
  return Boolean(order && order.state === "ready_for_dispatch" && !order.riderId
    && !isContainedPickup(order) && !recoveryHeld(order));
}

/** Keep aligned with the rider app's ACTIVE_TRIP_STATES. */
export function riderHasActiveDelivery(store, userId) {
  return (store.orders || []).some(order => order.riderId === userId
    && ["rider_assigned", "picked_up", "out_for_delivery"].includes(order.state));
}
