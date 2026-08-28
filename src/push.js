/**
 * Firebase Cloud Messaging (HTTP v1) push delivery.
 *
 * Two separable halves live here, for the same reason `attachments.js` keeps
 * domain rules apart from `object-storage.js`:
 *
 *   - Device-token domain rules (register / unregister / lookup / prune). Pure
 *     functions over an in-memory transaction snapshot, so ownership can be tested without a
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
 * owner-scoped, but a future field (a supplier subtotal or payout split)
 * added to those records must not reach a device by default — see the money
 * visibility rules in `operational-model.js`.
 */
const PUSH_DATA_FIELDS = ["notificationId", "type", "orderId", "at"];

/**
 * The `data` an *unclaimed* device may receive: the message type and nothing
 * else. No notification ID (there is no notification record behind an
 * announcement), no order ID, no timestamp that could correlate a handset with
 * an order. See `assertStrangerSafeMessage`.
 */
const ANONYMOUS_PUSH_DATA_FIELDS = ["type"];

/** The one message type an anonymous handset may ever be sent. */
export const ANNOUNCEMENT_PUSH_TYPE = "announcement";

/** Longest operator-supplied picture URL the announcement route accepts. */
export const ANNOUNCEMENT_IMAGE_URL_MAX = 2048;

/**
 * Hosted broadcast pictures are served from this unauthenticated path so FCM
 * and the apps can fetch bytes without a signed MinIO URL. The id is a GRIDGO
 * file id (`file_` + 12 hex chars).
 */
export const ANNOUNCEMENT_IMAGE_PUBLIC_PREFIX = "/public/announcement-images/";
const ANNOUNCEMENT_IMAGE_FILE_ID = /^file_[a-f0-9]{12}$/;

export class PushConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PushConfigurationError";
  }
}

/**
 * Thrown when a message that is not safe for a stranger would reach a device
 * nobody has signed in on. This is a programming error, not a runtime
 * condition: it means a personal notification reached the anonymous fan-out.
 */
export class PushAudienceError extends Error {
  constructor(message) {
    super(message);
    this.name = "PushAudienceError";
  }
}

// ---------------------------------------------------------------------------
// Device-token domain rules
// ---------------------------------------------------------------------------

/**
 * Normalize a caller-created snapshot before applying device-token rules.
 */
export function ensureDeviceTokens(store) {
  if (!Array.isArray(store.deviceTokens)) {
    store.deviceTokens = [];
    return true;
  }
  let changed = false;
  for (const record of store.deviceTokens) {
    // `null` is the stored spelling of "unclaimed"; an absent key would read the
    // same way through `isClaimedDevice`, but only an explicit value keeps the
    // shape of every row identical.
    if (!Object.hasOwn(record, "userId")) {
      record.userId = null;
      changed = true;
    }
  }
  return changed;
}

function deviceId() {
  return `dev_${crypto.randomBytes(6).toString("hex")}`;
}

export function normalizeDeviceToken(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A registration belongs to somebody exactly when it holds a non-empty user id.
 * `userId: null` is an *unclaimed* device: an install that has never signed in,
 * or one whose owner signed out. It has no role, no orders and no name, so the
 * only thing it may ever be sent is a general announcement.
 */
export function isClaimedDevice(record) {
  return typeof record?.userId === "string" && record.userId !== "";
}

/**
 * Every registration owned by one user — and never an unclaimed one.
 *
 * The empty-caller guard is the load-bearing half. Unclaimed rows store
 * `userId: null`, so a caller that passed a missing or null id would otherwise
 * match every anonymous handset on the platform and fan a personal
 * notification out to strangers. There is no id that means "everyone" here.
 */
export function deviceTokensFor(store, userId) {
  if (typeof userId !== "string" || userId === "") return [];
  return (store.deviceTokens || []).filter((record) => record.userId === userId);
}

/** Every registration nobody has signed in on. The announcement audience. */
export function unclaimedDeviceTokens(store) {
  return (store.deviceTokens || []).filter((record) => !isClaimedDevice(record));
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
  ensureDeviceTokens(store);
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

  // An unclaimed row is *claimed*, not reassigned: nobody loses a phone when a
  // handset that had never signed in acquires its first owner.
  const reassignedFrom = isClaimedDevice(existing) && existing.userId !== userId ? existing.userId : null;
  const claimedFromUnclaimed = !isClaimedDevice(existing);
  existing.userId = userId;
  existing.platform = platform;
  // `updatedAt` moves on every re-registration: the app refreshes its token on
  // a schedule, and that recency is the only staleness signal ops has.
  existing.updatedAt = at;
  return { device: existing, created: false, reassignedFrom, claimedFromUnclaimed, changed: true };
}

/**
 * Shape check for the unauthenticated registration path.
 *
 * Anyone on the internet can call that route, so a value that cannot be an FCM
 * registration token is rejected before it can occupy a row. Firebase issues
 * roughly 140–200 characters of `[A-Za-z0-9_:.-]` (the instance-ID half, a
 * colon, then the APA91b… half); the bounds here are deliberately wider than
 * any token observed, because rejecting a *valid* token silently removes that
 * handset from the app-update channel, which is worse than storing a
 * well-formed fake that FCM will reject once and let us prune.
 */
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_:.-]{64,4096}$/;

