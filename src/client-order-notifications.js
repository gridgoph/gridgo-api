/**
 * Client inbox rows for a job moving without the client doing the moving.
 *
 * `GET /notifications` is not a view of `orders`. Seed and some live
 * transitions used to write the job and skip the inbox, which is why a phone
 * full of orders still said "you are all caught up". This is the one place
 * that names the client-facing copy for a state and writes the row once.
 */

const COPY = {
  needs_qa: {
    type: "order_needs_qa",
    title: "Operations is checking your artwork",
    body: "GRIDGO is reviewing the files on this job. We'll tell you if anything needs a change.",
  },
  client_correction: {
    type: "order_client_correction",
    title: "Artwork needs a change",
    body: "Operations asked you to fix the artwork. Open the job to see what to send back.",
  },
  proof_approval: {
    type: "order_proof_approval",
    title: "Approve the proof",
    body: "Check the proof and approve it so the shop can start.",
  },
  awaiting_checkout: {
    type: "supplier_assignment_final_price",
    title: "Final quote ready",
    body: "Review the final quote, fulfillment choice, and payment plan.",
  },
  production: {
    type: "order_in_production",
    title: "Your job is in production",
    body: "The shop has started printing this order.",
  },
  supplier_self_qc: {
    type: "order_shop_qc",
    title: "The shop is checking the finished job",
    body: "Printing is done. The shop is checking the work before it leaves.",
  },
  ready_for_dispatch: {
    type: "order_ready_for_dispatch",
    title: "Ready to leave the shop",
    body: "This job is packed and waiting for a rider.",
  },
  rider_assigned: {
    type: "order_rider_assigned",
    title: "A rider has your job",
    body: "A GRIDGO rider is on the way to collect it from the shop.",
  },
  picked_up: {
    type: "order_picked_up",
    title: "Picked up from the shop",
    body: "The rider has the package. Delivery is next.",
  },
  out_for_delivery: {
    type: "order_out_for_delivery",
    title: "Out for delivery",
    body: "Your order is on the way.",
  },
  awaiting_collection: {
    type: "order_ready_for_pickup",
    title(order) {
      return collectionOwed(order) ? "Settle, then collect" : "Waiting at the counter";
    },
    body(order) {
      return collectionOwed(order)
        ? "Your order is waiting at GRIDGO Office. Settle the remaining balance in the app, then collect it at the counter."
        : "Your order is waiting for you at the GRIDGO Office counter.";
    },
  },
  delivered: {
    type: "order_delivered",
    title: "Delivered",
    body: "The rider has handed over this order.",
  },
  issue_window_open: {
    type: "order_delivered",
    title: "Delivered",
    body: "The rider has handed over this order. You have a short window to raise an issue if something is wrong.",
  },
};

/**
 * A collecting client is not being delivered to. The rider only moves the job
 * from the shop to GRIDGO's own counter — telling them it is "out for delivery"
 * sends them looking out a window for something sitting on our shelf.
 */
const COLLECT_COPY = {
  supplier_self_qc: {
    type: "order_shop_qc",
    title: "The shop is checking the finished job",
    body: "Printing is done. The shop is checking the work before it comes to the office.",
  },
  ready_for_dispatch: {
    type: "order_ready_for_dispatch",
    title: "Packed for the office",
    body: "This job is packed. A GRIDGO rider will bring it to the GRIDGO Office counter.",
  },
  rider_assigned: {
    type: "order_rider_assigned",
    title: "A rider is collecting it",
    body: "A GRIDGO rider is picking this up from the shop to bring it to the office.",
  },
  picked_up: {
    type: "order_picked_up",
    title: "On the way to GRIDGO Office",
    body: "The rider has your order and is bringing it to the counter.",
  },
  out_for_delivery: {
    type: "order_out_for_delivery",
    title: "On the way to GRIDGO Office",
    body: "Your order is heading to the GRIDGO Office counter. We'll tell you when you can collect it.",
  },
  delivered: {
    type: "order_delivered",
    title: "Collected",
    body: "This order was collected at the GRIDGO Office counter.",
  },
  issue_window_open: {
    type: "order_delivered",
    title: "Collected",
    body: "This order was collected at the GRIDGO Office counter. You have a short window to raise an issue if something is wrong.",
  },
};

function collectionOwed(order) {
  const status = order?.payments?.final_online?.status;
  return Boolean(status) && status !== "confirmed" && status !== "legacy_confirmed";
}

function resolveCopy(entry, order) {
  if (!entry) return null;
  return {
    type: entry.type,
    title: typeof entry.title === "function" ? entry.title(order) : entry.title,
    body: typeof entry.body === "function" ? entry.body(order) : entry.body,
  };
}

export function clientNotificationDraft(order) {
  if (!order?.clientId || !order.id || !order.state) return null;
  const collecting = order.fulfillmentMode === "pickup";
  const copy = resolveCopy(
    (collecting && COLLECT_COPY[order.state]) || COPY[order.state],
    order,
  );
  if (!copy) return null;
  return {
    userId: order.clientId,
    type: copy.type,
    orderId: order.id,
    title: copy.title,
    body: copy.body,
    read: false,
  };
}

