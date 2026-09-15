import test from "node:test";
import assert from "node:assert/strict";

import { routePayoutAccount, opsPayoutAccountProjection } from "../src/payout-account.js";
import { authorizeFileRead, markFileDeletePending } from "../src/attachments.js";
import { publicOrderFor } from "../src/operational-model.js";
import { resolveAuthorizationContext, selectActorRole } from "../src/authorization-context.js";

const AT = "2026-09-15T00:00:00.000Z";
const LATER = "2026-09-15T01:00:00.000Z";

function qrFile(fileId, overrides = {}) {
  return {
    fileId,
    ownerId: "supplier",
    purpose: "supplier_payout_qr",
    originalFilename: `${fileId}.png`,
    declaredContentType: "image/png",
    detectedContentType: "image/png",
    size: 10,
    state: "ready",
    objectKey: `payout-qr/${fileId}.png`,
    references: [],
    createdAt: AT,
    readyAt: AT,
    ...overrides,
  };
}

function fixture() {
  const store = {
    users: [
      { id: "supplier", role: "supplier", email: "shop@gridgo.test", supplierName: "Lovis Printshop" },
      { id: "other_supplier", role: "supplier", email: "other@gridgo.test" },
      { id: "ops", role: "ops_admin", email: "ops@gridgo.test" },
      { id: "client", role: "client", email: "client@gridgo.test" },
    ],
    userRoleMemberships: [
      { userId: "supplier", role: "supplier" },
      { userId: "other_supplier", role: "supplier" },
      { userId: "ops", role: "ops_admin" },
      { userId: "client", role: "client" },
    ],
    approvalCases: [
      { id: "case_supplier", userId: "supplier", kind: "supplier", status: "approved" },
      { id: "case_other", userId: "other_supplier", kind: "supplier", status: "approved" },
    ],
    supplierProfiles: [{
      userId: "supplier", shopName: "Lovis Printshop", contactName: "Lovis",
      shop: { lat: 7.1, lng: 125.6, label: "Davao" }, pickupAvailable: false, version: 1, updatedAt: AT,
    }, {
      userId: "other_supplier", shopName: "Other Shop", contactName: "Other",
      shop: { lat: 7.1, lng: 125.6, label: "Davao" }, pickupAvailable: false, version: 1, updatedAt: AT,
    }],
    supplierPayoutAccounts: [],
    files: [qrFile("qr_one"), qrFile("qr_two"), qrFile("qr_theirs", { ownerId: "other_supplier" })],
    orders: [],
    auditLog: [],
  };
  return store;
}

function actor(store, id) {
  const user = store.users.find((candidate) => candidate.id === id);
  return selectActorRole(store, { ...user, context: resolveAuthorizationContext(store, user) }, user.role);
}

function call(store, { method, userId = "supplier", body = {}, headers = {}, at = AT, audit = () => {}, search = "" } = {}) {
  return routePayoutAccount({
    req: { method, headers },
    url: new URL(`http://127.0.0.1/me/payout-account${search}`),
    store,
    user: actor(store, userId),
    readBody: async () => body,
    now: () => at,
    audit,
  });
}

async function rejects(fn, status, code) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.status, status, `${error.code}: ${error.message}`);
    assert.equal(error.code, code);
    assert.match(error.message, /[A-Za-z]/);
    return true;
  });
}

test("a shop with no payout account reads back null and other routes are ignored", async () => {
  const store = fixture();
  const got = await call(store, { method: "GET" });
  assert.equal(got.status, 200);
  assert.equal(got.body.payoutAccount, null);
  assert.equal(await routePayoutAccount({
    req: { method: "GET", headers: {} },
    url: new URL("http://127.0.0.1/me/supplier-profile"),
    store,
    user: actor(store, "supplier"),
    readBody: async () => ({}),
    now: () => AT,
  }), null);
});

test("only a supplier may touch a payout account", async () => {
  const store = fixture();
  await rejects(() => call(store, { method: "GET", userId: "client" }), 403, "forbidden");
  await rejects(() => call(store, { method: "PATCH", userId: "ops", body: { provider: "gcash", accountName: "Ops" } }), 403, "forbidden");
});

