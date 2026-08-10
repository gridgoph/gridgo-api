import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { DEMO_USERS, DEMO_SUPPLIER_SHOP } from "./demo-fixtures.js";
import { defaultTaxonomy } from "./taxonomy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const storePath = path.join(dataDir, "store.json");

const reset = process.argv.includes("--reset");

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

/** Plausible Davao City zone anchors (real neighbourhoods, not Manila / null island). */
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

/** Deterministic dropoff near the zone centre so new orders do not stack on one pin. */
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

const supplierShop = DEMO_SUPPLIER_SHOP;

const t = now();

/** Seed users = fixtures + verification timestamps for approved supplier/rider. */
const users = DEMO_USERS.map((u) => {
  const copy = { ...u, shop: u.shop ? { ...u.shop } : undefined };
  if (copy.shop === undefined) delete copy.shop;
  if (u.verificationStatus === "approved") {
    copy.verifiedAt = t;
    copy.verifiedBy = u.verifiedBy || "user_admin";
  }
  return copy;
});

const catalog = [
  { id: "prod_tarpaulin", name: "Tarpaulin / Banner", family: "banner", basePriceMinor: 45000, unit: "sqm" },
  { id: "prod_sticker", name: "Stickers", family: "sticker", basePriceMinor: 15000, unit: "sheet" },
  { id: "prod_flyer", name: "Brochures / Flyers", family: "flyer", basePriceMinor: 2500, unit: "pack100" },
  { id: "prod_card", name: "Business Cards", family: "card", basePriceMinor: 35000, unit: "box100" },
  { id: "prod_apparel", name: "Simple Apparel Print", family: "apparel", basePriceMinor: 28000, unit: "piece" },
];

// Fresh-store taxonomy comes from the shared definition so a seeded store and a
// backfilled store end up with byte-identical taxonomy content.
const taxonomy = defaultTaxonomy();

const zones = [
  { id: "zone_central", code: "davao_central", name: "Davao Central (Bajada / JP Laurel)", deliveryFeeMinor: 15000, active: true },
  { id: "zone_south", code: "davao_south", name: "Davao South (Matina)", deliveryFeeMinor: 10000, active: true },
  { id: "zone_north", code: "davao_north", name: "Davao North (Lanang)", deliveryFeeMinor: 15000, active: true },
  { id: "zone_west", code: "davao_west", name: "Davao West (Toril side)", deliveryFeeMinor: 20000, active: true },
  { id: "zone_east", code: "davao_east", name: "Davao East (Buhangin / Sasa)", deliveryFeeMinor: 18000, active: true },
];

const supplierServices = [
  {
    id: "svc_demo_tarpaulin",
    supplierId: "user_supplier",
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
    verifiedAt: t,
    verifiedBy: "user_admin",
    suspendedAt: null,
    suspendedBy: null,
    suspendReason: null,
    withdrawnAt: null,
    imageFileIds: [],
    createdAt: t,
    updatedAt: t,
  },
  {
    id: "svc_demo_print",
    supplierId: "user_supplier",
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
    verifiedAt: t,
    verifiedBy: "user_admin",
    suspendedAt: null,
    suspendedBy: null,
    suspendReason: null,
    withdrawnAt: null,
    imageFileIds: [],
    createdAt: t,
    updatedAt: t,
  },
  {
    id: "svc_demo_apparel_draft",
    supplierId: "user_supplier",
    categoryCode: "corporate_event_merch",
    materialCodes: ["cotton_tee"],
    finishCodes: ["none"],
    productFamilyIds: ["apparel"],
    sizeMin: "XS",
    sizeMax: "XXL",
    qtyMin: 12,
    qtyMax: 500,
    pricingBasis: "per_piece",
    referenceRateMinor: 28000,
    turnaroundHours: 72,
    capacityDaily: 30,
    capacityWeekly: 150,
    zones: ["davao_central", "davao_south"],
    equipmentNotes: "Heat press pending verification",
    state: "pending_verification",
    verifiedAt: null,
    verifiedBy: null,
    suspendedAt: null,
    suspendedBy: null,
    suspendReason: null,
    withdrawnAt: null,
    imageFileIds: [],
    createdAt: t,
    updatedAt: t,
  },
];

const pickupSupplier = {
  lat: supplierShop.lat,
  lng: supplierShop.lng,
  label: supplierShop.label,
};

