import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { authConfiguration, clerkClientProfile, createClerkBackend } from "./auth.js";
import { createDatabase } from "./database.js";
import { createObjectStorage } from "./object-storage.js";
import { createPayoutMilestones } from "./operational-model.js";
import { loadStore, saveStore } from "./postgres-store.js";
import { notifyOrderParties } from "./client-order-notifications.js";
import { seedReferenceData } from "./seed.js";
import { measurementKindFor } from "./pricing.js";
import { priceCatalogSelection, selectedCatalogPrice } from "./supplier-catalog.js";
import { defaultTaxonomy } from "./taxonomy.js";

/** Local development shop. Production `npm run seed` never creates this. */
export const LOVIS_DEV_SHOP = Object.freeze({
  email: "felyciaaa0220@gmail.com",
  shopName: "Lovis Printshop",
  contactName: "Felycia",
  phone: "+639171234567",
  shop: {
    lat: 7.086767242919336,
    lng: 125.61613995306057,
    label: "Iñigo, Corner Cervantes St, Poblacion, Davao City",
  },
});

/** Local development client. Must not be consumed as an extra shop. */
export const MARK_DEV_CLIENT = Object.freeze({
  email: "markdavidprado@gmail.com",
  name: "Mark David",
});

/**
 * Local development rider. Production `npm run seed` never creates this.
 * Email matches the official Clerk rider the rider app prefills in `__DEV__`.
 */
export const MARK_DEV_RIDER = Object.freeze({
  email: "mddprado00290@usep.edu.ph",
  name: "Mark David Prado",
  phone: "+639171234567",
  vehicleType: "motorcycle",
  plateNumber: "ABC 1234",
  licenseNumber: "N01-23-456789",
});

/**
 * Local portal testers. Production `npm run seed` never creates these.
 * One person, one portal: Mark is Super Admin only, Giorno is Operations only.
 */
export const PRIVILEGED_DEV_ACCOUNTS = Object.freeze([
  {
    id: "user_markshopease",
    email: "markshopease123@gmail.com",
    name: "Mark",
    primaryRole: "super_admin",
    roles: Object.freeze(["super_admin"]),
  },
  {
    id: "user_giorno_ops",
    email: "giornogiovanna0990@gmail.com",
    name: "Giorno",
    primaryRole: "ops_admin",
    roles: Object.freeze(["ops_admin"]),
  },
]);

const USER_ID = "user_lovis_printshop";
const CASE_ID = "apc_lovis_printshop";
const LOGO_ID = "file_lovis_logo";

/** Tiny JPEG fallback if a starter photograph is missing from seed-assets. */
export const PLACEHOLDER_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBwgHBgkIBwgKCgkLDRYPDQwMDRsUFRAWIB0iIiAdHx8kKDQsJCYxJx8fLT0tMTU3Ojo6Iys/RD84QzQ5OjcBCgoKDQwNGg8PGjclHyU3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3N//AABEIAAEAAQMBIgACEQEDEQH/xAAXAAADAQAAAAAAAAAAAAAAAAABAgME/8QAFhABAQEAAAAAAAAAAAAAAAAAABEB/9oADAMBAAIQAxAAAAGf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPwB//9k=",
  "base64",
);

const STARTER_ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "seed-assets", "starters");

export function starterSampleBytes(starterId) {
  const filePath = path.join(STARTER_ASSETS_DIR, `${starterId}.jpg`);
  try {
    return fs.readFileSync(filePath);
  } catch {
    return PLACEHOLDER_JPEG;
  }
}

const DESIGN_FORMATS = ["pdf", "png", "jpeg", "psd", "canva_link", "other_link"];

/**
 * Lovis is a document shop: everyday printing, booklets, brochures, cards,
 * binding and ID photos. It was seeded selling tarpaulins, jerseys, plaques and
 * 3D prints, which made one shop the competitor in every subcategory on the
 * platform and matching a formality.
 *
 * Only part of its real board can be sold yet. Document printing, booklets,
 * hardbound binding, risograph and ID pictures -- most of its price list, and
 * its highest-frequency work -- have no subcategory in the taxonomy to sit
 * under. That gap is a product decision, not a seeding one.
 */
export const LOVIS_CATEGORY_LINES = [
  {
    id: "svc_lovis_marketing_collateral",
    categoryCode: "marketing_collateral",
    formats: DESIGN_FORMATS,
    referenceRateMinor: 40000,
    turnaroundHours: 12,
    capacityDaily: 60,
  },
  {
    // The document board, which is most of what this shop actually does and
    // had no category to sit under until Documents & Publications existed.
    id: "svc_lovis_document_publication",
    categoryCode: "document_publication",
    formats: DESIGN_FORMATS,
    referenceRateMinor: 200,
    turnaroundHours: 4,
    // A document shop runs volume: thousands of pages a day, not dozens.
    capacityDaily: 2_000,
  },
];

export const LOVIS_LISTINGS = [
  {
    starterId: "lst_flyers",
    serviceId: "svc_lovis_marketing_collateral",
    priceMinor: 40_000, // PHP 4.00 a sheet in colour, a pack of 100
    description: "Single-sheet colour printing on 70gsm or 80gsm bond. Short, A4 and long.",
  },
  {
    starterId: "lst_brochures",
    serviceId: "svc_lovis_marketing_collateral",
    priceMinor: 50_000, // PHP 5.00 front only, a pack of 100
    description: "Bond or C2S brochures from 120 to 160gsm, matte as standard. Bi-fold and tri-fold.",
  },
  {
    starterId: "lst_business_cards",
    serviceId: "svc_lovis_marketing_collateral",
    priceMinor: 50_000, // PHP 5.00 base, a pack of 100
    description: "Calling card stock at 240gsm or 300gsm, sharp or round edge.",
  },

  // The document board. Everything here is priced the way the shop quotes it
  // rather than flattened to a per-piece figure.
  {
    starterId: "lst_document_printing",
    serviceId: "svc_lovis_document_publication",
    // PHP 2.00 a page, short, black and white. Size and colour are options on
    // top, and back-to-back doubles it.
    priceMinor: 200,
    description:
      "Everyday printing on 70gsm or 80gsm bond, black and white or colour. Short, A4 and long.",
  },
  {
    starterId: "lst_booklets",
    serviceId: "svc_lovis_document_publication",
    priceMinor: 125, // PHP 1.25 a page, A5, two pages to a sheet
    description: "A5 booklets, two pages to a sheet, bifold or trifold on bond paper.",
  },
  {
    starterId: "lst_risograph",
    serviceId: "svc_lovis_document_publication",
    priceMinor: 40_000, // PHP 400.00 a ream of 500, short, front only
    description: "High-volume black and white by the ream of 500, front only. Short, A4 and long.",
  },
  {
    starterId: "lst_binding_hardbound",
    // Priced entirely by how fast it is wanted: PHP 250 at five days through
    // PHP 700 in two hours. Four prices for the same book, not a base price
    // and three surcharges.
    priceMinor: 25_000,
    serviceId: "svc_lovis_document_publication",
    speedTiers: [
      { label: "5 days", turnaroundHours: 120, priceMinor: 25_000 },
      { label: "3 days", turnaroundHours: 72, priceMinor: 35_000 },
      { label: "Next day", turnaroundHours: 24, priceMinor: 50_000 },
      { label: "Same day, 2 to 3 hours", turnaroundHours: 3, priceMinor: 70_000 },
    ],
    description:
      "Thesis and report hardbound with gold or silver lettering, digital or embossed. A4, short and long.",
  },
  {
    starterId: "lst_id_photos",
    priceMinor: 5_000, // PHP 50.00 for the 3pcs 2x2 & 4pcs 1x1 set
    serviceId: "svc_lovis_document_publication",
    description:
      "ID photographs on photo paper or PVC, in the usual sets and single sizes. Collar and name tag available.",
  },
];

function upsert(list, key, record) {
  const index = list.findIndex((item) => item[key] === record[key]);
  if (index === -1) list.push(record);
  else Object.assign(list[index], record);
}

export async function resolveDevClerkUser(email, clerkBackend) {
  const backend = clerkBackend || createClerkBackend(authConfiguration(process.env));
  const listed = await backend.users.getUserList({ emailAddress: [email], limit: 5 });
  const rows = listed?.data || listed || [];
  const clerkUser = Array.isArray(rows) ? rows[0] : null;
  if (!clerkUser?.id) {
    throw new Error(
      `No Clerk user for ${email}. Create that sign-in in the development Clerk instance, then run npm run seed:dev.`,
    );
  }
  return clerkUser;
}

async function putJpeg(objectStorage, key, body) {
  if (!objectStorage) return false;
  try {
    await objectStorage.putObject({
      key,
      body,
      contentType: "image/jpeg",
      size: body.length,
    });
    return true;
  } catch {
    return false;
  }
}

