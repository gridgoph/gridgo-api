import test from "node:test";
import assert from "node:assert/strict";

import {
  StorageObjectMissingError,
  StorageUnavailableError,
  createObjectStorage,
} from "../src/object-storage.js";

const env = {
  MINIO_ENDPOINT: "http://127.0.0.1:19000",
  MINIO_PUBLIC_URL: "http://192.168.1.50:19000",
  MINIO_ACCESS_KEY: "gridgo-api",
  MINIO_SECRET_KEY: "gridgo-api-dev-only",
  MINIO_BUCKET: "gridgo-test",
  MINIO_REGION: "us-east-1",
  MINIO_DOWNLOAD_URL_TTL_SECONDS: "300",
};

function clients(overrides = {}) {
  return {
    internalClient: {
      bucketExists: async () => true,
      putObject: async () => ({ etag: "abc123" }),
      statObject: async () => ({ size: 3, etag: "abc123", metaData: { "content-type": "application/pdf" } }),
      removeObject: async () => {},
      ...overrides.internalClient,
    },
    publicClient: {
      presignedGetObject: async () => "http://192.168.1.50:19000/gridgo-test/key?X-Amz-Signature=signed",
      ...overrides.publicClient,
    },
  };
}

test("reports available only when the init-created bucket exists", async () => {
  const storage = createObjectStorage(env, clients());
  await storage.ensureBucket();
  assert.equal(storage.health().status, "available");
  assert.equal(storage.health().bucket, "gridgo-test");
});

test("normalizes connection or missing-bucket failures without leaking the SDK exception", async () => {
  const storage = createObjectStorage(
    env,
    clients({ internalClient: { bucketExists: async () => { throw new Error("ECONNREFUSED secret host"); } } }),
  );
  await assert.rejects(storage.ensureBucket(), (error) => {
    assert.equal(error instanceof StorageUnavailableError, true);
    assert.equal(error.code, "minio_unavailable");
    assert.doesNotMatch(error.message, /secret host/);
    return true;
  });
});

test("streams a stored object for unauthenticated announcement picture fetches", async () => {
  const stream = { pipe() {} };
  const storage = createObjectStorage(
    env,
    clients({ internalClient: { getObject: async (bucket, key) => {
      assert.equal(bucket, "gridgo-test");
      assert.equal(key, "announcement_image/pic.jpg");
      return stream;
    } } }),
  );
  assert.equal(await storage.getObject("announcement_image/pic.jpg"), stream);

  const missing = createObjectStorage(
    env,
    clients({ internalClient: { getObject: async () => { const error = new Error("missing"); error.code = "NoSuchKey"; throw error; } } }),
  );
  await assert.rejects(missing.getObject("missing"), StorageObjectMissingError);
});

test("streams puts, stats objects, and maps missing objects specifically", async () => {
  const storage = createObjectStorage(env, clients());
  assert.deepEqual(
    await storage.putObject({ key: "key", body: Buffer.from("pdf"), contentType: "application/pdf", size: 3 }),
    { key: "key", etag: "abc123" },
  );
  assert.deepEqual(await storage.statObject("key"), {
    size: 3,
    etag: "abc123",
    contentType: "application/pdf",
  });

  const missing = createObjectStorage(
    env,
    clients({ internalClient: { statObject: async () => { const error = new Error("missing"); error.code = "NoSuchKey"; throw error; } } }),
  );
  await assert.rejects(missing.statObject("key"), StorageObjectMissingError);
});

test("presigns against the configured phone-visible client and never rewrites the URL", async () => {
  const calls = [];
  const storage = createObjectStorage(
    env,
    clients({ publicClient: { presignedGetObject: async (...args) => { calls.push(args); return "http://192.168.1.50:19000/exact?signed=yes"; } } }),
  );
  const result = await storage.presignGet("artwork/key.pdf");
  assert.equal(result.url, "http://192.168.1.50:19000/exact?signed=yes");
  assert.equal(result.expiresInSeconds, 300);
  assert.deepEqual(calls, [["gridgo-test", "artwork/key.pdf", 300]]);
});

test("deletes through the internal endpoint client", async () => {
  const removed = [];
  const storage = createObjectStorage(
    env,
    clients({ internalClient: { removeObject: async (...args) => removed.push(args) } }),
  );
  await storage.deleteObject("service_image/key.jpg");
  assert.deepEqual(removed, [["gridgo-test", "service_image/key.jpg"]]);
});

test("rejects unsafe presign TTL configuration", () => {
  assert.throws(
    () => createObjectStorage({ ...env, MINIO_DOWNLOAD_URL_TTL_SECONDS: "3600" }, clients()),
    /30 through 900/,
  );
});
