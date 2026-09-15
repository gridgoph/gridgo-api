import { activePayoutHold } from "./operational-model.js";
import { formatMinorPhp, payoutStageLabel } from "./payout-copy.js";
import {
  writeDraft,
  notifyOrderParties,
  notifyOpsOrderProgress,
  stateOccurrence,
} from "./client-order-notifications.js";
import {
  queueInvalidate,
  queueOrderInvalidate,
  eligibleRiderIds,
  privilegedAdminMemberships,
  hasRole,
} from "./notifications.js";
const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
const keyed = (rows) =>
  new Map(
    (rows || []).map((r) => [
      r.id || `${r.userId || r.supplierId}:${r.role || r.kind || ""}`,
      r,
    ]),
  );
/** Derive effects from the transaction's before/after domain snapshots. Never from request recipients. */
export function deriveDomainEvents(store, before, { createId, at }) {
  if (!before) return;
  const admins = privilegedAdminMemberships(store);
  const oldNotificationIds = new Set(
    (before.notifications || []).map((n) => n.id),
  );
  const routeNotificationIds = new Set(
    (store.notifications || []).filter((n) => !oldNotificationIds.has(n.id)).map((n) => n.id),
  );
  const actor =
    (store.auditLog || []).slice((before.auditLog || []).length).at(-1)
      ?.actorId ||
    (store.orders || [])
      .find(
        (o) =>
          o.timeline?.length >
          ((before.orders || []).find((p) => p.id === o.id)?.timeline?.length ||
            0),
      )
      ?.timeline?.at(-1)?.by;
  function hint(resource, id, userIds) {
    queueInvalidate(store, {
      resource,
      ...(id ? { id } : {}),
      ...(userIds ? { userIds: [...new Set(userIds.filter(Boolean))] } : {}),
    });
  }
  function notify(userId, type, title, order, occurrence, appRole, extra = {}, preserveOccurrences = false) {
    if (!userId) return;
    // Existing route effect for the same recipient/purpose wins in this transaction.
    if (
      (store.notifications || []).some(
        (n) =>
          (preserveOccurrences ? routeNotificationIds.has(n.id) : !oldNotificationIds.has(n.id)) &&
          n.userId === userId &&
          n.type === type &&
          (n.appRole ?? null) === (appRole ?? null) &&
          (n.orderId || null) === (order?.id || null) &&
          (n.approvalCaseId || null) === (extra.approvalCaseId || null),
      )
    )
      return;
    writeDraft(
      store,
      {
        userId,
        type,
        title,
        body: "Open GRIDGO to review the latest update.",
        read: false,
        ...(order ? { orderId: order.id } : {}),
        occurrenceKey: occurrence,
        appRole,
        ...extra,
      },
      { id: createId("ntf"), at },
    );
  }
  function notifyAdmins(type, title, order, occurrence, extra = {}) {
    for (const membership of admins)
      notify(
        membership.userId,
        type,
        title,
        order,
        occurrence,
        membership.role,
        extra,
        true,
      );
  }
  const priorOrders = keyed(before.orders);
  for (const order of store.orders || []) {
    const old = priorOrders.get(order.id);
    const occurrence = `${order.id}:${order.updatedAt || at}:${order.timeline?.length || 0}`;
    if (old && activePayoutHold(before, old) && !activePayoutHold(store, order)) {
      notify(
        order.supplierId,
        "shop_payout_hold_released",
        "Payout hold released",
        order,
        `${occurrence}:hold_released`,
        "supplier",
      );
      notifyAdmins("ops_payout_hold_released", "Payout hold released", order, `${occurrence}:hold_released`);
    }
    if (!changed(old, order)) continue;
    queueOrderInvalidate(store, order, [
      "orders",
      "jobs",
      "dispatch",
      "payouts",
    ]);
    if (order.state === "submitted" && old?.state !== "submitted")
      notifyAdmins(
        "ops_order_submitted",
        "An order needs review",
        order,
        occurrence,
      );
    if (
      old?.state === "supplier_assigned" &&
      ["supplier_accepted", "payment_authorized", "production"].includes(
        order.state,
      )
    )
      notify(
        order.clientId,
        "order_supplier_accepted",
        "The supplier accepted your job",
        order,
        occurrence,
        "client",
      );
    if (!old || stateOccurrence(old) !== stateOccurrence(order)) {
      notifyOrderParties(store, order, { createId, at });
      notifyOpsOrderProgress(store, order, { createId, at });
    }
    if (
      old?.state === "ready_for_dispatch" &&
      !old.riderId &&
      (order.state !== old.state || order.riderId)
    )
      hint("dispatch", order.id, eligibleRiderIds(before));
    if (order.state === "ready_for_dispatch" && !order.riderId)
      hint("dispatch", order.id, eligibleRiderIds(store));
    if (old && old.supplierId !== order.supplierId) {
      for (const resource of ["jobs", "orders", "payouts"])
        hint(resource, order.id, [old.supplierId]);
      notifyAdmins(
        "ops_assignment_changed",
        order.supplierId
          ? "Supplier assignment changed"
          : "An order needs a supplier",
        order,
        occurrence,
      );
      notify(
        order.clientId,
        "order_assignment_changed",
        "Your supplier assignment changed",
        order,
        occurrence,
        "client",
      );
      if (order.supplierId)
        notify(
          order.supplierId,
          "shop_job_assigned",
          "A job was assigned to you",
          order,
          occurrence,
          "supplier",
        );
    }
    if (old?.riderId && old.riderId !== order.riderId)
      for (const resource of ["dispatch", "orders", "jobs", "location"])
        hint(resource, order.id, [old.riderId]);
    for (const [code, payment] of Object.entries(order.payments || {})) {
      const prior = old?.payments?.[code];
      const rejected = payment.rejectedAt && payment.rejectedAt !== prior?.rejectedAt;
      if (rejected || (payment.status !== prior?.status && ["pending_confirmation", "confirmed"].includes(payment.status))) {
        const status = rejected ? "rejected" : payment.status === "pending_confirmation" ? "submitted" : "confirmed";
        notifyAdmins(
          `ops_payment_${status}`,
          `Payment ${status}`,
          order,
          `${occurrence}:${code}:${payment.submittedAt || ""}:${payment.confirmedAt || payment.rejectedAt || at}`,
        );
      }
      if (payment.status === "confirmed" && prior?.status !== "confirmed")
        notify(
          order.clientId,
          "order_payment_confirmed",
          "Payment confirmed",
          order,
          `${occurrence}:${code}:${payment.confirmedAt || at}`,
          "client",
        );
    }
    if (
      old?.payments?.final_online?.status !== "confirmed" &&
      order.payments?.final_online?.status === "confirmed" &&
      order.fulfillmentMode === "delivery" &&
      order.riderId &&
      ["picked_up", "out_for_delivery"].includes(order.state)
    ) {
      notify(
        order.riderId,
        "rider_delivery_payment_cleared",
        "Delivery payment cleared",
        order,
        `${occurrence}:final_online`,
        "rider",
      );
    }
    for (const milestone of order.payoutMilestones || []) {
      const prior = (old?.payoutMilestones || []).find(
        (m) => m.code === milestone.code,
      );
      if (milestone.status === "released" && prior?.status !== "released") {
        const stage = payoutStageLabel(milestone.code);
        const figure = formatMinorPhp(milestone.amountMinor || 0);
        const shop = (store.users || []).find((u) => u.id === order.supplierId)?.name || "the shop";
        notifyAdmins(
          "ops_payout_released",
          `Payout released · ${order.id}`,
          order,
          `${occurrence}:${milestone.code}:${milestone.releasedAt || at}`,
          { body: `${stage} share of ${figure} released to ${shop}.` },
        );
        notify(
          order.supplierId,
          "shop_payout_released",
          `${figure} released`,
          order,
          `${occurrence}:${milestone.code}:${milestone.releasedAt || at}`,
          "supplier",
          { body: `${stage} was recorded as released. Open the payout ledger for the recorded details.` },
        );
      }
    }
    if (old?.state === "proof_approval" && order.state !== old.state) {
      notifyAdmins(
        "ops_proof_decided",
        "Client proof decision received",
        order,
        occurrence,
      );
      notify(
        order.supplierId,
        "shop_proof_decided",
        "Proof status changed",
        order,
        occurrence,
        "supplier",
      );
    }
    if (old?.state === "client_correction" && ["submitted", "needs_qa"].includes(order.state))
      notifyAdmins(
        "ops_artwork_resubmitted",
        "Artwork resubmitted",
        order,
        occurrence,
      );
    if (
      [
        "delivered",
        "issue_window_open",
        "completed",
        "awaiting_collection",
      ].includes(order.state) &&
      old?.state !== order.state
    )
      notify(
        order.supplierId,
        "shop_fulfilment_updated",
        "Job fulfilment updated",
        order,
        occurrence,
        "supplier",
      );
    if (!old && order.state !== "draft")
      notify(
        order.clientId,
        "order_submitted",
        "Order received",
        order,
        occurrence,
        "client",
        { push: false },
      );
  }
  for (const table of [
    "orderJobs",
    "approvalCases",
    "supplierServices",
    "claims",
    "issues",
    "escalations",
  ]) {
    const previous = keyed(before[table]);
    for (const row of store[table] || []) {
      const old = previous.get(
        row.id || `${row.userId}:${row.role || row.kind || ""}`,
      );
      if (!changed(old, row)) continue;
      const order = (store.orders || []).find((o) => o.id === row.orderId);
      const occurrence = `${row.id}:${row.version || row.applicationRevision || row.updatedAt || at}:${row.status || row.state}`;
      if (table === "orderJobs") {
        hint("jobs", row.orderId, [
          row.supplierId,
          old?.supplierId,
          row.riderId,
          old?.riderId,
        ]);
        if (
          (!old || old.supplierId !== row.supplierId) &&
          row.state !== "cancelled"
        ) {
          notifyAdmins("ops_assignment_changed", "Supplier assignment changed", order, occurrence);
          notify(
            row.supplierId,
            "shop_job_assigned",
            "A job was assigned to you",
            order,
            occurrence,
            "supplier",
          );
        }
      } else if (table === "approvalCases") {
        if (row.status !== old?.status && row.status !== "pending") {
          notifyAdmins(
            "ops_approval_decision",
            "Application status changed",
            null,
            occurrence,
            { approvalCaseId: row.id },
          );
        }
        if (old?.status !== "suspended" && row.status === "suspended") {
          for (const affected of store.orders || [])
            if (
              (affected.supplierId === row.userId ||
                affected.riderId === row.userId) &&
              ![
                "draft",
                "cancelled",
                "delivered",
                "issue_window_open",
                "completed",
                "payout_released",
              ].includes(affected.state)
            ) {
              queueOrderInvalidate(store, affected, [
                "orders",
                "jobs",
                "dispatch",
              ]);
              notifyAdmins(
                "ops_active_work_suspended",
                "Active work needs reassignment review",
                affected,
                occurrence,
              );
            }
        }
        hint("approvals", row.id, [row.userId]);
        hint("identity", null, [row.userId]);
        hint("dispatch");
        hint("services");
        if (
          row.status !== old?.status &&
          row.status !== "pending" &&
          !(store.notifications || []).some(
            (n) =>
              !oldNotificationIds.has(n.id) &&
              n.approvalCaseId === row.id &&
              n.userId === row.userId,
          )
        )
          notify(
            row.userId,
            "approval_decision",
            "Your application status changed",
            null,
            occurrence,
            row.kind === "business_client" ? "client" : row.kind,
            { approvalCaseId: row.id },
          );
      } else if (table === "supplierServices") {
        hint("services", row.id, [row.supplierId]);
        hint(
          "catalog",
          null,
          (store.users || []).map((u) => u.id),
        );
        if (row.state !== old?.state && row.state === "pending_verification")
          notifyAdmins(
            "ops_service_submitted",
            "Service needs review",
            null,
            occurrence,
          );
        if (
          row.state !== old?.state &&
          ["live", "suspended"].includes(row.state)
        ) {
          notifyAdmins("ops_service_decision", "Service status changed", null, occurrence);
          notify(
            row.supplierId,
            "supplier_service_decision",
            "Service status changed",
            null,
            occurrence,
            "supplier",
          );
        }
      } else {
        hint(table === "issues" ? "claims" : table, row.id);
        if (order)
          queueOrderInvalidate(store, order, ["orders", "jobs", "payouts"]);
        if (table === "escalations" && row.status !== old?.status) {
          const escalationAlreadyWritten = (userId, appRole) =>
            (store.notifications || []).some(
              (n) =>
                !oldNotificationIds.has(n.id) &&
                n.userId === userId &&
                (!appRole || n.appRole === appRole) &&
                n.orderId === order?.id &&
                [
                  "pickup_escalation_resolved",
                  "pickup_check_escalation",
                ].includes(n.type),
            );
          for (const membership of admins)
            if (!escalationAlreadyWritten(membership.userId, membership.role))
              notify(
                membership.userId,
                "pickup_escalation_changed",
                "Pickup issue status changed",
                order,
                occurrence,
                membership.role,
              );
          if (row.status !== "open") {
            const userId = row.riderId || order?.riderId;
            if (userId && !escalationAlreadyWritten(userId))
              notify(
                userId,
                "pickup_escalation_changed",
                "Pickup issue status changed",
                order,
                occurrence,
                "rider",
              );
          }
          notify(
            order?.supplierId,
            "shop_pickup_issue_changed",
            "Pickup issue status changed",
            order,
            occurrence,
            "supplier",
          );
        }
        if (table === "issues") {
          notifyAdmins(
            old ? "ops_issue_changed" : "ops_issue_reported",
            old ? "Issue status updated" : "Client reported an issue",
            order,
            occurrence,
          );
          if (old && row.status !== old.status)
            notify(
              order?.clientId,
              "order_issue_resolved",
              "Issue status updated",
              order,
              occurrence,
              "client",
            );
          notify(
            order?.supplierId,
            "shop_issue_changed",
            "Job issue status updated",
            order,
            occurrence,
            "supplier",
          );
        }
        if (
          table === "claims" &&
          ["open", "payout_held"].includes(row.status) &&
          (!old ||
            old.status !== row.status ||
            old.holdReason !== row.holdReason)
        )
          notify(
            order?.supplierId,
            "shop_payout_held",
            "Payout on hold",
            order,
            occurrence,
            "supplier",
          );
        if (
          table === "claims" &&
          (!old || row.status !== old.status || row.holdReason !== old.holdReason)
        )
          notifyAdmins("ops_claim_changed", "Claim status updated", order, occurrence);
      }
    }
  }
  const oldRoles = new Set(
    (before.userRoleMemberships || []).map((m) => `${m.userId}:${m.role}`),
  );
  const newRoles = new Set(
    (store.userRoleMemberships || []).map((m) => `${m.userId}:${m.role}`),
  );
  for (const key of new Set([...oldRoles, ...newRoles]))
    if (oldRoles.has(key) !== newRoles.has(key)) {
      const [userId, role] = key.split(":");
      hint("identity", null, [userId]);
      for (const resource of [
        "orders",
        "jobs",
        "dispatch",
        "approvals",
        "payouts",
      ])
        hint(resource, null, [userId]);
      notify(
        userId,
        "role_changed",
        "Account access changed",
        null,
        `${key}:${at}`,
        null,
      );
      notifyAdmins("ops_role_changed", "Account access changed", null, `${key}:${at}`);
      if (["ops_admin", "super_admin"].includes(role))
        for (const m of store.userRoleMemberships || [])
          if (m.role === "super_admin" && m.userId !== userId)
            notify(
              m.userId,
              "privileged_role_changed",
              "Administrative access changed",
              null,
              `${key}:${at}`,
              "super_admin",
            );
    }
  for (const table of [
    "users",
    "supplierProfiles",
    "riderProfiles",
    "clientProfiles",
    "supplierPayoutAccounts",
  ]) {
    const previous = keyed(before[table]);
    for (const row of store[table] || [])
      if (changed(previous.get(row.id || `${row.userId || row.supplierId}:`), row))
        hint("identity", null, [row.userId || row.supplierId || row.id]);
  }
  const catalogTables = [
    "catalog",
    "supplierProfiles",
    "supplierPaymentTerms",
    "catalogItems",
    "catalogItemPhotos",
    "supplierShopMedia",
    "catalogOptions",
    "catalogOptionGroups",
    "catalogPrepSteps",
    "catalogItemFileFormats",
    "catalogPriceTiers",
    "catalogSpeedTiers",
    "supplierServicePriceTiers",
  ];
  if (catalogTables.some((t) => changed(before[t], store[t])))
    hint(
      "catalog",
      null,
      (store.users || []).map((u) => u.id),
    );
  if (
    changed(before.settings, store.settings) ||
    changed(before.zones, store.zones) ||
    changed(before.taxonomy, store.taxonomy)
  ) {
    hint("settings");
    hint(
      "catalog",
      null,
      (store.users || []).map((u) => u.id),
    );
  }
  if (
    changed(before.supplierProfiles, store.supplierProfiles) ||
    changed(before.supplierServices, store.supplierServices) ||
    changed(before.supplierAvailability, store.supplierAvailability)
  )
    hint(
      "availability",
      null,
      (store.users || [])
        .filter((u) => hasRole(store, u.id, "supplier"))
        .map((u) => u.id),
    );
  if (changed(before.credits, store.credits))
    for (const userId of new Set([
      ...Object.keys(before.credits || {}),
      ...Object.keys(store.credits || {}),
    ]))
      if (changed(before.credits?.[userId], store.credits?.[userId])) {
        hint("credits", null, [userId]);
        notifyAdmins("ops_credit_updated", "Credit account updated", null, `${userId}:${at}`);
        notify(
          userId,
          "credit_updated",
          "Credit account updated",
          null,
          `${userId}:${at}`,
          "client",
        );
      }
  const oldPings = new Set((before.locationPings || []).map((p) => p.id));
  for (const ping of store.locationPings || [])
    if (!oldPings.has(ping.id)) hint("location", ping.orderId);
  const oldNotifications = keyed(before.notifications);
  for (const n of store.notifications || [])
    if (changed(oldNotifications.get(n.id), n)) {
      hint("notifications", null, [n.userId]);
      if (!oldNotificationIds.has(n.id) && n.userId === actor) n.push = false;
    }
}