function codesFor(taxonomy, kind, categoryCode) {
  return (taxonomy[kind] || [])
    .filter((row) => row.active !== false && (row.categoryCodes || []).includes(categoryCode))
    .map((row) => row.code);
}

function ensureFile(store, file) {
  upsert(store.files, "fileId", file);
}

/**
 * Copy a starter template onto one shop's listing.
 *
 * `optionPrices` reprices individual copied options by their starter id. Six
 * blueprint services share one template and one shape -- four sheet sizes and
 * three papers -- but each charges its own ladder, so what differs is the
 * numbers rather than the structure. Restating the whole template six times to
 * change twelve figures would bury the difference rather than show it.
 */
function copyStarter(store, starter, item, at, prefix = "lovis", optionPrices = null) {
  // Replaced, not skipped. Skipping made the seed idempotent but also inert:
  // a corrected starter never reached a board that had already been seeded,
  // so a wrong price stayed wrong until the database was dropped.
  const stale = (store.catalogOptionGroups || []).filter((group) => group.catalogItemId === item.id);
  if (stale.length) {
    const staleIds = new Set(stale.map((group) => group.id));
    store.catalogOptions = (store.catalogOptions || []).filter((option) => !staleIds.has(option.optionGroupId));
    store.catalogOptionGroups = (store.catalogOptionGroups || []).filter((group) => !staleIds.has(group.id));
  }
  for (const group of (store.listingStarterGroups || []).filter((candidate) => candidate.starterId === starter.id)) {
    const groupId = `cog_${prefix}_${group.id}`;
    store.catalogOptionGroups.push({
      id: groupId,
      catalogItemId: item.id,
      name: group.name,
      kind: group.kind,
      helpText: group.helpText ?? null,
      required: group.required,
      selectionMode: "single",
      sortOrder: group.sortOrder,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    for (const option of (store.listingStarterOptions || []).filter((candidate) => candidate.starterGroupId === group.id)) {
      store.catalogOptions.push({
        id: `cop_${prefix}_${option.id}`,
        optionGroupId: groupId,
        label: option.label,
        priceModifierMinor: optionPrices?.[option.id] ?? option.priceModifierMinor,
        // An option that multiplies rather than adds. Dropped here, Lovis's
        // "back-to-back, x2 the price" copied across as a free add-on.
        priceMultiplierBps: option.priceMultiplierBps ?? null,
        specBinding: option.specBinding ?? null,
        active: true,
        sortOrder: option.sortOrder,
        createdAt: at,
        updatedAt: at,
      });
    }
  }
  if (starter.defaultFormatCodes?.length) {
    item.fileFormatMode = "override";
    store.catalogItemFileFormats = (store.catalogItemFileFormats || [])
      .filter((format) => format.catalogItemId !== item.id);
    store.catalogItemFileFormats.push(
      ...starter.defaultFormatCodes.map((formatCode) => ({ catalogItemId: item.id, formatCode })),
    );
  }
}

/**
 * Idempotent local shop: Lovis Printshop for the development Clerk email.
 *
 * Looks up the live Clerk subject so Sign in works after a fresh migrate.
 * Does not run from `npm run seed`.
 */
export async function seedDevelopmentShop(database, {
  clerkBackend,
  objectStorage,
  now = () => new Date().toISOString(),
} = {}) {
  const clerkUser = await resolveDevClerkUser(LOVIS_DEV_SHOP.email, clerkBackend);
  const person = clerkClientProfile(clerkUser);
  const at = now();
  const listingPhotos = LOVIS_LISTINGS.map((listing) => {
    const body = starterSampleBytes(listing.starterId);
    return {
      ...listing,
      fileId: `file_lovis_${listing.starterId.replace(/^lst_/, "")}`,
      objectKey: `dev/lovis/${listing.starterId}.jpg`,
      body,
    };
  });
  const logoBody = starterSampleBytes("lst_tarpaulins_outdoor_banners");
  const logoKey = "dev/lovis/logo.jpg";
  let storedPhoto = await putJpeg(objectStorage, logoKey, logoBody);
  for (const listing of listingPhotos) {
    if (!(await putJpeg(objectStorage, listing.objectKey, listing.body))) storedPhoto = false;
  }

  await database.transaction(async () => {
    const store = await loadStore(database);
    const taxonomy = store.taxonomy?.categories?.length ? store.taxonomy : defaultTaxonomy();
    store.files ||= [];
    store.catalogItemPhotos ||= [];
    store.supplierShopMedia ||= [];
    store.catalogOptionGroups ||= [];
    store.catalogOptions ||= [];
    store.catalogItemFileFormats ||= [];
    store.catalogPrepSteps ||= [];
    store.supplierServiceFileFormats ||= [];
    store.userRoleMemberships ||= [];
    store.supplierProfiles ||= [];
    store.approvalCases ||= [];
    store.supplierServices ||= [];
    store.catalogItems ||= [];

    const byClerk = (store.users || []).find((user) => user.clerkUserId === clerkUser.id);
    const byEmail = (store.users || []).find(
      (user) => String(user.email || "").toLowerCase() === LOVIS_DEV_SHOP.email,
    );
    const user = byClerk || byEmail || { id: USER_ID, createdAt: at };
    user.clerkUserId = clerkUser.id;
    user.email = LOVIS_DEV_SHOP.email;
    user.name = person.name || LOVIS_DEV_SHOP.contactName;
    user.role = "supplier";
    user.verificationStatus = "approved";
    user.supplierName = LOVIS_DEV_SHOP.shopName;
    user.shop = { ...LOVIS_DEV_SHOP.shop };
    user.phone = person.phone || LOVIS_DEV_SHOP.phone;
    if (!(store.users || []).some((candidate) => candidate.id === user.id)) {
      store.users.push(user);
    }

    if (!store.userRoleMemberships.some((row) => row.userId === user.id && row.role === "supplier")) {
      store.userRoleMemberships.push({ userId: user.id, role: "supplier", createdAt: at });
    }

    upsert(store.supplierProfiles, "userId", {
      userId: user.id,
      shopName: LOVIS_DEV_SHOP.shopName,
      contactName: person.name || LOVIS_DEV_SHOP.contactName,
      shop: { ...LOVIS_DEV_SHOP.shop },
      pickupAvailable: false,
      version: 1,
      updatedAt: at,
    });

    const existingCase = store.approvalCases.find(
      (row) => row.userId === user.id && row.kind === "supplier",
    );
    if (existingCase) {
      existingCase.status = "approved";
      existingCase.submittedAt ||= at;
      existingCase.decidedAt ||= at;
      existingCase.updatedAt = at;
    } else {
      store.approvalCases.push({
        id: CASE_ID,
        userId: user.id,
        kind: "supplier",
        status: "approved",
        version: 1,
        applicationRevision: 1,
        submittedAt: at,
        decidedAt: at,
        createdAt: at,
        updatedAt: at,
      });
    }

    for (const line of LOVIS_CATEGORY_LINES) {
      upsert(store.supplierServices, "id", {
        id: line.id,
        supplierId: user.id,
        categoryCode: line.categoryCode,
        state: "live",
        pricingBasis: "per_unit",
        referenceRateMinor: line.referenceRateMinor,
        turnaroundHours: line.turnaroundHours,
        capacityDaily: line.capacityDaily ?? null,
        capacityWeekly: null,
        standardTurnaroundHours: line.turnaroundHours,
        rushEnabled: false,
        materialCodes: codesFor(taxonomy, "materials", line.categoryCode),
        finishCodes: codesFor(taxonomy, "finishes", line.categoryCode),
        productFamilyIds: [],
        zones: ["davao_central"],
        equipmentNotes: "Placeholder development line for Lovis Printshop.",
        imageFileIds: [],
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      store.supplierServiceFileFormats = store.supplierServiceFileFormats
        .filter((row) => row.supplierServiceId !== line.id);
      store.supplierServiceFileFormats.push(
        ...line.formats.map((formatCode) => ({ supplierServiceId: line.id, formatCode })),
      );
    }

    if (storedPhoto) {
      ensureFile(store, {
        fileId: LOGO_ID,
        ownerId: user.id,
        purpose: "supplier_shop_image",
        originalFilename: "lovis-printshop.jpg",
        declaredContentType: "image/jpeg",
        detectedContentType: "image/jpeg",
        size: logoBody.length,
        state: "ready",
        objectKey: logoKey,
        createdAt: at,
        readyAt: at,
      });
      const logo = store.supplierShopMedia.find(
        (row) => row.supplierId === user.id && row.slot === "logo",
      );
      if (logo) {
        logo.fileId = LOGO_ID;
        logo.updatedAt = at;
      } else {
        store.supplierShopMedia.push({
          supplierId: user.id,
          slot: "logo",
          fileId: LOGO_ID,
          updatedAt: at,
        });
      }
    }

    for (const listing of listingPhotos) {
      const starter = (store.listingStarters || []).find((candidate) => candidate.id === listing.starterId);
      if (!starter) continue;
      const itemId = `sci_lovis_${starter.subcategoryCode}`;
      const item = {
        id: itemId,
        supplierId: user.id,
        supplierServiceId: listing.serviceId,
        subcategoryCode: starter.subcategoryCode,
        name: starter.name,
        // Never the shop's name. A client reads this under a GRIDGO label, so
        // a description signed by the press is where the anonymity leaks.
        description: listing.description,
        basePriceMinor: listing.priceMinor,
        // The starter's unit is the template's guess; a listing that states
        // its own overrules it, the same rule the other shops follow.
        pricingUnit: listing.pricingUnit || starter.defaultPricingUnit || "per_unit",
        packageQty: listing.pricingUnit ? null : (starter.defaultPackageQty ?? null),
        measureUnit: listing.measureUnit ?? null,
        minimumWidthMilli: listing.minimumWidthMilli ?? null,
        minimumHeightMilli: listing.minimumHeightMilli ?? null,
        minimumLengthMilli: listing.minimumLengthMilli ?? null,
        minimumOrderQuantity: listing.minimumOrderQuantity ?? null,
        turnaroundMode: starter.defaultTurnaroundHours ? "override" : "inherit",
        turnaroundHours: starter.defaultTurnaroundHours ?? null,
        fileFormatMode: starter.defaultFormatCodes?.length ? "override" : "inherit",
        active: true,
        sortOrder: listingPhotos.indexOf(listing),
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      upsert(store.catalogItems, "id", item);
      copyStarter(store, starter, store.catalogItems.find((row) => row.id === itemId), at);
      seedListingTiers(store, itemId, listing, at);
      if (storedPhoto) {
        ensureFile(store, {
          fileId: listing.fileId,
          ownerId: user.id,
          purpose: "catalog_item_photo",
          originalFilename: `${listing.starterId}.jpg`,
          declaredContentType: "image/jpeg",
          detectedContentType: "image/jpeg",
          size: listing.body.length,
          state: "ready",
          objectKey: listing.objectKey,
          createdAt: at,
          readyAt: at,
        });
        const photo = store.catalogItemPhotos.find((row) => row.catalogItemId === itemId);
        if (!photo) {
          store.catalogItemPhotos.push({
            catalogItemId: itemId,
            fileId: listing.fileId,
            sortOrder: 0,
            altText: starter.name,
            createdAt: at,
          });
        }
      }
    }

    await saveStore(database, store);
  });

  return { email: LOVIS_DEV_SHOP.email, shopName: LOVIS_DEV_SHOP.shopName, clerkUserId: clerkUser.id, photos: storedPhoto };
}

/**
 * The four other pilot shops, from the Davao master price list.
 *
 * Each is a real Clerk sign-in so the captain can log in as any of them and
 * work the supplier app for that trade. They are deliberately spread across
 * three categories and four corners of the city: with every shop selling the
 * same thing from the same street, matching has nothing to rank and the
 * quality, speed, cost and distance factors cannot be told apart.
 *
 * Prices are the shop's own figures where the master list states one. Two do
 * not, and are marked. None of them can express what the shop really charges
 * yet -- Polymedia sells tarpaulin by the square foot and plaques by the inch
 * of height, which needs the pricing columns this seed does not have. These
 * stand in until then, so matching and the order flow have real shops to work
 * with; they are not what those shops charge.
 */
export const ADDITIONAL_DEV_SHOPS = Object.freeze([
  {
    slug: "dara_blueprint",
    email: "felycia123@proton.me",
    shopName: "Dara Blueprint",
    shop: {
      lat: 7.061391404845615,
      lng: 125.59319894381005,
      label: "Camia St, Talomo, Davao City",
    },
    services: [
      {
        categoryCode: "specialized_prototyping",
        turnaroundHours: 24,
        formats: ["pdf"], // "1. FILE & FORMAT REQUIREMENTS -- PDF only"
        capacityDaily: 40, // large-format sheets, not a volume trade
        listings: [
          {
            starterId: "lst_blueprint_cad_plotting",
            variant: "cad",
            name: "CAD plotting",
            priceMinor: 6_500, // PHP 65.00 at 20x30 / A2
            // The size ladder is this service's own. Six services share one
            // shape and none of them share a price, which is exactly why they
            // are six listings rather than one with a service option.
            optionPrices: {
              lsto_plot_a2: 0,
              lsto_plot_a1: 1_500,
              lsto_plot_30x40: 8_500,
              lsto_plot_a0: 11_500,
            },
            description: "High-precision CAD plotting for architectural and engineering plans. PDF files only.",
          },
          {
            starterId: "lst_blueprint_cad_plotting",
            variant: "ammonia",
            name: "Ammonia blueprint",
            priceMinor: 1_500, // PHP 15.00 at 20x30 / A2
            // The size ladder is this service's own. Six services share one
            // shape and none of them share a price, which is exactly why they
            // are six listings rather than one with a service option.
            optionPrices: {
              lsto_plot_a2: 0,
              lsto_plot_a1: 1_300,
              lsto_plot_30x40: 3_000,
              lsto_plot_a0: 4_000,
            },
            description: "Traditional ammonia-process blueprint copies for plan sets and permit submissions.",
          },
          {
            starterId: "lst_blueprint_cad_plotting",
            variant: "whiteprint",
            name: "Whiteprint",
            priceMinor: 3_000, // PHP 30.00 at 20x30 / A2
            // The size ladder is this service's own. Six services share one
            // shape and none of them share a price, which is exactly why they
            // are six listings rather than one with a service option.
            optionPrices: {
              lsto_plot_a2: 0,
              lsto_plot_a1: 1_000,
              lsto_plot_30x40: 5_500,
              lsto_plot_a0: 7_000,
            },
            description: "Whiteprint copies for site sets and shop drawings, on whiteprint stock.",
          },
          {
            starterId: "lst_blueprint_cad_plotting",
            variant: "digital_white",
            name: "Digital blueprint, white paper",
            priceMinor: 2_500, // PHP 25.00 at 20x30 / A2
            // The size ladder is this service's own. Six services share one
            // shape and none of them share a price, which is exactly why they
            // are six listings rather than one with a service option.
            optionPrices: {
              lsto_plot_a2: 0,
              lsto_plot_a1: 1_000,
              lsto_plot_30x40: 5_500,
              lsto_plot_a0: 6_000,
            },
            description: "Digital plan copies on white paper, for revisions and working sets.",
          },
          {
            starterId: "lst_blueprint_cad_plotting",
            variant: "digital_blue",
            name: "Digital blueprint, blue paper",
            priceMinor: 3_000, // PHP 30.00 at 20x30 / A2
            // The size ladder is this service's own. Six services share one
            // shape and none of them share a price, which is exactly why they
            // are six listings rather than one with a service option.
            optionPrices: {
              lsto_plot_a2: 0,
              lsto_plot_a1: 1_000,
              lsto_plot_30x40: 6_000,
              lsto_plot_a0: 6_000,
            },
            description: "Digital plan copies on blue paper, the traditional look without the ammonia process.",
          },
          {
            starterId: "lst_blueprint_cad_plotting",
            variant: "colour",
            name: "Full-page colour plan",
            priceMinor: 20_000, // PHP 200.00 at 20x30 / A2
            // The size ladder is this service's own. Six services share one
            // shape and none of them share a price, which is exactly why they
            // are six listings rather than one with a service option.
            optionPrices: {
              lsto_plot_a2: 0,
              lsto_plot_a1: 5_000,
              lsto_plot_30x40: 15_000,
              lsto_plot_a0: 25_000,
            },
            description: "Full-colour large-format plans for presentation sets and client submissions.",
          },
        ],
      },
    ],
  },
  {
    slug: "jopal_davao",
    email: "felycia123@polynomial-princess.com",
    shopName: "Jopal Davao",
    shop: {
      lat: 7.0729598559850615,
      lng: 125.62065833216744,
      label: "Door 2 Calderon Bldg., J. Luna St, Poblacion, Davao City",
    },
    services: [
      {
        categoryCode: "corporate_event_merch",
        turnaroundHours: 120, // "5 days for 100-200 pcs"
        capacityDaily: 40,
        listings: [
          {
            starterId: "lst_custom_apparel",
            priceMinor: 18_000, // PHP 180.00, print and press t-shirt with cloth
            description: "Direct-to-film and full dye-sublimation on tees, polos and jerseys. Ready-to-print files only.",
          },
          {
            starterId: "lst_drinkware",
            priceMinor: 10_000, // PHP 100.00 a piece under 250
            // The break replaces the rate from 250 up rather than discounting
            // it, which is how the shop quotes it and how the pricer bills it.
            priceTiers: [{ minQuantity: 250, unitPriceMinor: 6_000 }],
            description: "Sublimated mugs for events, giveaways and corporate gifts.",
          },
        ],
      },
      {
        // Stickers are marketing collateral, not merchandise, so they need
        // their own line -- a listing can only sit under a service line
        // declaring the category its subcategory belongs to.
        categoryCode: "marketing_collateral",
        turnaroundHours: 120,
        capacityDaily: 30,
        listings: [{
          starterId: "lst_stickers_packaging_labels",
          // Sold by the running metre off an 11-inch roll, so the client says
          // how long they want rather than how many.
          pricingUnit: "per_length",
          measureUnit: "m",
          priceMinor: 75_000, // PHP 750.00 a metre of 11in UV sticker
          description: "UV stickers by the metre. Ready-to-print PNG or JPG, RGB or CMYK.",
        }],
      },
    ],
  },
  {
    slug: "pins_on",
    email: "felycia123@lumeya-ai.com",
    shopName: "Pins On",
    shop: {
      lat: 7.0862901948541035,
      lng: 125.61505126462532,
      label: "Manuel Bldg., Iñigo St, Poblacion, Davao City",
    },
    services: [
      {
        categoryCode: "corporate_event_merch",
        turnaroundHours: 72, // "normal turnaround: 3 days, no rush fee"
        capacityDaily: 70,
        listings: [{
          starterId: "lst_corporate_giveaways",
          // The master list gives this shop's finishes, minimum and rush fees
          // but never a price per pin. Confirm with the shop before anything
          // of theirs goes on a real board.
          priceMinor: 2_500,
          // The description said "minimum 20 pieces" while the listing would
          // take an order of one, which is a promise the board could not keep.
          minimumOrderQuantity: 20,
          // A flat fee added to the order, not a different price per pin --
          // the other shape a speed can take, and the one this shop quotes.
          speedTiers: [
            { label: "1 to 3 days", turnaroundHours: 72, surchargeMinor: 5_000 },
            { label: "Under 24 hours", turnaroundHours: 24, surchargeMinor: 10_000 },
          ],
          description: "Custom button pins in glossy or glitter finish. Minimum 20 pieces.",
        }],
      },
    ],
  },
  {
    slug: "polymedia",
    email: "felycia123@talasoraprime.com",
    shopName: "Polymedia Printing Services",
    shop: {
      lat: 7.088551681322852,
      lng: 125.61598902558961,
      label: "Corner New Burgos, Nicasio Torres St, Barrio Obrero, Davao City",
    },
    services: [
      {
        categoryCode: "marketing_collateral",
        turnaroundHours: 24,
        capacityDaily: 8, // large-format jobs a day across both printers
        listings: [
          {
            starterId: "lst_tarpaulins_outdoor_banners",
            // The master list quotes this by the square foot, not by the
            // banner, and the shop bills a small one at its 2x4 minimum
            // because the sheet is wasted either way.
            pricingUnit: "per_area",
            measureUnit: "ft",
            priceMinor: 4_000, // PHP 40.00 per square foot, eco-solvent
            minimumWidthMilli: 2_000,
            minimumHeightMilli: 4_000,
            description: "Heavy-duty eco-solvent tarpaulin for events, campaigns and roadside signs.",
          },
          {
            starterId: "lst_stickers_packaging_labels",
            pricingUnit: "per_area",
            measureUnit: "ft",
            priceMinor: 6_350, // PHP 63.50 per square foot, eco-solvent vinyl
            description: "Vinyl sticker printing in matte, frosted, clear or glossy.",
          },
        ],
      },
      {
        categoryCode: "recognition_awards_signage",
        turnaroundHours: 48,
        capacityDaily: 25,
        listings: [
          {
            starterId: "lst_plaques_trophies",
            // Priced by height, which is a length rather than an area: the
            // face is a fixed proportion, so the shop quotes the one number
            // that varies.
            pricingUnit: "per_length",
            measureUnit: "in",
            priceMinor: 10_000, // PHP 100.00 per inch of height
            minimumLengthMilli: 5_000, // the smallest they cut is five inches
            description: "Acrylic plaques, 3mm face on a 5mm base, priced by height.",
          },
          {
            starterId: "lst_certificates_diplomas",
            priceMinor: 18_000, // PHP 180.00 a piece, C2S
            description: "Coated two-sides award certificates, A5 through A1.",
          },
          {
            // "Fixed Price PHP 5,400 All-in Package". Not per piece and not
            // per foot: one price for the whole job, whatever it involves.
            starterId: "lst_business_store_signages",
            pricingUnit: "whole_job",
            priceMinor: 540_000,
            description:
              "Acrylic and Panaflex store signage as one all-in package, surveyed and installed.",
          },
        ],
      },
    ],
  },
]);

/**
 * The volume breaks and speeds a listing sells at.
 *
 * Both are how these shops actually quote and neither fits in a single price:
 * Jopal drops mugs from PHP 100 to PHP 60 at 250, which is a different rate
 * rather than a discount, and a shop selling the same book at four speeds is
 * selling four prices rather than a price and three surcharges.
 *
 * Replaced rather than appended, so re-running the seed does not stack a
 * second copy of every break onto a board that already has them.
 */
/**
 * Take down a seeded listing this fixture no longer describes.
 *
 * The seed upserts, so a listing that is renamed or split into several leaves
 * its old self behind -- Dara's six blueprint services arrived beside the one
 * listing they replaced, and a client browsing saw the same plotting service
 * twice at the same price.
 *
 * Only listings the seed itself owns, and only while nothing has ordered from
 * one. A listing a real order references is history rather than fixture data,
 * which is why the platform archives one instead of deleting it.
 */
function retireUnseededListings(store, slug, keep) {
  const prefix = `sci_${slug}_`;
  const ordered = new Set((store.orderLineItems || []).map((line) => line.sourceCatalogItemId));
  const staleIds = new Set(
    (store.catalogItems || [])
      .filter((item) => item.id.startsWith(prefix) && !keep.has(item.id) && !ordered.has(item.id))
      .map((item) => item.id),
  );
  if (!staleIds.size) return;

  const groupIds = new Set(
    (store.catalogOptionGroups || [])
      .filter((group) => staleIds.has(group.catalogItemId))
      .map((group) => group.id),
  );
  store.catalogOptions = (store.catalogOptions || []).filter((option) => !groupIds.has(option.optionGroupId));
  store.catalogOptionGroups = (store.catalogOptionGroups || []).filter((group) => !staleIds.has(group.catalogItemId));
  store.catalogItemPhotos = (store.catalogItemPhotos || []).filter((photo) => !staleIds.has(photo.catalogItemId));
  store.catalogItemFileFormats = (store.catalogItemFileFormats || []).filter((row) => !staleIds.has(row.catalogItemId));
  store.catalogPrepSteps = (store.catalogPrepSteps || []).filter((row) => !staleIds.has(row.catalogItemId));
  store.catalogPriceTiers = (store.catalogPriceTiers || []).filter((row) => !staleIds.has(row.catalogItemId));
  store.catalogSpeedTiers = (store.catalogSpeedTiers || []).filter((row) => !staleIds.has(row.catalogItemId));
  store.catalogItems = (store.catalogItems || []).filter((item) => !staleIds.has(item.id));
}

function seedListingTiers(store, itemId, listing, at) {
  store.catalogPriceTiers = (store.catalogPriceTiers || []).filter((row) => row.catalogItemId !== itemId);
  store.catalogSpeedTiers = (store.catalogSpeedTiers || []).filter((row) => row.catalogItemId !== itemId);

  for (const tier of listing.priceTiers || []) {
    store.catalogPriceTiers.push({
      id: `pt_${itemId}_${tier.minQuantity}`,
      catalogItemId: itemId,
      minQuantity: tier.minQuantity,
      unitPriceMinor: tier.unitPriceMinor,
      createdAt: at,
      updatedAt: at,
    });
  }
  for (const [order, tier] of (listing.speedTiers || []).entries()) {
    store.catalogSpeedTiers.push({
      id: `st_${itemId}_${tier.turnaroundHours}`,
      catalogItemId: itemId,
      label: tier.label,
      turnaroundHours: tier.turnaroundHours,
      priceMinor: tier.priceMinor ?? null,
      surchargeMinor: tier.surchargeMinor ?? null,
      sortOrder: order,
      createdAt: at,
      updatedAt: at,
    });
  }
}

function clerkRows(result) {
  const rows = result?.data || result || [];
  return Array.isArray(rows) ? rows : [];
}

async function seedAdditionalDevelopmentShop(database, fixture, { clerkBackend, objectStorage, now }) {
  // A real sign-in, not a fabricated id. These shops exist so the captain can
  // log into the supplier app as each trade and work its board, which a
  // synthetic clerk_dev_* row cannot do.
  const clerkUser = await resolveDevClerkUser(fixture.email, clerkBackend);
  const clerkUserId = clerkUser.id;
  const email = fixture.email;
  const person = clerkClientProfile(clerkUser);
  const at = now();
  const uploaded = [];
  for (const service of fixture.services) {
    for (const listing of service.listings) {
      const body = starterSampleBytes(listing.starterId);
      // Per listing, not per starter: six blueprint services copy one template
      // and would otherwise all claim the same object, which storage refuses.
      const objectKey = `dev/${fixture.slug}/${listing.starterId}${listing.variant ? `_${listing.variant}` : ""}.jpg`;
      uploaded.push({
        ...listing,
        categoryCode: service.categoryCode,
        turnaroundHours: service.turnaroundHours,
        body,
        objectKey,
        stored: await putJpeg(objectStorage, objectKey, body),
      });
    }
  }

  await database.transaction(async () => {
    const store = await loadStore(database);
    store.files ||= [];
    store.catalogItemPhotos ||= [];
    store.catalogOptionGroups ||= [];
    store.catalogOptions ||= [];
    store.catalogItemFileFormats ||= [];
    store.supplierServiceFileFormats ||= [];
    store.userRoleMemberships ||= [];
    store.supplierProfiles ||= [];
    store.approvalCases ||= [];
    store.supplierServices ||= [];
    store.catalogItems ||= [];

    const byClerk = store.users.find((user) => user.clerkUserId === clerkUserId);
    const bySlug = store.users.find((user) => user.id === `user_${fixture.slug}`);
    const user = byClerk || bySlug || { id: `user_${fixture.slug}`, createdAt: at };
    user.clerkUserId = clerkUserId;
    user.email = email;
    user.name = person.name || fixture.shopName;
    user.phone = person.phone || user.phone || null;
    user.role = "supplier";
    user.verificationStatus = "approved";
    user.supplierName = fixture.shopName;
    user.shop = { ...fixture.shop };
    if (!store.users.some((candidate) => candidate.id === user.id)) store.users.push(user);

    if (!store.userRoleMemberships.some((row) => row.userId === user.id && row.role === "supplier")) {
      store.userRoleMemberships.push({ userId: user.id, role: "supplier", createdAt: at });
    }
    upsert(store.supplierProfiles, "userId", {
      userId: user.id,
      shopName: fixture.shopName,
      contactName: person.name || fixture.shopName,
      shop: { ...fixture.shop },
      pickupAvailable: true,
      version: 1,
      updatedAt: at,
    });
    const approvalCase = store.approvalCases.find((row) => row.userId === user.id && row.kind === "supplier");
    if (approvalCase) {
      approvalCase.status = "approved";
      approvalCase.submittedAt ||= at;
      approvalCase.decidedAt ||= at;
      approvalCase.updatedAt = at;
    } else {
      store.approvalCases.push({
        id: `apc_${fixture.slug}`,
        userId: user.id,
        kind: "supplier",
        status: "approved",
        version: 1,
        applicationRevision: 1,
        submittedAt: at,
        decidedAt: at,
        createdAt: at,
        updatedAt: at,
      });
    }

    // A service line carries one category, so a shop working across two of them
    // -- Polymedia sells banners and it sells awards -- declares one line each.
    const serviceIdFor = (categoryCode) => `svc_${fixture.slug}_${categoryCode}`;
    for (const service of fixture.services) {
      const serviceId = serviceIdFor(service.categoryCode);
      upsert(store.supplierServices, "id", {
        id: serviceId,
        supplierId: user.id,
        categoryCode: service.categoryCode,
        state: "live",
        pricingBasis: "per_unit",
        referenceRateMinor: service.listings[0].priceMinor,
        turnaroundHours: service.turnaroundHours,
        standardTurnaroundHours: service.turnaroundHours,
        // What the shop can actually run in a day, from its own catalogue:
        // Jopal quotes "5 days for 100-200 pcs" and Pins On "200 pcs within
        // 2-3 days". Without this the schedule has no idea what full means and
        // every day reads as merely having work on it.
        capacityDaily: service.capacityDaily ?? null,
        capacityWeekly: null,
        rushEnabled: false,
        materialCodes: [],
        finishCodes: [],
        productFamilyIds: [],
        zones: ["davao_central"],
        equipmentNotes: `${service.categoryCode} work, seeded from the Davao master price list.`,
        imageFileIds: [],
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      store.supplierServiceFileFormats = store.supplierServiceFileFormats.filter((row) => row.supplierServiceId !== serviceId);
      store.supplierServiceFileFormats.push(
        ...(service.formats || DESIGN_FORMATS).map((formatCode) => ({ supplierServiceId: serviceId, formatCode })),
      );
    }

    const seededItemIds = new Set();
    for (const listing of uploaded) {
      const starter = store.listingStarters.find((candidate) => candidate.id === listing.starterId);
      if (!starter) continue;
      // A shop may sell several distinct things under one subcategory: Dara
      // runs six blueprint services, each with its own size ladder, and they
      // are not one listing with options because the ladders differ. `variant`
      // is what keeps their ids, photos and copied options apart.
      const key = listing.variant
        ? `${starter.subcategoryCode}_${listing.variant}`
        : starter.subcategoryCode;
      const itemId = `sci_${fixture.slug}_${key}`;
      upsert(store.catalogItems, "id", {
        id: itemId,
        supplierId: user.id,
        supplierServiceId: serviceIdFor(listing.categoryCode),
        subcategoryCode: starter.subcategoryCode,
        // A listing may name itself. Six blueprint services copied from one
        // template are all called "Blueprint plotting" otherwise, which is a
        // board a client cannot choose from.
        name: listing.name || starter.name,
        // Never the shop's name. The client reads this under a GRIDGO label,
        // and a description signed by the press undoes the whole point of
        // GRIDGO being the counter.
        description: listing.description,
        basePriceMinor: listing.priceMinor,
        // The starter's default unit is a sensible guess for a new shop; the
        // master list says what these five actually charge, and where the two
        // disagree the real one wins. A listing that states no unit of its own
        // keeps the starter's.
        pricingUnit: listing.pricingUnit || starter.defaultPricingUnit || "per_unit",
        packageQty: listing.pricingUnit ? null : (starter.defaultPackageQty ?? null),
        measureUnit: listing.measureUnit ?? null,
        minimumWidthMilli: listing.minimumWidthMilli ?? null,
        minimumHeightMilli: listing.minimumHeightMilli ?? null,
        minimumLengthMilli: listing.minimumLengthMilli ?? null,
        minimumOrderQuantity: listing.minimumOrderQuantity ?? null,
        turnaroundMode: "override",
        turnaroundHours: listing.turnaroundHours,
        fileFormatMode: starter.defaultFormatCodes?.length ? "override" : "inherit",
        active: true,
        sortOrder: uploaded.indexOf(listing),
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      seededItemIds.add(itemId);
      const item = store.catalogItems.find((row) => row.id === itemId);
      // Prefixed per listing, not per shop: six listings copying one starter
      // would otherwise claim the same option ids.
      copyStarter(store, starter, item, at, `${fixture.slug}_${key}`, listing.optionPrices);
      seedListingTiers(store, itemId, listing, at);
      if (!listing.stored) continue;
      const fileId = `file_${fixture.slug}_${key}`;
      ensureFile(store, {
        fileId,
        ownerId: user.id,
        purpose: "catalog_item_photo",
        originalFilename: `${listing.starterId}.jpg`,
        declaredContentType: "image/jpeg",
        detectedContentType: "image/jpeg",
        size: listing.body.length,
        state: "ready",
        objectKey: listing.objectKey,
        createdAt: at,
        readyAt: at,
      });
      const photo = store.catalogItemPhotos.find((row) => row.catalogItemId === itemId);
      if (photo) {
        photo.fileId = fileId;
      } else {
        store.catalogItemPhotos.push({ catalogItemId: itemId, fileId, sortOrder: 0, altText: listing.name || starter.name, createdAt: at });
      }
    }
    retireUnseededListings(store, fixture.slug, seededItemIds);
    await saveStore(database, store);
  });
  return { email, shopName: fixture.shopName, clerkUserId, photos: uploaded.every((row) => row.stored) };
}

async function seedDevelopmentClient(database, clerkBackend, now) {
  let clientUserId = null;
  const clerkUser = await resolveDevClerkUser(MARK_DEV_CLIENT.email, clerkBackend);
  const person = clerkClientProfile(clerkUser);
  const at = now();
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.userRoleMemberships ||= [];
    store.clientProfiles ||= [];
    const takenByShop = store.users.find(
      (user) =>
        (user.clerkUserId === clerkUser.id || String(user.email || "").toLowerCase() === person.email) &&
        user.role !== "client",
    );
    if (takenByShop) {
      takenByShop.clerkUserId = `clerk_dev_${takenByShop.id.replace(/^user_/, "")}`;
      takenByShop.email = `dev+${takenByShop.id.replace(/^user_/, "")}@gridgo.local`;
    }
    const byClerk = store.users.find((user) => user.clerkUserId === clerkUser.id);
    const byEmail = store.users.find((user) => String(user.email || "").toLowerCase() === person.email);
    const user = byClerk || byEmail || { id: "user_markdavid_client", createdAt: at };
    user.clerkUserId = clerkUser.id;
    user.email = person.email;
    user.name = person.name || MARK_DEV_CLIENT.name;
    user.phone = person.phone || user.phone || null;
    user.role = "client";
    user.accountType = "individual";
    user.orgName = null;
    delete user.verificationStatus;
    clientUserId = user.id;
    if (!store.users.some((candidate) => candidate.id === user.id)) store.users.push(user);
    store.userRoleMemberships = store.userRoleMemberships.filter(
      (row) => !(row.userId === user.id && row.role !== "client"),
    );
    if (!store.userRoleMemberships.some((row) => row.userId === user.id && row.role === "client")) {
      store.userRoleMemberships.push({ userId: user.id, role: "client", createdAt: at });
    }
    const profile = store.clientProfiles.find((row) => row.userId === user.id);
    if (profile) {
      profile.clientKind = "personal";
      profile.businessName = null;
      profile.businessNature = null;
      profile.updatedAt = at;
    } else {
      store.clientProfiles.push({ userId: user.id, clientKind: "personal", updatedAt: at });
    }
    await saveStore(database, store);
  });
  return { email: person.email, clerkUserId: clerkUser.id, userId: clientUserId };
}

/**
 * Idempotent local rider for the live Clerk email so Sign in works after a
 * fresh migrate, without sending the rider through apply.
 */
export async function seedDevelopmentRider(database, clerkBackend, now = () => new Date().toISOString()) {
  const clerkUser = await resolveDevClerkUser(MARK_DEV_RIDER.email, clerkBackend);
  const person = clerkClientProfile(clerkUser);
  const at = typeof now === "function" ? now() : now;
  const email = MARK_DEV_RIDER.email.toLowerCase();
  return database.transaction(async () => {
    const existing = await database.query(
      `SELECT id, phone, created_at, version, position, data
         FROM users
        WHERE clerk_user_id = $1 OR lower(email) = $2
        ORDER BY CASE WHEN clerk_user_id = $1 THEN 0 ELSE 1 END
        LIMIT 1`,
      [clerkUser.id, email],
    );
    const row = existing.rows[0];
    const userId = row?.id || "user_markdavid_rider";
    const createdAt = row?.created_at || at;
    const version = row?.version || 1;
    const position = row?.position ?? Number((await database.query("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM users")).rows[0].next);
    const data = row?.data && typeof row.data === "object" ? row.data : {};
    await database.query(
      `INSERT INTO users (
         id, clerk_user_id, email, name, phone, role, account_type, org_name,
         verification_status, shop_lat, shop_lng, shop_label, version, created_at, position, data
       ) VALUES (
         $1, $2, $3, $4, $5, 'rider', NULL, NULL,
         'approved', NULL, NULL, NULL, $6, $7, $8, $9::jsonb
       )
       ON CONFLICT (id) DO UPDATE SET
         clerk_user_id = EXCLUDED.clerk_user_id,
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         phone = EXCLUDED.phone,
         role = 'rider',
         account_type = NULL,
         org_name = NULL,
         verification_status = 'approved'`,
      [
        userId,
        clerkUser.id,
        email,
        person.name || MARK_DEV_RIDER.name,
        person.phone || row?.phone || MARK_DEV_RIDER.phone,
        version,
        createdAt,
        position,
        JSON.stringify(data),
      ],
    );
    await database.query(
      `INSERT INTO user_role_memberships (user_id, role, created_at, created_by)
       VALUES ($1, 'rider', $2, $1)
       ON CONFLICT (user_id, role) DO NOTHING`,
      [userId, at],
    );
    await database.query(
      `INSERT INTO rider_profiles (user_id, vehicle_type, plate_number, license_number, version, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         vehicle_type = EXCLUDED.vehicle_type,
         plate_number = EXCLUDED.plate_number,
         license_number = EXCLUDED.license_number,
         updated_at = EXCLUDED.updated_at`,
      [userId, MARK_DEV_RIDER.vehicleType, MARK_DEV_RIDER.plateNumber, MARK_DEV_RIDER.licenseNumber, at],
    );
    const existingCase = await database.query(
      `SELECT id FROM approval_cases WHERE user_id = $1 AND kind = 'rider' LIMIT 1`,
      [userId],
    );
    if (existingCase.rows[0]) {
      await database.query(
        `UPDATE approval_cases
            SET status = 'approved',
                submitted_at = COALESCE(submitted_at, $2),
                decided_at = COALESCE(decided_at, $2),
                updated_at = $2
          WHERE id = $1`,
        [existingCase.rows[0].id, at],
      );
    } else {
      await database.query(
        `INSERT INTO approval_cases (
           id, user_id, kind, status, version, application_revision,
           submitted_at, decided_at, created_at, updated_at
         ) VALUES (
           'apc_markdavid_rider', $1, 'rider', 'approved', 1, 1,
           $2, $2, $2, $2
         )`,
        [userId, at],
      );
    }
    return { email: MARK_DEV_RIDER.email, clerkUserId: clerkUser.id };
  });
}

/**
 * Idempotent local Operations / Super Admin identities for the live Clerk emails.
 * Looks up each Clerk subject so dashboard sign-in works after a fresh migrate.
 */
export async function seedDevelopmentPrivilegedAccounts(database, {
  clerkBackend,
  now = () => new Date().toISOString(),
} = {}) {
  const backend = clerkBackend || createClerkBackend(authConfiguration(process.env));
  const accounts = [];
  for (const account of PRIVILEGED_DEV_ACCOUNTS) {
    accounts.push(await seedDevelopmentPrivilegedAccount(database, account, backend, now));
  }
  return accounts;
}

async function seedDevelopmentPrivilegedAccount(database, account, clerkBackend, now) {
  const clerkUser = await resolveDevClerkUser(account.email, clerkBackend);
  const person = clerkClientProfile(clerkUser);
  const at = typeof now === "function" ? now() : now;
  const email = account.email.toLowerCase();
  return database.transaction(async () => {
    const existing = await database.query(
      `SELECT id, phone, created_at, version, position, data
         FROM users
        WHERE clerk_user_id = $1 OR lower(email) = $2
        ORDER BY CASE WHEN clerk_user_id = $1 THEN 0 ELSE 1 END
        LIMIT 1`,
      [clerkUser.id, email],
    );
    const row = existing.rows[0];
    const userId = row?.id || account.id;
    const createdAt = row?.created_at || at;
    const version = row?.version || 1;
    const position = row?.position ?? Number((await database.query("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM users")).rows[0].next);
    const data = row?.data && typeof row.data === "object" ? row.data : {};
    await database.query(
      `INSERT INTO users (
         id, clerk_user_id, email, name, phone, role, account_type, org_name,
         verification_status, shop_lat, shop_lng, shop_label, version, created_at, position, data
       ) VALUES (
         $1, $2, $3, $4, $5, $6, NULL, NULL,
         NULL, NULL, NULL, NULL, $7, $8, $9, $10::jsonb
       )
       ON CONFLICT (id) DO UPDATE SET
         clerk_user_id = EXCLUDED.clerk_user_id,
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         phone = EXCLUDED.phone,
         role = EXCLUDED.role,
         account_type = NULL,
         org_name = NULL,
         verification_status = NULL`,
      [
        userId,
        clerkUser.id,
        email,
        person.name || account.name,
        person.phone || row?.phone || null,
        account.primaryRole,
        version,
        createdAt,
        position,
        JSON.stringify(data),
      ],
    );
    await database.query(
      `DELETE FROM user_role_memberships
        WHERE user_id = $1
          AND NOT (role = ANY($2::text[]))`,
      [userId, [...account.roles]],
    );
    for (const role of account.roles) {
      await database.query(
        `INSERT INTO user_role_memberships (user_id, role, created_at, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, role) DO NOTHING`,
        [userId, role, at, userId],
      );
    }
    return { email: account.email, clerkUserId: clerkUser.id, roles: [...account.roles] };
  });
}

/** Local-only shops plus the development client and rider. Extra shops are fixtures, not real Clerk people. */
export async function seedDevelopmentShops(database, {
  clerkBackend,
  objectStorage,
  now = () => new Date().toISOString(),
} = {}) {
  const backend = clerkBackend || createClerkBackend(authConfiguration(process.env));
  const lovis = await seedDevelopmentShop(database, { clerkBackend: backend, objectStorage, now });
  const shops = [lovis];
  for (const fixture of ADDITIONAL_DEV_SHOPS) {
    shops.push(await seedAdditionalDevelopmentShop(database, fixture, { clerkBackend: backend, objectStorage, now }));
  }
  const client = await seedDevelopmentClient(database, backend, now);
  const rider = await seedDevelopmentRider(database, backend, now);
  if (client.userId) await seedDevelopmentQueue(database, client.userId, now);
  const privileged = await seedDevelopmentPrivilegedAccounts(database, { clerkBackend: backend, now });
  return { shops, client, rider, privileged, photos: shops.every((shop) => shop.photos) };
}

/**
 * A believable fortnight of work in front of each shop.
 *
 * The schedule calendar is a view of a queue, and a queue nobody has placed is
 * a grid of empty circles that proves nothing. These are the smallest orders
 * that make it say something true: a day under capacity, a day at it, and days
 * with nothing on them, so a shop can see the difference between the three.
 *
 * Development only, and deliberately thin. Each is an order at a shop with a
 * date and a size -- enough for a board to load against -- and none of the
 * money, payment or payout machinery a real order carries, because none of
 * that is what this screen reads.
 *
 * Dated relative to the day the seed runs, so the fortnight is always the one
 * in front of you rather than a fixed month that scrolls into the past.
 */
const DEV_QUEUE = [
  // Lovis runs 2,000 pages a day. A full Thursday, a busy Friday.
  // `estimatedHours` is press time, not the promise. Without it every queued
  // job is charged the listing's whole turnaround, and four document runs
  // became a month of queue that made flyers unorderable.
  //
  // Each sits at a different real point in the lifecycle rather than all at
  // production, so a shop opening its board sees the states it will actually
  // work through -- something waiting on a quality check, something in
  // correction with the client, something already with a rider -- and every
  // screen that reads a state has a case to draw.
  // Quantities are what a client would really ask for, which is not the same
  // number in every trade: pages for a document, banners for a banner, reams
  // for a risograph run. A figure that reads as load on a shop's day and as an
  // order at the same time is one of them wrong -- six hundred reams of exam
  // paper is a year of work, not a Tuesday.
  { supplierId: "user_lovis_printshop", inDays: 2, quantity: 1_400, title: "Thesis reprint, 7 copies", subcategoryCode: "document_printing", estimatedHours: 4, state: "supplier_self_qc" },
  { supplierId: "user_lovis_printshop", inDays: 3, quantity: 2_000, title: "Department handouts", subcategoryCode: "document_printing", estimatedHours: 5, state: "production" },
  { supplierId: "user_lovis_printshop", inDays: 3, quantity: 250, title: "Programme booklets", subcategoryCode: "booklets", estimatedHours: 2, state: "needs_qa" },
  { supplierId: "user_lovis_printshop", inDays: 8, quantity: 2, title: "Exam papers", subcategoryCode: "risograph", estimatedHours: 3, state: "needs_qa" },

  // Polymedia bills 120 square feet a day.
  { supplierId: "user_polymedia", inDays: 1, quantity: 1, title: "Storefront tarpaulin", subcategoryCode: "tarpaulins_outdoor_banners", estimatedHours: 6, state: "ready_for_dispatch" },
  { supplierId: "user_polymedia", inDays: 4, quantity: 6, title: "Campaign banners, set of six", subcategoryCode: "tarpaulins_outdoor_banners", estimatedHours: 12, state: "production" },
  { supplierId: "user_polymedia", inDays: 9, quantity: 8, title: "Window decals", subcategoryCode: "stickers_packaging_labels", estimatedHours: 4, state: "needs_qa" },

  // Jopal presses 40 garments a day.
  { supplierId: "user_jopal_davao", inDays: 5, quantity: 40, title: "Team jerseys", subcategoryCode: "custom_apparel", estimatedHours: 24, state: "production" },
  { supplierId: "user_jopal_davao", inDays: 6, quantity: 18, title: "Staff polos", subcategoryCode: "custom_apparel", estimatedHours: 10, state: "client_correction" },

  // Pins On makes 70 pins a day.
  { supplierId: "user_pins_on", inDays: 2, quantity: 55, title: "Org giveaway pins", subcategoryCode: "corporate_giveaways", estimatedHours: 8, state: "out_for_delivery" },

  // Dara plots 40 sheets a day.
  { supplierId: "user_dara_blueprint", inDays: 7, quantity: 40, title: "Permit plan set", subcategoryCode: "blueprint_cad_plotting", estimatedHours: 6, state: "production" },

  // Both halves of a collected order's ending, because the two look nothing
  // alike and each has a screen of its own. One is on the counter, settled and
  // waiting for whoever placed it; the other reached the counter with the
  // balance still owed, and Operations must refuse to release it.
  { supplierId: "user_lovis_printshop", inDays: -1, quantity: 500, title: "Seminar handouts", subcategoryCode: "document_printing", estimatedHours: 2, state: "awaiting_collection", fulfillmentMode: "pickup", paymentStage: "settled" },
  { supplierId: "user_polymedia", inDays: -1, quantity: 3, title: "Booth backdrops", subcategoryCode: "tarpaulins_outdoor_banners", estimatedHours: 5, state: "awaiting_collection", fulfillmentMode: "pickup", paymentStage: "downpayment_cleared" },
];

/*
 Where each stage of a seeded job has got to.

 Written back from the state rather than forward from nothing: a job on the
 press has its printing photo filed and released, a packed one has both, and a
 collected one is waiting on the counter with its delivered share still owed.
 Retention is never released here, because no seeded job has sat out a full
 issue window.
*/
function seedPayoutStages(subtotalMinor, state, paymentStage, at) {
  const released = new Set();
  const proven = new Set();
  const printed = ["production", "supplier_self_qc", "ready_for_dispatch", "out_for_delivery", "awaiting_collection"];
  const packed = ["supplier_self_qc", "ready_for_dispatch", "out_for_delivery", "awaiting_collection"];
  if (printed.includes(state)) proven.add("printing");
  if (packed.includes(state)) proven.add("packaging_qc");
  // Only what the client's money actually covers. The first stage is half the
  // shop's price and the downpayment is three quarters of the whole order, so
  // printing clears on the downpayment and packing waits for the balance.
  if (paymentStage !== "submitted" && proven.has("printing")) released.add("printing");
  if (paymentStage === "settled" && proven.has("packaging_qc")) released.add("packaging_qc");

  return createPayoutMilestones({ supplierPlatformPayoutMinor: subtotalMinor }).map((milestone) => {
    if (released.has(milestone.code)) {
      return {
        ...milestone,
        status: "released",
        pofFileIds: [`file_pof_${milestone.code}`],
        releasedAt: at,
        releasedBy: "user_ops",
      };
    }
    if (proven.has(milestone.code)) {
      return { ...milestone, status: "pof_attached", pofFileIds: [`file_pof_${milestone.code}`] };
    }
    return milestone;
  });
}

/** The local day `offset` days from now, as an ISO instant at noon. */
function devQueueDate(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(12, 0, 0, 0);
  return date.toISOString();
}

/**
 * How far through paying an order at each state is.
 *
 * A shop does not start until the downpayment has cleared, and nothing is
 * fully paid until it is with a rider. Anything else is a board that reads
 * plausibly and is wrong about the one thing a client checks.
 */
function paymentStageFor(state) {
  if (state === "needs_qa" || state === "client_correction") return "submitted";
  if (state === "out_for_delivery" || state === "ready_for_dispatch") return "settled";
  return "downpayment_cleared";
}

/*
 A collected order settles at the counter, not at a door, so both halves of
 that moment have to be seedable: one paid and ready to hand over, one still
 owed and rightly refused. An entry may say which rather than have it inferred
 from a state that no longer implies one.
*/
function seedPaymentStage(entry) {
  return entry.paymentStage ?? paymentStageFor(entry.state);
}

/** The cheapest choice in every group a listing insists on. */
function defaultOptionIds(store, item) {
  return (store.catalogOptionGroups || [])
    .filter((group) => group.catalogItemId === item.id && group.required)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((group) => {
      const options = (store.catalogOptions || [])
        .filter((option) => option.optionGroupId === group.id && option.active !== false)
        .sort((left, right) => left.priceModifierMinor - right.priceModifierMinor);
      return options[0]?.id;
    })
    .filter(Boolean);
}

/** A measurement, for a listing that cannot be priced without one. */
function measurementForSeed(item, quantity) {
  const kind = measurementKindFor(item.pricingUnit || "per_unit");
  if (kind === "area") return { width: 3_000, height: 4_000 };
  if (kind === "length") return { length: 3_000 };
  // Pages times copies, so the quantity a client asked for is the page count.
  if (kind === "pages") return { pages: Math.max(1, quantity) };
  return null;
}

async function seedDevelopmentQueue(database, clientId, now) {
  const at = now();
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.orders ||= [];
    store.orderLineItems ||= [];
    store.auditLog ||= [];
    store.notifications ||= [];

    for (const [index, entry] of DEV_QUEUE.entries()) {
      // Skipped rather than invented: a shop the seed did not create is not
      // one to hang orders on.
      if (!store.users.some((user) => user.id === entry.supplierId)) continue;
      const item = (store.catalogItems || []).find(
        (row) => row.supplierId === entry.supplierId && row.subcategoryCode === entry.subcategoryCode,
      );
      if (!item) continue;

      const orderId = `order_dev_queue_${index}`;
      const promisedDate = devQueueDate(entry.inDays);
      const measurement = measurementForSeed(item, entry.quantity);
      const optionIds = defaultOptionIds(store, item);
      // For a listing priced by the page the client's number is the pages, so
      // one copy; everywhere else it is how many of the thing they wanted.
      const quantity = measurement?.pages ? 1 : entry.quantity;

      /*
       Priced through the same engine an order placed in the app goes through.

       A figure typed into the seed would drift from the catalogue the first
       time a shop changed a price, and the board would quietly be quoting
       something no listing sells. This asks the listing.
      */
      const { selectedOptions } = selectedCatalogPrice(store, item, optionIds);
      const priced = priceCatalogSelection(store, item, {
        selectedOptions,
        quantity,
        measurement,
      });

      const itemSubtotalMinor = priced.lineSubtotalMinor;
      const serviceFeeMinor = Math.round(
        (itemSubtotalMinor * (store.settings?.serviceFeeRateBps ?? 1_000)) / 10_000,
      );
      const deliveryFeeMinor = 5_000;
      const totalMinor = itemSubtotalMinor + serviceFeeMinor + deliveryFeeMinor;
      const downpaymentMinor = Math.round((totalMinor * 7_500) / 10_000);
      const balanceMinor = totalMinor - downpaymentMinor;
      const stage = seedPaymentStage(entry);

      upsert(store.orders, "id", {
        id: orderId,
        clientId,
        supplierId: entry.supplierId,
        state: entry.state,
        title: entry.title,
        quantity: entry.quantity,
        promisedDate,
        deadline: promisedDate,
        readyBy: promisedDate,
        estimatedHours: entry.estimatedHours,
        payoutHold: false,
        moneyModelVersion: 3,
        paymentPlan: "order_match_qr_75_25",
        // Both journeys, so a rider's board shows each. A collected order goes
        // from the shop to GRIDGO Office, where the client picks it up; a
        // delivered one goes to the client's own address. Every third is
        // collected, which is roughly the mix the pilot expects.
        fulfillmentMode: entry.fulfillmentMode ?? (index % 3 === 0 ? "pickup" : "delivery"),
        supplierSubtotalMinor: itemSubtotalMinor,
        subtotalMinor: itemSubtotalMinor,
        serviceFeeMinor,
        deliveryFeeMinor,
        totalMinor,
        onlineDueMinor: totalMinor,
        supplierPlatformPayoutMinor: itemSubtotalMinor,
        payments: {
          initial: {
            amountMinor: downpaymentMinor,
            method: "qr_manual",
            status: stage === "submitted" ? "pending_confirmation" : "confirmed",
            label: "75% downpayment",
            reference: `DEV-${index}-INIT`,
            submittedAt: at,
            confirmedAt: stage === "submitted" ? null : at,
          },
          final_online: {
            amountMinor: balanceMinor,
            method: "qr_manual",
            status: stage === "settled" ? "confirmed" : "not_submitted",
            label: "25% balance",
            reference: stage === "settled" ? `DEV-${index}-FINAL` : null,
            submittedAt: stage === "settled" ? at : null,
            confirmedAt: stage === "settled" ? at : null,
          },
        },
        /*
         The four stages a shop is paid across, at the point this job has
         actually reached.

         Without them the shop's money screen opens empty on every seeded job,
         which is the one screen a shop checks daily -- and a demo that shows a
         shop nothing about its own earnings teaches it the app has none.
        */
        payoutMilestones: seedPayoutStages(itemSubtotalMinor, entry.state, stage, at),
        createdAt: at,
        updatedAt: at,
      });

      // The line the money came from, so an order can say what was ordered
      // rather than only what it cost.
      upsert(store.orderLineItems, "id", {
        id: `oli_dev_queue_${index}`,
        orderId,
        sourceCatalogItemId: item.id,
        sourceSupplierServiceId: item.supplierServiceId,
        itemNameSnapshot: item.name,
        descriptionSnapshot: item.description || "",
        pricingBasisSnapshot: item.pricingUnit || "per_unit",
        pricingUnitSnapshot: item.pricingUnit || "per_unit",
        packageQtySnapshot: item.packageQty ?? null,
        turnaroundHoursSnapshot: item.turnaroundHours ?? null,
        baseUnitPriceMinor: item.basePriceMinor,
        // The rate the line was actually charged at, options and any volume
        // break included. The base price alone leaves the subtotal unable to
        // be a rate times a count, which is the one thing the database still
        // checks for a line sold by the piece.
        effectiveUnitPriceMinor: priced.unitRateMinor,
        quantity,
        measurement,
        lineSubtotalMinor: itemSubtotalMinor,
        // What the shop takes, snapshotted at the moment of the order — the
        // platform insists a line records it, because the formats a listing
        // accepts can change after a job is placed against it.
        acceptedFormatCodesSnapshot: (store.catalogItemFileFormats || [])
          .filter((row) => row.catalogItemId === item.id)
          .map((row) => row.formatCode),
        structuredSpecSnapshot: {},
        sortOrder: 0,
        snapshotFinalized: true,
        createdAt: at,
      });

      seedQueueAudit(store, { orderId, clientId, entry, stage, at, index });
      let ntf = 0;
      notifyOrderParties(store, store.orders.find((row) => row.id === orderId), {
        createId: () => `ntf_dev_queue_${index}_${ntf++}`,
        at,
      });
    }
    await saveStore(database, store);
  });
}

/**
 * The trail an order of this age would really have left.
 *
 * Written back from the state it is in rather than forward from nothing: an
 * order in production has been checked, paid for and started, and each of those
 * left a line. A board whose orders have no history is one where every screen
 * that reads a trail has nothing to draw.
 */
function seedQueueAudit(store, { orderId, clientId, entry, stage, at, index }) {
  store.auditLog = (store.auditLog || []).filter((row) => row.orderId !== orderId);

  // Looked up rather than named: an audit row points at a real person, and a
  // guessed id fails at the foreign key rather than quietly.
  const holder = (role) => (store.userRoleMemberships || []).find((row) => row.role === role)?.userId;
  const ops = holder("ops_admin");
  const rider = holder("rider");

  const trail = [["order.placed", clientId, "client"]];
  if (stage !== "submitted") {
    if (ops) trail.push(["payment.confirmed", ops, "ops_admin"]);
    if (ops) trail.push(["order.qa_passed", ops, "ops_admin"]);
  }
  const printed = ["production", "supplier_self_qc", "ready_for_dispatch", "out_for_delivery", "awaiting_collection"];
  const checked = ["supplier_self_qc", "ready_for_dispatch", "out_for_delivery", "awaiting_collection"];
  const staged = ["ready_for_dispatch", "out_for_delivery", "awaiting_collection"];
  if (printed.includes(entry.state)) {
    trail.push(["order.production_started", entry.supplierId, "supplier"]);
  }
  if (checked.includes(entry.state)) {
    trail.push(["order.self_qc", entry.supplierId, "supplier"]);
  }
  if (staged.includes(entry.state)) {
    trail.push(["order.ready_for_dispatch", entry.supplierId, "supplier"]);
  }
  if (["out_for_delivery", "awaiting_collection"].includes(entry.state) && rider) {
    trail.push(["order.picked_up", rider, "rider"]);
  }
  // The rider's leg is over: it is on GRIDGO's own shelf, and the next step
  // belongs to whoever comes to the counter for it.
  if (entry.state === "awaiting_collection" && rider) {
    trail.push(["order.left_at_office", rider, "rider"]);
  }
  if (entry.state === "client_correction" && ops) trail.push(["order.correction_requested", ops, "ops_admin"]);

  for (const [step, [action, actorId, actorRole]] of trail.entries()) {
    // Spaced backwards from now, so the trail reads in the order it happened
    // rather than arriving in one instant.
    const when = new Date(Date.parse(at) - (trail.length - step) * 3_600_000).toISOString();
    store.auditLog.push({
      id: `aud_dev_queue_${index}_${step}`,
      at: when,
      actorId,
      actorRole,
      action,
      entityType: "order",
      entityId: orderId,
      orderId,
      detail: { to: entry.state },
    });
  }
}

async function main() {
  const database = createDatabase(process.env);
  try {
    await database.assertReady();
    await seedReferenceData(database);
    let storage = null;
    try {
      storage = createObjectStorage(process.env);
      await storage.ensureBucket();
    } catch {
      storage = null;
    }
    const result = await seedDevelopmentShops(database, { objectStorage: storage });
    console.log(
      `Seeded development shops ${result.shops.map((shop) => `${shop.shopName} <${shop.email}>`).join(", ")}`
      + (result.client ? ` and client <${result.client.email}>` : "")
      + (result.rider ? ` and rider <${result.rider.email}>` : "")
      + (result.privileged?.length
        ? ` and portal testers ${result.privileged.map((account) => `<${account.email}>`).join(", ")}`
        : "")
      + (result.photos ? " with starter sample photographs.\n" : " (listings have no photos — MinIO was unreachable).\n"),
    );
  } finally {
    await database.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
