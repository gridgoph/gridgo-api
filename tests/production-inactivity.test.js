import test from "node:test";
import assert from "node:assert/strict";

import { deviceAcceptsNotification } from "../src/push-outbox.js";
import { defaultOperationalSettings } from "../src/operational-model.js";
import {
  applyProductionNudges,
  continueAfterStepFailure,
  lastShopProductionAt,
  nextNudgeDueAt,
  nudgeOccurrenceKey,
  productionNudgeHours,
} from "../src/production-inactivity.js";

const T0 = "2026-09-01T00:00:00.000Z";

function plusHours(iso, hours) {
  return new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();
}

let seq = 0;
const createId = () => {
  seq += 1;
  return `ntf_${seq}`;
};

function milestones(printing = "pending_pof", packaging = "pending_pof") {
  return [
    { code: "printing", status: printing, pofFileIds: printing === "pending_pof" ? [] : ["file_print"] },
    { code: "packaging_qc", status: packaging, pofFileIds: packaging === "pending_pof" ? [] : ["file_pack"] },
  ];
}

function order(partial = {}) {
  return {
    id: "ord_1",
    supplierId: "shop_1",
    clientId: "client_1",
    state: "production",
    payoutHold: false,
    payoutMilestones: milestones(),
    timeline: [{ at: T0, state: "production", by: "shop_1", note: "Production started" }],
    updatedAt: T0,
    ...partial,
  };
}

function store(orders, extra = {}) {
  return {
    orders,
    notifications: [],
    userRoleMemberships: [{ userId: "ops_1", role: "ops_admin" }],
    claims: [],
    files: [],
    settings: defaultOperationalSettings(),
    ...extra,
  };
}

function shopRows(snapshot, id = "ord_1") {
  return snapshot.notifications.filter((row) => row.type === "shop_production_inactive" && row.orderId === id);
}

function sweep(snapshot, at) {
  return applyProductionNudges(snapshot, { at, createId, limit: 100 });
}

test("a job silent for 3 hours is not reminded when the wait is 4 hours", () => {
  const snapshot = store([order()]);
  assert.equal(sweep(snapshot, plusHours(T0, 3)).length, 0);
});

test("four hours of silence writes one shop reminder and a second tick does not repeat it", () => {
  const snapshot = store([order()]);
  const created = sweep(snapshot, plusHours(T0, 4));
  assert.equal(created.length, 1);
  assert.equal(created[0].type, "shop_production_inactive");
  assert.equal(created[0].occurrenceKey, "nudge:ord_1:production:1");
  assert.equal(created[0].userId, "shop_1");
  assert.equal(created[0].appRole, "supplier");
  assert.equal(sweep(snapshot, plusHours(T0, 4)).length, 0);
  assert.equal(shopRows(snapshot).length, 1);
});

test("a one-day wait is 24 hours, not one hour", () => {
  const settings = defaultOperationalSettings();
  settings.productionNudge = { ...settings.productionNudge, afterValue: 1, afterUnit: "days" };
  assert.equal(productionNudgeHours(settings).afterHours, 24);
  const snapshot = store([order()], { settings });
  assert.equal(sweep(snapshot, plusHours(T0, 23)).length, 0);
  assert.equal(sweep(snapshot, plusHours(T0, 24)).length, 1);
});

test("the repeat unit can be days while the first wait stays in hours", () => {
  const settings = defaultOperationalSettings();
  settings.productionNudge = {
    ...settings.productionNudge,
    afterValue: 4,
    afterUnit: "hours",
    repeatValue: 1,
    repeatUnit: "days",
  };
  const snapshot = store([order()], { settings });
  sweep(snapshot, plusHours(T0, 4));
  assert.equal(sweep(snapshot, plusHours(T0, 8)).length, 0);
  const second = sweep(snapshot, plusHours(T0, 4 + 24));
  assert.equal(second.length, 1);
  assert.equal(second[0].occurrenceKey, "nudge:ord_1:production:2");
});

test("reminders continue until maxCount and the last one also tells Operations", () => {
  const snapshot = store([order()]);
  sweep(snapshot, plusHours(T0, 4));
  sweep(snapshot, plusHours(T0, 8));
  assert.equal(snapshot.notifications.some((row) => row.type === "ops_production_inactive"), false);
  const third = sweep(snapshot, plusHours(T0, 12));
  assert.equal(third.filter((row) => row.type === "shop_production_inactive").length, 1);
  assert.equal(third.filter((row) => row.type === "ops_production_inactive").length, 1);
  assert.equal(third.find((row) => row.type === "ops_production_inactive").userId, "ops_1");
  assert.equal(sweep(snapshot, plusHours(T0, 16)).length, 0);
  assert.equal(shopRows(snapshot).length, 3);
});

test("maxCount 1 writes one shop row and one Operations row, then nothing", () => {
  const settings = defaultOperationalSettings();
  settings.productionNudge = { ...settings.productionNudge, maxCount: 1 };
  const snapshot = store([order()], { settings });
  const created = sweep(snapshot, plusHours(T0, 4));
  assert.deepEqual(created.map((row) => row.type), ["shop_production_inactive", "ops_production_inactive"]);
  assert.equal(sweep(snapshot, plusHours(T0, 8)).length, 0);
});

test("a disabled policy writes nothing", () => {
  const settings = defaultOperationalSettings();
  settings.productionNudge = { ...settings.productionNudge, enabled: false };
  const snapshot = store([order()], { settings });
  assert.deepEqual(sweep(snapshot, plusHours(T0, 100)), []);
});