export function isFcmTokenShaped(token) {
  return FCM_TOKEN_PATTERN.test(token);
}

/**
 * How many unclaimed registrations the pilot keeps. See
 * `registerUnclaimedDeviceToken` for why this is a ceiling with eviction
 * rather than a refusal.
 */
export const UNCLAIMED_DEVICE_LIMIT = 5_000;

export function unclaimedDeviceLimit(env = process.env) {
  const configured = Number(env.GRIDGO_MAX_UNCLAIMED_DEVICES);
  return Number.isInteger(configured) && configured > 0 ? configured : UNCLAIMED_DEVICE_LIMIT;
}

/** Drop least-recently-seen unclaimed rows until at most `keep` remain. */
function evictOldestUnclaimed(store, keep) {
  const unclaimed = unclaimedDeviceTokens(store);
  if (unclaimed.length <= keep) return 0;
  const ordered = unclaimed.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  const doomed = new Set(ordered.slice(0, unclaimed.length - keep).map((record) => record.id));
  store.deviceTokens = store.deviceTokens.filter((record) => !doomed.has(record.id));
  return doomed.size;
}

/**
 * Register a handset that has no account yet, so an app-update announcement
 * can reach an install whose owner never signed in.
 *
 * Two rules make this safe to expose unauthenticated:
 *
 *   - **A claimed row is never touched.** The token is a value an attacker can
 *     supply, and an anonymous call that could unclaim, re-platform or refresh
 *     somebody's registration would be a way to steal or silence their phone.
 *     A re-register of a claimed token is therefore a complete no-op, and the
 *     route answers identically either way. The owner's own app re-registers
 *     with its bearer token; a genuine sign-out unclaims the row itself.
 *   - **The unclaimed pool is bounded.** Past the ceiling the least recently
 *     seen unclaimed rows are evicted, rather than the registration being
 *     refused. A refusal would let one script close the app-update channel to
 *     every genuine new install until an operator intervened; eviction costs an
 *     attacker's fabricated rows first and a real phone only until its next
 *     launch, when the app re-registers. Claimed rows are never evicted.
 */
export function registerUnclaimedDeviceToken(store, { token, platform, at, limit = UNCLAIMED_DEVICE_LIMIT }) {
  ensureDeviceTokens(store);
  const existing = store.deviceTokens.find((record) => record.token === token);
  if (existing) {
    if (isClaimedDevice(existing)) {
      return { device: null, created: false, changed: false, claimedElsewhere: true, evicted: 0 };
    }
    existing.platform = platform;
    existing.updatedAt = at;
    return { device: existing, created: false, changed: true, claimedElsewhere: false, evicted: 0 };
  }

  const evicted = evictOldestUnclaimed(store, Math.max(limit - 1, 0));
  const device = { id: deviceId(), userId: null, token, platform, createdAt: at, updatedAt: at };
  store.deviceTokens.push(device);
  return { device, created: true, changed: true, claimedElsewhere: false, evicted };
}

/**
 * Signing in claims the handset it was performed on.
 *
 * Only an existing registration is claimed: a login knows no platform, so it
 * cannot create one. An app whose token is not registered yet simply calls
 * `POST /devices` with its new bearer token, which registers and claims in one
 * step.
 */
export function claimDeviceToken(store, { token, userId, at }) {
  ensureDeviceTokens(store);
  const existing = store.deviceTokens.find((record) => record.token === token);
  if (!existing) return { device: null, claimed: false, changed: false, previousUserId: null };
  if (existing.userId === userId) {
    existing.updatedAt = at;
    return { device: existing, claimed: false, changed: true, previousUserId: null };
  }
  const previousUserId = isClaimedDevice(existing) ? existing.userId : null;
  existing.userId = userId;
  existing.updatedAt = at;
  return { device: existing, claimed: true, changed: true, previousUserId };
}

