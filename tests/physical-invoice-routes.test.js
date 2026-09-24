import test from "node:test";
import assert from "node:assert/strict";

import { routePhysicalInvoice } from "../src/physical-invoice-routes.js";

const AT = "2026-09-21T06:00:00.000Z";

function fixture() {
  const user = { id: "user_client", role: "client", email: "client@gridgo.test" };
  const order = {
    id: "ord_1",
    clientId: user.id,
    state: "needs_qa",
    updatedAt: AT,
  };
  return {
    user,
    store: {
      users: [user],
      userRoleMemberships: [{ userId: user.id, role: "client" }],
      orders: [order],
    },
    order,
  };
}

function recordAudit(store, entry) {
  if (!Array.isArray(store.auditLog)) store.auditLog = [];
  const row = { id: `aud_${store.auditLog.length + 1}`, at: AT, actorId: entry.actor?.id || null, ...entry };
  delete row.actor;
  store.auditLog.push(row);
  return row;
}

async function call({ store, user }, method, pathname, body) {
  return routePhysicalInvoice({
    req: { method },
    url: new URL(`http://gridgo.test${pathname}`),
    store,
    user,
    readBody: async () => body,
    now: () => AT,
    audit: recordAudit,
  });
}

test("a client can request a physical invoice for their own order", async () => {
  const context = fixture();
  const created = await call(context, "POST", "/orders/ord_1/physical-invoice", {
    contactPerson: "Ana Reyes",
    officeAddress: "7th floor, 12 J.P. Laurel Ave, Davao City",
    operatingHours: "Mon–Fri 9am–5pm",
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.request.contactPerson, "Ana Reyes");
  assert.equal(created.body.request.operatingHours, "Mon–Fri 9am–5pm");
  assert.equal(created.body.request.requestedAt, AT);
  assert.equal(context.order.physicalInvoiceRequest.contactPerson, "Ana Reyes");

  const read = await call(context, "GET", "/orders/ord_1/physical-invoice");
  assert.equal(read.status, 200);
  assert.equal(read.body.request.officeAddress, "7th floor, 12 J.P. Laurel Ave, Davao City");
});

test("a second request on the same order is refused", async () => {
  const context = fixture();
  await call(context, "POST", "/orders/ord_1/physical-invoice", {
    contactPerson: "Ana Reyes",
    officeAddress: "12 Laurel",
    operatingHours: "9–5",
  });
  await assert.rejects(
    call(context, "POST", "/orders/ord_1/physical-invoice", {
      contactPerson: "Ana Reyes",
      officeAddress: "12 Laurel",
      operatingHours: "9–5",
    }),
    (error) => error.status === 409 && error.code === "physical_invoice_already_requested",
  );
});

test("another client's order is forbidden", async () => {
  const context = fixture();
  context.order.clientId = "someone_else";
  await assert.rejects(
    call(context, "POST", "/orders/ord_1/physical-invoice", {
      contactPerson: "Ana Reyes",
      officeAddress: "12 Laurel",
      operatingHours: "9–5",
    }),
    (error) => error.status === 403 && error.code === "forbidden",
  );
});

test("requesting a physical invoice writes an audit row naming the office", async () => {
  const context = fixture();
  await call(context, "POST", "/orders/ord_1/physical-invoice", {
    contactPerson: "Ana Reyes",
    officeAddress: "7th floor, 12 J.P. Laurel Ave, Davao City",
    operatingHours: "Mon\u2013Fri 9am\u20135pm",
  });

  const entries = (context.store.auditLog || []).filter(
    (entry) => entry.action === "order.physical_invoice_requested",
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].orderId, "ord_1");
  assert.equal(entries[0].entityType, "order");
  assert.equal(entries[0].entityId, "ord_1");
  assert.equal(entries[0].actorId, "user_client");
  assert.equal(entries[0].detail.officeAddress, "7th floor, 12 J.P. Laurel Ave, Davao City");
  assert.equal(entries[0].detail.contactPerson, "Ana Reyes");
});

const MONDAY_10 = "2026-09-21T02:00:00.000Z";
const TUESDAY_11 = "2026-09-22T03:00:00.000Z";

function withRequest(context = fixture()) {
  context.order.physicalInvoiceRequest = {
    contactPerson: "Ana Reyes",
    officeAddress: "7th floor, 12 J.P. Laurel Ave, Davao City",
    operatingHours: "Mon–Fri 9am–5pm",
    requestedAt: AT,
  };
  return context;
}

function asRole(context, role, id = `user_${role}`) {
  context.user = { id, role, email: `${role}@gridgo.test` };
  context.store.users.push(context.user);
  context.store.userRoleMemberships.push({ userId: id, role });
  return context;
}