test("starting production or filing printing proof resets the clock to a full first wait", () => {
  const snapshot = store([
    order({
      state: "payment_authorized",
      timeline: [{ at: T0, state: "payment_authorized", by: "ops_1", note: "Payment confirmed" }],
    }),
  ]);
  sweep(snapshot, plusHours(T0, 4));
  assert.equal(shopRows(snapshot)[0].occurrenceKey, "nudge:ord_1:payment_authorized:1");
  const job = snapshot.orders[0];
  job.state = "production";
  job.timeline.push({ at: plusHours(T0, 5), state: "production", by: "shop_1", note: "Production started" });
  assert.equal(sweep(snapshot, plusHours(T0, 8)).length, 0);
  const started = sweep(snapshot, plusHours(T0, 9));
  assert.equal(started[0].occurrenceKey, nudgeOccurrenceKey(job, 1));
  job.timeline.push({
    at: plusHours(T0, 10),
    state: "production",
    by: "shop_1",
    note: "Proof of Fulfilment attached for printing",
    milestoneCode: "printing",
  });
  job.payoutMilestones = milestones("pof_attached", "pending_pof");
  assert.equal(sweep(snapshot, plusHours(T0, 13)).length, 0);
  const afterProof = sweep(snapshot, plusHours(T0, 14));
  assert.equal(afterProof[0].occurrenceKey, "nudge:ord_1:production:2");
  assert.match(afterProof[0].body, /packaging proof/);
});

test("a rider ping or an Operations note does not reset the clock", () => {
  const job = order({
    state: "payment_authorized",
    updatedAt: plusHours(T0, 10),
    timeline: [
      { at: T0, state: "payment_authorized", by: "ops_1", note: "Payment confirmed" },
      { at: plusHours(T0, 1), state: "payment_authorized", by: "ops_1", note: "Operations looked again" },
    ],
  });
  assert.equal(lastShopProductionAt(job, { files: [] }), T0);
  const snapshot = store([job]);
  assert.equal(sweep(snapshot, plusHours(T0, 3)).length, 0);
  assert.equal(sweep(snapshot, plusHours(T0, 4)).length, 1);
});

test("ready for pickup and an unaccepted assignment are never reminded", () => {
  const snapshot = store([
    order({ id: "ord_ready", state: "ready_for_dispatch", timeline: [{ at: T0, state: "ready_for_dispatch", by: "shop_1" }] }),
    order({ id: "ord_offer", state: "supplier_assigned", timeline: [{ at: T0, state: "supplier_assigned", by: "ops_1" }] }),
  ]);
  assert.deepEqual(sweep(snapshot, plusHours(T0, 100)), []);
  assert.equal(lastShopProductionAt(snapshot.orders[0], snapshot), null);
});

test("an unclaimed device is not eligible for this reminder", () => {
  const snapshot = store([order()]);
  const [notification] = sweep(snapshot, plusHours(T0, 4));
  assert.equal(
    deviceAcceptsNotification(snapshot, { id: "dev_anon", userId: null }, notification),
    false,
  );
});

test("a longer wait does not rewrite a reminder already sent", () => {
  const snapshot = store([order()]);
  sweep(snapshot, plusHours(T0, 4));
  snapshot.settings = {
    ...snapshot.settings,
    productionNudge: {
      ...snapshot.settings.productionNudge,
      afterValue: 2,
      afterUnit: "days",
    },
  };
  assert.equal(sweep(snapshot, plusHours(T0, 5)).length, 0);
  assert.equal(shopRows(snapshot).length, 1);
  assert.equal(shopRows(snapshot)[0].occurrenceKey, "nudge:ord_1:production:1");
});

test("the sweep stops after 100 jobs and does not write a client or rider row", () => {
  const orders = Array.from({ length: 101 }, (_, index) =>
    order({ id: `ord_${index}`, timeline: [{ at: T0, state: "production", by: "shop_1" }] }),
  );
  const snapshot = store(orders);
  const created = sweep(snapshot, plusHours(T0, 4));
  assert.equal(created.length, 100);
  assert.equal(snapshot.notifications.some((row) => row.appRole === "client" || row.appRole === "rider"), false);
});

test("a held job is skipped", () => {
  const snapshot = store([order({ payoutHold: true })]);
  assert.deepEqual(sweep(snapshot, plusHours(T0, 4)), []);
});

test("payment waiting to start uses the start-production sentence, not a proof sentence", () => {
  const snapshot = store([
    order({
      state: "payment_authorized",
      timeline: [{ at: T0, state: "payment_authorized", by: "system", note: "Payment confirmed" }],
    }),
  ]);
  const [row] = sweep(snapshot, plusHours(T0, 4));
  assert.equal(row.title, "This job is still waiting to start");
  assert.match(row.body, /start production/);
  assert.equal(row.body.includes("proof"), false);
});

test("nextNudgeDueAt is null when reminders are off or the cap is spent", () => {
  const policy = productionNudgeHours(defaultOperationalSettings());
  assert.equal(nextNudgeDueAt(T0, null, 0, { ...policy, enabled: false }), null);
  assert.equal(nextNudgeDueAt(null, null, 0, policy), null);
  assert.equal(nextNudgeDueAt(T0, T0, policy.maxCount, policy), null);
});

test("a failing push step does not fail the lifecycle tick", async () => {
  const ran = [];
  const errors = await continueAfterStepFailure([
    async () => { ran.push("expire"); },
    async () => { ran.push("nudge"); },
    async () => { throw Object.assign(new Error("push down"), { code: "transport_error" }); },
  ], () => {});
  assert.deepEqual(ran, ["expire", "nudge"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "transport_error");
});