/**
 * Signing out returns the handset to the unclaimed pool instead of deleting it.
 *
 * Deleting would take the phone off the app-update channel at exactly the
 * moment it is most likely to be stuck on a broken build. The row survives
 * carrying no identity: it stops receiving that person's notifications with
 * the same immediacy an unregister gave.
 */
export function releaseDeviceToken(store, { token, userId, at }) {
  ensureDeviceTokens(store);
  const record = store.deviceTokens.find(
    (candidate) => candidate.token === token && isClaimedDevice(candidate) && candidate.userId === userId,
  );
  if (!record) return { device: null, released: false, changed: false };
  record.userId = null;
  record.updatedAt = at;
  return { device: record, released: true, changed: true };
}

/**
 * Remove a device token: the caller's own, or — for an unauthenticated caller,
 * `userId: null` — an unclaimed one.
 *
 * A token the caller does not own is reported as absent, not as forbidden. The
 * value is attacker-suppliable, so a distinguishable refusal would turn this
 * route into an oracle for "is this token registered to somebody else?" —
 * unlike an opaque server-minted notification ID, where `403` is safe. The same
 * reasoning bars an anonymous caller from removing a *claimed* row: that still
 * requires its owner's bearer token.
 */
export function unregisterDeviceToken(store, { userId = null, token }) {
  ensureDeviceTokens(store);
  const index = store.deviceTokens.findIndex((record) =>
    record.token === token &&
    (userId == null ? !isClaimedDevice(record) : record.userId === userId),
  );
  if (index === -1) return { removed: null, changed: false };
  const [removed] = store.deviceTokens.splice(index, 1);
  return { removed, changed: true };
}

