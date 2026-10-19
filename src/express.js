/** The legacy listing switch remains editable. It never bypasses scheduling.
 * Existing orders retain their Express tag and immutable promises. */
export function listingExpress(item) { return item?.express === true; }
