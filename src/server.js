import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DEMO_USERS } from "./demo-fixtures.js";
import {
  AttachmentError,
  attachFileReference,
  authorizeFileAttach,
  authorizeFileAttachOwner,
  authorizeFileRead,
  authorizeFileUpload,
  backfillFiles,
  createPendingFile,
  findFile,
  markFileDeleted,
  markFileDeletePending,
  markFileReady,
  parseMultipartStream,
  publicFile,
  resolveFileTarget,
  validateUpload,
} from "./attachments.js";
import { createMutationQueue } from "./mutation-queue.js";
import {
  backfillNotifications,
  createNotificationEvents,
  formatNotificationEvent,
  notificationSnapshot,
} from "./notifications.js";
import { createObjectStorage } from "./object-storage.js";
import {
  backfillTaxonomy,
  buildCategoryTree,
  defaultTaxonomy,
  resolveCategoryCode,
} from "./taxonomy.js";
import {
  backfillOperationalModel,
  calculateFinalPrice,
  createPayoutMilestones,
  defaultOperationalSettings,
  estimatePriceRange,
  issueWindowExpiresAt,
  PICKUP_CHECK_CODES,
  PICKUP_SIGN_OFF_PROMPT,
  publicOrderFor,
  releaseMilestone,
  validateOperationalSettings,
} from "./operational-model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEFAULT_STORE = path.join(ROOT, "data", "store.json");
const STORE = process.env.STORE_PATH ? path.resolve(process.env.STORE_PATH) : DEFAULT_STORE;
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const objectStorage = createObjectStorage(process.env);
const enqueueMutation = createMutationQueue();
const notificationEvents = createNotificationEvents();
const NOTIFICATION_HEARTBEAT_MS = Number(process.env.NOTIFICATION_HEARTBEAT_MS || 25_000);
const STORE_NOTIFICATION_IDS = Symbol("storeNotificationIds");
let storageInitializing = true;

// Auto-seed if missing
if (!fs.existsSync(STORE)) {
  if (STORE !== DEFAULT_STORE) {
    throw new Error(`STORE_PATH does not exist: ${STORE}`);
  }
  spawnSync(process.execPath, [path.join(__dirname, "seed.js"), "--reset"], { stdio: "inherit" });
}

