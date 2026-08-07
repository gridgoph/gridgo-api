import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

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

const users = [
  { id: "user_client", email: "client@gridgo.local", password: "demo", name: "Ana Client", role: "client", orgName: "Davao Events Co." },
  { id: "user_supplier", email: "supplier@gridgo.local", password: "demo", name: "Ben Supplier", role: "supplier", supplierName: "PrintRight Davao" },
  { id: "user_rider", email: "rider@gridgo.local", password: "demo", name: "Carlo Rider", role: "rider" },
  { id: "user_ops", email: "ops@gridgo.local", password: "demo", name: "Dina Ops", role: "ops_admin" },
  { id: "user_admin", email: "admin@gridgo.local", password: "demo", name: "Eli Admin", role: "super_admin" },
];

const catalog = [
  { id: "prod_tarpaulin", name: "Tarpaulin / Banner", family: "banner", basePriceMinor: 45000, unit: "sqm" },
  { id: "prod_sticker", name: "Stickers", family: "sticker", basePriceMinor: 15000, unit: "sheet" },
  { id: "prod_flyer", name: "Brochures / Flyers", family: "flyer", basePriceMinor: 2500, unit: "pack100" },
  { id: "prod_card", name: "Business Cards", family: "card", basePriceMinor: 35000, unit: "box100" },
  { id: "prod_apparel", name: "Simple Apparel Print", family: "apparel", basePriceMinor: 28000, unit: "piece" },
];

const t = now();
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
    deadline: "2026-08-12T10:00:00+08:00",
    address: "JP Laurel Ave, Bajada, Davao City",
    zone: "davao_central",
    totalMinor: 120000,
    deliveryFeeMinor: 15000,
    paymentMethod: null,
    paymentStatus: "unpaid",
    codEligible: true,
    promisedDate: "2026-08-12T17:00:00+08:00",
    artworkName: "opening-banner-final.pdf",
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
    deadline: "2026-08-10T09:00:00+08:00",
    address: "Matina Crossing, Davao City",
    zone: "davao_south",
    totalMinor: 85000,
    deliveryFeeMinor: 10000,
    paymentMethod: "pilot_credit",
    paymentStatus: "authorized",
    codEligible: true,
    promisedDate: "2026-08-10T15:00:00+08:00",
    artworkName: "school-flyers.pdf",
    createdAt: t,
    updatedAt: t,
    timeline: [{ at: t, state: "ready_for_dispatch", by: "user_supplier", note: "Self-QC passed" }],
  },
];

const store = {
  version: 1,
  users,
  sessions: {},
  catalog,
  orders,
  credits: {
    user_client: { balanceMinor: 500000, ledger: [
      { id: id("led"), type: "grant", amountMinor: 500000, balanceAfterMinor: 500000, reason: "Pilot grant", at: t, actorId: "user_admin" },
    ]},
  },
  notifications: [
    { id: id("ntf"), userId: "user_supplier", title: "New assignment", body: "Grand opening tarpaulin 3x6 awaits accept/decline", read: false, at: t },
    { id: id("ntf"), userId: "user_rider", title: "Dispatch available", body: "School event flyers ready for pickup", read: false, at: t },
    { id: id("ntf"), userId: "user_client", title: "QA update", body: "Your tarpaulin request is with a supplier", read: false, at: t },
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
