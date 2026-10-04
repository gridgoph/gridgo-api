import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDatabase } from "../src/database.js";
import { seedReferenceData } from "../src/seed.js";
import { loadStore } from "../src/postgres-store.js";
import { ADDITIONAL_DEV_SHOPS, LOVIS_DEV_SHOP } from "../src/seed-dev.js";
import { catalogItemBlockers } from "../src/supplier-catalog.js";
import { supplierMatchBlockersFor } from "../src/supplier-eligibility.js";
import { up } from "../migrations/1791072000000_retire_development_shops.js";

const DATABASE_URL = process.env.DATABASE_URL;
test.before(() => { process.env.NODE_ENV = "production"; });
const AT = "2026-10-04T00:00:00.000Z";
const seededIds = [
  `user_${LOVIS_DEV_SHOP.shopName.toLowerCase().replaceAll(" ", "_")}`,
  ...ADDITIONAL_DEV_SHOPS.map(row => `user_${row.slug}`),
];
const targets = seededIds.slice(0, 4);
const untouched = [seededIds[4], "user_separate_test", "user_real_supplier"];
const fingerprint = id => createHash("md5").update(id).digest("hex");

test("retirement leaves development and test fixture accounts alone", async () => {
  const previous = process.env.NODE_ENV;
  try {
    for (const mode of ["development", "test", undefined]) {
      if (mode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = mode;
      const sql = [];
      await up({ sql: statement => sql.push(statement) });
      assert.deepEqual(sql, [], mode || "undeclared environment");
    }
  } finally { process.env.NODE_ENV = previous; }
});

async function fixture(db) {
  await db.query("TRUNCATE users, catalog_products, platform_settings, taxonomy_categories, zones RESTART IDENTITY CASCADE");
  await seedReferenceData(db);
  for (const [position, id] of [...targets, ...untouched].entries()) {
    await db.query(`INSERT INTO users (id, clerk_user_id, email, name, role, verification_status, created_at, position)
      VALUES ($1, $1, $2, 'Fixture', 'supplier', 'approved', $3, $4)`, [id, `fixture${position}@example.test`, AT, position]);
    await db.query("INSERT INTO user_role_memberships (user_id, role, created_at) VALUES ($1, 'supplier', $2)", [id, AT]);
    await db.query(`INSERT INTO supplier_profiles (user_id, shop_name, contact_name, shop_lat, shop_lng, shop_label, updated_at)
      VALUES ($1, 'Fixture', 'Fixture', 7, 125, 'Fixture', $2)`, [id, AT]);
    await db.query(`INSERT INTO approval_cases (id, user_id, kind, status, created_at, updated_at)
      VALUES ($1, $2, 'supplier', 'approved', $3, $3)`, [`case_${position}`, id, AT]);
    await db.query(`INSERT INTO supplier_services (id, supplier_id, category_code, state, reference_rate_minor, turnaround_hours, created_at, updated_at, position)
      VALUES ($1, $2, 'marketing_collateral', 'live', 100, 24, $3, $3, $4)`, [`service_${position}`, id, AT, position]);
    await db.query("INSERT INTO supplier_service_file_formats (supplier_service_id, format_code) VALUES ($1, 'pdf')", [`service_${position}`]);
    await db.query(`INSERT INTO supplier_catalog_items (id, supplier_id, supplier_service_id, subcategory_code, name, base_price_minor, sort_order, created_at, updated_at)
      VALUES ($1, $2, $3, 'flyers', 'Fixture listing', 100, 0, $4, $4)`, [`item_${position}`, id, `service_${position}`, AT]);
    await db.query(`INSERT INTO files (file_id, owner_id, purpose, original_filename, declared_content_type, state, object_key, created_at, position)
      VALUES ($1, $2, 'catalog_photo', 'sample.jpg', 'image/jpeg', 'ready', $1, $3, $4)`, [`photo_${position}`, id, AT, position]);
    await db.query("INSERT INTO supplier_catalog_item_photos (catalog_item_id, file_id, sort_order, created_at) VALUES ($1, $2, 0, $3)", [`item_${position}`, `photo_${position}`, AT]);
  }
  await db.query(`INSERT INTO users (id, clerk_user_id, email, name, role, created_at, position)
    VALUES ('user_admin', 'clerk_admin', 'admin@example.test', 'Fixture', 'super_admin', $1, 99)`, [AT]);
  await db.query(`INSERT INTO user_role_memberships (user_id, role, created_at)
    VALUES ('user_admin', 'super_admin', $1), ('user_admin', 'ops_admin', $1)`, [AT]);
}

async function retire(db) {
  const sql = [];
  await up({ sql: statement => sql.push(statement) });
  const notices = [];
  // Run the same SQL and transaction model as node-pg-migrate, capturing PostgreSQL notices.
  const pg = await import("pg");
  const client = new pg.default.Client({ connectionString: DATABASE_URL });
  client.on("notice", notice => notices.push(notice.message));
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const statement of sql) await client.query(statement);
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
  return notices;
}

