/**
 * GRIDGO's own counter in Davao.
 *
 * GRIDGO is the storefront a client buys from; the approved shop that runs the
 * job is GRIDGO's arrangement, not the client's. So a client never collects
 * from a shop and is never given a shop's address: a GRIDGO rider brings the
 * finished job here, and the client collects here.
 *
 * Production is unchanged by this. A job is still assigned to a real supplier,
 * `job.pickup` is still that supplier's shop, and the rider and supplier
 * projections still carry it — that is the address a rider actually drives to.
 * Only what the *client* is shown moves to this pin.
 *
 * One owner for the coordinates. They came from the captain against a Google
 * Maps link and are not derived from any stored record, so a second copy is a
 * second thing to get wrong. `lib/gridgoOffice.ts` in gridgo-client holds the
 * same pin for the surfaces that draw it before an order exists.
 */
export const GRIDGO_OFFICE = Object.freeze({
  lat: 7.13267,
  lng: 125.611265,
  label: "GRIDGO Office",
});

/** A fresh copy, because callers write it onto a projection they then mutate. */
export function gridgoOfficePoint() {
  return { ...GRIDGO_OFFICE };
}
