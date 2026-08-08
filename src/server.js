import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const STORE = path.join(ROOT, "data", "store.json");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

// Auto-seed if missing
if (!fs.existsSync(STORE)) {
  spawnSync(process.execPath, [path.join(__dirname, "seed.js"), "--reset"], { stdio: "inherit" });
}

function save(store) {
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
}
function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}
function now() {
  return new Date().toISOString();
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
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

function publicUser(u) {
  if (!u) return null;
  const { password, ...rest } = u;
  return rest;
}

function isOps(user) {
  return user && (user.role === "ops_admin" || user.role === "super_admin");
}

function isSuper(user) {
  return user && user.role === "super_admin";
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

function defaultTaxonomy() {
  return {
    categories: [
      {
        id: "taxc_large_format",
        code: "large_format",
        name: "Large format",
        productFamilyIds: ["banner"],
        active: true,
      },
      {
        id: "taxc_offset",
        code: "offset",
        name: "Offset / digital sheet",
        productFamilyIds: ["flyer", "card", "sticker"],
        active: true,
      },
      {
        id: "taxc_apparel",
        code: "apparel_sublimation",
        name: "Apparel / sublimation",
        productFamilyIds: ["apparel"],
        active: true,
      },
      {
        id: "taxc_signage",
        code: "signage",
        name: "Signage",
        productFamilyIds: ["banner", "sticker"],
        active: true,
      },
    ],
    materials: [
      { id: "taxm_13oz", code: "tarpaulin_13oz", name: "13oz tarpaulin", categoryCodes: ["large_format", "signage"], active: true },
      { id: "taxm_mesh", code: "mesh_banner", name: "Mesh banner", categoryCodes: ["large_format"], active: true },
      { id: "taxm_vinyl", code: "vinyl_sticker", name: "Vinyl sticker", categoryCodes: ["offset", "signage"], active: true },
      { id: "taxm_matte150", code: "matte_150gsm", name: "Matte 150gsm", categoryCodes: ["offset"], active: true },
      { id: "taxm_gloss_card", code: "gloss_cardstock", name: "Gloss cardstock", categoryCodes: ["offset"], active: true },
      { id: "taxm_cotton", code: "cotton_tee", name: "Cotton tee", categoryCodes: ["apparel_sublimation"], active: true },
    ],
    finishes: [
      { id: "taxf_hem_grommet", code: "hem_grommet", name: "Hem + grommets", categoryCodes: ["large_format", "signage"], active: true },
      { id: "taxf_laminate", code: "lamination", name: "Lamination", categoryCodes: ["offset", "signage"], active: true },
      { id: "taxf_none", code: "none", name: "None", categoryCodes: ["large_format", "offset", "apparel_sublimation", "signage"], active: true },
      { id: "taxf_cut", code: "kiss_cut", name: "Kiss cut", categoryCodes: ["offset", "signage"], active: true },
    ],
  };
}

function defaultZones() {
  return [
    { id: "zone_central", code: "davao_central", name: "Davao Central (Bajada / JP Laurel)", deliveryFeeMinor: 15000, active: true },
    { id: "zone_south", code: "davao_south", name: "Davao South (Matina)", deliveryFeeMinor: 10000, active: true },
    { id: "zone_north", code: "davao_north", name: "Davao North (Lanang)", deliveryFeeMinor: 15000, active: true },
    { id: "zone_west", code: "davao_west", name: "Davao West (Toril side)", deliveryFeeMinor: 20000, active: true },
    { id: "zone_east", code: "davao_east", name: "Davao East (Buhangin / Sasa)", deliveryFeeMinor: 18000, active: true },
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
          categoryCode: "large_format",
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
          categoryCode: "offset",
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
  let changed = false;
  if (backfillGeography(store)) changed = true;
  if (backfillPlatform(store)) changed = true;
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

function taxonomyCodeSet(taxonomy, kind) {
  const list = taxonomy?.[kind] || [];
  return new Set(list.filter((x) => x.active !== false).map((x) => x.code));
}

function validateTaxonomyRefs(store, body) {
  const cats = taxonomyCodeSet(store.taxonomy, "categories");
  const mats = taxonomyCodeSet(store.taxonomy, "materials");
  const fins = taxonomyCodeSet(store.taxonomy, "finishes");
  if (body.categoryCode != null && !cats.has(body.categoryCode)) {
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
  supplier_accepted: { awaiting_payment: ["supplier", "ops_admin", "super_admin"] },
  awaiting_payment: { payment_authorized: ["client", "ops_admin", "super_admin"] },
  payment_authorized: { production: ["supplier"] },
  production: { supplier_self_qc: ["supplier"] },
  supplier_self_qc: { ready_for_dispatch: ["supplier"] },
  ready_for_dispatch: { rider_assigned: ["rider", "ops_admin", "super_admin"] },
  rider_assigned: { picked_up: ["rider"] },
  picked_up: { out_for_delivery: ["rider"] },
  out_for_delivery: { delivered: ["rider"] },
  delivered: { issue_window_open: ["system", "ops_admin", "super_admin", "client", "rider"] },
  issue_window_open: {
    completed: ["ops_admin", "super_admin", "system"],
    // issue path simplified
  },
  completed: { payout_released: ["ops_admin", "super_admin"] },
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const { pathname } = url;
    const store = load();

    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, { ok: true, service: "gridgo-api", version: store.version, at: now() });
    }

    // ---- auth ----
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

    if (!user) return send(res, 401, { error: "unauthorized" });

    // ---- notifications ----
    if (req.method === "GET" && pathname === "/notifications") {
      const items = store.notifications
        .filter((n) => n.userId === user.id)
        .sort((a, b) => (a.at < b.at ? 1 : -1));
      return send(res, 200, { notifications: items });
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
      if (user.role !== "client") return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const order = store.orders.find((o) => o.id === body.orderId);
      if (!order || order.clientId !== user.id) return send(res, 404, { error: "order_not_found" });
      if (order.state !== "awaiting_payment" && order.state !== "supplier_accepted") {
        return send(res, 409, { error: "invalid_state", state: order.state });
      }
      const acct = store.credits[user.id] || { balanceMinor: 0, ledger: [] };
      const amount = order.totalMinor + order.deliveryFeeMinor;
      if (acct.balanceMinor < amount) return send(res, 402, { error: "insufficient_credits", needMinor: amount, balanceMinor: acct.balanceMinor });
      acct.balanceMinor -= amount;
      acct.ledger.push({
        id: id("led"),
        type: "spend",
        amountMinor: -amount,
        balanceAfterMinor: acct.balanceMinor,
        reason: `Authorize order ${order.id}`,
        orderId: order.id,
        at: now(),
        actorId: user.id,
      });
      store.credits[user.id] = acct;
      order.paymentMethod = "pilot_credit";
      order.paymentStatus = "authorized";
      order.state = "payment_authorized";
      order.updatedAt = now();
      order.timeline.push({ at: order.updatedAt, state: order.state, by: user.id, note: "Pilot Credits authorized" });
      save(store);
      return send(res, 200, { order, balanceMinor: acct.balanceMinor });
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
      audit(store, {
        actor: user,
        action: "user.role_change",
        entityType: "user",
        entityId: target.id,
        detail: { from: prev, to: body.role },
        reason: body.reason || null,
      });
      save(store);
      return send(res, 200, { user: publicUser(target) });
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
      return send(res, 200, { user: publicUser(target) });
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
        deliveryFeeMinor: Number(body.deliveryFeeMinor ?? 15000),
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
      if (body.deliveryFeeMinor != null) zone.deliveryFeeMinor = Number(body.deliveryFeeMinor);
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
      return send(res, 200, { taxonomy: store.taxonomy });
    }

    if (req.method === "POST" && pathname === "/taxonomy/categories") {
      if (!isSuper(user)) return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      if (!body.code || !body.name) return send(res, 400, { error: "invalid_category", need: "code, name" });
      if (store.taxonomy.categories.some((c) => c.code === body.code)) {
        return send(res, 409, { error: "code_exists", code: body.code });
      }
      const item = {
        id: id("taxc"),
        code: String(body.code),
        name: String(body.name),
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
      if (body.productFamilyIds != null) item.productFamilyIds = body.productFamilyIds;
      if (body.active != null) item.active = Boolean(body.active);
      audit(store, { actor: user, action: "taxonomy.category_update", entityType: "taxonomy_category", entityId: item.id, detail: item });
      save(store);
      return send(res, 200, { category: item });
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

    // ---- issues (24h material issue window) ----
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
      if (order.state !== "issue_window_open") {
        return send(res, 409, { error: "issue_window_closed", state: order.state });
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

    // ---- orders list / create ----
    if (req.method === "GET" && pathname === "/orders") {
      return send(res, 200, { orders: ordersFor(user, store) });
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
        return send(res, 200, { order });
      }
    }

    if (req.method === "POST" && pathname === "/orders") {
      if (user.role !== "client") return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const product = store.catalog.find((p) => p.id === body.productId) || store.catalog[0];
      const qty = Number(body.quantity || 1);
      const totalMinor = (product?.basePriceMinor || 10000) * qty;
      const zoneCode = body.zone || "davao_central";
      const zoneRec = (store.zones || []).find((z) => z.code === zoneCode);
      const deliveryFeeMinor = Number(body.deliveryFeeMinor ?? zoneRec?.deliveryFeeMinor ?? 15000);
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
        totalMinor,
        deliveryFeeMinor,
        paymentMethod: null,
        paymentStatus: "unpaid",
        codEligible: totalMinor + deliveryFeeMinor <= 150000,
        payoutHold: false,
        promisedDate: null,
        matchingServiceIds: null,
        artworkName: body.artworkName || null,
        createdAt: ts,
        updatedAt: ts,
        timeline: [{ at: ts, state: body.submit ? "submitted" : "draft", by: user.id, note: body.submit ? "Submitted" : "Draft saved" }],
      };
      store.orders.unshift(order);
      save(store);
      return send(res, 201, { order });
    }

    if (req.method === "POST" && /^\/orders\/[^/]+\/transition$/.test(pathname)) {
      const orderId = pathname.split("/")[2];
      const body = await readBody(req);
      const order = store.orders.find((o) => o.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const next = body.state;
      const allowed = TRANSITIONS[order.state]?.[next];
      if (!allowed || (!allowed.includes(user.role) && !allowed.includes("system"))) {
        return send(res, 409, { error: "transition_not_allowed", from: order.state, to: next, role: user.role });
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
      }
      // COD authorize path
      if (next === "payment_authorized" && body.paymentMethod === "cod") {
        const total = order.totalMinor + order.deliveryFeeMinor;
        if (total > 150000) return send(res, 400, { error: "cod_limit", maxMinor: 150000 });
        if (!order.codEligible) return send(res, 400, { error: "cod_not_eligible" });
        const openCod = store.orders.some(
          (o) => o.clientId === order.clientId && o.id !== order.id && o.paymentMethod === "cod" && o.paymentStatus !== "collected" && o.paymentStatus !== "reconciled" && !["completed", "payout_released"].includes(o.state),
        );
        if (openCod) return send(res, 409, { error: "cod_one_active" });
        order.paymentMethod = "cod";
        order.paymentStatus = "authorized";
      }
      if (next === "supplier_accepted") {
        order.supplierId = order.supplierId || user.id;
        order.promisedDate = body.promisedDate || order.deadline;
        if (body.finalTotalMinor) order.totalMinor = Number(body.finalTotalMinor);
        setOrderPickup(order, store);
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
      if (next === "delivered") {
        order.state = "delivered";
        order.updatedAt = now();
        order.timeline.push({ at: order.updatedAt, state: "delivered", by: user.id, note: body.note || "Delivered" });
        // auto open issue window
        order.state = "issue_window_open";
        order.timeline.push({ at: now(), state: "issue_window_open", by: "system", note: "24h issue window opened" });
        save(store);
        return send(res, 200, { order });
      }
      order.state = next;
      order.updatedAt = now();
      order.timeline.push({ at: order.updatedAt, state: next, by: user.id, note: body.note || "" });
      save(store);
      return send(res, 200, { order });
    }

    // ---- dispatch (rider) ----
    if (req.method === "GET" && pathname === "/dispatch/offers") {
      if (user.role !== "rider" && user.role !== "ops_admin" && user.role !== "super_admin") {
        return send(res, 403, { error: "forbidden" });
      }
      const offers = store.orders.filter((o) => o.state === "ready_for_dispatch" || (o.state === "rider_assigned" && o.riderId === user.id));
      return send(res, 200, { offers });
    }

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/accept$/.test(pathname)) {
      if (user.role !== "rider") return send(res, 403, { error: "forbidden" });
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((o) => o.id === orderId);
      if (!order || order.state !== "ready_for_dispatch") return send(res, 409, { error: "not_offerable" });
      order.riderId = user.id;
      order.state = "rider_assigned";
      order.updatedAt = now();
      order.timeline.push({ at: order.updatedAt, state: order.state, by: user.id, note: "Rider accepted" });
      save(store);
      return send(res, 200, { order });
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

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/proof$/.test(pathname)) {
      if (user.role !== "rider") return send(res, 403, { error: "forbidden" });
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((o) => o.id === orderId && o.riderId === user.id);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const body = await readBody(req);
      const proof = {
        id: id("prf"),
        orderId,
        riderId: user.id,
        kind: body.kind || "delivery", // pickup | delivery | cod | failure
        otp: body.otp || null,
        photoName: body.photoName || null,
        note: body.note || "",
        at: now(),
      };
      store.proofs.push(proof);
      if (proof.kind === "pickup" && order.state === "rider_assigned") {
        order.state = "picked_up";
        order.timeline.push({ at: now(), state: "picked_up", by: user.id, note: "Pickup proof" });
      } else if (proof.kind === "delivery" && ["picked_up", "out_for_delivery"].includes(order.state)) {
        order.state = "issue_window_open";
        order.timeline.push({ at: now(), state: "delivered", by: user.id, note: "Delivery proof" });
        order.timeline.push({ at: now(), state: "issue_window_open", by: "system", note: "24h issue window" });
        if (order.paymentMethod === "cod") order.paymentStatus = "collected";
      } else if (proof.kind === "cod") {
        order.paymentStatus = "collected";
      }
      order.updatedAt = now();
      save(store);
      return send(res, 201, { proof, order });
    }

    // ---- supplier jobs helper alias ----
    if (req.method === "GET" && pathname === "/jobs") {
      if (user.role !== "supplier") return send(res, 403, { error: "forbidden" });
      return send(res, 200, { jobs: store.orders.filter((o) => o.supplierId === user.id || o.state === "supplier_assigned") });
    }

    return send(res, 404, { error: "not_found", path: pathname });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: "server_error", message: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`gridgo-api listening on http://${HOST}:${PORT}`);
  console.log(`health: http://127.0.0.1:${PORT}/health`);
});
