import test from "node:test";
import assert from "node:assert/strict";

import { createMutationQueue } from "../src/mutation-queue.js";

test("serializes JSON-store mutations while allowing preparation before commit", async () => {
  const enqueue = createMutationQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = enqueue(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
    return "first-result";
  });
  const second = enqueue(async () => {
    events.push("second:start");
    events.push("second:end");
    return "second-result";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first-result", "second-result"]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("continues processing after a failed mutation", async () => {
  const enqueue = createMutationQueue();
  await assert.rejects(enqueue(async () => Promise.reject(new Error("write failed"))), /write failed/);
  await assert.doesNotReject(enqueue(async () => "next write"));
});
