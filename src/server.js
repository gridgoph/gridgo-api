import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const STORE = path.join(ROOT, "data", "store.json");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

// Auto-seed if missing
if (!fs.existsSync(STORE)) {
  spawnSync(process.execPath, [path.join(__dirname, "seed.js"), "--reset"], { stdio: "inherit" });
}

function save(store) {
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
}
function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}
function now() {
  return new Date().toISOString();
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function authUser(req, store) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const session = store.sessions[m[1]];
  if (!session) return null;
  return store.users.find((u) => u.id === session.userId) || null;
}

function publicUser(u) {
  if (!u) return null;
  const { password, ...rest } = u;
  return rest;
}

/** Plausible Davao City zone anchors (real neighbourhoods). Centre ~7.0731, 125.6128. */
const ZONE_COORDS = {
  davao_central: { lat: 7.0865, lng: 125.6135 }, // Bajada / JP Laurel
  davao_south: { lat: 7.0495, lng: 125.5875 }, // Matina Crossing
  davao_north: { lat: 7.1165, lng: 125.6452 }, // Lanang
  davao_west: { lat: 7.0380, lng: 125.5450 }, // Toril side
  davao_east: { lat: 7.0950, lng: 125.6500 }, // Buhangin / Sasa
};

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Deterministic dropoff near the zone so new orders do not stack on one pin. */
function dropoffFor(address, zone) {
  const base = ZONE_COORDS[zone] || { lat: 7.0731, lng: 125.6128 };
  const h = hashString(`${zone}|${address || ""}`);
  const dLat = ((h % 200) - 100) * 0.00003;
  const dLng = ((((h / 200) | 0) % 200) - 100) * 0.00003;
  return {
    lat: Math.round((base.lat + dLat) * 1e6) / 1e6,
    lng: Math.round((base.lng + dLng) * 1e6) / 1e6,
    label: address || zone || "Davao City",
  };
}

/** True when a map point already has usable coordinates (do not overwrite). */
function hasCoords(point) {
  return (
    point != null &&
    typeof point.lat === "number" &&
    typeof point.lng === "number" &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng)
  );
}

/** Default shop for suppliers that predate geography (stable Davao downtown pin). */
function defaultShopFor(supplier) {
  const name = supplier.supplierName || supplier.name || "Supplier";
  return {
    lat: 7.064,
    lng: 125.6085,
    label: `${name}, C.M. Recto St`,
  };
}

/** Pickup from supplier shop; null when no supplier assigned yet. */
function pickupFromSupplier(supplier) {
  if (!supplier?.shop || !hasCoords(supplier.shop)) return null;
  return {
    lat: supplier.shop.lat,
    lng: supplier.shop.lng,
    label: supplier.shop.label || supplier.supplierName || supplier.name,
  };
}

function setOrderPickup(order, store) {
  if (!order.supplierId) {
    order.pickup = null;
    return;
  }
  const supplier = store.users.find((u) => u.id === order.supplierId);
  order.pickup = pickupFromSupplier(supplier);
}

/**
 * Idempotent geography backfill for stores that predate pickup/dropoff/shop.
 * Only fills missing coords; never overwrites existing ones. Returns true if mutated.
 */
function backfillGeography(store) {
  let changed = false;

  for (const u of store.users || []) {
    if (u.role === "supplier" && !hasCoords(u.shop)) {
      u.shop = defaultShopFor(u);
      changed = true;
    }
  }

  for (const order of store.orders || []) {
    if (!hasCoords(order.dropoff)) {
      order.dropoff = dropoffFor(order.address, order.zone || "davao_central");
      changed = true;
    }
    if (order.supplierId && !hasCoords(order.pickup)) {
      const supplier = (store.users || []).find((u) => u.id === order.supplierId);
      const pickup = pickupFromSupplier(supplier);
      if (pickup) {
        order.pickup = pickup;
        changed = true;
      }
    }
  }

  return changed;
}

