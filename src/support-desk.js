import crypto from "node:crypto";

import { requestClientKey, tooManyRequests } from "./support-rate-limit.js";
import { validateReply, validateTicket } from "./support-validate.js";

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

export function readBearer(header) {
  if (!header) return null;
  const [scheme, token] = String(header).split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
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

export function deskAllowedEmails(env = process.env) {
  return new Set(
    String(env.SUPPORT_DESK_ALLOWED_EMAILS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The Clerk user's primary email, only when Clerk has verified it.
 *
 * `clerkClientProfile` falls back to the first listed address, which can be
 * one the account merely added and never confirmed. That is fine for a
 * display name and wrong for an allowlist.
 */
export function verifiedPrimaryEmail(clerkUser) {
  const emails = Array.isArray(clerkUser?.emailAddresses) ? clerkUser.emailAddresses : [];
  const primary = clerkUser?.primaryEmailAddress
    || emails.find((entry) => entry && entry.id === clerkUser?.primaryEmailAddressId);
  if (primary?.verification?.status !== "verified") return "";
  return String(primary.emailAddress || "").trim().toLowerCase();
}

/**
 * Desk access is a verified Clerk session whose primary email is on
 * SUPPORT_DESK_ALLOWED_EMAILS. A signed Clerk token for any other GRIDGO
 * account is not enough.
 *
 * A verified token may carry `email` (a session-token template mapping
 * `{{user.primary_email_address}}`). When it does not, the Clerk user is
 * loaded and only a verified primary address counts. The email claim is
 * trusted only because verifyClerk already checked the signature.
 */
export async function deskOperatorFromRequest(req, { env = process.env, verifyClerk, loadClerkUser }) {
  const allowed = deskAllowedEmails(env);
  if (allowed.size === 0) {
    return {
      status: 503,
      error: "desk_unconfigured",
      message: "Support desk access is not configured.",
    };
  }
  const token = readBearer(req.headers.authorization) || "";
  if (!token) {
    return { status: 401, error: "unauthorized", message: "Sign in with Clerk, then retry." };
  }
  const verified = await verifyClerk(token);
  if (!verified?.claims?.sub) {
    return { status: 401, error: "unauthorized", message: "Sign in with Clerk, then retry." };
  }
  let email = String(verified.claims.email || "").trim().toLowerCase();
  if (!email) {
    try {
      const user = await loadClerkUser(verified.claims.sub);
      email = verifiedPrimaryEmail(user);
    } catch {
      return {
        status: 503,
        error: "clerk_unavailable",
        message: "Could not confirm the Clerk account.",
      };
    }
  }
  if (!allowed.has(email)) {
    return {
      status: 403,
      error: "forbidden",
      message: "This desk is limited to the GRIDGO support account.",
    };
  }
  return { admin: { email, clerkUserId: verified.claims.sub } };
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
  verifyClerk,
  loadClerkUser,
}) {
  const path = supportDeskPathname(pathname);
  if (!path) return false;

  const method = req.method;
  const ipKey = requestClientKey(req);

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
    send(res, 404, {
      error: "not_found",
      message: "Desk password sign-in has been removed. Sign in with Clerk.",
    });
    return true;
  }

  async function requireDeskOperator() {
    return deskOperatorFromRequest(req, { env, verifyClerk, loadClerkUser });
  }

  if (method === "GET" && path === "/admin/me") {
    const auth = await requireDeskOperator();
    if (!auth.admin) {
      send(res, auth.status, { error: auth.error, message: auth.message });
      return true;
    }
    send(res, 200, { email: auth.admin.email });
    return true;
  }

  if (method === "GET" && path === "/support-tickets") {
    const auth = await requireDeskOperator();
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
    const auth = await requireDeskOperator();
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
    const auth = await requireDeskOperator();
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
    const auth = await requireDeskOperator();
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