const SHOP_COPY = {
  production: {
    type: "shop_job_in_production",
    title: "A job is on your board",
    body: "This job is in production. Start the run from Jobs.",
  },
  supplier_self_qc: {
    type: "shop_job_self_qc",
    title: "Check the finished job",
    body: "Printing is done. Run your quality check before it leaves the shop.",
  },
  ready_for_dispatch: {
    type: "shop_job_ready_for_dispatch",
    title: "Ready for a rider",
    body: "This job is packed and waiting for dispatch.",
  },
  client_correction: {
    type: "shop_job_client_correction",
    title: "Waiting on the client",
    body: "This job is paused while the client fixes the artwork.",
  },
  rider_assigned: {
    type: "shop_job_rider_assigned",
    title: "A rider is coming",
    body: "A GRIDGO rider is on the way to collect this job.",
  },
  picked_up: {
    type: "shop_job_picked_up",
    title: "Collected from the shop",
    body: "The rider has this job.",
  },
  out_for_delivery: {
    type: "shop_job_out_for_delivery",
    title: "A rider has this job",
    body: "It has left the shop.",
  },
};

const RIDER_ASSIGNED_COPY = {
  rider_assigned: {
    type: "order_rider_assigned",
    title: "You have this job",
    body: "Collect it from the shop and run the pickup checks.",
  },
  picked_up: {
    type: "order_picked_up",
    title: "Pickup checks passed",
    body: "The package is with you. Start delivery when you are ready.",
  },
  out_for_delivery: {
    type: "order_out_for_delivery",
    title: "You are carrying this job",
    body: "Head to the drop-off. The client can see you moving.",
  },
  awaiting_collection: {
    type: "order_ready_for_pickup",
    title: "Left at GRIDGO Office",
    body: "The client will collect this job at the counter.",
  },
};

function sameLiveNotification(store, draft) {
  return (store.notifications || []).find(
    (notification) =>
      notification.userId === draft.userId
      && notification.orderId === draft.orderId
      && notification.type === draft.type
      && notification.deletedAt == null,
  );
}

function writeDraft(store, draft, { id, at }) {
  if (!draft) return { notification: null, created: false };
  if (!id || !at) {
    throw new Error("order inbox write requires id and at");
  }
  if (!Array.isArray(store.notifications)) store.notifications = [];
  const existing = sameLiveNotification(store, draft);
  if (existing) return { notification: existing, created: false };
  const notification = { ...draft, id, at };
  store.notifications.push(notification);
  return { notification, created: true };
}

export function shopNotificationDraft(order) {
  if (!order?.supplierId || !order.id || !order.state) return null;
  const copy = SHOP_COPY[order.state];
  if (!copy) return null;
  return {
    userId: order.supplierId,
    type: copy.type,
    orderId: order.id,
    title: copy.title,
    body: copy.body,
    read: false,
  };
}

function approvedRiders(store) {
  return (store.users || []).filter(
    (user) => user.role === "rider" && user.verificationStatus === "approved",
  );
}

export function riderNotificationDrafts(store, order) {
  if (!order?.id || !order.state) return [];
  const drafts = [];
  const assigned = order.riderId ? RIDER_ASSIGNED_COPY[order.state] : null;
  if (assigned && order.riderId) {
    drafts.push({
      userId: order.riderId,
      type: assigned.type,
      orderId: order.id,
      title: assigned.title,
      body: assigned.body,
      read: false,
    });
  }
  if (order.state === "ready_for_dispatch" && !order.riderId) {
    for (const rider of approvedRiders(store)) {
      drafts.push({
        userId: rider.id,
        type: "dispatch_available",
        orderId: order.id,
        title: "A job is ready to collect",
        body: "Open Offers to take it before another rider does.",
        read: false,
      });
    }
  }
  return drafts;
}

/**
 * Write the inbox row for this order's current state, once.
 *
 * Returns `{ notification, created }`. `created` is false when the same
 * live row already exists, so seed and a later live transition cannot
 * double-ping the same stop.
 */
export function ensureClientOrderNotification(store, order, { id, at }) {
  return writeDraft(store, clientNotificationDraft(order), { id, at });
}

/**
 * Client, shop, and rider inbox rows for this job's current state.
 *
 * One call so a transition cannot remember the client and forget the shop.
 * Each party is still written once per type.
 */
export function notifyOrderParties(store, order, { createId, at }) {
  if (typeof createId !== "function" || !at) {
    throw new Error("notifyOrderParties requires createId and at");
  }
  const created = [];
  const client = writeDraft(store, clientNotificationDraft(order), {
    id: createId("ntf"),
    at,
  });
  if (client.created) created.push(client.notification);
  const shop = writeDraft(store, shopNotificationDraft(order), {
    id: createId("ntf"),
    at,
  });
  if (shop.created) created.push(shop.notification);
  for (const draft of riderNotificationDrafts(store, order)) {
    const rider = writeDraft(store, draft, { id: createId("ntf"), at });
    if (rider.created) created.push(rider.notification);
  }
  return { created, client: client.notification };
}

export function backfillClientOrderNotifications(store, createId, clock = () => new Date().toISOString()) {
  return backfillOrderInboxNotifications(store, createId, clock);
}

export function backfillOrderInboxNotifications(store, createId, clock = () => new Date().toISOString()) {
  const created = [];
  for (const order of store.orders || []) {
    const result = notifyOrderParties(store, order, {
      createId,
      at: order.updatedAt || clock(),
    });
    created.push(...result.created);
  }
  return created;
}
