import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as seed from "../src/seed-dev.js";

test("development seed CLI refuses production before requiring a database", () => {
  for (const [mode, key] of [
    ["production", "sk_test_fixture"],
    ["development", "sk_live_fixture"],
    ["", "sk_test_fixture"],
    ["development", ""],
  ]) {
    const result = spawnSync(process.execPath, ["src/seed-dev.js"], {
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: mode, CLERK_SECRET_KEY: key, DATABASE_URL: "" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /development_seed_not_allowed/);
    assert.doesNotMatch(result.stderr, /DATABASE_URL is required/);
  }
});

test("direct development seed entry points refuse production before side effects", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    for (const name of [
      "seedDevelopmentShops", "seedDevelopmentShop", "seedDevelopmentRider",
      "seedDevelopmentPrivilegedAccounts", "resolveDevClerkUser",
    ]) {
      await assert.rejects(seed[name]({}), /development_seed_not_allowed/, name);
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
