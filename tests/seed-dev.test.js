import test from "node:test";
import assert from "node:assert/strict";

import { createDatabase } from "../src/database.js";
import { loadStore } from "../src/postgres-store.js";
import { seedReferenceData } from "../src/seed.js";
import { ADDITIONAL_DEV_SHOPS, LOVIS_CATEGORY_LINES, LOVIS_DEV_SHOP, LOVIS_LISTINGS, MARK_DEV_CLIENT, MARK_DEV_RIDER, PLACEHOLDER_JPEG, PRIVILEGED_DEV_ACCOUNTS, seedDevelopmentShops, starterSampleBytes } from "../src/seed-dev.js";
import { catalogItemBlockers } from "../src/supplier-catalog.js";
import { defaultListingStarters } from "../src/listing-starters.js";

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
  // Lovis is a document shop. Seeding it across every category made one shop
  // the competitor in every subcategory, and matching a formality.
  assert.equal(
    first.supplierServices.filter((row) => row.supplierId === shop.id && row.state === "live").length,
    LOVIS_CATEGORY_LINES.length,
  );
  assert.equal(first.catalogItems.filter((row) => row.supplierId === shop.id).length, LOVIS_LISTINGS.length);
  // Three marketing listings, and the whole document board that gave the
  // fifth category its reason to exist.
  assert.deepEqual(
    first.catalogItems.filter((row) => row.supplierId === shop.id).map((row) => row.subcategoryCode).sort(),
    [
      "binding_hardbound",
      "booklets",
      "brochures",
      "business_cards",
      "document_printing",
      "flyers",
      "id_photos",
      "risograph",
    ],
  );

  // A real starter photograph reaches storage at its real size, and the listing
  // it lands on is board-ready.
  const sampleBytes = starterSampleBytes("lst_flyers");
  assert.ok(sampleBytes.length > PLACEHOLDER_JPEG.length);
  assert.equal(sampleBytes[0], 0xff);
  assert.equal(sampleBytes[1], 0xd8);
  assert.ok(uploaded.some((row) => row.key.endsWith("lst_flyers.jpg") && row.size === sampleBytes.length));
  const samplePhoto = first.catalogItemPhotos.find((row) => row.catalogItemId === "sci_lovis_flyers");
  assert.equal(first.files.find((file) => file.fileId === samplePhoto.fileId).size, sampleBytes.length);
  const flyers = first.catalogItems.find((row) => row.id === "sci_lovis_flyers");
  assert.equal(catalogItemBlockers(first, flyers).join(","), "");
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

  // Two shops have to want the same work somewhere, or every match has one
  // candidate and the ranking never runs. Stickers is that place.
  const bySubcategory = new Map();
  for (const item of first.catalogItems.filter((row) => row.active !== false)) {
    bySubcategory.set(item.subcategoryCode, (bySubcategory.get(item.subcategoryCode) || new Set()).add(item.supplierId));
  }
  assert.ok(
    [...bySubcategory.values()].some((suppliers) => suppliers.size > 1),
    "at least one subcategory needs two shops or matching is a formality",
  );

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

test("the pilot board carries the pricing shapes the master list actually quotes", () => {
  // These five shops price real work in real units, and for a long time the
  // catalogue could only say "per piece" and "per pack". A board that quotes
  // a tarpaulin as one flat price is a board nobody in Davao recognises.
  const listings = ADDITIONAL_DEV_SHOPS.flatMap((shop) =>
    shop.services.flatMap((service) => service.listings.map((listing) => ({ shop: shop.slug, ...listing }))),
  );
  const find = (shop, starterId) =>
    listings.find((listing) => listing.shop === shop && listing.starterId === starterId);

  // Polymedia quotes tarpaulin by the square foot at PHP 40, and bills a small
  // banner at its 2x4 minimum because the sheet is wasted either way.
  const tarpaulin = find("polymedia", "lst_tarpaulins_outdoor_banners");
  assert.equal(tarpaulin.pricingUnit, "per_area");
  assert.equal(tarpaulin.measureUnit, "ft");
  assert.equal(tarpaulin.priceMinor, 4_000);
  assert.equal(tarpaulin.minimumWidthMilli, 2_000);
  assert.equal(tarpaulin.minimumHeightMilli, 4_000);

  // Plaques are priced by height, which is a length and not an area.
  const plaques = find("polymedia", "lst_plaques_trophies");
  assert.equal(plaques.pricingUnit, "per_length");
  assert.equal(plaques.measureUnit, "in");

  // Jopal sells UV stickers off a roll by the running metre.
  const stickers = find("jopal_davao", "lst_stickers_packaging_labels");
  assert.equal(stickers.pricingUnit, "per_length");
  assert.equal(stickers.measureUnit, "m");
  assert.equal(stickers.priceMinor, 75_000);

  // And drops mugs from PHP 100 to PHP 60 at 250. The break replaces the rate
  // rather than discounting it, which is how the shop quotes it.
  const mugs = find("jopal_davao", "lst_drinkware");
  assert.deepEqual(mugs.priceTiers, [{ minQuantity: 250, unitPriceMinor: 6_000 }]);

  // Pins On's description promised a minimum of 20 while the listing would
  // have taken an order of one.
  const pins = find("pins_on", "lst_corporate_giveaways");
  assert.equal(pins.minimumOrderQuantity, 20);
  assert.match(pins.description, /Minimum 20/);

  // At least one listing of each measured kind, so a client can be walked
  // through every shape of the flow against seeded data.
  const units = new Set(listings.map((listing) => listing.pricingUnit).filter(Boolean));
  assert.equal(units.has("per_area"), true, "a listing priced by area");
  assert.equal(units.has("per_length"), true, "a listing priced by length");
});

