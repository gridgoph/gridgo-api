import crypto from "node:crypto";
import { promisify } from "node:util";

import { clientKey, tooManyRequests } from "./support-rate-limit.js";
import { validateLogin, validateReply, validateTicket } from "./support-validate.js";

const scrypt = promisify(crypto.scrypt);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const TOKEN_TTL_SECONDS = 12 * 60 * 60;
const SUPPORT_LOCK = "gridgo-support-desk";

export function supportDeskPathname(pathname) {
  const path = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
  if (path === "/support-tickets" || path === "/admin/login" || path === "/admin/me") return path;
  if (/^\/support-tickets\/[^/]+$/.test(path)) return path;
  if (/^\/support-tickets\/[^/]+\/reply$/.test(path)) return path;
  return null;
}

export function isSupportDeskRoute(pathname) {
  return supportDeskPathname(pathname) != null;
}

function asIso(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function mapTicket(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    subject: row.subject,
    message: row.message,
    status: row.status,
    adminReply: row.admin_reply,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${Buffer.from(key).toString("base64url")}`;
}

export async function verifyPassword(password, passwordHash) {
  const parts = String(passwordHash || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 2 || r < 1 || p < 1) {
    return false;
  }
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], "base64url");
    expected = Buffer.from(parts[5], "base64url");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = Buffer.from(await scrypt(password, salt, expected.length, { N: n, r, p }));
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function deskJwtSecret(env) {
  return String(env.SUPPORT_DESK_JWT_SECRET || "").trim();
}

export function signAdminToken(admin, env = process.env) {
  const secret = deskJwtSecret(env);
  if (!secret) throw new Error("SUPPORT_DESK_JWT_SECRET is not set");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: admin.id,
    username: admin.username,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function verifyAdminToken(token, env = process.env) {
  const secret = deskJwtSecret(env);
  if (!secret) throw new Error("invalid token");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("invalid token");
  const [headerB64, payloadB64, signature] = parts;
  let header;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid token");
  }
  if (header?.alg !== "HS256") throw new Error("invalid token");
  const expected = crypto.createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest("base64url");
  const signatureBuf = Buffer.from(signature, "base64url");
  const expectedBuf = Buffer.from(expected, "base64url");
  if (signatureBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(signatureBuf, expectedBuf)) {
    throw new Error("invalid token");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid token");
  }
  if (typeof payload.sub !== "string" || typeof payload.username !== "string" || !payload.username) {
    throw new Error("invalid token");
  }
  if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("invalid token");
  }
  return { sub: payload.sub, username: payload.username };
}

export function readBearer(header) {
  if (!header) return null;
  const [scheme, token] = String(header).split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export async function findAdminByUsername(database, username) {
  const result = await database.query(
    "SELECT id, username, password_hash FROM support_admins WHERE username = $1 LIMIT 1",
    [username],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, username: row.username, passwordHash: row.password_hash };
}

export async function authenticateAdmin(database, username, password) {
  const admin = await findAdminByUsername(database, username);
  if (!admin) return null;
  const matches = await verifyPassword(password, admin.passwordHash);
  return matches ? admin : null;
}

export async function seedSupportDeskAdmin(database, env = process.env) {
  const username = String(env.SUPPORT_DESK_USERNAME || "").trim();
  const password = env.SUPPORT_DESK_PASSWORD;
  if (!username || typeof password !== "string" || !password) return { seeded: false };
  const passwordHash = await hashPassword(password);
  await database.query(
    `INSERT INTO support_admins (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [username, passwordHash],
  );
  return { seeded: true };
}

export async function createTicket(database, input) {
  const result = await database.query(
    `INSERT INTO support_tickets (name, email, subject, message)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, email, subject, message, status, admin_reply, created_at, updated_at`,
    [input.name, input.email, input.subject, input.message],
  );
  return mapTicket(result.rows[0]);
}

export async function listTickets(database) {
  const result = await database.query(
    `SELECT id, name, email, subject, message, status, admin_reply, created_at, updated_at
     FROM support_tickets
     ORDER BY created_at DESC`,
  );
  return result.rows.map(mapTicket);
}

export async function findTicket(database, id) {
  const result = await database.query(
    `SELECT id, name, email, subject, message, status, admin_reply, created_at, updated_at
     FROM support_tickets
     WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapTicket(row) : null;
}

export async function saveReply(database, id, replyMessage) {
  const result = await database.query(
    `UPDATE support_tickets
     SET admin_reply = $2, status = 'closed', updated_at = now()
     WHERE id = $1
     RETURNING id, name, email, subject, message, status, admin_reply, created_at, updated_at`,
    [id, replyMessage],
  );
  const row = result.rows[0];
  return row ? mapTicket(row) : null;
}

export async function deleteTicket(database, id) {
  const result = await database.query("DELETE FROM support_tickets WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

function deskAdminFromRequest(req, env) {
  const token = readBearer(req.headers.authorization);
  if (!token) {
    return { status: 401, error: "unauthorized", message: "Sign in required." };
  }
  try {
    return { admin: verifyAdminToken(token, env) };
  } catch {
    return { status: 401, error: "unauthorized", message: "Session expired. Sign in again." };
  }
}

function ticketNotFound(id) {
  return {
    error: "support_ticket_not_found",
    message: `Support ticket with ID ${id} not found`,
  };
}

export async function routeSupportDesk({
  req,
  res,
  pathname,
  readBody,
  send,
  database,
  mailer,
  env = process.env,
}) {
  const path = supportDeskPathname(pathname);
  if (!path) return false;

  const method = req.method;
  const ipKey = clientKey(req.socket?.remoteAddress, req.headers["x-forwarded-for"]);

  if (method === "POST" && path === "/support-tickets") {
    if (tooManyRequests(`ticket:${ipKey}`, 5, 10 * 60 * 1000)) {
      send(res, 429, {
        error: "too_many_requests",
        message: "You are submitting tickets too fast. Please wait a few minutes.",
      });
      return true;
    }
    const parsed = validateTicket(await readBody(req));
    if (!parsed.ok) {
      send(res, 400, { error: "invalid_request", message: parsed.message });
      return true;
    }
    const ticket = await database.transaction(
      () => createTicket(database, parsed.value),
      { lockKey: SUPPORT_LOCK },
    );
    send(res, 201, { id: ticket.id, status: ticket.status, createdAt: ticket.createdAt });
    return true;
  }

  if (method === "POST" && path === "/admin/login") {
    const parsed = validateLogin(await readBody(req));
    if (!parsed.ok) {
      send(res, 400, { error: "invalid_request", message: parsed.message });
      return true;
    }
    if (tooManyRequests(`login:${ipKey}`, 8, 15 * 60 * 1000)) {
      send(res, 429, {
        error: "too_many_requests",
        message: "Too many sign-in attempts. Try again later.",
      });
      return true;
    }
    const admin = await authenticateAdmin(database, parsed.username, parsed.password);
    if (!admin) {
      send(res, 401, { error: "invalid_credentials", message: "Invalid username or password." });
      return true;
    }
    if (!deskJwtSecret(env)) {
      send(res, 503, {
        error: "desk_unconfigured",
        message: "Support desk sessions are not configured.",
      });
      return true;
    }
    send(res, 200, { token: signAdminToken(admin, env), username: admin.username });
    return true;
  }

  if (method === "GET" && path === "/admin/me") {
    const auth = deskAdminFromRequest(req, env);
    if (!auth.admin) {
      send(res, auth.status, { error: auth.error, message: auth.message });
      return true;
    }
    send(res, 200, { username: auth.admin.username });
    return true;
  }

  if (method === "GET" && path === "/support-tickets") {
    const auth = deskAdminFromRequest(req, env);
    if (!auth.admin) {
      send(res, auth.status, { error: auth.error, message: auth.message });
      return true;
    }
    send(res, 200, await listTickets(database));
    return true;
  }

  const ticketMatch = /^\/support-tickets\/([^/]+)$/.exec(path);
  const replyMatch = /^\/support-tickets\/([^/]+)\/reply$/.exec(path);

  if (method === "GET" && ticketMatch) {
    const auth = deskAdminFromRequest(req, env);
    if (!auth.admin) {
      send(res, auth.status, { error: auth.error, message: auth.message });
      return true;
    }
    const ticket = await findTicket(database, ticketMatch[1]);
    if (!ticket) {
      send(res, 404, ticketNotFound(ticketMatch[1]));
      return true;
    }
    send(res, 200, ticket);
    return true;
  }

  if (method === "PATCH" && replyMatch) {
    const auth = deskAdminFromRequest(req, env);
    if (!auth.admin) {
      send(res, auth.status, { error: auth.error, message: auth.message });
      return true;
    }
    const parsed = validateReply(await readBody(req));
    if (!parsed.ok) {
      send(res, 400, { error: "invalid_request", message: parsed.message });
      return true;
    }
    const existing = await findTicket(database, replyMatch[1]);
    if (!existing) {
      send(res, 404, ticketNotFound(replyMatch[1]));
      return true;
    }
    const ticket = await database.transaction(
      () => saveReply(database, existing.id, parsed.replyMessage),
      { lockKey: SUPPORT_LOCK },
    );
    if (!ticket) {
      send(res, 404, ticketNotFound(replyMatch[1]));
      return true;
    }
    const mail = await mailer.sendReplyEmail(ticket, parsed.replyMessage);
    if (!mail.sent) {
      console.error(`Reply email not sent for ticket ${ticket.id}: ${mail.error}`);
    }
    send(res, 200, { ...ticket, emailSent: mail.sent });
    return true;
  }

  if (method === "DELETE" && ticketMatch) {
    const auth = deskAdminFromRequest(req, env);
    if (!auth.admin) {
      send(res, auth.status, { error: auth.error, message: auth.message });
      return true;
    }
    const removed = await database.transaction(
      () => deleteTicket(database, ticketMatch[1]),
      { lockKey: SUPPORT_LOCK },
    );
    if (!removed) {
      send(res, 404, ticketNotFound(ticketMatch[1]));
      return true;
    }
    send(res, 204, {});
    return true;
  }

  send(res, 404, { error: "not_found", path: pathname });
  return true;
}
