import test from "node:test";
import assert from "node:assert/strict";

import { createDatabase } from "../src/database.js";
import { loadStore, saveStore } from "../src/postgres-store.js";
import { seedReferenceData } from "../src/seed.js";
import { routeRiderProfile } from "../src/rider-profile-routes.js";

const DATABASE_URL = process.env.DATABASE_URL;
const AT = "2026-08-20T00:00:00.000Z";

function fixture() {
  return {
    users: [{
      id: "rider",
      role: "rider",
      email: "rider@gridgo.test",
      name: "Carlo Rider",
      phone: "+639171234567",
    }],
    userRoleMemberships: [{ userId: "rider", role: "rider" }],
    riderProfiles: [{
      userId: "rider",
      vehicleType: "motorcycle",
      plateNumber: "ABC 1234",
      licenseNumber: "N01-23-456789",
      version: 1,
    }],
  };
}

function riderProfileCall(store, { method, body = {}, headers = {}, audit = () => {} } = {}) {
  return routeRiderProfile({
    req: { method, headers },
    url: new URL("http://127.0.0.1/me/rider-profile"),
    store,
    user: store.users[0],
    readBody: async () => body,
    now: () => AT,
    audit,
  });
}

test("a rider changes their own phone number and reads it back with their email", async () => {
  const store = fixture();
  const actions = [];
  const patched = await riderProfileCall(store, {
    method: "PATCH",
    body: { expectedVersion: 1, phone: "0917 765 4321" },
    audit: (_store, entry) => actions.push(entry.action),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.profile.phone, "+639177654321");
  assert.equal(patched.body.profile.email, "rider@gridgo.test");
  assert.equal(patched.body.profile.name, "Carlo Rider");
  assert.equal(patched.body.profile.version, 2);
  assert.equal(patched.body.profile.updatedAt, AT);
  assert.deepEqual(actions, ["rider_profile.update"]);
  assert.equal(store.users[0].phone, "+639177654321");

  const got = await riderProfileCall(store, { method: "GET" });
  assert.equal(got.status, 200);
  assert.equal(got.body.profile.phone, "+639177654321");
  assert.equal(got.body.profile.email, "rider@gridgo.test");
  assert.equal(got.body.profile.vehicleType, "motorcycle");
  assert.equal(got.body.profile.plateNumber, "ABC 1234");
  assert.equal(got.body.profile.version, 2);
});

test("a rider that never gave a number reads back an empty phone", async () => {
  const store = fixture();
  delete store.users[0].phone;
  const got = await riderProfileCall(store, { method: "GET" });
  assert.equal(got.body.profile.phone, null);
  assert.equal(got.body.profile.email, "rider@gridgo.test");
});

test("a phone edit from a stale screen still loses to the current record", async () => {
  const store = fixture();
  await riderProfileCall(store, { method: "PATCH", body: { expectedVersion: 1, phone: "09177654321" } });
  await assert.rejects(
    () => riderProfileCall(store, { method: "PATCH", body: { expectedVersion: 1, phone: "09170001111" } }),
    (error) => error.status === 409 && error.code === "rider_profile_stale",
  );
  assert.equal(store.users[0].phone, "+639177654321");
  assert.equal(store.riderProfiles[0].version, 2);
});

test("saving the name also writes the account name Account already reads", async () => {
  const store = fixture();
  const patched = await riderProfileCall(store, {
    method: "PATCH",
    body: { expectedVersion: 1, name: "Carlo Dela Cruz" },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.profile.name, "Carlo Dela Cruz");
  assert.equal(patched.body.profile.version, 2);
  assert.equal(store.users[0].name, "Carlo Dela Cruz");
});

test("saved rider name persists as users.name", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, proofs, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, files,
    payout_milestones, order_payments, order_line_item_options, order_line_items, orders,
    supplier_catalog_prep_steps, supplier_catalog_item_photos, supplier_shop_media,
    supplier_catalog_item_file_formats, supplier_catalog_options, supplier_catalog_option_groups,
    supplier_catalog_items, supplier_service_file_formats, supplier_service_price_tiers, supplier_services,
    listing_starter_options, listing_starter_groups, listing_starters, accepted_file_formats,
    zones, taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
    taxonomy_category_aliases, taxonomy_categories, catalog_products, users,
    platform_settings RESTART IDENTITY CASCADE`);
  await seedReferenceData(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users.push({
      id: "user_carlo", clerkUserId: "clerk_carlo", email: "carlo@gridgo.test",
      name: "Carlo Rider", role: "rider", verificationStatus: "pending", createdAt: AT,
    });
    store.userRoleMemberships.push({ userId: "user_carlo", role: "rider", createdAt: AT });
    store.riderProfiles.push({
      userId: "user_carlo", vehicleType: "motorcycle", plateNumber: "ABC 1234",
      licenseNumber: "N01-23-456789", version: 1, updatedAt: AT,
    });
    await saveStore(database, store);
  });
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users[0] = store.users.find((user) => user.id === "user_carlo");
    const patched = await riderProfileCall(store, {
      method: "PATCH",
      body: { expectedVersion: 1, name: "Carlo Dela Cruz" },
    });
    assert.equal(patched.status, 200);
    await saveStore(database, store);
  });
  const reloaded = await loadStore(database);
  assert.equal(reloaded.users.find((user) => user.id === "user_carlo").name, "Carlo Dela Cruz");
  assert.equal(reloaded.riderProfiles.find((profile) => profile.userId === "user_carlo").version, 2);
  await database.close();
});

test("email is refused because the GRIDGO sign-in owns it", async () => {
  const store = fixture();
  await assert.rejects(
    () => riderProfileCall(store, {
      method: "PATCH",
      body: { expectedVersion: 1, email: "new@gridgo.test", name: "New Name" },
    }),
    (error) => error.status === 400 && error.code === "email_not_editable",
  );
  assert.equal(store.users[0].email, "rider@gridgo.test");
  assert.equal(store.users[0].name, "Carlo Rider");
  assert.equal(store.riderProfiles[0].version, 1);
});

test("a mistyped phone saves nothing at all, not even the fields beside it", async () => {
  const store = fixture();
  await assert.rejects(
    () => riderProfileCall(store, {
      method: "PATCH",
      body: { expectedVersion: 1, name: "Renamed Rider", phone: "0917" },
    }),
    (error) => error.status === 400 && error.code === "invalid_rider_profile" && error.details.field === "phone",
  );
  assert.equal(store.users[0].name, "Carlo Rider");
  assert.equal(store.riderProfiles[0].version, 1);
  assert.equal(store.riderProfiles[0].updatedAt, undefined);
  assert.equal(store.users[0].phone, "+639171234567");
});

test("a vehicle and plate edit writes the rider profile and bumps version", async () => {
  const store = fixture();
  const patched = await riderProfileCall(store, {
    method: "PATCH",
    body: { expectedVersion: 1, vehicleType: "car", plateNumber: "XYZ 9876", licenseNumber: "N99-00-111111" },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.profile.vehicleType, "car");
  assert.equal(patched.body.profile.plateNumber, "XYZ 9876");
  assert.equal(patched.body.profile.licenseNumber, "N99-00-111111");
  assert.equal(patched.body.profile.version, 2);
});

test("an unknown vehicle type is refused without moving the record", async () => {
  const store = fixture();
  await assert.rejects(
    () => riderProfileCall(store, {
      method: "PATCH",
      body: { expectedVersion: 1, vehicleType: "spaceship" },
    }),
    (error) => error.status === 400 && error.code === "invalid_rider_profile" && error.details.field === "vehicleType",
  );
  assert.equal(store.riderProfiles[0].vehicleType, "motorcycle");
  assert.equal(store.riderProfiles[0].version, 1);
});
