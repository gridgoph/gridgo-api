import { createClerkClient, verifyToken } from "@clerk/backend";

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
  return { email, phone, name };
}

function unauthorized(message = "Sign in with Clerk, then retry this request with the new access token.") {
  return { status: 401, error: "unauthorized", message, user: null, mutated: false };
}

function invitationRequired(message) {
  return { status: 403, error: "invitation_required", message, user: null, mutated: false };
}

export async function authenticateBearerToken(token, store, config) {
  if (!token) return { user: null, status: 401, kind: null };
  const verified = await verifyClerkClaims(token, config);
  if (!verified.claims?.sub) return { user: null, status: 401, kind: "clerk" };
  const matches = (store.users || []).filter((candidate) => candidate.clerkUserId === verified.claims.sub);
  if (matches.length !== 1) return { user: null, status: 401, kind: "clerk" };
  return { user: matches[0], status: null, kind: "clerk" };
}

/** Explicit first-use entry for public SSO. It can only create a client. */
export async function activateClerkClientProfile({ token, store, config, clerkBackend, createId, now }) {
  if (!token) return unauthorized();
  const verified = await verifyClerkClaims(token, config);
  if (!verified.claims?.sub) return unauthorized();
  const clerkUserId = verified.claims.sub;
  const linked = (store.users || []).filter((candidate) => candidate.clerkUserId === clerkUserId);
  if (linked.length > 1) return unauthorized();
  if (linked.length === 1 && linked[0].role !== "client") {
    return invitationRequired("This Clerk identity is already assigned to a non-client GRIDGO role.");
  }

  let clerkUser;
  try {
    clerkUser = await clerkBackend.users.getUser(clerkUserId);
  } catch {
    return { status: 502, error: "clerk_unavailable", message: "Could not load this Clerk user. Retry Google sign-in in a moment.", user: null, mutated: false };
  }
  const profile = clerkClientProfile(clerkUser);
  let user = linked[0] || null;
  let mutated = false;

  if (!user) {
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
      createdAt: now(),
    };
    if (profile.phone) user.phone = profile.phone;
    store.users.push(user);
    mutated = true;
  }
  return { status: 200, error: null, message: null, user, mutated };
}
