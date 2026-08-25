import test from "node:test";
import assert from "node:assert/strict";

import { createDatabase } from "../src/database.js";
import { loadStore } from "../src/postgres-store.js";
import { seedReferenceData } from "../src/seed.js";
import { LOVIS_DEV_SHOP, MARK_DEV_CLIENT, PLACEHOLDER_JPEG, seedDevelopmentShops, starterSampleBytes } from "../src/seed-dev.js";
import { catalogItemBlockers } from "../src/supplier-catalog.js";

const DATABASE_URL = process.env.DATABASE_URL;

const clerkBackend = {
  users: {
    getUserList: async ({ emailAddress } = {}) => {
      const data = [{
        id: "clerk_lovis_dev",
        firstName: "Felycia",
        lastName: "",
        primaryEmailAddress: { emailAddress: LOVIS_DEV_SHOP.email },
        primaryPhoneNumber: { phoneNumber: "+639171234567" },
      }, {
        id: "clerk_quickprint_dev",
        firstName: "Quinn",
        lastName: "Reyes",
        primaryEmailAddress: { emailAddress: "quinn@gridgo.test" },
      }, {
        id: "clerk_matina_dev",
        firstName: "Mara",
        lastName: "Santos",
        primaryEmailAddress: { emailAddress: "mara@gridgo.test" },
      }, {
        id: "clerk_markdavid_dev",
        firstName: "Mark",
        lastName: "David",
        primaryEmailAddress: { emailAddress: MARK_DEV_CLIENT.email },
      }];
      const requested = emailAddress?.[0]?.toLowerCase();
      return { data: requested ? data.filter((row) => row.primaryEmailAddress.emailAddress.toLowerCase() === requested) : data };
    },
  },
};

const uploaded = [];
const objectStorage = {
  putObject: async ({ key, body, size }) => {
    uploaded.push({ key, size, bytes: body?.length });
    return { key, etag: "seed" };
  },
};

test("development shop seed is idempotent and names Lovis Printshop", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, proofs, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, files,
    payout_milestones, order_payments, order_line_item_options, order_line_items, orders,
    supplier_catalog_prep_steps, supplier_catalog_item_photos, supplier_shop_media, supplier_catalog_item_file_formats,
    supplier_catalog_options, supplier_catalog_option_groups, supplier_catalog_items,
    supplier_service_file_formats, supplier_service_price_tiers, supplier_services,
    listing_starter_options, listing_starter_groups, listing_starters, accepted_file_formats,
    supplier_payment_terms, supplier_profiles, rider_profiles, client_profiles,
    approval_case_events, approval_cases, user_role_memberships,
    zones, taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
    taxonomy_category_aliases, taxonomy_categories, catalog_products, users,
    platform_settings RESTART IDENTITY CASCADE`);

  await seedReferenceData(database);
  uploaded.length = 0;
  await seedDevelopmentShops(database, { clerkBackend, objectStorage, now: () => "2026-08-23T00:00:00.000Z" });
  const first = await loadStore(database);
  await seedDevelopmentShops(database, { clerkBackend, objectStorage, now: () => "2026-08-23T00:00:00.000Z" });
  const second = await loadStore(database);

  const shop = first.users.find((user) => user.email === LOVIS_DEV_SHOP.email);
  assert.equal(shop.supplierName, "Lovis Printshop");
  assert.equal(shop.role, "supplier");
  assert.equal(shop.verificationStatus, "approved");
  assert.equal(shop.clerkUserId, "clerk_lovis_dev");
  assert.equal(first.supplierProfiles.find((row) => row.userId === shop.id).shopName, "Lovis Printshop");
  assert.equal(first.supplierServices.filter((row) => row.supplierId === shop.id && row.state === "live").length, 4);
  assert.ok(first.catalogItems.filter((row) => row.supplierId === shop.id).length >= 14);
  const tarpBytes = starterSampleBytes("lst_tarpaulins_outdoor_banners");
  assert.ok(tarpBytes.length > PLACEHOLDER_JPEG.length);
  assert.equal(tarpBytes[0], 0xff);
  assert.equal(tarpBytes[1], 0xd8);
  assert.ok(uploaded.some((row) => row.key.endsWith("lst_tarpaulins_outdoor_banners.jpg") && row.size === tarpBytes.length));
  const tarpPhoto = first.catalogItemPhotos.find((row) => row.catalogItemId === "sci_lovis_tarpaulins_outdoor_banners");
  assert.equal(first.files.find((file) => file.fileId === tarpPhoto.fileId).size, tarpBytes.length);
  const tarp = first.catalogItems.find((row) => row.id === "sci_lovis_tarpaulins_outdoor_banners");
  assert.equal(catalogItemBlockers(first, tarp).join(","), "");
  assert.equal(second.users.filter((user) => user.email === LOVIS_DEV_SHOP.email).length, 1);
  assert.equal(second.supplierServices.filter((row) => row.supplierId === shop.id).length, first.supplierServices.filter((row) => row.supplierId === shop.id).length);
  assert.equal(second.catalogItems.filter((row) => row.supplierId === shop.id).length, first.catalogItems.filter((row) => row.supplierId === shop.id).length);
  const fixtureProfiles = first.supplierProfiles.filter((profile) => ["Lovis Printshop", "Davao Quickprint", "Matina Creative Hub"].includes(profile.shopName));
  assert.equal(fixtureProfiles.length, 3);
  for (const profile of fixtureProfiles) {
    const publicItems = first.catalogItems.filter((item) => item.supplierId === profile.userId && item.active !== false);
    assert.ok(publicItems.some((item) => item.subcategoryCode === "flyers"), `${profile.shopName} should list Flyers`);
    assert.ok(publicItems.some((item) => item.subcategoryCode !== "flyers"), `${profile.shopName} should support same-shop bundling`);
    assert.ok(first.userRoleMemberships.some((row) => row.userId === profile.userId && row.role === "supplier"));
  }
  assert.equal(second.supplierProfiles.filter((profile) => ["Lovis Printshop", "Davao Quickprint", "Matina Creative Hub"].includes(profile.shopName)).length, 3);
  const client = first.users.find((user) => user.email === MARK_DEV_CLIENT.email);
  assert.equal(client.role, "client");
  assert.equal(client.accountType, "individual");
  assert.equal(client.clerkUserId, "clerk_markdavid_dev");
  assert.ok(first.userRoleMemberships.some((row) => row.userId === client.id && row.role === "client"));
  assert.equal(first.clientProfiles.find((row) => row.userId === client.id)?.clientKind, "personal");
  assert.equal(
    first.users.find((user) => user.id === "user_matina_creative_hub")?.email,
    "dev+matina_creative_hub@gridgo.local",
  );
  await database.close();
});
