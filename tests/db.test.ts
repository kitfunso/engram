// Pure control-flow tests for withTransientRetry (no real DB access needed -
// the function under test is DB-agnostic retry logic; feeding it a fake
// throwing closure tests OUR retry contract, not a mocked SQL result, so
// this stays inside CLAUDE.md rule 7's "no mocked SQL" boundary). Real-DB
// coverage of the store-level callers (rememberMemory, recallMemories,
// sleepScope) already exercises the success path end-to-end in the other
// test files; this file covers the retry/reconnect contract itself, which
// those tests can't exercise deterministically (a real dropped connection
// isn't reproducible on demand against local CockroachDB).

import assert from "node:assert/strict";
import { test } from "node:test";
import { withTransientRetry } from "../src/db.js";

test("withTransientRetry retries a connection-drop error and succeeds once the operation recovers", async () => {
  let attempts = 0;
  const result = await withTransientRetry(async () => {
    attempts++;
    if (attempts < 3) {
      throw new Error("Connection terminated unexpectedly");
    }
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(attempts, 3, "expected 2 failed attempts then a 3rd success - each a fresh call to fn()");
});

test("withTransientRetry classifies an ECONNRESET-worded error as transient and retries", async () => {
  let attempts = 0;
  const result = await withTransientRetry(async () => {
    attempts++;
    if (attempts < 2) {
      const err = new Error("read ECONNRESET");
      throw err;
    }
    return "recovered";
  });
  assert.equal(result, "recovered");
  assert.equal(attempts, 2);
});

test("withTransientRetry classifies a 'server closed the connection' error as transient and retries", async () => {
  let attempts = 0;
  const result = await withTransientRetry(async () => {
    attempts++;
    if (attempts < 2) {
      throw new Error("server closed the connection unexpectedly");
    }
    return "recovered";
  });
  assert.equal(result, "recovered");
  assert.equal(attempts, 2);
});

test("withTransientRetry does not retry a non-transient error", async () => {
  let attempts = 0;
  await assert.rejects(
    withTransientRetry(async () => {
      attempts++;
      throw new Error("some unrelated permanent failure");
    }),
    /unrelated permanent failure/
  );
  assert.equal(attempts, 1, "a non-transient error must not be retried");
});

test("withTransientRetry gives up after MAX_ATTEMPTS and rethrows the last transient error", async () => {
  let attempts = 0;
  await assert.rejects(
    withTransientRetry(async () => {
      attempts++;
      throw new Error("restart transaction: always fails");
    }),
    /restart transaction/
  );
  assert.equal(attempts, 4, "expected exactly MAX_ATTEMPTS (4) attempts before giving up");
});
