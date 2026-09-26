import { createClerkClient, verifyToken } from "@clerk/backend";

import { resolveAuthorizationContext } from "./authorization-context.js";

function configurationError(problem, fix) {
  return new Error(`${problem} ${fix}`);
}

function requiredClerkValue(env, variable, description) {
  const value = String(env[variable] || "").trim();
  if (!value) {
    throw configurationError(
      `${variable} is required for Clerk-only authentication.`,
      `Set ${variable} to ${description} and restart.`,
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
  if (env.AUTH_MODE != null) {
    throw configurationError(
      "AUTH_MODE has been removed; legacy and dual authentication are no longer supported.",
      "Remove AUTH_MODE and configure Clerk-only authentication.",
    );
  }
  const secretKey = requiredClerkValue(env, "CLERK_SECRET_KEY", "the server-only Clerk instance secret key");
  const issuer = exactIssuer(requiredClerkValue(env, "CLERK_ISSUER", "the exact HTTPS issuer for the intended Clerk instance"));
  const authorizedParties = requiredClerkValue(
    env,
    "CLERK_AUTHORIZED_PARTIES",
    "a comma-separated allowlist of frontend origins allowed in the Clerk token azp claim",
  ).split(",").map((value) => value.trim()).filter(Boolean);
  if (authorizedParties.length === 0) {
    throw configurationError(
      "CLERK_AUTHORIZED_PARTIES must contain at least one origin.",
      "Set it to the expected mobile and dashboard frontend origins and restart.",
    );
  }
  return {
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
    // Expo session JWTs omit azp. Clerk's verifyToken rejects a missing azp
    // whenever authorizedParties is set, so check azp only after verification.
    claims = await verifyToken(token, {
      secretKey: config.secretKey,
      ...(config.jwtKey ? { jwtKey: config.jwtKey } : {}),
    });
  } catch {
    return { claims: null, status: 401 };
  }
  if (claims.iss !== config.issuer) return { claims: null, status: 401 };
  if (claims.azp != null && claims.azp !== "" && !config.authorizedParties.includes(claims.azp)) {
    return { claims: null, status: 401 };
  }
  return { claims, status: null };
}

export function clerkClientProfile(clerkUser) {
  const emails = Array.isArray(clerkUser?.email_addresses) ? clerkUser.email_addresses : [];
  const webhookPrimary = emails.find((entry) => entry && entry.id === clerkUser?.primary_email_address_id) || emails[0];
  const email = String(
    clerkUser?.primaryEmailAddress?.emailAddress
      || clerkUser?.emailAddresses?.[0]?.emailAddress
      || webhookPrimary?.email_address
      || "",
  ).trim().toLowerCase();
  const phone = String(
    clerkUser?.primaryPhoneNumber?.phoneNumber
      || clerkUser?.phoneNumbers?.[0]?.phoneNumber
      || clerkUser?.phone_numbers?.[0]?.phone_number
      || "",
  ).trim();
  const name = [clerkUser?.firstName ?? clerkUser?.first_name, clerkUser?.lastName ?? clerkUser?.last_name]
    .filter(Boolean).join(" ").trim()
    || String(clerkUser?.username || "").trim()
    || (email.includes("@") ? email.split("@")[0] : "");
  return { email, phone, name };
}

/**
 * Clerk webhook payloads use snake_case UserJSON. Shape that into the Backend
 * user the profile helper already understands so enroll, /auth/me, and the
 * webhook share one copy rule.
 */
export function clerkUserFromWebhookData(data) {
  if (!data || typeof data !== "object") return null;
  const emails = Array.isArray(data.email_addresses) ? data.email_addresses : [];
  const primary = emails.find((entry) => entry && entry.id === data.primary_email_address_id) || emails[0];
  return {
    firstName: data.first_name,
    lastName: data.last_name,
    username: data.username,
    primaryEmailAddress: primary?.email_address ? { emailAddress: primary.email_address } : undefined,
  };
}

/**
 * Refresh the GRIDGO account's person copy from Clerk.
 *
 * Clerk owns first name, last name, and primary email. GRIDGO keeps a copy so
 * greetings, Operations lists, and mail still work when Clerk is not in the
 * request. Shop name, pin, floor phone, and floor contact are not touched.
 * A Clerk email that already belongs to another GRIDGO account is left alone.
 */
export function applyClerkIdentityCopy(store, user, clerkUser) {
  if (!user || !clerkUser) return { mutated: false };
  const profile = clerkClientProfile(clerkUser);
  let mutated = false;

  if (!user.profileNameManaged && profile.name && profile.name !== user.name) {
    user.name = profile.name;
    mutated = true;
  }

  const currentEmail = String(user.email || "").trim().toLowerCase();
  if (profile.email && profile.email.includes("@") && profile.email !== currentEmail) {
    const taken = (store.users || []).some(
      (candidate) => candidate.id !== user.id && String(candidate.email || "").trim().toLowerCase() === profile.email,
    );
    if (!taken) {
      user.email = profile.email;
      mutated = true;
    }
  }

  return { mutated };
}

export async function refreshMappedIdentityFromClerk({ clerkBackend, store, user }) {
  if (!user?.clerkUserId || typeof clerkBackend?.users?.getUser !== "function") {
    return { mutated: false };
  }
  let clerkUser;
  try {
    clerkUser = await clerkBackend.users.getUser(user.clerkUserId);
  } catch {
    return { mutated: false };
  }
  return applyClerkIdentityCopy(store, user, clerkUser);
}

/**
 * Apply a verified Clerk user event to an already-mapped account.
 * Unmapped identities stay unmapped — GRIDGO still creates accounts only on
 * activate/enroll. Ambiguous mappings are left untouched.
 */
export function applyClerkWebhookEvent(store, event) {
  if (!event || (event.type !== "user.updated" && event.type !== "user.created")) {
    return { mutated: false };
  }
  const clerkUserId = event.data?.id;
  if (!clerkUserId) return { mutated: false };
  const matches = (store.users || []).filter((candidate) => candidate.clerkUserId === clerkUserId);
  if (matches.length !== 1) return { mutated: false };
  return applyClerkIdentityCopy(store, matches[0], clerkUserFromWebhookData(event.data));
}

function unauthorized(message = "Sign in with Clerk, then retry this request with the new access token.") {
  return { status: 401, error: "unauthorized", message, user: null, mutated: false };
}

function invitationRequired(message) {
  return { status: 403, error: "invitation_required", message, user: null, mutated: false };
}

/**
 * Whether this email may continue as a GRIDGO client.
 *
 * Unknown emails are allowed (new clients). An existing non-client identity
 * is not — the Client app must refuse before Clerk emails a device-trust code.
 * The answer never names the other role.
 */
export function clientEmailAvailable(store, email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized.includes("@")) return false;
  const matches = (store.users || []).filter(
    (candidate) => String(candidate.email || "").toLowerCase() === normalized,
  );
  if (matches.length === 0) return true;
  return matches.every((candidate) => candidate.role === "client");
}

function ensureClientMembership(store, user, now) {
  let mutated = false;
  if (!Array.isArray(store.userRoleMemberships)) store.userRoleMemberships = [];
  if (!store.userRoleMemberships.some(
    (membership) => membership.userId === user.id && membership.role === "client",
  )) {
    store.userRoleMemberships.push({
      userId: user.id,
      role: "client",
      createdAt: now(),
    });
    mutated = true;
  }

  if (!Array.isArray(store.clientProfiles)) store.clientProfiles = [];
  if (!store.clientProfiles.some((clientProfile) => clientProfile.userId === user.id)) {
    store.clientProfiles.push({
      userId: user.id,
      clientKind: "personal",
      updatedAt: now(),
    });
    mutated = true;
  }
  return mutated;
}

export async function authenticateBearerToken(token, store, config, preVerified = null) {
  if (!token) return { user: null, status: 401, kind: null, error: "unauthorized" };
  const verified = preVerified || (await verifyClerkClaims(token, config));
  if (!verified.claims?.sub) return { user: null, status: 401, kind: "clerk", error: "unauthorized" };
  const matches = (store.users || []).filter((candidate) => candidate.clerkUserId === verified.claims.sub);
  if (matches.length === 0) {
    return { user: null, status: 401, kind: "clerk", error: "unmapped_identity" };
  }
  if (matches.length !== 1) return { user: null, status: 401, kind: "clerk", error: "unauthorized" };
  const user = matches[0];
  return {
    user,
    authorization: resolveAuthorizationContext(store, user),
    status: null,
    kind: "clerk",
  };
}

/** Body for a failed authenticateBearerToken result. */
export function authFailureBody(auth) {
  const error = auth?.error || (auth?.status === 403 ? "forbidden" : "unauthorized");
  if (error === "unmapped_identity") {
    return {
      error,
      message: "This sign-in is not linked to a GRIDGO account yet.",
    };
  }
  return { error };
}

/** Explicit first-use entry for public SSO. It can only create a client. */
export async function activateClerkClientProfile({
  token,
  store,
  config,
  clerkBackend,
  createId,
  now,
  preVerified = null,
  preloadedClerkUser = null,
}) {
  if (!token) return unauthorized();
  const verified = preVerified || (await verifyClerkClaims(token, config));
  if (!verified.claims?.sub) return unauthorized();
  const clerkUserId = verified.claims.sub;
  const linked = (store.users || []).filter((candidate) => candidate.clerkUserId === clerkUserId);
  if (linked.length > 1) return unauthorized();
  if (linked.length === 1) {
    const user = linked[0];
    const mutated = ensureClientMembership(store, user, now);
    return { status: 200, error: null, message: null, user, mutated };
  }

  let clerkUser = preloadedClerkUser ? preloadedClerkUser.clerkUser : undefined;
  if (clerkUser === undefined) {
    try {
      clerkUser = await clerkBackend.users.getUser(clerkUserId);
    } catch {
      clerkUser = null;
    }
  }
  if (!clerkUser) {
    return { status: 502, error: "clerk_unavailable", message: "Could not load this Clerk user. Retry Google sign-in in a moment.", user: null, mutated: false };
  }
  const profile = clerkClientProfile(clerkUser);
  let user = null;
  let mutated = false;

  if (!profile.email || !profile.email.includes("@")) {
    return { status: 400, error: "email_required", message: "This Google account has no email address GRIDGO can use. Add an email in Clerk and try again.", user: null, mutated: false };
  }
  const emailMatches = (store.users || []).filter(
    (candidate) => String(candidate.email || "").toLowerCase() === profile.email,
  );
  if (emailMatches.some((candidate) => candidate.role !== "client")) {
    return invitationRequired("This email belongs to a non-client GRIDGO account. Ask an administrator to link the Clerk identity.");
  }
  if (emailMatches.length > 0) {
    return { status: 409, error: "email_already_registered", message: "This email is already assigned to another GRIDGO identity. Ask an administrator to resolve the account conflict.", user: null, mutated: false };
  }
  user = {
    id: createId("user"),
    clerkUserId,
    email: profile.email,
    name: profile.name || profile.email.split("@")[0],
    role: "client",
    accountType: "individual",
    accountStatus: "active",
    createdAt: now(),
  };
  if (profile.phone) user.phone = profile.phone;
  store.users.push(user);
  mutated = true;
  mutated = ensureClientMembership(store, user, now) || mutated;
  return { status: 200, error: null, message: null, user, mutated };
}
