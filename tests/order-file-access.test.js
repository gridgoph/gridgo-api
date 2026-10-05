import test from "node:test";
import assert from "node:assert/strict";
import { publicOrderFor } from "../src/operational-model.js";
import { authorizeFileRead } from "../src/attachments.js";

const actor = (role, key = "a") => ({ role, id: `${role}-${key}`, verificationStatus: "approved" });
function fixture() {
  const order = { id: "order", clientId: "client-a", supplierId: "supplier-a", riderId: "rider-a", timeline: [], artworkName: "other-shop.pdf" };
  const store = {
    orders: [order],
    orderJobs: ["a", "b"].map((key) => ({ id: `job-${key}`, orderId: order.id, supplierId: `supplier-${key}`, riderId: `rider-${key}` })),
    orderLineItems: ["a", "b"].map((key) => ({ id: `line-${key}`, orderId: order.id, jobId: `job-${key}`, quantity: 1, artworkFileId: `artwork-${key}`, mockupFileId: `mockup-${key}` })),
    files: ["artwork", "mockup"].flatMap((purpose) => ["a", "b"].map((key) => ({
      fileId: `${purpose}-${key}`, purpose, state: "ready", ownerId: "client-a", originalFilename: `${purpose}-${key}.pdf`,
      references: [{ type: "order", id: order.id, field: `line:line-${key}:${purpose}` }],
    }))),
  };
  order.artworkFileIds = ["artwork-a", "artwork-b"];
  order.mockupFileIds = ["mockup-a", "mockup-b"];
  return { order, store };
}
function denied(user, store, file) {
  assert.throws(() => authorizeFileRead(user, store, file), { status: 403, code: "forbidden" });
}

for (const role of ["supplier", "rider"]) for (const key of ["a", "b"]) {
  test(`${role} ${key} lists only its job files, including when primary order ids point elsewhere`, () => {
    const { order, store } = fixture();
    const view = publicOrderFor(order, actor(role, key), store);
    assert.deepEqual(view.artworkFileIds, [`artwork-${key}`]);
    assert.deepEqual(view.mockupFileIds, [`mockup-${key}`]);
    assert.deepEqual(view.productionItems.map((line) => line.id), [`line-${key}`]);
    assert.equal(view.artworkName, `artwork-${key}.pdf`);
    assert.deepEqual(order.artworkFileIds, ["artwork-a", "artwork-b"]);
  });
  test(`${role} ${key} cannot read the other job's files`, () => {
    const { store } = fixture();
    for (const file of store.files) {
      if (file.fileId.endsWith(`-${key}`)) assert.doesNotThrow(() => authorizeFileRead(actor(role, key), store, file));
      else denied(actor(role, key), store, file);
    }
  });
}

test("client and both staff roles retain full artwork and mockup access", () => {
  const { order, store } = fixture();
  for (const role of ["client", "ops_admin", "super_admin"]) {
    const user = actor(role);
    const view = publicOrderFor(order, user, store);
    assert.deepEqual(view.artworkFileIds, ["artwork-a", "artwork-b"]);
    assert.deepEqual(view.mockupFileIds, ["mockup-a", "mockup-b"]);
    for (const file of store.files) assert.doesNotThrow(() => authorizeFileRead(user, store, file));
  }
});

test("a rider assigned both jobs can list and read both jobs' files", () => {
  const { order, store } = fixture();
  store.orderJobs[1].riderId = "rider-a";
  assert.deepEqual(publicOrderFor(order, actor("rider"), store).artworkFileIds, ["artwork-a", "artwork-b"]);
  for (const file of store.files) assert.doesNotThrow(() => authorizeFileRead(actor("rider"), store, file));
});

