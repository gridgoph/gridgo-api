/**
 * Firebase Cloud Messaging (HTTP v1) push delivery.
 *
 * Two separable halves live here, for the same reason `attachments.js` keeps
 * store rules apart from `object-storage.js`:
 *
 *   - Device-token store rules (register / unregister / lookup / prune). Pure
 *     functions over the JSON store, so ownership can be tested without a
 *     network or a server process.
 *   - `createPushDelivery()`, the FCM client. It signs a service-account JWT
 *     with `node:crypto` (RS256), exchanges it for a cached OAuth2 access
 *     token, and POSTs one message per device token. `firebase-admin` is
 *     deliberately not a dependency; see the constraints in AGENTS.md.
 *
 * Nothing in this file may log, return, or embed the service-account private
 * key, the minted access token, or a device token. Errors carry status codes
 * and FCM error codes only.
 */
import crypto from "node:crypto";
import fs from "node:fs";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_FCM_BASE_URL = "https://fcm.googleapis.com";
/** Minted tokens last an hour; refresh early so an in-flight send never races expiry. */
const ACCESS_TOKEN_SKEW_SECONDS = 120;
const SEND_TIMEOUT_MS = 10_000;

/**
 * Android requires a notification channel that the app has created. Changing
 * this string silently downgrades every Android notification, so it is part of
 * the published contract in docs/OPERATIONAL_MODEL_V2_API.md.
 */
export const ANDROID_NOTIFICATION_CHANNEL_ID = "gridgo_default";

export const DEVICE_PLATFORMS = ["android", "ios", "web"];

/**
 * The only notification fields that may cross onto a lock screen, as an
 * allowlist rather than a redaction list. A notification record is already
 * owner-scoped, but a future field (a supplier price, a commission split)
 * added to those records must not reach a device by default — see the money
 * visibility rules in `operational-model.js`.
 */
const PUSH_DATA_FIELDS = ["notificationId", "type", "orderId", "at"];

export class PushConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PushConfigurationError";
  }
}

// ---------------------------------------------------------------------------
// Device-token store rules
// ---------------------------------------------------------------------------

/**
 * Additive migration for legacy stores: a store written before push existed
 * has no device tokens at all. Idempotent — a second run changes nothing.
 */
export function backfillDeviceTokens(store) {
  if (!Array.isArray(store.deviceTokens)) {
    store.deviceTokens = [];
    return true;
  }
  return false;
}

function deviceId() {
  return `dev_${crypto.randomBytes(6).toString("hex")}`;
}