test("a measured listing states the unit it is measured in", () => {
  // A width with no unit is not a size. The platform refuses the pair at the
  // database, and a seed that could produce one would fail on write rather
  // than in a review.
  for (const shop of ADDITIONAL_DEV_SHOPS) {
    for (const service of shop.services) {
      for (const listing of service.listings) {
        const measured = listing.pricingUnit === "per_area" || listing.pricingUnit === "per_length";
        assert.equal(
          Boolean(listing.measureUnit),
          measured,
          `${shop.slug}/${listing.starterId} must state a measure unit exactly when it is measured`,
        );
        if (!measured) {
          assert.equal(listing.minimumWidthMilli ?? null, null);
          assert.equal(listing.minimumLengthMilli ?? null, null);
        }
      }
    }
  }
});


test("the pilot board exercises every pricing shape the catalogue can hold", () => {
  // Six units, two shapes of speed, volume breaks, and both kinds of minimum.
  // A shape nothing seeds is a shape nothing exercises, and the measured path
  // was unreachable in development for exactly that reason until the master
  // list went on the board.
  const listings = [
    ...LOVIS_LISTINGS,
    ...ADDITIONAL_DEV_SHOPS.flatMap((shop) => shop.services.flatMap((service) => service.listings)),
  ];

  // The unit a listing actually ships with: its own if it states one, and the
  // starter's template otherwise. Asserting only the overrides would miss
  // document printing, which is per-page because its starter says so.
  const starters = new Map(defaultListingStarters().map((starter) => [starter.id, starter]));
  const units = new Set(
    listings.map(
      (listing) => listing.pricingUnit || starters.get(listing.starterId)?.defaultPricingUnit || "per_unit",
    ),
  );
  for (const unit of ["per_unit", "per_package", "per_page", "per_area", "per_length", "whole_job"]) {
    assert.equal(units.has(unit), true, `a listing priced ${unit}`);
  }

  // Lovis prices hardbound entirely by speed: four prices for the same book,
  // not a base price and three surcharges.
  const hardbound = listings.find((listing) => listing.starterId === "lst_binding_hardbound");
  assert.equal(hardbound.speedTiers.length, 4);
  assert.ok(hardbound.speedTiers.every((tier) => tier.priceMinor != null));

  // Pins On quotes the other shape: a flat fee on the order, whatever its size.
  const pins = listings.find((listing) => listing.starterId === "lst_corporate_giveaways");
  assert.ok(pins.speedTiers.every((tier) => tier.surchargeMinor != null && tier.priceMinor == null));

  // Polymedia's signage is the one job with no per-piece figure at all.
  const signage = listings.find((listing) => listing.starterId === "lst_business_store_signages");
  assert.equal(signage.pricingUnit, "whole_job");
  assert.equal(signage.priceMinor, 540_000);
});

test("Lovis's document board is the master list's document services, whole", () => {
  // The largest single price list in the catalogue, and the reason Documents
  // & Publications exists. Losing one of these silently would take a whole
  // trade off the board.
  const starters = LOVIS_LISTINGS.map((listing) => listing.starterId);
  for (const starter of [
    "lst_document_printing",
    "lst_booklets",
    "lst_risograph",
    "lst_binding_hardbound",
    "lst_id_photos",
    // Brochures and business cards are on Lovis's document price list too,
    // but they are marketing collateral and stay in that category.
    "lst_brochures",
    "lst_business_cards",
  ]) {
    assert.ok(starters.includes(starter), `Lovis lists ${starter}`);
  }

  const document = LOVIS_LISTINGS.filter(
    (listing) => listing.serviceId === "svc_lovis_document_publication",
  );
  assert.equal(document.length, 5);

  // Priced the way the shop quotes it: PHP 2.00 a page, PHP 1.25 a booklet
  // page, PHP 400 a ream of 500.
  const byStarter = Object.fromEntries(LOVIS_LISTINGS.map((listing) => [listing.starterId, listing]));
  assert.equal(byStarter.lst_document_printing.priceMinor, 200);
  assert.equal(byStarter.lst_booklets.priceMinor, 125);
  assert.equal(byStarter.lst_risograph.priceMinor, 40_000);
});