test("unattributed legacy multi-shop files are denied even to their supplier uploader", () => {
  const { order, store } = fixture();
  store.orderLineItems = [];
  for (const file of store.files) {
    file.references = [{ type: "order", id: order.id, field: `${file.purpose}FileIds` }];
    file.ownerId = "supplier-a";
  }
  for (const role of ["supplier", "rider"]) {
    const view = publicOrderFor(order, actor(role), store);
    assert.deepEqual(view.artworkFileIds, []);
    assert.deepEqual(view.mockupFileIds, []);
    assert.equal(view.artworkName, null);
    for (const file of store.files) denied(actor(role), store, file);
  }
  for (const role of ["client", "ops_admin", "super_admin"]) {
    assert.deepEqual(publicOrderFor(order, actor(role), store).artworkFileIds, ["artwork-a", "artwork-b"]);
    for (const file of store.files) assert.doesNotThrow(() => authorizeFileRead(actor(role), store, file));
  }
});

test("legacy single-shop orders retain unscoped files with and without job rows", () => {
  for (const withJob of [false, true]) {
    const { order, store } = fixture();
    store.orderLineItems = [];
    store.orderJobs = withJob ? [store.orderJobs[0]] : [];
    for (const file of store.files) file.references = [{ type: "order", id: order.id, field: `${file.purpose}FileIds` }];
    for (const role of ["supplier", "rider"]) {
      assert.deepEqual(publicOrderFor(order, actor(role), store).artworkFileIds, ["artwork-a", "artwork-b"]);
      for (const file of store.files) assert.doesNotThrow(() => authorizeFileRead(actor(role), store, file));
    }
  }
});

test("legacy order-level references can use line snapshots, without granting other jobs access", () => {
  const { order, store } = fixture();
  for (const file of store.files) file.references = [{ type: "order", id: order.id, field: `${file.purpose}FileIds` }];
  assert.deepEqual(publicOrderFor(order, actor("supplier"), store).artworkFileIds, ["artwork-a"]);
  authorizeFileRead(actor("supplier"), store, store.files[0]);
  denied(actor("supplier"), store, store.files[1]);
});

test("order-level references and uploader ownership cannot bypass a different job's line reference", () => {
  const { order, store } = fixture();
  const file = store.files[1];
  file.ownerId = "supplier-a";
  file.references.push({ type: "order", id: order.id, field: "artworkFileIds" });
  denied(actor("supplier"), store, file);
});

test("shared files are readable through either genuinely assigned line", () => {
  const { order, store } = fixture();
  store.orderLineItems[1].artworkFileId = "artwork-a";
  store.files[0].references.push({ type: "order", id: order.id, field: "line:line-b:artwork" });
  for (const key of ["a", "b"]) authorizeFileRead(actor("supplier", key), store, store.files[0]);
});

test("dangling, foreign-order and mismatched line references fail closed", () => {
  for (const field of ["line:missing:artwork", "line:foreign:artwork", "line:line-a:mockup", "line:line-b:artwork"]) {
    const { order, store } = fixture();
    store.orderLineItems.push({ id: "foreign", orderId: "elsewhere", jobId: "job-a", artworkFileId: "artwork-a" });
    store.files[0].references = [{ type: "order", id: order.id, field }];
    denied(actor("supplier"), store, store.files[0]);
  }
});

test("unassigned and unapproved workers cannot use scoped file references", () => {
  const { order, store } = fixture();
  for (const role of ["supplier", "rider"]) {
    denied(actor(role, "outsider"), store, store.files[0]);
    denied({ ...actor(role), verificationStatus: "pending" }, store, store.files[0]);
    assert.deepEqual(publicOrderFor(order, actor(role, "outsider"), store).artworkFileIds, []);
  }
});

test("lists inferred from line snapshots are scoped before the order response leaves the API", () => {
  const { order, store } = fixture();
  delete order.artworkFileIds;
  delete order.mockupFileIds;
  for (const role of ["supplier", "rider"]) {
    const view = publicOrderFor(order, actor(role), store);
    assert.deepEqual(view.artworkFileIds, ["artwork-a"]);
    assert.deepEqual(view.mockupFileIds, ["mockup-a"]);
  }
  assert.equal(order.artworkFileIds, undefined);
});