test("a shop sets up GCash with its plate in one write and reads it back", async () => {
  const store = fixture();
  const actions = [];
  const created = await call(store, {
    method: "PATCH",
    body: { provider: "GCash", accountName: "  Lovis P.  ", accountNumber: "0917 123 4567", qrFileId: "qr_one" },
    audit: (_store, entry) => actions.push(entry),
  });
  assert.equal(created.status, 201);
  assert.equal(created.mutated, true);
  assert.deepEqual(created.body.payoutAccount, {
    supplierId: "supplier",
    provider: "gcash",
    accountName: "Lovis P.",
    accountNumber: "+639171234567",
    institution: null,
    qr: { fileId: "qr_one", originalFilename: "qr_one.png", detectedContentType: "image/png", size: 10, readyAt: AT },
    version: 1,
    updatedAt: AT,
  });
  assert.deepEqual(store.files[0].references, [{ type: "supplier_payout_account", id: "supplier", field: "qr" }]);
  assert.deepEqual(actions.map((entry) => [entry.action, entry.entityType, entry.entityId]), [
    ["payout_account.create", "payout_account", "supplier"],
  ]);

  const got = await call(store, { method: "GET" });
  assert.equal(got.body.payoutAccount.qr.fileId, "qr_one");
  assert.equal(got.body.payoutAccount.version, 1);
});

test("a wallet number must be a Philippine mobile number, a bank account is free text", async () => {
  const store = fixture();
  await rejects(
    () => call(store, { method: "PATCH", body: { provider: "maya", accountName: "Lovis", accountNumber: "12345" } }),
    400,
    "invalid_payout_account",
  );
  assert.equal(store.supplierPayoutAccounts.length, 0);
  const bank = await call(store, {
    method: "PATCH",
    body: { provider: "bank", institution: "BPI", accountName: "Lovis Printshop", accountNumber: "1234-5678-90" },
  });
  assert.equal(bank.status, 201);
  assert.equal(bank.body.payoutAccount.accountNumber, "1234-5678-90");
  assert.equal(bank.body.payoutAccount.institution, "BPI");
  assert.equal(bank.body.payoutAccount.qr, null);
});

test("provider and account name are required the first time, and the provider must be known", async () => {
  const store = fixture();
  await rejects(() => call(store, { method: "PATCH", body: { accountName: "Lovis" } }), 400, "invalid_payout_account");
  await rejects(() => call(store, { method: "PATCH", body: { provider: "gcash" } }), 400, "invalid_payout_account");
  await rejects(() => call(store, { method: "PATCH", body: { provider: "paypal", accountName: "Lovis" } }), 400, "invalid_payout_account");
  await rejects(() => call(store, { method: "PATCH", body: "nope" }), 400, "invalid_payout_account");
});

