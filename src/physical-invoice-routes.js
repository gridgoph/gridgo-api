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
    ...(request.promisedDeliveryAt ? { promisedDeliveryAt: request.promisedDeliveryAt } : {}),
  };
}

/**
 * GRIDGO's window for handing over a paper invoice.
 *
 * Asia/Manila is UTC+8 with no daylight saving. Monday–Friday, 08:00:00
 * inclusive through 17:00:00 exclusive. `operatingHours` is the client's own
 * note and is not read as a clock.
 */
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

function manilaWall(instantMs) {
  return new Date(instantMs + MANILA_OFFSET_MS);
}

export function isGridgoDeskInstant(iso) {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return false;
  const wall = manilaWall(parsed);
  const day = wall.getUTCDay();
  if (day === 0 || day === 6) return false;
  const seconds =
    wall.getUTCHours() * 3600 +
    wall.getUTCMinutes() * 60 +
    wall.getUTCSeconds() +
    wall.getUTCMilliseconds() / 1000;
  return seconds >= 8 * 3600 && seconds < 17 * 3600;
}

function parsePromisedInstant(value) {
  if (typeof value !== "string" || !value.trim()) {
    fail(400, "invalid_physical_invoice", "promisedDeliveryAt is required.", {
      field: "promisedDeliveryAt",
    });
  }
  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed)) {
    fail(400, "invalid_physical_invoice", "promisedDeliveryAt must be an instant.", {
      field: "promisedDeliveryAt",
    });
  }
  return new Date(parsed).toISOString();
}

function requireDesk(user) {
  if (!user) fail(401, "unauthorized", "Sign in to promise a physical invoice.");
  const privileged =
    identityHasMembership(user, "ops_admin") || identityHasMembership(user, "super_admin");
  if (!privileged) {
    fail(403, "forbidden", "Only Operations can promise when a physical invoice will arrive.");
  }
}

export function isPhysicalInvoiceRoute(method, pathname) {
  return /\/orders\/[^/]+\/physical-invoice$/.test(pathname) && ["GET", "POST", "PATCH"].includes(method);
}

/**
 * A printed invoice, sent to an office when the rider is not at the door.
 *
 * GET   /orders/:orderId/physical-invoice
 * POST  /orders/:orderId/physical-invoice { contactPerson, officeAddress, operatingHours }
 * PATCH /orders/:orderId/physical-invoice { promisedDeliveryAt }
 *
 * One request per order. The figures stay on the digital receipt; this is
 * only where to send a paper copy. The promise is when that copy will arrive,
 * and it is not the print job's promised date.
 */
export async function routePhysicalInvoice({ req, url, store, user, readBody, now, audit }) {
  const { pathname } = url;
  if (!isPhysicalInvoiceRoute(req.method, pathname)) return null;

  const orderId = pathname.split("/")[2];
  if (req.method === "PATCH") {
    return promisePhysicalInvoice({ req, store, user, readBody, now, audit, orderId });
  }

  requireClient(user);
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
  /*
   A paper invoice is a promise somebody at GRIDGO has to keep, so it is
   recorded as a change to the order rather than as a field that quietly
   appeared. The detail names the office, because "a physical invoice was
   requested" without a destination tells the desk nothing it can act on.
  */
  if (typeof audit === "function") {
    audit(store, {
      actor: user,
      action: "order.physical_invoice_requested",
      entityType: "order",
      entityId: order.id,
      orderId: order.id,
      detail: {
        contactPerson: request.contactPerson,
        officeAddress: request.officeAddress,
        operatingHours: request.operatingHours,
      },
    });
  }
  return { status: 201, body: { request: publicRequest(order) }, mutated: true };
}

async function promisePhysicalInvoice({ req, store, user, readBody, now, audit, orderId }) {
  requireDesk(user);
  const order = orderFor(store, orderId);
  if (!order) fail(404, "order_not_found", "That order no longer exists.");
  if (!order.physicalInvoiceRequest) {
    fail(404, "physical_invoice_not_found", "There is no physical-invoice request on this order yet.");
  }

  const body = record(await readBody(req));
  const promisedDeliveryAt = parsePromisedInstant(body.promisedDeliveryAt);
  if (!isGridgoDeskInstant(promisedDeliveryAt)) {
    fail(
      400,
      "promise_outside_business_hours",
      "Promise a Monday–Friday time from 8:00 am up to, but not including, 5:00 pm Philippine time.",
      { field: "promisedDeliveryAt" },
    );
  }

  const at = now();
  order.physicalInvoiceRequest.promisedDeliveryAt = promisedDeliveryAt;
  order.updatedAt = at;
  if (typeof audit === "function") {
    audit(store, {
      actor: user,
      action: "order.physical_invoice_promised",
      entityType: "order",
      entityId: order.id,
      orderId: order.id,
      detail: { promisedDeliveryAt },
    });
  }
  return { status: 200, body: { request: publicRequest(order) }, mutated: true };
}
