import { createRealtimeTransport } from "./realtime-transport.js";
import { createApnsDelivery, routePushDelivery } from "./apns.js";
import { enqueueNotificationPushes, createOutboxWorker } from "./push-outbox.js";
import { deriveDomainEvents } from "./domain-events.js";
import { originalDomainStore } from "./postgres-store.js";
import { hasRole, approvedRole, canAccessOrder, notificationVisible, EVENT_ROLES } from "./notifications.js";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWebhook } from "@clerk/backend/webhooks";
import {
  activateClerkClientProfile,
  applyClerkIdentityCopy,
  applyClerkWebhookEvent,
  authConfiguration,
  authenticateBearerToken,
  clientEmailAvailable,
  createClerkBackend,
  verifyClerkClaims,
  authFailureBody,
} from "./auth.js";
import {
  resolveAuthorizationContext,
  approvalCaseFor,
  approvalCaseSummary,
  contextHasMembership,
  identityHasMembership,
  membershipFor,
  membershipSummary,
} from "./authorization-context.js";
import {
  APPROVAL_CASE_KINDS,
  APPROVAL_CASE_STATUSES,
  APPROVAL_DECISIONS,
  approvalDecisionInput,
  decideApprovalCase,
  supplierApprovalReadiness,
} from "./approval-cases.js";
import {
  AttachmentError,
  attachCatalogItemPhoto,
  attachSupplierShopImage,
  attachRiderDocument,
  attachFileReference,
  authorizeFileAttach,
  authorizeFileAttachOwner,
  authorizeFileRead,
  authorizeFileUpload,
  createPendingFile,
  findFile,
  markFileDeleted,
  invalidateRiderDocumentsForFile,
  markFileDeletePending,
  markFileReady,
  parseMultipartStream,
  publicFile,
  readArtworkMeasurements,
  resolveFileTarget,
  validateUpload,
} from "./attachments.js";
import {
  isPublicSupplierCatalogRoute,
  routeSupplierCatalog,
} from "./catalog-routes.js";
import {
  isPrivateRiderProfileRoute,
  routeRiderProfile,
} from "./rider-profile-routes.js";
import { routeOrderMatch } from "./order-match-routes.js";
import { MatchError, matchShop } from "./order-match.js";
import { defaultShopSchedule, projectFinish } from "./availability.js";
import { decorateCatalogPhotoUrls as signCatalogPhotoUrls } from "./catalog-photo-urls.js";
import { privateCatalogItem } from "./supplier-catalog.js";
import {
  applyForBusiness,
  assertRiderLegacyVerificationReady,
  enrollRider,
  enrollSupplier,
  reapplyForApproval,
  requireIdempotencyKey,
  submitRiderApplication,
} from "./enrollment.js";
import {
  notifyClientPaymentRejected,
  notifyOpsIssueReported,
  notifyOpsJobNeedsQa,
  notifyOpsPaymentSubmitted,
  notifyOrderParties,
  notifyShopPayoutHeld,
} from "./client-order-notifications.js";
import {
  createNotificationEvents,
  formatInvalidateEvent,
  formatNotificationEvent,
  listInbox,
  notificationSnapshot,
  orderFromNotification,
  privilegedAdminMemberships,
  publicNotification,
  publishQueuedInvalidates,
  queueInvalidate,
  queueOrderInvalidate,
} from "./notifications.js";
import { createObjectStorage } from "./object-storage.js";
import {
  DEVICE_PLATFORMS,
  announcementPushMessage,
  createPushDeliveryOrDisable,
  deviceTokensFor,
  isFcmTokenShaped,
  normalizeAnnouncementImageUrl,
  normalizeDeviceToken,
  publicDevice,
  pushMessageFor,
  registerDeviceToken,
  registerUnclaimedDeviceToken,
  releaseDeviceToken,
  removeDeviceTokenIds,
  unclaimedDeviceLimit,
  unclaimedDeviceTokens,
  unregisterDeviceToken,
} from "./push.js";
import {
  buildCategoryTree,
  resolveCategoryCode,
} from "./taxonomy.js";
import { routeAccountProfile } from "./account-profile-routes.js";
import {
  calculateOrderMoney,
  carriedToOffice,
  createPaymentSchedule,
  createPayoutMilestones,
  defaultOperationalSettings,
  estimatePriceRange,
  expireIssueWindows,
  isContainedPickup,
  issueWindowExpiresAt,
  PICKUP_CHECK_CODES,
  PICKUP_SIGN_OFF_PROMPT,
  publicOrderFor,
  releaseMilestone,
  validateOperationalSettings,
} from "./operational-model.js";
import {
  parseAllowedOrigins,
  validateProductionServerEnvironment,
} from "./runtime-config.js";
import { createDatabase } from "./database.js";
import { createSupportMailer, emailConfigured } from "./support-mail.js";
import {
  isSupportDeskRoute,
  routeSupportDesk,
  seedSupportDeskAdmin,
} from "./support-desk.js";
import {
  loadDeviceTokenStore,
  loadStore,
  originalNotificationIds,
  saveDeviceTokenStore,
  saveStore,
} from "./postgres-store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const AUTH = authConfiguration(process.env);
const clerkBackend = createClerkBackend(AUTH);
const database = createDatabase(process.env);
// Baked into the image at build time (see Dockerfile). `/health` reports them so
// a deploy can be *proven* to have taken: a stale container answering `ok` is
// otherwise indistinguishable from a deploy that never happened.
const BUILD_COMMIT = process.env.GRIDGO_BUILD_SHA || "unknown";
const BUILD_TIME = process.env.GRIDGO_BUILD_TIME || "unknown";
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env);
validateProductionServerEnvironment(process.env, ALLOWED_ORIGINS);
const objectStorage = createObjectStorage(process.env);
// Push is optional configuration, not a startup requirement. A hosted pilot
// without a usable service-account file must still serve every route — the
// phones simply fall back to in-app and SSE delivery — because the deploy that
// ships this code runs before an operator can install the secret. `/health`
// reports `push.status` as `disabled` or `misconfigured` with the reason, so
// the gap is loud rather than silent.
const pushDelivery = routePushDelivery(createPushDeliveryOrDisable(process.env),createApnsDelivery(process.env));
const supportMailer = createSupportMailer(process.env);
// Ceiling on registrations nobody has signed in on; `POST /devices` is the one
// unauthenticated write on the platform. See `registerUnclaimedDeviceToken`.
const MAX_UNCLAIMED_DEVICES = unclaimedDeviceLimit(process.env);
const enqueueMutation = (mutation) => database.transaction(mutation);
// The anonymous device routes touch nothing but device_tokens, so they commit
// under their own advisory lock and can never hold up the domain lock that
// serializes every credentialed platform mutation.
const enqueueDeviceMutation = (mutation) => database.transaction(mutation, { lockKey: "gridgo-device-tokens" });
const notificationEvents = createNotificationEvents();
const realtimeTransport = createRealtimeTransport({database,loadStore,events:notificationEvents,connectionString:process.env.DATABASE_URL});
const NOTIFICATION_HEARTBEAT_MS = Number(process.env.NOTIFICATION_HEARTBEAT_MS || 25_000);
let storageInitializing = true;

async function save(store) {
  deriveDomainEvents(store, originalDomainStore(store), {createId:id,at:now()});
  const previousNotificationIds = originalNotificationIds(store);
  const createdNotifications = (store.notifications || []).filter(
    (notification) => !previousNotificationIds.has(notification.id),
  );
  await saveStore(database, store);
  await enqueueNotificationPushes(database,store,createdNotifications);
  await realtimeTransport.enqueue(store,createdNotifications);
}

/**
 * Push a platform-wide announcement to every handset nobody has signed in on.
 *
 * The single exception to "`save()` is the only place push fires", and it is
 * not one a call site can forget: an unclaimed device has no user, so there is
 * no notification record for it to be derived from, and no `save()` to hook.
 * The rule the hook exists to enforce — one push per readable notification —
 * still holds, because this path carries no notification at all. It has exactly
 * one call site (`POST /announcements`), and `pushDelivery.send` refuses
 * anything but a stranger-safe message for these devices regardless.
 */
function deliverAnnouncementPush(devices, { title, body, imageUrl }) {
  if (!pushDelivery.configured || devices.length === 0) return;
  fanOutPush("announcement", announcementPushMessage({ title, body, imageUrl }), devices);
}

/**
 * Fire-and-forget fan-out shared by both push paths. Cannot reject: whatever
 * created the message is already committed, and neither a dead phone nor
 * an unreachable Google may turn that into a failed request.
 */
function fanOutPush(label, message, devices) {
  pushDelivery
    .send(message, devices)
    .then((results) => {
      for (const result of results) {
        if (!result.ok && !result.prune) {
          console.warn(`push delivery failed ${label} device=${result.deviceId} code=${result.code}`);
        }
      }
      return pruneDeadDeviceTokens(results.filter((result) => result.prune).map(({ deviceId }) => deviceId));
    })
    .catch((error) => {
      console.warn(`push delivery error ${label} reason=${error?.message || "unknown"}`);
    });
}

/**
 * Drop registrations FCM reported as gone. Left in place, they fill the database
 * with reinstalled and wiped phones and cost a request on every later send.
 *
 * Re-reads the database snapshot in a transaction instead of editing the caller's
 * copy: by the time FCM answers, that copy is stale and writing it back would
 * lose whatever landed in between.
 */
async function pruneDeadDeviceTokens(deviceIds) {
  if (deviceIds.length === 0) return;
  await enqueueMutation(async () => {
    const latestStore = await load();
    const removed = removeDeviceTokenIds(latestStore, deviceIds);
    if (removed === 0) return;
    await save(latestStore);
    console.warn(`push pruned ${removed} unregistered device token(s)`);
  });
}
function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}
function now() {
  return new Date().toISOString();
}

async function compensatePendingFile(fileId, objectKey) {
  try {
    await objectStorage.deleteObject(objectKey);
    await enqueueMutation(async () => {
      const latestStore = await load();
      const latestFile = findFile(latestStore, fileId);
      if (latestFile?.state !== "pending_upload") return;
      markFileDeleted(latestFile, now());
      await save(latestStore);
    });
  } catch {
    // The pending record is the durable reconciliation marker for the next successful boot.
  }
}

function writeJsonResponse(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  if (status >= 400 && body && typeof body === "object") {
    res.gridgoError = typeof body.error === "string" ? body.error : "";
    res.gridgoErrorFields =
      body.fields && typeof body.fields === "object" ? Object.keys(body.fields) : [];
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...(res.gridgoCorsHeaders || {}),
  });
  res.end(payload);
}

function send(res, status, body, { afterCommit = true } = {}) {
  if (afterCommit && database.inWriteTransaction()) {
    database.afterCommit(() => writeJsonResponse(res, status, body));
    return;
  }
  writeJsonResponse(res, status, body);
}

function clerkWebhookSigningSecret() {
  return String(process.env.CLERK_WEBHOOK_SIGNING_SECRET || "").trim();
}

function readRawBody(req) {
  if (Object.hasOwn(req, "gridgoRawBody")) return Promise.resolve(req.gridgoRawBody);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024 && !tooLarge) {
        tooLarge = true;
        chunks.length = 0;
        reject(
          new AttachmentError(
            413,
            "request_body_too_large",
            "This request body is larger than 1 MiB. Remove extra data and try again.",
            { maxBytes: 1024 * 1024 },
          ),
        );
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      req.gridgoRawBody = Buffer.concat(chunks);
      resolve(req.gridgoRawBody);
    });
    req.on("error", reject);
  });
}

async function verifiedClerkWebhookEvent(req) {
  const signingSecret = clerkWebhookSigningSecret();
  if (!signingSecret) {
    const error = new Error("Clerk webhook signing secret is not configured.");
    error.status = 503;
    error.code = "webhook_unconfigured";
    throw error;
  }
  const raw = await readRawBody(req);
  const request = new Request("https://gridgo.invalid/webhooks/clerk", {
    method: "POST",
    headers: {
      "svix-id": String(req.headers["svix-id"] || ""),
      "svix-timestamp": String(req.headers["svix-timestamp"] || ""),
      "svix-signature": String(req.headers["svix-signature"] || ""),
      "content-type": "application/json",
    },
    body: raw,
  });
  try {
    return await verifyWebhook(request, { signingSecret });
  } catch {
    const error = new Error("This Clerk webhook could not be verified. Check the signing secret and retry.");
    error.status = 400;
    error.code = "invalid_webhook";
    throw error;
  }
}

function readBody(req) {
  if (Object.hasOwn(req, "gridgoParsedBody")) return Promise.resolve(req.gridgoParsedBody);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024 && !tooLarge) {
        tooLarge = true;
        chunks.length = 0;
        reject(
          new AttachmentError(
            413,
            "request_body_too_large",
            "This request body is larger than 1 MiB. Remove extra data and try again.",
            { maxBytes: 1024 * 1024 },
          ),
        );
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      if (!chunks.length) {
        req.gridgoParsedBody = {};
        return resolve(req.gridgoParsedBody);
      }
      try {
        req.gridgoParsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(req.gridgoParsedBody);
      } catch {
        reject(
          new AttachmentError(
            400,
            "invalid_json",
            "The request body is not valid JSON. Fix the JSON syntax and try again.",
          ),
        );
      }
    });
    req.on("error", reject);
  });
}

function sendDomainError(res, error, options) {
  return send(res, error.status || 500, {
    error: error.code || "server_error",
    message: error.message,
    ...(error.details || {}),
  }, options);
}

async function decorateCatalogPhotoUrls(store, body) {
  await signCatalogPhotoUrls(store, body, {
    findFile,
    presignGet: (key) => objectStorage.presignGet(key),
  });
}

const PAYMENT_QR_PUBLIC_PATH = "/public/payment-qr";

function readyPaymentQrFile(store) {
  const fileId = store?.settings?.paymentQrFileId;
  if (!fileId) return null;
  const file = findFile(store, fileId);
  if (
    !file
    || file.purpose !== "payment_qr"
    || file.state !== "ready"
    || file.deletedAt
    || file.deleteRequestedAt
    || !file.objectKey
  ) {
    return null;
  }
  return file;
}

function publicOperationalSettings(settings, store = null) {
  const { paymentQrFileId: _paymentQrFileId, ...rest } = settings || {};
  const paymentQr = { method: "qr_manual", caption: "QR Ph" };
  const file = store ? readyPaymentQrFile(store) : null;
  if (file) paymentQr.imageUrl = `${PAYMENT_QR_PUBLIC_PATH}?v=${encodeURIComponent(file.fileId)}`;
  return { ...rest, paymentQr };
}

/**
 * Lock-screen and in-app broadcast pictures. Unauthenticated on purpose: FCM
 * fetches this URL from Google, and a signed MinIO URL would expire before a
 * shop opened the alert. Only `announcement_image` files that are ready.
 */
async function serveAnnouncementImage(req, res, store, pathname) {
  const fileId = pathname.slice("/public/announcement-images/".length);
  const file = findFile(store, fileId);
  if (
    !file
    || file.purpose !== "announcement_image"
    || file.state !== "ready"
    || file.deletedAt
    || file.deleteRequestedAt
    || !file.objectKey
  ) {
    return send(res, 404, { error: "announcement_image_not_found" });
  }
  try {
    const headers = {
      "Content-Type": file.detectedContentType || "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
      "Content-Length": String(file.size),
      ...(res.gridgoCorsHeaders || {}),
    };
    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    const stream = await objectStorage.getObject(file.objectKey);
    res.writeHead(200, headers);
    stream.on("error", () => {
      if (!res.writableEnded) res.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof AttachmentError || (error && Number.isInteger(error.status) && error.code)) {
      return sendDomainError(res, error);
    }
    throw error;
  }
}

/**
 * GRIDGO's one receiving QR. Unauthenticated on purpose: checkout needs the
 * plate even when totals are not ready, and a signed MinIO URL would expire
 * while a client still has the sheet open. Only the current ready `payment_qr`.
 */
async function servePaymentQr(req, res, store) {
  const file = readyPaymentQrFile(store);
  if (!file) {
    return send(res, 404, { error: "payment_qr_not_found" });
  }
  try {
    const headers = {
      "Content-Type": file.detectedContentType || "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
      "Content-Length": String(file.size),
      ...(res.gridgoCorsHeaders || {}),
    };
    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    const stream = await objectStorage.getObject(file.objectKey);
    res.writeHead(200, headers);
    stream.on("error", () => {
      if (!res.writableEnded) res.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof AttachmentError || (error && Number.isInteger(error.status) && error.code)) {
      return sendDomainError(res, error);
    }
    throw error;
  }
}

/** Whether the caller presented a bearer token at all — valid or not. */
function hasBearerToken(req) {
  return /^Bearer\s+(.+)$/i.test(req.headers.authorization || "");
}

/**
 * Verify the request's Clerk token once per request and reuse the verdict.
 *
 * Verification can reach the Clerk JWKS endpoint over the network, and every
 * mutation handler runs inside the transaction that holds the global mutation
 * advisory lock — so the network round trip must happen before the transaction
 * starts, never inside it, or a slow Clerk API stalls every platform mutation.
 */
async function verifiedClerkClaimsFor(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  const token = m?.[1] || null;
  if (!token) return null;
  if (!req.gridgoVerifiedClaims) {
    req.gridgoVerifiedClaims = await verifyClerkClaims(token, AUTH);
  }
  return req.gridgoVerifiedClaims;
}

async function authenticateRequest(req, store) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  return authenticateBearerToken(m?.[1] || null, store, AUTH, await verifiedClerkClaimsFor(req));
}

/**
 * All Clerk network traffic a mutation needs, performed before its transaction.
 * Activation additionally loads the Clerk user profile; a failure is carried as
 * `clerkUser: null` so the handler can still answer its ordering-sensitive
 * 401/403 checks against the store before reporting Clerk as unavailable.
 */
async function verifyClerkBeforeMutation(req, pathname) {
  const verified = await verifiedClerkClaimsFor(req);
  const needsClerkProfile = [
    "/auth/clerk/activate",
    "/auth/clerk/enroll/supplier",
    "/auth/clerk/enroll/rider",
  ].includes(pathname);
  if (req.method === "POST" && needsClerkProfile && verified?.claims?.sub) {
    try {
      req.gridgoClerkUser = { clerkUser: await clerkBackend.users.getUser(verified.claims.sub) };
    } catch {
      req.gridgoClerkUser = { clerkUser: null };
    }
  }
  return verified;
}

/** Client account types for branding (GRIDGO vs GRIDGO Business). Not inferred from orgName. */
const CLIENT_ACCOUNT_TYPES = new Set(["individual", "business", "organization"]);
const FIXED_AUTH_ROLES = new Map([
  ["/auth/me/client", "client"],
  ["/auth/me/supplier", "supplier"],
  ["/auth/me/rider", "rider"],
  ["/auth/me/ops", "ops_admin"],
  ["/auth/me/admin", "super_admin"],
]);

/**
 * Safe default when a client has no recorded type: individual.
 * Business branding must be explicit opt-in, never accidental from orgName.
 */
function resolveClientAccountType(u) {
  if (u && CLIENT_ACCOUNT_TYPES.has(u.accountType)) return u.accountType;
  return "individual";
}

function publicUser(u) {
  if (!u) return null;
  const rest = { ...u };
  delete rest.clerkUserId;
  // Identity-document references are exposed only through the dedicated, caller-aware
  // verification projection. publicUser is reused in catalogue and matching responses.
  delete rest.verificationDocumentFileIds;
  delete rest.profileNameManaged;
  // Clients always expose an authoritative accountType (never undefined for consumers).
  // Non-client roles omit the field — same pattern as orgName / shop / verificationStatus.
  if (u.role === "client") {
    rest.accountType = resolveClientAccountType(u);
    rest.version = u.version || 1;
  } else {
    delete rest.accountType;
    delete rest.version;
  }
  return rest;
}

/** Directory filters select authoritative memberships, retaining their role profile. */
function roleDirectoryUser(store, user, role) {
  const projected = { ...user, role };
  if (["supplier", "rider"].includes(role)) {
    const approval = (store.approvalCases || []).find((c) => c.userId === user.id && c.kind === role);
    projected.verificationStatus = approval?.status || (user.role === role ? user.verificationStatus : "unverified");
  }
  if (role === "supplier") {
    const profile = supplierProfileProjection(store, user.id);
    if (profile) { projected.supplierName = profile.shopName; projected.shop = profile.shop; }
  } else if (role === "rider") {
    const profile = riderProfileProjection(store, user.id);
    if (profile) projected.riderProfile = profile;
  }
  return projected;
}

function publicIdentity(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    ...(user.phone ? { phone: user.phone } : {}),
    createdAt: user.createdAt,
  };
}

function clientProfileProjection(store, userId) {
  const profile = (store.clientProfiles || []).find((candidate) => candidate.userId === userId);
  if (!profile) return null;
  return {
    clientKind: profile.clientKind,
    businessName: profile.businessName ?? null,
    businessNature: profile.businessNature ?? null,
    updatedAt: profile.updatedAt,
  };
}

function supplierProfileProjection(store, userId) {
  const profile = (store.supplierProfiles || []).find((candidate) => candidate.userId === userId);
  if (!profile) return null;
  return {
    shopName: profile.shopName,
    contactName: profile.contactName,
    shop: profile.shop,
    pickupAvailable: profile.pickupAvailable,
    updatedAt: profile.updatedAt,
  };
}

function riderProfileProjection(store, userId) {
  const profile = (store.riderProfiles || []).find((candidate) => candidate.userId === userId);
  if (!profile) return null;
  return {
    vehicleType: profile.vehicleType,
    plateNumber: profile.plateNumber,
    licenseNumber: profile.licenseNumber ?? null,
    updatedAt: profile.updatedAt,
  };
}

function supplierReadiness(store, userId, approvalCase) {
  if (approvalCase?.status === "approved") return { readyForApproval: true, missing: [] };
  return supplierApprovalReadiness(store, userId);
}

function currentRiderDocuments(store, userId) {
  return (store.riderDocuments || [])
    .filter((document) => document.riderId === userId && document.isCurrent !== false)
    .map((document) => ({
      id: document.id,
      kind: document.kind,
      fileId: document.fileId,
      expiresOn: document.expiresOn ?? null,
      uploadedAt: document.uploadedAt,
    }));
}

function approvalCaseForApprover(approvalCase) {
  return {
    ...approvalCaseSummary(approvalCase),
    decidedBy: approvalCase.decidedBy ?? null,
  };
}

function approvalHistoryFor(store, caseId) {
  return (store.approvalCaseEvents || [])
    .filter((event) => event.approvalCaseId === caseId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map((event) => ({
      id: event.id,
      applicationRevision: event.applicationRevision,
      fromStatus: event.fromStatus ?? null,
      toStatus: event.toStatus,
      actorUserId: event.actorUserId ?? null,
      actorKind: event.actorKind,
      reason: event.reason ?? null,
      requestId: event.requestId,
      snapshot: stripCommissionFields(event.snapshot || {}),
      createdAt: event.createdAt,
    }));
}

function stripCommissionFields(value) {
  if (Array.isArray(value)) return value.map(stripCommissionFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.toLowerCase().includes("commission"))
      .map(([key, child]) => [key, stripCommissionFields(child)]),
  );
}

function riderDocumentsForApproval(store, userId) {
  return currentRiderDocuments(store, userId).map((document) => {
    const file = findFile(store, document.fileId);
    return {
      ...document,
      file: file?.state === "ready" && file.ownerId === userId ? publicFile(file) : null,
    };
  });
}

function approvalCaseDetail(store, approvalCase) {
  const applicant = (store.users || []).find((candidate) => candidate.id === approvalCase.userId);
  const base = {
    approvalCase: approvalCaseForApprover(approvalCase),
    applicant: publicIdentity(applicant),
    history: approvalHistoryFor(store, approvalCase.id),
  };
  if (approvalCase.kind === "business_client") {
    return {
      ...base,
      clientProfile: clientProfileProjection(store, approvalCase.userId),
    };
  }
  if (approvalCase.kind === "rider") {
    return {
      ...base,
      riderProfile: riderProfileProjection(store, approvalCase.userId),
      riderDocuments: riderDocumentsForApproval(store, approvalCase.userId),
    };
  }
  const services = (store.supplierServices || [])
    .filter((service) => service.supplierId === approvalCase.userId)
    .map(summarizeService);
  return {
    ...base,
    supplierProfile: supplierProfileProjection(store, approvalCase.userId),
    categories: [...new Set(services.map((service) => service.categoryCode))],
    services,
    readiness: supplierReadiness(store, approvalCase.userId, approvalCase),
    // Task E owns these settled sections. Stable placeholders keep this detail
    // contract additive while its relational tables are absent on main.
    pickupPaymentTerms: null,
    shopMedia: [],
    catalogPreview: [],
  };
}

function encodeApprovalCursor(approvalCase) {
  return Buffer.from(JSON.stringify({ submittedAt: approvalCase.submittedAt, id: approvalCase.id }))
    .toString("base64url");
}

function decodeApprovalCursor(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof cursor.submittedAt !== "string" || typeof cursor.id !== "string") return null;
    if (Number.isNaN(Date.parse(cursor.submittedAt)) || !cursor.id) return null;
    return cursor;
  } catch {
    return null;
  }
}