test("replacing the plate retires the old picture and a stale screen loses", async () => {
  const store = fixture();
  await call(store, { method: "PATCH", body: { provider: "gcash", accountName: "Lovis", qrFileId: "qr_one" } });
  const replaced = await call(store, {
    method: "PATCH",
    body: { expectedVersion: 1, qrFileId: "qr_two" },
    at: LATER,
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.payoutAccount.version, 2);
  assert.equal(replaced.body.payoutAccount.updatedAt, LATER);
  assert.equal(replaced.body.payoutAccount.qr.fileId, "qr_two");
  assert.equal(replaced.body.payoutAccount.provider, "gcash");
  const old = store.files.find((file) => file.fileId === "qr_one");
  assert.equal(old.state, "delete_pending");
  assert.deepEqual(old.references, []);
  assert.deepEqual(store.files.find((file) => file.fileId === "qr_two").references, [
    { type: "supplier_payout_account", id: "supplier", field: "qr" },
  ]);

  await rejects(
    () => call(store, { method: "PATCH", body: { expectedVersion: 1, accountName: "Someone else" } }),
    409,
    "payout_account_stale",
  );
  await rejects(
    () => call(store, { method: "PATCH", body: { accountName: "Someone else" } }),
    400,
    "expected_version_required",
  );
  assert.equal(store.supplierPayoutAccounts[0].accountName, "Lovis");
});

test("a plate must be the shop's own ready upload that nothing else claimed", async () => {
  const store = fixture();
  await rejects(
    () => call(store, { method: "PATCH", body: { provider: "gcash", accountName: "Lovis", qrFileId: "qr_theirs" } }),
    400,
    "invalid_payout_qr",
  );
  await rejects(
    () => call(store, { method: "PATCH", body: { provider: "gcash", accountName: "Lovis", qrFileId: "missing" } }),
    400,
    "invalid_payout_qr",
  );
  store.files.push(qrFile("logo", { purpose: "supplier_shop_image" }));
  await rejects(
    () => call(store, { method: "PATCH", body: { provider: "gcash", accountName: "Lovis", qrFileId: "logo" } }),
    400,
    "invalid_payout_qr",
  );
  store.files.find((file) => file.fileId === "qr_two").references = [{ type: "supplier_payout_account", id: "other_supplier", field: "qr" }];
  await rejects(
    () => call(store, { method: "PATCH", body: { provider: "gcash", accountName: "Lovis", qrFileId: "qr_two" } }),
    409,
    "file_already_attached",
  );
  // A refused write leaves nothing behind.
  assert.equal(store.supplierPayoutAccounts.length, 0);
});

test("removing the picture keeps the words; deleting the account retires everything", async () => {
  const store = fixture();
  await call(store, { method: "PATCH", body: { provider: "maya", accountName: "Lovis", qrFileId: "qr_one" } });
  const cleared = await call(store, { method: "PATCH", body: { expectedVersion: 1, qrFileId: null } });
  assert.equal(cleared.body.payoutAccount.qr, null);
  assert.equal(cleared.body.payoutAccount.provider, "maya");
  assert.equal(store.files[0].state, "delete_pending");

  await rejects(() => call(store, { method: "DELETE" }), 400, "expected_version_required");
  const actions = [];
  const deleted = await call(store, {
    method: "DELETE",
    headers: { "if-match": "2" },
    audit: (_store, entry) => actions.push(entry.action),
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.payoutAccount, null);
  assert.equal(store.supplierPayoutAccounts.length, 0);
  assert.deepEqual(actions, ["payout_account.delete"]);
  const again = await call(store, { method: "DELETE" });
  assert.equal(again.mutated, undefined);
});

test("switching from a wallet to a bank re-reads the number under the new provider", async () => {
  const store = fixture();
  await call(store, { method: "PATCH", body: { provider: "gcash", accountName: "Lovis", accountNumber: "09171234567" } });
  const bank = await call(store, { method: "PATCH", body: { expectedVersion: 1, provider: "bank", institution: "BDO" } });
  assert.equal(bank.body.payoutAccount.provider, "bank");
  assert.equal(bank.body.payoutAccount.accountNumber, "+639171234567");
  await rejects(
    () => call(store, { method: "PATCH", body: { expectedVersion: 2, provider: "gcash", accountNumber: "acct-77" } }),
    400,
    "invalid_payout_account",
  );
});

test("the plate is readable by its shop and Operations only, and cannot be deleted while bound", () => {
  const store = fixture();
  const file = store.files[0];
  file.references.push({ type: "supplier_payout_account", id: "supplier", field: "qr" });
  assert.doesNotThrow(() => authorizeFileRead(actor(store, "supplier"), store, file));
  assert.doesNotThrow(() => authorizeFileRead(actor(store, "ops"), store, file));
  assert.throws(() => authorizeFileRead(actor(store, "other_supplier"), store, file), (error) => error.status === 403);
  assert.throws(() => authorizeFileRead(actor(store, "client"), store, file), (error) => error.status === 403);
  assert.throws(() => markFileDeletePending(file, actor(store, "supplier"), AT), (error) => error.code === "file_in_use");
});

test("Operations sees where the money goes on every order it reads; nobody else does", async () => {
  const store = fixture();
  await call(store, { method: "PATCH", body: { provider: "gcash", accountName: "Lovis P.", qrFileId: "qr_one" } });
  const order = { id: "ord_1", clientId: "client", supplierId: "supplier", state: "in_production", timeline: [] };
  store.orders.push(order);

  const forOps = publicOrderFor(order, actor(store, "ops"), store);
  assert.equal(forOps.supplierPayoutAccount.shopName, "Lovis Printshop");
  assert.equal(forOps.supplierPayoutAccount.provider, "gcash");
  assert.equal(forOps.supplierPayoutAccount.accountName, "Lovis P.");
  assert.equal(forOps.supplierPayoutAccount.qr.fileId, "qr_one");
  assert.equal("supplierPayoutAccount" in publicOrderFor(order, actor(store, "supplier"), store), false);
  assert.equal("supplierPayoutAccount" in publicOrderFor(order, actor(store, "client"), store), false);

  assert.equal(opsPayoutAccountProjection(store, "other_supplier"), null);
  assert.equal(opsPayoutAccountProjection(store, null), null);
  const withoutAccount = publicOrderFor({ ...order, supplierId: "other_supplier" }, actor(store, "ops"), store);
  assert.equal(withoutAccount.supplierPayoutAccount, null);
});