const orders = [
  {
    id: "ord_demo_1",
    clientId: "user_client",
    supplierId: "user_supplier",
    riderId: null,
    state: "supplier_assigned",
    productId: "prod_tarpaulin",
    title: "Grand opening tarpaulin 3x6",
    quantity: 1,
    size: "3x6 ft",
    material: "13oz tarpaulin",
    finish: "hem_grommet",
    deadline: "2026-08-12T10:00:00+08:00",
    address: "JP Laurel Ave, Bajada, Davao City",
    zone: "davao_central",
    pickup: pickupSupplier,
    dropoff: dropoffFor("JP Laurel Ave, Bajada, Davao City", "davao_central"),
    totalMinor: 120000,
    deliveryFeeMinor: 15000,
    paymentMethod: null,
    paymentStatus: "unpaid",
    codEligible: true,
    payoutHold: false,
    promisedDate: "2026-08-12T17:00:00+08:00",
    matchingServiceIds: ["svc_demo_tarpaulin"],
    artworkName: "opening-banner-final.pdf",
    artworkFileIds: [],
    proofFileIds: [],
    deliveryPhotoFileIds: [],
    createdAt: t,
    updatedAt: t,
    timeline: [{ at: t, state: "submitted", by: "user_client", note: "Submitted for QA" }],
  },
  {
    id: "ord_demo_2",
    clientId: "user_client",
    supplierId: "user_supplier",
    riderId: "user_rider",
    state: "ready_for_dispatch",
    productId: "prod_flyer",
    title: "School event flyers x500",
    quantity: 5,
    size: "A5",
    material: "matte 150gsm",
    finish: "none",
    deadline: "2026-08-10T09:00:00+08:00",
    address: "Matina Crossing, Davao City",
    zone: "davao_south",
    pickup: pickupSupplier,
    dropoff: dropoffFor("Matina Crossing, Davao City", "davao_south"),
    totalMinor: 85000,
    deliveryFeeMinor: 10000,
    paymentMethod: "pilot_credit",
    paymentStatus: "authorized",
    codEligible: true,
    payoutHold: false,
    promisedDate: "2026-08-10T15:00:00+08:00",
    matchingServiceIds: ["svc_demo_print"],
    artworkName: "school-flyers.pdf",
    artworkFileIds: [],
    proofFileIds: [],
    deliveryPhotoFileIds: [],
    createdAt: t,
    updatedAt: t,
    timeline: [{ at: t, state: "ready_for_dispatch", by: "user_supplier", note: "Self-QC passed" }],
  },
  {
    id: "ord_demo_issue",
    clientId: "user_client",
    supplierId: "user_supplier",
    riderId: "user_rider",
    state: "issue_window_open",
    productId: "prod_sticker",
    title: "Event vinyl stickers pack",
    quantity: 100,
    size: "A6",
    material: "vinyl sticker",
    finish: "kiss_cut",
    deadline: "2026-08-08T12:00:00+08:00",
    address: "Lanang, Davao City",
    zone: "davao_north",
    pickup: pickupSupplier,
    dropoff: dropoffFor("Lanang, Davao City", "davao_north"),
    totalMinor: 60000,
    deliveryFeeMinor: 15000,
    paymentMethod: "pilot_credit",
    paymentStatus: "authorized",
    codEligible: true,
    payoutHold: true,
    promisedDate: "2026-08-08T18:00:00+08:00",
    matchingServiceIds: ["svc_demo_print"],
    artworkName: "event-stickers.pdf",
    artworkFileIds: [],
    proofFileIds: [],
    deliveryPhotoFileIds: [],
    createdAt: t,
    updatedAt: t,
    timeline: [
      { at: t, state: "delivered", by: "user_rider", note: "Delivery proof" },
      { at: t, state: "issue_window_open", by: "system", note: "24h issue window opened" },
      { at: t, state: "issue_window_open", by: "user_client", note: "Material issue reported: edges peeling" },
    ],
  },
  {
    id: "ord_demo_claim",
    clientId: "user_client",
    supplierId: "user_supplier",
    riderId: "user_rider",
    state: "completed",
    productId: "prod_card",
    title: "Business cards box (hold demo)",
    quantity: 2,
    size: "standard",
    material: "gloss cardstock",
    finish: "lamination",
    deadline: "2026-08-05T10:00:00+08:00",
    address: "Buhangin, Davao City",
    zone: "davao_east",
    pickup: pickupSupplier,
    dropoff: dropoffFor("Buhangin, Davao City", "davao_east"),
    totalMinor: 70000,
    deliveryFeeMinor: 18000,
    paymentMethod: "cod",
    paymentStatus: "collected",
    codEligible: true,
    payoutHold: true,
    promisedDate: "2026-08-05T16:00:00+08:00",
    matchingServiceIds: ["svc_demo_print"],
    artworkName: "biz-cards.pdf",
    artworkFileIds: [],
    proofFileIds: [],
    deliveryPhotoFileIds: [],
    createdAt: t,
    updatedAt: t,
    timeline: [
      { at: t, state: "completed", by: "user_ops", note: "Issue window closed clean" },
      { at: t, state: "completed", by: "user_ops", note: "Claim raised; payout held: COD cash short on count" },
    ],
  },
];

