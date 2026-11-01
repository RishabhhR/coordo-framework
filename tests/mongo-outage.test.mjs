import assert from "node:assert/strict";
import { test } from "node:test";
import { simulateMongoOutage } from "../scripts/simulate-mongo-outage.mjs";

test("one million Mongo-down requests fail fast without network attempts", () => {
  const result = simulateMongoOutage({ requestsPerSecond: 1_000_000, seconds: 1 });
  assert.equal(result.logicalRequests, 1_000_000);
  assert.equal(result.rejected, 1_000_000);
  assert.equal(result.accepted, 0);
  assert.equal(result.networkAttempts, 0);
  assert.equal(result.failFast, true);
});
