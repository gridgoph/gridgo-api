import test from "node:test";
import assert from "node:assert/strict";

import { createDatabase } from "../src/database.js";
import { loadStore } from "../src/postgres-store.js";
import { seedReferenceData } from "../src/seed.js";
import { LOVIS_DEV_SHOP, PLACEHOLDER_JPEG, seedDevelopmentShop } from "../src/seed-dev.js";
import { catalogItemBlockers } from "../src/supplier-catalog.js";

const DATABASE_URL = process.env.DATABASE_URL;

const clerkBackend = {
  users: {
    getUserList: async () => ({
      data: [{
        id: "clerk_lovis_dev",
        firstName: "Felycia",
        lastName: "",
        primaryEmailAddress: { emailAddress: LOVIS_DEV_SHOP.email },
        primaryPhoneNumber: { phoneNumber: "+639171234567" },
      }],
    }),
  },
};

const objectStorage = {
  putObject: async () => ({ key: "dev/lovis/placeholder.jpg", etag: "seed" }),
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
  await seedDevelopmentShop(database, { clerkBackend, objectStorage, now: () => "2026-08-23T00:00:00.000Z" });
  const first = await loadStore(database);
  await seedDevelopmentShop(database, { clerkBackend, objectStorage, now: () => "2026-08-23T00:00:00.000Z" });
  const second = await loadStore(database);

  const shop = first.users.find((user) => user.email === LOVIS_DEV_SHOP.email);
  assert.equal(shop.supplierName, "Lovis Printshop");
  assert.equal(shop.role, "supplier");
  assert.equal(shop.verificationStatus, "approved");
  assert.equal(shop.clerkUserId, "clerk_lovis_dev");
  assert.equal(first.supplierProfiles.find((row) => row.userId === shop.id).shopName, "Lovis Printshop");
  assert.equal(first.supplierServices.filter((row) => row.supplierId === shop.id && row.state === "live").length, 4);
  assert.ok(first.catalogItems.filter((row) => row.supplierId === shop.id).length >= 5);
  assert.equal(PLACEHOLDER_JPEG[0], 0xff);
  assert.equal(PLACEHOLDER_JPEG[1], 0xd8);
  const tarp = first.catalogItems.find((row) => row.id === "sci_lovis_tarpaulins_outdoor_banners");
  assert.equal(catalogItemBlockers(first, tarp).join(","), "");
  assert.equal(second.users.filter((user) => user.email === LOVIS_DEV_SHOP.email).length, 1);
  assert.equal(second.supplierServices.filter((row) => row.supplierId === shop.id).length, first.supplierServices.filter((row) => row.supplierId === shop.id).length);
  assert.equal(second.catalogItems.filter((row) => row.supplierId === shop.id).length, first.catalogItems.filter((row) => row.supplierId === shop.id).length);
  await database.close();
});
