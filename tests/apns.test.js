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
