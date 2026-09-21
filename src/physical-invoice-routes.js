import { identityHasMembership } from "./authorization-context.js";

export class PhysicalInvoiceError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "PhysicalInvoiceError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details) {
  throw new PhysicalInvoiceError(status, code, message, details);
}

const CONTACT_MAX = 80;
const ADDRESS_MAX = 240;
const HOURS_MAX = 80;

function record(value, field = "body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, "invalid_physical_invoice", `${field} must be a JSON object.`, { field });
  }
  return value;
}

function text(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    fail(400, "invalid_physical_invoice", `${field} is required.`, { field });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    fail(400, "invalid_physical_invoice", `${field} must be at most ${maxLength} characters.`, {
      field,
      maxLength,
    });
  }
  return normalized;
}

function requireClient(user) {
  if (!user) fail(401, "unauthorized", "Sign in to request a physical invoice.");
  if (!identityHasMembership(user, "client")) {
    fail(403, "membership_required", "A GRIDGO client membership is required.", {
      requiredRole: "client",
    });
  }
}

function orderFor(store, orderId) {
  return (store.orders || []).find((row) => row.id === orderId) || null;
}

function publicRequest(order) {
  const request = order.physicalInvoiceRequest;
  if (!request) return null;
  return {
    orderId: order.id,
    contactPerson: request.contactPerson,
    officeAddress: request.officeAddress,
    operatingHours: request.operatingHours,
    requestedAt: request.requestedAt,
  };
}

export function isPhysicalInvoiceRoute(method, pathname) {
  return /\/orders\/[^/]+\/physical-invoice$/.test(pathname) && ["GET", "POST"].includes(method);
}

/**
 * A printed invoice, sent to an office when the rider is not at the door.
 *
 * GET  /orders/:orderId/physical-invoice
 * POST /orders/:orderId/physical-invoice { contactPerson, officeAddress, operatingHours }
 *
 * One request per order. The figures stay on the digital receipt; this is
 * only where to send a paper copy.
 */
export async function routePhysicalInvoice({ req, url, store, user, readBody, now }) {
  const { pathname } = url;
  if (!isPhysicalInvoiceRoute(req.method, pathname)) return null;

  requireClient(user);
  const orderId = pathname.split("/")[2];
  const order = orderFor(store, orderId);
  if (!order) fail(404, "order_not_found", "That order no longer exists.");
  if (order.clientId !== user.id) {
    fail(403, "forbidden", "That order belongs to another client.");
  }

  if (req.method === "GET") {
    const request = publicRequest(order);
    if (!request) {
      fail(404, "physical_invoice_not_found", "There is no physical-invoice request on this order yet.");
    }
    return { status: 200, body: { request }, mutated: false };
  }

  if (order.physicalInvoiceRequest) {
    fail(409, "physical_invoice_already_requested", "A physical invoice has already been requested for this order.");
  }

  const body = record(await readBody(req));
  const request = {
    contactPerson: text(body.contactPerson, "contactPerson", CONTACT_MAX),
    officeAddress: text(body.officeAddress, "officeAddress", ADDRESS_MAX),
    operatingHours: text(body.operatingHours, "operatingHours", HOURS_MAX),
    requestedAt: now(),
  };
  order.physicalInvoiceRequest = request;
  order.updatedAt = request.requestedAt;
  return { status: 201, body: { request: publicRequest(order) }, mutated: true };
}
