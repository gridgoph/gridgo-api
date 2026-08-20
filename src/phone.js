import { CatalogError } from "./supplier-catalog.js";

const LOCAL = /^0(9\d{9})$/;
const INTERNATIONAL = /^\+?63(9\d{9})$/;

/**
 * Read one Philippine mobile number the way a shop owner types it.
 *
 * Owners copy the number off a receipt, a chat thread, or a calling card, so it
 * arrives as `0917 123 4567`, `(0917) 123-4567`, `639171234567`, or already
 * international. GRIDGO keeps one canonical `+639XXXXXXXXX` form so a rider,
 * a client, and Operations all dial the same digits.
 *
 * A blank value is a rejection, not a clear: the floor phone is how a customer
 * reaches the shop, and losing it silently would strand an order.
 *
 * This runs only where a shop edits its own details. Numbers captured at
 * enrollment stay exactly as they were stored.
 */
export function philippineMobileNumber(value, field = "phone") {
  if (value != null && typeof value !== "string") {
    throw new CatalogError(400, "invalid_supplier_profile", `${field} must be a string.`, { field });
  }
  const typed = String(value ?? "").trim();
  if (!typed) {
    throw new CatalogError(400, "invalid_supplier_profile", "Enter the mobile number customers can reach this shop on.", { field });
  }
  const compact = typed.replaceAll(/[\s()-]/g, "");
  const match = LOCAL.exec(compact) || INTERNATIONAL.exec(compact);
  if (!match) {
    throw new CatalogError(400, "invalid_supplier_profile", "Enter a Philippine mobile number, for example 0917 123 4567.", { field });
  }
  return `+63${match[1]}`;
}
