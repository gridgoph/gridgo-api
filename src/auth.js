import crypto from "node:crypto";
import { createClerkClient, verifyToken } from "@clerk/backend";

const AUTH_MODES = new Set(["legacy", "dual", "clerk"]);
const GRIDGO_ROLES = new Set(["client", "supplier", "rider", "ops_admin", "super_admin"]);

function configurationError(problem, fix) {
  return new Error(`${problem} ${fix}`);
}

function requiredClerkValue(env, variable, mode, description) {
  const value = String(env[variable] || "").trim();
  if (!value) {
    throw configurationError(
      `${variable} is required when AUTH_MODE=${mode}.`,
      `Set ${variable} to ${description} and restart, or use AUTH_MODE=legacy.`,
    );
  }
  return value;
}

function exactIssuer(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw configurationError(
      `CLERK_ISSUER must be an exact HTTPS origin; received ${value}.`,
      "Set CLERK_ISSUER to the Clerk instance issuer without a path or trailing slash and restart.",
    );
  }
  if (parsed.protocol !== "https:" || parsed.origin !== value || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw configurationError(
      `CLERK_ISSUER must be an exact HTTPS origin; received ${value}.`,
      "Set CLERK_ISSUER to the Clerk instance issuer without a path or trailing slash and restart.",
    );
  }
  return value;
}

