import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createDatabase } from "../src/database.js";
import {
  AUDIT_TOPICS,
  appendAudit,
  filterAuditLog,
} from "../src/audit-record.js";

const SRC = join(import.meta.dirname, "../src");

function sourceText(dir) {
  let text = "";
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) text += sourceText(full);
    else if (entry.endsWith(".js")) text += readFileSync(full, "utf8");
  }
  return text;
}

const store = {
  users: [{ id: "user_ops", name: "Amina Cruz", role: "ops_admin" }],
  auditLog: [],
};

function entryFor(action, index) {
  return appendAudit(store, {
    id: `aud_${index}`,
    at: `2026-10-15T0${index}:00:00.000Z`,
    actor: { id: "user_ops", role: "ops_admin" },
    action,
    entityType: "order",
    entityId: "order_1",
    orderId: "order_1",
    previous: { state: "before" },
    current: { state: "after" },
    reason: "Checked against the order",
  });
}

test("each existing listed action writes who, when, where, the item, old and new values, and the reason", () => {
  const source = sourceText(SRC);
  const recorded = AUDIT_TOPICS.filter((topic) => topic.status === "recorded");
  assert.ok(recorded.length > 0);
  store.auditLog = [];
  recorded.forEach((topic, index) => {
    assert.ok(source.includes(topic.action), `${topic.area} / ${topic.topic}`);
    const written = topic.example || topic.action;
    const entry = entryFor(written, index);
    assert.equal(entry.actorName, "Amina Cruz");
    assert.equal(entry.actorRole, "ops_admin");
    assert.equal(entry.at, `2026-10-15T0${index}:00:00.000Z`);
    assert.equal(entry.action, written);
    assert.equal(entry.entityType, "order");
    assert.equal(entry.entityId, "order_1");
    assert.deepEqual(entry.previous, { state: "before" });
    assert.deepEqual(entry.current, { state: "after" });
    assert.equal(entry.reason, "Checked against the order");
  });
  store.users[0].name = "Someone Else";
  assert.equal(store.auditLog[0].actorName, "Amina Cruz");
});

test("vouchers, invoice mode, voucher issue, document publishes, and sign-ins are absent", () => {
  const absent = AUDIT_TOPICS.filter((topic) => topic.status === "absent").map((topic) => topic.topic);
  assert.deepEqual(absent, [
    "vouchers",
    "invoice mode",
    "voucher issue and void",
    "document publishes",
    "sign-ins",
  ]);
  for (const topic of AUDIT_TOPICS.filter((row) => row.status === "absent")) {
    assert.equal(topic.action, null);
  }
});

test("search filters by person, action, order, and date", () => {
  const rows = [
    { id: "a", at: "2026-10-01T00:00:00.000Z", actorName: "Amina Cruz", actorId: "user_ops", actorRole: "ops_admin", action: "order.cancelled", orderId: "order_1", entityType: "order", entityId: "order_1" },
    { id: "b", at: "2026-10-20T00:00:00.000Z", actorName: "Ben Santos", actorId: "user_ben", actorRole: "super_admin", action: "settings.operational_update", orderId: null, entityType: "settings", entityId: "operational" },
  ];
  const filtered = filterAuditLog(rows, {
    actor: "amina",
    actionQuery: "cancel",
    orderId: "order_1",
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-02T00:00:00.000Z",
    limit: 50,
  });
  assert.deepEqual(filtered.map((row) => row.id), ["a"]);
});

test("UPDATE and DELETE on audit_log fail", { skip: !process.env.DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL: process.env.DATABASE_URL });
  t.after(() => database.close());
  await database.query(`
    ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_id_fkey;
    ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_order_id_fkey;
    CREATE OR REPLACE FUNCTION gridgo_audit_log_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '55000';
    END;
    $$;
    DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
    CREATE TRIGGER audit_log_no_update
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION gridgo_audit_log_immutable();
  `);
  const id = `aud_immutable_${Date.now()}`;
  await database.query(
    `INSERT INTO audit_log (id, at, actor_role, action, position, data)
     VALUES ($1, now(), 'system', 'audit.immutable_probe', 0, '{}')`,
    [id],
  );
  await assert.rejects(
    () => database.query("UPDATE audit_log SET action = 'audit.rewritten' WHERE id = $1", [id]),
    /append-only/,
  );
  await assert.rejects(
    () => database.query("DELETE FROM audit_log WHERE id = $1", [id]),
    /append-only/,
  );
});
