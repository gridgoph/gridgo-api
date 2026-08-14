import { verifyToken } from "@clerk/backend";

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

  let claims;
  try {
    claims = await verifyToken(token, {
      secretKey: config.secretKey,
      authorizedParties: config.authorizedParties,
      ...(config.jwtKey ? { jwtKey: config.jwtKey } : {}),
    });
  } catch {
    return { user: null, status: 401, kind: "clerk" };
  }
  if (claims.iss !== config.issuer) return { user: null, status: 401, kind: "clerk" };
  const matches = store.users.filter((candidate) => candidate.clerkUserId === claims.sub);
  if (matches.length !== 1) return { user: null, status: 401, kind: "clerk" };

  const user = matches[0];
  const claimRole = claims.gridgo_role;
  if (!GRIDGO_ROLES.has(claimRole) || claimRole !== user.role) {
    return { user: null, status: 403, kind: "clerk" };
  }
  return { user, status: null, kind: "clerk" };
}
