import { Client } from "minio";

const DEFAULTS = {
  endpoint: "http://127.0.0.1:9000",
  publicUrl: "http://127.0.0.1:9000",
  accessKey: "gridgo_api_7f3a91c2",
  secretKey: "ggo_api_m1n10_9f41b7c3e68a2d55",
  bucket: "gridgo-uploads",
  region: "us-east-1",
  downloadUrlTtlSeconds: 300,
};

export class StorageUnavailableError extends Error {
  constructor() {
    super(
      "File storage is unavailable because MinIO cannot be reached. Start MinIO with `docker compose up -d --wait` and try again.",
    );
    this.name = "StorageUnavailableError";
    this.status = 503;
    this.code = "minio_unavailable";
  }
}

export class StorageObjectMissingError extends Error {
  constructor() {
    super("The file record is ready, but its MinIO object is missing. Upload the file again and reattach it.");
    this.name = "StorageObjectMissingError";
    this.status = 409;
    this.code = "storage_object_missing";
  }
}

function endpointOptions(value, credentials, region) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || (url.pathname && url.pathname !== "/")) {
    throw new Error("MinIO endpoint must be an http(s) origin without credentials or a path");
  }
  return {
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    useSSL: url.protocol === "https:",
    accessKey: credentials.accessKey,
    secretKey: credentials.secretKey,
    region,
  };
}

function missingObject(error) {
  return ["NoSuchKey", "NotFound", "NoSuchObject"].includes(error?.code || error?.name) || error?.statusCode === 404;
}

export function createObjectStorage(env = process.env, options = {}) {
  const endpoint = env.MINIO_ENDPOINT || DEFAULTS.endpoint;
  const publicUrl = env.MINIO_PUBLIC_URL || DEFAULTS.publicUrl;
  const accessKey = env.MINIO_ACCESS_KEY || DEFAULTS.accessKey;
  const secretKey = env.MINIO_SECRET_KEY || DEFAULTS.secretKey;
  const bucket = env.MINIO_BUCKET || DEFAULTS.bucket;
  const region = env.MINIO_REGION || DEFAULTS.region;
  const ttlSeconds = Number(env.MINIO_DOWNLOAD_URL_TTL_SECONDS || DEFAULTS.downloadUrlTtlSeconds);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900) {
    throw new Error("MINIO_DOWNLOAD_URL_TTL_SECONDS must be an integer from 30 through 900");
  }
  const credentials = { accessKey, secretKey };
  const internalClient = options.internalClient || new Client(endpointOptions(endpoint, credentials, region));
  const publicClient = options.publicClient || new Client(endpointOptions(publicUrl, credentials, region));
  let status = "checking";
  let checkedAt = null;

  function mark(next) {
    status = next;
    checkedAt = new Date().toISOString();
  }

  function health() {
    return { provider: "minio", bucket, status, checkedAt };
  }

  async function ensureBucket() {
    try {
      const exists = await internalClient.bucketExists(bucket);
      if (!exists) throw new Error("bucket missing");
      mark("available");
    } catch {
      mark("unavailable");
      throw new StorageUnavailableError();
    }
  }

  async function putObject({ key, body, contentType, size }) {
    try {
      const result = await internalClient.putObject(bucket, key, body, size, { "Content-Type": contentType });
      mark("available");
      return { key, etag: result?.etag || result?.ETag || null };
    } catch {
      mark("unavailable");
      throw new StorageUnavailableError();
    }
  }

  async function statObject(key) {
    try {
      const stat = await internalClient.statObject(bucket, key);
      mark("available");
      return { size: Number(stat.size), etag: stat.etag || null, contentType: stat.metaData?.["content-type"] || null };
    } catch (error) {
      if (missingObject(error)) {
        mark("available");
        throw new StorageObjectMissingError();
      }
      mark("unavailable");
      throw new StorageUnavailableError();
    }
  }

  async function deleteObject(key) {
    try {
      await internalClient.removeObject(bucket, key);
      mark("available");
    } catch (error) {
      if (missingObject(error)) return;
      mark("unavailable");
      throw new StorageUnavailableError();
    }
  }

  async function getObject(key) {
    try {
      const stream = await internalClient.getObject(bucket, key);
      mark("available");
      return stream;
    } catch (error) {
      if (missingObject(error)) {
        mark("available");
        throw new StorageObjectMissingError();
      }
      mark("unavailable");
      throw new StorageUnavailableError();
    }
  }

  async function presignGet(key) {
    try {
      // Signing must happen against the device-visible origin. Rewriting this URL later invalidates SigV4.
      const url = await publicClient.presignedGetObject(bucket, key, ttlSeconds);
      mark("available");
      return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(), expiresInSeconds: ttlSeconds };
    } catch {
      mark("unavailable");
      throw new StorageUnavailableError();
    }
  }

  return { ensureBucket, putObject, statObject, deleteObject, getObject, presignGet, health };
}
