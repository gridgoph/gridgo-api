import test from "node:test";
import assert from "node:assert/strict";

import { createDatabase } from "../src/database.js";
import { loadStore } from "../src/postgres-store.js";
import { seedReferenceData } from "../src/seed.js";
import { ADDITIONAL_DEV_SHOPS, LOVIS_DEV_SHOP, MARK_DEV_CLIENT, MARK_DEV_RIDER, PLACEHOLDER_JPEG, PRIVILEGED_DEV_ACCOUNTS, seedDevelopmentShops, starterSampleBytes } from "../src/seed-dev.js";
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
        id: "clerk_markdavid_dev",
        firstName: "Mark",
        lastName: "David",
        primaryEmailAddress: { emailAddress: MARK_DEV_CLIENT.email },
      }, {
        id: "clerk_markdavid_rider_dev",
        firstName: "Mark",
        lastName: "Prado",
        primaryEmailAddress: { emailAddress: MARK_DEV_RIDER.email },
        primaryPhoneNumber: { phoneNumber: MARK_DEV_RIDER.phone },
      }, {
        id: "clerk_markshopease_dev",
        firstName: "Mark",
        lastName: "Admin",
        primaryEmailAddress: { emailAddress: PRIVILEGED_DEV_ACCOUNTS[0].email },
      }, {
        id: "clerk_giorno_dev",
        firstName: "Giorno",
        lastName: "Ops",
        primaryEmailAddress: { emailAddress: PRIVILEGED_DEV_ACCOUNTS[1].email },
      },
      // Derived from the fixtures themselves, so a shop can never be added to
      // the seed without this stub knowing the sign-in it will look for.
      ...ADDITIONAL_DEV_SHOPS.map((shop) => ({
        id: `clerk_${shop.slug}_dev`,
        firstName: shop.shopName,
        lastName: "",
        primaryEmailAddress: { emailAddress: shop.email },
      }))];
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
  // Every pilot shop from the Davao master list, each on its own trade. They
  // deliberately do not all sell the same thing: with one subcategory per shop
  // the matcher has something real to choose between.
  const shopNames = ADDITIONAL_DEV_SHOPS.map((shop) => shop.shopName);
  for (const fixture of ADDITIONAL_DEV_SHOPS) {
    const profile = first.supplierProfiles.find((row) => row.shopName === fixture.shopName);
    assert.ok(profile, `${fixture.shopName} should be seeded`);
    const user = first.users.find((row) => row.id === profile.userId);
    assert.equal(user.email, fixture.email, `${fixture.shopName} maps its own Clerk sign-in`);
    assert.equal(user.verificationStatus, "approved");
    assert.ok(first.userRoleMemberships.some((row) => row.userId === profile.userId && row.role === "supplier"));

    // One live service line per category the shop declared, and every listing
    // hanging off the line for its own category.
    const services = first.supplierServices.filter((row) => row.supplierId === profile.userId && row.state === "live");
    assert.equal(services.length, fixture.services.length, `${fixture.shopName} service lines`);
    const items = first.catalogItems.filter((row) => row.supplierId === profile.userId && row.active !== false);
    assert.equal(items.length, fixture.services.flatMap((service) => service.listings).length);
    for (const item of items) {
      const line = services.find((row) => row.id === item.supplierServiceId);
      assert.ok(line, `${item.id} should hang off a live service line`);
      assert.equal(catalogItemBlockers(first, item).join(","), "", `${item.id} should be board-ready`);
    }
  }
  // Polymedia sells banners and it sells awards. A shop spanning two categories
  // is the case a single hardcoded service line used to get wrong.
  const polymedia = first.supplierProfiles.find((row) => row.shopName === "Polymedia Printing Services");
  assert.equal(
    first.supplierServices.filter((row) => row.supplierId === polymedia.userId && row.state === "live").length,
    2,
  );
  assert.equal(second.supplierProfiles.filter((profile) => shopNames.includes(profile.shopName)).length, shopNames.length);

  // The client reads a listing under a GRIDGO label, so a description signed by
  // the press is where the anonymity leaks. It has leaked twice.
  for (const item of first.catalogItems) {
    const profile = first.supplierProfiles.find((row) => row.userId === item.supplierId);
    if (!profile) continue;
    assert.ok(
      !item.description.toLowerCase().includes(profile.shopName.toLowerCase()),
      `${item.id} names its own shop in the description a client reads`,
    );
  }
  const client = first.users.find((user) => user.email === MARK_DEV_CLIENT.email);
  assert.equal(client.role, "client");
  assert.equal(client.accountType, "individual");
  assert.equal(client.clerkUserId, "clerk_markdavid_dev");
  assert.ok(first.userRoleMemberships.some((row) => row.userId === client.id && row.role === "client"));
  assert.equal(first.clientProfiles.find((row) => row.userId === client.id)?.clientKind, "personal");
  assert.equal(
    first.users.find((user) => user.id === "user_polymedia")?.email,
    "felycia123@talasoraprime.com",
  );
  const rider = first.users.find((user) => user.email === MARK_DEV_RIDER.email);
  assert.equal(rider.role, "rider");
  assert.equal(rider.verificationStatus, "approved");
  assert.equal(rider.clerkUserId, "clerk_markdavid_rider_dev");
  assert.ok(first.userRoleMemberships.some((row) => row.userId === rider.id && row.role === "rider"));
  assert.equal(first.riderProfiles.find((row) => row.userId === rider.id)?.plateNumber, MARK_DEV_RIDER.plateNumber);
  assert.equal(first.approvalCases.find((row) => row.userId === rider.id && row.kind === "rider")?.status, "approved");
  assert.equal(second.users.filter((user) => user.email === MARK_DEV_RIDER.email).length, 1);
  const markAdmin = first.users.find((user) => user.email === PRIVILEGED_DEV_ACCOUNTS[0].email);
  const giornoOps = first.users.find((user) => user.email === PRIVILEGED_DEV_ACCOUNTS[1].email);
  assert.equal(markAdmin.role, "super_admin");
  assert.equal(markAdmin.clerkUserId, "clerk_markshopease_dev");
  assert.equal(giornoOps.role, "ops_admin");
  assert.equal(giornoOps.clerkUserId, "clerk_giorno_dev");
  assert.deepEqual(
    first.userRoleMemberships.filter((row) => row.userId === markAdmin.id).map((row) => row.role),
    ["super_admin"],
  );
  assert.deepEqual(
    first.userRoleMemberships.filter((row) => row.userId === giornoOps.id).map((row) => row.role),
    ["ops_admin"],
  );
  assert.equal(second.users.filter((user) => user.email === PRIVILEGED_DEV_ACCOUNTS[0].email).length, 1);
  assert.equal(second.users.filter((user) => user.email === PRIVILEGED_DEV_ACCOUNTS[1].email).length, 1);
  await database.close();
});