function approvalQueue(store, url) {
  const status = url.searchParams.get("status") || "pending";
  const kind = url.searchParams.get("kind");
  if (!APPROVAL_CASE_STATUSES.has(status)) {
    return { error: "invalid_approval_status", status: 400, allowed: [...APPROVAL_CASE_STATUSES] };
  }
  if (kind && !APPROVAL_CASE_KINDS.has(kind)) {
    return { error: "invalid_approval_kind", status: 400, allowed: [...APPROVAL_CASE_KINDS] };
  }
  const encodedCursor = url.searchParams.get("cursor");
  const cursor = decodeApprovalCursor(encodedCursor);
  if (encodedCursor && !cursor) return { error: "invalid_cursor", status: 400 };

  let cases = (store.approvalCases || [])
    .filter((approvalCase) => approvalCase.submittedAt != null && approvalCase.status === status)
    .filter((approvalCase) => !kind || approvalCase.kind === kind)
    .sort(
      (left, right) =>
        left.submittedAt.localeCompare(right.submittedAt) || left.id.localeCompare(right.id),
    );
  if (cursor) {
    cases = cases.filter(
      (approvalCase) =>
        approvalCase.submittedAt > cursor.submittedAt ||
        (approvalCase.submittedAt === cursor.submittedAt && approvalCase.id > cursor.id),
    );
  }
  const page = cases.slice(0, 51);
  const hasMore = page.length > 50;
  if (hasMore) page.pop();
  return {
    status: 200,
    approvalCases: page.map((approvalCase) => ({
      ...approvalCaseForApprover(approvalCase),
      applicant: publicIdentity(
        (store.users || []).find((candidate) => candidate.id === approvalCase.userId),
      ),
    })),
    nextCursor: hasMore ? encodeApprovalCursor(page.at(-1)) : null,
  };
}

function fixedAuthProjection(store, auth, role) {
  const context = auth.authorization;
  const membership = membershipSummary(membershipFor(context, role));
  const base = { user: publicIdentity(auth.user), membership };
  if (role === "client") {
    const approvalCase = approvalCaseFor(context, "business_client");
    const approved = approvalCase?.status === "approved";
    return {
      ...base,
      clientProfile: clientProfileProjection(store, auth.user.id),
      approvalCase: approvalCaseSummary(approvalCase),
      capabilities: {
        placePersonalOrders: true,
        maintainBusinessProfile: Boolean(approvalCase),
        placeBusinessOrders: approved,
        requestOfficialReceipts: approved,
      },
    };
  }
  if (role === "supplier") {
    const approvalCase = approvalCaseFor(context, "supplier");
    const canEdit = approvalCase?.status !== "suspended";
    const approved = approvalCase?.status === "approved";
    return {
      ...base,
      supplierProfile: supplierProfileProjection(store, auth.user.id),
      approvalCase: approvalCaseSummary(approvalCase),
      readiness: supplierReadiness(store, auth.user.id, approvalCase),
      capabilities: {
        editCatalogue: canEdit,
        editSettings: canEdit,
        receiveJobOffers: approved,
        acceptJobs: approved,
      },
    };
  }
  if (role === "rider") {
    const approvalCase = approvalCaseFor(context, "rider");
    const documents = currentRiderDocuments(store, auth.user.id);
    const approved = approvalCase?.status === "approved";
    return {
      ...base,
      riderProfile: riderProfileProjection(store, auth.user.id),
      approvalCase: approvalCaseSummary(approvalCase),
      onboardingIncomplete: approvalCase?.status === "pending" && approvalCase.submittedAt == null,
      documents,
      capabilities: {
        maintainProfile: true,
        uploadDocuments: true,
        receiveDispatchOffers: approved,
        acceptAssignments: approved,
        startTracking: approved,
      },
    };
  }
  if (role === "ops_admin") {
    return {
      ...base,
      capabilities: {
        manageApprovalCases: true,
        manageOperations: true,
      },
    };
  }
  return {
    ...base,
    capabilities: {
      manageApprovalCases: true,
      manageOperations: true,
      manageRoleMemberships: true,
      managePlatformSettings: true,
    },
  };
}

function isOps(user) {
  return identityHasMembership(user, "ops_admin") || identityHasMembership(user, "super_admin");
}

function isSuper(user) {
  return identityHasMembership(user, "super_admin");
}

/**
 * Who a platform announcement reaches.
 *
 * `everyone` is the only audience that extends to unclaimed devices, and it is
 * the reason they exist: an app-update notice has to reach an install whose
 * owner never signed in. A role-targeted audience cannot include them — an
 * unclaimed handset has no role, and guessing one would put a print-shop
 * message on a rider's lock screen.
 */
const ANNOUNCEMENT_AUDIENCES = new Map([
  ["everyone", null],
  ["clients", ["client"]],
  ["suppliers", ["supplier"]],
  ["riders", ["rider"]],
  ["ops", ["ops_admin", "super_admin"]],
]);
const ANNOUNCEMENT_TITLE_MAX = 120;
const ANNOUNCEMENT_BODY_MAX = 500;

function validatedShop(value) {
  if (
    !value ||
    typeof value.lat !== "number" ||
    typeof value.lng !== "number" ||
    !Number.isFinite(value.lat) ||
    !Number.isFinite(value.lng) ||
    value.lat < -90 ||
    value.lat > 90 ||
    value.lng < -180 ||
    value.lng > 180
  ) {
    return {
      error: "invalid_shop_coordinates",
      message: "Pin the shop with finite latitude from -90 to 90 and longitude from -180 to 180.",
    };
  }
  if (typeof value.label !== "string" || !value.label.trim()) {
    return {
      error: "shop_label_required",
      message: "Add the shop address or landmark label before saving the pin.",
    };
  }
  return { shop: { lat: value.lat, lng: value.lng, label: value.label.trim() } };
}

function verificationDocumentsFor(store, supplier) {
  if (!supplier || supplier.role !== "supplier") return [];
  return (supplier.verificationDocumentFileIds || [])
    .map((fileId) => findFile(store, fileId))
    .filter(
      (file) =>
        file?.state === "ready" &&
        file.purpose === "verification_document" &&
        file.ownerId === supplier.id,
    )
    .map(publicFile);
}

function verificationUserResponse(store, target) {
  return {
    user: publicUser(target),
    ...(target.role === "supplier" ? { verificationDocuments: verificationDocumentsFor(store, target) } : {}),
  };
}

/**
 * The legacy verification and role routes stay the only decision surfaces for
 * one release, so their transactions must also keep the membership-era approval
 * case truthful: fixed projections and existing work gates read different
 * owners. The legacy `unverified` status has no case equivalent and maps to
 * `pending`; a demoted then re-promoted supplier or rider re-earns approval,
 * and approval never transfers between the supplier and rider kinds.
 */
function syncApprovalCaseWithVerification(store, target, status, actor, reason, { createMissing = true } = {}) {
  const caseStatus = status === "unverified" ? "pending" : status;
  const decisionReason = typeof reason === "string" && reason.trim() ? reason.trim() : null;
  const at = now();
  if (!Array.isArray(store.approvalCases)) store.approvalCases = [];
  if (!Array.isArray(store.approvalCaseEvents)) store.approvalCaseEvents = [];
  let approvalCase = store.approvalCases.find(
    (candidate) => candidate.userId === target.id && candidate.kind === target.role,
  );
  const fromStatus = approvalCase?.status ?? null;
  if (!approvalCase) {
    if (!createMissing) return;
    approvalCase = {
      id: id("apc"),
      userId: target.id,
      kind: target.role,
      status: caseStatus,
      version: 1,
      applicationRevision: 1,
      createdAt: at,
      updatedAt: at,
    };
    store.approvalCases.push(approvalCase);
  }
  approvalCase.status = caseStatus;
  approvalCase.updatedAt = at;
  delete approvalCase.rejectionReason;
  delete approvalCase.suspensionReason;
  if (caseStatus === "pending") {
    delete approvalCase.decidedAt;
    delete approvalCase.decidedBy;
  } else {
    approvalCase.decidedAt = at;
    approvalCase.decidedBy = actor.id;
    if (approvalCase.submittedAt == null) approvalCase.submittedAt = at;
    if (caseStatus === "rejected") {
      approvalCase.rejectionReason = decisionReason || "Verification rejected";
    }
    if (caseStatus === "suspended") {
      approvalCase.suspensionReason = decisionReason || "Verification suspended";
    }
  }
  if (fromStatus !== caseStatus) {
    if (fromStatus !== null) approvalCase.version += 1;
    store.approvalCaseEvents.push({
      id: id("ace"),
      approvalCaseId: approvalCase.id,
      applicationRevision: approvalCase.applicationRevision,
      ...(fromStatus ? { fromStatus } : {}),
      toStatus: caseStatus,
      actorUserId: actor.id,
      actorKind: "approver",
      ...(decisionReason ? { reason: decisionReason } : {}),
      requestId: id("acr"),
      snapshot: {},
      createdAt: at,
    });
  }
}

/** Plausible Davao City zone anchors (real neighbourhoods). Centre ~7.0731, 125.6128. */
const ZONE_COORDS = {
  davao_central: { lat: 7.0865, lng: 125.6135 }, // Bajada / JP Laurel
  davao_south: { lat: 7.0495, lng: 125.5875 }, // Matina Crossing
  davao_north: { lat: 7.1165, lng: 125.6452 }, // Lanang
  davao_west: { lat: 7.0380, lng: 125.5450 }, // Toril side
  davao_east: { lat: 7.0950, lng: 125.6500 }, // Buhangin / Sasa
};

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Deterministic dropoff near the zone so new orders do not stack on one pin. */
function dropoffFor(address, zone) {
  const base = ZONE_COORDS[zone] || { lat: 7.0731, lng: 125.6128 };
  const h = hashString(`${zone}|${address || ""}`);
  const dLat = ((h % 200) - 100) * 0.00003;
  const dLng = ((((h / 200) | 0) % 200) - 100) * 0.00003;
  return {
    lat: Math.round((base.lat + dLat) * 1e6) / 1e6,
    lng: Math.round((base.lng + dLng) * 1e6) / 1e6,
    label: address || zone || "Davao City",
  };
}

/** True when a map point already has usable coordinates (do not overwrite). */
function hasCoords(point) {
  return (
    point != null &&
    typeof point.lat === "number" &&
    typeof point.lng === "number" &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng)
  );
}

/** Pickup from supplier shop; null when no supplier assigned yet. */
function pickupFromSupplier(supplier) {
  if (!supplier?.shop || !hasCoords(supplier.shop)) return null;
  return {
    lat: supplier.shop.lat,
    lng: supplier.shop.lng,
    label: supplier.shop.label || supplier.supplierName || supplier.name,
  };
}

/**
 * The shop that takes over when one declines.
 *
 * Chosen by the same ranking the client set, filtered to shops that can still
 * make the date the client was promised, and never one that would cost more
 * than the job was sold for. Shops that already declined are excluded so a job
 * cannot be handed back and forth.
 *
 * The committed price does not move. A checkout order's money is immutable once
 * placed -- the database enforces it -- and rewriting what a client agreed to
 * because a shop dropped out is the wrong direction to fix this from. So the
 * replacement is paid the price the job was sold at, and the client pays what
 * they were told. A shop that cannot do it for that is simply not a candidate.
 */
function findReplacementShop(store, order, at) {
  const lines = (store.orderLineItems || []).filter((row) => row.orderId === order.id);
  if (lines.length === 0) return null;
  const sourceItem = (store.catalogItems || []).find((row) => row.id === lines[0].sourceCatalogItemId);
  const subcategoryCode = sourceItem?.subcategoryCode;
  if (!subcategoryCode) return null;

  const quantity = lines.reduce((total, row) => total + Number(row.quantity || 0), 0);
  const committedMinor = Number(order.supplierSubtotalMinor || 0);
  const preference = (store.clientPreferences || []).find((row) => row.userId === order.clientId);
  const ranking = preference?.ranking?.length === 4
    ? preference.ranking
    : ["quality", "speed", "cost", "distance"];

  const excluded = [...(order.declinedBy || [])];
  // Bounded: each pass rules out exactly one shop, and a shop is only ruled out
  // once, so this cannot run longer than the number of shops on the platform.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let match;
    try {
      match = matchShop(store, {
        subcategoryCode,
        ranking,
        dropoff: order.dropoff || null,
        excludedSupplierIds: excluded,
        deadline: order.promiseBy || null,
        units: quantity > 0 ? quantity : null,
        now: at,
      });
    } catch (error) {
      if (error instanceof MatchError) return null;
      throw error;
    }
    const cheapest = match.listings
      .map((item) => (Number.isSafeInteger(item.fromPriceMinor) ? item.fromPriceMinor : item.basePriceMinor))
      .filter((value) => Number.isSafeInteger(value));
    const floorMinor = cheapest.length ? Math.min(...cheapest) * Math.max(1, quantity) : null;
    if (floorMinor != null && floorMinor <= committedMinor) {
      const profile = (store.supplierProfiles || []).find((row) => row.userId === match.shop.supplierId);
      return {
        supplierId: match.shop.supplierId,
        pickup: profile?.shop || null,
        readyBy: match.shopReadyBy,
        promiseBy: match.promiseBy,
      };
    }
    excluded.push(match.shop.supplierId);
  }
  return null;
}

function setOrderPickup(order, store) {
  if (!order.supplierId) {
    order.pickup = null;
    return;
  }
  const profile = (store.supplierProfiles || []).find((candidate) => candidate.userId === order.supplierId);
  const supplier = store.users.find((candidate) => candidate.id === order.supplierId);
  order.pickup = profile?.shop ? structuredClone(profile.shop) : pickupFromSupplier(supplier);
}

function supplierTermsFor(store, supplierId) {
  return (store.supplierPaymentTerms || []).find((terms) => terms.supplierId === supplierId) || null;
}

/** Peso, as a person writes it. Minor units in, one figure out. */
function formatMinorPhp(amountMinor) {
  const pesos = Math.trunc(Math.abs(amountMinor) / 100);
  const centavos = String(Math.abs(amountMinor) % 100).padStart(2, "0");
  const sign = amountMinor < 0 ? "-" : "";
  return `${sign}\u20b1${pesos.toLocaleString("en-PH")}.${centavos}`;
}

/** What the shop calls each stage. Never the platform's own code. */
function payoutStageLabel(code) {
  return ({
    printing: "Printing",
    packaging_qc: "Packing and quality check",
    delivered: "Delivered",
    retention: "Retention",
  })[code] || "Payout";
}

function paymentCodeForRoute(code) {
  return ({ downpayment: "initial", balance: "final_online" })[code] || code;
}

// ---------------------------------------------------------------------------
// Default platform data used by route validation and the explicit reference seed.
// ---------------------------------------------------------------------------

function audit(store, { actor, action, entityType, entityId, detail, reason, orderId }) {
  if (!Array.isArray(store.auditLog)) store.auditLog = [];
  const entry = {
    id: id("aud"),
    at: now(),
    actorId: actor?.role === "system" ? null : actor?.id || null,
    actorRole: actor?.role || null,
    action,
    entityType: entityType || null,
    entityId: entityId || null,
    orderId: orderId || null,
    detail: detail || null,
    reason: reason || null,
  };
  store.auditLog.push(entry);
  return entry;
}

/**
 * Whether this is the pickup shape that was never finished.
 *
 * The contained one is a commercial plan: the client pays the shop directly,
 * or pays in full for a counter collection, and nothing was ever built to hand
 * the job over. An order on the order-match plan is collected at GRIDGO Office
 * instead, which a rider delivers to — the same journey as any other order,
 * ending at a different pin.
 */

async function load() {
  return loadStore(database);
}

async function expireElapsedIssueWindows() {
  const candidate = await database.query(`
    SELECT 1
      FROM orders AS candidate
     WHERE candidate.state = 'issue_window_open'
       AND candidate.issue_window_expires_at <= now()
       AND candidate.payout_hold = false
       AND NOT EXISTS (
         SELECT 1 FROM claims
          WHERE claims.order_id = candidate.id
            AND claims.status IN ('open', 'payout_held')
       )
     LIMIT 1
  `);
  if (candidate.rowCount === 0) return;
  await enqueueMutation(async () => {
    const store = await load();
    if (expireIssueWindows(store, now())) await save(store);
  });
}

/*
 Remaining QR balance vs handing the job to a rider.

 A shop-marked ready delivery is a rider offer even when the client's remaining
 installment is still unpaid — that money is owed at the door (or at the office
 counter), not as a condition of leaving the shop. Withholding the offer left a
 packed Business Card job sitting at the printer while Rider showed nothing.

 The remaining balance still gates completing a door delivery and releasing a
 collected job at the counter.
*/
function deliveryBalanceSettled(order) {
  if (carriedToOffice(order)) return true;
  const balance = order?.payments?.final_online;
  if (!balance) return true;
  return balance.status === "confirmed";
}

function syncJobsWithOrder(store, order, at) {
  for (const job of store.orderJobs || []) {
    if (job.orderId !== order.id || job.state === "cancelled") continue;
    job.state = order.state;
    job.riderId = order.riderId ?? null;
    job.updatedAt = at;
  }
}

function canViewOrderLocation(user, order, store) {
  return canAccessOrder(store,user?.id,order,{role:user?.role,location:true});
}

function ordersFor(user, store) {
  return store.orders.filter(order => canAccessOrder(store,user.id,order,{role:user.role,offer:true}));
}

function orderVisible(user, order, store) {
  return ordersFor(user, store).some((o) => o.id === order.id);
}

function attachedReadyOrderFile(store, order, fileId, purpose, ownerId) {
  const file = (store.files || []).find((candidate) => candidate.fileId === fileId);
  if (!file || file.state !== "ready" || file.purpose !== purpose || file.ownerId !== ownerId) return null;
  const referenced = (file.references || []).some(
    (reference) => reference.type === "order" && reference.id === order.id,
  );
  return referenced ? file : null;
}

function publicOrder(order, user, orderStore) {
  return publicOrderFor(order, user, orderStore);
}

function taxonomyCodeSet(taxonomy, kind) {
  const list = taxonomy?.[kind] || [];
  return new Set(list.filter((x) => x.active !== false).map((x) => x.code));
}

/** A category code is valid when it names, or aliases, an active category. */
function activeCategoryFor(taxonomy, code) {
  const category = resolveCategoryCode(taxonomy, code);
  return category && category.active !== false ? category : null;
}

function validateTaxonomyRefs(store, body) {
  const mats = taxonomyCodeSet(store.taxonomy, "materials");
  const fins = taxonomyCodeSet(store.taxonomy, "finishes");
  if (body.categoryCode != null && !activeCategoryFor(store.taxonomy, body.categoryCode)) {
    return { error: "invalid_category_code", code: body.categoryCode };
  }
  if (Array.isArray(body.materialCodes)) {
    for (const c of body.materialCodes) {
      if (!mats.has(c)) return { error: "invalid_material_code", code: c };
    }
  }
  if (Array.isArray(body.finishCodes)) {
    for (const c of body.finishCodes) {
      if (!fins.has(c)) return { error: "invalid_finish_code", code: c };
    }
  }
  const zoneCodes = new Set((store.zones || []).filter((z) => z.active !== false).map((z) => z.code));
  if (Array.isArray(body.zones)) {
    for (const z of body.zones) {
      if (!zoneCodes.has(z)) return { error: "invalid_zone_code", code: z };
    }
  }
  return null;
}

function materialMatches(orderMaterial, materialCodes, taxonomy) {
  if (!orderMaterial) return true; // no constraint on order
  const raw = String(orderMaterial).toLowerCase().trim();
  for (const code of materialCodes || []) {
    const codeSpaced = code.replace(/_/g, " ");
    if (raw.includes(codeSpaced) || raw.includes(code) || code.includes(raw) || codeSpaced.includes(raw)) return true;
    const mat = (taxonomy?.materials || []).find((m) => m.code === code);
    if (mat) {
      const name = String(mat.name).toLowerCase();
      if (raw.includes(name) || name.includes(raw)) return true;
      // token overlap (e.g. "13oz" vs "13oz tarpaulin")
      const tokens = raw.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
      for (const tok of tokens) {
        if (name.includes(tok) || code.includes(tok)) return true;
      }
    }
    // common pilot shorthand
    if (code.includes("tarpaulin") && raw.includes("tarpaulin")) return true;
    if (code.includes("matte") && raw.includes("matte")) return true;
    if (code.includes("vinyl") && raw.includes("vinyl")) return true;
    if (code.includes("gloss") && raw.includes("gloss")) return true;
    if (code.includes("cotton") && raw.includes("cotton")) return true;
  }
  return false;
}

function serviceCoversOrder(service, order, product, taxonomy) {
  if (service.state !== "live") return { ok: false, reason: "service_not_live" };
  const family = product?.family;
  if (family && Array.isArray(service.productFamilyIds) && service.productFamilyIds.length) {
    if (!service.productFamilyIds.includes(family)) {
      return { ok: false, reason: "product_family_mismatch", need: family, have: service.productFamilyIds };
    }
  }
  if (order.zone && Array.isArray(service.zones) && service.zones.length) {
    if (!service.zones.includes(order.zone)) {
      return { ok: false, reason: "zone_mismatch", need: order.zone, have: service.zones };
    }
  }
  if (order.quantity != null) {
    const q = Number(order.quantity);
    if (service.qtyMin != null && q < Number(service.qtyMin)) {
      return { ok: false, reason: "qty_below_min", need: service.qtyMin, have: q };
    }
    if (service.qtyMax != null && q > Number(service.qtyMax)) {
      return { ok: false, reason: "qty_above_max", need: service.qtyMax, have: q };
    }
  }
  if (order.material && !materialMatches(order.material, service.materialCodes, taxonomy)) {
    return { ok: false, reason: "material_mismatch", need: order.material, have: service.materialCodes };
  }
  return { ok: true };
}

function eligibleSuppliersForOrder(store, order) {
  const product = (store.catalog || []).find((p) => p.id === order.productId);
  const suppliers = (store.users || []).filter((u) => hasRole(store, u.id, "supplier"))
    .map((u) => roleDirectoryUser(store, u, "supplier"));
  const results = [];

  for (const supplier of suppliers) {
    const reasons = [];
    if (supplier.verificationStatus !== "approved") {
      results.push({
        supplier: publicUser(supplier),
        eligible: false,
        reasons: [`verification_status:${supplier.verificationStatus || "unverified"}`],
        matchingServiceIds: [],
        services: [],
      });
      continue;
    }
    const services = (store.supplierServices || []).filter((s) => s.supplierId === supplier.id);
    const live = services.filter((s) => s.state === "live");
    if (!live.length) {
      results.push({
        supplier: publicUser(supplier),
        eligible: false,
        reasons: ["no_live_services"],
        matchingServiceIds: [],
        services: services.map(summarizeService),
      });
      continue;
    }
    const matching = [];
    const rejectNotes = [];
    for (const svc of live) {
      const cover = serviceCoversOrder(svc, order, product, store.taxonomy);
      if (cover.ok) matching.push(svc);
      else rejectNotes.push(`${svc.id}:${cover.reason}`);
    }
    if (!matching.length) {
      results.push({
        supplier: publicUser(supplier),
        eligible: false,
        reasons: rejectNotes.length ? rejectNotes : ["no_covering_service"],
        matchingServiceIds: [],
        services: services.map(summarizeService),
      });
      continue;
    }
    results.push({
      supplier: publicUser(supplier),
      eligible: true,
      reasons: [],
      matchingServiceIds: matching.map((s) => s.id),
      services: matching.map(summarizeService),
      rankingInputs: {
        liveServiceCount: live.length,
        matchingServiceCount: matching.length,
        minTurnaroundHours: Math.min(...matching.map((s) => Number(s.turnaroundHours) || 9999)),
        totalCapacityDaily: matching.reduce((a, s) => a + (Number(s.capacityDaily) || 0), 0),
        verificationStatus: supplier.verificationStatus,
      },
    });
  }

  // eligible first, then by turnaround
  results.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    const ta = a.rankingInputs?.minTurnaroundHours ?? 9999;
    const tb = b.rankingInputs?.minTurnaroundHours ?? 9999;
    return ta - tb;
  });
  return { product, candidates: results };
}

function summarizeService(s) {
  return {
    id: s.id,
    supplierId: s.supplierId,
    categoryCode: s.categoryCode,
    materialCodes: s.materialCodes,
    finishCodes: s.finishCodes,
    productFamilyIds: s.productFamilyIds,
    sizeMin: s.sizeMin,
    sizeMax: s.sizeMax,
    qtyMin: s.qtyMin,
    qtyMax: s.qtyMax,
    pricingBasis: s.pricingBasis,
    referenceRateMinor: s.referenceRateMinor,
    turnaroundHours: s.turnaroundHours,
    capacityDaily: s.capacityDaily,
    capacityWeekly: s.capacityWeekly,
    zones: s.zones,
    equipmentNotes: s.equipmentNotes,
    state: s.state,
    verifiedAt: s.verifiedAt,
    suspendedAt: s.suspendedAt,
    suspendReason: s.suspendReason,
    withdrawnAt: s.withdrawnAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    imageFileIds: s.imageFileIds || [],
  };
}

function activePayoutHold(store, orderId) {
  return (store.claims || []).find(
    (c) => c.orderId === orderId && (c.status === "open" || c.status === "payout_held"),
  );
}

function openIssueOnOrder(store, orderId) {
  return (store.issues || []).find((i) => i.orderId === orderId && i.status !== "resolved" && i.status !== "dismissed");
}

/** Simplified PRD state machine: who may trigger which transition. */
const TRANSITIONS = {
  draft: { submitted: ["client"] },
  submitted: { needs_qa: ["ops_admin", "super_admin"] },
  needs_qa: {
    client_correction: ["ops_admin", "super_admin"],
    proof_approval: ["ops_admin", "super_admin"],
    approved_for_matching: ["ops_admin", "super_admin"],
    // A checkout order already knows its shop, so passing quality control hands
    // it straight to that shop. There is nothing left to match.
    supplier_assigned: ["ops_admin", "super_admin"],
    cancelled: ["ops_admin", "super_admin"],
  },
  // A correction keeps the money. The client fixes the artwork and it goes back
  // to the same quality check, rather than starting the order again.
  client_correction: { submitted: ["client"], needs_qa: ["client"], cancelled: ["ops_admin", "super_admin"] },
  initial_payment_review: { cancelled: ["ops_admin", "super_admin"] },
  proof_approval: {
    approved_for_matching: ["client"],
    client_correction: ["client"],
  },
  approved_for_matching: { supplier_assigned: ["ops_admin", "super_admin"] },
  supplier_assigned: {
    supplier_accepted: ["supplier"], // legacy quote path
    approved_for_matching: ["supplier"], // legacy decline -> rematch
    // The shop has nothing to price and nothing to promise: accepting is only
    // confirming it can run the work. Declining is its own route, because it
    // has to find a replacement rather than just step aside.
    payment_authorized: ["supplier"],
    cancelled: ["ops_admin", "super_admin"],
  },
  awaiting_checkout: { awaiting_initial_payment: ["client"], supplier_accepted: ["supplier"] },
  awaiting_initial_payment: { supplier_accepted: ["supplier"] },
  awaiting_downpayment: {},
  downpayment_review: {},
  payment_authorized: { production: ["supplier"] },
  production: { supplier_self_qc: ["supplier"] },
  supplier_self_qc: { ready_for_dispatch: ["supplier"] },
  ready_for_dispatch: { rider_assigned: ["rider", "ops_admin", "super_admin"] },
  rider_assigned: {},
  picked_up: { out_for_delivery: ["rider"] },
  out_for_delivery: {},
  // A collected job waits on our shelf. Only the counter can end it, and only
  // once the client has settled what is left.
  awaiting_collection: { delivered: ["ops_admin", "super_admin"] },
  delivered: { issue_window_open: ["system", "ops_admin", "super_admin", "client", "rider"] },
  issue_window_open: {}, // request-driven expiry completes; no actor may close it early
  completed: { payout_released: ["ops_admin", "super_admin"] },
};