export function normalizeDeviceToken(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function deviceTokensFor(store, userId) {
  return (store.deviceTokens || []).filter((record) => record.userId === userId);
}

/**
 * The device token itself is never returned. The registering phone already has
 * it, and every other consumer only needs to identify the registration.
 */
export function publicDevice(record) {
  return {
    id: record.id,
    userId: record.userId,
    platform: record.platform,
    tokenTail: record.token.slice(-8),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Register a device token against exactly one user.
 *
 * A token identifies a *phone*, not an account, so the same token can arrive
 * under a second account after a sign-out/sign-in or on a shared handset. The
 * previous owner's claim is replaced rather than duplicated: two rows for one
 * token means one person's notifications land on someone else's lock screen.
 *
 * Returns `{ device, created, reassignedFrom, changed }`.
 */
export function registerDeviceToken(store, { userId, token, platform, at }) {
  backfillDeviceTokens(store);
  const existing = store.deviceTokens.find((record) => record.token === token);

  if (!existing) {
    const device = {
      id: deviceId(),
      userId,
      token,
      platform,
      createdAt: at,
      updatedAt: at,
    };
    store.deviceTokens.push(device);
    return { device, created: true, reassignedFrom: null, changed: true };
  }

  const reassignedFrom = existing.userId === userId ? null : existing.userId;
  const changed = reassignedFrom !== null || existing.platform !== platform;
  existing.userId = userId;
  existing.platform = platform;
  // `updatedAt` moves on every re-registration: the app refreshes its token on
  // a schedule, and that recency is the only staleness signal ops has.
  existing.updatedAt = at;
  return { device: existing, created: false, reassignedFrom, changed: true };
}

/**
 * Remove one of the caller's own device tokens.
 *
 * A token the caller does not own is reported as absent, not as forbidden. The
 * value is attacker-suppliable, so a distinguishable refusal would turn this
 * route into an oracle for "is this token registered to somebody else?" —
 * unlike an opaque server-minted notification ID, where `403` is safe.
 */
export function unregisterDeviceToken(store, { userId, token }) {
  backfillDeviceTokens(store);
  const index = store.deviceTokens.findIndex(
    (record) => record.token === token && record.userId === userId,
  );
  if (index === -1) return { removed: null, changed: false };
  const [removed] = store.deviceTokens.splice(index, 1);
  return { removed, changed: true };
}

/** Drop registrations FCM has reported as dead. Returns the number removed. */
export function removeDeviceTokenIds(store, ids) {
  backfillDeviceTokens(store);
  const doomed = new Set(ids);
  if (doomed.size === 0) return 0;
  const before = store.deviceTokens.length;
  store.deviceTokens = store.deviceTokens.filter((record) => !doomed.has(record.id));
  return before - store.deviceTokens.length;
}

// ---------------------------------------------------------------------------
// Message shaping
// ---------------------------------------------------------------------------

function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the user-facing half of a push from an already-persisted notification,
 * so every push corresponds to a record the same user can also read in-app.
 *
 * `data` is built from PUSH_DATA_FIELDS only — enough for the app to open the
 * right screen, and nothing else regardless of what the record carries.
 */
export function pushMessageFor(notification) {
  const data = {
    notificationId: String(notification.id),
    type: trimmedString(notification.type),
    orderId: trimmedString(notification.orderId),
    at: trimmedString(notification.at),
  };
  for (const key of Object.keys(data)) {
    if (!PUSH_DATA_FIELDS.includes(key) || data[key] === "") delete data[key];
  }
  return {
    title: trimmedString(notification.title) || "GRIDGO",
    body: trimmedString(notification.body) || "Open GRIDGO for the latest update.",
    data,
  };
}

export function fcmRequestBody(message, token) {
  return {
    message: {
      token,
      notification: { title: message.title, body: message.body },
      data: message.data,
      android: {
        priority: "high",
        notification: { channel_id: ANDROID_NOTIFICATION_CHANNEL_ID },
      },
      apns: {
        headers: { "apns-priority": "10" },
        payload: { aps: { sound: "default" } },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

const PRUNABLE_ERROR_CODES = new Set([
  // The app was uninstalled, the data was wiped, or FCM rotated the token.
  "UNREGISTERED",
  // The token belongs to a different Firebase sender; it will never work here.
  "SENDER_ID_MISMATCH",
]);

function fcmErrorCode(payload) {
  const details = payload?.error?.details;
  if (!Array.isArray(details)) return "";
  for (const detail of details) {
    if (typeof detail?.errorCode === "string") return detail.errorCode;
  }
  return "";
}

function tokenFieldViolation(payload) {
  const details = payload?.error?.details;
  if (!Array.isArray(details)) return false;
  for (const detail of details) {
    for (const violation of Array.isArray(detail?.fieldViolations) ? detail.fieldViolations : []) {
      if (typeof violation?.field === "string" && violation.field.split(".").pop() === "token") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Decide whether a failed send means "this phone is gone" (prune) or "try
 * again later" (keep).
 *
 * The trap is `INVALID_ARGUMENT`: FCM returns it both for a malformed token
 * *and* for a malformed message. Pruning on the bare status would delete every
 * live registration the moment a payload bug shipped, so it prunes only when
 * the reported field violation is the token itself. A `404 NOT_FOUND` with no
 * detail is FCM's other spelling of "unregistered" and is safe to prune.
 */
export function classifyFcmFailure({ status, payload }) {
  const errorCode = fcmErrorCode(payload);
  const grpcStatus = trimmedString(payload?.error?.status);
  const code = errorCode || grpcStatus || `http_${status}`;

  if (PRUNABLE_ERROR_CODES.has(errorCode)) return { prune: true, code };
  if (status === 404) return { prune: true, code };
  if (status === 400 && (errorCode === "INVALID_ARGUMENT" || grpcStatus === "INVALID_ARGUMENT")) {
    return { prune: tokenFieldViolation(payload), code };
  }
  return { prune: false, code };
}

// ---------------------------------------------------------------------------
// Service-account credentials
// ---------------------------------------------------------------------------

const REQUIRED_CREDENTIAL_FIELDS = ["project_id", "private_key", "client_email"];

/**
 * Read the service account from the path in GRIDGO_FCM_SERVICE_ACCOUNT_FILE.
 *
 * Deliberately a file, not an environment variable: the key is a multi-line
 * PEM, and the hosted pilot already installs secrets as mode-0600 files beside
 * the compose file (docs/DEPLOYMENT.md §2). Errors name the path and the
 * missing field — never a value from inside the file.
 */
export function loadServiceAccount(env = process.env, readFile = fs.readFileSync) {
  const file = trimmedString(env.GRIDGO_FCM_SERVICE_ACCOUNT_FILE);
  if (!file) return null;

  let raw;
  try {
    raw = readFile(file, "utf8");
  } catch {
    throw new PushConfigurationError(
      `GRIDGO_FCM_SERVICE_ACCOUNT_FILE points at a file this process cannot read: ${file}. ` +
        "Install the Firebase service-account JSON there mode 0600, owned by the API user, and restart.",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PushConfigurationError(
      `GRIDGO_FCM_SERVICE_ACCOUNT_FILE is not valid JSON: ${file}. ` +
        "Install the unmodified service-account JSON downloaded from the Firebase console and restart.",
    );
  }

  for (const field of REQUIRED_CREDENTIAL_FIELDS) {
    if (!trimmedString(parsed?.[field])) {
      throw new PushConfigurationError(
        `GRIDGO_FCM_SERVICE_ACCOUNT_FILE is missing '${field}': ${file}. ` +
          "Install a complete Firebase service-account JSON and restart.",
      );
    }
  }

  return {
    projectId: parsed.project_id,
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key,
    privateKeyId: trimmedString(parsed.private_key_id) || undefined,
    tokenUri: trimmedString(parsed.token_uri) || "https://oauth2.googleapis.com/token",
  };
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

/**
 * Sign the service-account assertion Google exchanges for an access token.
 * Exported so a test can verify the signature with the matching public key
 * without a network round trip.
 */
export function signServiceAccountAssertion(credentials, issuedAtSeconds, lifetimeSeconds = 3600) {
  const header = { alg: "RS256", typ: "JWT" };
  if (credentials.privateKeyId) header.kid = credentials.privateKeyId;
  const claims = {
    iss: credentials.clientEmail,
    scope: FCM_SCOPE,
    aud: credentials.tokenUri,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + lifetimeSeconds,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(credentials.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

// ---------------------------------------------------------------------------
// Delivery client
// ---------------------------------------------------------------------------

/**
 * `options` exists for tests: an injected `fetch` and `now` make the OAuth2
 * cache, the fan-out and the prune verdicts assertable without touching
 * Google. Same shape as `createObjectStorage(env, options)`.
 */
export function createPushDelivery(env = process.env, options = {}) {
  const credentials = options.credentials ?? loadServiceAccount(env);
  return buildPushDelivery(credentials, env, options);
}

/**
 * Same client, but a broken credential disables push instead of refusing to
 * boot.
 *
 * Deliberately different from the CORS/MinIO/password checks, which do refuse:
 * those protect data, while a missing push credential only costs lock-screen
 * delivery. Every merge to the default branch deploys automatically, and the
 * compose file bind-mounts the credential by path — a not-yet-installed secret
 * (which Docker silently materialises as a *directory*) would otherwise take
 * the whole API down on the deploy that shipped this code. The reason is
 * reported on `/health` and logged once at startup, so the gap is loud without
 * being fatal.
 */
export function createPushDeliveryOrDisable(env = process.env, options = {}) {
  try {
    return createPushDelivery(env, options);
  } catch (error) {
    if (!(error instanceof PushConfigurationError)) throw error;
    (options.logger || console).warn?.(
      `push notifications are DISABLED: ${error.message}`,
    );
    return buildPushDelivery(null, env, { ...options, misconfiguration: error.message });
  }
}

function buildPushDelivery(credentials, env, options) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const clock = options.now || (() => Date.now());
  const logger = options.logger || console;
  const baseUrl = (trimmedString(env.GRIDGO_FCM_BASE_URL) || DEFAULT_FCM_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Number(env.GRIDGO_FCM_TIMEOUT_MS || SEND_TIMEOUT_MS);

  const configured = credentials != null;
  const misconfiguration = options.misconfiguration || null;
  let status = configured ? "configured" : misconfiguration ? "misconfigured" : "disabled";
  let checkedAt = null;
  let cachedToken = null;
  let cachedTokenExpiresAtMs = 0;
  let inFlightToken = null;

  function mark(next) {
    status = next;
    checkedAt = new Date(clock()).toISOString();
  }

  function health() {
    return {
      provider: "fcm",
      projectId: credentials?.projectId || null,
      status,
      // Names the file and the missing field, never a value from inside it.
      detail: misconfiguration,
      checkedAt,
    };
  }

  async function requestAccessToken() {
    const issuedAt = Math.floor(clock() / 1000);
    const assertion = signServiceAccountAssertion(credentials, issuedAt);
    const response = await fetchImpl(credentials.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // The response body can echo request material; only the status escapes.
      mark("unavailable");
      throw new Error(`fcm_access_token_failed status=${response.status}`);
    }
    const payload = await response.json();
    const accessToken = trimmedString(payload?.access_token);
    if (!accessToken) {
      mark("unavailable");
      throw new Error("fcm_access_token_failed status=200 missing_access_token");
    }
    const lifetime = Number(payload?.expires_in) > 0 ? Number(payload.expires_in) : 3600;
    cachedToken = accessToken;
    cachedTokenExpiresAtMs = clock() + Math.max(lifetime - ACCESS_TOKEN_SKEW_SECONDS, 30) * 1000;
    return accessToken;
  }

  /**
   * One access token per lifetime, and one mint per burst: without the
   * in-flight promise a batch of notifications would each mint their own token
   * and be rate-limited by Google.
   */
  async function accessToken({ forceRefresh = false } = {}) {
    if (!configured) throw new PushConfigurationError("push delivery is not configured");
    if (forceRefresh) {
      cachedToken = null;
      cachedTokenExpiresAtMs = 0;
    }
    if (cachedToken && clock() < cachedTokenExpiresAtMs) return cachedToken;
    if (!inFlightToken) {
      inFlightToken = requestAccessToken().finally(() => {
        inFlightToken = null;
      });
    }
    return inFlightToken;
  }

  async function postMessage(token, message, bearer) {
    const response = await fetchImpl(`${baseUrl}/v1/projects/${credentials.projectId}/messages:send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(fcmRequestBody(message, token)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  }

  async function sendToDevice(device, message) {
    let bearer = await accessToken();
    let result = await postMessage(device.token, message, bearer);
    if (result.status === 401) {
      // The cached token was revoked or clock-skewed out from under us. One
      // forced refresh, then accept the verdict.
      bearer = await accessToken({ forceRefresh: true });
      result = await postMessage(device.token, message, bearer);
    }
    if (result.status >= 200 && result.status < 300) {
      mark("available");
      return { deviceId: device.id, ok: true, prune: false, code: null };
    }
    const { prune, code } = classifyFcmFailure(result);
    mark(prune ? "available" : "unavailable");
    return { deviceId: device.id, ok: false, prune, code };
  }

  /**
   * Fan a message out to every one of a user's devices. Each token is
   * independent: one dead phone must not stop the others, and no rejection
   * escapes this function — a failed push may never break whatever action
   * created the notification.
   */
  async function send(message, devices) {
    if (!configured || devices.length === 0) return [];
    const settled = await Promise.allSettled(
      devices.map((device) => sendToDevice(device, message)),
    );
    return settled.map((outcome, index) => {
      if (outcome.status === "fulfilled") return outcome.value;
      mark("unavailable");
      logger.warn?.(
        `push send failed device=${devices[index].id} reason=${outcome.reason?.message || "unknown"}`,
      );
      return { deviceId: devices[index].id, ok: false, prune: false, code: "transport_error" };
    });
  }

  return { configured, projectId: credentials?.projectId || null, accessToken, send, health };
}
