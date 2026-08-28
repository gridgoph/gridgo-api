import { CatalogError } from "./supplier-catalog.js";

const LOCAL = /^0(9\d{9})$/;
const INTERNATIONAL = /^\+?63(9\d{9})$/;

/**
 * Read one Philippine mobile number the way a person types it.
 *
 * It arrives as `0917 123 4567`, `(0917) 123-4567`, `639171234567`, or already
 * international. GRIDGO keeps one canonical `+639XXXXXXXXX` form so a rider,
 * a client, and Operations all dial the same digits.
 *
 * A blank value is a rejection, not a clear: the number is how GRIDGO and the
 * other party reach this person, and losing it silently would strand a job.
 *
 * This runs where a shop or a rider edits their own details. Numbers captured
 * at enrollment stay exactly as they were stored.
 */
export function philippineMobileNumber(value, field = "phone", options = {}) {
  const code = options.code || "invalid_supplier_profile";
  const blankMessage = options.blankMessage
    || "Enter the mobile number customers can reach this shop on.";
  if (value != null && typeof value !== "string") {
    throw new CatalogError(400, code, `${field} must be a string.`, { field });
  }
  const typed = String(value ?? "").trim();
  if (!typed) {
    throw new CatalogError(400, code, blankMessage, { field });
  }
  const compact = typed.replaceAll(/[\s()-]/g, "");
  const match = LOCAL.exec(compact) || INTERNATIONAL.exec(compact);
  if (!match) {
    throw new CatalogError(400, code, "Enter a Philippine mobile number, for example 0917 123 4567.", { field });
  }
  return `+63${match[1]}`;
}
