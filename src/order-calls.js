import crypto from "node:crypto";
import { deliveryChatParty, deliveryChatWindow } from "./delivery-chat.js";
import { pickupChatParty, pickupChatWindow } from "./pickup-chat.js";
import { approvedRole, canAccessOrder, queueInvalidate } from "./notifications.js";
import { notifyAdmins } from "./domain-events.js";

const ROUTE = /^\/orders\/([^/]+)\/calls(?:\/([^/]+)(?:\/(accept|decline|cancel|end|heartbeat|signals|ice))?)?$/;
const ACTIVE = new Set(["ringing", "accepted"]);
export const CALL_RING_MS = 30_000;
export const CALL_LEASE_MS = 90_000;
export const isOrderCallRoute = (path) => ROUTE.test(path);
const fail = (send, res, status, error) => { send(res, status, { error }); return true; };

export function callParty(user, order, store, pair) {
  if ((store.users.find(u => u.id === user?.id)?.accountStatus ?? "active") !== "active") return null;
  if (pair === "pickup") return pickupChatParty(user, order, store);
  if (pair !== "delivery" || !deliveryChatParty(user, order)) return null;
  if (!canAccessOrder(store, user.id, order, { role: user.role })) return null;
  if (user.role === "rider" && !approvedRole(store, user.id, "rider")) return null;
  return user.role;
}
export function callWindow(order, pair, at) {
  return pair === "pickup"
    ? Boolean(order?.riderId && order.state === "rider_assigned")
    : pair === "delivery" && deliveryChatWindow(order, at).status === "open";
}
function counterpart(order, pair, role) {
  if (role !== "rider") return { id: order.riderId, role: "rider" };
  return pair === "pickup" ? { id: order.supplierId, role: "supplier" } : { id: order.clientId, role: "client" };
}
function currentParties(call, order, store) {
  return order?.riderId === call.rider_id &&
    callParty({ id: call.caller_id, role: call.caller_role }, order, store, call.pair) &&
    callParty({ id: call.callee_id, role: call.callee_role }, order, store, call.pair);
}
function firstName(store, id, role) {
  const word = String(store.users.find(u => u.id === id)?.name || "").trim().split(/\s+/)[0];
  // A phone/email used as a display name must not become call identity.
  return /^[\p{L}\p{M}'’-]{1,40}$/u.test(word) ? word : { supplier: "Shop", rider: "Rider", client: "Client" }[role];
}
export function publicCall(call, store, viewerId) {
  return {
    id: call.id, orderId: call.order_id, pair: call.pair, state: call.state,
    caller: { firstName: firstName(store, call.caller_id, call.caller_role), role: call.caller_role },
    callee: { firstName: firstName(store, call.callee_id, call.callee_role), role: call.callee_role },
    mine: call.caller_id === viewerId, createdAt: call.created_at, ringExpiresAt: call.ring_expires_at,
    acceptedAt: call.accepted_at, endedAt: call.ended_at,
    leaseExpiresAt: call.state === "accepted"
      ? new Date(Math.min(Date.parse(call.caller_seen_at), Date.parse(call.callee_seen_at)) + CALL_LEASE_MS).toISOString() : null,
  };
}
function changed(store, call) {
  queueInvalidate(store, { resource: "calls", id: call.order_id, userIds: [call.caller_id, call.callee_id] });
}
function notice(store, call, type, createId, at) {
  store.notifications.push({ id: createId("ntf"), userId: call.callee_id, appRole: call.callee_role,
    orderId: call.order_id, callId: call.id, callExpiresAt: call.ring_expires_at, type, title: type === "order_call_incoming" ? "Incoming voice call" : "Missed voice call",
    body: type === "order_call_incoming" ? "Open GRIDGO to answer the call." : "A call attempt was not answered. Open the order to call back.",
    read: false, at });
}
function silenceIncoming(store, call) {
  for (const n of store.notifications) {
    if (n.callId === call.id && n.type === "order_call_incoming") n.push = false;
  }
}
function staffNotice(store, call, createId, at) {
  notifyAdmins(store, "order_call_activity", "Order call activity", store.orders.find(o => o.id === call.order_id),
    `call:${call.id}:${call.state}`, { createId, at });
}
async function finish(database, store, call, state, { createId, at }) {
  await database.query(`UPDATE order_calls SET state = $2, ended_at = $3 WHERE id = $1`, [call.id, state, at]);
  Object.assign(call, { state, ended_at: at });
  silenceIncoming(store, call);
  await database.query('DELETE FROM order_call_signals WHERE call_id = $1', [call.id]);
  if (["missed", "declined", "cancelled"].includes(state)) notice(store, call, "order_call_missed", createId, at);
  changed(store, call);
  staffNotice(store, call, createId, at);
}

/** Called under the domain lock, before save on every mutation and on a 1s tick. */
export async function reconcileCalls(database, store, { createId, at }) {
  const { rows } = await database.query("SELECT * FROM order_calls WHERE state IN ('ringing','accepted')");
  let count = 0;
  for (const call of rows) {
    const order = store.orders.find(o => o.id === call.order_id);
    let state;
    if (!currentParties(call, order, store) || !callWindow(order, call.pair, at)) state = "ended";
    else if (call.state === "ringing" && Date.parse(at) >= Date.parse(call.ring_expires_at)) state = "missed";
    else if (call.state === "accepted" && (Date.parse(at) >= Math.min(Date.parse(call.caller_seen_at), Date.parse(call.callee_seen_at)) + CALL_LEASE_MS
      || Date.parse(at) >= Date.parse(call.accepted_at) + 2 * 60 * 60 * 1000)) state = "ended";
    if (state) { await finish(database, store, call, state, { createId, at }); count++; }
  }
  return count;
}

export function iceConfiguration(env = process.env, at = new Date().toISOString()) {
  const urls = (value, pattern) => String(value || "").split(',').map(v => v.trim()).filter(v => pattern.test(v));
  const stun = urls(env.STUN_URLS || "stun:stun.l.google.com:19302", /^stuns?:[^\s@]+$/);
  const turn = urls(env.TURN_URLS, /^turns?:[^\s@]+$/);
  const iceServers = stun.length ? [{ urls: stun }] : [];
  if (!turn.length || !env.TURN_SHARED_SECRET) return { iceServers, expiresAt: null, relayAvailable: false };
  const requested = Number(env.TURN_CREDENTIAL_TTL_SECONDS || 600);
  const ttl = Number.isFinite(requested) ? Math.max(60, Math.min(3600, Math.floor(requested))) : 600;
  const expires = Math.floor(Date.parse(at) / 1000) + ttl;
  const username = `${expires}:${crypto.randomBytes(16).toString('hex')}`;
  const credential = crypto.createHmac('sha1', env.TURN_SHARED_SECRET).update(username).digest('base64');
  iceServers.push({ urls: turn, username, credential, credentialType: "password" });
  return { iceServers, expiresAt: new Date(expires * 1000).toISOString(), relayAvailable: true };
}

/** No contact/session identity lines, video or data channels. WebRTC network addresses are necessary. */
export function parseCallSignal(body) {
  if (!body || typeof body.clientId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.clientId)) return null;
  if (["offer", "answer"].includes(body.kind)) {
    if (typeof body.sdp !== "string" || Buffer.byteLength(body.sdp) > 60_000) return null;
    const lines = body.sdp.trim().split(/\r?\n/);
    const media = lines.filter(l => l.startsWith('m='));
    if (lines[0] !== 'v=0' || media.length !== 1 || !/^m=audio \d+ UDP\/TLS\/RTP\/SAVPF /.test(media[0])
      || lines.some(l => /^[epiu]=|^a=identity:/.test(l))) return null;
    const clean = lines.map(l => l.startsWith('s=') ? 's=-' : l.startsWith('o=') ? l.replace(/^o=\S+/, 'o=-') : l);
    const payload = { sdp: clean.join('\r\n') + '\r\n' };
    if (Buffer.byteLength(JSON.stringify(payload)) > 65_000) return null;
    return { kind: body.kind, payload, clientId: body.clientId };
  }
  if (body.kind !== "ice" || typeof body.candidate !== "string" || body.candidate.length > 2048
    || (body.candidate !== '' && !/^candidate:[^\r\n@]+$/.test(body.candidate))
    || !(body.sdpMid == null || (typeof body.sdpMid === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(body.sdpMid)))
    || !(body.sdpMLineIndex == null || body.sdpMLineIndex === 0)) return null;
  return { kind: "ice", clientId: body.clientId, payload: { candidate: body.candidate,
    sdpMid: body.sdpMid ?? null, sdpMLineIndex: body.sdpMLineIndex ?? null } };
}