function save(store) {
  const previousNotificationIds = store[STORE_NOTIFICATION_IDS] || new Set();
  const createdNotifications = (store.notifications || []).filter(
    (notification) => !previousNotificationIds.has(notification.id),
  );
  const temporary = `${STORE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2));
  fs.renameSync(temporary, STORE);
  store[STORE_NOTIFICATION_IDS] = new Set((store.notifications || []).map((notification) => notification.id));
  for (const notification of createdNotifications) notificationEvents.publish(notification);
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
      const latestStore = load();
      const latestFile = findFile(latestStore, fileId);
      if (latestFile?.state !== "pending_upload") return;
      markFileDeleted(latestFile, now());
      save(latestStore);
    });
  } catch {
    // The pending record is the durable reconciliation marker for the next successful boot.
  }
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Last-Event-ID",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  });
  res.end(payload);
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

function sendDomainError(res, error) {
  return send(res, error.status || 500, {
    error: error.code || "server_error",
    message: error.message,
    ...(error.details || {}),
  });
}

function authUser(req, store) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const session = store.sessions[m[1]];
  if (!session) return null;
  return store.users.find((u) => u.id === session.userId) || null;
}

/** Client account types for branding (GRIDGO vs GRIDGO Business). Not inferred from orgName. */
const CLIENT_ACCOUNT_TYPES = new Set(["individual", "business", "organization"]);

/**
 * Safe default when a client has no recorded type: individual.
 * Business branding must be explicit opt-in, never accidental from orgName or legacy data.
 */
function resolveClientAccountType(u) {
  if (u && CLIENT_ACCOUNT_TYPES.has(u.accountType)) return u.accountType;
  return "individual";
}

function publicUser(u) {
  if (!u) return null;
  const { password, ...rest } = u;
  // Identity-document references are exposed only through the dedicated, caller-aware
  // verification projection. publicUser is reused in catalogue and matching responses.
  delete rest.verificationDocumentFileIds;
  // Clients always expose an authoritative accountType (never undefined for consumers).
  // Non-client roles omit the field — same pattern as orgName / shop / verificationStatus.
  if (u.role === "client") {
    rest.accountType = resolveClientAccountType(u);
  } else {
    delete rest.accountType;
  }
  return rest;
}

function isOps(user) {
  return user && (user.role === "ops_admin" || user.role === "super_admin");
}

function isSuper(user) {
  return user && user.role === "super_admin";
}

function signupError(res, error, message, details = {}) {
  return send(res, 400, { error, message, ...details });
}

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

function normalizedSignupAccountType(value) {
  return value === "personal" ? "individual" : value;
}

function validatedCategoryRanks(store, value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const canonical = [];
  const seen = new Set();
  for (const item of value) {
    const category = activeCategoryFor(store.taxonomy, item?.categoryCode);
    const rank = Number(item?.rank);
    if (!category || !Number.isInteger(rank) || rank < 1 || seen.has(category.code)) return null;
    seen.add(category.code);
    canonical.push({ categoryCode: category.code, rank });
  }
  canonical.sort((a, b) => a.rank - b.rank);
  if (canonical.some((item, index) => item.rank !== index + 1)) return null;
  return canonical;
}

function hasSignupShop(value) {
  return Boolean(validatedShop(value).shop);
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

/** Default shop for suppliers that predate geography (stable Davao downtown pin). */
function defaultShopFor(supplier) {
  const name = supplier.supplierName || supplier.name || "Supplier";
  return {
    lat: 7.064,
    lng: 125.6085,
    label: `${name}, C.M. Recto St`,
  };
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

function setOrderPickup(order, store) {
  if (!order.supplierId) {
    order.pickup = null;
    return;
  }
  const supplier = store.users.find((u) => u.id === order.supplierId);
  order.pickup = pickupFromSupplier(supplier);
}

// ---------------------------------------------------------------------------
// Default platform data (used by seed + idempotent backfill)
// ---------------------------------------------------------------------------

function defaultZones() {
  return [
    { id: "zone_central", code: "davao_central", name: "Davao Central (Bajada / JP Laurel)", active: true },
    { id: "zone_south", code: "davao_south", name: "Davao South (Matina)", active: true },
    { id: "zone_north", code: "davao_north", name: "Davao North (Lanang)", active: true },
    { id: "zone_west", code: "davao_west", name: "Davao West (Toril side)", active: true },
    { id: "zone_east", code: "davao_east", name: "Davao East (Buhangin / Sasa)", active: true },
  ];
}

/**
 * Append an audit log entry. Separate from order.timeline:
 * - order.timeline = per-order state machine history (clients/suppliers/riders see it on the order)
 * - auditLog = platform-wide immutable record for ops/super (role changes, grants, verification,
 *   taxonomy, claims, issues, matching decisions, etc.) that is not order-scoped only
 */
function audit(store, { actor, action, entityType, entityId, detail, reason, orderId }) {
  if (!Array.isArray(store.auditLog)) store.auditLog = [];
  const entry = {
    id: id("aud"),
    at: now(),
    actorId: actor?.id || null,
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
 * Idempotent geography backfill for stores that predate pickup/dropoff/shop.
 * Only fills missing coords; never overwrites existing ones. Returns true if mutated.
 */
function backfillGeography(store) {
  let changed = false;

  for (const u of store.users || []) {
    if (u.role === "supplier" && !hasCoords(u.shop)) {
      u.shop = defaultShopFor(u);
      changed = true;
    }
  }

  for (const order of store.orders || []) {
    if (!hasCoords(order.dropoff)) {
      order.dropoff = dropoffFor(order.address, order.zone || "davao_central");
      changed = true;
    }
    if (order.supplierId && !hasCoords(order.pickup)) {
      const supplier = (store.users || []).find((u) => u.id === order.supplierId);
      const pickup = pickupFromSupplier(supplier);
      if (pickup) {
        order.pickup = pickup;
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * Idempotent backfill: every client user gets accountType.
 * Missing → "individual" (safe default; never overwrite an existing valid value).
 * Non-clients are left unchanged (field absent). Returns true if mutated.
 *
 * Distinct from convergeDemoFixtures: this only fills missing/invalid types and
 * never upgrades a recorded "individual" to "business".
 */
function backfillAccountType(store) {
  let changed = false;
  for (const u of store.users || []) {
    if (u.role !== "client") continue;
    if (!CLIENT_ACCOUNT_TYPES.has(u.accountType)) {
      u.accountType = "individual";
      changed = true;
    }
  }
  return changed;
}

/** Structural equality for fixture scalars and small plain objects (e.g. shop). */
function fixtureValueEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function cloneFixtureValue(value) {
  if (value == null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Bring seed demo accounts (fixtures) up to their defined state on an existing store.
 *
 * Fixture boundary (must stay tight — wrong match eats captain data):
 * - Only emails/ids listed in DEMO_USERS from demo-fixtures.js are fixtures.
 * - Match by exact email first, else by stable seed id. Never by role or domain alone.
 * - Create a fixture user when missing; converge only attributes defined on the fixture.
 * - Never renumber an existing user's id (orders/credits FK safety).
 * - Never touch orders, credits, proofs, claims, issues, sessions, locationPings,
 *   notifications, catalog, taxonomy, zones, supplierServices, or auditLog.
 * - Never create/modify non-fixture users (captain-created accounts).
 *
 * Distinct from backfillAccountType: backfill only fills *missing* accountType with
 * "individual"; fixture convergence *overwrites* fixture fields so client@ becomes
 * business as the seed defines, even when a prior backfill left "individual".
 *
 * Returns true if the store was mutated.
 */
function convergeDemoFixtures(store) {
  let changed = false;
  if (!Array.isArray(store.users)) {
    store.users = [];
    changed = true;
  }

  for (const fixture of DEMO_USERS) {
    let user = store.users.find((u) => u.email === fixture.email);
    if (!user) {
      user = store.users.find((u) => u.id === fixture.id);
    }

    if (!user) {
      const created = {};
      for (const [key, value] of Object.entries(fixture)) {
        created[key] = cloneFixtureValue(value);
      }
      // Approved supplier/rider fixtures need verification timestamps once on create.
      if (created.verificationStatus === "approved" && created.verifiedAt == null) {
        created.verifiedAt = now();
      }
      store.users.push(created);
      changed = true;
      continue;
    }

    // Converge fixture-owned attributes only. Leave id and any extra keys alone.
    for (const [key, value] of Object.entries(fixture)) {
      if (key === "id") continue;
      if (!fixtureValueEqual(user[key], value)) {
        user[key] = cloneFixtureValue(value);
        changed = true;
      }
    }
    // If fixture requires approved verification but store never recorded a stamp, set once.
    if (
      fixture.verificationStatus === "approved" &&
      user.verificationStatus === "approved" &&
      user.verifiedAt == null
    ) {
      user.verifiedAt = now();
      changed = true;
    }
  }

  return changed;
}

/**
 * Idempotent backfill for ops/super-admin platform records (taxonomy, services, zones,
 * claims, issues, audit). Never overwrites existing arrays/objects; never deletes orders.
 */
function backfillPlatform(store) {
  let changed = false;

  if (!store.taxonomy || !Array.isArray(store.taxonomy.categories)) {
    store.taxonomy = defaultTaxonomy();
    changed = true;
  } else {
    if (!Array.isArray(store.taxonomy.materials)) {
      store.taxonomy.materials = defaultTaxonomy().materials;
      changed = true;
    }
    if (!Array.isArray(store.taxonomy.finishes)) {
      store.taxonomy.finishes = defaultTaxonomy().finishes;
      changed = true;
    }
  }

  if (!Array.isArray(store.zones) || store.zones.length === 0) {
    store.zones = defaultZones();
    changed = true;
  }
  if (!Array.isArray(store.supplierServices)) {
    store.supplierServices = [];
    changed = true;
  }

  if (!Array.isArray(store.claims)) {
    store.claims = [];
    changed = true;
  }

  if (!Array.isArray(store.issues)) {
    store.issues = [];
    changed = true;
  }

  if (!Array.isArray(store.auditLog)) {
    store.auditLog = [];
    changed = true;
  }

  if (!store.credits || typeof store.credits !== "object") {
    store.credits = {};
    changed = true;
  }

  for (const u of store.users || []) {
    if (u.role === "supplier") {
      if (u.verificationStatus == null) {
        // Demo supplier is treated as accredited so matching works without reset
        u.verificationStatus = u.id === "user_supplier" ? "approved" : "unverified";
        changed = true;
      }
      if (u.verificationNote == null) {
        u.verificationNote = u.verificationStatus === "approved" ? "Pilot accredited" : null;
        changed = true;
      }
      if (u.verifiedAt == null && u.verificationStatus === "approved") {
        u.verifiedAt = now();
        changed = true;
      }
      if (u.verifiedBy == null && u.verificationStatus === "approved") {
        u.verifiedBy = "user_admin";
        changed = true;
      }
    }
  }

  // If no services at all, seed a live catalogue for the demo supplier (idempotent key)
  if (store.supplierServices.length === 0) {
    const demoSupplier = (store.users || []).find((u) => u.id === "user_supplier" || (u.role === "supplier" && u.email === "supplier@gridgo.local"));
    if (demoSupplier) {
      const ts = now();
      store.supplierServices.push(
        {
          id: "svc_demo_tarpaulin",
          supplierId: demoSupplier.id,
          categoryCode: "marketing_collateral",
          materialCodes: ["tarpaulin_13oz", "mesh_banner"],
          finishCodes: ["hem_grommet", "none"],
          productFamilyIds: ["banner"],
          sizeMin: "1x1 ft",
          sizeMax: "10x30 ft",
          qtyMin: 1,
          qtyMax: 50,
          pricingBasis: "per_sqm",
          referenceRateMinor: 45000,
          turnaroundHours: 24,
          capacityDaily: 20,
          capacityWeekly: 100,
          zones: ["davao_central", "davao_south", "davao_north", "davao_east"],
          equipmentNotes: "Solvent large-format printer + welding table",
          state: "live",
          verifiedAt: ts,
          verifiedBy: "user_admin",
          suspendedAt: null,
          suspendedBy: null,
          suspendReason: null,
          withdrawnAt: null,
          createdAt: ts,
          updatedAt: ts,
        },
        {
          id: "svc_demo_print",
          supplierId: demoSupplier.id,
          categoryCode: "marketing_collateral",
          materialCodes: ["matte_150gsm", "gloss_cardstock", "vinyl_sticker"],
          finishCodes: ["lamination", "kiss_cut", "none"],
          productFamilyIds: ["flyer", "card", "sticker"],
          sizeMin: "A6",
          sizeMax: "A3",
          qtyMin: 50,
          qtyMax: 10000,
          pricingBasis: "per_pack",
          referenceRateMinor: 2500,
          turnaroundHours: 48,
          capacityDaily: 40,
          capacityWeekly: 200,
          zones: ["davao_central", "davao_south", "davao_north", "davao_west", "davao_east"],
          equipmentNotes: "Digital press + guillotine",
          state: "live",
          verifiedAt: ts,
          verifiedBy: "user_admin",
          suspendedAt: null,
          suspendedBy: null,
          suspendReason: null,
          withdrawnAt: null,
          createdAt: ts,
          updatedAt: ts,
        },
      );
      changed = true;
    }
  }

  return changed;
}

function load() {
  const store = JSON.parse(fs.readFileSync(STORE, "utf8"));
  Object.defineProperty(store, STORE_NOTIFICATION_IDS, {
    value: new Set((store.notifications || []).map((notification) => notification.id)),
    writable: true,
  });
  let changed = false;
  if (backfillGeography(store)) changed = true;
  if (backfillPlatform(store)) changed = true;
  // After backfillPlatform, which guarantees store.taxonomy and its arrays exist.
  if (backfillTaxonomy(store)) changed = true;
  if (backfillFiles(store)) changed = true;
  if (backfillNotifications(store)) changed = true;
  if (backfillAccountType(store)) changed = true;
  // Fixtures last so seed-defined demo identity wins over fill-missing defaults
  // (e.g. client@ accountType business after a prior individual backfill).
  if (convergeDemoFixtures(store)) changed = true;
  if (backfillOperationalModel(store, now())) changed = true;
  if (changed) save(store);
  return store;
}

function canViewOrderLocation(user, order) {
  if (!user || !order) return false;
  if (user.role === "ops_admin" || user.role === "super_admin") return true;
  if (user.role === "rider" && order.riderId === user.id) return true;
  if (user.role === "client" && order.clientId === user.id) return true;
  if (user.role === "supplier" && order.supplierId === user.id) return true;
  return false;
}

function ordersFor(user, store) {
  if (user.role === "client") return store.orders.filter((o) => o.clientId === user.id);
  if (user.role === "supplier") return store.orders.filter((o) => o.supplierId === user.id);
  if (user.role === "rider") {
    if (user.verificationStatus !== "approved") {
      return store.orders.filter((o) => o.riderId === user.id);
    }
    return store.orders.filter(
      (o) => o.riderId === user.id || ["ready_for_dispatch", "rider_assigned", "picked_up", "out_for_delivery"].includes(o.state),
    );
  }
  // ops / super see all
  return store.orders;
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

function publicOrder(order, user) {
  return publicOrderFor(order, user);
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
  const suppliers = (store.users || []).filter((u) => u.role === "supplier");
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
  },
  client_correction: { submitted: ["client"] },
  proof_approval: {
    approved_for_matching: ["client"],
    client_correction: ["client"],
  },
  approved_for_matching: { supplier_assigned: ["ops_admin", "super_admin"] },
  supplier_assigned: {
    supplier_accepted: ["supplier"],
    approved_for_matching: ["supplier"], // decline -> rematch
  },
  awaiting_downpayment: {},
  downpayment_review: {},
  payment_authorized: { production: ["supplier"] },
  production: { supplier_self_qc: ["supplier"] },
  supplier_self_qc: { ready_for_dispatch: ["supplier"] },
  ready_for_dispatch: { rider_assigned: ["rider", "ops_admin", "super_admin"] },
  rider_assigned: {},
  picked_up: { out_for_delivery: ["rider"] },
  out_for_delivery: {},
  delivered: { issue_window_open: ["system", "ops_admin", "super_admin", "client", "rider"] },
  issue_window_open: {}, // load-time expiry completes; no actor may close it early
  completed: { payout_released: ["ops_admin", "super_admin"] },
};

async function handleRequest(req, res) {
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const { pathname } = url;
    const store = load();

    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, {
        ok: true,
        service: "gridgo-api",
        version: store.version,
        storage: objectStorage.health(),
        at: now(),
      });
    }

    // ---- auth ----
    if (req.method === "POST" && pathname === "/auth/signup") {
      const body = await readBody(req);
      const role = String(body.role || "");
      const allowedRoles = ["client", "supplier", "rider"];
      if (!allowedRoles.includes(role)) {
        return signupError(
          res,
          "invalid_signup_role",
          "Choose client, supplier, or rider for this account.",
          { allowedRoles },
        );
      }
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const name = String(body.name || "").trim();
      const phone = String(body.phone || "").trim();
      if (!email || !email.includes("@")) {
        return signupError(res, "invalid_email", "Enter a complete email address, then try again.");
      }
      if (store.users.some((candidate) => String(candidate.email).toLowerCase() === email)) {
        return send(res, 409, {
          error: "email_already_registered",
          message: "This email already has a GRIDGO account. Sign in or use a different email address.",
        });
      }
      if (password.length < 8) {
        return signupError(res, "invalid_password", "Use a password with at least 8 characters.");
      }
      if (!name) return signupError(res, "name_required", "Enter the account holder's full name.");
      if (!phone) return signupError(res, "phone_required", "Enter a phone number Operations can use for this account.");

      const createdAt = now();
      const created = { id: id("user"), email, password, name, phone, role, createdAt };
      if (role === "client") {
        const accountType = normalizedSignupAccountType(body.accountType);
        if (!CLIENT_ACCOUNT_TYPES.has(accountType)) {
          return signupError(
            res,
            "invalid_account_type",
            "Choose personal, business, or organization for this client account.",
            { allowed: ["individual", "business", "organization"], inputAlias: { personal: "individual" } },
          );
        }
        const orgName = String(body.orgName || "").trim();
        if (["business", "organization"].includes(accountType) && !orgName) {
          return signupError(
            res,
            "organization_name_required",
            "Enter the business or organization name used on this account.",
          );
        }
        created.accountType = accountType;
        if (orgName) created.orgName = orgName;
      }
      if (role === "supplier") {
        const supplierName = String(body.supplierName || "").trim();
        if (!supplierName) {
          return signupError(res, "supplier_name_required", "Enter the supplier shop or trading name.");
        }
        if (!hasSignupShop(body.shop)) {
          return signupError(
            res,
            "shop_location_required",
            "Pin the supplier shop and add its address label before creating the account.",
          );
        }
        const categoryRanks = validatedCategoryRanks(store, body.categoryRanks);
        if (!categoryRanks) {
          return signupError(
            res,
            "invalid_category_ranks",
            "Rank at least one active service category from 1 with no gaps or duplicates.",
          );
        }
        created.supplierName = supplierName;
        created.shop = validatedShop(body.shop).shop;
        created.categoryRanks = categoryRanks;
        created.verificationDocumentFileIds = [];
        created.verificationStatus = "pending";
        created.verificationNote = "Operations review required before matching";
        created.verifiedAt = null;
        created.verifiedBy = null;
      }
      if (role === "rider") {
        const profile = body.riderProfile;
        const vehicleType = String(profile?.vehicleType || "").trim();
        const vehiclePlate = String(profile?.vehiclePlate || "").trim();
        const licenseNumber = String(profile?.licenseNumber || "").trim();
        if (!vehicleType || !vehiclePlate || !licenseNumber) {
          return signupError(
            res,
            "invalid_rider_profile",
            "Enter the rider's vehicle type, plate number, and driving licence number.",
          );
        }
        created.riderProfile = { vehicleType, vehiclePlate, licenseNumber };
        created.verificationStatus = "pending";
        created.verificationNote = "Operations review required before dispatch";
        created.verifiedAt = null;
        created.verifiedBy = null;
      }

      const token = id("tok");
      store.users.push(created);
      store.sessions[token] = { userId: created.id, createdAt };
      save(store);
      return send(res, 201, { token, user: publicUser(created) });
    }

    if (req.method === "POST" && pathname === "/auth/login") {
      const body = await readBody(req);
      const user = store.users.find(
        (u) => u.email === String(body.email || "").toLowerCase() && u.password === body.password,
      );
      if (!user) return send(res, 401, { error: "invalid_credentials" });
      const token = id("tok");
      store.sessions[token] = { userId: user.id, createdAt: now() };
      save(store);
      return send(res, 200, { token, user: publicUser(user) });
    }

    if (req.method === "GET" && pathname === "/auth/me") {
      const user = authUser(req, store);
      if (!user) return send(res, 401, { error: "unauthorized" });
      return send(res, 200, { user: publicUser(user) });
    }

    if (req.method === "POST" && pathname === "/auth/logout") {
      const h = req.headers.authorization || "";
      const m = /^Bearer\s+(.+)$/i.exec(h);
      if (m && store.sessions[m[1]]) {
        delete store.sessions[m[1]];
        save(store);
      }
      return send(res, 200, { ok: true });
    }

    const user = authUser(req, store);

    // public catalog for demo convenience
    if (req.method === "GET" && pathname === "/catalog") {
      return send(res, 200, { catalog: store.catalog });
    }

    if (!user) {
      return send(res, 401, {
        error: "unauthorized",
        message: "Sign in to GRIDGO, then retry this request with the new access token.",
      });
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
        const pending = createPendingFile({
          fileId,
          objectKey,
          user,
          purpose,
          file,
          detectedContentType,
          at: createdAt,
        });

        await enqueueMutation(async () => {
          const latestStore = load();
          const latestUser = authUser(req, latestStore);
          if (!latestUser) {
            throw new AttachmentError(401, "unauthorized", "Your sign-in expired. Sign in and upload the file again.");
          }
          authorizeFileUpload(latestUser, purpose);
          latestStore.files.push(pending);
          save(latestStore);
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
            const latestStore = load();
            const latestUser = authUser(req, latestStore);
            const latestFile = findFile(latestStore, fileId);
            if (!latestUser || latestUser.id !== pending.ownerId || !latestFile) {
              throw new AttachmentError(
                401,
                "unauthorized",
                "Your sign-in expired while the file was uploading. Sign in and upload the file again.",
              );
            }
            markFileReady(latestFile, now());
            save(latestStore);
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
        const latestStore = load();
        const latestUser = authUser(req, latestStore);
        if (!latestUser) {
          throw new AttachmentError(401, "unauthorized", "Your sign-in expired. Sign in and attach the file again.");
        }
        const latestFile = findFile(latestStore, fileId);
        authorizeFileAttachOwner(latestUser, latestFile);
        const latestTarget = resolveFileTarget(latestStore, latestFile.purpose, body, latestUser);
        authorizeFileAttach(latestUser, latestFile, latestTarget);
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
          save(latestStore);
          return send(res, 200, { file: publicFile(latestFile), order: publicOrder(latestTarget.record, latestUser) });
        }
        if (latestTarget.type === "user") {
          save(latestStore);
          return send(res, 200, {
            file: publicFile(latestFile),
            ...verificationUserResponse(latestStore, latestTarget.record),
          });
        }
        save(latestStore);
        return send(res, 200, { file: publicFile(latestFile), supplierService: summarizeService(latestTarget.record) });
      });
    }

    if (req.method === "DELETE" && /^\/files\/[^/]+$/.test(pathname)) {
      const fileId = pathname.split("/")[2];
      const pending = await enqueueMutation(async () => {
        const latestStore = load();
        const latestUser = authUser(req, latestStore);
        if (!latestUser) throw new AttachmentError(401, "unauthorized", "Sign in and request the deletion again.");
        const latestFile = findFile(latestStore, fileId);
        const alreadyDeleted = latestFile?.state === "deleted";
        markFileDeletePending(latestFile, latestUser, now());
        save(latestStore);
        return { alreadyDeleted, file: latestFile, objectKey: latestFile.objectKey };
      });
      if (pending.alreadyDeleted) return send(res, 200, { file: publicFile(pending.file) });
      await objectStorage.deleteObject(pending.objectKey);
      const deleted = await enqueueMutation(async () => {
        const latestStore = load();
        const latestFile = findFile(latestStore, fileId);
        markFileDeleted(latestFile, now());
        save(latestStore);
        return latestFile;
      });
      return send(res, 200, { file: publicFile(deleted) });
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
        "Access-Control-Allow-Origin": "*",
      });
      res.flushHeaders();
      res.write("retry: 5000\n\n");

      const unsubscribe = notificationEvents.subscribe(user.id, (notification) => {
        if (notification.deletedAt == null) res.write(formatNotificationEvent(notification));
      });
      for (let index = resumeIndex + 1; index < store.notifications.length; index += 1) {
        const notification = store.notifications[index];
        if (notification.userId === user.id && notification.deletedAt == null) {
          res.write(formatNotificationEvent(notification));
        }
      }

      const heartbeat = setInterval(() => {
        res.write(`: heartbeat ${now()}\n\n`);
      }, NOTIFICATION_HEARTBEAT_MS);
      heartbeat.unref();
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.once("aborted", cleanup);
      res.once("close", cleanup);
      return;
    }

    if (req.method === "GET" && pathname === "/notifications") {
      const items = store.notifications
        .filter((n) => n.userId === user.id && n.deletedAt == null)
        .sort((a, b) => (a.at < b.at ? 1 : -1));
      return send(res, 200, {
        notifications: items,
        snapshot: notificationSnapshot(store.notifications, user.id),
      });
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
        if (notification.userId !== user.id || notification.deletedAt != null || notification.read) continue;
        notification.read = true;
        updatedCount += 1;
      }
      if (updatedCount) save(store);
      return send(res, 200, { updatedCount });
    }

    if (req.method === "PATCH" && /^\/notifications\/[^/]+$/.test(pathname)) {
      const notificationId = pathname.split("/")[2];
      const notification = store.notifications.find((candidate) => candidate.id === notificationId);
      if (!notification) return send(res, 404, { error: "notification_not_found" });
      if (notification.userId !== user.id) return send(res, 403, { error: "forbidden" });
      if (notification.deletedAt != null) return send(res, 404, { error: "notification_not_found" });
      const body = await readBody(req);
      if (typeof body.read !== "boolean") {
        return send(res, 400, { error: "notification_read_required" });
      }
      notification.read = body.read;
      save(store);
      return send(res, 200, { notification });
    }

    if (req.method === "DELETE" && /^\/notifications\/[^/]+$/.test(pathname)) {
      const notificationId = pathname.split("/")[2];
      const notification = store.notifications.find((candidate) => candidate.id === notificationId);
      if (!notification) return send(res, 404, { error: "notification_not_found" });
      if (notification.userId !== user.id) return send(res, 403, { error: "forbidden" });
      if (notification.deletedAt == null) {
        notification.deletedAt = now();
        save(store);
      }
      return send(res, 200, { id: notification.id, deletedAt: notification.deletedAt });
    }

    // ---- global operational settings ----
    if (req.method === "GET" && pathname === "/settings") {
      return send(res, 200, { settings: store.settings || defaultOperationalSettings() });
    }

    if (req.method === "PATCH" && pathname === "/settings") {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const next = {
        issueWindowHours: body.issueWindowHours ?? store.settings.issueWindowHours,
        deliveryFeeBands: body.deliveryFeeBands ?? store.settings.deliveryFeeBands,
      };
      validateOperationalSettings(next);
      const previous = structuredClone(store.settings);
      store.settings = structuredClone(next);
      audit(store, {
        actor: user,
        action: "settings.operational_update",
        entityType: "settings",
        entityId: "operational",
        detail: { previous, current: store.settings },
        reason: body.reason || null,
      });
      save(store);
      return send(res, 200, { settings: store.settings });
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
        message: "Order payments now use the 75% downpayment and 25% balance QR routes. Refresh the order and submit the required installment.",
      });
    }

    // Super Admin grants Pilot Credits (not a purchase; non-cash, non-transferable)
    if (req.method === "POST" && pathname === "/credits/grant") {
      if (!isSuper(user)) return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const clientId = body.clientId;
      const amountMinor = Number(body.amountMinor);
      if (!clientId || !Number.isFinite(amountMinor) || amountMinor <= 0) {
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
      save(store);
      return send(res, 200, { clientId, balanceMinor: acct.balanceMinor, entry, ledger: acct.ledger });
    }

    // ---- users directory ----
    if (req.method === "GET" && pathname === "/users") {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const role = url.searchParams.get("role");
      let list = store.users.map(publicUser);
      if (role) list = list.filter((u) => u.role === role);
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
      const previousShop = target.shop ? { ...target.shop } : null;
      const updatedAt = now();
      target.shop = validation.shop;
      target.shopUpdatedAt = updatedAt;
      target.updatedAt = updatedAt;
      audit(store, {
        actor: user,
        action: "user.shop_update",
        entityType: "user",
        entityId: target.id,
        detail: { from: previousShop, to: target.shop, existingOrdersRepriced: false },
      });
      save(store);
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
      if (prev === body.role) {
        return send(res, 200, { user: publicUser(target) });
      }
      target.role = body.role;
      if (body.role === "supplier" && target.verificationStatus == null) {
        target.verificationStatus = "unverified";
      }
      if (body.role === "supplier" && !Array.isArray(target.verificationDocumentFileIds)) {
        target.verificationDocumentFileIds = [];
      }
      audit(store, {
        actor: user,
        action: "user.role_change",
        entityType: "user",
        entityId: target.id,
        detail: { from: prev, to: body.role },
        reason: body.reason || null,
      });
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
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
        referenceRateMinor: body.referenceRateMinor != null ? Number(body.referenceRateMinor) : 0,
        turnaroundHours: body.turnaroundHours != null ? Number(body.turnaroundHours) : 48,
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
      save(store);
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
      save(store);
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
      save(store);
      return send(res, 200, { service: summarizeService(service) });
    }

    if (req.method === "POST" && /^\/supplier-services\/[^/]+\/verify$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const sid = pathname.split("/")[2];
      const service = (store.supplierServices || []).find((s) => s.id === sid);
      if (!service) return send(res, 404, { error: "service_not_found" });
      const owner = store.users.find((u) => u.id === service.supplierId);
      if (!owner || owner.verificationStatus !== "approved") {
        return send(res, 409, { error: "supplier_not_approved", verificationStatus: owner?.verificationStatus || null });
      }
      if (service.state === "withdrawn") return send(res, 409, { error: "service_withdrawn" });
      const body = await readBody(req);
      service.state = "live";
      service.verifiedAt = now();
      service.verifiedBy = user.id;
      service.suspendedAt = null;
      service.suspendedBy = null;
      service.suspendReason = null;
      service.updatedAt = now();
      audit(store, {
        actor: user,
        action: "supplier_service.verify",
        entityType: "supplier_service",
        entityId: service.id,
        reason: body.reason || null,
      });
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
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
      save(store);
      return send(res, 200, { escalation, order: publicOrder(order, user) });
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
      save(store);
      return send(res, 200, { order: publicOrder(order, user), milestone });
    }

    // ---- manual QR installment payments ----
    if (req.method === "POST" && /^\/orders\/[^/]+\/payments\/(downpayment|balance)\/submit$/.test(pathname)) {
      if (user.role !== "client") return send(res, 403, { error: "forbidden" });
      const parts = pathname.split("/");
      const orderId = parts[2];
      const installmentCode = parts[4];
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
      const notification = (store.notifications || []).find(
        (item) => item.id === order.assignmentNotificationId && item.orderId === order.id && item.userId === order.clientId,
      );
      if (!notification || !order.assignmentNotifiedAt) {
        return send(res, 409, {
          error: "assignment_notification_required",
          message: "Wait for GRIDGO to notify you of the assigned supplier and final price before submitting payment.",
        });
      }
      const installment = order.payments?.[installmentCode];
      if (!installment || !Number.isSafeInteger(installment.amountMinor)) {
        return send(res, 409, {
          error: "final_price_required",
          message: "The final price is not ready. Wait for the supplier assignment notification and refresh the order.",
        });
      }
      if (installmentCode === "downpayment" && !["awaiting_downpayment", "downpayment_review"].includes(order.state)) {
        return send(res, 409, {
          error: "downpayment_not_available",
          message: "The downpayment is not available at this order step. Refresh the order to see the current payment action.",
          state: order.state,
        });
      }
      if (
        installmentCode === "balance" &&
        !["confirmed", "legacy_confirmed"].includes(order.payments?.downpayment?.status)
      ) {
        return send(res, 409, {
          error: "downpayment_not_confirmed",
          message: "Operations must confirm the downpayment before you submit the remaining balance.",
        });
      }
      if (["pending_confirmation", "confirmed", "legacy_confirmed"].includes(installment.status)) {
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
      order.paymentStatus = installmentCode === "downpayment" ? "downpayment_pending" : "balance_pending";
      if (installmentCode === "downpayment") order.state = "downpayment_review";
      order.updatedAt = submittedAt;
      order.timeline.push({
        at: submittedAt,
        state: order.state,
        by: user.id,
        note: `${installmentCode === "downpayment" ? "Downpayment" : "Balance"} submitted for Operations confirmation`,
      });
      audit(store, {
        actor: user,
        action: `payment.${installmentCode}_submit`,
        entityType: "order",
        entityId: order.id,
        orderId: order.id,
        detail: { amountMinor: installment.amountMinor, method: "qr_manual" },
      });
      save(store);
      return send(res, 200, { order: publicOrder(order, user) });
    }

    if (req.method === "POST" && /^\/orders\/[^/]+\/payments\/(downpayment|balance)\/reject$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const parts = pathname.split("/");
      const orderId = parts[2];
      const installmentCode = parts[4];
      const order = store.orders.find((candidate) => candidate.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const installment = order.payments?.[installmentCode];
      if (["confirmed", "legacy_confirmed"].includes(installment?.status)) {
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
      if (installmentCode === "downpayment") {
        order.state = "awaiting_downpayment";
        order.paymentStatus = "unpaid";
      } else {
        order.paymentStatus = "downpayment_confirmed";
      }
      order.updatedAt = rejectedAt;
      order.timeline.push({
        at: rejectedAt,
        state: order.state,
        by: user.id,
        note: `${installmentCode === "downpayment" ? "Downpayment" : "Balance"} rejected by Operations: ${reason}`,
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
      save(store);
      return send(res, 200, { order: publicOrder(order, user) });
    }

    if (req.method === "POST" && /^\/orders\/[^/]+\/payments\/(downpayment|balance)\/confirm$/.test(pathname)) {
      if (!isOps(user)) return send(res, 403, { error: "forbidden" });
      const parts = pathname.split("/");
      const orderId = parts[2];
      const installmentCode = parts[4];
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
      if (installmentCode === "downpayment") {
        order.state = "payment_authorized";
        order.paymentStatus = "downpayment_confirmed";
      } else {
        order.paymentStatus = "paid";
      }
      order.updatedAt = confirmedAt;
      order.timeline.push({
        at: confirmedAt,
        state: order.state,
        by: user.id,
        note: `${installmentCode === "downpayment" ? "Downpayment" : "Balance"} confirmed manually by Operations`,
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
      save(store);
      return send(res, 200, { order: publicOrder(order, user) });
    }

    // ---- orders list / create ----
    if (req.method === "GET" && pathname === "/orders") {
      return send(res, 200, { orders: ordersFor(user, store).map((order) => publicOrder(order, user)) });
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
        return send(res, 200, { order: publicOrder(order, user) });
      }
    }

    if (req.method === "POST" && pathname === "/orders") {
      if (user.role !== "client") return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const product = store.catalog.find((p) => p.id === body.productId) || store.catalog[0];
      const qty = Number(body.quantity || 1);
      const referenceCandidates = [(product?.basePriceMinor || 10000) * qty];
      for (const service of store.supplierServices || []) {
        if (service.state !== "live" || !Number.isSafeInteger(Number(service.referenceRateMinor))) continue;
        if (Array.isArray(service.productFamilyIds) && service.productFamilyIds.includes(product?.family)) {
          referenceCandidates.push(Number(service.referenceRateMinor) * qty);
        }
      }
      const priceRange = estimatePriceRange({ supplierPriceCandidatesMinor: referenceCandidates });
      const zoneCode = body.zone || "davao_central";
      const ts = now();
      const address = body.address || "";
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
        dropoff: dropoffFor(address, zoneCode),
        operationalModelVersion: 2,
        priceRange,
        supplierPriceMinor: null,
        commissionRatePercent: null,
        commissionMinor: null,
        subtotalMinor: null,
        deliveryDistanceMeters: null,
        deliveryFeeMinor: null,
        totalMinor: null,
        downpaymentMinor: null,
        balanceMinor: null,
        paymentMethod: null,
        paymentStatus: "unpaid",
        payments: {
          downpayment: { amountMinor: null, method: "qr_manual", status: "not_submitted", reference: null, submittedAt: null, confirmedAt: null, confirmedBy: null, confirmationSource: null, rejectedAt: null, rejectedBy: null, rejectionReason: null },
          balance: { amountMinor: null, method: "qr_manual", status: "not_submitted", reference: null, submittedAt: null, confirmedAt: null, confirmedBy: null, confirmationSource: null, rejectedAt: null, rejectedBy: null, rejectionReason: null },
        },
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
      save(store);
      return send(res, 201, { order: publicOrder(order, user) });
    }

    if (req.method === "POST" && /^\/orders\/[^/]+\/transition$/.test(pathname)) {
      const orderId = pathname.split("/")[2];
      const body = await readBody(req);
      const order = store.orders.find((o) => o.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const next = body.state;
      if (body.paymentMethod != null && String(body.paymentMethod).trim().toLowerCase() !== "qr_manual") {
        return send(res, 400, {
          error: "payment_method_not_allowed",
          message: "Order transitions do not accept cash or legacy payment methods. Submit the digital QR installment for Operations confirmation.",
          allowed: ["qr_manual"],
        });
      }
      if (next === "supplier_assigned") {
        const supplier = store.users.find(
          (candidate) => candidate.id === body.supplierId && candidate.role === "supplier",
        );
        if (!supplier) {
          return send(res, 404, {
            error: "supplier_not_found",
            message: "That supplier account no longer exists. Refresh eligible suppliers and choose another.",
          });
        }
        if (supplier.verificationStatus !== "approved") {
          return send(res, 409, {
            error: "supplier_not_approved",
            message: "Operations must approve this supplier before assigning new work.",
            verificationStatus: supplier.verificationStatus || "unverified",
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
      if (next === "rider_assigned") {
        const riderId = user.role === "rider" ? user.id : body.riderId;
        const rider = store.users.find((candidate) => candidate.id === riderId && candidate.role === "rider");
        if (!rider) {
          return send(res, 404, {
            error: "rider_not_found",
            message: "That rider account no longer exists. Refresh approved riders and choose another.",
          });
        }
        if (rider.verificationStatus !== "approved") {
          return send(res, user.role === "rider" ? 403 : 409, {
            error: "rider_not_approved",
            message: "Operations must approve this rider profile before dispatch assignment.",
            verificationStatus: rider.verificationStatus || "unverified",
          });
        }
      }
      const allowed = TRANSITIONS[order.state]?.[next];
      if (!allowed || (!allowed.includes(user.role) && !allowed.includes("system"))) {
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
            message: "Release every Proof-of-Fulfilment-gated milestone before closing the supplier payout.",
            milestoneCodes: unreleased.map((milestone) => milestone.code),
          });
        }
      }
      if (next === "supplier_accepted") {
        if (user.role !== "supplier" || order.supplierId !== user.id) {
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
        order.promisedDate = body.promisedDate || order.deadline;
        setOrderPickup(order, store);
        const money = calculateFinalPrice({
          supplierPriceMinor: body.supplierPriceMinor,
          pickup: order.pickup,
          dropoff: order.dropoff,
          settings: store.settings,
        });
        Object.assign(order, money, { operationalModelVersion: 2 });
        order.priceRange.deliveryFeeStatus = "final";
        order.payoutMilestones = createPayoutMilestones(order.supplierPriceMinor);
        order.payments = {
          downpayment: {
            amountMinor: order.downpaymentMinor,
            method: "qr_manual",
            status: "not_submitted",
            reference: null,
            submittedAt: null,
            confirmedAt: null,
            confirmedBy: null,
            confirmationSource: null,
            rejectedAt: null,
            rejectedBy: null,
            rejectionReason: null,
          },
          balance: {
            amountMinor: order.balanceMinor,
            method: "qr_manual",
            status: "not_submitted",
            reference: null,
            submittedAt: null,
            confirmedAt: null,
            confirmedBy: null,
            confirmationSource: null,
            rejectedAt: null,
            rejectedBy: null,
            rejectionReason: null,
          },
        };
        const acceptedAt = now();
        order.timeline.push({
          at: acceptedAt,
          state: "supplier_accepted",
          by: user.id,
          note: "Supplier accepted and set the final price",
        });
        const notification = {
          id: id("ntf"),
          userId: order.clientId,
          type: "supplier_assignment_final_price",
          orderId: order.id,
          title: "Supplier assigned and final price ready",
          body: "A supplier accepted your order. Review the final price and submit the digital downpayment.",
          read: false,
          at: acceptedAt,
        };
        store.notifications.push(notification);
        order.assignmentNotificationId = notification.id;
        order.assignmentNotifiedAt = notification.at;
        order.state = "awaiting_downpayment";
        order.updatedAt = acceptedAt;
        order.timeline.push({
          at: acceptedAt,
          state: "awaiting_downpayment",
          by: "system",
          note: "Client notified of assignment and final price",
        });
        save(store);
        return send(res, 200, { order: publicOrder(order, user) });
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
      order.state = next;
      order.updatedAt = now();
      order.timeline.push({ at: order.updatedAt, state: next, by: user.id, note: body.note || "" });
      save(store);
      return send(res, 200, { order: publicOrder(order, user) });
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
      const offers = store.orders.filter((o) => o.state === "ready_for_dispatch" || (o.state === "rider_assigned" && o.riderId === user.id));
      return send(res, 200, { offers: offers.map((order) => publicOrder(order, user)) });
    }

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/accept$/.test(pathname)) {
      if (user.role !== "rider") return send(res, 403, { error: "forbidden" });
      if (user.verificationStatus !== "approved") {
        return send(res, 403, {
          error: "rider_not_approved",
          message: "Operations must approve this rider profile before the rider can accept a dispatch.",
        });
      }
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((o) => o.id === orderId);
      if (!order || order.state !== "ready_for_dispatch") return send(res, 409, { error: "not_offerable" });
      order.riderId = user.id;
      order.state = "rider_assigned";
      order.updatedAt = now();
      order.timeline.push({ at: order.updatedAt, state: order.state, by: user.id, note: "Rider accepted" });
      save(store);
      return send(res, 200, { order: publicOrder(order, user) });
    }

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/pickup-checklist$/.test(pathname)) {
      if (user.role !== "rider") return send(res, 403, { error: "forbidden" });
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
        for (const recipient of store.users.filter((candidate) => isOps(candidate))) {
          store.notifications.push({
            id: id("ntf"),
            userId: recipient.id,
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
        save(store);
        return send(res, 200, { order: publicOrder(order, user), escalation });
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
      save(store);
      return send(res, 200, {
        order: publicOrder(order, user),
        signOffPrompt: PICKUP_SIGN_OFF_PROMPT,
      });
    }

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/location$/.test(pathname)) {
      if (user.role !== "rider") return send(res, 403, { error: "forbidden" });
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((o) => o.id === orderId && o.riderId === user.id);
      if (!order) return send(res, 404, { error: "order_not_found" });
      if (!["picked_up", "out_for_delivery"].includes(order.state)) {
        return send(res, 409, { error: "tracking_not_active", state: order.state });
      }
      const body = await readBody(req);
      const ping = {
        id: id("ping"),
        orderId,
        riderId: user.id,
        lat: Number(body.lat),
        lng: Number(body.lng),
        accuracy: body.accuracy ?? null,
        at: now(),
      };
      store.locationPings.push(ping);
      save(store);
      return send(res, 201, { ping });
    }

    // Latest rider location for tracking (assigned rider, client, supplier, ops/super).
    if (req.method === "GET" && /^\/dispatch\/[^/]+\/location$/.test(pathname)) {
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((o) => o.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      if (!canViewOrderLocation(user, order)) return send(res, 403, { error: "forbidden" });
      const pings = store.locationPings.filter((p) => p.orderId === orderId);
      if (!pings.length) return send(res, 200, { ping: null });
      const ping = pings.reduce((latest, p) => (p.at > latest.at ? p : latest), pings[0]);
      return send(res, 200, { ping });
    }

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/delivery$/.test(pathname)) {
      if (user.role !== "rider") return send(res, 403, { error: "forbidden" });
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
      if (!["confirmed", "legacy_confirmed"].includes(order.payments?.balance?.status)) {
        return send(res, 409, {
          error: "balance_not_confirmed",
          message: "Operations must confirm the client's digital balance before the rider completes delivery.",
        });
      }
      const deliveredMilestone = (order.payoutMilestones || []).find((milestone) => milestone.code === "delivered");
      if (!deliveredMilestone?.pofFileIds?.length) {
        return send(res, 409, {
          error: "pof_required",
          message: "Attach the delivered Proof of Fulfilment before completing this delivery.",
          milestoneCode: "delivered",
        });
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
      save(store);
      return send(res, 200, { order: publicOrder(order, user) });
    }

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/proof$/.test(pathname)) {
      return send(res, 410, {
        error: "dispatch_proof_route_retired",
        message: "Use the pickup checklist or delivery evidence route. Direct proof names and cash collection are no longer accepted.",
      });
    }

    // ---- supplier jobs helper alias ----
    if (req.method === "GET" && pathname === "/jobs") {
      if (user.role !== "supplier") return send(res, 403, { error: "forbidden" });
      return send(res, 200, {
        jobs: store.orders
          .filter((o) => o.supplierId === user.id)
          .map((order) => publicOrder(order, user)),
      });
    }

    return send(res, 404, { error: "not_found", path: pathname });
  } catch (err) {
    if (err instanceof AttachmentError || (err && Number.isInteger(err.status) && err.code)) {
      return sendDomainError(res, err);
    }
    console.error(err);
    return send(res, 500, {
      error: "server_error",
      message: "GRIDGO could not complete that request. Try again, or check the API log if the problem continues.",
    });
  }
}

const server = http.createServer((req, res) => {
  const pathname = String(req.url || "").split("?", 1)[0];
  const mutatesStore = req.method === "POST" || req.method === "PATCH" || req.method === "DELETE";
  // File transfers and MinIO calls stay outside the mutation queue. File routes
  // acquire the queue only for short load -> validate -> mutate -> atomic-save commits.
  const isSelfQueuedFileMutation =
    (req.method === "POST" && pathname === "/files") ||
    (req.method === "POST" && /^\/files\/[^/]+\/attach$/.test(pathname)) ||
    (req.method === "DELETE" && /^\/files\/[^/]+$/.test(pathname));
  if (isSelfQueuedFileMutation) {
    void handleRequest(req, res);
    return;
  }
  if (mutatesStore) {
    void readBody(req)
      .then(() => enqueueMutation(() => handleRequest(req, res)))
      .catch((error) => {
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
  const candidates = load().files.filter(
    (file) => ["pending_upload", "delete_pending"].includes(file.state) && file.objectKey,
  );
  for (const candidate of candidates) {
    try {
      await objectStorage.deleteObject(candidate.objectKey);
      await enqueueMutation(async () => {
        const latestStore = load();
        const latestFile = findFile(latestStore, candidate.fileId);
        if (!latestFile || !["pending_upload", "delete_pending"].includes(latestFile.state)) return;
        markFileDeleted(latestFile, now());
        save(latestStore);
      });
    } catch {
      // Leave the durable pending state for the next boot; non-file routes remain usable.
    }
  }
}

// Complete additive/idempotent backfill before accepting concurrent requests.
load();

server.listen(PORT, HOST, () => {
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
