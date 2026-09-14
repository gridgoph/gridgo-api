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
      sound: "default",
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
          const session = (options.connect || http2.connect)(origin);
          let finished = false;
          const done = (result) => {
            if (finished) return;
            finished = true;
            session.destroy();
            resolve({ deviceId: d.id, ...result });
          };
          session.on("error", () =>
            done({ ok: false, prune: false, code: "apns_transport_error" }),
          );
          const request = session.request({
            ":method": "POST",
            ":path": `/3/device/${d.token}`,
            authorization: `bearer ${apnsToken(credentials, Math.floor(Date.now() / 1000))}`,
            "apns-topic": topic,
            "apns-push-type": "alert",
            "apns-priority": "10",
          });
          request.setTimeout(10000, () =>
            done({ ok: false, prune: false, code: "apns_timeout" }),
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