export async function routeOrderCalls({ req, res, pathname, user, store, database, readBody, send, save, createId, now }) {
  const match = ROUTE.exec(pathname);
  if (!match) return false;
  if (!user) return fail(send, res, 401, "unauthorized");
  const [, orderId, callId, action] = match;
  const order = store.orders.find(o => o.id === orderId);
  if (!order) return fail(send, res, 404, "order_not_found");
  // GET also owns the mutation lock: timeout reconciliation must commit before returning state.
  const at = now();
  if (!["delivery", "pickup"].some(pair => callParty(user, order, store, pair))) return fail(send, res, 403, "forbidden");
  if (await reconcileCalls(database, store, { createId, at })) await save(store);
  res.setHeader("Cache-Control", "no-store");
  if (!callId) {
    if (req.method === "GET") {
      const rows = await database.query(`SELECT * FROM order_calls WHERE order_id = $1
        AND (caller_id = $2 OR callee_id = $2)
        ORDER BY (state IN ('ringing','accepted')) DESC, created_at DESC LIMIT 100`, [order.id, user.id]);
      const calls = rows.rows.filter(c => currentParties(c, order, store) && callParty(user, order, store, c.pair)
        && [c.caller_id, c.callee_id].includes(user.id) && (c.pair === 'delivery' ? deliveryChatWindow(order, at) : pickupChatWindow(order, at)).status !== 'closed');
      send(res, 200, { calls: calls.map(c => publicCall(c, store, user.id)) });
      return true;
    }
    if (req.method !== "POST") return fail(send, res, 405, "method_not_allowed");
    const pair = (await readBody(req))?.pair;
    if (!["delivery", "pickup"].includes(pair)) return fail(send, res, 400, "invalid_call_pair");
    if (!callParty(user, order, store, pair)) return fail(send, res, 403, "forbidden");
    if (!callWindow(order, pair, at)) return fail(send, res, 409, "call_not_available");
    const other = counterpart(order, pair, user.role);
    if (other.id === user.id || !callParty(other, order, store, pair)) return fail(send, res, 409, "call_not_available");
    const active = await database.query("SELECT 1 FROM order_calls WHERE order_id = $1 AND pair = $2 AND state IN ('ringing','accepted')", [order.id, pair]);
    if (active.rowCount) return fail(send, res, 409, "call_already_active");
    const recent = await database.query('SELECT count(*)::int AS n FROM order_calls WHERE caller_id = $1 AND created_at > $2::timestamptz - interval \'10 minutes\'', [user.id, at]);
    if (recent.rows[0].n >= 10) return fail(send, res, 429, "too_many_requests");
    const result = await database.query(`INSERT INTO order_calls
      (order_id,pair,rider_id,caller_id,callee_id,caller_role,callee_role,state,created_at,ring_expires_at,caller_seen_at,callee_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'ringing',$8,$9,$8,$8) RETURNING *`,
    [order.id, pair, order.riderId, user.id, other.id, user.role, other.role, at, new Date(Date.parse(at) + CALL_RING_MS).toISOString()]);
    const call = result.rows[0];
    notice(store, call, "order_call_incoming", createId, at);
    changed(store, call); staffNotice(store, call, createId, at);
    await save(store);
    send(res, 201, { call: publicCall(call, store, user.id) });
    return true;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId)) return fail(send, res, 404, "call_not_found");
  const { rows: [call] } = await database.query('SELECT * FROM order_calls WHERE id = $1 AND order_id = $2', [callId, order.id]);
  if (!call || !currentParties(call, order, store) || ![call.caller_id, call.callee_id].includes(user.id)
    || !callParty(user, order, store, call.pair)) return fail(send, res, 404, "call_not_found");
  const window = call.pair === 'delivery' ? deliveryChatWindow(order, at) : pickupChatWindow(order, at);
  if (window.status === 'closed') return fail(send, res, 410, "call_history_closed");
  if (!action && req.method === 'GET') { send(res, 200, { call: publicCall(call, store, user.id) }); return true; }
  const reading = ["signals", "ice"].includes(action) && req.method === 'GET';
  if (!reading && req.method !== 'POST') return fail(send, res, 405, "method_not_allowed");
  if (!ACTIVE.has(call.state) || !callWindow(order, call.pair, at)) return fail(send, res, 409, "call_not_active");
  if (action === 'ice' && reading) { send(res, 200, iceConfiguration(process.env, at)); return true; }
  if (action === 'signals') {
    if (reading) {
      const after = Number(new URL(req.url, 'http://localhost').searchParams.get('after') || 0);
      if (!Number.isSafeInteger(after) || after < 0) return fail(send, res, 400, 'invalid_cursor');
      const result = await database.query(`SELECT id, kind, payload FROM order_call_signals
        WHERE call_id = $1 AND sender_id <> $2 AND id > $3
        ORDER BY id LIMIT 256`, [call.id, user.id, after]);
      send(res, 200, { signals: result.rows.map(r => ({ id: r.id, kind: r.kind, ...r.payload })),
        cursor: result.rows.at(-1)?.id ?? after, call: publicCall(call, store, user.id) });
      return true;
    }
    const signal = parseCallSignal(await readBody(req));
    if (!signal) return fail(send, res, 400, 'invalid_call_signal');
    const caller = call.caller_id === user.id;
    if ((signal.kind === 'offer' && !caller) || (signal.kind === 'answer' && caller)
      || (!caller && call.state !== 'accepted')) return fail(send, res, 409, 'call_signal_out_of_order');
    const prior = await database.query('SELECT * FROM order_call_signals WHERE call_id = $1 ORDER BY id', [call.id]);
    const duplicate = prior.rows.find(s => s.sender_id === user.id && s.client_id === signal.clientId);
    if (duplicate) {
      if (duplicate.kind !== signal.kind || Object.keys(signal.payload).some(k => duplicate.payload[k] !== signal.payload[k])) {
        return fail(send, res, 409, 'call_signal_conflict');
      }
      send(res, 200, { id: duplicate.id }); return true;
    }
    if ((signal.kind === 'answer' && !prior.rows.some(s => s.kind === 'offer'))
      || (signal.kind !== 'ice' && prior.rows.some(s => s.kind === signal.kind))) return fail(send, res, 409, 'call_signal_out_of_order');
    if (prior.rowCount >= 256) return fail(send, res, 429, 'call_signal_limit');
    const result = await database.query(`INSERT INTO order_call_signals (call_id,sender_id,client_id,kind,payload,created_at)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [call.id, user.id, signal.clientId, signal.kind, signal.payload, at]);
    changed(store, call); await save(store);
    send(res, 201, { id: result.rows[0].id }); return true;
  }
  const caller = call.caller_id === user.id;
  if (action === 'heartbeat' && call.state === 'accepted') {
    await database.query(`UPDATE order_calls SET ${caller ? 'caller_seen_at' : 'callee_seen_at'} = $2 WHERE id = $1`, [call.id, at]);
    call[caller ? 'caller_seen_at' : 'callee_seen_at'] = at;
  } else if (action === 'accept' && !caller && call.state === 'ringing') {
    await database.query("UPDATE order_calls SET state = 'accepted', accepted_at = $2, caller_seen_at = $2, callee_seen_at = $2 WHERE id = $1", [call.id, at]);
    silenceIncoming(store, call);
    Object.assign(call, { state: 'accepted', accepted_at: at, caller_seen_at: at, callee_seen_at: at });
    staffNotice(store, call, createId, at);
  } else if (action === 'decline' && !caller && call.state === 'ringing') await finish(database, store, call, 'declined', { createId, at });
  else if (action === 'cancel' && caller && call.state === 'ringing') await finish(database, store, call, 'cancelled', { createId, at });
  else if (action === 'end' && call.state === 'accepted') await finish(database, store, call, 'ended', { createId, at });
  else return fail(send, res, 409, 'invalid_call_transition');
  changed(store, call); await save(store);
  send(res, 200, { call: publicCall(call, store, user.id) });
  return true;
}

/** Same sweep/window as each order chat, including reassignment and cancellation. */
export async function purgeClosedCalls(database, store, at) {
  const { rows } = await database.query('SELECT * FROM order_calls');
  let removed = 0;
  for (const call of rows) {
    const order = store.orders.find(o => o.id === call.order_id);
    const window = call.pair === 'delivery' ? deliveryChatWindow(order, at) : pickupChatWindow(order, at);
    if (!currentParties(call, order, store) || window.status === 'closed') {
      await database.query('DELETE FROM order_calls WHERE id = $1', [call.id]); removed++;
    }
  }
  return removed;
}
