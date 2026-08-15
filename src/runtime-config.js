export function isProduction(env = process.env) {
  return env.NODE_ENV === "production";
}

function configurationError(problem, fix) {
  return new Error(`${problem} ${fix}`);
}


function exactOrigin(value, variable) {
  if (value === "*") {
    throw configurationError(
      `${variable} cannot contain the wildcard origin '*'.`,
      `Set ${variable} to comma-separated exact dashboard origins such as https://gridgo-dash.talasora.com and restart.`,
    );
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw configurationError(
      `${variable} contains an invalid origin: ${value}.`,
      `Use complete HTTP(S) origins without paths, for example https://gridgo-dash.talasora.com, and restart.`,
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

const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];

/**
 * The API-to-MinIO leg carries bucket credentials over plain HTTP, so it must
 * never be able to leave the host's trust boundary. Exactly two deployment
 * shapes satisfy that:
 *
 *   - host loopback (`http://127.0.0.1:19000`), when the API runs as a host
 *     process against a MinIO container that publishes a loopback-only port;
 *   - a single-label container name (`http://gridgo-minio:9000`), when both run
 *     as containers on a private Docker network that publishes no host port at
 *     all. A hostname with no dot cannot resolve in public DNS, so it can only
 *     ever mean a container on a network this one is already attached to.
 *
 * Anything dotted is a routable name and is refused: that is how a "private"
 * endpoint silently becomes a public one.
 */
function isPrivateStorageHost(hostname) {
  if (LOOPBACK_HOSTNAMES.includes(hostname)) return true;
  return /^[a-z0-9][a-z0-9-]*$/i.test(hostname);
}

function requireStorageOrigin(env, variable, { httpsOnly, privateOnly = false }) {
  const value = requireValue(
    env,
    variable,
    httpsOnly ? "the public HTTPS object-storage origin" : "the private API-to-MinIO HTTP(S) origin",
  );
  const origin = exactOrigin(value, variable);
  const hostname = new URL(origin).hostname;
  if (privateOnly && !isPrivateStorageHost(hostname)) {
    throw configurationError(
      `${variable} must stay on a private API-to-MinIO leg in production; received ${origin}.`,
      `Set ${variable} to a loopback origin such as http://127.0.0.1:19000, or to the MinIO container name on the API's private Docker network such as http://gridgo-minio:9000, and restart.`,
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
      "Set CORS_ALLOWED_ORIGINS to the exact dashboard origin, for example https://gridgo-dash.talasora.com, and restart.",
    );
  }
  requireStorageOrigin(env, "MINIO_ENDPOINT", { httpsOnly: false, privateOnly: true });
  requireStorageOrigin(env, "MINIO_PUBLIC_URL", { httpsOnly: true });
  requireValue(env, "MINIO_ACCESS_KEY", "the bucket-scoped MinIO API access key");
  requireValue(env, "MINIO_SECRET_KEY", "the bucket-scoped MinIO API secret key");
}
