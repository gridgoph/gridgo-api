import { tooManyRequests } from "./support-rate-limit.js";

/*
 Client <-> rider messages for one door delivery (gridgo-client#198).

 Open while the assigned rider has the job (accepted, picked up, on the way),
 readable for one day after the delivery is recorded, then gone: the routes
 refuse it at once and the lifecycle sweep deletes the rows. A conversation is
 keyed by order *and* rider, so a reassigned job never shows the new rider
 what the client said to the old one.

 Neither side ever sees the other's phone number or email. Calls are out of
 scope until GRIDGO has a masked-call provider; the issue's stop rule forbids
 handing out personal numbers.

 A job collected at GRIDGO Office has no conversation: its rider drives to our
 counter, not to the client.
*/

export const DELIVERY_CHAT_RETENTION_HOURS = 24;
const RETENTION_MS = DELIVERY_CHAT_RETENTION_HOURS * 60 * 60 * 1000;
const ACTIVE_STATES = new Set(["rider_assigned", "picked_up", "out_for_delivery"]);
const MESSAGE_MAX = 1000;
const MESSAGE_LIMIT = 200;
const POST_LIMIT = 30;
const POST_WINDOW_MS = 10 * 60 * 1000;
// One buzz per burst: a second message inside this window rides on the
// recipient's still-unread notice instead of ringing the phone again.
const NOTICE_QUIET_MS = 5 * 60 * 1000;
const ROUTE = /^\/orders\/([^/]+)\/delivery-chat(\/messages)?$/;

export function isDeliveryChatRoute(pathname) {
  return ROUTE.test(pathname);
}

