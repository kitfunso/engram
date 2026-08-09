// Real-DB tests against local CockroachDB (CLAUDE.md rule 7). Bedrock is
// mocked via ENGRAM_FAKE_BEDROCK=1 (set in .env) - zero AWS access required.
// Each test creates its own unique scope_id so parallel runs stay isolated.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closePool, getPool } from "../src/db.js";
import { consolidateSourceTx, recallMemories, rememberMemory } from "../src/store/memories.js";
import { isPastWindowError, recallAsOf } from "../src/store/timetravel.js";
import { newUlid } from "../src/ulid.js";

after(async () => {
  await closePool();
});

/** DB-clock "now", so test timestamps compare against the same clock as
 * memory_versions.at (avoids any host/DB clock-skew flakiness). */
async function dbNow(): Promise<Date> {
  const result = await getPool().query<{ now: Date }>("SELECT now() AS now");
  return result.rows[0].now;
}

test("recallAsOf (forceReplay) reconstructs 3 historical states: insert, retrieve_boost, consolidate", async () => {
  const scopeId = newUlid();
  const mem = await rememberMemory({ scopeId, content: "timetravel probe memory about lighthouses" });
  const t1 = await dbNow();

  await recallMemories({ scopeId, query: "lighthouses", k: 8 }); // writes an op=retrieve_boost version
  const t2 = await dbNow();

  const consolidationTarget = await rememberMemory({ scopeId, content: "placeholder consolidation target" });
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await consolidateSourceTx(client, { scopeId, memoryId: mem.memoryId, consolidatedInto: consolidationTarget.memoryId });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const t3 = await dbNow();

  const atT1 = await recallAsOf({ scopeId, at: t1, forceReplay: true });
  assert.equal(atT1.usedReplay, true);
  const foundAtT1 = atT1.memories.find((m) => m.memoryId === mem.memoryId);
  assert.ok(foundAtT1, "memory should exist and be active at T1 (right after insert)");
  assert.equal(foundAtT1?.retrievalCount, 0);
  assert.equal(foundAtT1?.status, "active");

  const atT2 = await recallAsOf({ scopeId, at: t2, forceReplay: true });
  const foundAtT2 = atT2.memories.find((m) => m.memoryId === mem.memoryId);
  assert.ok(foundAtT2, "memory should still be active at T2 (right after retrieve_boost)");
  assert.equal(foundAtT2?.retrievalCount, 1);
  assert.equal(foundAtT2?.status, "active");

  const atT3 = await recallAsOf({ scopeId, at: t3, forceReplay: true });
  const foundAtT3 = atT3.memories.find((m) => m.memoryId === mem.memoryId);
  assert.equal(foundAtT3, undefined, "consolidated memory must be excluded from active-at-T3 results");
});

test("recallAsOf fast path (AOST) returns correct recent state when in-window", async () => {
  const scopeId = newUlid();
  const mem = await rememberMemory({ scopeId, content: "aost fast path probe about kestrels" });
  const at = await dbNow(); // a moment after the insert commits; well within AOST_SAFE_WINDOW_MS

  const result = await recallAsOf({ scopeId, query: "kestrels", at });
  assert.equal(result.usedReplay, false, "expected the fast AOST path for a just-committed, in-window T");
  const found = result.memories.find((m) => m.memoryId === mem.memoryId);
  assert.ok(found, "expected the memory to be found via the fast path");
  assert.equal(found?.content, "aost fast path probe about kestrels");
  assert.equal(found?.status, "active");
});

test("recallAsOf falls back to replay (not a throw) when T predates the database's own history", async () => {
  const scopeId = newUlid();
  const mem = await rememberMemory({ scopeId, content: "error-class fallback probe about otters" });

  const farPast = new Date(Date.now() - 1000 * 60 * 60 * 24 * 400); // ~400 days ago
  const result = await recallAsOf({ scopeId, query: "otters", at: farPast });
  assert.equal(result.usedReplay, true, "expected replay for a T far outside AOST_SAFE_WINDOW_MS");
  // The memory did not exist 400 days ago - this asserts no throw, not presence.
  assert.ok(!result.memories.some((m) => m.memoryId === mem.memoryId));
});

test("isPastWindowError classifies both documented past-window error message classes", () => {
  assert.equal(isPastWindowError(new Error("must be after replica GC threshold")), true);
  assert.equal(isPastWindowError(new Error('database "engram" does not exist')), true);
  assert.equal(isPastWindowError(new Error("connection refused")), false);
  assert.equal(isPastWindowError("plain string, not an Error, unrelated"), false);
});