/** Drop registrations FCM has reported as dead. Returns the number removed. */
export function removeDeviceTokenIds(store, ids) {
  ensureDeviceTokens(store);
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

export function announcementImagePublicPath(fileId) {
  return `${ANNOUNCEMENT_IMAGE_PUBLIC_PREFIX}${fileId}`;
}

/**
 * The phone downloads the lock-screen picture itself from this URL, so a LAN
 * `http://192.168.1.55:8787/...` path is valid in local development. Credentials
 * in the URL are never allowed.
 */
export function isFcmFetchableImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    return Boolean(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Origin the phone uses to fetch a hosted broadcast picture.
 *
 * `GRIDGO_PUBLIC_API_ORIGIN` always wins. When it is unset and MinIO's public
 * origin is plain http (local LAN), reuse that host with this process's port
 * so an uploaded picture can ride the lock screen without another env var.
 * An https MinIO origin is production storage, not the API — do not guess.
 */
export function announcementImageOrigin(env = process.env) {
  const explicit = trimmedString(env.GRIDGO_PUBLIC_API_ORIGIN).replace(/\/+$/, "");
  if (explicit) return explicit;
  try {
    const minio = new URL(trimmedString(env.MINIO_PUBLIC_URL));
    if (minio.protocol !== "http:" || !minio.hostname) return "";
    const port = trimmedString(env.PORT) || "8787";
    return `${minio.protocol}//${minio.hostname}:${port}`;
  } catch {
    return "";
  }
}

/**
 * Optional announcement picture. Empty is fine. A hosted file is stored as the
 * public path; anything else must be an http(s) URL without credentials.
 */
export function normalizeAnnouncementImageUrl(value) {
  if (value == null) return { imageUrl: null };
  if (typeof value !== "string") {
    return { error: "invalid_announcement_image" };
  }
  const trimmed = value.trim();
  if (!trimmed) return { imageUrl: null };
  if (trimmed.length > ANNOUNCEMENT_IMAGE_URL_MAX) {
    return { error: "invalid_announcement_image" };
  }
  if (trimmed.startsWith(ANNOUNCEMENT_IMAGE_PUBLIC_PREFIX)) {
    const fileId = trimmed.slice(ANNOUNCEMENT_IMAGE_PUBLIC_PREFIX.length);
    if (!ANNOUNCEMENT_IMAGE_FILE_ID.test(fileId)) {
      return { error: "invalid_announcement_image" };
    }
    return { imageUrl: announcementImagePublicPath(fileId) };
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: "invalid_announcement_image" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { error: "invalid_announcement_image" };
  }
  if (parsed.username || parsed.password) {
    return { error: "invalid_announcement_image" };
  }
  return { imageUrl: parsed.toString() };
}

/**
 * Absolute URL to put on the FCM payload so the phone can download the picture.
 * Hosted paths are joined to `announcementImageOrigin`.
 */
export function resolveFcmImageUrl(imageUrl, env = process.env) {
  const value = trimmedString(imageUrl);
  if (!value) return null;
  let absolute = value;
  if (value.startsWith(ANNOUNCEMENT_IMAGE_PUBLIC_PREFIX)) {
    const origin = announcementImageOrigin(env);
    if (!origin) return null;
    try {
      absolute = new URL(value, `${origin}/`).toString();
    } catch {
      return null;
    }
  }
  return isFcmFetchableImageUrl(absolute) ? absolute : null;
}

/**
 * Build the user-facing half of a push from an already-persisted notification,
 * so every push corresponds to a record the same user can also read in-app.
 *
 * `data` is built from PUSH_DATA_FIELDS only — enough for the app to open the
 * right screen, and nothing else regardless of what the record carries.
 */
export function pushMessageFor(notification, env = process.env) {
  const data = {
    notificationId: String(notification.id),
    type: trimmedString(notification.type),
    orderId: trimmedString(notification.orderId),
    at: trimmedString(notification.at),
  };
  for (const key of Object.keys(data)) {
    if (!PUSH_DATA_FIELDS.includes(key) || data[key] === "") delete data[key];
  }
  const image = resolveFcmImageUrl(notification.imageUrl, env);
  return {
    title: trimmedString(notification.title) || "GRIDGO",
    body: trimmedString(notification.body) || "Open GRIDGO for the latest update.",
    data,
    ...(image ? { image } : {}),
  };
}

/**
 * The only message shape an unclaimed device may be handed: an ops-authored
 * title and body, plus `type: "announcement"` so the app can route it without
 * a notification record to open.
 */
export function announcementPushMessage({ title, body, imageUrl }, env = process.env) {
  const image = resolveFcmImageUrl(imageUrl, env);
  return {
    title: trimmedString(title) || "GRIDGO",
    body: trimmedString(body) || "Open GRIDGO for the latest update.",
    data: { type: ANNOUNCEMENT_PUSH_TYPE },
    ...(image ? { image } : {}),
  };
}

/**
 * Refuse to send anything but a general announcement to a handset nobody has
 * signed in on.
 *
 * An unclaimed registration is an anonymous phone: nothing proves who is
 * holding it. So the boundary is enforced where the bytes leave — any fan-out
 * that includes one unclaimed device must carry a stranger-safe message —
 * rather than by each caller remembering to pick the right audience. A
 * personal notification's message carries `notificationId` (and usually
 * `orderId`), so passing one here throws rather than silently reaching a
 * stranger's lock screen.
 */
export function assertStrangerSafeMessage(message) {
  const data = message?.data || {};
  const personal = Object.keys(data).filter((key) => !ANONYMOUS_PUSH_DATA_FIELDS.includes(key));
  if (personal.length > 0) {
    throw new PushAudienceError(
      `refusing to push personal field(s) to an unclaimed device: ${personal.sort().join(", ")}`,
    );
  }
  if (data.type !== ANNOUNCEMENT_PUSH_TYPE) {
    throw new PushAudienceError(
      `only ${ANNOUNCEMENT_PUSH_TYPE} messages may reach an unclaimed device (got ${JSON.stringify(data.type ?? null)})`,
    );
  }
}

export function fcmRequestBody(message, token) {
  const notification = { title: message.title, body: message.body };
  const androidNotification = { channel_id: ANDROID_NOTIFICATION_CHANNEL_ID };
  const aps = { sound: "default" };
  const apns = {
    headers: { "apns-priority": "10" },
    payload: { aps },
  };
  if (message.image) {
    notification.image = message.image;
    androidNotification.image = message.image;
    aps["mutable-content"] = 1;
    apns.fcm_options = { image: message.image };
  }
  return {
    message: {
      token,
      notification,
      data: message.data,
      android: {
        priority: "high",
        notification: androidNotification,
      },
      apns,
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
    // The one gate every push passes through. A batch containing a device
    // nobody has signed in on may only carry a general announcement, whatever
    // the caller believed it was sending.
    if (devices.some((device) => !isClaimedDevice(device))) assertStrangerSafeMessage(message);
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