test("ops_admin can promise a weekday 10:00 Asia/Manila delivery and the client can read it back", async () => {
  const context = asRole(withRequest(), "ops_admin");
  const promised = await call(context, "PATCH", "/orders/ord_1/physical-invoice", {
    promisedDeliveryAt: MONDAY_10,
  });

  assert.equal(promised.status, 200);
  assert.equal(promised.body.request.promisedDeliveryAt, MONDAY_10);
  assert.equal(context.order.physicalInvoiceRequest.promisedDeliveryAt, MONDAY_10);
  assert.equal(context.order.updatedAt, AT);

  const client = fixture();
  client.store = context.store;
  client.order = context.order;
  client.user = context.store.users.find((user) => user.role === "client");
  const read = await call(client, "GET", "/orders/ord_1/physical-invoice");
  assert.equal(read.status, 200);
  assert.equal(read.body.request.promisedDeliveryAt, MONDAY_10);
  assert.equal(read.body.request.contactPerson, "Ana Reyes");
});

test("super_admin can promise a physical-invoice delivery", async () => {
  const context = asRole(withRequest(), "super_admin");
  const promised = await call(context, "PATCH", "/orders/ord_1/physical-invoice", {
    promisedDeliveryAt: "2026-09-21T10:00:00+08:00",
  });
  assert.equal(promised.status, 200);
  assert.equal(promised.body.request.promisedDeliveryAt, MONDAY_10);
});

test("Saturday, Sunday, 07:59, and 17:00 Asia/Manila are outside the desk window", async () => {
  const outside = [
    "2026-09-19T02:00:00.000Z",
    "2026-09-20T02:00:00.000Z",
    "2026-09-20T23:59:00.000Z",
    "2026-09-21T09:00:00.000Z",
  ];
  for (const promisedDeliveryAt of outside) {
    const context = asRole(withRequest(), "ops_admin");
    await assert.rejects(
      call(context, "PATCH", "/orders/ord_1/physical-invoice", { promisedDeliveryAt }),
      (error) => error.status === 400 && error.code === "promise_outside_business_hours",
      promisedDeliveryAt,
    );
    assert.equal(context.order.physicalInvoiceRequest.promisedDeliveryAt, undefined);
  }
});

test("a client, a supplier, and a signed-out caller cannot promise a delivery", async () => {
  const client = withRequest();
  await assert.rejects(
    call(client, "PATCH", "/orders/ord_1/physical-invoice", { promisedDeliveryAt: MONDAY_10 }),
    (error) => error.status === 403,
  );

  const supplier = asRole(withRequest(), "supplier");
  await assert.rejects(
    call(supplier, "PATCH", "/orders/ord_1/physical-invoice", { promisedDeliveryAt: MONDAY_10 }),
    (error) => error.status === 403,
  );

  const signedOut = withRequest();
  signedOut.user = null;
  await assert.rejects(
    call(signedOut, "PATCH", "/orders/ord_1/physical-invoice", { promisedDeliveryAt: MONDAY_10 }),
    (error) => error.status === 401 && error.code === "unauthorized",
  );
});

test("promising a delivery on an order with no request is not found", async () => {
  const context = asRole(fixture(), "ops_admin");
  await assert.rejects(
    call(context, "PATCH", "/orders/ord_1/physical-invoice", { promisedDeliveryAt: MONDAY_10 }),
    (error) => error.status === 404 && error.code === "physical_invoice_not_found",
  );
});

test("promising a delivery writes an audit row naming the instant", async () => {
  const context = asRole(withRequest(), "ops_admin", "user_ops");
  await call(context, "PATCH", "/orders/ord_1/physical-invoice", { promisedDeliveryAt: MONDAY_10 });

  const entries = (context.store.auditLog || []).filter(
    (entry) => entry.action === "order.physical_invoice_promised",
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].orderId, "ord_1");
  assert.equal(entries[0].entityType, "order");
  assert.equal(entries[0].entityId, "ord_1");
  assert.equal(entries[0].actorId, "user_ops");
  assert.equal(entries[0].detail.promisedDeliveryAt, MONDAY_10);
});

test("a second promise replaces the instant and writes another audit row", async () => {
  const context = asRole(withRequest(), "ops_admin");
  await call(context, "PATCH", "/orders/ord_1/physical-invoice", { promisedDeliveryAt: MONDAY_10 });
  const again = await call(context, "PATCH", "/orders/ord_1/physical-invoice", {
    promisedDeliveryAt: TUESDAY_11,
  });

  assert.equal(again.status, 200);
  assert.equal(again.body.request.promisedDeliveryAt, TUESDAY_11);
  assert.equal(context.order.physicalInvoiceRequest.promisedDeliveryAt, TUESDAY_11);
  const entries = (context.store.auditLog || []).filter(
    (entry) => entry.action === "order.physical_invoice_promised",
  );
  assert.deepEqual(
    entries.map((entry) => entry.detail.promisedDeliveryAt),
    [MONDAY_10, TUESDAY_11],
  );
});

test("a refused second request writes no further audit row", async () => {
  const context = fixture();
  const request = {
    contactPerson: "Ana Reyes",
    officeAddress: "12 Laurel",
    operatingHours: "9\u20135",
  };
  await call(context, "POST", "/orders/ord_1/physical-invoice", request);
  await assert.rejects(call(context, "POST", "/orders/ord_1/physical-invoice", request));
  assert.equal(
    (context.store.auditLog || []).filter((entry) => entry.action === "order.physical_invoice_requested").length,
    1,
  );
});
