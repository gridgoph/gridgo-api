import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { DEMO_PASSWORD, DEMO_SUPPLIER_SHOP } from "./demo-fixtures.js";
import { configuredDemoUsers, isProduction } from "./runtime-config.js";
import { defaultTaxonomy } from "./taxonomy.js";
import {
  PICKUP_CHECK_CODES,
  PICKUP_SIGN_OFF_PROMPT,
  backfillOperationalModel,
  calculateFinalPrice,
  createPayoutMilestones,
  defaultOperationalSettings,
} from "./operational-model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const storePath = process.env.STORE_PATH ? path.resolve(process.env.STORE_PATH) : path.join(dataDir, "store.json");

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
const production = isProduction(process.env);
const users = configuredDemoUsers(process.env).map((u) => {
  const copy = { ...u, shop: u.shop ? { ...u.shop } : undefined };
  if (copy.shop === undefined) delete copy.shop;
  if (copy.role === "supplier") copy.verificationDocumentFileIds = [];
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
  { id: "zone_central", code: "davao_central", name: "Davao Central (Bajada / JP Laurel)", active: true },
  { id: "zone_south", code: "davao_south", name: "Davao South (Matina)", active: true },
  { id: "zone_north", code: "davao_north", name: "Davao North (Lanang)", active: true },
  { id: "zone_west", code: "davao_west", name: "Davao West (Toril side)", active: true },
  { id: "zone_east", code: "davao_east", name: "Davao East (Buhangin / Sasa)", active: true },
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

const settings = defaultOperationalSettings();
const dropoffs = {
  ord_demo_1: dropoffFor("JP Laurel Ave, Bajada, Davao City", "davao_central"),
  ord_demo_2: dropoffFor("Matina Crossing, Davao City", "davao_south"),
  ord_demo_issue: dropoffFor("Lanang, Davao City", "davao_north"),
  ord_demo_claim: dropoffFor("Buhangin, Davao City", "davao_east"),
};
const prices = {
  ord_demo_1: calculateFinalPrice({ supplierPriceMinor: 100_000, pickup: pickupSupplier, dropoff: dropoffs.ord_demo_1, settings }),
  ord_demo_2: calculateFinalPrice({ supplierPriceMinor: 70_000, pickup: pickupSupplier, dropoff: dropoffs.ord_demo_2, settings }),
  ord_demo_issue: calculateFinalPrice({ supplierPriceMinor: 50_000, pickup: pickupSupplier, dropoff: dropoffs.ord_demo_issue, settings }),
  ord_demo_claim: calculateFinalPrice({ supplierPriceMinor: 60_000, pickup: pickupSupplier, dropoff: dropoffs.ord_demo_claim, settings }),
};

function installment(amountMinor, status, reference) {
  const confirmed = status === "confirmed";
  return {
    amountMinor,
    method: "qr_manual",
    status,
    reference: reference || null,
    submittedAt: confirmed ? t : null,
    confirmedAt: confirmed ? t : null,
    confirmedBy: confirmed ? "user_ops" : null,
    confirmationSource: confirmed ? "manual_ops" : null,
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
  };
}

function paymentsFor(price, { downpayment = "not_submitted", balance = "not_submitted", key }) {
  return {
    downpayment: installment(price.downpaymentMinor, downpayment, downpayment === "confirmed" ? `GCASH-DEMO-${key}-75` : null),
    balance: installment(price.balanceMinor, balance, balance === "confirmed" ? `GCASH-DEMO-${key}-25` : null),
  };
}

function milestonesFor(supplierPriceMinor, evidenceByCode = {}, releasedCodes = []) {
  const released = new Set(releasedCodes);
  return createPayoutMilestones(supplierPriceMinor).map((milestone) => {
    const pofFileIds = evidenceByCode[milestone.code] || [];
    if (released.has(milestone.code)) {
      return { ...milestone, status: "released", pofFileIds, releasedAt: t, releasedBy: "user_ops" };
    }
    if (pofFileIds.length) return { ...milestone, status: "pof_attached", pofFileIds };
    return milestone;
  });
}

const passedPickupChecks = PICKUP_CHECK_CODES.map((code) => ({ code, passed: true }));
const failedPickupChecks = PICKUP_CHECK_CODES.map((code) => ({ code, passed: code !== "visible_defects" }));

const orders = [
  {
    id: "ord_demo_1",
    clientId: "user_client",
    supplierId: "user_supplier",
    riderId: null,
    state: "awaiting_downpayment",
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
    dropoff: dropoffs.ord_demo_1,
    ...prices.ord_demo_1,
    operationalModelVersion: 2,
    priceRange: { subtotalMinMinor: prices.ord_demo_1.subtotalMinor, subtotalMaxMinor: prices.ord_demo_1.subtotalMinor, deliveryFeeStatus: "final" },
    paymentMethod: "qr_manual",
    paymentStatus: "unpaid",
    payments: paymentsFor(prices.ord_demo_1, { key: "ORDER1" }),
    payoutHold: false,
    payoutMilestones: milestonesFor(prices.ord_demo_1.supplierPriceMinor),
    assignmentNotificationId: "ntf_demo_assignment_ord_demo_1",
    assignmentNotifiedAt: t,
    promisedDate: "2026-08-12T17:00:00+08:00",
    matchingServiceIds: ["svc_demo_tarpaulin"],
    artworkName: "opening-banner-final.pdf",
    artworkFileIds: [],
    proofFileIds: [],
    fulfilmentProofFileIds: [],
    deliveryPhotoFileIds: [],
    pickupChecklist: {
      status: "not_started", checks: [], evidenceFileIds: [], failureNote: null,
      completedAt: null, completedBy: null, escalationId: null, signOffPrompt: PICKUP_SIGN_OFF_PROMPT,
    },
    createdAt: t,
    updatedAt: t,
    timeline: [
      { at: t, state: "submitted", by: "user_client", note: "Submitted for QA" },
      { at: t, state: "awaiting_downpayment", by: "user_supplier", note: "Supplier accepted at ₱1,000; final price sent to client" },
    ],
  },
  {
    id: "ord_demo_2",
    clientId: "user_client",
    supplierId: "user_supplier",
    riderId: "user_rider",
    state: "rider_assigned",
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
    dropoff: dropoffs.ord_demo_2,
    ...prices.ord_demo_2,
    operationalModelVersion: 2,
    priceRange: { subtotalMinMinor: prices.ord_demo_2.subtotalMinor, subtotalMaxMinor: prices.ord_demo_2.subtotalMinor, deliveryFeeStatus: "final" },
    paymentMethod: "qr_manual",
    paymentStatus: "authorized",
    payments: paymentsFor(prices.ord_demo_2, { downpayment: "confirmed", key: "ORDER2" }),
    payoutHold: false,
    payoutMilestones: milestonesFor(prices.ord_demo_2.supplierPriceMinor),
    assignmentNotificationId: "ntf_demo_assignment_ord_demo_2",
    assignmentNotifiedAt: t,
    promisedDate: "2026-08-10T15:00:00+08:00",
    matchingServiceIds: ["svc_demo_print"],
    artworkName: "school-flyers.pdf",
    artworkFileIds: [],
    proofFileIds: [],
    fulfilmentProofFileIds: [],
    deliveryPhotoFileIds: ["file_demo_pickup_failure"],
    pickupChecklist: {
      status: "failed_escalated",
      checks: failedPickupChecks,
      evidenceFileIds: ["file_demo_pickup_failure"],
      failureNote: "Colour shift found on the first flyer batch; transport is blocked pending Operations instruction.",
      completedAt: t,
      completedBy: "user_rider",
      escalationId: "esc_demo_pickup_failure",
      signOffPrompt: PICKUP_SIGN_OFF_PROMPT,
    },
    createdAt: t,
    updatedAt: t,
    timeline: [
      { at: t, state: "ready_for_dispatch", by: "user_supplier", note: "Self-QC passed" },
      { at: t, state: "rider_assigned", by: "user_rider", note: "Rider accepted" },
      { at: t, state: "rider_assigned", by: "user_rider", note: "Pickup blocked and escalated: visible_defects", escalationId: "esc_demo_pickup_failure" },
    ],
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
    dropoff: dropoffs.ord_demo_issue,
    ...prices.ord_demo_issue,
    operationalModelVersion: 2,
    priceRange: { subtotalMinMinor: prices.ord_demo_issue.subtotalMinor, subtotalMaxMinor: prices.ord_demo_issue.subtotalMinor, deliveryFeeStatus: "final" },
    paymentMethod: "qr_manual",
    paymentStatus: "paid",
    payments: paymentsFor(prices.ord_demo_issue, { downpayment: "confirmed", balance: "confirmed", key: "ISSUE" }),
    payoutHold: true,
    payoutMilestones: milestonesFor(
      prices.ord_demo_issue.supplierPriceMinor,
      {
        printing: ["file_demo_issue_printing_pof"],
        packaging_qc: ["file_demo_issue_packaging_pof"],
        delivered: ["file_demo_issue_delivered_pof"],
        retention: ["file_demo_issue_delivered_pof"],
      },
      ["printing", "packaging_qc", "delivered"],
    ),
    assignmentNotificationId: "ntf_demo_assignment_ord_demo_issue",
    assignmentNotifiedAt: t,
    promisedDate: "2026-08-08T18:00:00+08:00",
    matchingServiceIds: ["svc_demo_print"],
    artworkName: "event-stickers.pdf",
    artworkFileIds: [],
    proofFileIds: [],
    fulfilmentProofFileIds: ["file_demo_issue_printing_pof", "file_demo_issue_packaging_pof", "file_demo_issue_delivered_pof"],
    deliveryPhotoFileIds: ["file_demo_issue_delivery"],
    pickupChecklist: {
      status: "passed", checks: passedPickupChecks, evidenceFileIds: [], failureNote: null,
      completedAt: t, completedBy: "user_rider", escalationId: null, signOffPrompt: PICKUP_SIGN_OFF_PROMPT,
    },
    deliveryEvidence: { fileId: "file_demo_issue_delivery", evidenceType: "photo", riderId: "user_rider", recordedAt: t },
    issueWindowOpenedAt: t,
    issueWindowExpiresAt: new Date(new Date(t).getTime() + settings.issueWindowHours * 60 * 60 * 1000).toISOString(),
    createdAt: t,
    updatedAt: t,
    timeline: [
      { at: t, state: "delivered", by: "user_rider", note: "Delivery proof" },
      { at: t, state: "issue_window_open", by: "system", note: "Issue window opened" },
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
    dropoff: dropoffs.ord_demo_claim,
    ...prices.ord_demo_claim,
    operationalModelVersion: 2,
    priceRange: { subtotalMinMinor: prices.ord_demo_claim.subtotalMinor, subtotalMaxMinor: prices.ord_demo_claim.subtotalMinor, deliveryFeeStatus: "final" },
    paymentMethod: "qr_manual",
    paymentStatus: "paid",
    payments: paymentsFor(prices.ord_demo_claim, { downpayment: "confirmed", balance: "confirmed", key: "CLAIM" }),
    payoutHold: true,
    payoutMilestones: milestonesFor(
      prices.ord_demo_claim.supplierPriceMinor,
      {
        printing: ["file_demo_claim_printing_pof"],
        packaging_qc: ["file_demo_claim_packaging_pof"],
        delivered: ["file_demo_claim_delivered_pof"],
        retention: ["file_demo_claim_delivered_pof"],
      },
      ["printing", "packaging_qc", "delivered", "retention"],
    ),
    assignmentNotificationId: "ntf_demo_assignment_ord_demo_claim",
    assignmentNotifiedAt: t,
    promisedDate: "2026-08-05T16:00:00+08:00",
    matchingServiceIds: ["svc_demo_print"],
    artworkName: "biz-cards.pdf",
    artworkFileIds: [],
    proofFileIds: [],
    fulfilmentProofFileIds: ["file_demo_claim_printing_pof", "file_demo_claim_packaging_pof", "file_demo_claim_delivered_pof"],
    deliveryPhotoFileIds: ["file_demo_claim_delivery"],
    pickupChecklist: {
      status: "passed", checks: passedPickupChecks, evidenceFileIds: [], failureNote: null,
      completedAt: t, completedBy: "user_rider", escalationId: null, signOffPrompt: PICKUP_SIGN_OFF_PROMPT,
    },
    deliveryEvidence: { fileId: "file_demo_claim_delivery", evidenceType: "photo", riderId: "user_rider", recordedAt: t },
    issueWindowOpenedAt: "2026-08-04T08:00:00.000Z",
    issueWindowExpiresAt: "2026-08-05T08:00:00.000Z",
    createdAt: t,
    updatedAt: t,
    timeline: [
      { at: t, state: "completed", by: "user_ops", note: "Issue window closed clean" },
      { at: t, state: "completed", by: "user_ops", note: "Claim raised; payout held: payment reconciliation discrepancy" },
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
    reason: "Payment reconciliation discrepancy",
    status: "payout_held",
    holdReason: "Payment reconciliation discrepancy",
    releaseReason: null,
    heldAt: t,
    heldBy: "user_ops",
    releasedAt: null,
    releasedBy: null,
    createdAt: t,
    updatedAt: t,
    issueId: null,
    timeline: [{ at: t, action: "raised_and_held", by: "user_ops", note: "Payment reconciliation discrepancy" }],
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
    reason: "Payment reconciliation discrepancy",
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
  {
    id: id("aud"),
    at: t,
    actorId: "user_rider",
    actorRole: "rider",
    action: "pickup_checklist.escalate",
    entityType: "escalation",
    entityId: "esc_demo_pickup_failure",
    orderId: "ord_demo_2",
    detail: { failedCheckCodes: ["visible_defects"], evidenceFileIds: ["file_demo_pickup_failure"] },
    reason: "Colour shift found on the first flyer batch; transport is blocked pending Operations instruction.",
  },
];

function seededOrderFile({ fileId, orderId, ownerId, purpose, originalFilename, milestoneCode = null }) {
  const field = purpose === "fulfilment_proof" ? "fulfilmentProofFileIds" : "deliveryPhotoFileIds";
  return {
    fileId,
    ownerId,
    purpose,
    originalFilename,
    declaredContentType: "image/jpeg",
    detectedContentType: "image/jpeg",
    size: 128_000,
    state: "ready",
    objectKey: `${purpose}/seed/${orderId}/${originalFilename}`,
    references: [{ type: "order", id: orderId, field, ...(milestoneCode ? { milestoneCode } : {}) }],
    createdAt: t,
    readyAt: t,
    deleteRequestedAt: null,
    deletedAt: null,
  };
}

const files = [
  seededOrderFile({
    fileId: "file_demo_pickup_failure", orderId: "ord_demo_2", ownerId: "user_rider",
    purpose: "delivery_photo", originalFilename: "flyer-colour-shift.jpg",
  }),
  seededOrderFile({
    fileId: "file_demo_issue_printing_pof", orderId: "ord_demo_issue", ownerId: "user_supplier",
    purpose: "fulfilment_proof", originalFilename: "stickers-printing-pof.jpg", milestoneCode: "printing",
  }),
  seededOrderFile({
    fileId: "file_demo_issue_packaging_pof", orderId: "ord_demo_issue", ownerId: "user_supplier",
    purpose: "fulfilment_proof", originalFilename: "stickers-packaging-pof.jpg", milestoneCode: "packaging_qc",
  }),
  seededOrderFile({
    fileId: "file_demo_issue_delivered_pof", orderId: "ord_demo_issue", ownerId: "user_rider",
    purpose: "fulfilment_proof", originalFilename: "stickers-delivered-pof.jpg", milestoneCode: "delivered",
  }),
  seededOrderFile({
    fileId: "file_demo_issue_delivery", orderId: "ord_demo_issue", ownerId: "user_rider",
    purpose: "delivery_photo", originalFilename: "stickers-delivery.jpg",
  }),
  seededOrderFile({
    fileId: "file_demo_claim_printing_pof", orderId: "ord_demo_claim", ownerId: "user_supplier",
    purpose: "fulfilment_proof", originalFilename: "cards-printing-pof.jpg", milestoneCode: "printing",
  }),
  seededOrderFile({
    fileId: "file_demo_claim_packaging_pof", orderId: "ord_demo_claim", ownerId: "user_supplier",
    purpose: "fulfilment_proof", originalFilename: "cards-packaging-pof.jpg", milestoneCode: "packaging_qc",
  }),
  seededOrderFile({
    fileId: "file_demo_claim_delivered_pof", orderId: "ord_demo_claim", ownerId: "user_rider",
    purpose: "fulfilment_proof", originalFilename: "cards-delivered-pof.jpg", milestoneCode: "delivered",
  }),
  seededOrderFile({
    fileId: "file_demo_claim_delivery", orderId: "ord_demo_claim", ownerId: "user_rider",
    purpose: "delivery_photo", originalFilename: "cards-delivery.jpg",
  }),
];

const escalations = [
  {
    id: "esc_demo_pickup_failure",
    type: "pickup_check_failed",
    status: "open",
    orderId: "ord_demo_2",
    riderId: "user_rider",
    supplierId: "user_supplier",
    failedCheckCodes: ["visible_defects"],
    evidenceFileIds: ["file_demo_pickup_failure"],
    failureNote: "Colour shift found on the first flyer batch; transport is blocked pending Operations instruction.",
    createdAt: t,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  },
];

const demoStore = {
  version: 2,
  users,
  sessions: {},
  catalog,
  taxonomy,
  settings,
  zones,
  supplierServices,
  orders,
  files,
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
    { id: "ntf_demo_assignment_ord_demo_1", userId: "user_client", type: "supplier_assignment_final_price", orderId: "ord_demo_1", title: "Supplier assigned and final price ready", body: "A supplier accepted your order. Review the final price and submit the digital downpayment.", read: false, at: t },
    { id: "ntf_demo_assignment_ord_demo_2", userId: "user_client", type: "supplier_assignment_final_price", orderId: "ord_demo_2", title: "Supplier assigned and final price ready", body: "A supplier accepted your order. Review the final price and submit the digital downpayment.", read: true, at: t },
    { id: "ntf_demo_assignment_ord_demo_issue", userId: "user_client", type: "supplier_assignment_final_price", orderId: "ord_demo_issue", title: "Supplier assigned and final price ready", body: "A supplier accepted your order. Review the final price and submit the digital downpayment.", read: true, at: t },
    { id: "ntf_demo_assignment_ord_demo_claim", userId: "user_client", type: "supplier_assignment_final_price", orderId: "ord_demo_claim", title: "Supplier assigned and final price ready", body: "A supplier accepted your order. Review the final price and submit the digital downpayment.", read: true, at: t },
    { id: id("ntf"), userId: "user_rider", title: "Dispatch available", body: "School event flyers ready for pickup", read: false, at: t },
    { id: id("ntf"), userId: "user_client", title: "QA update", body: "Your tarpaulin request is with a supplier", read: false, at: t },
    { id: id("ntf"), userId: "user_ops", title: "Issue reported", body: "Client reported material issue on event stickers", read: false, at: t },
    { id: id("ntf"), userId: "user_ops", title: "Payout hold", body: "Payment claim held on business cards order", read: false, at: t },
    { id: id("ntf"), userId: "user_ops", type: "pickup_check_escalation", orderId: "ord_demo_2", title: "Pickup blocked by a failed quality check", body: "Colour shift found on the first flyer batch. The rider is waiting for Operations instruction.", read: false, at: t },
    { id: id("ntf"), userId: "user_admin", type: "pickup_check_escalation", orderId: "ord_demo_2", title: "Pickup blocked by a failed quality check", body: "Colour shift found on the first flyer batch. The rider is waiting for Operations instruction.", read: false, at: t },
  ],
  locationPings: [],
  escalations,
  proofs: [],
};

// Hosted pilots keep platform reference data and configured identities, but no
// scenario transactions or supplier-authored catalogue records. Local
// development continues to use demoStore unchanged.
const store = production
  ? {
      version: 2,
      users,
      sessions: {},
      catalog,
      taxonomy,
      settings,
      zones,
      supplierServices: [],
      orders: [],
      files: [],
      credits: {},
      claims: [],
      issues: [],
      auditLog: [],
      notifications: [],
      locationPings: [],
      escalations: [],
      proofs: [],
    }
  : demoStore;

// A fresh seed is native v2 data. Any mutation here means a fixture drifted back
// into a legacy shape and should fail reset loudly instead of hiding the mismatch.
if (backfillOperationalModel(store, t)) {
  throw new Error("fresh seed required operational-model backfill");
}

fs.mkdirSync(path.dirname(storePath), { recursive: true });
if (!reset && fs.existsSync(storePath)) {
  console.log("store already exists; pass --reset to overwrite");
  process.exit(0);
}
fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
console.log(`wrote ${storePath}`);
if (production) {
  console.log("hosted pilot accounts: passwords loaded from GRIDGO_*_PASSWORD environment variables");
} else {
  console.log(`demo logins: *@gridgo.local / ${DEMO_PASSWORD}`);
}
const ordersByState = Object.fromEntries(
  [...new Set(store.orders.map((order) => order.state))]
    .sort()
    .map((state) => [state, store.orders.filter((order) => order.state === state).length]),
);
const pofBackedOrders = store.orders
  .filter((order) => order.payoutMilestones.some((milestone) => milestone.status === "released" && milestone.pofFileIds.length))
  .map((order) => order.id);
console.log(`orders by state: ${Object.entries(ordersByState).map(([state, count]) => `${state}=${count}`).join(", ")}`);
console.log(`seed evidence: POF-backed releases=${pofBackedOrders.join(", ")}; failed pickup escalations=${store.escalations.map((item) => item.id).join(", ")}`);