function load() {
  const store = JSON.parse(fs.readFileSync(STORE, "utf8"));
  if (backfillGeography(store)) {
    save(store);
  }
  return store;
}

function canViewOrderLocation(user, order) {
  if (!user || !order) return false;
  if (user.role === "ops_admin" || user.role === "super_admin") return true;
  if (user.role === "rider" && order.riderId === user.id) return true;
  if (user.role === "client" && order.clientId === user.id) return true;
  if (user.role === "supplier" && order.supplierId === user.id) return true;
  return false;
}

function ordersFor(user, store) {
  if (user.role === "client") return store.orders.filter((o) => o.clientId === user.id);
  if (user.role === "supplier") return store.orders.filter((o) => o.supplierId === user.id);
  if (user.role === "rider") {
    return store.orders.filter(
      (o) => o.riderId === user.id || ["ready_for_dispatch", "rider_assigned", "picked_up", "out_for_delivery"].includes(o.state),
    );
  }
  // ops / super see all
  return store.orders;
}

/** Simplified PRD state machine: who may trigger which transition. */
const TRANSITIONS = {
  draft: { submitted: ["client"] },
  submitted: { needs_qa: ["ops_admin", "super_admin"] },
  needs_qa: {
    client_correction: ["ops_admin", "super_admin"],
    proof_approval: ["ops_admin", "super_admin"],
    approved_for_matching: ["ops_admin", "super_admin"],
  },
  client_correction: { submitted: ["client"] },
  proof_approval: {
    approved_for_matching: ["client"],
    client_correction: ["client"],
  },
  approved_for_matching: { supplier_assigned: ["ops_admin", "super_admin"] },
  supplier_assigned: {
    supplier_accepted: ["supplier"],
    approved_for_matching: ["supplier"], // decline -> rematch
  },
  supplier_accepted: { awaiting_payment: ["supplier", "ops_admin", "super_admin"] },
  awaiting_payment: { payment_authorized: ["client", "ops_admin", "super_admin"] },
  payment_authorized: { production: ["supplier"] },
  production: { supplier_self_qc: ["supplier"] },
  supplier_self_qc: { ready_for_dispatch: ["supplier"] },
  ready_for_dispatch: { rider_assigned: ["rider", "ops_admin", "super_admin"] },
  rider_assigned: { picked_up: ["rider"] },
  picked_up: { out_for_delivery: ["rider"] },
  out_for_delivery: { delivered: ["rider"] },
  delivered: { issue_window_open: ["system", "ops_admin", "super_admin", "client", "rider"] },
  issue_window_open: {
    completed: ["ops_admin", "super_admin", "system"],
    // issue path simplified
  },
  completed: { payout_released: ["ops_admin", "super_admin"] },
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const { pathname } = url;
    const store = load();

    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, { ok: true, service: "gridgo-api", version: store.version, at: now() });
    }

    // ---- auth ----
    if (req.method === "POST" && pathname === "/auth/login") {
      const body = await readBody(req);
      const user = store.users.find(
        (u) => u.email === String(body.email || "").toLowerCase() && u.password === body.password,
      );
      if (!user) return send(res, 401, { error: "invalid_credentials" });
      const token = id("tok");
      store.sessions[token] = { userId: user.id, createdAt: now() };
      save(store);
      return send(res, 200, { token, user: publicUser(user) });
    }

    if (req.method === "GET" && pathname === "/auth/me") {
      const user = authUser(req, store);
      if (!user) return send(res, 401, { error: "unauthorized" });
      return send(res, 200, { user: publicUser(user) });
    }

    if (req.method === "POST" && pathname === "/auth/logout") {
      const h = req.headers.authorization || "";
      const m = /^Bearer\s+(.+)$/i.exec(h);
      if (m && store.sessions[m[1]]) {
        delete store.sessions[m[1]];
        save(store);
      }
      return send(res, 200, { ok: true });
    }

    const user = authUser(req, store);

    // public catalog for demo convenience
    if (req.method === "GET" && pathname === "/catalog") {
      return send(res, 200, { catalog: store.catalog });
    }

    if (!user) return send(res, 401, { error: "unauthorized" });

    // ---- notifications ----
    if (req.method === "GET" && pathname === "/notifications") {
      const items = store.notifications
        .filter((n) => n.userId === user.id)
        .sort((a, b) => (a.at < b.at ? 1 : -1));
      return send(res, 200, { notifications: items });
    }

    // ---- credits ----
    if (req.method === "GET" && pathname === "/credits/balance") {
      if (user.role !== "client" && user.role !== "ops_admin" && user.role !== "super_admin") {
        return send(res, 403, { error: "forbidden" });
      }
      const clientId = url.searchParams.get("clientId") || user.id;
      const acct = store.credits[clientId] || { balanceMinor: 0, ledger: [] };
      return send(res, 200, { clientId, balanceMinor: acct.balanceMinor, ledger: acct.ledger });
    }

    if (req.method === "POST" && pathname === "/credits/authorize") {
      if (user.role !== "client") return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const order = store.orders.find((o) => o.id === body.orderId);
      if (!order || order.clientId !== user.id) return send(res, 404, { error: "order_not_found" });
      if (order.state !== "awaiting_payment" && order.state !== "supplier_accepted") {
        return send(res, 409, { error: "invalid_state", state: order.state });
      }
      const acct = store.credits[user.id] || { balanceMinor: 0, ledger: [] };
      const amount = order.totalMinor + order.deliveryFeeMinor;
      if (acct.balanceMinor < amount) return send(res, 402, { error: "insufficient_credits", needMinor: amount, balanceMinor: acct.balanceMinor });
      acct.balanceMinor -= amount;
      acct.ledger.push({
        id: id("led"),
        type: "spend",
        amountMinor: -amount,
        balanceAfterMinor: acct.balanceMinor,
        reason: `Authorize order ${order.id}`,
        orderId: order.id,
        at: now(),
        actorId: user.id,
      });
      store.credits[user.id] = acct;
      order.paymentMethod = "pilot_credit";
      order.paymentStatus = "authorized";
      order.state = "payment_authorized";
      order.updatedAt = now();
      order.timeline.push({ at: order.updatedAt, state: order.state, by: user.id, note: "Pilot Credits authorized" });
      save(store);
      return send(res, 200, { order, balanceMinor: acct.balanceMinor });
    }

    // ---- orders list / create ----
    if (req.method === "GET" && pathname === "/orders") {
      return send(res, 200, { orders: ordersFor(user, store) });
    }

    if (req.method === "GET" && pathname.startsWith("/orders/")) {
      const orderId = pathname.slice("/orders/".length).split("/")[0];
      if (pathname.endsWith("/transition")) {
        // handled below for POST
      } else {
        const order = store.orders.find((o) => o.id === orderId);
        if (!order) return send(res, 404, { error: "order_not_found" });
        const visible = ordersFor(user, store).some((o) => o.id === orderId);
        if (!visible) return send(res, 403, { error: "forbidden" });
        return send(res, 200, { order });
      }
    }

    if (req.method === "POST" && pathname === "/orders") {
      if (user.role !== "client") return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const product = store.catalog.find((p) => p.id === body.productId) || store.catalog[0];
      const qty = Number(body.quantity || 1);
      const totalMinor = (product?.basePriceMinor || 10000) * qty;
      const deliveryFeeMinor = Number(body.deliveryFeeMinor || 15000);
      const ts = now();
      const address = body.address || "";
      const zone = body.zone || "davao_central";
      const order = {
        id: id("ord"),
        clientId: user.id,
        supplierId: null,
        riderId: null,
        state: body.submit ? "submitted" : "draft",
        productId: product.id,
        title: body.title || product.name,
        quantity: qty,
        size: body.size || "",
        material: body.material || "",
        deadline: body.deadline || null,
        address,
        zone,
        pickup: null,
        dropoff: dropoffFor(address, zone),
        totalMinor,
        deliveryFeeMinor,
        paymentMethod: null,
        paymentStatus: "unpaid",
        codEligible: totalMinor + deliveryFeeMinor <= 150000,
        promisedDate: null,
        artworkName: body.artworkName || null,
        createdAt: ts,
        updatedAt: ts,
        timeline: [{ at: ts, state: body.submit ? "submitted" : "draft", by: user.id, note: body.submit ? "Submitted" : "Draft saved" }],
      };
      store.orders.unshift(order);
      save(store);
      return send(res, 201, { order });
    }

    if (req.method === "POST" && /^\/orders\/[^/]+\/transition$/.test(pathname)) {
      const orderId = pathname.split("/")[2];
      const body = await readBody(req);
      const order = store.orders.find((o) => o.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const next = body.state;
      const allowed = TRANSITIONS[order.state]?.[next];
      if (!allowed || (!allowed.includes(user.role) && !allowed.includes("system"))) {
        return send(res, 409, { error: "transition_not_allowed", from: order.state, to: next, role: user.role });
      }
      // COD authorize path
      if (next === "payment_authorized" && body.paymentMethod === "cod") {
        const total = order.totalMinor + order.deliveryFeeMinor;
        if (total > 150000) return send(res, 400, { error: "cod_limit", maxMinor: 150000 });
        if (!order.codEligible) return send(res, 400, { error: "cod_not_eligible" });
        const openCod = store.orders.some(
          (o) => o.clientId === order.clientId && o.id !== order.id && o.paymentMethod === "cod" && o.paymentStatus !== "collected" && o.paymentStatus !== "reconciled" && !["completed", "payout_released"].includes(o.state),
        );
        if (openCod) return send(res, 409, { error: "cod_one_active" });
        order.paymentMethod = "cod";
        order.paymentStatus = "authorized";
      }
      if (next === "supplier_accepted") {
        order.supplierId = order.supplierId || user.id;
        order.promisedDate = body.promisedDate || order.deadline;
        if (body.finalTotalMinor) order.totalMinor = Number(body.finalTotalMinor);
        setOrderPickup(order, store);
      }
      if (next === "supplier_assigned" && body.supplierId) {
        order.supplierId = body.supplierId;
        setOrderPickup(order, store);
      }
      if (next === "approved_for_matching" && order.state === "supplier_assigned" && user.role === "supplier") {
        // treat as decline
        order.supplierId = null;
        order.pickup = null;
      }
      if (next === "rider_assigned") {
        order.riderId = user.role === "rider" ? user.id : body.riderId || order.riderId;
      }
      if (next === "delivered") {
        order.state = "delivered";
        order.updatedAt = now();
        order.timeline.push({ at: order.updatedAt, state: "delivered", by: user.id, note: body.note || "Delivered" });
        // auto open issue window
        order.state = "issue_window_open";
        order.timeline.push({ at: now(), state: "issue_window_open", by: "system", note: "24h issue window opened" });
        save(store);
        return send(res, 200, { order });
      }
      order.state = next;
      order.updatedAt = now();
      order.timeline.push({ at: order.updatedAt, state: next, by: user.id, note: body.note || "" });
      save(store);
      return send(res, 200, { order });
    }

    // ---- dispatch (rider) ----
    if (req.method === "GET" && pathname === "/dispatch/offers") {
      if (user.role !== "rider" && user.role !== "ops_admin" && user.role !== "super_admin") {
        return send(res, 403, { error: "forbidden" });
      }
      const offers = store.orders.filter((o) => o.state === "ready_for_dispatch" || (o.state === "rider_assigned" && o.riderId === user.id));
      return send(res, 200, { offers });
    }

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/accept$/.test(pathname)) {
      if (user.role !== "rider") return send(res, 403, { error: "forbidden" });
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((o) => o.id === orderId);
      if (!order || order.state !== "ready_for_dispatch") return send(res, 409, { error: "not_offerable" });
      order.riderId = user.id;
      order.state = "rider_assigned";
      order.updatedAt = now();
      order.timeline.push({ at: order.updatedAt, state: order.state, by: user.id, note: "Rider accepted" });
      save(store);
      return send(res, 200, { order });
    }

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/location$/.test(pathname)) {
      if (user.role !== "rider") return send(res, 403, { error: "forbidden" });
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((o) => o.id === orderId && o.riderId === user.id);
      if (!order) return send(res, 404, { error: "order_not_found" });
      if (!["picked_up", "out_for_delivery"].includes(order.state)) {
        return send(res, 409, { error: "tracking_not_active", state: order.state });
      }
      const body = await readBody(req);
      const ping = {
        id: id("ping"),
        orderId,
        riderId: user.id,
        lat: Number(body.lat),
        lng: Number(body.lng),
        accuracy: body.accuracy ?? null,
        at: now(),
      };
      store.locationPings.push(ping);
      save(store);
      return send(res, 201, { ping });
    }

    // Latest rider location for tracking (assigned rider, client, supplier, ops/super).
    if (req.method === "GET" && /^\/dispatch\/[^/]+\/location$/.test(pathname)) {
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((o) => o.id === orderId);
      if (!order) return send(res, 404, { error: "order_not_found" });
      if (!canViewOrderLocation(user, order)) return send(res, 403, { error: "forbidden" });
      const pings = store.locationPings.filter((p) => p.orderId === orderId);
      if (!pings.length) return send(res, 200, { ping: null });
      const ping = pings.reduce((latest, p) => (p.at > latest.at ? p : latest), pings[0]);
      return send(res, 200, { ping });
    }

    if (req.method === "POST" && /^\/dispatch\/[^/]+\/proof$/.test(pathname)) {
      if (user.role !== "rider") return send(res, 403, { error: "forbidden" });
      const orderId = pathname.split("/")[2];
      const order = store.orders.find((o) => o.id === orderId && o.riderId === user.id);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const body = await readBody(req);
      const proof = {
        id: id("prf"),
        orderId,
        riderId: user.id,
        kind: body.kind || "delivery", // pickup | delivery | cod | failure
        otp: body.otp || null,
        photoName: body.photoName || null,
        note: body.note || "",
        at: now(),
      };
      store.proofs.push(proof);
      if (proof.kind === "pickup" && order.state === "rider_assigned") {
        order.state = "picked_up";
        order.timeline.push({ at: now(), state: "picked_up", by: user.id, note: "Pickup proof" });
      } else if (proof.kind === "delivery" && ["picked_up", "out_for_delivery"].includes(order.state)) {
        order.state = "issue_window_open";
        order.timeline.push({ at: now(), state: "delivered", by: user.id, note: "Delivery proof" });
        order.timeline.push({ at: now(), state: "issue_window_open", by: "system", note: "24h issue window" });
        if (order.paymentMethod === "cod") order.paymentStatus = "collected";
      } else if (proof.kind === "cod") {
        order.paymentStatus = "collected";
      }
      order.updatedAt = now();
      save(store);
      return send(res, 201, { proof, order });
    }

    // ---- supplier jobs helper alias ----
    if (req.method === "GET" && pathname === "/jobs") {
      if (user.role !== "supplier") return send(res, 403, { error: "forbidden" });
      return send(res, 200, { jobs: store.orders.filter((o) => o.supplierId === user.id || o.state === "supplier_assigned") });
    }

    return send(res, 404, { error: "not_found", path: pathname });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: "server_error", message: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`gridgo-api listening on http://${HOST}:${PORT}`);
  console.log(`health: http://127.0.0.1:${PORT}/health`);
});
