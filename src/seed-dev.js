import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { authConfiguration, clerkClientProfile, createClerkBackend } from "./auth.js";
import { createDatabase } from "./database.js";
import { createObjectStorage } from "./object-storage.js";
import { loadStore, saveStore } from "./postgres-store.js";
import { seedReferenceData } from "./seed.js";
import { defaultTaxonomy } from "./taxonomy.js";

/** Local development shop. Production `npm run seed` never creates this. */
export const LOVIS_DEV_SHOP = Object.freeze({
  email: "felyciaaa0220@gmail.com",
  shopName: "Lovis Printshop",
  contactName: "Felycia",
  phone: "+639171234567",
  shop: { lat: 7.0731, lng: 125.6128, label: "Bajada, Davao City" },
});

/** Local development client. Must not be consumed as an extra shop. */
export const MARK_DEV_CLIENT = Object.freeze({
  email: "markdavidprado@gmail.com",
  name: "Mark David",
});

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
const MODEL_FORMATS = ["pdf", "png", "jpeg", "3mf", "stl", "other_link"];

const CATEGORY_LINES = [
  {
    id: "svc_lovis_marketing_collateral",
    categoryCode: "marketing_collateral",
    formats: DESIGN_FORMATS,
    referenceRateMinor: 45000,
    turnaroundHours: 24,
  },
  {
    id: "svc_lovis_corporate_event_merch",
    categoryCode: "corporate_event_merch",
    formats: DESIGN_FORMATS,
    referenceRateMinor: 28000,
    turnaroundHours: 72,
  },
  {
    id: "svc_lovis_recognition_awards_signage",
    categoryCode: "recognition_awards_signage",
    formats: DESIGN_FORMATS,
    referenceRateMinor: 35000,
    turnaroundHours: 48,
  },
  {
    id: "svc_lovis_specialized_prototyping",
    categoryCode: "specialized_prototyping",
    formats: MODEL_FORMATS,
    referenceRateMinor: 80000,
    turnaroundHours: 72,
  },
];

