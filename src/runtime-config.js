import {
  DEMO_PASSWORD,
  DEMO_PASSWORD_ENV_BY_EMAIL,
  DEMO_USERS,
} from "./demo-fixtures.js";

const MIN_PRODUCTION_PASSWORD_LENGTH = 12;

export function isProduction(env = process.env) {
  return env.NODE_ENV === "production";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function configurationError(problem, fix) {
  return new Error(`${problem} ${fix}`);
}

/**
 * The repository-visible fixture credential is valid only for local development.
 * In production, each fixed pilot identity has an environment-owned password.
 */
export function configuredDemoUsers(env = process.env) {
  if (!isProduction(env)) return DEMO_USERS;

  const passwordOwners = new Map();
  return DEMO_USERS.map((fixture) => {
    const variable = DEMO_PASSWORD_ENV_BY_EMAIL.get(fixture.email);
    const password = String(env[variable] || "");
    if (!password) {
      throw configurationError(
        `${variable} is required when NODE_ENV=production.`,
        `Set ${variable} to a unique password of at least ${MIN_PRODUCTION_PASSWORD_LENGTH} characters and restart.`,
      );
    }
    if (password.length < MIN_PRODUCTION_PASSWORD_LENGTH) {
      throw configurationError(
        `${variable} is too short for the hosted pilot.`,
        `Set ${variable} to a unique password of at least ${MIN_PRODUCTION_PASSWORD_LENGTH} characters and restart.`,
      );
    }
    if (password === DEMO_PASSWORD) {
      throw configurationError(
        `${variable} still uses the repository-visible local development password.`,
        `Set ${variable} to a different password and restart.`,
      );
    }
    const existingVariable = passwordOwners.get(password);
    if (existingVariable) {
      throw configurationError(
        `${variable} reuses the password configured by ${existingVariable}.`,
        `Set ${variable} to a unique password for this pilot identity and restart.`,
      );
    }
    passwordOwners.set(password, variable);
    return { ...clone(fixture), password };
  });
}

function exactOrigin(value, variable) {
  if (value === "*") {
    throw configurationError(
      `${variable} cannot contain the wildcard origin '*'.`,
      `Set ${variable} to comma-separated exact portal origins such as https://gridgo.talasora.com and restart.`,
    );
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw configurationError(
      `${variable} contains an invalid origin: ${value}.`,
      `Use complete HTTP(S) origins without paths, for example https://gridgo.talasora.com, and restart.`,
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.origin !== value ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw configurationError(
      `${variable} contains a value that is not an exact HTTP(S) origin: ${value}.`,
      `Remove credentials, paths, query strings, fragments, and trailing slashes, then restart.`,
    );
  }
  return url.origin;
}

export function parseAllowedOrigins(env = process.env) {
  const raw = String(env.CORS_ALLOWED_ORIGINS || "").trim();
  if (!raw) return new Set();
  const origins = raw.split(",").map((value) => value.trim()).filter(Boolean);
  return new Set(origins.map((value) => exactOrigin(value, "CORS_ALLOWED_ORIGINS")));
}

function requireValue(env, variable, description) {
  const value = String(env[variable] || "").trim();
  if (!value) {
    throw configurationError(
      `${variable} is required when NODE_ENV=production.`,
      `Set ${variable} to ${description} and restart.`,
    );
  }
  return value;
}

function requireStorageOrigin(env, variable, { httpsOnly, loopbackOnly = false }) {
  const value = requireValue(
    env,
    variable,
    httpsOnly ? "the public HTTPS object-storage origin" : "the private API-to-MinIO HTTP(S) origin",
  );
  const origin = exactOrigin(value, variable);
  const hostname = new URL(origin).hostname;
  if (loopbackOnly && !["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
    throw configurationError(
      `${variable} must use host loopback in production; received ${origin}.`,
      `Set ${variable} to a loopback origin such as http://127.0.0.1:19000 and restart.`,
    );
  }
  if (httpsOnly && !origin.startsWith("https://")) {
    throw configurationError(
      `${variable} must use HTTPS in production; received ${origin}.`,
      `Set ${variable} to the public TLS origin used in signed download URLs and restart.`,
    );
  }
}

export function validateProductionServerEnvironment(env = process.env, allowedOrigins = parseAllowedOrigins(env)) {
  if (!isProduction(env)) return;
  if (allowedOrigins.size === 0) {
    throw configurationError(
      "CORS_ALLOWED_ORIGINS is required when NODE_ENV=production.",
      "Set CORS_ALLOWED_ORIGINS to the exact portal origin, for example https://gridgo.talasora.com, and restart.",
    );
  }
  requireStorageOrigin(env, "MINIO_ENDPOINT", { httpsOnly: false, loopbackOnly: true });
  requireStorageOrigin(env, "MINIO_PUBLIC_URL", { httpsOnly: true });
  requireValue(env, "MINIO_ACCESS_KEY", "the bucket-scoped MinIO API access key");
  requireValue(env, "MINIO_SECRET_KEY", "the bucket-scoped MinIO API secret key");
}
