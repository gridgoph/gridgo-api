import { CatalogError } from "./supplier-catalog.js";
import {
  privilegedAdminMemberships,
  queueInvalidate,
} from "./notifications.js";
export const fail = (code, message, status = 400, details = {}) => {
  throw new CatalogError(status, code, message, details);
};
export const text = (v, max = 2000) => {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max)
    fail("invalid_template_request", "Enter the requested text.");
  return v.trim();
};
export const positive = (v) => {
  if (!Number.isSafeInteger(v) || v <= 0)
    fail(
      "template_price_required",
      "Enter a full price greater than zero for every selected option.",
    );
  return v;
};
export function object(v) {
  if (!v || typeof v !== "object" || Array.isArray(v))
    fail("invalid_template_request", "Send a JSON object.");
  return v;
}
export function templateNotice(store, item, args, type, body) {
  store.notifications ||= [];
  const recipients = [
    ...(item.supplierId ? [{ userId: item.supplierId, role: "supplier" }] : []),
    ...privilegedAdminMemberships(store),
  ];
  for (const r of recipients)
    store.notifications.push({
      id: args.id("ntf"),
      userId: r.userId,
      appRole: r.role,
      type,
      title:
        type === "template_product_live"
          ? "Your product is live"
          : "Product setup updated",
      body,
      at: args.now(),
      read: false,
    });
  queueInvalidate(store, {
    resource: "catalog",
    id: item.id,
    supplierId: item.supplierId,
    userIds: recipients.map((r) => r.userId),
  });
}
export function templateFor(store, id) {
  const t = (store.productTemplates || []).find(
    (t) => t.id === id && t.active !== false,
  );
  if (!t)
    fail("product_template_not_found", "Choose an available template.", 404);
  return t;
}
