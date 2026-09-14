import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { apnsPayload, apnsToken, createApnsDelivery } from "../src/apns.js";
test("APNs uses native device tokens and minimal data with signed provider JWT", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwt = apnsToken({ keyId: "key", teamId: "team", privateKey }, 100);
  const parts = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(parts[1], "base64url")).iss, "team");
  assert.equal(
    crypto.verify(
      "sha256",
      Buffer.from(parts.slice(0, 2).join(".")),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(parts[2], "base64url"),
    ),
    true,
  );
  assert.deepEqual(
    apnsPayload({ title: "t", body: "b", data: { notificationId: "n" } }),
    {
      aps: { alert: { title: "t", body: "b" }, sound: "default" },
      notificationId: "n",
    },
  );
});
test("missing APNs credentials remain explicitly disabled", () => {
  const d = createApnsDelivery({});
  assert.equal(d.configured, false);
  assert.equal(d.health().status, "disabled");
});

test("legacy iOS FCM tokens never enter APNs delivery or pruning", async () => {
  const { routePushDelivery } = await import("../src/apns.js");
  const received = [];
  const fcm = {
    configured: true,
    send: async (_message, devices) => {
      received.push(...devices.map((d) => d.id));
      return devices.map((d) => ({ deviceId: d.id, ok: true, prune: false }));
    },
  };
  const apns = createApnsDelivery({ GRIDGO_APNS_TOPIC: "test.app" }, { credentials: {} });
  const devices = [
    { id: "legacy", userId: "u", platform: "ios", token: "existing-fcm-registration" },
    { id: "explicit-fcm", userId: "u", platform: "ios", tokenProvider: "fcm", token: "another-fcm-registration" },
    { id: "explicit-apns", userId: "u", platform: "ios", tokenProvider: "apns", token: "invalid-native-token" },
  ];
  const results = await routePushDelivery(fcm, apns).send({ title: "test", body: "test", data: {} }, devices);
  assert.deepEqual(received, ["legacy", "explicit-fcm"]);
  assert.deepEqual(results.map((r) => r.prune), [false, false, true]);
  assert.equal(results[2].code, "BadDeviceToken");
});

test("push routing bounds concurrent fan-out across both providers", async () => {
  const { routePushDelivery } = await import("../src/apns.js");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let peak = 0;
  const attempted = [];
  const provider = (name) => ({
    configured: true,
    send: async (_message, [device]) => {
      attempted.push(`${name}:${device.id}`);
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return [{ deviceId: device.id, ok: true, prune: false }];
    },
  });
  const devices = Array.from({ length: 35 }, (_, index) => ({
    id: String(index), userId: null, tokenProvider: index % 2 ? "apns" : "fcm",
  }));
  const pending = routePushDelivery(provider("fcm"), provider("apns")).send(
    { title: "Update", body: "Update available", data: { type: "announcement" } }, devices,
  );
  try {
    assert.equal(active, 10);
    assert.equal(attempted.length, 10);
  } finally {
    release();
  }
  const results = await pending;
  assert.equal(peak, 10);
  assert.equal(active, 0);
  assert.equal(attempted.length, devices.length);
  assert.deepEqual(attempted, devices.map((d) => `${d.tokenProvider}:${d.id}`));
  assert.deepEqual(results, devices.map((d) => ({ deviceId: d.id, ok: true, prune: false })));
});

test("push routing isolates synchronous and asynchronous device failures", async () => {
  const { routePushDelivery } = await import("../src/apns.js");
  const attempted = [];
  const delivery = {
    configured: true,
    send: (_message, [device]) => {
      attempted.push(device.id);
      if (device.id === "sync") throw new Error("private provider detail");
      if (device.id === "async") return Promise.reject(new Error("private provider detail"));
      return Promise.resolve([{ deviceId: device.id, ok: true, prune: false }]);
    },
  };
  const devices = [
    { id: "sync", userId: "u", tokenProvider: "fcm" },
    { id: "async", userId: "u", tokenProvider: "apns" },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `live-${i}`, userId: "u", tokenProvider: "apns" })),
  ];
  const results = await routePushDelivery(delivery, delivery).send({ title: "t", body: "b", data: {} }, devices);
  assert.equal(attempted.length, devices.length);
  assert.deepEqual(results.slice(0, 2), [
    { deviceId: "sync", ok: false, prune: false, code: "fcm_transport_error" },
    { deviceId: "async", ok: false, prune: false, code: "apns_transport_error" },
  ]);
  assert.ok(results.slice(2).every((r) => r.ok && !r.prune));
  const disabled = await routePushDelivery({ configured: false }, delivery).send(
    { title: "t", body: "b", data: {} }, [{ id: "legacy", userId: "u", platform: "ios" }],
  );
  assert.deepEqual(disabled, [{ deviceId: "legacy", ok: false, prune: false, code: "fcm_disabled" }]);
});

test("concurrent routing rejects unsafe anonymous batches before any delivery", async () => {
  const { routePushDelivery } = await import("../src/apns.js");
  let calls = 0;
  const delivery = { configured: true, send: async () => { calls += 1; return []; } };
  await assert.rejects(routePushDelivery(delivery, delivery).send(
    { title: "Order", body: "Private update", data: { orderId: "private" } },
    [{ id: "owned", userId: "u" }, { id: "anonymous", userId: null, tokenProvider: "apns" }],
  ));
  assert.equal(calls, 0);
  assert.deepEqual(await routePushDelivery(delivery, delivery).send({}, []), []);
});