export function authConfiguration(env = process.env) {
  const mode = String(env.AUTH_MODE || "legacy").trim().toLowerCase();
  if (!AUTH_MODES.has(mode)) {
    throw configurationError(
      `AUTH_MODE must be legacy, dual, or clerk; received ${mode || "empty"}.`,
      "Set AUTH_MODE to one of those exact values and restart.",
    );
  }
  if (mode === "legacy") return { mode };

  const secretKey = requiredClerkValue(
    env,
    "CLERK_SECRET_KEY",
    mode,
    "the server-only Clerk instance secret key",
  );
  const issuer = exactIssuer(
    requiredClerkValue(env, "CLERK_ISSUER", mode, "the exact HTTPS issuer for the intended Clerk instance"),
  );
  const authorizedParties = requiredClerkValue(
    env,
    "CLERK_AUTHORIZED_PARTIES",
    mode,
    "a comma-separated allowlist of frontend origins allowed in the Clerk token azp claim",
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (authorizedParties.length === 0) {
    throw configurationError(
      `CLERK_AUTHORIZED_PARTIES is required when AUTH_MODE=${mode}.`,
      "Set CLERK_AUTHORIZED_PARTIES to at least one expected frontend origin and restart, or use AUTH_MODE=legacy.",
    );
  }

  return {
    mode,
    secretKey,
    issuer,
    authorizedParties,
    ...(String(env.CLERK_JWT_KEY || "").trim() ? { jwtKey: String(env.CLERK_JWT_KEY).trim() } : {}),
    ...(String(env.CLERK_API_URL || "").trim() ? { apiUrl: String(env.CLERK_API_URL).trim() } : {}),
  };
}

export function createClerkBackend(config) {
  return createClerkClient({
    secretKey: config.secretKey,
    ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
    telemetry: { disabled: true },
  });
}

export async function verifyClerkClaims(token, config) {
  let claims;
  try {
    claims = await verifyToken(token, {
      secretKey: config.secretKey,
      authorizedParties: config.authorizedParties,
      ...(config.jwtKey ? { jwtKey: config.jwtKey } : {}),
    });
  } catch {
    return { claims: null, status: 401 };
  }
  if (claims.iss !== config.issuer) return { claims: null, status: 401 };
  return { claims, status: null };
}

function clerkMetadataRole(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const value = metadata.gridgoRole ?? metadata.gridgo_role;
  return typeof value === "string" && value ? value : null;
}

export function clerkClientProfile(clerkUser) {
  const email = String(
    clerkUser?.primaryEmailAddress?.emailAddress
      || clerkUser?.emailAddresses?.[0]?.emailAddress
      || "",
  ).trim().toLowerCase();
  const phone = String(
    clerkUser?.primaryPhoneNumber?.phoneNumber
      || clerkUser?.phoneNumbers?.[0]?.phoneNumber
      || "",
  ).trim();
  const name = [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(" ").trim()
    || String(clerkUser?.username || "").trim()
    || (email.includes("@") ? email.split("@")[0] : "");
  return {
    email,
    phone,
    name,
    metadataRole: clerkMetadataRole(clerkUser?.publicMetadata),
  };
}

function unauthorized(message = "Sign in with Clerk, then retry this request with the new access token.") {
  return { status: 401, error: "unauthorized", message, user: null, mutated: false };
}

function invitationRequired(message) {
  return {
    status: 403,
    error: "invitation_required",
    message,
    user: null,
    mutated: false,
  };
}

function legacyIdentity(token, store) {
  const session = store.sessions?.[token];
  if (!session) return { user: null, status: 401, kind: "legacy" };
  const user = store.users.find((candidate) => candidate.id === session.userId) || null;
  return user ? { user, status: null, kind: "legacy" } : { user: null, status: 401, kind: "legacy" };
}

export async function authenticateBearerToken(token, store, config) {
  if (!token) return { user: null, status: 401, kind: null };
  // Dual mode recognizes the legacy family by its server-issued prefix. Every
  // other bearer goes through Clerk and can never fall back to store.sessions,
  // even when verification throws or the token is malformed.
  if (config.mode === "legacy" || (config.mode === "dual" && token.startsWith("tok_"))) {
    return legacyIdentity(token, store);
  }

  const verified = await verifyClerkClaims(token, config);
  if (!verified.claims) return { user: null, status: 401, kind: "clerk" };
  const matches = store.users.filter((candidate) => candidate.clerkUserId === verified.claims.sub);
  if (matches.length !== 1) return { user: null, status: 401, kind: "clerk" };

  const user = matches[0];
  const claimRole = verified.claims.gridgo_role;
  if (!GRIDGO_ROLES.has(claimRole) || claimRole !== user.role) {
    return { user: null, status: 403, kind: "clerk" };
  }
  return { user, status: null, kind: "clerk" };
}

/**
 * First-time Google / public SSO entry. `/auth/me` stays fail-closed: this is
 * the only path that may link by email, and it can only activate a client.
 */
export async function activateClerkClientProfile({
  token,
  store,
  config,
  clerkBackend,
  createId,
  now,
}) {
  if (!token || config.mode === "legacy") return unauthorized();
  if (config.mode === "dual" && token.startsWith("tok_")) return unauthorized();

  const verified = await verifyClerkClaims(token, config);
  if (!verified.claims) return unauthorized();
  const clerkUserId = verified.claims.sub;
  if (!clerkUserId) return unauthorized();

  const claimRole = verified.claims.gridgo_role;
  if (claimRole != null && claimRole !== "client") {
    return invitationRequired(
      "Supplier, rider, and operations access is assigned by GRIDGO Operations. This Google sign-in can only open a client profile.",
    );
  }

  const linked = (store.users || []).filter((candidate) => candidate.clerkUserId === clerkUserId);
  if (linked.length > 1) return unauthorized();
  if (linked.length === 1 && linked[0].role !== "client") {
    return invitationRequired(
      "This Clerk identity is already assigned to a non-client GRIDGO role.",
    );
  }

  let clerkUser;
  try {
    clerkUser = await clerkBackend.users.getUser(clerkUserId);
  } catch {
    return {
      status: 502,
      error: "clerk_unavailable",
      message: "Could not load this Clerk user. Retry Google sign-in in a moment.",
      user: null,
      mutated: false,
    };
  }

  const profile = clerkClientProfile(clerkUser);
  if (profile.metadataRole && profile.metadataRole !== "client") {
    return invitationRequired(
      "This Clerk account is reserved for a non-client GRIDGO role. Ask Operations for an invitation.",
    );
  }

  let user = linked[0] || null;
  let mutated = false;

  if (!user) {
    if (!profile.email || !profile.email.includes("@")) {
      return {
        status: 400,
        error: "email_required",
        message: "This Google account has no email address GRIDGO can use. Add an email in Clerk and try again.",
        user: null,
        mutated: false,
      };
    }

    const emailMatches = (store.users || []).filter(
      (candidate) => String(candidate.email || "").toLowerCase() === profile.email,
    );
    if (emailMatches.some((candidate) => candidate.role !== "client")) {
      return invitationRequired(
        "This email already belongs to a supplier, rider, or operations account. Ask Operations to assign access.",
      );
    }
    const clients = emailMatches.filter((candidate) => candidate.role === "client");
    if (clients.length > 1) {
      return {
        status: 409,
        error: "email_conflict",
        message: "More than one client account uses this email. Ask Operations to resolve the duplicate.",
        user: null,
        mutated: false,
      };
    }
    if (clients.length === 1) {
      if (clients[0].clerkUserId && clients[0].clerkUserId !== clerkUserId) {
        return {
          status: 409,
          error: "email_already_linked",
          message: "This email is already linked to a different Clerk identity.",
          user: null,
          mutated: false,
        };
      }
      clients[0].clerkUserId = clerkUserId;
      user = clients[0];
      mutated = true;
    } else {
      user = {
        id: createId("user"),
        email: profile.email,
        password: `clerk_${crypto.randomBytes(24).toString("hex")}`,
        name: profile.name || profile.email.split("@")[0],
        role: "client",
        clerkUserId,
        createdAt: now(),
      };
      if (profile.phone) user.phone = profile.phone;
      store.users.push(user);
      mutated = true;
    }
  }

  try {
    await clerkBackend.users.updateUserMetadata(clerkUserId, {
      publicMetadata: { gridgoRole: "client" },
    });
  } catch {
    return {
      status: 502,
      error: "clerk_unavailable",
      message: "The GRIDGO client profile was prepared, but Clerk metadata could not be written. Retry activate.",
      user,
      mutated,
    };
  }

  return { status: 200, error: null, message: null, user, mutated };
}
