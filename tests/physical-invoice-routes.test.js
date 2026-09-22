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
