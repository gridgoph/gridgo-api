import { assertStrangerSafeMessage, isClaimedDevice } from "./push.js";
import crypto from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";
export function apnsToken({ keyId, teamId, privateKey }, issuedAt) {
  const input = [
    { alg: "ES256", kid: keyId },
    { iss: teamId, iat: issuedAt },
  ]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  return `${input}.${crypto.sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
export function apnsPayload(message) {
  return {
    aps: {
      alert: { title: message.title, body: message.body },
      sound: message.sound || "default",
    },
    ...message.data,
  };
}
export function createApnsDelivery(env = process.env, options = {}) {
  const topics = {
    client: env.GRIDGO_APNS_CLIENT_TOPIC,
    supplier: env.GRIDGO_APNS_SUPPLIER_TOPIC,
    rider: env.GRIDGO_APNS_RIDER_TOPIC,
  };
  let credentials = options.credentials;
  let detail = null;
  if (!credentials && env.GRIDGO_APNS_KEY_FILE) {
    try {
      credentials = {
        privateKey: fs.readFileSync(env.GRIDGO_APNS_KEY_FILE, "utf8"),
        keyId: env.GRIDGO_APNS_KEY_ID,
        teamId: env.GRIDGO_APNS_TEAM_ID,
      };
      if (!credentials.keyId || !credentials.teamId) throw Error();
      apnsToken(credentials, Math.floor(Date.now() / 1000));
    } catch {
      credentials = null;
      detail = "APNs key file or key/team identifiers are missing or invalid";
    }
  }
  const configured = Boolean(credentials);
  const origin =
    env.GRIDGO_APNS_SANDBOX === "true"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
  let session = null;
  let cachedToken = null;
  let tokenIssuedAt = 0;
  const now = options.now || Date.now;
  function providerToken() {
    const issuedAt = Math.floor(now() / 1000);
    if (!cachedToken || issuedAt < tokenIssuedAt || issuedAt - tokenIssuedAt >= 50 * 60) {
      cachedToken = apnsToken(credentials, issuedAt);
      tokenIssuedAt = issuedAt;
    }
    return cachedToken;
  }
  function connection() {
    if (session && !session.closed && !session.destroyed) return session;
    const current = (options.connect || http2.connect)(origin);
    session = current;
    const forget = () => { if (session === current) session = null; };
    current.on("error", () => {
      forget();
      current.destroy();
    });
    current.once("goaway", () => {
      forget();
      current.close();
    });
    current.once("close", forget);
    return current;
  }
  const activeRequests = new WeakMap();
  async function send(message, devices) {
    if (!configured) return [];
    if (devices.some((d) => !isClaimedDevice(d)))
      assertStrangerSafeMessage(message);
    return Promise.all(
      devices.map(async (d) => {
        const topic = topics[d.appRole] || env.GRIDGO_APNS_TOPIC;
        if (!topic)
          return {
            deviceId: d.id,
            ok: false,
            prune: false,
            code: "apns_topic_missing",
          };
        if (!/^[a-fA-F0-9]{64}$/.test(d.token))
          return {
            deviceId: d.id,
            ok: false,
            prune: true,
            code: "BadDeviceToken",
          };
        return new Promise((resolve) => {
          let current;
          let request;
          let finished = false;
          const done = (result) => {
            if (finished) return;
            finished = true;
            if (request) {
              request.setTimeout(0);
              request.close(http2.constants.NGHTTP2_CANCEL);
            }
            if (current) {
              const active = (activeRequests.get(current) || 1) - 1;
              activeRequests.set(current, active);
              if (active === 0) current.unref();
            }
            resolve({ deviceId: d.id, ...result });
          };
          try {
            const token = providerToken();
            current = connection();
            activeRequests.set(current, (activeRequests.get(current) || 0) + 1);
            current.ref();
            request = current.request({
              ":method": "POST",
              ":path": `/3/device/${d.token}`,
              authorization: `bearer ${token}`,
              "apns-topic": topic,
              "apns-push-type": "alert",
              "apns-priority": "10",
            });
          } catch {
            done({ ok: false, prune: false, code: "apns_transport_error" });
            return;
          }
          request.setTimeout(options.timeoutMs ?? 10000, () =>
            done({ ok: false, prune: false, code: "apns_timeout" }),
          );
          request.on("close", () =>
            done({ ok: false, prune: false, code: "apns_transport_error" }),
          );
          let status = 0;
          let body = "";
          request.on("response", (headers) => {
            status = headers[":status"];
          });
          request.on("data", (chunk) => {
            if (body.length < 1024) body += chunk;
          });
          request.on("error", () =>
            done({ ok: false, prune: false, code: "apns_transport_error" }),
          );
          request.on("end", () => {
            let reason;
            try {
              reason = JSON.parse(body).reason;
            } catch {}
            done({
              ok: status === 200,
              prune:
                status === 410 ||
                reason === "BadDeviceToken" ||
                reason === "DeviceTokenNotForTopic",
              code: status === 200 ? null : reason || `apns_${status}`,
            });
          });
          request.end(JSON.stringify(apnsPayload(message)));
        });
      }),
    );
  }
  return {
    configured,
    send,
    health: () => ({
      provider: "apns",
      status: configured ? "configured" : detail ? "misconfigured" : "disabled",
      detail,
    }),
  };
}
export function routePushDelivery(fcm, apns) {
  return {
    configured: fcm.configured || apns.configured,
    health: () => ({ ...fcm.health(), apns: apns.health() }),
    // Only FCM has a dry-run send. APNs registrations are left to the outbox,
    // which prunes them when a real send is refused.
    validate: async (message, devices) => {
      const fcmDevices = devices.filter((device) => (device.tokenProvider || "fcm") === "fcm");
      if (!fcm.configured || typeof fcm.validate !== "function" || !fcmDevices.length) return [];
      return fcm.validate(message, fcmDevices);
    },
    send: async (message, devices) => {
      if (devices.some((device) => !isClaimedDevice(device)))
        assertStrangerSafeMessage(message);
      const results = new Array(devices.length);
      let next = 0;
      async function worker() {
        while (next < devices.length) {
          const index = next++;
          const device = devices[index];
          const provider = device.tokenProvider || "fcm";
          const delivery = provider === "apns" ? apns : fcm;
          try {
            results[index] = delivery.configured
              ? await delivery.send(message, [device])
              : [{ deviceId: device.id, ok: false, prune: false, code: `${provider}_disabled` }];
          } catch {
            results[index] = [{ deviceId: device.id, ok: false, prune: false, code: `${provider}_transport_error` }];
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(10, devices.length) }, worker));
      return results.flat();
    },
  };
}