const PLACEHOLDER_LISTINGS = [
  { starterId: "lst_tarpaulins_outdoor_banners", serviceId: "svc_lovis_marketing_collateral", priceMinor: 45000 },
  { starterId: "lst_flyers", serviceId: "svc_lovis_marketing_collateral", priceMinor: 2500 },
  { starterId: "lst_brochures", serviceId: "svc_lovis_marketing_collateral", priceMinor: 8000 },
  { starterId: "lst_business_cards", serviceId: "svc_lovis_marketing_collateral", priceMinor: 35000 },
  { starterId: "lst_posters_standees", serviceId: "svc_lovis_marketing_collateral", priceMinor: 12000 },
  { starterId: "lst_stickers_packaging_labels", serviceId: "svc_lovis_marketing_collateral", priceMinor: 5000 },
  { starterId: "lst_custom_apparel", serviceId: "svc_lovis_corporate_event_merch", priceMinor: 28000 },
  { starterId: "lst_lanyards_id_accessories", serviceId: "svc_lovis_corporate_event_merch", priceMinor: 1500 },
  { starterId: "lst_drinkware", serviceId: "svc_lovis_corporate_event_merch", priceMinor: 4500 },
  { starterId: "lst_corporate_giveaways", serviceId: "svc_lovis_corporate_event_merch", priceMinor: 2000 },
  { starterId: "lst_certificates_diplomas", serviceId: "svc_lovis_recognition_awards_signage", priceMinor: 15000 },
  { starterId: "lst_plaques_trophies", serviceId: "svc_lovis_recognition_awards_signage", priceMinor: 25000 },
  { starterId: "lst_medals_ribbons", serviceId: "svc_lovis_recognition_awards_signage", priceMinor: 8000 },
  { starterId: "lst_three_d_printing_scale_models", serviceId: "svc_lovis_specialized_prototyping", priceMinor: 150000 },
  { starterId: "lst_blueprint_cad_plotting", serviceId: "svc_lovis_specialized_prototyping", priceMinor: 8000 },
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

function copyStarter(store, starter, item, at, prefix = "lovis") {
  const already = (store.catalogOptionGroups || []).some((group) => group.catalogItemId === item.id);
  if (already) return;
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
        priceModifierMinor: option.priceModifierMinor,
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
  const listingPhotos = PLACEHOLDER_LISTINGS.map((listing) => {
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

    for (const line of CATEGORY_LINES) {
      upsert(store.supplierServices, "id", {
        id: line.id,
        supplierId: user.id,
        categoryCode: line.categoryCode,
        state: "live",
        pricingBasis: "per_unit",
        referenceRateMinor: line.referenceRateMinor,
        turnaroundHours: line.turnaroundHours,
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
        description: "Placeholder sample for Lovis Printshop. Replace this with your own art when you are ready.",
        basePriceMinor: listing.priceMinor,
        pricingUnit: starter.defaultPricingUnit || "per_unit",
        packageQty: starter.defaultPackageQty ?? null,
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

const ADDITIONAL_DEV_SHOPS = Object.freeze([
  {
    slug: "davao_quickprint",
    shopName: "Davao Quickprint",
    shop: { lat: 7.0514, lng: 125.5948, label: "Matina Crossing, Davao City" },
    turnaroundHours: 12,
    listings: [
      { starterId: "lst_flyers", priceMinor: 2200 },
      { starterId: "lst_business_cards", priceMinor: 32000 },
    ],
  },
  {
    slug: "matina_creative_hub",
    shopName: "Matina Creative Hub",
    shop: { lat: 7.0635, lng: 125.5901, label: "Matina, Davao City" },
    turnaroundHours: 18,
    listings: [
      { starterId: "lst_flyers", priceMinor: 2800 },
      { starterId: "lst_business_cards", priceMinor: 30000 },
    ],
  },
]);

function clerkRows(result) {
  const rows = result?.data || result || [];
  return Array.isArray(rows) ? rows : [];
}

async function seedAdditionalDevelopmentShop(database, fixture, { objectStorage, now }) {
  const clerkUserId = `clerk_dev_${fixture.slug}`;
  const email = `dev+${fixture.slug}@gridgo.local`;
  const person = { email, name: fixture.shopName, phone: null };
  const at = now();
  const uploaded = [];
  for (const listing of fixture.listings) {
    const body = starterSampleBytes(listing.starterId);
    const objectKey = `dev/${fixture.slug}/${listing.starterId}.jpg`;
    uploaded.push({
      ...listing,
      body,
      objectKey,
      stored: await putJpeg(objectStorage, objectKey, body),
    });
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

    const serviceId = `svc_${fixture.slug}_marketing_collateral`;
    upsert(store.supplierServices, "id", {
      id: serviceId,
      supplierId: user.id,
      categoryCode: "marketing_collateral",
      state: "live",
      pricingBasis: "per_unit",
      referenceRateMinor: fixture.listings[0].priceMinor,
      turnaroundHours: fixture.turnaroundHours,
      standardTurnaroundHours: fixture.turnaroundHours,
      rushEnabled: false,
      materialCodes: [],
      finishCodes: [],
      productFamilyIds: [],
      zones: ["davao_central"],
      equipmentNotes: "Local order-match fixture shop.",
      imageFileIds: [],
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    store.supplierServiceFileFormats = store.supplierServiceFileFormats.filter((row) => row.supplierServiceId !== serviceId);
    store.supplierServiceFileFormats.push(...DESIGN_FORMATS.map((formatCode) => ({ supplierServiceId: serviceId, formatCode })));

    for (const listing of uploaded) {
      const starter = store.listingStarters.find((candidate) => candidate.id === listing.starterId);
      if (!starter) continue;
      const itemId = `sci_${fixture.slug}_${starter.subcategoryCode}`;
      upsert(store.catalogItems, "id", {
        id: itemId,
        supplierId: user.id,
        supplierServiceId: serviceId,
        subcategoryCode: starter.subcategoryCode,
        name: starter.name,
        description: `${starter.name} from ${fixture.shopName}. Local order-match fixture.`,
        basePriceMinor: listing.priceMinor,
        pricingUnit: starter.defaultPricingUnit || "per_unit",
        packageQty: starter.defaultPackageQty ?? null,
        turnaroundMode: "override",
        turnaroundHours: fixture.turnaroundHours,
        fileFormatMode: starter.defaultFormatCodes?.length ? "override" : "inherit",
        active: true,
        sortOrder: uploaded.indexOf(listing),
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      const item = store.catalogItems.find((row) => row.id === itemId);
      copyStarter(store, starter, item, at, fixture.slug);
      if (!listing.stored) continue;
      const fileId = `file_${fixture.slug}_${starter.subcategoryCode}`;
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
        store.catalogItemPhotos.push({ catalogItemId: itemId, fileId, sortOrder: 0, altText: starter.name, createdAt: at });
      }
    }
    await saveStore(database, store);
  });
  return { email, shopName: fixture.shopName, clerkUserId, photos: uploaded.every((row) => row.stored) };
}

async function seedDevelopmentClient(database, clerkBackend, now) {
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
  return { email: person.email, clerkUserId: clerkUser.id };
}

/** Local-only shops plus the development client. Extra shops are fixtures, not real Clerk people. */
export async function seedDevelopmentShops(database, {
  clerkBackend,
  objectStorage,
  now = () => new Date().toISOString(),
} = {}) {
  const backend = clerkBackend || createClerkBackend(authConfiguration(process.env));
  const lovis = await seedDevelopmentShop(database, { clerkBackend: backend, objectStorage, now });
  const shops = [lovis];
  for (const fixture of ADDITIONAL_DEV_SHOPS) {
    shops.push(await seedAdditionalDevelopmentShop(database, fixture, { objectStorage, now }));
  }
  const client = await seedDevelopmentClient(database, backend, now);
  return { shops, client, photos: shops.every((shop) => shop.photos) };
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
      + (result.photos ? " with starter sample photographs.\n" : " (listings have no photos — MinIO was unreachable).\n"),
    );
  } finally {
    await database.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
