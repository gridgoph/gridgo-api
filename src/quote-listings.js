/**
 * Private whole-job listings behind published quote options
 * (docs/QUOTE_REQUESTS_API.md). Each belongs to one client's quote request and
 * is priced only through that client's cart; every catalogue, board, match and
 * staff index leaves it out.
 */
const QUOTE_VIEWER = Symbol('quoteListingViewer');

export const isQuoteListing = (item) => Boolean(item?.quoteRequestId);

/**
 * Called once a cart route has proved the caller owns the cart. Not enumerable:
 * the grant is request context, never store content to compare or persist.
 */
export function grantQuoteListings(store, clientId) {
  if (store && clientId) Object.defineProperty(store, QUOTE_VIEWER, { value: clientId, enumerable: false, configurable: true, writable: true });
}

/** Carry the grant onto a derived store view. */
export function inheritQuoteViewer(from, to) {
  if (from?.[QUOTE_VIEWER] != null) grantQuoteListings(to, from[QUOTE_VIEWER]);
  return to;
}

export function quoteListingVisible(store, item) {
  return !isQuoteListing(item) || (store?.[QUOTE_VIEWER] != null && store[QUOTE_VIEWER] === item.quoteClientId);
}