async function handleRequest(req, res) {
  try {
    const requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : null;
    res.gridgoCorsHeaders = { Vary: "Origin" };
    if (requestOrigin && !ALLOWED_ORIGINS.has(requestOrigin)) {
      return send(res, 403, {
        error: "origin_not_allowed",
        message: `Origin ${requestOrigin} is not allowed. Add its exact origin to CORS_ALLOWED_ORIGINS and restart the API.`,
      });
    }
    if (requestOrigin) {
      res.gridgoCorsHeaders = {
        "Access-Control-Allow-Origin": requestOrigin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Last-Event-ID, Idempotency-Key, X-GRIDGO-Role",
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        Vary: "Origin",
      };
    }
    if (req.method === "OPTIONS") return send(res, 204, {});

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/health") {
      const databaseHealth = await database.health();
      return send(res, databaseHealth.status === "available" ? 200 : 503, {
        ok: databaseHealth.status === "available",
        service: "gridgo-api",
        version: 3,
        commit: BUILD_COMMIT,
        builtAt: BUILD_TIME,
        database: databaseHealth,
        storage: objectStorage.health(),
        push: pushDelivery.health(),
        emailConfigured: emailConfigured(process.env),
        at: now(),
      });
    }
    if (await routeSupportDesk({
      req,
      res,
      pathname,
      readBody,
      send,
      database,
      mailer: supportMailer,
    })) {
      return;
    }

    // ---- push registration before there is an account ----
    //
    // An unauthenticated write, and it exists so an
    // "update your app" announcement reaches an install whose owner never
    // signed in — the people most likely to be stuck on a broken build.
    //
    // Anonymous only when the request carries no Authorization header at all.
    // A *stale* bearer token still gets `401`, so an app with an expired
    // session learns to sign in again instead of silently demoting its
    // registration to unclaimed.
    //
    // Every response on this path is a fixed body. It must not disclose whether
    // the token was already known, whether it belongs to somebody, or how many
    // registrations exist: the caller supplies the token, so any variation
    // would answer those questions for whoever asked. `GET /devices` stays
    // authenticated and caller-scoped.
    //
    // Handled before the store load on purpose: these routes read and write
    // only device_tokens through their own targeted transaction, so anonymous
    // callers can neither hold the domain mutation lock nor force full-store
    // work.
    if (!hasBearerToken(req) && req.method === "POST" && pathname === "/devices") {
      const body = await readBody(req);
      const token = normalizeDeviceToken(body.token);
      if (!token) {
        return send(res, 400, {
          error: "device_token_required",
          message: "Send the FCM registration token this device received from Firebase.",
        });
      }
      if (!isFcmTokenShaped(token)) {
        return send(res, 400, {
          error: "invalid_device_token",
          message:
            "This is not an FCM registration token. Send the token Firebase issued to this installation, unmodified.",
        });
      }
      const platform = String(body.platform || "").trim();
      if (!DEVICE_PLATFORMS.includes(platform)) {
        return send(res, 400, {
          error: "invalid_device_platform",
          message: "Choose android, ios, or web for this device registration.",
          allowed: DEVICE_PLATFORMS,
        });
      }
      const result = await enqueueDeviceMutation(async () => {
        const deviceStore = await loadDeviceTokenStore(database);
        const outcome = registerUnclaimedDeviceToken(deviceStore, {
          token,
          platform,
          at: now(),
          limit: MAX_UNCLAIMED_DEVICES,
        });
        if (outcome.changed) await saveDeviceTokenStore(database, deviceStore);
        return outcome;
      });
      if (result.evicted > 0) {
        console.warn(
          `unclaimed device registry at capacity ${MAX_UNCLAIMED_DEVICES}; evicted ${result.evicted} least-recently-seen registration(s)`,
        );
      }
      return send(res, 200, { ok: true });
    }

    if (!hasBearerToken(req) && req.method === "POST" && pathname === "/devices/unregister") {
      const body = await readBody(req);
      const token = normalizeDeviceToken(body.token);
      if (!token) {
        return send(res, 400, {
          error: "device_token_required",
          message: "Send the FCM registration token this device is registered with.",
        });
      }
      // Unclaimed rows only. A claimed registration still requires its owner's
      // bearer token, and the identical response is what stops this from
      // reporting which of the two it was.
      await enqueueDeviceMutation(async () => {
        const deviceStore = await loadDeviceTokenStore(database);
        if (unregisterDeviceToken(deviceStore, { userId: null, token }).changed) {
          await saveDeviceTokenStore(database, deviceStore);
        }
      });
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && pathname === "/webhooks/clerk") {
      let event;
      try {
        event = await verifiedClerkWebhookEvent(req);
      } catch (error) {
        if (error.status === 503 || error.status === 400 || error.status === 413) {
          return send(res, error.status, { error: error.code, message: error.message });
        }
        throw error;
      }
      const store = await load();
      const { mutated } = applyClerkWebhookEvent(store, event);
      if (mutated) await save(store);
      return send(res, 200, { ok: true });
    }

    await expireElapsedIssueWindows();
    const store = await load();

    if (
      (req.method === "GET" || req.method === "HEAD")
      && pathname.startsWith("/public/announcement-images/")
    ) {
      return serveAnnouncementImage(req, res, store, pathname);
    }

    if (
      (req.method === "GET" || req.method === "HEAD")
      && (pathname === PAYMENT_QR_PUBLIC_PATH || pathname === `${PAYMENT_QR_PUBLIC_PATH}.jpg`)
    ) {
      return servePaymentQr(req, res, store);
    }

    // ---- auth ----
    if (req.method === "POST" && ["/auth/login", "/auth/signup"].includes(pathname)) {
      return send(res, 404, { error: "not_found", path: pathname });
    }
    if (req.method === "GET" && pathname === "/auth/me") {
      const auth = await authenticateRequest(req, store);
      if (!auth.user) return send(res, auth.status || 401, authFailureBody(auth));
      let clerkUser = null;
      try {
        clerkUser = await clerkBackend.users.getUser(auth.user.clerkUserId);
      } catch {
        clerkUser = null;
      }
      let user = auth.user;
      if (clerkUser) {
        user = await enqueueMutation(async () => {
          const latest = await load();
          const latestUser = (latest.users || []).find((candidate) => candidate.id === auth.user.id);
          if (!latestUser) return auth.user;
          if (applyClerkIdentityCopy(latest, latestUser, clerkUser).mutated) {
            await save(latest);
          }
          return latestUser;
        });
      }
      const requestedRole = req.headers['x-gridgo-role'];
      if (requestedRole && !EVENT_ROLES.includes(requestedRole)) return send(res,403,{error:'forbidden'});
      // An unenrolled app still receives the identity probe needed to enroll.
      // Once the membership exists, return its compatible user projection.
      if (requestedRole && hasRole(store,user.id,requestedRole)) {
        const approval = (store.approvalCases || []).find(c=>c.userId===user.id&&c.kind===requestedRole);
        const supplierProfile = (store.supplierProfiles || []).find(p=>p.userId===user.id);
        user = {...user,role:requestedRole,...(['supplier','rider'].includes(requestedRole)?{verificationStatus:approval?.status || 'unverified'}:{}),...(requestedRole==='supplier' && supplierProfile?{supplierName:supplierProfile.shopName,shop:supplierProfile.shop}:{})};
      }
      const projected = publicUser(user);
      if ((store.userRoleMemberships || []).some(
        (membership) => membership.userId === user.id && membership.role === "rider",
      )) {
        const profile = riderProfileProjection(store, user.id);
        if (profile) projected.riderProfile = profile;
      }
      return send(res, 200, {
        user: projected,
        memberships: auth.authorization.memberships.map(membershipSummary),
        approvalCases: auth.authorization.approvalCases.map(approvalCaseSummary),
      });
    }

    const fixedAuthRole = FIXED_AUTH_ROLES.get(pathname);
    if (req.method === "GET" && fixedAuthRole) {
      const auth = await authenticateRequest(req, store);
      if (!auth.user) return send(res, auth.status || 401, authFailureBody(auth));
      if (!contextHasMembership(auth.authorization, fixedAuthRole)) {
        if (fixedAuthRole === "supplier") {
          return send(res, 403, {
            error: "supplier_account_not_found",
            message: "This identity has no supplier account. Sign up as a supplier or use another account.",
          });
        }
        return send(res, 403, {
          error: "membership_required",
          message: `This surface requires the ${fixedAuthRole} membership assigned in GRIDGO.`,
          requiredRole: fixedAuthRole,
        });
      }
      return send(res, 200, fixedAuthProjection(store, auth, fixedAuthRole));
    }

    if (req.method === "POST" && pathname === "/auth/clerk/client-available") {
      const body = await readBody(req);
      return send(res, 200, { available: clientEmailAvailable(store, body?.email) });
    }

    if (req.method === "POST" && pathname === "/auth/clerk/activate") {
      const header = req.headers.authorization || "";
      const match = /^Bearer\s+(.+)$/i.exec(header);
      const result = await activateClerkClientProfile({
        token: match?.[1] || null,
        store,
        config: AUTH,
        clerkBackend,
        createId: id,
        now,
        preVerified: req.gridgoVerifiedClaims || null,
        preloadedClerkUser: req.gridgoClerkUser || null,
      });
      if (result.mutated) await save(store);
      if (result.status !== 200) {
        return send(res, result.status, {
          error: result.error,
          message: result.message,
        });
      }
      return send(res, 200, { user: publicUser(result.user) });
    }

    if (req.method === "POST" && [
      "/auth/clerk/enroll/supplier",
      "/auth/clerk/enroll/rider",
    ].includes(pathname)) {
      const claims = req.gridgoVerifiedClaims?.claims;
      if (!claims?.sub) {
        return send(res, 401, {
          error: "unauthorized",
          message: "Sign in with Clerk before submitting this role application.",
        });
      }
      const body = await readBody(req);
      const idempotencyKey = requireIdempotencyKey(req.headers["idempotency-key"]);
      const common = {
        store,
        clerkUserId: claims.sub,
        clerkUser: req.gridgoClerkUser?.clerkUser || null,
        body,
        idempotencyKey,
        createId: id,
        now,
      };
      const role = pathname.endsWith("/supplier") ? "supplier" : "rider";
      const result = role === "supplier" ? enrollSupplier(common) : enrollRider(common);
      if (result.status === 201) await save(store);
      const refreshed = await authenticateRequest(req, store);
      const response = fixedAuthProjection(store, refreshed, role);
      if (role === "supplier") {
        response.supplierServices = (result.supplierServices || []).map(summarizeService);
      }
      return send(res, result.status, response);
    }

    if (req.method === "POST" && pathname === "/me/business-application") {
      const auth = await authenticateRequest(req, store);
      if (!auth.user) {
        return send(res, auth.status || 401, {
          error: "unauthorized",
          message: "Activate ordinary client access before applying for GRIDGO Business.",
        });
      }
      const result = applyForBusiness({
        store,
        user: auth.user,
        body: await readBody(req),
        idempotencyKey: requireIdempotencyKey(req.headers["idempotency-key"]),
        createId: id,
        now,
      });
      if (result.status === 201) await save(store);
      const refreshed = await authenticateRequest(req, store);
      return send(res, result.status, fixedAuthProjection(store, refreshed, "client"));
    }

    if (req.method === "POST" && pathname === "/auth/logout") {
      // Signing out is the moment a phone must stop receiving that person's
      // notifications. Accepting the device token here removes the ordering
      // trap of "unregister first, then log out" — after logout the bearer
      // token is gone and the phone can no longer authenticate an unregister
      // call at all.
      //
      // The registration is *released*, not deleted: it returns to the
      // unclaimed pool so an app-update announcement still reaches the handset.
      // Deleting it would close that channel at exactly the moment the person
      // is most likely to be stuck on a build that made them sign out.
      const body = await readBody(req);
      const deviceToken = normalizeDeviceToken(body?.deviceToken);
      let released = false;
      const auth = await authenticateRequest(req, store);
      if (!auth.user) {
        return send(res, auth.status || 401, { error: auth.status === 403 ? "forbidden" : "unauthorized" });
      }
      if (deviceToken) {
        released = releaseDeviceToken(store, {
          userId: auth.user.id,
          token: deviceToken,
          at: now(),
        }).released;
      }
      if (released) await save(store);
      // `deviceUnregistered` keeps its published meaning — this phone no longer
      // receives the caller's notifications — for app builds already shipped.
      return send(res, 200, { ok: true, deviceUnregistered: released, deviceUnclaimed: released });
    }

    const auth = await authenticateRequest(req, store);
    let user = auth.user;
    // Other routes already use ?role as a directory filter. Only the inbox
    // contract interprets that query as actor context.
    const notificationRoleQuery = ["/notifications", "/notifications/stream", "/notifications/read-all"].includes(pathname)
      ? url.searchParams.get("role") : undefined;
    const eventRole = notificationRoleQuery || req.headers['x-gridgo-role'] || undefined;
    if (user) {
      if (eventRole && (!EVENT_ROLES.includes(eventRole) || !hasRole(store,user.id,eventRole))) return send(res,403,{error:'forbidden'});
      const inferredRole = !eventRole && !isOps(user) && (pathname === '/dispatch/offers' || (req.method === 'POST' && pathname.startsWith('/dispatch'))) && hasRole(store,user.id,'rider') ? 'rider'
        : !eventRole && pathname === '/jobs' && hasRole(store,user.id,'supplier') ? 'supplier' : user.role;
      const selectedRole = eventRole || inferredRole;
      const approval = (store.approvalCases || []).find(c=>c.userId===user.id&&c.kind===selectedRole);
      // Actor projection is never written into users.role. Other legacy user-field
      // writes still target the actual row through this proxy.
      user = new Proxy(user,{get(target,key,receiver){
        if(key==='role')return selectedRole;
        if(key==='verificationStatus' && ['supplier','rider'].includes(selectedRole)) return approval?.status || (target.role===selectedRole?target.verificationStatus:'unverified');
        return Reflect.get(target,key,receiver);
      }});
      const actorContext = resolveAuthorizationContext(store,user);
      if (eventRole) actorContext.memberships = actorContext.memberships.filter(m=>m.role===eventRole);
      if (/^\/(orders|jobs|dispatch|payouts|claims|issues|escalations)(\/|$)/.test(pathname)) {
        if (!hasRole(store,user.id,selectedRole) || (['supplier','rider'].includes(selectedRole) && !approvedRole(store,user.id,selectedRole))) return send(res,403,{error:'forbidden'});
      }
    }

    if (!user
        && /^Bearer\s+.+$/i.test(req.headers.authorization || "")
        && isPublicSupplierCatalogRoute(req.method, pathname)) {
      return send(res, 401, {
        error: "unauthorized",
        message: "Sign in to GRIDGO, then retry this request with the new access token.",
      });
    }

    const privateCatalogRoute = pathname === "/listing-starters"
      || pathname === "/me/supplier-readiness"
      || pathname === "/me/supplier-profile"
      || pathname === "/me/supplier-payment-terms"
      || pathname.startsWith("/me/supplier-services")
      || pathname.startsWith("/me/catalog-items")
      || pathname.startsWith("/me/catalog-option-groups");
    if (!user && (privateCatalogRoute || isPrivateRiderProfileRoute(pathname))) {
      return send(res, 401, {
        error: "unauthorized",
        message: "Sign in to GRIDGO, then retry this request with the new access token.",
      });
    }

    const catalogResponse = await routeSupplierCatalog({
      req,
      url,
      store,
      user,
      readBody,
      id,
      now,
      audit,
    });
    if (catalogResponse) {
      if (catalogResponse.mutated) await save(store);
      if (catalogResponse.status < 400) {
        await decorateCatalogPhotoUrls(store, catalogResponse.body);
      }
      return send(res, catalogResponse.status, catalogResponse.body);
    }

    const riderProfileResponse = await routeRiderProfile({
      req,
      url,
      store,
      user,
      readBody,
      now,
      audit,
    });
    if (riderProfileResponse) {
      if (riderProfileResponse.mutated) await save(store);
      return send(res, riderProfileResponse.status, riderProfileResponse.body);
    }

    const accountProfileResponse = await routeAccountProfile({
      req,
      url,
      store,
      user,
      readBody,
      createId: id,
      now,
      audit,
      publicUser,
    });
    if (accountProfileResponse) {
      if (accountProfileResponse.mutated) await save(store);
      return send(res, accountProfileResponse.status, accountProfileResponse.body);
    }

    // public catalog for demo convenience
    if (req.method === "GET" && pathname === "/catalog") {
      return send(res, 200, { catalog: store.catalog });
    }

    if (!user) {
      if (auth.status === 403) return send(res, 403, { error: "forbidden" });
      return send(res, 401, {
        error: "unauthorized",
        message: "Sign in to GRIDGO, then retry this request with the new access token.",
      });
    }

    const orderMatchResponse = await routeOrderMatch({
      req,
      url,
      store,
      user,
      readBody,
      id,
      now,
    });
    if (orderMatchResponse) {
      if (orderMatchResponse.mutated) await save(store);
      if (orderMatchResponse.status < 400) {
        await decorateCatalogPhotoUrls(store, orderMatchResponse.body);
      }
      return send(res, orderMatchResponse.status, orderMatchResponse.body);
    }

    // ---- shared Operations / Super Admin approval queue ----
    if (req.method === "GET" && pathname === "/approval-cases") {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const result = approvalQueue(store, url);
      const { status: responseStatus, ...body } = result;
      return send(res, responseStatus, body);
    }

    if (req.method === "GET" && /^\/approval-cases\/[^/]+$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const caseId = pathname.split("/")[2];
      const approvalCase = (store.approvalCases || []).find((candidate) => candidate.id === caseId);
      if (!approvalCase) return send(res, 404, { error: "approval_case_not_found" });
      return send(res, 200, approvalCaseDetail(store, approvalCase));
    }

    if (req.method === "POST" && /^\/approval-cases\/[^/]+\/(approve|reject|suspend|restore)$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const [, , caseId, action] = pathname.split("/");
      if (!APPROVAL_DECISIONS.has(action)) return send(res, 404, { error: "not_found", path: pathname });
      const input = approvalDecisionInput(action, await readBody(req));
      if (input.error) {
        return send(res, input.status, { error: input.error, ...(input.details || {}) });
      }

      // Every decision request has already entered the global domain
      // transaction. The row lock makes the optimistic case boundary explicit
      // and remains necessary if the compatibility adapter is later narrowed.
      const locked = await database.query(
        "SELECT id FROM approval_cases WHERE id = $1 FOR UPDATE",
        [caseId],
      );
      if (locked.rowCount === 0) return send(res, 404, { error: "approval_case_not_found" });
      const actorRole = contextHasMembership(auth.authorization, "super_admin")
        ? "super_admin"
        : "ops_admin";
      const outcome = decideApprovalCase({
        store,
        caseId,
        action,
        input,
        actor: user,
        actorRole,
        at: now(),
        createId: id,
      });
      if (!outcome.replayed) {
        queueInvalidate(store, { resource: "approvals", id: outcome.approvalCase.id });
        await save(store);
      }
      return send(res, 200, {
        ...approvalCaseDetail(store, outcome.approvalCase),
        publishedServiceIds: outcome.publishedServiceIds,
        suspendedServiceIds: outcome.suspendedServiceIds,
        replayed: outcome.replayed,
      });
    }

    if (req.method === "POST" && pathname === "/me/approval-cases/rider/submit") {
      const idempotencyKey = requireIdempotencyKey(req.headers["idempotency-key"]);
      const body = await readBody(req);
      const result = submitRiderApplication({
        store,
        user,
        body,
        idempotencyKey,
        createId: id,
        now,
      });
      if (!result.replay) await save(store);
      return send(res, 200, { approvalCase: approvalCaseSummary(result.approvalCase) });
    }

    const reapplyMatch = /^\/me\/approval-cases\/(business-client|supplier|rider)\/reapply$/.exec(pathname);
    if (req.method === "POST" && reapplyMatch) {
      const result = reapplyForApproval({
        store,
        user,
        pathKind: reapplyMatch[1],
        body: await readBody(req),
        idempotencyKey: requireIdempotencyKey(req.headers["idempotency-key"]),
        createId: id,
        now,
      });
      if (!result.replay) await save(store);
      return send(res, result.status, { approvalCase: approvalCaseSummary(result.approvalCase) });
    }

    const needsInitializedStorage =
      (req.method === "POST" && pathname === "/files") ||
      (req.method === "POST" && /^\/files\/[^/]+\/attach$/.test(pathname)) ||
      (req.method === "GET" && /^\/files\/[^/]+\/download-url$/.test(pathname)) ||
      (req.method === "DELETE" && /^\/files\/[^/]+$/.test(pathname));
    if (storageInitializing && needsInitializedStorage) {
      throw new AttachmentError(
        503,
        "storage_initializing",
        "MinIO file recovery is still finishing. Wait a moment, then try the file action again.",
      );
    }

    // ---- private files: streamed upload control plane + presigned MinIO download plane ----
    if (req.method === "POST" && pathname === "/files") {
      req.setTimeout(Number(process.env.UPLOAD_REQUEST_TIMEOUT_MS || 15 * 60 * 1000));
      const { fields, file } = await parseMultipartStream(req, req.headers["content-type"], {
        tempDir: path.join(ROOT, ".tmp", "uploads"),
      });
      try {
        const unexpectedFields = Object.keys(fields).filter((name) => name !== "purpose");
        if (unexpectedFields.length) {
          throw new AttachmentError(
            400,
            "unexpected_form_field",
            `Remove the unsupported upload form field: ${unexpectedFields[0]}. Send only \`purpose\` and \`file\`.`,
            { field: unexpectedFields[0] },
          );
        }
        const purpose = String(fields.purpose || "");
        authorizeFileUpload(user, purpose);
        const detectedContentType = validateUpload(file, purpose);
        const fileId = id("file");
        const createdAt = now();
        const datePath = createdAt.slice(0, 10).replaceAll("-", "/");
        const extension = path.extname(file.originalFilename).toLowerCase();
        const objectKey = `${purpose}/${datePath}/${fileId}${extension}`;
        // Read before the bytes leave for storage: this is the one moment the
        // file is on local disk, and re-downloading it later to measure it
        // would cost a round trip per upload.
        const detected = await readArtworkMeasurements(file, detectedContentType, purpose);
        const pending = createPendingFile({
          fileId,
          objectKey,
          user,
          purpose,
          file,
          detectedContentType,
          detected,
          at: createdAt,
        });

        await enqueueMutation(async () => {
          const latestStore = await load();
          const latestUser = (await authenticateRequest(req, latestStore)).user;
          if (!latestUser) {
            throw new AttachmentError(401, "unauthorized", "Your sign-in expired. Sign in and upload the file again.");
          }
          authorizeFileUpload(latestUser, purpose);
          latestStore.files.push(pending);
          await save(latestStore);
        });

        try {
          await objectStorage.ensureBucket();
          await objectStorage.putObject({
            key: objectKey,
            body: fs.createReadStream(file.tempPath),
            contentType: detectedContentType,
            size: file.size,
          });
        } catch (error) {
          await compensatePendingFile(fileId, objectKey);
          throw error;
        }
        try {
          const ready = await enqueueMutation(async () => {
            const latestStore = await load();
            const latestUser = (await authenticateRequest(req, latestStore)).user;
            const latestFile = findFile(latestStore, fileId);
            if (!latestUser || latestUser.id !== pending.ownerId || !latestFile) {
              throw new AttachmentError(
                401,
                "unauthorized",
                "Your sign-in expired while the file was uploading. Sign in and upload the file again.",
              );
            }
            markFileReady(latestFile, now());
            await save(latestStore);
            return latestFile;
          });
          // A fileId is the readiness signal and is returned only after PutObject and ready metadata both persist.
          return send(res, 201, { file: publicFile(ready) });
        } catch (error) {
          await compensatePendingFile(fileId, objectKey);
          throw error;
        }
      } finally {
        await fs.promises.unlink(file.tempPath).catch(() => {});
      }
    }

    if (req.method === "GET" && /^\/files\/[^/]+$/.test(pathname)) {
      const file = findFile(store, pathname.split("/")[2]);
      authorizeFileRead(user, store, file);
      return send(res, 200, { file: publicFile(file) });
    }

    if (req.method === "GET" && /^\/files\/[^/]+\/download-url$/.test(pathname)) {
      const file = findFile(store, pathname.split("/")[2]);
      authorizeFileRead(user, store, file);
      const stat = await objectStorage.statObject(file.objectKey);
      if (stat.size !== file.size) {
        throw new AttachmentError(
          409,
          "storage_object_mismatch",
          "The stored object size does not match its file record. Upload the file again before using it.",
        );
      }
      const signed = await objectStorage.presignGet(file.objectKey);
      return send(res, 200, { fileId: file.fileId, ...signed });
    }

    if (req.method === "POST" && /^\/files\/[^/]+\/attach$/.test(pathname)) {
      const fileId = pathname.split("/")[2];
      const body = await readBody(req);
      const file = findFile(store, fileId);
      authorizeFileAttachOwner(user, file);
      const target = resolveFileTarget(store, file.purpose, body, user);
      authorizeFileAttach(user, file, target);
      const stat = await objectStorage.statObject(file.objectKey);
      if (stat.size !== file.size) {
        throw new AttachmentError(
          409,
          "storage_object_mismatch",
          "The stored object size does not match its file record. Upload the file again before attaching it.",
        );
      }
      return await enqueueMutation(async () => {
        const latestStore = await load();
        const latestUser = (await authenticateRequest(req, latestStore)).user;
        if (!latestUser) {
          throw new AttachmentError(401, "unauthorized", "Your sign-in expired. Sign in and attach the file again.");
        }
        const latestFile = findFile(latestStore, fileId);
        authorizeFileAttachOwner(latestUser, latestFile);
        const latestTarget = resolveFileTarget(latestStore, latestFile.purpose, body, latestUser);
        authorizeFileAttach(latestUser, latestFile, latestTarget);
        if (latestTarget.type === "supplier_catalog_item") {
          const attached = attachCatalogItemPhoto(latestStore, latestFile, latestTarget, { at: now() });
          await save(latestStore);
          const item = privateCatalogItem(latestStore, attached.item);
          await decorateCatalogPhotoUrls(latestStore, { item });
          return send(res, 200, { file: publicFile(latestFile), item });
        }
        if (latestTarget.type === "supplier_shop_media") {
          const attached = attachSupplierShopImage(latestStore, latestFile, latestTarget, { at: now() });
          await save(latestStore);
          return send(res, 200, {
            file: publicFile(latestFile),
            profile: attached.profile,
            media: attached.media,
          });
        }
        if (latestTarget.type === "rider_document") {
          const attachedAt = now();
          const attached = attachRiderDocument(latestStore, latestFile, latestTarget, {
            documentId: id("rdoc"),
            at: attachedAt,
          });
          await save(latestStore);
          return send(res, 200, {
            file: publicFile(latestFile),
            riderDocument: {
              id: attached.document.id,
              kind: attached.document.kind,
              fileId: attached.document.fileId,
              expiresOn: attached.document.expiresOn ?? null,
              uploadedAt: attached.document.uploadedAt,
            },
            approvalCase: approvalCaseSummary(attached.approvalCase),
          });
        }
        attachFileReference(latestFile, latestTarget);
        const attachedAt = now();
        latestTarget.record.updatedAt = attachedAt;
        if (latestTarget.type === "order") {
          if (latestFile.purpose === "artwork") latestTarget.record.artworkName = latestFile.originalFilename;
          if (latestFile.purpose === "fulfilment_proof") {
            latestTarget.record.timeline.push({
              at: attachedAt,
              state: latestTarget.record.state,
              by: latestUser.id,
              note: `Proof of Fulfilment attached for ${latestTarget.milestoneCode}`,
              fileId: latestFile.fileId,
              milestoneCode: latestTarget.milestoneCode,
            });
          }
          await save(latestStore);
          return send(res, 200, { file: publicFile(latestFile), order: publicOrder(latestTarget.record, latestUser, latestStore) });
        }
        if (latestTarget.type === "user") {
          await save(latestStore);
          return send(res, 200, {
            file: publicFile(latestFile),
            ...verificationUserResponse(latestStore, latestTarget.record),
          });
        }
        await save(latestStore);
        return send(res, 200, { file: publicFile(latestFile), supplierService: summarizeService(latestTarget.record) });
      });
    }

    if (req.method === "DELETE" && /^\/files\/[^/]+$/.test(pathname)) {
      const fileId = pathname.split("/")[2];
      const pending = await enqueueMutation(async () => {
        const latestStore = await load();
        const latestUser = (await authenticateRequest(req, latestStore)).user;
        if (!latestUser) throw new AttachmentError(401, "unauthorized", "Sign in and request the deletion again.");
        const latestFile = findFile(latestStore, fileId);
        const alreadyDeleted = latestFile?.state === "deleted";
        const deleteRequestedAt = now();
        markFileDeletePending(latestFile, latestUser, deleteRequestedAt);
        invalidateRiderDocumentsForFile(latestStore, latestFile, deleteRequestedAt);
        await save(latestStore);
        return { alreadyDeleted, file: latestFile, objectKey: latestFile.objectKey };
      });
      if (pending.alreadyDeleted) return send(res, 200, { file: publicFile(pending.file) });
      await objectStorage.deleteObject(pending.objectKey);
      const deleted = await enqueueMutation(async () => {
        const latestStore = await load();
        const latestFile = findFile(latestStore, fileId);
        markFileDeleted(latestFile, now());
        await save(latestStore);
        return latestFile;
      });
      return send(res, 200, { file: publicFile(deleted) });
    }

    // ---- push device registrations ----
    //
    // Ownership is established exactly as it is for /notifications: the bearer
    // token names the caller, and a caller only ever sees or edits records
    // whose userId is their own. There is no second rule and no ops override —
    // nothing on the platform needs to read another person's device tokens.
    //
    // Registering an already-unclaimed token here claims it for the caller: one
    // row, now owned. Unclaimed rows never appear in `GET /devices` — they
    // belong to nobody, so they are nobody's to list.
    if (req.method === "GET" && pathname === "/devices") {
      return send(res, 200, { devices: deviceTokensFor(store, user.id).map(publicDevice) });
    }

    if (req.method === "POST" && pathname === "/devices") {
      const body = await readBody(req);
      const token = normalizeDeviceToken(body.token);
      if (!token) {
        return send(res, 400, {
          error: "device_token_required",
          message: "Send the FCM registration token this device received from Firebase.",
        });
      }
      if (token.length > 4096) {
        return send(res, 400, {
          error: "device_token_too_long",
          message: "An FCM registration token is far shorter than this. Send the token Firebase issued, unmodified.",
        });
      }
      const platform = String(body.platform || "").trim();
      if (!DEVICE_PLATFORMS.includes(platform)) {
        return send(res, 400, {
          error: "invalid_device_platform",
          message: "Choose android, ios, or web for this device registration.",
          allowed: DEVICE_PLATFORMS,
        });
      }
      const appRole = body.appRole || null;
      if (appRole && (!EVENT_ROLES.includes(appRole) || !hasRole(store,user.id,appRole))) return send(res,403,{error:'forbidden'});
      const tokenProvider = body.tokenProvider || (platform === 'ios' ? 'apns' : 'fcm');
      if (!['fcm','apns'].includes(tokenProvider) || (tokenProvider === 'apns' && platform !== 'ios')) return send(res,400,{error:'invalid_token_provider'});
      const { device, created, reassignedFrom } = registerDeviceToken(store, {
        userId: user.id,
        token,
        platform,
        appRole, tokenProvider,
        at: now(),
      });
      await save(store);
      return send(res, created ? 201 : 200, {
        device: publicDevice(device),
        created,
        // A shared handset or a re-login moves the token; the response says so
        // rather than leaving the app to guess whether it now owns the phone.
        reassigned: reassignedFrom !== null,
      });
    }

    if (req.method === "POST" && pathname === "/devices/unregister") {
      const body = await readBody(req);
      const token = normalizeDeviceToken(body.token);
      if (!token) {
        return send(res, 400, {
          error: "device_token_required",
          message: "Send the FCM registration token this device is registered with.",
        });
      }
      const { removed } = unregisterDeviceToken(store, { userId: user.id, token });
      if (!removed) {
        return send(res, 404, {
          error: "device_token_not_found",
          message: "This device token is not registered to your account. Nothing was changed.",
        });
      }
      await save(store);
      return send(res, 200, { id: removed.id, unregistered: true });
    }

    // ---- notifications ----
    if (req.method === "GET" && pathname === "/notifications/stream") {
      const lastEventId = String(req.headers["last-event-id"] || "").trim();
      let resumeIndex = -1;
      if (lastEventId) {
        resumeIndex = store.notifications.findIndex((notification) => notification.id === lastEventId);
        if (resumeIndex === -1) {
          return send(res, 409, { error: "notification_resume_unavailable" });
        }
        if (store.notifications[resumeIndex].userId !== user.id) {
          return send(res, 403, { error: "forbidden" });
        }
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...(res.gridgoCorsHeaders || {}),
      });
      res.flushHeaders();
      res.write("retry: 5000\n\n");

      const writeNotification = (notification, committedStore = store) => {
        if (notification.push === false || !notificationVisible(committedStore, notification, user.id, eventRole)) return;
        res.write(formatNotificationEvent(notification, orderFromNotification(committedStore, notification)));
      };
      const unsubscribe = notificationEvents.subscribe(user.id, writeNotification);
      const unsubscribeInvalidate = notificationEvents.subscribeInvalidate(user.id, (payload, committedStore = store) => {
        if (eventRole && !hasRole(committedStore,user.id,eventRole) && payload.resource !== 'identity') return;
        if (payload.resource === 'location' && payload.id && !canAccessOrder(committedStore,user.id,(committedStore.orders || []).find(o=>o.id===payload.id),{role:eventRole,location:true})) return;
        res.write(formatInvalidateEvent(payload));
      });
      for (let index = resumeIndex + 1; index < store.notifications.length; index += 1) {
        const notification = store.notifications[index];
        if (notification.userId === user.id && notification.deletedAt == null) {
          writeNotification(notification);
        }
      }

      const heartbeat = setInterval(() => {
        if (req.gridgoVerifiedClaims?.claims?.exp && Date.now() >= req.gridgoVerifiedClaims.claims.exp * 1000) { res.end(); return; }
        res.write(`: heartbeat ${now()}\n\n`);
      }, NOTIFICATION_HEARTBEAT_MS);
      heartbeat.unref();
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribeInvalidate();
      };
      req.once("aborted", cleanup);
      res.once("close", cleanup);
      return;
    }

    if (req.method === "GET" && pathname === "/notifications") {
      return send(res, 200, listInbox(store, user.id, { limit: url.searchParams.get("limit"), role:eventRole }));
    }

    if (req.method === "PATCH" && pathname === "/notifications/read-all") {
      const body = await readBody(req);
      if (typeof body.snapshot !== "string" || !body.snapshot) {
        return send(res, 400, { error: "notification_snapshot_required" });
      }
      const snapshotIndex = store.notifications.findIndex((notification) => notification.id === body.snapshot);
      if (snapshotIndex === -1) return send(res, 404, { error: "notification_not_found" });
      if (store.notifications[snapshotIndex].userId !== user.id) {
        return send(res, 403, { error: "forbidden" });
      }
      let updatedCount = 0;
      for (let index = 0; index <= snapshotIndex; index += 1) {
        const notification = store.notifications[index];
        if (!notificationVisible(store,notification,user.id,eventRole) || notification.read) continue;
        notification.read = true;
        updatedCount += 1;
      }
      if (updatedCount) await save(store);
      return send(res, 200, { updatedCount });
    }

    if (req.method === "PATCH" && /^\/notifications\/[^/]+$/.test(pathname)) {
      const notificationId = pathname.split("/")[2];
      const notification = store.notifications.find((candidate) => candidate.id === notificationId);
      if (!notification) return send(res, 404, { error: "notification_not_found" });
      if (notification.userId !== user.id) return send(res, 403, { error: "forbidden" });
      if (!notificationVisible(store, { ...notification, deletedAt: null }, user.id, eventRole)) {
        return send(res, 403, { error: "forbidden" });
      }
      if (notification.deletedAt != null) return send(res, 404, { error: "notification_not_found" });
      const body = await readBody(req);
      if (typeof body.read !== "boolean") {
        return send(res, 400, { error: "notification_read_required" });
      }
      notification.read = body.read;
      await save(store);
      return send(res, 200, { notification: publicNotification(notification, orderFromNotification(store, notification)) });
    }

    if (req.method === "DELETE" && /^\/notifications\/[^/]+$/.test(pathname)) {
      const notificationId = pathname.split("/")[2];
      const notification = store.notifications.find((candidate) => candidate.id === notificationId);
      if (!notification) return send(res, 404, { error: "notification_not_found" });
      if (notification.userId !== user.id) return send(res, 403, { error: "forbidden" });
      if (!notificationVisible(store, { ...notification, deletedAt: null }, user.id, eventRole)) {
        return send(res, 403, { error: "forbidden" });
      }
      if (notification.deletedAt == null) {
        notification.deletedAt = now();
        await save(store);
      }
      return send(res, 200, { id: notification.id, deletedAt: notification.deletedAt });
    }

    // ---- platform announcements ----
    //
    // One general message to a whole audience. `everyone` is the app-update
    // channel: it writes a notification for every account (which pushes to
    // their claimed devices through `save()`) *and* pushes to every unclaimed
    // handset, which is the only way to reach an install that never signed in.
    //
    // An announcement is deliberately not a way to say something personal to a
    // crowd. Nothing order-, money- or person-specific belongs in one, because
    // for `everyone` the same words land on handsets nobody has signed in on.
    if (req.method === "POST" && pathname === "/announcements") {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const audience = String(body.audience || "").trim();
      if (!ANNOUNCEMENT_AUDIENCES.has(audience)) {
        return send(res, 400, {
          error: "invalid_announcement_audience",
          message: "Choose everyone, clients, suppliers, riders, or ops for this announcement.",
          allowed: [...ANNOUNCEMENT_AUDIENCES.keys()],
        });
      }
      const title = String(body.title || "").trim();
      const text = String(body.body || "").trim();
      if (!title || title.length > ANNOUNCEMENT_TITLE_MAX) {
        return send(res, 400, {
          error: "invalid_announcement_title",
          message: `Enter an announcement title of 1 to ${ANNOUNCEMENT_TITLE_MAX} characters.`,
        });
      }
      if (!text || text.length > ANNOUNCEMENT_BODY_MAX) {
        return send(res, 400, {
          error: "invalid_announcement_body",
          message: `Enter announcement text of 1 to ${ANNOUNCEMENT_BODY_MAX} characters.`,
        });
      }
      const image = normalizeAnnouncementImageUrl(body.imageUrl);
      if (image.error) {
        return send(res, 400, {
          error: "invalid_announcement_image",
          message: "Attach a JPEG, PNG or WebP, or paste an http(s) picture link. Nothing was sent.",
        });
      }
      const imageUrl = image.imageUrl;

      const roles = ANNOUNCEMENT_AUDIENCES.get(audience);
      const recipients = store.users.filter((candidate) => roles === null || roles.some(role=>hasRole(store,candidate.id,role)));
      const announcementId = id("anc");
      const at = now();
      for (const recipient of recipients) {
        store.notifications.push({
          id: id("ntf"),
          userId: recipient.id,
          type: "announcement",
          ...(roles ? {audienceRoles:roles} : {}),
          orderId: null,
          announcementId,
          title,
          body: text,
          ...(imageUrl ? { imageUrl } : {}),
          read: false,
          at,
        });
      }
      // Read before `save()`, which is where the per-account pushes fire; the
      // records themselves carry no identity, so the anonymous fan-out below
      // can use them after the write.
      const unclaimed = audience === "everyone" ? unclaimedDeviceTokens(store) : [];
      audit(store, {
        actor: user,
        action: "announcement.broadcast",
        entityType: "announcement",
        entityId: announcementId,
        detail: {
          audience,
          title,
          notifiedUsers: recipients.length,
          unclaimedDevices: unclaimed.length,
          hasImage: Boolean(imageUrl),
        },
        reason: body.reason || null,
      });
      await save(store);
      database.afterCommit(() => deliverAnnouncementPush(unclaimed, { title, body: text, imageUrl }));
      return send(res, 201, {
        announcement: {
          id: announcementId,
          audience,
          title,
          body: text,
          imageUrl,
          at,
          notifiedUsers: recipients.length,
          unclaimedDevices: unclaimed.length,
        },
      });
    }

    // ---- global operational settings ----
    if (req.method === "GET" && pathname === "/settings") {
      return send(res, 200, {
        version: store.version,
        settings: publicOperationalSettings(store.settings || defaultOperationalSettings(), store),
      });
    }

    if (req.method === "PATCH" && pathname === "/settings") {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      if (!Number.isInteger(body.expectedVersion) || body.expectedVersion !== store.version) {
        return send(res, 409, { error: "settings_version_conflict", version: store.version });
      }
      const reason = String(body.reason || "").trim();
      if (!reason) return send(res, 400, { error: "settings_reason_required" });
      const next = {
        ...store.settings,
        serviceFeeRateBps: body.serviceFeeRateBps ?? store.settings.serviceFeeRateBps,
        issueWindowHours: body.issueWindowHours ?? store.settings.issueWindowHours,
        deliveryFeeBands: body.deliveryFeeBands ?? store.settings.deliveryFeeBands,
      };
      validateOperationalSettings(next);
      next.deliveryFeeBands = next.deliveryFeeBands.map((band) => ({
        maxDistanceMeters: band.maxDistanceMeters,
        feeMinor: band.feeMinor,
      }));
      const previous = structuredClone(store.settings);
      store.settings = structuredClone(next);
      store.version += 1;
      audit(store, {
        actor: user,
        action: "settings.operational_update",
        entityType: "settings",
        entityId: "operational",
        detail: { previous, current: store.settings },
        reason,
      });
      await save(store);
      return send(res, 200, { version: store.version, settings: publicOperationalSettings(store.settings, store) });
    }

    if (req.method === "POST" && pathname === "/settings/payment-qr") {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const reason = String(body.reason || "").trim();
      if (!reason) return send(res, 400, { error: "settings_reason_required" });
      const fileId = String(body.fileId || "").trim();
      const file = findFile(store, fileId);
      if (
        !file
        || file.purpose !== "payment_qr"
        || file.state !== "ready"
        || file.deletedAt
        || file.deleteRequestedAt
        || !file.objectKey
      ) {
        return send(res, 400, {
          error: "invalid_payment_qr",
          message: "Upload a JPEG, PNG or WebP with purpose payment_qr, then activate that file as the platform QR.",
        });
      }
      if (!store.settings) store.settings = defaultOperationalSettings();
      const previousId = store.settings.paymentQrFileId || null;
      if (previousId === file.fileId) {
        return send(res, 200, {
          version: store.version,
          settings: publicOperationalSettings(store.settings, store),
        });
      }
      const previous = previousId ? findFile(store, previousId) : null;
      store.settings = { ...store.settings, paymentQrFileId: file.fileId };
      store.version += 1;
      if (previous && previous.state === "ready" && !previous.deletedAt && !previous.deleteRequestedAt) {
        markFileDeletePending(previous, user, now());
      }
      audit(store, {
        actor: user,
        action: "settings.payment_qr_replace",
        entityType: "settings",
        entityId: "payment_qr",
        detail: { previousFileId: previousId, fileId: file.fileId },
        reason,
      });
      await save(store);
      return send(res, 200, {
        version: store.version,
        settings: publicOperationalSettings(store.settings, store),
      });
    }

    // ---- supplier payment timing terms ----
    if (req.method === "GET" && pathname === "/supplier-payment-terms") {
      const supplierId = isOps(user) ? (url.searchParams.get("supplierId") || user.id) : user.id;
      if (user.role !== "supplier" && !isOps(user)) return send(res, 403, { error: "forbidden" });
      const terms = supplierTermsFor(store, supplierId);
      if (!terms) return send(res, 404, { error: "supplier_payment_terms_not_found" });
      return send(res, 200, { terms });
    }

    if (req.method === "PATCH" && pathname === "/supplier-payment-terms") {
      if (user.role !== "supplier") return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const terms = supplierTermsFor(store, user.id);
      if (!terms) return send(res, 409, { error: "supplier_profile_required" });
      const next = {
        ...terms,
        deliveryDownpaymentRateBps: body.deliveryDownpaymentRateBps ?? terms.deliveryDownpaymentRateBps,
        pickupFullOnlineEnabled: body.pickupFullOnlineEnabled ?? terms.pickupFullOnlineEnabled,
        pickupDownpaymentStoreEnabled: body.pickupDownpaymentStoreEnabled ?? terms.pickupDownpaymentStoreEnabled,
        pickupDownpaymentRateBps: body.pickupDownpaymentStoreEnabled === false
          ? null
          : (body.pickupDownpaymentRateBps ?? terms.pickupDownpaymentRateBps),
      };
      if (![0, 2_500, 5_000].includes(next.deliveryDownpaymentRateBps)) {
        return send(res, 400, { error: "invalid_delivery_downpayment_rate" });
      }
      if (typeof next.pickupFullOnlineEnabled !== "boolean" || typeof next.pickupDownpaymentStoreEnabled !== "boolean") {
        return send(res, 400, { error: "invalid_pickup_payment_mode" });
      }
      if (next.pickupDownpaymentStoreEnabled !== [2_500, 5_000].includes(next.pickupDownpaymentRateBps)) {
        return send(res, 400, { error: "invalid_pickup_downpayment_rate" });
      }
      const profile = (store.supplierProfiles || []).find((candidate) => candidate.userId === user.id);
      if (profile?.pickupAvailable && !next.pickupFullOnlineEnabled && !next.pickupDownpaymentStoreEnabled) {
        return send(res, 400, { error: "pickup_payment_mode_required" });
      }
      next.updatedAt = now();
      Object.assign(terms, next);
      audit(store, {
        actor: user,
        action: "supplier_payment_terms.update",
        entityType: "supplier_payment_terms",
        entityId: user.id,
        detail: { current: terms },
      });
      await save(store);
      return send(res, 200, { terms });
    }

    // ---- credits ----
    if (req.method === "GET" && pathname === "/credits/balance") {
      if (user.role !== "client" && user.role !== "ops_admin" && user.role !== "super_admin") {
        return send(res, 403, { error: "forbidden" });
      }
      const clientId = url.searchParams.get("clientId") || user.id;
      // clients may only read their own balance
      if (user.role === "client" && clientId !== user.id) {
        return send(res, 403, { error: "forbidden" });
      }
      const acct = store.credits[clientId] || { balanceMinor: 0, ledger: [] };
      return send(res, 200, { clientId, balanceMinor: acct.balanceMinor, ledger: acct.ledger });
    }

    if (req.method === "POST" && pathname === "/credits/authorize") {
      return send(res, 410, {
        error: "payment_route_retired",
        message: "Order payments use the installment plan snapshotted at final checkout. Refresh the order and submit its required online payment.",
      });
    }

    // Super Admin grants Pilot Credits (not a purchase; non-cash, non-transferable)
    if (req.method === "POST" && pathname === "/credits/grant") {
      if (!isSuper(user)) return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const clientId = body.clientId;
      const amountMinor = Number(body.amountMinor);
      if (!clientId || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
        return send(res, 400, { error: "invalid_grant", need: "clientId, amountMinor > 0" });
      }
      const client = store.users.find((u) => u.id === clientId);
      if (!client || client.role !== "client") return send(res, 404, { error: "client_not_found" });
      const acct = store.credits[clientId] || { balanceMinor: 0, ledger: [] };
      acct.balanceMinor += amountMinor;
      const entry = {
        id: id("led"),
        type: "grant",
        amountMinor,
        balanceAfterMinor: acct.balanceMinor,
        reason: body.reason || "Pilot Credits grant",
        orderId: null,
        at: now(),
        actorId: user.id,
      };
      acct.ledger.push(entry);
      store.credits[clientId] = acct;
      audit(store, {
        actor: user,
        action: "credits.grant",
        entityType: "credits",
        entityId: clientId,
        detail: { amountMinor, balanceAfterMinor: acct.balanceMinor },
        reason: entry.reason,
      });
      await save(store);
      return send(res, 200, { clientId, balanceMinor: acct.balanceMinor, entry, ledger: acct.ledger });
    }

    // ---- users directory ----
    if (req.method === "GET" && pathname === "/users") {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const role = url.searchParams.get("role");
      const list = role
        ? store.users.filter((u) => hasRole(store, u.id, role)).map((u) => publicUser(roleDirectoryUser(store, u, role)))
        : store.users.map(publicUser);
      return send(res, 200, { users: list });
    }

    if (req.method === "GET" && /^\/users\/[^/]+$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const uid = pathname.split("/")[2];
      const target = store.users.find((u) => u.id === uid);
      if (!target) return send(res, 404, { error: "user_not_found" });
      return send(res, 200, verificationUserResponse(store, target));
    }

    if (req.method === "GET" && /^\/users\/[^/]+\/verification-documents$/.test(pathname)) {
      const uid = pathname.split("/")[2];
      const target = store.users.find((candidate) => candidate.id === uid);
      if (!target) {
        return send(res, 404, {
          error: "user_not_found",
          message: "That supplier account no longer exists. Refresh the account list and try again.",
        });
      }
      const ownsSupplierProfile = user.role === "supplier" && user.id === target.id;
      if (!isOps(user) && !ownsSupplierProfile) {
        return send(res, 403, {
          error: "forbidden",
          message: "Verification documents are private. Open your own supplier documents or ask Operations for access.",
        });
      }
      if (target.role !== "supplier") {
        return send(res, 400, {
          error: "verification_documents_require_supplier",
          message: "Verification documents apply only to supplier accounts. Choose a supplier profile.",
        });
      }
      return send(res, 200, {
        userId: target.id,
        verificationDocuments: verificationDocumentsFor(store, target),
      });
    }

    // Supplier shop correction. Orders retain their pickup and money snapshots.
    if (req.method === "PATCH" && /^\/users\/[^/]+\/shop$/.test(pathname)) {
      const uid = pathname.split("/")[2];
      const target = store.users.find((candidate) => candidate.id === uid);
      if (!target) {
        return send(res, 404, {
          error: "user_not_found",
          message: "That supplier account no longer exists. Refresh the account list and try again.",
        });
      }
      const ownsSupplierProfile = user.role === "supplier" && user.id === target.id;
      if (!isOps(user) && !ownsSupplierProfile) {
        return send(res, 403, {
          error: "forbidden",
          message: "You can move only your own supplier shop pin. Open your supplier profile and try again.",
        });
      }
      if (target.role !== "supplier") {
        return send(res, 400, {
          error: "shop_requires_supplier",
          message: "Shop pins apply only to supplier accounts. Choose a supplier profile.",
        });
      }
      const body = await readBody(req);
      const validation = validatedShop(body.shop);
      if (!validation.shop) return send(res, 400, validation);
      const profile = (store.supplierProfiles || []).find((candidate) => candidate.userId === target.id);
      const previousShop = profile?.shop
        ? structuredClone(profile.shop)
        : (target.shop ? structuredClone(target.shop) : null);
      const updatedAt = now();
      target.shop = structuredClone(validation.shop);
      target.shopUpdatedAt = updatedAt;
      target.updatedAt = updatedAt;
      if (profile) {
        profile.shop = structuredClone(validation.shop);
        profile.updatedAt = updatedAt;
      }
      audit(store, {
        actor: user,
        action: "user.shop_update",
        entityType: "user",
        entityId: target.id,
        detail: { from: previousShop, to: target.shop, existingOrdersRepriced: false },
      });
      await save(store);
      return send(res, 200, { user: publicUser(target) });
    }

    // Super Admin role change
    if (req.method === "PATCH" && /^\/users\/[^/]+\/role$/.test(pathname)) {
      if (!isSuper(user)) return send(res, 403, { error: "forbidden" });
      const uid = pathname.split("/")[2];
      const target = store.users.find((u) => u.id === uid);
      if (!target) return send(res, 404, { error: "user_not_found" });
      const body = await readBody(req);
      const allowedRoles = ["client", "supplier", "rider", "ops_admin", "super_admin"];
      if (!allowedRoles.includes(body.role)) {
        return send(res, 400, { error: "invalid_role", allowed: allowedRoles });
      }
      const prev = target.role;
      const requestedMembership = (store.userRoleMemberships || []).find(
        (membership) => membership.userId === target.id && membership.role === body.role,
      );
      if (prev === body.role && requestedMembership) {
        return send(res, 200, { user: publicUser(target) });
      }
      // Administrator bootstrap closes permanently after first use, so losing
      // the final super_admin would lock role management until manual SQL.
      if (
        prev === "super_admin"
        && body.role !== "super_admin"
        && !store.userRoleMemberships.some(
          (membership) => membership.role === "super_admin" && membership.userId !== target.id,
        )
      ) {
        return send(res, 409, {
          error: "last_super_admin",
          message: "GRIDGO must keep at least one Super Admin. Promote another user to super_admin before changing this account's role.",
        });
      }
      if (prev !== body.role) {
        store.userRoleMemberships = store.userRoleMemberships.filter(
          (membership) => !(membership.userId === target.id && membership.role === prev),
        );
      }
      if (!requestedMembership) {
        store.userRoleMemberships.push({
          userId: target.id,
          role: body.role,
          createdAt: now(),
          createdBy: user.id,
        });
      }
      target.role = body.role;
      if (body.role === "client") {
        target.accountType = resolveClientAccountType(target);
      } else {
        delete target.accountType;
        delete target.orgName;
      }
      if (["supplier", "rider"].includes(body.role) && (prev !== body.role || target.verificationStatus == null)) {
        target.verificationStatus = "unverified";
        delete target.verificationNote;
        delete target.verifiedAt;
        delete target.verifiedBy;
        syncApprovalCaseWithVerification(store, target, "unverified", user, null, { createMissing: false });
      }
      if (body.role === "supplier" && !Array.isArray(target.verificationDocumentFileIds)) {
        target.verificationDocumentFileIds = [];
      }
      if (body.role !== "supplier") {
        delete target.shop;
        delete target.shopUpdatedAt;
        delete target.supplierName;
        delete target.categoryRanks;
        delete target.verificationDocumentFileIds;
      }
      if (body.role !== "rider") delete target.riderProfile;
      if (!["supplier", "rider"].includes(body.role)) {
        delete target.verificationStatus;
        delete target.verificationNote;
        delete target.verifiedAt;
        delete target.verifiedBy;
      }
      audit(store, {
        actor: user,
        action: "user.role_change",
        entityType: "user",
        entityId: target.id,
        detail: { from: prev, to: body.role },
        reason: body.reason || null,
      });
      await save(store);
      return send(res, 200, verificationUserResponse(store, target));
    }

    // Supplier / rider verification (ops + super)
    if (req.method === "POST" && /^\/users\/[^/]+\/verification$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const uid = pathname.split("/")[2];
      const target = store.users.find((u) => u.id === uid);
      if (!target) return send(res, 404, { error: "user_not_found" });
      if (target.role !== "supplier" && target.role !== "rider") {
        return send(res, 400, { error: "not_verifiable_role", role: target.role });
      }
      const body = await readBody(req);
      const allowed = ["unverified", "pending", "approved", "suspended", "rejected"];
      if (!allowed.includes(body.status)) {
        return send(res, 400, { error: "invalid_verification_status", allowed });
      }
      const prev = target.verificationStatus || "unverified";
      if (target.role === "rider" && body.status === "approved") {
        assertRiderLegacyVerificationReady(store, target.id, now());
      }
      syncApprovalCaseWithVerification(store, target, body.status, user, body.reason || body.note || null);
      target.verificationStatus = body.status;
      target.verificationNote = body.reason || body.note || null;
      if (body.status === "approved") {
        target.verifiedAt = now();
        target.verifiedBy = user.id;
      }
      if (body.status === "suspended" || body.status === "rejected") {
        // suspend all live services for suppliers (new matching only; in-flight orders kept)
        if (target.role === "supplier") {
          for (const svc of store.supplierServices || []) {
            if (svc.supplierId === target.id && svc.state === "live") {
              svc.state = "suspended";
              svc.suspendedAt = now();
              svc.suspendedBy = user.id;
              svc.suspendReason = body.reason || "supplier_verification_suspended";
              svc.updatedAt = now();
            }
          }
        }
      }
      audit(store, {
        actor: user,
        action: "user.verification",
        entityType: "user",
        entityId: target.id,
        detail: { from: prev, to: body.status },
        reason: body.reason || body.note || null,
      });
      await save(store);
      return send(res, 200, verificationUserResponse(store, target));
    }

    // ---- zones ----
    if (req.method === "GET" && pathname === "/zones") {
      return send(res, 200, { zones: store.zones || [] });
    }

    if (req.method === "POST" && pathname === "/zones") {
      if (!isSuper(user)) return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      if (!body.code || !body.name) return send(res, 400, { error: "invalid_zone", need: "code, name" });
      if ((store.zones || []).some((z) => z.code === body.code)) {
        return send(res, 409, { error: "zone_code_exists", code: body.code });
      }
      const zone = {
        id: id("zone"),
        code: String(body.code),
        name: String(body.name),
        active: body.active !== false,
      };
      store.zones.push(zone);
      audit(store, { actor: user, action: "zone.create", entityType: "zone", entityId: zone.id, detail: zone });
      await save(store);
      return send(res, 201, { zone });
    }

    if (req.method === "PATCH" && /^\/zones\/[^/]+$/.test(pathname)) {
      if (!isSuper(user)) return send(res, 403, { error: "forbidden" });
      const zid = pathname.split("/")[2];
      const zone = (store.zones || []).find((z) => z.id === zid || z.code === zid);
      if (!zone) return send(res, 404, { error: "zone_not_found" });
      const body = await readBody(req);
      if (body.name != null) zone.name = String(body.name);
      if (body.active != null) zone.active = Boolean(body.active);
      // code is stable identity for orders; allow rename only if unused, else ignore code change
      if (body.code != null && body.code !== zone.code) {
        if ((store.zones || []).some((z) => z.code === body.code && z.id !== zone.id)) {
          return send(res, 409, { error: "zone_code_exists", code: body.code });
        }
        zone.code = String(body.code);
      }
      audit(store, { actor: user, action: "zone.update", entityType: "zone", entityId: zone.id, detail: zone });
      await save(store);
      return send(res, 200, { zone });
    }

    // ---- taxonomy ----
    if (req.method === "GET" && pathname === "/taxonomy") {
      // categoryTree is derived per request from the flat collections; it is a
      // convenience projection for pickers and is never persisted.
      return send(res, 200, { taxonomy: store.taxonomy, categoryTree: buildCategoryTree(store.taxonomy) });
    }

    if (req.method === "POST" && pathname === "/taxonomy/categories") {
      if (!isSuper(user)) return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      if (!body.code || !body.name) return send(res, 400, { error: "invalid_category", need: "code, name" });
      if (store.taxonomy.categories.some((c) => c.code === body.code)) {
        return send(res, 409, { error: "code_exists", code: body.code });
      }
      if ((store.taxonomy.categoryAliases || []).some((a) => a.code === body.code)) {
        return send(res, 409, { error: "code_is_alias", code: body.code });
      }
      const item = {
        id: id("taxc"),
        code: String(body.code),
        name: String(body.name),
        bestFor: body.bestFor != null ? String(body.bestFor) : null,
        sortOrder: body.sortOrder != null ? Number(body.sortOrder) : store.taxonomy.categories.length + 1,
        productFamilyIds: Array.isArray(body.productFamilyIds) ? body.productFamilyIds : [],
        active: body.active !== false,
      };
      store.taxonomy.categories.push(item);
      audit(store, { actor: user, action: "taxonomy.category_create", entityType: "taxonomy_category", entityId: item.id, detail: item });
      await save(store);
      return send(res, 201, { category: item });
    }

    if (req.method === "PATCH" && /^\/taxonomy\/categories\/[^/]+$/.test(pathname)) {
      if (!isSuper(user)) return send(res, 403, { error: "forbidden" });
      const cid = pathname.split("/")[3];
      const item = store.taxonomy.categories.find((c) => c.id === cid || c.code === cid);
      if (!item) return send(res, 404, { error: "category_not_found" });
      const body = await readBody(req);
      if (body.name != null) item.name = String(body.name);
      if (body.bestFor != null) item.bestFor = String(body.bestFor);
      if (body.sortOrder != null) item.sortOrder = Number(body.sortOrder);
      if (body.productFamilyIds != null) item.productFamilyIds = body.productFamilyIds;
      if (body.active != null) item.active = Boolean(body.active);
      audit(store, { actor: user, action: "taxonomy.category_update", entityType: "taxonomy_category", entityId: item.id, detail: item });
      await save(store);
      return send(res, 200, { category: item });
    }

    if (req.method === "POST" && pathname === "/taxonomy/subcategories") {
      if (!isSuper(user)) return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      if (!body.code || !body.name || !body.categoryCode) {
        return send(res, 400, { error: "invalid_subcategory", need: "code, name, categoryCode" });
      }
      if (store.taxonomy.subcategories.some((s) => s.code === body.code)) {
        return send(res, 409, { error: "code_exists", code: body.code });
      }
      // Accept a retired legacy code but always store the canonical category code.
      const parent = activeCategoryFor(store.taxonomy, body.categoryCode);
      if (!parent) return send(res, 400, { error: "invalid_category_code", code: body.categoryCode });
      const siblings = store.taxonomy.subcategories.filter((s) => s.categoryCode === parent.code);
      const item = {
        id: id("taxs"),
        code: String(body.code),
        name: String(body.name),
        categoryCode: parent.code,
        examples: Array.isArray(body.examples) ? body.examples.map((e) => String(e)) : [],
        sortOrder: body.sortOrder != null ? Number(body.sortOrder) : siblings.length + 1,
        active: body.active !== false,
      };
      store.taxonomy.subcategories.push(item);
      audit(store, { actor: user, action: "taxonomy.subcategory_create", entityType: "taxonomy_subcategory", entityId: item.id, detail: item });
      await save(store);
      return send(res, 201, { subcategory: item });
    }

    if (req.method === "PATCH" && /^\/taxonomy\/subcategories\/[^/]+$/.test(pathname)) {
      if (!isSuper(user)) return send(res, 403, { error: "forbidden" });
      const sid = pathname.split("/")[3];
      const item = store.taxonomy.subcategories.find((s) => s.id === sid || s.code === sid);
      if (!item) return send(res, 404, { error: "subcategory_not_found" });
      const body = await readBody(req);
      if (body.categoryCode != null) {
        const parent = activeCategoryFor(store.taxonomy, body.categoryCode);
        if (!parent) return send(res, 400, { error: "invalid_category_code", code: body.categoryCode });
        item.categoryCode = parent.code;
      }
      if (body.name != null) item.name = String(body.name);
      if (body.examples != null) item.examples = Array.isArray(body.examples) ? body.examples.map((e) => String(e)) : [];
      if (body.sortOrder != null) item.sortOrder = Number(body.sortOrder);
      if (body.active != null) item.active = Boolean(body.active);
      audit(store, { actor: user, action: "taxonomy.subcategory_update", entityType: "taxonomy_subcategory", entityId: item.id, detail: item });
      await save(store);
      return send(res, 200, { subcategory: item });
    }

    if (req.method === "POST" && pathname === "/taxonomy/materials") {
      if (!isSuper(user)) return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      if (!body.code || !body.name) return send(res, 400, { error: "invalid_material", need: "code, name" });
      if (store.taxonomy.materials.some((m) => m.code === body.code)) {
        return send(res, 409, { error: "code_exists", code: body.code });
      }
      const item = {
        id: id("taxm"),
        code: String(body.code),
        name: String(body.name),
        categoryCodes: Array.isArray(body.categoryCodes) ? body.categoryCodes : [],
        active: body.active !== false,
      };
      store.taxonomy.materials.push(item);
      audit(store, { actor: user, action: "taxonomy.material_create", entityType: "taxonomy_material", entityId: item.id, detail: item });
      await save(store);
      return send(res, 201, { material: item });
    }

    if (req.method === "PATCH" && /^\/taxonomy\/materials\/[^/]+$/.test(pathname)) {
      if (!isSuper(user)) return send(res, 403, { error: "forbidden" });
      const mid = pathname.split("/")[3];
      const item = store.taxonomy.materials.find((m) => m.id === mid || m.code === mid);
      if (!item) return send(res, 404, { error: "material_not_found" });
      const body = await readBody(req);
      if (body.name != null) item.name = String(body.name);
      if (body.categoryCodes != null) item.categoryCodes = body.categoryCodes;
      if (body.active != null) item.active = Boolean(body.active);
      audit(store, { actor: user, action: "taxonomy.material_update", entityType: "taxonomy_material", entityId: item.id, detail: item });
      await save(store);
      return send(res, 200, { material: item });
    }

    if (req.method === "POST" && pathname === "/taxonomy/finishes") {
      if (!isSuper(user)) return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      if (!body.code || !body.name) return send(res, 400, { error: "invalid_finish", need: "code, name" });
      if (store.taxonomy.finishes.some((f) => f.code === body.code)) {
        return send(res, 409, { error: "code_exists", code: body.code });
      }
      const item = {
        id: id("taxf"),
        code: String(body.code),
        name: String(body.name),
        categoryCodes: Array.isArray(body.categoryCodes) ? body.categoryCodes : [],
        active: body.active !== false,
      };
      store.taxonomy.finishes.push(item);
      audit(store, { actor: user, action: "taxonomy.finish_create", entityType: "taxonomy_finish", entityId: item.id, detail: item });
      await save(store);
      return send(res, 201, { finish: item });
    }

    if (req.method === "PATCH" && /^\/taxonomy\/finishes\/[^/]+$/.test(pathname)) {
      if (!isSuper(user)) return send(res, 403, { error: "forbidden" });
      const fid = pathname.split("/")[3];
      const item = store.taxonomy.finishes.find((f) => f.id === fid || f.code === fid);
      if (!item) return send(res, 404, { error: "finish_not_found" });
      const body = await readBody(req);
      if (body.name != null) item.name = String(body.name);
      if (body.categoryCodes != null) item.categoryCodes = body.categoryCodes;
      if (body.active != null) item.active = Boolean(body.active);
      audit(store, { actor: user, action: "taxonomy.finish_update", entityType: "taxonomy_finish", entityId: item.id, detail: item });
      await save(store);
      return send(res, 200, { finish: item });
    }

    // ---- supplier services ----
    if (req.method === "GET" && pathname === "/supplier-services") {
      const supplierIdParam = url.searchParams.get("supplierId");
      const stateParam = url.searchParams.get("state");
      let list = store.supplierServices || [];

      if (user.role === "supplier") {
        list = list.filter((s) => s.supplierId === user.id);
      } else if (isOps(user)) {
        if (supplierIdParam) list = list.filter((s) => s.supplierId === supplierIdParam);
      } else {
        return send(res, 403, { error: "forbidden" });
      }
      if (stateParam) list = list.filter((s) => s.state === stateParam);
      return send(res, 200, { services: list.map(summarizeService) });
    }

    if (req.method === "POST" && pathname === "/supplier-services") {
      if (user.role !== "supplier") return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      if (!body.categoryCode) return send(res, 400, { error: "invalid_service", need: "categoryCode" });
      const bad = validateTaxonomyRefs(store, body);
      if (bad) return send(res, 400, bad);
      const referenceRateMinor = body.referenceRateMinor != null ? Number(body.referenceRateMinor) : 0;
      const turnaroundHours = body.turnaroundHours != null ? Number(body.turnaroundHours) : 48;
      if (!Number.isSafeInteger(referenceRateMinor) || referenceRateMinor < 0 || !Number.isSafeInteger(turnaroundHours) || turnaroundHours <= 0) {
        return send(res, 400, {
          error: "invalid_service",
          message: "referenceRateMinor must be a non-negative integer and turnaroundHours must be a positive integer.",
        });
      }
      const ts = now();
      const service = {
        id: id("svc"),
        supplierId: user.id,
        categoryCode: body.categoryCode,
        materialCodes: Array.isArray(body.materialCodes) ? body.materialCodes : [],
        finishCodes: Array.isArray(body.finishCodes) ? body.finishCodes : [],
        productFamilyIds: Array.isArray(body.productFamilyIds) ? body.productFamilyIds : [],
        sizeMin: body.sizeMin ?? null,
        sizeMax: body.sizeMax ?? null,
        qtyMin: body.qtyMin != null ? Number(body.qtyMin) : null,
        qtyMax: body.qtyMax != null ? Number(body.qtyMax) : null,
        pricingBasis: body.pricingBasis || "per_unit",
        referenceRateMinor,
        turnaroundHours,
        capacityDaily: body.capacityDaily != null ? Number(body.capacityDaily) : null,
        capacityWeekly: body.capacityWeekly != null ? Number(body.capacityWeekly) : null,
        zones: Array.isArray(body.zones) ? body.zones : [],
        equipmentNotes: body.equipmentNotes || "",
        state: "draft",
        verifiedAt: null,
        verifiedBy: null,
        suspendedAt: null,
        suspendedBy: null,
        suspendReason: null,
        withdrawnAt: null,
        imageFileIds: [],
        createdAt: ts,
        updatedAt: ts,
      };
      store.supplierServices.push(service);
      audit(store, {
        actor: user,
        action: "supplier_service.create",
        entityType: "supplier_service",
        entityId: service.id,
        detail: { categoryCode: service.categoryCode, state: service.state },
      });
      await save(store);
      return send(res, 201, { service: summarizeService(service) });
    }

    if (req.method === "GET" && /^\/supplier-services\/[^/]+$/.test(pathname)) {
      const sid = pathname.split("/")[2];
      const service = (store.supplierServices || []).find((s) => s.id === sid);
      if (!service) return send(res, 404, { error: "service_not_found" });
      if (user.role === "supplier" && service.supplierId !== user.id) {
        return send(res, 403, { error: "forbidden" });
      }
      if (user.role !== "supplier" && !isOps(user)) {
        return send(res, 403, { error: "forbidden" });
      }
      return send(res, 200, { service: summarizeService(service) });
    }

    if (req.method === "PATCH" && /^\/supplier-services\/[^/]+$/.test(pathname)) {
      const sid = pathname.split("/")[2];
      const service = (store.supplierServices || []).find((s) => s.id === sid);
      if (!service) return send(res, 404, { error: "service_not_found" });

      // suppliers edit own; ops may only use dedicated suspend/verify endpoints for state
      if (user.role === "supplier") {
        if (service.supplierId !== user.id) return send(res, 403, { error: "forbidden" });
        if (service.state === "withdrawn") return send(res, 409, { error: "service_withdrawn" });
      } else if (!isOps(user)) {
        return send(res, 403, { error: "forbidden" });
      }

      const body = await readBody(req);
      // Suppliers cannot invent taxonomy codes
      const checkBody = {
        categoryCode: body.categoryCode,
        materialCodes: body.materialCodes,
        finishCodes: body.finishCodes,
        zones: body.zones,
      };
      // only validate fields present
      const toValidate = {};
      if (body.categoryCode != null) toValidate.categoryCode = body.categoryCode;
      if (body.materialCodes != null) toValidate.materialCodes = body.materialCodes;
      if (body.finishCodes != null) toValidate.finishCodes = body.finishCodes;
      if (body.zones != null) toValidate.zones = body.zones;
      const bad = validateTaxonomyRefs(store, toValidate);
      if (bad) return send(res, 400, bad);
      const referenceRateMinor = body.referenceRateMinor == null ? null : Number(body.referenceRateMinor);
      const turnaroundHours = body.turnaroundHours == null ? null : Number(body.turnaroundHours);
      if (
        (referenceRateMinor != null && (!Number.isSafeInteger(referenceRateMinor) || referenceRateMinor < 0)) ||
        (turnaroundHours != null && (!Number.isSafeInteger(turnaroundHours) || turnaroundHours <= 0))
      ) {
        return send(res, 400, {
          error: "invalid_service",
          message: "referenceRateMinor must be a non-negative integer and turnaroundHours must be a positive integer.",
        });
      }

      const paramKeys = [
        "sizeMin",
        "sizeMax",
        "qtyMin",
        "qtyMax",
        "pricingBasis",
        "referenceRateMinor",
        "turnaroundHours",
        "capacityDaily",
        "capacityWeekly",
        "equipmentNotes",
      ];
      const prevCategory = service.categoryCode;
      const prevMaterials = [...(service.materialCodes || [])];

      if (user.role === "supplier") {
        if (body.categoryCode != null) service.categoryCode = body.categoryCode;
        if (body.materialCodes != null) service.materialCodes = body.materialCodes;
        if (body.finishCodes != null) service.finishCodes = body.finishCodes;
        if (body.productFamilyIds != null) service.productFamilyIds = body.productFamilyIds;
        if (body.zones != null) service.zones = body.zones;
        for (const k of paramKeys) {
          if (body[k] != null) {
            if (["qtyMin", "qtyMax", "referenceRateMinor", "turnaroundHours", "capacityDaily", "capacityWeekly"].includes(k)) {
              service[k] = Number(body[k]);
            } else {
              service[k] = body[k];
            }
          }
        }
        // Capability expansion on a live service requires re-verification
        const categoryChanged = body.categoryCode != null && body.categoryCode !== prevCategory;
        const materialsExpanded =
          Array.isArray(body.materialCodes) &&
          body.materialCodes.some((c) => !prevMaterials.includes(c));
        if (service.state === "live" && (categoryChanged || materialsExpanded)) {
          service.state = "pending_verification";
          service.verifiedAt = null;
          service.verifiedBy = null;
        }
        // Routine param edits on live stay live (blueprint: within verified envelope)
      } else if (isOps(user)) {
        // ops can annotate notes fields only via PATCH; state changes use action routes
        if (body.equipmentNotes != null) service.equipmentNotes = body.equipmentNotes;
      }

      service.updatedAt = now();
      audit(store, {
        actor: user,
        action: "supplier_service.update",
        entityType: "supplier_service",
        entityId: service.id,
        detail: { state: service.state },
      });
      await save(store);
      return send(res, 200, { service: summarizeService(service) });
    }

    if (req.method === "POST" && /^\/supplier-services\/[^/]+\/submit$/.test(pathname)) {
      if (user.role !== "supplier") return send(res, 403, { error: "forbidden" });
      const sid = pathname.split("/")[2];
      const service = (store.supplierServices || []).find((s) => s.id === sid);
      if (!service) return send(res, 404, { error: "service_not_found" });
      if (service.supplierId !== user.id) return send(res, 403, { error: "forbidden" });
      if (!["draft", "suspended", "withdrawn"].includes(service.state) && service.state !== "pending_verification") {
        // allow re-submit from draft or after suspension (reactivate path uses submit after draft-like)
      }
      if (service.state === "live") return send(res, 409, { error: "already_live" });
      if (service.state === "withdrawn") {
        // re-activation after withdraw needs verification
        service.withdrawnAt = null;
      }
      if (service.state === "suspended") {
        // re-activation after suspension requires verification (blueprint)
        service.suspendedAt = null;
        service.suspendedBy = null;
        service.suspendReason = null;
      }
      service.state = "pending_verification";
      service.updatedAt = now();
      audit(store, {
        actor: user,
        action: "supplier_service.submit",
        entityType: "supplier_service",
        entityId: service.id,
      });
      await save(store);
      return send(res, 200, { service: summarizeService(service) });
    }

    if (req.method === "POST" && /^\/supplier-services\/[^/]+\/verify$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const sid = pathname.split("/")[2];
      const service = (store.supplierServices || []).find((s) => s.id === sid);
      if (!service) return send(res, 404, { error: "service_not_found" });
      const owner = store.users.find((u) => u.id === service.supplierId);
      if (!owner || !approvedRole(store, owner.id, "supplier")) {
        const approval = (store.approvalCases || []).find((c) => c.userId === owner?.id && c.kind === "supplier");
        return send(res, 409, { error: "supplier_not_approved", verificationStatus: approval?.status || owner?.verificationStatus || null });
      }
      if (service.state === "withdrawn") return send(res, 409, { error: "service_withdrawn" });
      const body = await readBody(req);
      service.state = "live";
      service.verifiedAt = now();
      service.verifiedBy = user.id;
      service.suspendedAt = null;
      service.suspendedBy = null;
      service.suspendReason = null;
      delete service.approvalSuspensionPreviousState;
      delete service.approvalSuspensionCaseId;
      service.updatedAt = now();
      audit(store, {
        actor: user,
        action: "supplier_service.verify",
        entityType: "supplier_service",
        entityId: service.id,
        reason: body.reason || null,
      });
      await save(store);
      return send(res, 200, { service: summarizeService(service) });
    }

    if (req.method === "POST" && /^\/supplier-services\/[^/]+\/suspend$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const sid = pathname.split("/")[2];
      const service = (store.supplierServices || []).find((s) => s.id === sid);
      if (!service) return send(res, 404, { error: "service_not_found" });
      const body = await readBody(req);
      if (!body.reason) return send(res, 400, { error: "reason_required" });
      service.state = "suspended";
      service.suspendedAt = now();
      service.suspendedBy = user.id;
      service.suspendReason = body.reason;
      service.updatedAt = now();
      audit(store, {
        actor: user,
        action: "supplier_service.suspend",
        entityType: "supplier_service",
        entityId: service.id,
        reason: body.reason,
      });
      await save(store);
      return send(res, 200, { service: summarizeService(service) });
    }

    if (req.method === "POST" && /^\/supplier-services\/[^/]+\/withdraw$/.test(pathname)) {
      if (user.role !== "supplier") return send(res, 403, { error: "forbidden" });
      const sid = pathname.split("/")[2];
      const service = (store.supplierServices || []).find((s) => s.id === sid);
      if (!service) return send(res, 404, { error: "service_not_found" });
      if (service.supplierId !== user.id) return send(res, 403, { error: "forbidden" });
      // Withdrawal never cancels in-flight orders — only removes from new matching
      service.state = "withdrawn";
      service.withdrawnAt = now();
      service.updatedAt = now();
      audit(store, {
        actor: user,
        action: "supplier_service.withdraw",
        entityType: "supplier_service",
        entityId: service.id,
      });
      await save(store);
      return send(res, 200, { service: summarizeService(service) });
    }

    // ---- matching support ----
    if (req.method === "GET" && /^\/orders\/[^/]+\/eligible-suppliers$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((o) => o.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const result = eligibleSuppliersForOrder(store, order);
      return send(res, 200, {
        orderId: order.id,
        orderState: order.state,
        productId: order.productId,
        productFamily: result.product?.family || null,
        zone: order.zone,
        material: order.material || null,
        quantity: order.quantity,
        candidates: result.candidates,
      });
    }

    // ---- claims ----
    if (req.method === "GET" && pathname === "/claims") {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      let list = store.claims || [];
      const orderId = url.searchParams.get("orderId");
      const status = url.searchParams.get("status");
      if (orderId) list = list.filter((c) => c.orderId === orderId);
      if (status) list = list.filter((c) => c.status === status);
      list = [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return send(res, 200, { claims: list });
    }

    if (req.method === "POST" && pathname === "/claims") {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      if (!body.orderId || !body.reason) {
        return send(res, 400, { error: "invalid_claim", need: "orderId, reason" });
      }
      const order = store.orders.find((o) => o.id === body.orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const ts = now();
      const claim = {
        id: id("clm"),
        orderId: order.id,
        raisedBy: user.id,
        reason: body.reason,
        status: body.hold === false ? "open" : "payout_held",
        holdReason: body.hold === false ? null : body.reason,
        releaseReason: null,
        heldAt: body.hold === false ? null : ts,
        heldBy: body.hold === false ? null : user.id,
        releasedAt: null,
        releasedBy: null,
        createdAt: ts,
        updatedAt: ts,
        issueId: null,
        timeline: [{ at: ts, action: body.hold === false ? "raised" : "raised_and_held", by: user.id, note: body.reason }],
      };
      store.claims.push(claim);
      order.payoutHold = claim.status === "payout_held";
      order.updatedAt = ts;
      order.timeline.push({
        at: ts,
        state: order.state,
        by: user.id,
        note: claim.status === "payout_held" ? `Claim raised; payout held: ${body.reason}` : `Claim raised: ${body.reason}`,
      });
      audit(store, {
        actor: user,
        action: "claim.raise",
        entityType: "claim",
        entityId: claim.id,
        orderId: order.id,
        reason: body.reason,
        detail: { status: claim.status },
      });
      if (claim.status === "payout_held") {
        notifyShopPayoutHeld(store, order, { createId: id, at: ts });
      }
      queueOrderInvalidate(store, order, ["payouts", "orders"]);
      queueInvalidate(store, { resource: "claims", id: claim.id, supplierId: order.supplierId });
      await save(store);
      return send(res, 201, { claim });
    }

    if (req.method === "GET" && /^\/claims\/[^/]+$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const cid = pathname.split("/")[2];
      const claim = (store.claims || []).find((c) => c.id === cid);
      if (!claim) return send(res, 404, { error: "claim_not_found" });
      return send(res, 200, { claim });
    }

    if (req.method === "POST" && /^\/claims\/[^/]+\/hold$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const cid = pathname.split("/")[2];
      const claim = (store.claims || []).find((c) => c.id === cid);
      if (!claim) return send(res, 404, { error: "claim_not_found" });
      const body = await readBody(req);
      if (!body.reason) return send(res, 400, { error: "reason_required" });
      if (claim.status === "released" || claim.status === "resolved") {
        return send(res, 409, { error: "claim_closed", status: claim.status });
      }
      const ts = now();
      claim.status = "payout_held";
      claim.holdReason = body.reason;
      claim.heldAt = ts;
      claim.heldBy = user.id;
      claim.updatedAt = ts;
      claim.timeline.push({ at: ts, action: "hold", by: user.id, note: body.reason });
      const order = store.orders.find((o) => o.id === claim.orderId);
      if (order) {
        order.payoutHold = true;
        order.updatedAt = ts;
        order.timeline.push({ at: ts, state: order.state, by: user.id, note: `Payout held: ${body.reason}` });
      }
      audit(store, {
        actor: user,
        action: "claim.hold",
        entityType: "claim",
        entityId: claim.id,
        orderId: claim.orderId,
        reason: body.reason,
      });
      if (order) notifyShopPayoutHeld(store, order, { createId: id, at: ts });
      queueInvalidate(store, { resource: "payouts", id: claim.orderId, supplierId: order?.supplierId });
      queueInvalidate(store, { resource: "claims", id: claim.id, supplierId: order?.supplierId });
      await save(store);
      return send(res, 200, { claim });
    }

    if (req.method === "POST" && /^\/claims\/[^/]+\/release$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const cid = pathname.split("/")[2];
      const claim = (store.claims || []).find((c) => c.id === cid);
      if (!claim) return send(res, 404, { error: "claim_not_found" });
      const body = await readBody(req);
      if (!body.reason) return send(res, 400, { error: "reason_required" });
      const ts = now();
      claim.status = "released";
      claim.releaseReason = body.reason;
      claim.releasedAt = ts;
      claim.releasedBy = user.id;
      claim.updatedAt = ts;
      claim.timeline.push({ at: ts, action: "release", by: user.id, note: body.reason });
      const order = store.orders.find((o) => o.id === claim.orderId);
      if (order) {
        // clear hold only if no other active hold claims
        const other = (store.claims || []).some(
          (c) => c.id !== claim.id && c.orderId === order.id && (c.status === "open" || c.status === "payout_held"),
        );
        order.payoutHold = other;
        order.updatedAt = ts;
        order.timeline.push({ at: ts, state: order.state, by: user.id, note: `Payout hold released: ${body.reason}` });
      }
      audit(store, {
        actor: user,
        action: "claim.release",
        entityType: "claim",
        entityId: claim.id,
        orderId: claim.orderId,
        reason: body.reason,
      });
      queueInvalidate(store, { resource: "payouts", id: claim.orderId, supplierId: order?.supplierId });
      queueInvalidate(store, { resource: "claims", id: claim.id, supplierId: order?.supplierId });
      await save(store);
      return send(res, 200, { claim });
    }

    // ---- issues (global configurable window) ----
    if (req.method === "GET" && pathname === "/issues") {
      let list = store.issues || [];
      if (user.role === "client") {
        list = list.filter((i) => i.clientId === user.id);
      } else if (user.role === "supplier") {
        // suppliers see issues on their orders only
        const myOrderIds = new Set((store.orders || []).filter((o) => o.supplierId === user.id).map((o) => o.id));
        list = list.filter((i) => myOrderIds.has(i.orderId));
      } else if (!isOps(user)) {
        return send(res, 403, { error: "forbidden" });
      }
      const orderId = url.searchParams.get("orderId");
      const status = url.searchParams.get("status");
      if (orderId) list = list.filter((i) => i.orderId === orderId);
      if (status) list = list.filter((i) => i.status === status);
      list = [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return send(res, 200, { issues: list });
    }

    /**
     * What the client thought of the work.
     *
     * Three scores, because they are three different experiences and an order
     * that came out beautifully a day late should be able to say so. Only the
     * quality star reaches matching: speed is measured from whether the shop hit
     * its own date, and marking a shop down for a price printed on its listing
     * would count the same thing twice.
     *
     * Asked once the order is finished and the issue window has closed, so a
     * rating is never a bargaining chip in an open dispute.
     */
    if (req.method === "POST" && /^\/orders\/[^/]+\/review$/.test(pathname)) {
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((candidate) => candidate.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      if (user.role !== "client" || order.clientId !== user.id) {
        return send(res, 403, {
          error: "forbidden",
          message: "Only the client who placed this order can rate it.",
        });
      }
      if (order.state !== "completed" && order.state !== "payout_released") {
        return send(res, 409, {
          error: "order_not_complete",
          message: "You can rate this once the order is finished and the issue window has closed.",
          state: order.state,
        });
      }
      if (!order.supplierId) {
        return send(res, 409, { error: "order_has_no_shop", message: "This order was never run by a shop." });
      }
      store.shopReviews ||= [];
      if (store.shopReviews.some((row) => row.orderId === order.id)) {
        return send(res, 409, {
          error: "already_rated",
          message: "You have already rated this order.",
        });
      }
      const body = await readBody(req);
      const scores = {};
      for (const field of ["qualityStars", "speedStars", "valueStars"]) {
        const value = body[field];
        if (!Number.isInteger(value) || value < 1 || value > 5) {
          return send(res, 400, {
            error: "invalid_rating",
            message: "Give each of quality, speed and value a whole number of stars from 1 to 5.",
            field,
          });
        }
        scores[field] = value;
      }
      const comment = body.comment == null ? null : String(body.comment).trim();
      if (comment && comment.length > 2_000) {
        return send(res, 400, { error: "invalid_rating", message: "Keep a comment under 2,000 characters.", field: "comment" });
      }
      const at = now();
      const review = {
        id: id("rev"),
        orderId: order.id,
        supplierId: order.supplierId,
        clientId: user.id,
        qualityStars: scores.qualityStars,
        speedStars: scores.speedStars,
        valueStars: scores.valueStars,
        comment: comment || null,
        createdAt: at,
      };
      store.shopReviews.push(review);
      audit(store, {
        actor: user,
        action: "order.rated",
        entityType: "order",
        entityId: order.id,
        orderId: order.id,
        detail: { supplierId: order.supplierId, qualityStars: review.qualityStars },
      });
      await save(store);
      return send(res, 201, { review });
    }

    if (req.method === "POST" && /^\/orders\/[^/]+\/issues$/.test(pathname)) {
      if (user.role !== "client") return send(res, 403, { error: "forbidden" });
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((o) => o.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      if (order.clientId !== user.id) return send(res, 403, { error: "forbidden" });
      if (
        order.state !== "issue_window_open" ||
        !order.issueWindowExpiresAt ||
        new Date(order.issueWindowExpiresAt).getTime() <= Date.now()
      ) {
        return send(res, 409, {
          error: "issue_window_closed",
          message: "The issue-reporting window has ended. Contact Operations if this order still needs review.",
          state: order.state,
          issueWindowExpiresAt: order.issueWindowExpiresAt || null,
        });
      }
      const body = await readBody(req);
      if (!body.description && !body.reason) {
        return send(res, 400, { error: "invalid_issue", need: "description" });
      }
      const existing = openIssueOnOrder(store, order.id);
      if (existing) return send(res, 409, { error: "issue_already_open", issueId: existing.id });

      const ts = now();
      const issue = {
        id: id("iss"),
        orderId: order.id,
        clientId: user.id,
        description: body.description || body.reason,
        kind: body.kind || "material_quality", // material_quality | damage | wrong_item | delivery | other
        status: "open",
        consequence: "payout_hold",
        claimId: null,
        createdAt: ts,
        updatedAt: ts,
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
      };

      // Timely issue freezes payout — create claim hold automatically
      const claim = {
        id: id("clm"),
        orderId: order.id,
        raisedBy: user.id,
        reason: `Client issue report: ${issue.description}`,
        status: "payout_held",
        holdReason: `Auto-hold from issue ${issue.id}`,
        releaseReason: null,
        heldAt: ts,
        heldBy: "system",
        releasedAt: null,
        releasedBy: null,
        createdAt: ts,
        updatedAt: ts,
        issueId: issue.id,
        timeline: [{ at: ts, action: "auto_hold_from_issue", by: "system", note: issue.description }],
      };
      issue.claimId = claim.id;
      store.issues.push(issue);
      store.claims.push(claim);
      order.payoutHold = true;
      order.updatedAt = ts;
      order.timeline.push({
        at: ts,
        state: order.state,
        by: user.id,
        note: `Material issue reported: ${issue.description}`,
      });
      audit(store, {
        actor: user,
        action: "issue.report",
        entityType: "issue",
        entityId: issue.id,
        orderId: order.id,
        detail: { kind: issue.kind, claimId: claim.id },
        reason: issue.description,
      });
      notifyShopPayoutHeld(store, order, { createId: id, at: ts });
      notifyOpsIssueReported(store, order, { createId: id, at: ts });
      queueOrderInvalidate(store, order, ["orders", "claims"]);
      await save(store);
      return send(res, 201, { issue, claim });
    }

    if (req.method === "GET" && /^\/issues\/[^/]+$/.test(pathname)) {
      const iid = pathname.split("/")[2];
      const issue = (store.issues || []).find((i) => i.id === iid);
      if (!issue) return send(res, 404, { error: "issue_not_found" });
      if (user.role === "client" && issue.clientId !== user.id) return send(res, 403, { error: "forbidden" });
      if (user.role === "supplier") {
        const order = store.orders.find((o) => o.id === issue.orderId);
        if (!order || order.supplierId !== user.id) return send(res, 403, { error: "forbidden" });
      } else if (user.role === "rider") {
        return send(res, 403, { error: "forbidden" });
      } else if (!isOps(user) && user.role !== "client" && user.role !== "supplier") {
        return send(res, 403, { error: "forbidden" });
      }
      return send(res, 200, { issue });
    }

    if (req.method === "POST" && /^\/issues\/[^/]+\/resolve$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const iid = pathname.split("/")[2];
      const issue = (store.issues || []).find((i) => i.id === iid);
      if (!issue) return send(res, 404, { error: "issue_not_found" });
      if (issue.status === "resolved" || issue.status === "dismissed") {
        return send(res, 409, { error: "issue_closed", status: issue.status });
      }
      const body = await readBody(req);
      const ts = now();
      issue.status = body.status === "dismissed" ? "dismissed" : "resolved";
      issue.resolution = body.resolution || body.reason || "";
      issue.resolvedAt = ts;
      issue.resolvedBy = user.id;
      issue.updatedAt = ts;
      const order = store.orders.find((o) => o.id === issue.orderId);
      if (order) {
        order.timeline.push({
          at: ts,
          state: order.state,
          by: user.id,
          note: `Issue ${issue.status}: ${issue.resolution}`,
        });
        order.updatedAt = ts;
      }
      // Optionally release linked claim if requested
      if (body.releasePayout && issue.claimId) {
        const claim = (store.claims || []).find((c) => c.id === issue.claimId);
        if (claim && (claim.status === "open" || claim.status === "payout_held")) {
          claim.status = "released";
          claim.releaseReason = body.resolution || "Issue resolved";
          claim.releasedAt = ts;
          claim.releasedBy = user.id;
          claim.updatedAt = ts;
          claim.timeline.push({ at: ts, action: "release", by: user.id, note: claim.releaseReason });
          if (order) {
            const other = (store.claims || []).some(
              (c) => c.id !== claim.id && c.orderId === order.id && (c.status === "open" || c.status === "payout_held"),
            );
            order.payoutHold = other;
          }
        }
      }
      audit(store, {
        actor: user,
        action: "issue.resolve",
        entityType: "issue",
        entityId: issue.id,
        orderId: issue.orderId,
        reason: issue.resolution,
        detail: { status: issue.status, releasePayout: Boolean(body.releasePayout) },
      });
      if (order) queueOrderInvalidate(store, order, ["orders", "claims"]);
      else queueInvalidate(store, { resource: "claims", id: issue.orderId });
      await save(store);
      return send(res, 200, { issue });
    }

    // ---- pickup escalations ----
    if (req.method === "GET" && pathname === "/escalations") {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      let list = store.escalations || [];
      const status = url.searchParams.get("status");
      const orderId = url.searchParams.get("orderId");
      if (status) list = list.filter((item) => item.status === status);
      if (orderId) list = list.filter((item) => item.orderId === orderId);
      return send(res, 200, {
        escalations: [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
      });
    }

    if (req.method === "POST" && /^\/escalations\/[^/]+\/resolve$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const escalationId = pathname.split("/")[2];
      const escalation = (store.escalations || []).find((item) => item.id === escalationId);
      if (!escalation) return send(res, 404, { error: "escalation_not_found" });
      if (escalation.status !== "open") {
        return send(res, 409, {
          error: "escalation_closed",
          message: "This pickup escalation is already resolved. Refresh the escalation list before taking action.",
        });
      }
      const body = await readBody(req);
      const resolution = String(body.resolution || "").trim();
      if (!resolution) {
        return send(res, 400, {
          error: "resolution_required",
          message: "Record the instruction given to the rider before resolving this pickup escalation.",
        });
      }
      const resolvedAt = now();
      escalation.status = "resolved";
      escalation.resolution = resolution;
      escalation.resolvedAt = resolvedAt;
      escalation.resolvedBy = user.id;
      const order = store.orders.find((candidate) => candidate.id === escalation.orderId);
      if (order) {
        order.pickupChecklist.status = "escalation_resolved";
        order.updatedAt = resolvedAt;
        order.timeline.push({
          at: resolvedAt,
          state: order.state,
          by: user.id,
          note: `Pickup escalation resolved; repeat all six checks: ${resolution}`,
        });
        store.notifications.push({
          id: id("ntf"),
          userId: escalation.riderId,
          type: "pickup_escalation_resolved",
          appRole: "rider",
          orderId: order.id,
          title: "Repeat the pickup quality check",
          body: resolution,
          read: false,
          at: resolvedAt,
        });
      }
      audit(store, {
        actor: user,
        action: "pickup_escalation.resolve",
        entityType: "escalation",
        entityId: escalation.id,
        orderId: escalation.orderId,
        reason: resolution,
      });
      queueInvalidate(store, {
        resource: "escalations",
        id: escalation.id,
        riderId: escalation.riderId,
      });
      if (order) queueOrderInvalidate(store, order, ["orders"]);
      await save(store);
      return send(res, 200, { escalation, order: publicOrder(order, user, store) });
    }

    // ---- audit trail ----
    if (req.method === "GET" && pathname === "/audit") {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      let list = store.auditLog || [];
      const entityType = url.searchParams.get("entityType");
      const entityId = url.searchParams.get("entityId");
      const orderId = url.searchParams.get("orderId");
      const actorId = url.searchParams.get("actorId");
      const action = url.searchParams.get("action");
      const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
      if (entityType) list = list.filter((e) => e.entityType === entityType);
      if (entityId) list = list.filter((e) => e.entityId === entityId);
      if (orderId) list = list.filter((e) => e.orderId === orderId);
      if (actorId) list = list.filter((e) => e.actorId === actorId);
      if (action) list = list.filter((e) => e.action === action);
      list = [...list].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
      return send(res, 200, { audit: list });
    }

    // ---- supplier payout milestones ----
    if (req.method === "POST" && /^\/orders\/[^/]+\/milestones\/[^/]+\/release$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const parts = pathname.split("/");
      const orderId = parts[2];
      const milestoneCode = parts[4];
      const order = store.orders.find((candidate) => candidate.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const body = await readBody(req);
      const releasedAt = now();
      const milestone = releaseMilestone(order, milestoneCode, user, releasedAt, store);
      order.updatedAt = releasedAt;
      order.timeline.push({
        at: releasedAt,
        state: order.state,
        by: user.id,
        note: `${milestoneCode} supplier payout milestone released`,
        milestoneCode,
      });
      audit(store, {
        actor: user,
        action: "payout_milestone.release",
        entityType: "order",
        entityId: order.id,
        orderId: order.id,
        detail: { milestoneCode, amountMinor: milestone.amountMinor },
        reason: body.note || null,
      });
      /*
       Tell the shop its money moved.

       A shop is told about its jobs at every step and never about its money,
       which is the half it is actually waiting on. The amount is in the
       notification rather than behind it, because "a payout was released" sends
       somebody looking for a figure they already had a right to.
      */
      if (order.supplierId) {
        store.notifications.push({
          id: id("ntf"),
          userId: order.supplierId,
          type: "shop_payout_released",
          appRole: "supplier",
          orderId: order.id,
          title: `${formatMinorPhp(milestone.amountMinor)} released`,
          body: `${payoutStageLabel(milestoneCode)} was recorded as released. Open the payout ledger for the recorded details.`,
          read: false,
          at: releasedAt,
        });
      }
      queueOrderInvalidate(store, order, ["payouts"]);
      await save(store);
      return send(res, 200, { order: publicOrder(order, user, store), milestone });
    }

    // ---- manual QR installment payments ----
    if (req.method === "POST" && /^\/orders\/[^/]+\/payments\/(initial|final_online|downpayment|balance)\/submit$/.test(pathname)) {
      if (user.role !== "client") return send(res, 403, { error: "forbidden" });
      const parts = pathname.split("/");
      const orderId = parts[2];
      const installmentCode = paymentCodeForRoute(parts[4]);
      const body = await readBody(req);
      const order = store.orders.find((candidate) => candidate.id === orderId);
      if (!order || order.clientId !== user.id) return send(res, 404, { error: "order_not_found" });
      if (body.method !== "qr_manual") {
        return send(res, 400, {
          error: "payment_method_not_allowed",
          message: "Cash on Delivery is unavailable. Choose the digital QR payment method and submit its reference.",
          allowed: ["qr_manual"],
        });
      }
      if (!order.commercialCommittedAt) {
        return send(res, 409, {
          error: "commercial_commitment_required",
          message: "Accept the current final quote before submitting its initial online payment.",
        });
      }
      const installment = order.payments?.[installmentCode];
      if (!installment || !Number.isSafeInteger(installment.amountMinor)) {
        return send(res, 409, {
          error: "final_price_required",
          message: "The final price is not ready. Wait for the supplier assignment notification and refresh the order.",
        });
      }
      if (installmentCode === "initial" && !["awaiting_initial_payment", "initial_payment_review", "awaiting_downpayment", "downpayment_review"].includes(order.state)) {
        return send(res, 409, {
          error: "initial_payment_not_available",
          message: "The initial online payment is not available at this order step. Refresh the order to see the current payment action.",
          state: order.state,
        });
      }
      if (
        installmentCode === "final_online" &&
        order.payments?.initial?.status !== "confirmed"
      ) {
        return send(res, 409, {
          error: "initial_payment_not_confirmed",
          message: "Operations must confirm the initial payment before you submit the final online payment.",
        });
      }
      if (["pending_confirmation", "confirmed"].includes(installment.status)) {
        return send(res, 409, {
          error: "payment_already_submitted",
          message: "This installment already has a submitted payment. Refresh the order to see its confirmation status.",
          installment: installmentCode,
          status: installment.status,
        });
      }
      const reference = String(body.reference || "").trim();
      if (!reference) {
        return send(res, 400, {
          error: "payment_reference_required",
          message: "Enter the GCash, Maya, or e-wallet payment reference so Operations can confirm it.",
        });
      }
      const submittedAt = now();
      installment.method = "qr_manual";
      installment.status = "pending_confirmation";
      installment.reference = reference;
      installment.submittedAt = submittedAt;
      installment.confirmedAt = null;
      installment.confirmedBy = null;
      installment.confirmationSource = null;
      installment.rejectedAt = null;
      installment.rejectedBy = null;
      installment.rejectionReason = null;
      order.paymentMethod = "qr_manual";
      order.paymentStatus = installmentCode === "initial" ? "initial_payment_pending" : "final_online_pending";
      if (installmentCode === "initial") order.state = "initial_payment_review";
      order.updatedAt = submittedAt;
      order.timeline.push({
        at: submittedAt,
        state: order.state,
        by: user.id,
        note: `${installmentCode === "initial" ? "Initial online payment" : "Final online payment"} submitted for Operations confirmation`,
      });
      audit(store, {
        actor: user,
        action: `payment.${installmentCode}_submit`,
        entityType: "order",
        entityId: order.id,
        orderId: order.id,
        detail: { amountMinor: installment.amountMinor, method: "qr_manual" },
      });
      notifyOpsPaymentSubmitted(store, order, { createId: id, at: submittedAt });
      queueOrderInvalidate(store, order, ["orders"]);
      await save(store);
      return send(res, 200, { order: publicOrder(order, user, store) });
    }

    if (req.method === "POST" && /^\/orders\/[^/]+\/payments\/(initial|final_online|downpayment|balance)\/reject$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const parts = pathname.split("/");
      const orderId = parts[2];
      const installmentCode = paymentCodeForRoute(parts[4]);
      const order = store.orders.find((candidate) => candidate.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const installment = order.payments?.[installmentCode];
      if (installment?.status === "confirmed") {
        return send(res, 409, {
          error: "payment_already_confirmed",
          message: "Operations already accepted this installment, so it cannot be rejected here. Escalate any payment correction for manual reconciliation.",
          installment: installmentCode,
          status: installment.status,
        });
      }
      if (!installment || installment.status !== "pending_confirmation") {
        return send(res, 409, {
          error: "payment_not_pending",
          message: "This installment has no submitted payment waiting for review. Refresh the order before taking action.",
          installment: installmentCode,
          status: installment?.status || null,
        });
      }
      const body = await readBody(req);
      const reason = String(body.reason || "").trim();
      if (!reason) {
        return send(res, 400, {
          error: "payment_rejection_reason_required",
          message: "Explain what is wrong with the submitted payment and tell the client what to correct before resubmitting.",
        });
      }
      const rejectedAt = now();
      installment.status = "not_submitted";
      installment.reference = null;
      installment.submittedAt = null;
      installment.confirmedAt = null;
      installment.confirmedBy = null;
      installment.confirmationSource = null;
      installment.rejectedAt = rejectedAt;
      installment.rejectedBy = user.id;
      installment.rejectionReason = reason;
      if (installmentCode === "initial") {
        order.state = order.moneyModelVersion === 3
          ? "awaiting_initial_payment"
          : (order.moneyModelVersion === 1 ? "awaiting_downpayment" : "awaiting_initial_payment");
        order.paymentStatus = "unpaid";
      } else {
        order.paymentStatus = "initial_payment_confirmed";
      }
      order.updatedAt = rejectedAt;
      order.timeline.push({
        at: rejectedAt,
        state: order.state,
        by: user.id,
        note: `${installmentCode === "initial" ? "Initial online payment" : "Final online payment"} rejected by Operations: ${reason}`,
      });
      audit(store, {
        actor: user,
        action: `payment.${installmentCode}_reject`,
        entityType: "order",
        entityId: order.id,
        orderId: order.id,
        detail: { amountMinor: installment.amountMinor, source: "manual_ops" },
        reason,
      });
      notifyClientPaymentRejected(store, order, { createId: id, at: rejectedAt, reason });
      queueOrderInvalidate(store, order, ["orders"]);
      await save(store);
      return send(res, 200, { order: publicOrder(order, user, store) });
    }

    if (req.method === "POST" && /^\/orders\/[^/]+\/payments\/(initial|final_online|downpayment|balance)\/confirm$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const parts = pathname.split("/");
      const orderId = parts[2];
      const installmentCode = paymentCodeForRoute(parts[4]);
      const order = store.orders.find((candidate) => candidate.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const installment = order.payments?.[installmentCode];
      if (!installment || installment.status !== "pending_confirmation") {
        return send(res, 409, {
          error: "payment_not_pending",
          message: "This installment has no payment waiting for confirmation. Refresh the order before taking action.",
          installment: installmentCode,
          status: installment?.status || null,
        });
      }
      const body = await readBody(req);
      const confirmedAt = now();
      installment.status = "confirmed";
      installment.confirmedAt = confirmedAt;
      installment.confirmedBy = user.id;
      installment.confirmationSource = "manual_ops";
      if (installmentCode === "initial") {
        // A cart checkout is paid before anything is checked, so confirming the
        // transfer hands the order to quality control rather than to the shop.
        // Older orders were quoted and approved long before payment, so for
        // them a confirmed payment really is the last gate.
        order.state = order.moneyModelVersion === 3 ? "needs_qa" : "payment_authorized";
        order.paymentStatus = "initial_payment_confirmed";
      } else {
        order.paymentStatus = "paid";
      }
      order.updatedAt = confirmedAt;
      notifyOrderParties(store, order, { createId: id, at: confirmedAt });
      if (order.state === "needs_qa") {
        notifyOpsJobNeedsQa(store, order, { createId: id, at: confirmedAt });
      }
      queueOrderInvalidate(store, order, ["orders", "jobs"]);
      order.timeline.push({
        at: confirmedAt,
        state: order.state,
        by: user.id,
        note: `${installmentCode === "initial" ? "Initial online payment" : "Final online payment"} confirmed manually by Operations`,
      });
      audit(store, {
        actor: user,
        action: `payment.${installmentCode}_confirm`,
        entityType: "order",
        entityId: order.id,
        orderId: order.id,
        detail: { amountMinor: installment.amountMinor, source: "manual_ops" },
        reason: body.note || null,
      });
      await save(store);
      return send(res, 200, { order: publicOrder(order, user, store) });
    }

    // ---- orders list / create ----
    // Latest ping per rider who is currently sharing location on an active trip.
    if (req.method === "GET" && pathname === "/ops/riders/locations") {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const tracking = new Set(["picked_up", "out_for_delivery"]);
      const latestByRider = new Map();
      for (const order of store.orders || []) {
        if (!order.riderId || !tracking.has(order.state)) continue;
        const ping = (store.locationPings || [])
          .filter((p) => p.orderId === order.id && p.riderId === order.riderId)
          .sort((a, b) => b.at.localeCompare(a.at))[0];
        if (!ping) continue;
        const prev = latestByRider.get(order.riderId);
        if (!prev || ping.at > prev.ping.at) {
          latestByRider.set(order.riderId, { order, ping });
        }
      }
      const riders = [...latestByRider.values()].map(({ order, ping }) => {
        const rider = (store.users || []).find((u) => u.id === order.riderId);
        return {
          riderId: order.riderId,
          name: rider?.name || "Rider",
          orderId: order.id,
          orderTitle: order.title || null,
          state: order.state,
          lat: ping.lat,
          lng: ping.lng,
          accuracy: ping.accuracy ?? null,
          at: ping.at,
        };
      });
      return send(res, 200, { riders });
    }

    if (req.method === "GET" && pathname === "/orders") {
      return send(res, 200, { orders: ordersFor(user, store).map((order) => publicOrder(order, user, store)) });
    }

    if (req.method === "GET" && pathname.startsWith("/orders/")) {
      const parts = pathname.slice("/orders/".length).split("/");
      const orderId = parts[0];
      // subpaths handled elsewhere (transition POST, eligible-suppliers, issues)
      if (parts.length === 1) {
        const order = store.orders.find((o) => o.id === orderId);
        if (!order) return send(res, 404, { error: "order_not_found" });
        const visible = ordersFor(user, store).some((o) => o.id === orderId);
        if (!visible) return send(res, 403, { error: "forbidden" });
        return send(res, 200, { order: publicOrder(order, user, store) });
      }
    }

    if (req.method === "POST" && pathname === "/orders") {
      if (user.role !== "client") return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      if (store.catalog.length === 0) {
        return send(res, 409, {
          error: "catalog_not_seeded",
          message: "The product catalog is unavailable. Run the platform reference seed and try again.",
        });
      }
      const product = store.catalog.find((p) => p.id === body.productId) || store.catalog[0];
      const qty = body.quantity == null ? 1 : Number(body.quantity);
      if (!Number.isSafeInteger(qty) || qty < 1) {
        return send(res, 400, {
          error: "invalid_quantity",
          message: "quantity must be a positive integer.",
        });
      }
      const referenceCandidates = [(product?.basePriceMinor || 10000) * qty];
      for (const service of store.supplierServices || []) {
        if (service.state !== "live" || !Number.isSafeInteger(Number(service.referenceRateMinor))) continue;
        if (Array.isArray(service.productFamilyIds) && service.productFamilyIds.includes(product?.family)) {
          referenceCandidates.push(Number(service.referenceRateMinor) * qty);
        }
      }
      const priceRange = estimatePriceRange({ supplierSubtotalCandidatesMinor: referenceCandidates });
      const zoneCode = body.zone || "davao_central";
      if (!store.zones.some((zone) => zone.code === zoneCode && zone.active !== false)) {
        return send(res, 400, {
          error: "invalid_zone",
          message: "Choose an active delivery zone from GET /zones.",
        });
      }
      const ts = now();
      const address = body.address || "";
      const requestedDropoff = dropoffFor(address, zoneCode);
      const order = {
        id: id("ord"),
        clientId: user.id,
        supplierId: null,
        riderId: null,
        state: body.submit ? "submitted" : "draft",
        productId: product.id,
        title: body.title || product.name,
        quantity: qty,
        size: body.size || "",
        material: body.material || "",
        finish: body.finish || "",
        deadline: body.deadline || null,
        address,
        zone: zoneCode,
        pickup: null,
        dropoff: structuredClone(requestedDropoff),
        requestedDropoff,
        operationalModelVersion: 2,
        moneyModelVersion: 2,
        priceRange,
        supplierSubtotalMinor: null,
        subtotalMinor: null,
        serviceFeeRateBps: null,
        serviceFeeMinor: null,
        deliveryDistanceMeters: null,
        deliveryFeeMinor: null,
        totalMinor: null,
        fulfillmentMode: null,
        paymentPlan: null,
        quoteVersion: null,
        supplierDownpaymentRateBps: null,
        onlineDueMinor: null,
        directStoreDueMinor: null,
        supplierPlatformPayoutMinor: null,
        commercialCommittedAt: null,
        paymentMethod: null,
        paymentStatus: "unpaid",
        payments: {},
        paymentAllocations: [],
        payoutHold: false,
        payoutMilestones: [],
        promisedDate: null,
        matchingServiceIds: null,
        assignmentNotificationId: null,
        assignmentNotifiedAt: null,
        artworkName: body.artworkName || null,
        artworkFileIds: [],
        proofFileIds: [],
        fulfilmentProofFileIds: [],
        deliveryPhotoFileIds: [],
        createdAt: ts,
        updatedAt: ts,
        timeline: [{ at: ts, state: body.submit ? "submitted" : "draft", by: user.id, note: body.submit ? "Submitted" : "Draft saved" }],
      };
      store.orders.unshift(order);
      await save(store);
      return send(res, 201, { order: publicOrder(order, user, store) });
    }

    /**
     * A shop that cannot take the work.
     *
     * Declining is not stepping aside: the client has already paid and been
     * given a date, so the job has to find another shop rather than stop. The
     * replacement is chosen by the same ranking, filtered to shops that can
     * still make the promised date and cannot cost the client more than they
     * already committed to. If one is cheaper the difference comes off their
     * balance; if none qualifies the order lands on Operations rather than
     * silently asking the client to pay more or wait longer.
     */
    if (req.method === "POST" && /^\/orders\/[^/]+\/decline$/.test(pathname)) {
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((candidate) => candidate.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      if (user.role !== "supplier" || !approvedRole(store,user.id,"supplier") || order.supplierId !== user.id) {
        return send(res, 403, {
          error: "forbidden",
          message: "Only the shop this job was handed to can decline it.",
        });
      }
      if (order.state !== "supplier_assigned") {
        return send(res, 409, {
          error: "decline_not_available",
          message: "This job can no longer be declined. Refresh it and use an available action.",
          state: order.state,
        });
      }
      const body = await readBody(req);
      const reason = String(body.reason || "").trim();
      const at = now();

      order.declinedBy = [...new Set([...(order.declinedBy || []), user.id])];
      audit(store, {
        actor: user,
        action: "order.shop_declined",
        entityType: "order",
        entityId: order.id,
        orderId: order.id,
        detail: { supplierId: user.id },
        reason: reason || null,
      });

      const replacement = findReplacementShop(store, order, at);
      if (!replacement) {
        // Nobody else can make the date at the price the client paid. That is
        // an Operations decision -- extend, refund, or ask the client -- not
        // something to resolve by quietly changing what they agreed to.
        order.supplierId = null;
        order.pickup = null;
        order.state = "approved_for_matching";
        order.updatedAt = at;
        order.timeline.push({ at, state: order.state, by: user.id, note: reason ? `Declined: ${reason}` : "Declined" });
        await save(store);
        return send(res, 200, { order: {id:order.id,state:order.state}, replaced: false });
      }

      order.supplierId = replacement.supplierId;
      order.pickup = structuredClone(replacement.pickup);
      order.readyBy = replacement.readyBy;
      order.promiseBy = replacement.promiseBy;
      order.updatedAt = at;
      order.timeline.push({ at, state: order.state, by: user.id, note: reason ? `Declined: ${reason}` : "Declined" });
      audit(store, {
        actor: user,
        action: "order.shop_replaced",
        entityType: "order",
        entityId: order.id,
        orderId: order.id,
        detail: { supplierId: replacement.supplierId, readyBy: replacement.readyBy },
      });
      await save(store);
      return send(res, 200, { order: {id:order.id,state:order.state}, replaced: true });
    }

    if (req.method === "POST" && /^\/orders\/[^/]+\/transition$/.test(pathname)) {
      const orderId = pathname.split("/")[2];
      const body = await readBody(req);
      const order = store.orders.find((o) => o.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const next = body.state;
      if (!hasRole(store,user.id,user.role) || (['supplier','rider'].includes(user.role) && !approvedRole(store,user.id,user.role))) return send(res,403,{error:'forbidden'});
      if (body.paymentMethod != null && String(body.paymentMethod).trim().toLowerCase() !== "qr_manual") {
        return send(res, 400, {
          error: "payment_method_not_allowed",
          message: "Order transitions do not accept cash or legacy payment methods. Submit the digital QR installment for Operations confirmation.",
          allowed: ["qr_manual"],
        });
      }
      // A checkout order was matched to its shop before the client paid, against
      // live listings, real opening hours and the client's own deadline. Handing
      // it to that shop is not an assignment decision, so the legacy eligibility
      // check -- which reads the retired product catalogue -- has nothing to say.
      const handingToMatchedShop = next === "supplier_assigned" && !body.supplierId && Boolean(order.supplierId);
      if (next === "supplier_assigned" && !handingToMatchedShop) {
        const supplier = store.users.find(
          (candidate) => candidate.id === body.supplierId && hasRole(store, candidate.id, "supplier"),
        );
        if (!supplier) {
          return send(res, 404, {
            error: "supplier_not_found",
            message: "That supplier account no longer exists. Refresh eligible suppliers and choose another.",
          });
        }
        if (!approvedRole(store, supplier.id, "supplier")) {
          const approval = (store.approvalCases || []).find((c) => c.userId === supplier.id && c.kind === "supplier");
          return send(res, 409, {
            error: "supplier_not_approved",
            message: "Operations must approve this supplier before assigning new work.",
            verificationStatus: approval?.status || supplier.verificationStatus || "unverified",
          });
        }
        const candidate = eligibleSuppliersForOrder(store, order).candidates.find(
          (item) => item.supplier.id === supplier.id,
        );
        if (!candidate?.eligible) {
          return send(res, 409, {
            error: "supplier_not_eligible",
            message: "This supplier has no approved live service that covers the order. Refresh eligible suppliers and choose a listed match.",
            reasons: candidate?.reasons || ["no_covering_service"],
          });
        }
      }
      /*
       Two different things have been called pickup, and only one is contained.

       The old one was the client collecting from the shop's own counter, whose
       handover lifecycle was never built — that is what this guard was written
       to hold back, and it still does, by the payment plan that shape uses.

       The one that shipped is different: a client collects at GRIDGO Office,
       and a rider carries the finished run there. It needs production and a
       rider exactly as a delivery does. Held by fulfilment mode alone, this
       refused every collected order the moment its shop pressed start, and the
       shop was told GRIDGO was unreachable.
      */
      if (isContainedPickup(order) && ["production", "rider_assigned"].includes(next)) {
        return send(res, 409, {
          error: "pickup_fulfillment_not_available",
          message: "Collecting from the shop counter is not available yet. Operations can switch this order to delivery.",
        });
      }
      if (next === "rider_assigned") {
        const riderId = user.role === "rider" ? user.id : body.riderId;
        const rider = store.users.find((candidate) => candidate.id === riderId && hasRole(store,candidate.id,"rider"));
        if (!rider) {
          return send(res, 404, {
            error: "rider_not_found",
            message: "That rider account no longer exists. Refresh approved riders and choose another.",
          });
        }
        if (!approvedRole(store,rider.id,"rider")) {
          return send(res, user.role === "rider" ? 403 : 409, {
            error: "rider_not_approved",
            message: "Operations must approve this rider profile before dispatch assignment.",
            verificationStatus: rider.verificationStatus || "unverified",
          });
        }
      }
      if (next === "cancelled") {
        const reason = String(body.reason || "").trim();
        if (!reason) {
          return send(res, 400, {
            error: "cancellation_reason_required",
            message: "Say why this order is being cancelled. The client is told, and the record has to explain itself later.",
          });
        }
        // Refunding is still a manual transfer. This records the decision, who
        // made it and why -- it does not move money, and must not read as if it
        // has.
        order.cancelledAt = now();
        order.cancelledBy = user.id;
        order.cancellationReason = reason;
      }

      const allowed = TRANSITIONS[order.state]?.[next];
      if (!allowed || !allowed.includes(user.role)) {
        return send(res, 409, {
          error: "transition_not_allowed",
          message: "This order cannot move to the requested state from its current step. Refresh the order and use an available action.",
          from: order.state,
          to: next,
          role: user.role,
        });
      }
      const wrongRelatedParty =
        (user.role === "client" && order.clientId !== user.id) ||
        (user.role === "supplier" && order.supplierId !== user.id) ||
        (user.role === "rider" && next !== "rider_assigned" && order.riderId !== user.id);
      if (wrongRelatedParty) {
        return send(res, 403, {
          error: "forbidden",
          message: "This order is assigned to another account. Open one of your own orders before taking this action.",
        });
      }
      // Soft guard: do not release payout while claim hold is active (missing half of completed → payout_released)
      if (next === "payout_released") {
        const hold = activePayoutHold(store, order.id);
        if (hold || order.payoutHold) {
          return send(res, 409, {
            error: "payout_held",
            claimId: hold?.id || null,
            reason: hold?.holdReason || "payout hold active",
          });
        }
        const unreleased = (order.payoutMilestones || []).filter((milestone) => milestone.status !== "released");
        if (unreleased.length) {
          return send(res, 409, {
            error: "milestones_not_released",
            message: "Release every eligible supplier payout milestone before closing the supplier payout.",
            milestoneCodes: unreleased.map((milestone) => milestone.code),
          });
        }
      }
      if (next === "supplier_accepted") {
        if (user.role !== "supplier" || !approvedRole(store,user.id,"supplier") || order.supplierId !== user.id) {
          return send(res, 403, {
            error: "forbidden",
            message: "Only the supplier assigned to this order can accept it and set the final price.",
          });
        }
        if (user.verificationStatus !== "approved") {
          return send(res, 403, {
            error: "supplier_not_approved",
            message: "Operations must approve this supplier before the supplier can accept matched work.",
          });
        }
        const priorQuote = order.pendingQuote || order.acceptedQuote;
        const superseding = Boolean(priorQuote || order.commercialCommittedAt);
        if (superseding) {
          if (Object.values(order.payments || {}).some((payment) => payment.status !== "not_submitted")) {
            return send(res, 409, { error: "payment_authorization_started" });
          }
          const reason = String(body.reason || "").trim();
          if (!reason) return send(res, 400, { error: "quote_supersession_reason_required" });
          order.quoteHistory ||= [];
          if (priorQuote) order.quoteHistory.push(structuredClone(priorQuote));
          order.dropoff = order.requestedDropoff ? structuredClone(order.requestedDropoff) : order.dropoff;
          for (const field of [
            "supplierSubtotalMinor", "subtotalMinor", "serviceFeeRateBps", "serviceFeeMinor",
            "deliveryDistanceMeters", "deliveryFeeMinor", "totalMinor", "fulfillmentMode",
            "paymentPlan", "supplierDownpaymentRateBps", "initialSupplierPrincipalMinor",
            "supplierRemainderMinor", "initialOnlineMinor", "finalOnlineMinor", "onlineDueMinor",
            "directStoreDueMinor", "supplierPlatformPayoutMinor", "supplierEarningsMinor",
          ]) order[field] = null;
          order.quoteVersion = null;
          order.commercialCommittedAt = null;
          order.payments = {};
          order.paymentAllocations = [];
          order.payoutMilestones = [];
          order.paymentStatus = "unpaid";
          delete order.acceptedQuote;
          audit(store, {
            actor: user,
            action: "order.quote_superseded",
            entityType: "order",
            entityId: order.id,
            orderId: order.id,
            detail: { priorQuoteVersion: order.quoteHistory.at(-1)?.version || null },
            reason,
          });
        }
        const supplierSubtotalMinor = body.supplierSubtotalMinor;
        if (!Number.isSafeInteger(supplierSubtotalMinor) || supplierSubtotalMinor < 0) {
          return send(res, 400, {
            error: "invalid_supplier_subtotal",
            message: "Enter the final supplier subtotal as a non-negative integer in PHP minor units.",
          });
        }
        const terms = supplierTermsFor(store, user.id);
        if (!terms) return send(res, 409, { error: "supplier_payment_terms_required" });
        order.promisedDate = body.promisedDate || order.deadline;
        setOrderPickup(order, store);
        const quoteVersion = Math.max(
          order.pendingQuote?.version || 0,
          order.quoteHistory?.at(-1)?.version || 0,
          order.quoteVersion || 0,
        ) + 1;
        order.pendingQuote = {
          version: quoteVersion,
          supplierSubtotalMinor,
          promisedDate: order.promisedDate,
          supplierShop: structuredClone(order.pickup),
          paymentTerms: structuredClone(terms),
          orderLines: structuredClone(order.orderLines || [{
            productId: order.productId,
            label: order.title,
            quantity: order.quantity,
            amountMinor: supplierSubtotalMinor,
            size: order.size || null,
            material: order.material || null,
            finish: order.finish || null,
            optionSnapshots: order.optionSnapshots || [],
            structuredSpecification: order.structuredSpecification || null,
            acceptedFormatCodes: order.acceptedFormatCodes || [],
          }]),
          createdAt: now(),
        };
        const acceptedAt = now();
        order.timeline.push({
          at: acceptedAt,
          state: "supplier_accepted",
          by: user.id,
          note: `Supplier issued final quote version ${quoteVersion}`,
        });
        order.state = "awaiting_checkout";
        order.updatedAt = acceptedAt;
        const { client: notification } = notifyOrderParties(store, order, {
          createId: id,
          at: acceptedAt,
        });
        if (notification) {
          order.assignmentNotificationId = notification.id;
          order.assignmentNotifiedAt = notification.at;
        }
        order.timeline.push({
          at: acceptedAt,
          state: "awaiting_checkout",
          by: "system",
          note: "Client notified that the final quote is ready for checkout",
        });
        queueOrderInvalidate(store, order, ["orders", "jobs"]);
        await save(store);
        return send(res, 200, { order: publicOrder(order, user, store) });
      }
      if (next === "awaiting_initial_payment") {
        if (user.role !== "client" || order.clientId !== user.id) {
          return send(res, 403, { error: "forbidden" });
        }
        const quote = order.pendingQuote;
        if (!quote || !Number.isInteger(body.quoteVersion) || body.quoteVersion !== quote.version) {
          return send(res, 409, {
            error: "quote_stale",
            quoteVersion: quote?.version || null,
          });
        }
        const fulfillmentMode = body.fulfillmentMode;
        const paymentPlan = body.paymentPlan;
        const terms = quote.paymentTerms;
        let supplierDownpaymentRateBps;
        if (paymentPlan === "delivery_online" && fulfillmentMode === "delivery") {
          supplierDownpaymentRateBps = terms.deliveryDownpaymentRateBps;
        } else if (paymentPlan === "pickup_full_online" && fulfillmentMode === "pickup") {
          if (!terms.pickupFullOnlineEnabled) return send(res, 409, { error: "payment_plan_not_offered" });
          supplierDownpaymentRateBps = 10_000;
        } else if (paymentPlan === "pickup_downpayment_store" && fulfillmentMode === "pickup") {
          if (!terms.pickupDownpaymentStoreEnabled) return send(res, 409, { error: "payment_plan_not_offered" });
          supplierDownpaymentRateBps = terms.pickupDownpaymentRateBps;
        } else {
          return send(res, 400, { error: "invalid_payment_plan" });
        }
        if (fulfillmentMode === "pickup") {
          return send(res, 409, {
            error: "pickup_fulfillment_not_available",
            message: "Pickup commercial commitment remains unavailable until the pickup handover lifecycle is implemented.",
          });
        }
        const supplierProfile = (store.supplierProfiles || []).find((candidate) => candidate.userId === order.supplierId);
        if (fulfillmentMode === "pickup" && (!supplierProfile?.pickupAvailable || !quote.supplierShop)) {
          return send(res, 409, { error: "pickup_not_available" });
        }

        const money = calculateOrderMoney({
          supplierSubtotalMinor: quote.supplierSubtotalMinor,
          fulfillmentMode,
          paymentPlan,
          supplierDownpaymentRateBps,
          pickup: quote.supplierShop,
          dropoff: order.dropoff,
          settings: store.settings,
        });
        const schedule = createPaymentSchedule(money);
        const committedAt = now();
        Object.assign(order, money, schedule, {
          operationalModelVersion: 2,
          moneyModelVersion: 2,
          quoteVersion: quote.version,
          commercialCommittedAt: committedAt,
          promisedDate: quote.promisedDate,
          pickup: structuredClone(quote.supplierShop),
          acceptedQuote: {
            ...structuredClone(quote),
            acceptedAt: committedAt,
            fulfillmentMode,
            paymentPlan,
            serviceFeeRateBps: money.serviceFeeRateBps,
            serviceFeeMinor: money.serviceFeeMinor,
            deliveryDistanceMeters: money.deliveryDistanceMeters,
            deliveryFeeMinor: money.deliveryFeeMinor,
            totalMinor: money.totalMinor,
            supplierDownpaymentRateBps: money.supplierDownpaymentRateBps,
            onlineDueMinor: money.onlineDueMinor,
            directStoreDueMinor: money.directStoreDueMinor,
            payments: structuredClone(schedule.payments),
          },
        });
        delete order.pendingQuote;
        if (fulfillmentMode === "pickup") {
          order.dropoff = null;
          order.riderId = null;
        }
        order.priceRange.deliveryFeeStatus = "final";
        order.payoutMilestones = createPayoutMilestones(order);
        order.state = "awaiting_initial_payment";
        order.updatedAt = committedAt;
        order.timeline.push({
          at: committedAt,
          state: order.state,
          by: user.id,
          note: `Client accepted quote version ${quote.version}`,
        });
        audit(store, {
          actor: user,
          action: "order.commercial_commitment",
          entityType: "order",
          entityId: order.id,
          orderId: order.id,
          detail: {
            quoteVersion: quote.version,
            fulfillmentMode,
            paymentPlan,
            serviceFeeRateBps: order.serviceFeeRateBps,
            serviceFeeMinor: order.serviceFeeMinor,
          },
        });
        await save(store);
        return send(res, 200, { order: publicOrder(order, user, store) });
      }
      if (next === "supplier_assigned" && body.supplierId) {
        order.supplierId = body.supplierId;
        // optional: record which service lines justified eligibility
        if (Array.isArray(body.matchingServiceIds)) {
          order.matchingServiceIds = body.matchingServiceIds;
        } else {
          const elig = eligibleSuppliersForOrder(store, order);
          const cand = elig.candidates.find((c) => c.supplier.id === body.supplierId && c.eligible);
          order.matchingServiceIds = cand?.matchingServiceIds || [];
        }
        setOrderPickup(order, store);
        audit(store, {
          actor: user,
          action: "order.supplier_assigned",
          entityType: "order",
          entityId: order.id,
          orderId: order.id,
          detail: { supplierId: body.supplierId, matchingServiceIds: order.matchingServiceIds },
          reason: body.note || null,
        });
      }
      if (next === "approved_for_matching" && order.state === "supplier_assigned" && user.role === "supplier") {
        // treat as decline
        order.supplierId = null;
        order.pickup = null;
        order.matchingServiceIds = null;
      }
      if (next === "rider_assigned") {
        order.riderId = user.role === "rider" ? user.id : body.riderId || order.riderId;
      }
      // The moment the shop's own work is done. Its on-time record is measured
      // from this against readyBy -- the date its board promised -- and never
      // against the padded date the client was given, or against a delivery a
      // rider was late for.
      if (next === "ready_for_dispatch" && !order.readyAt) {
        order.readyAt = now();
      }
      order.state = next;
      order.updatedAt = now();
      order.timeline.push({ at: order.updatedAt, state: next, by: user.id, note: body.note || "" });
      if (next === "ready_for_dispatch" || next === "rider_assigned") {
        syncJobsWithOrder(store, order, order.updatedAt);
      }
      notifyOrderParties(store, order, { createId: id, at: order.updatedAt });
      if (next === "needs_qa") {
        notifyOpsJobNeedsQa(store, order, { createId: id, at: order.updatedAt });
      }
      queueOrderInvalidate(
        store,
        order,
        next === "ready_for_dispatch" ? ["orders", "jobs", "dispatch"] : ["orders", "jobs"],
      );
      await save(store);
      return send(res, 200, { order: publicOrder(order, user, store) });
    }

    // ---- dispatch (rider) ----
    if (req.method === "GET" && pathname === "/dispatch/offers") {
      if (user.role !== "rider" && user.role !== "ops_admin" && user.role !== "super_admin") {
        return send(res, 403, { error: "forbidden" });
      }
      if (user.role === "rider" && user.verificationStatus !== "approved") {
        return send(res, 403, {
          error: "rider_not_approved",
          message: "Operations must approve this rider profile before dispatch offers become available.",
        });
      }
      // A collected order is offered too. It is carried from the shop to
      // GRIDGO Office rather than to the client's door, which is a different
      // destination and not a different job. Only the unfinished
      // counter-collection shape has no journey to offer.
      const offers = store.orders.filter(
        (o) => !isContainedPickup(o)
          && (o.state === "ready_for_dispatch"
            || (o.state === "rider_assigned" && o.riderId === user.id)),
      );
      return send(res, 200, { offers: offers.map((order) => publicOrder(order, user, store)) });
    }

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/accept$/.test(pathname)) {
      if (user.role !== "rider" || !approvedRole(store,user.id,"rider")) return send(res, 403, { error: "forbidden" });
      if (user.verificationStatus !== "approved") {
        return send(res, 403, {
          error: "rider_not_approved",
          message: "Operations must approve this rider profile before the rider can accept a dispatch.",
        });
      }
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((o) => o.id === orderId);
      if (!order || order.state !== "ready_for_dispatch") return send(res, 409, { error: "not_offerable" });
      // A collected order needs a rider too — it is carried to GRIDGO Office
      // rather than to the client's door. Only the unfinished counter-pickup
      // shape has no journey to offer.
      if (isContainedPickup(order)) {
        return send(res, 409, { error: "pickup_fulfillment_not_available" });
      }
      order.riderId = user.id;
      order.state = "rider_assigned";
      order.updatedAt = now();
      order.timeline.push({ at: order.updatedAt, state: order.state, by: user.id, note: "Rider accepted" });
      syncJobsWithOrder(store, order, order.updatedAt);
      notifyOrderParties(store, order, { createId: id, at: order.updatedAt });
      queueOrderInvalidate(store, order, ["dispatch", "orders", "jobs"]);
      await save(store);
      return send(res, 200, { order: publicOrder(order, user, store) });
    }

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/pickup-checklist$/.test(pathname)) {
      if (user.role !== "rider" || !approvedRole(store,user.id,"rider")) return send(res, 403, { error: "forbidden" });
      if (user.verificationStatus !== "approved") {
        return send(res, 403, {
          error: "rider_not_approved",
          message: "Operations must approve this rider profile before pickup checks can begin.",
        });
      }
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((candidate) => candidate.id === orderId && candidate.riderId === user.id);
      if (!order) return send(res, 404, { error: "order_not_found" });
      if (order.state !== "rider_assigned") {
        return send(res, 409, {
          error: "pickup_checklist_not_available",
          message: "The pickup checklist is available only before transport begins. Refresh the delivery to see its current step.",
          state: order.state,
        });
      }
      const openEscalation = (store.escalations || []).find(
        (item) => item.orderId === order.id && item.status === "open",
      );
      if (openEscalation) {
        return send(res, 409, {
          error: "pickup_escalation_open",
          message: "Do not transport this order. Wait for Operations to resolve the failed pickup check, then repeat all six checks.",
          escalationId: openEscalation.id,
        });
      }
      const body = await readBody(req);
      const checks = Array.isArray(body.checks) ? body.checks : [];
      const expected = new Set(PICKUP_CHECK_CODES);
      const received = new Set(checks.map((item) => item?.code));
      const valid =
        checks.length === PICKUP_CHECK_CODES.length &&
        received.size === PICKUP_CHECK_CODES.length &&
        checks.every((item) => expected.has(item?.code) && typeof item.passed === "boolean");
      if (!valid) {
        return send(res, 400, {
          error: "invalid_pickup_checklist",
          message: "Complete each of the six pickup checks once and mark every check passed or failed.",
          requiredCheckCodes: PICKUP_CHECK_CODES,
        });
      }
      const failedCheckCodes = checks.filter((item) => !item.passed).map((item) => item.code);
      const checkedAt = now();
      if (failedCheckCodes.length) {
        const failureNote = String(body.failureNote || "").trim();
        const evidenceFileIds = Array.isArray(body.evidenceFileIds) ? [...new Set(body.evidenceFileIds)] : [];
        if (!failureNote || evidenceFileIds.length === 0) {
          return send(res, 400, {
            error: "checklist_evidence_required",
            message: "Describe the failed pickup check and attach at least one photo before escalating it.",
            failedCheckCodes,
          });
        }
        const invalidEvidence = evidenceFileIds.find(
          (fileId) => !attachedReadyOrderFile(store, order, fileId, "delivery_photo", user.id),
        );
        if (invalidEvidence) {
          return send(res, 400, {
            error: "invalid_checklist_evidence",
            message: "Attach each failure photo to this order before submitting the pickup escalation.",
            fileId: invalidEvidence,
          });
        }
        const escalation = {
          id: id("esc"),
          type: "pickup_check_failed",
          status: "open",
          orderId: order.id,
          riderId: user.id,
          supplierId: order.supplierId,
          failedCheckCodes,
          evidenceFileIds,
          failureNote,
          createdAt: checkedAt,
          resolvedAt: null,
          resolvedBy: null,
          resolution: null,
        };
        store.escalations.push(escalation);
        order.pickupChecklist = {
          status: "failed_escalated",
          checks: structuredClone(checks),
          evidenceFileIds,
          failureNote,
          completedAt: checkedAt,
          completedBy: user.id,
          escalationId: escalation.id,
          signOffPrompt: PICKUP_SIGN_OFF_PROMPT,
        };
        order.updatedAt = checkedAt;
        order.timeline.push({
          at: checkedAt,
          state: order.state,
          by: user.id,
          note: `Pickup blocked and escalated: ${failedCheckCodes.join(", ")}`,
          escalationId: escalation.id,
        });
        for (const membership of privilegedAdminMemberships(store)) {
          store.notifications.push({
            id: id("ntf"),
            userId: membership.userId,
            appRole: membership.role,
            type: "pickup_check_escalation",
            orderId: order.id,
            title: "Pickup blocked by a failed quality check",
            body: `${failureNote} The rider is waiting for Operations instruction.`,
            read: false,
            at: checkedAt,
          });
        }
        audit(store, {
          actor: user,
          action: "pickup_checklist.escalate",
          entityType: "escalation",
          entityId: escalation.id,
          orderId: order.id,
          detail: { failedCheckCodes, evidenceFileIds },
          reason: failureNote,
        });
        queueInvalidate(store, { resource: "escalations", id: escalation.id, riderId: user.id });
        queueOrderInvalidate(store, order, ["orders"]);
        await save(store);
        return send(res, 200, { order: publicOrder(order, user, store), escalation });
      }

      order.pickupChecklist = {
        status: "passed",
        checks: structuredClone(checks),
        evidenceFileIds: [],
        failureNote: null,
        completedAt: checkedAt,
        completedBy: user.id,
        escalationId: order.pickupChecklist?.escalationId || null,
        signOffPrompt: PICKUP_SIGN_OFF_PROMPT,
      };
      order.state = "picked_up";
      order.updatedAt = checkedAt;
      order.timeline.push({
        at: checkedAt,
        state: "picked_up",
        by: user.id,
        note: "All six pickup checks passed; rider prompted to give the trained verbal sign-off",
      });
      notifyOrderParties(store, order, { createId: id, at: checkedAt });
      queueOrderInvalidate(store, order, ["orders", "jobs"]);
      await save(store);
      return send(res, 200, {
        order: publicOrder(order, user, store),
        signOffPrompt: PICKUP_SIGN_OFF_PROMPT,
      });
    }

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/location$/.test(pathname)) {
      if (user.role !== "rider" || !approvedRole(store,user.id,"rider")) return send(res, 403, { error: "forbidden" });
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((o) => o.id === orderId && o.riderId === user.id);
      if (!order) return send(res, 404, { error: "order_not_found" });
      if (!["picked_up", "out_for_delivery"].includes(order.state)) {
        return send(res, 409, { error: "tracking_not_active", state: order.state });
      }
      const body = await readBody(req);
      const sourceMs = body.recordedAt == null ? Date.now() : Date.parse(body.recordedAt);
      if (!Number.isFinite(sourceMs)) return send(res,400,{error:"invalid_location_timestamp"});
      const recordedAt = new Date(sourceMs).toISOString();
      const fixMs = Date.parse(recordedAt);
      if (!Number.isFinite(fixMs) || fixMs > Date.now()+30000 || fixMs < Date.now()-5*60*1000) return send(res,400,{error:'invalid_location_timestamp'});
      if (!Number.isFinite(body.lat) || Math.abs(body.lat)>90 || !Number.isFinite(body.lng) || Math.abs(body.lng)>180 || (body.accuracy != null && (!Number.isFinite(body.accuracy) || body.accuracy < 0))) return send(res,400,{error:'invalid_location'});
      const latest = store.locationPings.filter(p=>p.orderId===orderId&&p.riderId===order.riderId).sort((a,b)=>b.at.localeCompare(a.at))[0];
      if (latest && Date.parse(latest.at)>=fixMs) return send(res,200,{ping:latest,ignored:true});
      const ping = {
        id: id("ping"),
        orderId,
        riderId: user.id,
        lat: Number(body.lat),
        lng: Number(body.lng),
        accuracy: body.accuracy ?? null,
        at: recordedAt,
      };
      store.locationPings.push(ping);
      await save(store);
      return send(res, 201, { ping });
    }

    // Latest rider location for tracking (assigned rider, client, supplier, ops/super).
    if (req.method === "GET" && /^\/dispatch\/[^/]+\/location$/.test(pathname)) {
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((o) => o.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      if (!canViewOrderLocation(user, order, store)) return send(res, 403, { error: "forbidden" });
      const pings = store.locationPings.filter((p) => p.orderId === orderId && p.riderId === order.riderId);
      if (!pings.length) return send(res, 200, { ping: null });
      const ping = pings.reduce((latest, p) => (p.at > latest.at ? p : latest), pings[0]);
      return send(res, 200, { ping });
    }

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/delivery$/.test(pathname)) {
      if (user.role !== "rider" || !approvedRole(store,user.id,"rider")) return send(res, 403, { error: "forbidden" });
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((candidate) => candidate.id === orderId && candidate.riderId === user.id);
      if (!order) return send(res, 404, { error: "order_not_found" });
      if (!["picked_up", "out_for_delivery"].includes(order.state)) {
        return send(res, 409, {
          error: "delivery_not_available",
          message: "Complete the pickup checklist and begin transport before recording delivery.",
          state: order.state,
        });
      }
      /*
       Money is owed by whoever is being handed the job.

       On a delivery that is the client at their own door, so the rider holds
       the package until the balance clears. A collected job is only being put
       on GRIDGO's own shelf; blocking that strands a rider at our office
       waiting on something no one present can do, and the job can never move
       again. The gate moves to the counter, where the client actually is.
      */
      if (!carriedToOffice(order) && order.payments?.final_online?.status !== "confirmed") {
        return send(res, 409, {
          error: "final_payment_not_confirmed",
          message: "Operations must confirm the client's final online payment before the rider completes delivery.",
        });
      }
      if (order.moneyModelVersion === 1) {
        const deliveredMilestone = (order.payoutMilestones || []).find((milestone) => milestone.code === "delivered");
        if (!deliveredMilestone?.pofFileIds?.length) {
          return send(res, 409, {
            error: "pof_required",
            message: "Attach the delivered Proof of Fulfilment before completing this legacy delivery.",
            milestoneCode: "delivered",
          });
        }
      }
      const body = await readBody(req);
      if (!["photo", "signature"].includes(body.evidenceType)) {
        return send(res, 400, {
          error: "invalid_delivery_evidence_type",
          message: "Choose photo evidence, or signature only when the camera cannot be used.",
          allowed: ["photo", "signature"],
        });
      }
      const evidenceFileId = String(body.evidenceFileId || "");
      if (!attachedReadyOrderFile(store, order, evidenceFileId, "delivery_photo", user.id)) {
        return send(res, 400, {
          error: "delivery_evidence_required",
          message: "Attach the delivery photo or signature image to this order before completing delivery.",
        });
      }
      const deliveredAt = now();
      order.deliveryEvidence = {
        fileId: evidenceFileId,
        evidenceType: body.evidenceType,
        riderId: user.id,
        recordedAt: deliveredAt,
      };
      if (carriedToOffice(order)) {
        order.state = "awaiting_collection";
        order.awaitingCollectionAt = deliveredAt;
        order.updatedAt = deliveredAt;
        order.timeline.push({
          at: deliveredAt,
          state: "awaiting_collection",
          by: user.id,
          note: "Left at GRIDGO Office for the client to collect",
          fileId: evidenceFileId,
        });
        notifyOrderParties(store, order, { createId: id, at: deliveredAt });
        queueOrderInvalidate(store, order, ["orders", "jobs"]);
        await save(store);
        return send(res, 200, { order: publicOrder(order, user, store) });
      }
      order.state = "delivered";
      order.timeline.push({
        at: deliveredAt,
        state: "delivered",
        by: user.id,
        note: body.evidenceType === "photo" ? "Delivery completed with photo evidence" : "Delivery completed with signature evidence",
        fileId: evidenceFileId,
      });
      order.issueWindowOpenedAt = deliveredAt;
      order.issueWindowExpiresAt = issueWindowExpiresAt(deliveredAt, store.settings.issueWindowHours);
      order.state = "issue_window_open";
      order.updatedAt = deliveredAt;
      order.timeline.push({
        at: deliveredAt,
        state: "issue_window_open",
        by: "system",
        note: `Issue window opened for ${store.settings.issueWindowHours} hours`,
      });
      notifyOrderParties(store, order, { createId: id, at: deliveredAt });
      queueOrderInvalidate(store, order, ["orders", "jobs"]);
      await save(store);
      return send(res, 200, { order: publicOrder(order, user, store) });
    }

    /*
     The counter hand-over: the second ending a collected job has.

     A rider's proof says the job reached our shelf, which is not the same as
     the client having it. This is the moment it leaves GRIDGO -- so it is the
     moment the balance has to be settled, and the moment the complaint window
     starts running.
    */
    if (req.method === "POST" && /^\/orders\/[^/]+\/collection$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((candidate) => candidate.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      if (order.state !== "awaiting_collection") {
        return send(res, 409, {
          error: "collection_not_available",
          message: "This order is not waiting at the counter. Refresh it to see where it actually is.",
          state: order.state,
        });
      }
      if (order.payments?.final_online?.status !== "confirmed") {
        return send(res, 409, {
          error: "final_payment_not_confirmed",
          message: "Confirm the client's remaining balance before releasing this order at the counter.",
        });
      }
      const body = await readBody(req);
      const receivedBy = String(body.receivedBy || "").trim();
      if (!receivedBy) {
        return send(res, 400, {
          error: "collector_name_required",
          message: "Record who collected this order. A counter hand-over with no name cannot be checked later.",
        });
      }
      const collectedAt = now();
      order.collection = { receivedBy, recordedBy: user.id, at: collectedAt };
      order.state = "delivered";
      order.timeline.push({
        at: collectedAt,
        state: "delivered",
        by: user.id,
        note: `Collected at GRIDGO Office by ${receivedBy}`,
      });
      order.issueWindowOpenedAt = collectedAt;
      order.issueWindowExpiresAt = issueWindowExpiresAt(collectedAt, store.settings.issueWindowHours);
      order.state = "issue_window_open";
      order.updatedAt = collectedAt;
      order.timeline.push({
        at: collectedAt,
        state: "issue_window_open",
        by: "system",
        note: `Issue window opened for ${store.settings.issueWindowHours} hours`,
      });
      notifyOrderParties(store, order, { createId: id, at: collectedAt });
      audit(store, {
        actor: user,
        action: "order_collected",
        entityType: "order",
        entityId: order.id,
        orderId: order.id,
        detail: { receivedBy },
      });
      queueOrderInvalidate(store, order, ["orders"]);
      await save(store);
      return send(res, 200, { order: publicOrder(order, user, store) });
    }

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/proof$/.test(pathname)) {
      return send(res, 410, {
        error: "dispatch_proof_route_retired",
        message: "Use the pickup checklist or delivery evidence route. Direct proof names and cash collection are no longer accepted.",
      });
    }

    // ---- supplier jobs helper alias ----
    if (req.method === "GET" && pathname === "/jobs") {
      if (!approvedRole(store,user.id,"supplier")) return send(res, 403, { error: "forbidden" });
      return send(res, 200, {
        jobs: store.orders
          .filter((o) => o.supplierId === user.id)
          .map((order) => publicOrder(order, user, store)),
      });
    }

    return send(res, 404, { error: "not_found", path: pathname });
  } catch (err) {
    database.markRollback();
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    if (err instanceof AttachmentError || (err && Number.isInteger(err.status) && err.code)) {
      return sendDomainError(res, err, { afterCommit: false });
    }
    console.error(err);
    return send(res, 500, {
      error: "server_error",
      message: "GRIDGO could not complete that request. Try again, or check the API log if the problem continues.",
    }, { afterCommit: false });
  }
}

function logHttpRequest(req, res, pathname, started) {
  if (req.method === "GET" && pathname === "/health") return;
  res.on("finish", () => {
    const claims = req.gridgoVerifiedClaims?.claims;
    let clerk = "clerk=none";
    if (claims?.sub) clerk = `clerk=${String(claims.sub).slice(0, 10)}…`;
    else if (hasBearerToken(req)) clerk = "clerk=unverified";
    const error = res.gridgoError ? ` error=${res.gridgoError}` : "";
    const fields =
      Array.isArray(res.gridgoErrorFields) && res.gridgoErrorFields.length
        ? ` fields=${res.gridgoErrorFields.join(",")}`
        : "";
    console.log(
      `[gridgo-api] ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms auth=${hasBearerToken(req) ? "bearer" : "none"} ${clerk}${error}${fields}`,
    );
  });
}

const server = http.createServer((req, res) => {
  // The same WHATWG normalization handleRequest routes on — a raw string split
  // would let dot-segment paths reach a route the dispatch classified
  // differently.
  let pathname = "/";
  try {
    pathname = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
  } catch {
    // handleRequest fails the same parse and answers 500 itself.
  }
  logHttpRequest(req, res, pathname, Date.now());
  const mutatesStore = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
  // File transfers and MinIO calls stay outside database transactions. File routes
  // acquire one only for short load -> validate -> mutate -> commit sections.
  const isSelfQueuedFileMutation =
    (req.method === "POST" && pathname === "/files") ||
    (req.method === "POST" && /^\/files\/[^/]+\/attach$/.test(pathname)) ||
    (req.method === "DELETE" && /^\/files\/[^/]+$/.test(pathname));
  if (isSelfQueuedFileMutation) {
    void handleRequest(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/webhooks/clerk") {
    // Raw body and Svix headers are the credential. The generic mutation
    // path would parse JSON first and demand a Clerk session JWT.
    void enqueueMutation(() => handleRequest(req, res)).catch((error) => {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      if (error instanceof AttachmentError || (error && Number.isInteger(error.status) && error.code)) {
        sendDomainError(res, error);
        return;
      }
      send(res, 500, {
        error: "server_error",
        message: "GRIDGO could not read that request. Try again, or check the API log if the problem continues.",
      });
    });
    return;
  }
  if (mutatesStore && isSupportDeskRoute(pathname)) {
    // Public ticket submit and the desk JWT are not Clerk. They commit under
    // their own advisory lock inside the handler, the same way anonymous
    // device registration does, so they never wait on JWKS or the domain lock.
    void readBody(req)
      .then(() => handleRequest(req, res))
      .catch((error) => {
        if (res.headersSent) {
          res.destroy(error);
          return;
        }
        if (error instanceof AttachmentError || (error && Number.isInteger(error.status) && error.code)) {
          sendDomainError(res, error);
          return;
        }
        send(res, 500, {
          error: "server_error",
          message: "GRIDGO could not read that request. Try again, or check the API log if the problem continues.",
        });
      });
    return;
  }
  if (mutatesStore) {
    // Only a mutation bearing a verified Clerk subject enters the global
    // domain transaction. Without one, no store-mutating route is reachable:
    // anonymous or garbage-token requests end at 401/404, and the two
    // documented anonymous device routes commit through their own targeted
    // device-token transaction inside handleRequest.
    void readBody(req)
      .then(() => verifyClerkBeforeMutation(req, pathname))
      .then((verified) =>
        verified?.claims?.sub
          ? enqueueMutation(() => handleRequest(req, res))
          : handleRequest(req, res),
      )
      .catch((error) => {
        if (res.headersSent) {
          res.destroy(error);
          return;
        }
        if (error instanceof AttachmentError || (error && Number.isInteger(error.status) && error.code)) {
          sendDomainError(res, error);
          return;
        }
        send(res, 500, {
          error: "server_error",
          message: "GRIDGO could not read that request. Try again, or check the API log if the problem continues.",
        });
      });
    return;
  }
  void handleRequest(req, res);
});

server.requestTimeout = Number(process.env.UPLOAD_REQUEST_TIMEOUT_MS || 15 * 60 * 1000);

async function reconcileInterruptedFiles() {
  const candidates = (await load()).files.filter(
    (file) => ["pending_upload", "delete_pending"].includes(file.state) && file.objectKey,
  );
  for (const candidate of candidates) {
    try {
      await objectStorage.deleteObject(candidate.objectKey);
      await enqueueMutation(async () => {
        const latestStore = await load();
        const latestFile = findFile(latestStore, candidate.fileId);
        if (!latestFile || !["pending_upload", "delete_pending"].includes(latestFile.state)) return;
        markFileDeleted(latestFile, now());
        await save(latestStore);
      });
    } catch {
      // Leave the durable pending state for the next boot; non-file routes remain usable.
    }
  }
}

const drainPushOutbox = createOutboxWorker({database,loadStore,delivery:pushDelivery});
let lifecycleBusy = false;
async function runLifecycleWork() {
  if (lifecycleBusy) return;
  lifecycleBusy = true;
  try { await expireElapsedIssueWindows(); await drainPushOutbox(); }
  catch(error) { console.warn(`lifecycle worker failed: ${error?.code || 'unavailable'}`); }
  finally { lifecycleBusy = false; }
}
// Migrations and the reference seed are explicit operator steps. Boot never
// creates schema or data; it refuses before listening when PostgreSQL is not ready.
await database.assertReady();
await realtimeTransport.start();
await seedSupportDeskAdmin(database);

server.listen(PORT, HOST, () => {
  const lifecycleTimer = setInterval(runLifecycleWork, Math.max(1000,Number(process.env.GRIDGO_LIFECYCLE_INTERVAL_MS)||30000));
  lifecycleTimer.unref();
  void runLifecycleWork();
  console.log(`gridgo-api listening on http://${HOST}:${PORT}`);
  console.log(`health: http://127.0.0.1:${PORT}/health`);
  objectStorage
    .ensureBucket()
    .then(async () => {
      await reconcileInterruptedFiles();
      console.log(`MinIO ready: ${objectStorage.health().bucket}`);
    })
    .catch(() => {
      console.warn("MinIO unavailable; non-file routes remain available. Start it with `docker compose up -d`.");
    })
    .finally(() => {
      storageInitializing = false;
    });
});