async function order(db, id, supplierId, clientId = untouched[2]) {
  await db.query(`INSERT INTO orders (id, client_id, supplier_id, state, dropoff_lat, dropoff_lng, dropoff_label, created_at, updated_at, position)
    VALUES ($1, $2, $3, 'submitted', 7, 125, 'Fixture', $4, $4, 0)`, [id, clientId, supplierId, AT]);
}

test("retirement suspends only the four demo accounts, hides listings and is idempotent", { skip: !DATABASE_URL }, async () => {
  const db = createDatabase({ DATABASE_URL });
  try {
    await fixture(db);
    const before = await loadStore(db);
    assert.deepEqual(catalogItemBlockers(before, before.catalogItems[0], { publicOnly: true }), []);
    const notices = await retire(db);
    const after = await loadStore(db);
    for (const id of targets) {
      const account = after.users.find(row => row.id === id);
      assert.equal(account.accountStatus, "suspended");
      assert.equal(account.verificationStatus, "suspended");
      const approval = after.approvalCases.find(row => row.userId === id);
      assert.equal(approval.status, "suspended");
      const service = after.supplierServices.find(row => row.supplierId === id);
      assert.equal(service.state, "suspended");
      assert.equal(service.approvalSuspensionCaseId, approval.id);
      assert.equal(service.approvalSuspensionPreviousState, "live");
      assert.ok(supplierMatchBlockersFor(after)(id, after.supplierProfiles.find(row => row.userId === id)).length);
      const listing = after.catalogItems.find(row => row.supplierId === id);
      assert.ok(catalogItemBlockers(after, listing, { publicOnly: true }).includes("service_not_live"));
      assert.ok(notices.some(message => message.includes(fingerprint(id)) && message.includes("suspended")));
    }
    for (const id of untouched) {
      assert.deepEqual(after.users.find(row => row.id === id), before.users.find(row => row.id === id));
      assert.equal(after.supplierServices.find(row => row.supplierId === id).state, "live");
    }
    assert.deepEqual(after.catalogItems, before.catalogItems);
    assert.deepEqual(after.files, before.files);
    assert.equal(after.auditLog.filter(row => row.action === "user.account_suspend").length, 4);
    assert.equal(after.notifications.length, 12);
    for (const role of ["ops_admin", "super_admin"]) {
      assert.equal(after.notifications.filter(row => row.userId === "user_admin" && row.appRole === role).length, 4);
    }
    await retire(db);
    assert.deepEqual(await loadStore(db), after);
  } finally { await db.close(); }
});

test("retirement skips any order history including client and legacy job associations", { skip: !DATABASE_URL }, async () => {
  const db = createDatabase({ DATABASE_URL });
  try {
    await fixture(db);
    await order(db, "order_direct", targets[0]);
    await db.query(`INSERT INTO order_payments (order_id, code, amount_minor, method, status, position)
      VALUES ('order_direct', 'initial', 100, 'qr_manual', 'confirmed', 0)`);
    await db.query(`INSERT INTO payout_milestones (order_id, code, share_percent, amount_minor, status, position)
      VALUES ('order_direct', 'printing', 50, 50, 'released', 0)`);
    await order(db, "order_as_client", untouched[2], targets[1]);
    await order(db, "order_legacy", untouched[2]);
    await db.query(`INSERT INTO order_jobs (id, order_id, supplier_id, state, fulfillment_mode, pickup_lat, pickup_lng, pickup_label,
      supplier_subtotal_minor, delivery_fee_minor, estimated_hours, created_at, updated_at)
      VALUES ('job_legacy', 'order_legacy', $1, 'completed', 'pickup', 7, 125, 'Fixture', 100, 0, 24, $2, $2)`, [targets[2], AT]);
    const before = await loadStore(db);
    const notices = await retire(db);
    const after = await loadStore(db);
    for (const id of targets.slice(0, 3)) {
      assert.deepEqual(after.users.find(row => row.id === id), before.users.find(row => row.id === id));
      assert.equal(after.supplierServices.find(row => row.supplierId === id).state, "live");
      assert.ok(notices.some(message => message.includes(fingerprint(id)) && message.includes("skipped") && message.includes("history")));
    }
    assert.equal(after.users.find(row => row.id === targets[3]).accountStatus, "suspended");
    assert.deepEqual(after.orders, before.orders);
    assert.deepEqual(after.orderJobs, before.orderJobs);
    await retire(db);
    assert.deepEqual(await loadStore(db), after);
  } finally { await db.close(); }
});

test("retirement skips legacy supplier snapshots even without a relational assignment", { skip: !DATABASE_URL }, async () => {
  const db = createDatabase({ DATABASE_URL });
  try {
    await fixture(db);
    await order(db, "order_snapshot", null);
    await db.query("UPDATE orders SET data = $1 WHERE id = 'order_snapshot'", [
      { productionItems: [{ supplierId: targets[0] }] },
    ]);
    const notices = await retire(db);
    const account = (await loadStore(db)).users.find(row => row.id === targets[0]);
    assert.equal(account.accountStatus, "active");
    assert.ok(notices.some(message => message.includes(fingerprint(targets[0])) && message.includes("history")));
  } finally { await db.close(); }
});