const issues = [
  {
    id: "iss_demo_1",
    orderId: "ord_demo_issue",
    clientId: "user_client",
    description: "Edges peeling on vinyl stickers — adhesive failed on outdoor sample",
    kind: "material_quality",
    status: "open",
    consequence: "payout_hold",
    claimId: "clm_demo_issue",
    createdAt: t,
    updatedAt: t,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  },
];

const claims = [
  {
    id: "clm_demo_issue",
    orderId: "ord_demo_issue",
    raisedBy: "user_client",
    reason: "Client issue report: Edges peeling on vinyl stickers — adhesive failed on outdoor sample",
    status: "payout_held",
    holdReason: "Auto-hold from issue iss_demo_1",
    releaseReason: null,
    heldAt: t,
    heldBy: "system",
    releasedAt: null,
    releasedBy: null,
    createdAt: t,
    updatedAt: t,
    issueId: "iss_demo_1",
    timeline: [{ at: t, action: "auto_hold_from_issue", by: "system", note: "Edges peeling on vinyl stickers" }],
  },
  {
    id: "clm_demo_ops",
    orderId: "ord_demo_claim",
    raisedBy: "user_ops",
    reason: "COD cash short on count at reconciliation",
    status: "payout_held",
    holdReason: "COD cash short on count at reconciliation",
    releaseReason: null,
    heldAt: t,
    heldBy: "user_ops",
    releasedAt: null,
    releasedBy: null,
    createdAt: t,
    updatedAt: t,
    issueId: null,
    timeline: [{ at: t, action: "raised_and_held", by: "user_ops", note: "COD cash short on count at reconciliation" }],
  },
];

const grantLed = id("led");
const auditLog = [
  {
    id: id("aud"),
    at: t,
    actorId: "user_admin",
    actorRole: "super_admin",
    action: "credits.grant",
    entityType: "credits",
    entityId: "user_client",
    orderId: null,
    detail: { amountMinor: 500000, balanceAfterMinor: 500000 },
    reason: "Pilot grant",
  },
  {
    id: id("aud"),
    at: t,
    actorId: "user_admin",
    actorRole: "super_admin",
    action: "user.verification",
    entityType: "user",
    entityId: "user_supplier",
    orderId: null,
    detail: { from: "unverified", to: "approved" },
    reason: "Pilot accredited",
  },
  {
    id: id("aud"),
    at: t,
    actorId: "user_ops",
    actorRole: "ops_admin",
    action: "claim.raise",
    entityType: "claim",
    entityId: "clm_demo_ops",
    orderId: "ord_demo_claim",
    detail: { status: "payout_held" },
    reason: "COD cash short on count at reconciliation",
  },
  {
    id: id("aud"),
    at: t,
    actorId: "user_client",
    actorRole: "client",
    action: "issue.report",
    entityType: "issue",
    entityId: "iss_demo_1",
    orderId: "ord_demo_issue",
    detail: { kind: "material_quality", claimId: "clm_demo_issue" },
    reason: "Edges peeling on vinyl stickers — adhesive failed on outdoor sample",
  },
];

const store = {
  version: 2,
  users,
  sessions: {},
  catalog,
  taxonomy,
  zones,
  supplierServices,
  orders,
  files: [],
  credits: {
    user_client: {
      balanceMinor: 500000,
      ledger: [
        {
          id: grantLed,
          type: "grant",
          amountMinor: 500000,
          balanceAfterMinor: 500000,
          reason: "Pilot grant",
          orderId: null,
          at: t,
          actorId: "user_admin",
        },
      ],
    },
  },
  claims,
  issues,
  auditLog,
  notifications: [
    { id: id("ntf"), userId: "user_supplier", title: "New assignment", body: "Grand opening tarpaulin 3x6 awaits accept/decline", read: false, at: t },
    { id: id("ntf"), userId: "user_rider", title: "Dispatch available", body: "School event flyers ready for pickup", read: false, at: t },
    { id: id("ntf"), userId: "user_client", title: "QA update", body: "Your tarpaulin request is with a supplier", read: false, at: t },
    { id: id("ntf"), userId: "user_ops", title: "Issue reported", body: "Client reported material issue on event stickers", read: false, at: t },
    { id: id("ntf"), userId: "user_ops", title: "Payout hold", body: "COD claim held on business cards order", read: false, at: t },
  ],
  locationPings: [],
  proofs: [],
};

fs.mkdirSync(dataDir, { recursive: true });
if (!reset && fs.existsSync(storePath)) {
  console.log("store already exists; pass --reset to overwrite");
  process.exit(0);
}
fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
console.log(`wrote ${storePath}`);
console.log("demo logins: *@gridgo.local / demo");
