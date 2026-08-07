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

function load() {
  return JSON.parse(fs.readFileSync(STORE, "utf8"));
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
        address: body.address || "",
        zone: body.zone || "davao_central",
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
      }
      if (next === "approved_for_matching" && order.state === "supplier_assigned" && user.role === "supplier") {
        // treat as decline
        order.supplierId = null;
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