/** When this order's delivery was recorded, or null before then. */
export function deliveredAtOf(order) {
  const at = order?.deliveryEvidence?.recordedAt ?? order?.issueWindowOpenedAt ?? null;
  if (!at) return null;
  const ms = Date.parse(at instanceof Date ? at.toISOString() : String(at));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * `open` (both can write), `read_only` (delivered, readable until `closesAt`)
 * or `closed` (not started, not a door delivery, or past its day).
 */
export function deliveryChatWindow(order, at = new Date().toISOString()) {
  const closed = { status: "closed", closesAt: null };
  if (!order?.riderId || order.fulfillmentMode === "pickup") return closed;
  if (ACTIVE_STATES.has(order.state)) return { status: "open", closesAt: null };
  const deliveredAt = deliveredAtOf(order);
  if (!deliveredAt) return closed;
  const closesMs = Date.parse(deliveredAt) + RETENTION_MS;
  if (Date.parse(at) >= closesMs) return closed;
  return { status: "read_only", closesAt: new Date(closesMs).toISOString() };
}

/** `client` or `rider` when this caller is a party to the order's delivery. */
export function deliveryChatParty(user, order) {
  if (!user || !order) return null;
  if (user.role === "client" && order.clientId === user.id) return "client";
  if (user.role === "rider" && order.riderId && order.riderId === user.id) return "rider";
  return null;
}

/** The conversation summary an order carries for its client and rider. */
export function deliveryChatProjection(order, user, at) {
  if (!deliveryChatParty(user, order)) return null;
  const window = deliveryChatWindow(order, at);
  if (window.status === "closed") return null;
  return { ...window, retentionHours: DELIVERY_CHAT_RETENTION_HOURS };
}

export function parseDeliveryMessage(value) {
  if (typeof value !== "string") return { ok: false, message: "Write a message." };
  const body = value.replace(/\r\n/g, "\n").trim();
  if (!body) return { ok: false, message: "Write a message." };
  if (body.length > MESSAGE_MAX) {
    return { ok: false, message: `Messages can be up to ${MESSAGE_MAX} characters.` };
  }
  return { ok: true, body };
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapMessage(row, viewerId) {
  return {
    id: row.id,
    senderRole: row.sender_role,
    body: row.body,
    createdAt: iso(row.created_at),
    mine: row.sender_user_id === viewerId,
  };
}

async function listMessages(database, order, viewerId) {
  const result = await database.query(
    `SELECT id, sender_user_id, sender_role, body, created_at
       FROM delivery_chat_messages
      WHERE order_id = $1 AND rider_id = $2
      ORDER BY created_at ASC, id ASC
      LIMIT $3`,
    [order.id, order.riderId, MESSAGE_LIMIT],
  );
  return result.rows.map((row) => mapMessage(row, viewerId));
}

async function markRead(database, order, userId) {
  await database.query(
    `INSERT INTO delivery_chat_reads (order_id, rider_id, user_id, last_read_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (order_id, rider_id, user_id) DO UPDATE SET last_read_at = now()`,
    [order.id, order.riderId, userId],
  );
}

function counterpartNotice(order, party, createId, at) {
  return party === "client"
    ? {
      id: createId("ntf"), userId: order.riderId, appRole: "rider", orderId: order.id,
      type: "delivery_message", title: "Message from the client",
      body: "The client sent you a message about this delivery. Open the trip to read it and reply.",
      read: false, at,
    }
    : {
      id: createId("ntf"), userId: order.clientId, appRole: "client", orderId: order.id,
      type: "delivery_message", title: "Message from your rider",
      body: "Your rider sent you a message about this delivery. Open the order to read it and reply.",
      read: false, at,
    };
}

/*
 The notice never carries the message text: inbox rows outlive the
 conversation, and the words must go when it does.
*/
function notifyCounterpart(store, order, party, { createId, at }) {
  const notice = counterpartNotice(order, party, createId, at);
  const quiet = (store.notifications || []).some((row) => row.userId === notice.userId
    && row.orderId === order.id
    && row.type === "delivery_message"
    && !row.read
    && !row.deletedAt
    && Date.parse(at) - Date.parse(iso(row.at)) < NOTICE_QUIET_MS);
  if (!quiet) store.notifications.push(notice);
}

function closedBody(order) {
  if (order.fulfillmentMode === "pickup") {
    return { error: "delivery_chat_not_available", message: "Messages are for deliveries to your door. This job is collected at GRIDGO Office." };
  }
  return deliveredAtOf(order)
    ? { error: "delivery_chat_closed", message: "Messages for this delivery were removed one day after it was delivered." }
    : { error: "delivery_chat_not_available", message: "Messages open once a rider takes this delivery." };
}

/**
 * GET  /orders/:id/delivery-chat           -> { chat, messages }
 * POST /orders/:id/delivery-chat/messages  { body } -> 201 { chat, message }
 *
 * Returns false when the path is not this route. POST runs inside the domain
 * mutation transaction, so the message and its notice commit together.
 */
export async function routeDeliveryChat({ req, res, pathname, user, store, database, readBody, send, save, createId, now }) {
  const match = ROUTE.exec(pathname);
  if (!match) return false;
  const [, orderId, messagesPath] = match;
  const writing = Boolean(messagesPath);
  if ((writing && req.method !== "POST") || (!writing && req.method !== "GET")) {
    send(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!user) {
    send(res, 401, { error: "unauthorized", message: "Sign in to GRIDGO, then retry this request with the new access token." });
    return true;
  }
  const order = (store.orders || []).find((candidate) => candidate.id === orderId);
  if (!order) {
    send(res, 404, { error: "order_not_found" });
    return true;
  }
  const party = deliveryChatParty(user, order);
  if (!party) {
    send(res, 403, { error: "forbidden", message: "Only the client and the assigned rider can read these messages." });
    return true;
  }
  const at = now();
  const window = deliveryChatWindow(order, at);
  if (window.status === "closed") {
    const body = closedBody(order);
    send(res, body.error === "delivery_chat_closed" ? 410 : 409, body);
    return true;
  }
  const chat = { ...window, retentionHours: DELIVERY_CHAT_RETENTION_HOURS };

  if (!writing) {
    const messages = await listMessages(database, order, user.id);
    await markRead(database, order, user.id);
    send(res, 200, { chat, messages });
    return true;
  }

  if (window.status !== "open") {
    send(res, 409, {
      error: "delivery_chat_read_only",
      message: "This delivery is finished. Its messages stay readable for one day, but no new ones can be sent.",
      chat,
    });
    return true;
  }
  if (tooManyRequests(`delivery-chat:${user.id}`, POST_LIMIT, POST_WINDOW_MS)) {
    send(res, 429, { error: "too_many_requests", message: "You are sending messages too fast. Wait a moment and try again." });
    return true;
  }
  const payload = await readBody(req);
  const parsed = parseDeliveryMessage(payload?.body);
  if (!parsed.ok) {
    send(res, 400, { error: "invalid_request", message: parsed.message });
    return true;
  }
  const inserted = await database.query(
    `INSERT INTO delivery_chat_messages (order_id, rider_id, sender_user_id, sender_role, body, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, sender_user_id, sender_role, body, created_at`,
    [order.id, order.riderId, user.id, party, parsed.body, at],
  );
  await markRead(database, order, user.id);
  notifyCounterpart(store, order, party, { createId, at });
  await save(store);
  send(res, 201, { chat, message: mapMessage(inserted.rows[0], user.id) });
  return true;
}

/**
 * Deletes every conversation that is no longer open or readable: past its day
 * after delivery, cancelled, collected instead, or left behind by a rider the
 * job was taken from. Returns how many messages went.
 */
export async function purgeClosedDeliveryChats(database, at = new Date().toISOString()) {
  const conversations = await database.query(
    `SELECT DISTINCT m.order_id, m.rider_id, o.state, o.rider_id AS current_rider_id,
            o.fulfillment_mode, o.issue_window_opened_at, o.data->'deliveryEvidence' AS delivery_evidence
       FROM delivery_chat_messages m
       JOIN orders o ON o.id = m.order_id`,
  );
  let removed = 0;
  for (const row of conversations.rows) {
    const order = {
      riderId: row.current_rider_id,
      state: row.state,
      fulfillmentMode: row.fulfillment_mode,
      issueWindowOpenedAt: row.issue_window_opened_at,
      deliveryEvidence: row.delivery_evidence,
    };
    const stillReadable = row.current_rider_id === row.rider_id && deliveryChatWindow(order, at).status !== "closed";
    if (stillReadable) continue;
    const deleted = await database.query(
      `DELETE FROM delivery_chat_messages WHERE order_id = $1 AND rider_id = $2`,
      [row.order_id, row.rider_id],
    );
    await database.query(
      `DELETE FROM delivery_chat_reads WHERE order_id = $1 AND rider_id = $2`,
      [row.order_id, row.rider_id],
    );
    removed += deleted.rowCount || 0;
  }
  return removed;
}
