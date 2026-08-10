// Real-DB tests against local CockroachDB (CLAUDE.md rule 7). Bedrock is
// mocked via ENGRAM_FAKE_BEDROCK=1 (set in .env) - zero AWS access required.
// Each test creates its own unique scope_id so parallel runs stay isolated.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closePool, getPool } from "../src/db.js";
import { embed } from "../src/embeddings.js";
import { consolidateSourceTx, getMemory, reinforceMemoryTx, rememberMemory, strengthAt } from "../src/store/memories.js";
import { newUlid } from "../src/ulid.js";

after(async () => {
  await closePool();
});

test("rememberMemory writes exactly one memories row and one memory_versions row, atomically, with snapshot fidelity", async () => {
  const scopeId = newUlid();
  const memory = await rememberMemory({
    scopeId,
    content: "the cat sat on the mat",
    tags: ["pet"],
  });

  const pool = getPool();
  const memRows = await pool.query("SELECT * FROM memories WHERE scope_id = $1", [scopeId]);
  assert.equal(memRows.rows.length, 1, "expected exactly 1 memories row");

  const versionRows = await pool.query(
    "SELECT * FROM memory_versions WHERE scope_id = $1 AND memory_id = $2",
    [scopeId, memory.memoryId]
  );
  assert.equal(versionRows.rows.length, 1, "expected exactly 1 memory_versions row");
  assert.equal(versionRows.rows[0].op, "insert");
  assert.equal(versionRows.rows[0].actor, "store");

  const snapshot = versionRows.rows[0].snapshot;
  assert.equal(snapshot.scopeId, scopeId);
  assert.equal(snapshot.memoryId, memory.memoryId);
  assert.equal(snapshot.content, "the cat sat on the mat");
  assert.deepEqual(snapshot.tags, ["pet"]);
  assert.equal(snapshot.status, "active");
  assert.equal(snapshot.layer, "episodic");
  assert.equal(snapshot.strength, 1.0);

  const fetched = await getMemory(scopeId, memory.memoryId);
  assert.ok(fetched, "getMemory should find the row just written");
  assert.equal(fetched?.content, "the cat sat on the mat");
  assert.equal(fetched?.embedding.length, 1024, "embedding must be 1024-dim");
  assert.equal(fetched?.strength, 1.0);
  assert.equal(fetched?.halfLifeDays, 30);
  assert.equal(fetched?.retrievalCount, 0);
});

test("reinforceMemoryTx returns null and writes no version row for a non-active memory", async () => {
  const scopeId = newUlid();
  const target = await rememberMemory({ scopeId, content: "consolidation target for reinforce guard test" });
  const mem = await rememberMemory({ scopeId, content: "already-consolidated memory about kestrels" });

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await consolidateSourceTx(client, { scopeId, memoryId: mem.memoryId, consolidatedInto: target.memoryId });
    await client.query("COMMIT");

    await client.query("BEGIN");
    const result = await reinforceMemoryTx(client, { scopeId, memoryId: mem.memoryId, now: new Date() });
    await client.query("COMMIT");
    assert.equal(result, null, "reinforcing a non-active memory must return null, not throw or fabricate a row");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const versionRows = await pool.query(
    "SELECT * FROM memory_versions WHERE scope_id = $1 AND memory_id = $2 AND op = 'retrieve_boost'",
    [scopeId, mem.memoryId]
  );
  assert.equal(versionRows.rows.length, 0, "a no-op reinforce must not write a retrieve_boost version row");
});

test("consolidateSourceTx throws when the source memory is not active", async () => {
  const scopeId = newUlid();
  const target = await rememberMemory({ scopeId, content: "consolidation target for consolidate guard test" });
  const mem = await rememberMemory({ scopeId, content: "already-consolidated memory about otters" });

  const pool = getPool();
  const firstClient = await pool.connect();
  try {
    await firstClient.query("BEGIN");
    await consolidateSourceTx(firstClient, { scopeId, memoryId: mem.memoryId, consolidatedInto: target.memoryId });
    await firstClient.query("COMMIT");
  } catch (err) {
    await firstClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    firstClient.release();
  }

  const secondClient = await pool.connect();
  try {
    await secondClient.query("BEGIN");
    await assert.rejects(
      consolidateSourceTx(secondClient, { scopeId, memoryId: mem.memoryId, consolidatedInto: target.memoryId }),
      /is not active/,
      "consolidating an already-consolidated memory must throw, not silently write a version row off no matched rows"
    );
    await secondClient.query("ROLLBACK");
  } finally {
    secondClient.release();
  }
});

test("strengthAt matches hand-computed exponential decay values", () => {
  const lastRetrievedAt = new Date("2026-01-01T00:00:00.000Z");
  const memory = { strength: 1.0, halfLifeDays: 30, lastRetrievedAt };

  // t=0: no elapsed time, no decay.
  assert.equal(strengthAt(memory, lastRetrievedAt), 1.0);

  // one half-life later: strength should halve.
  const oneHalfLife = new Date(lastRetrievedAt.getTime() + 30 * 86_400_000);
  assert.ok(
    Math.abs(strengthAt(memory, oneHalfLife) - 0.5) < 1e-9,
    `expected ~0.5, got ${strengthAt(memory, oneHalfLife)}`
  );

  // two half-lives later: strength should quarter.
  const twoHalfLives = new Date(lastRetrievedAt.getTime() + 60 * 86_400_000);
  assert.ok(
    Math.abs(strengthAt(memory, twoHalfLives) - 0.25) < 1e-9,
    `expected ~0.25, got ${strengthAt(memory, twoHalfLives)}`
  );
});

test("two scopes with identical content stay isolated", async () => {
  const scopeA = newUlid();
  const scopeB = newUlid();
  const content = "duplicate content across scopes";

  const memA = await rememberMemory({ scopeId: scopeA, content });
  const memB = await rememberMemory({ scopeId: scopeB, content });

  const pool = getPool();
  const rowsA = await pool.query("SELECT memory_id FROM memories WHERE scope_id = $1", [scopeA]);
  assert.equal(rowsA.rows.length, 1);
  assert.equal(rowsA.rows[0].memory_id, memA.memoryId);

  const rowsB = await pool.query("SELECT memory_id FROM memories WHERE scope_id = $1", [scopeB]);
  assert.equal(rowsB.rows.length, 1);
  assert.equal(rowsB.rows[0].memory_id, memB.memoryId);

  // Composite-PK filter, not just distinct memory_ids: scope A must never
  // resolve scope B's memory_id, and vice versa.
  assert.equal(await getMemory(scopeA, memB.memoryId), null);
  assert.equal(await getMemory(scopeB, memA.memoryId), null);
});

test("fake embeddings preserve similarity structure (L2 distance)", async () => {
  const a = await embed("the cat sat on the mat");
  const b = await embed("a cat sat on a mat");
  const c = await embed("quarterly financial derivatives report");

  assert.equal(a.length, 1024);
  assert.equal(b.length, 1024);
  assert.equal(c.length, 1024);

  const l2 = (x: number[], y: number[]): number =>
    Math.sqrt(x.reduce((sum, xi, i) => sum + (xi - y[i]) ** 2, 0));

  const distAB = l2(a, b);
  const distAC = l2(a, c);
  assert.ok(distAB < distAC, `expected dist(a,b)=${distAB} < dist(a,c)=${distAC}`);
});

test("scoped ANN query is correct at ~300 rows across 2 scopes; logs whether the planner uses the vector index", async () => {
  const scopeA = newUlid();
  const scopeB = newUlid();
  const rowsPerScope = 150;

  for (let i = 0; i < rowsPerScope; i++) {
    await rememberMemory({ scopeId: scopeA, content: `scope A memory number ${i} about topic ${i % 11}` });
    await rememberMemory({ scopeId: scopeB, content: `scope B memory number ${i} about topic ${i % 11}` });
  }

  const pool = getPool();
  await pool.query("ANALYZE memories");

  const queryEmbedding = await embed("scope A memory number 42 about topic 9");
  const queryVector = `[${queryEmbedding.join(",")}]`;

  const result = await pool.query<{ memory_id: string }>(
    "SELECT memory_id FROM memories WHERE scope_id = $1 ORDER BY embedding <-> $2::vector LIMIT 5",
    [scopeA, queryVector]
  );
  assert.equal(result.rows.length, 5, "ANN query should return k=5 rows");

  const scopeBRows = await pool.query<{ memory_id: string }>("SELECT memory_id FROM memories WHERE scope_id = $1", [
    scopeB,
  ]);
  const scopeBIds = new Set(scopeBRows.rows.map((r) => r.memory_id));
  for (const row of result.rows) {
    assert.ok(!scopeBIds.has(row.memory_id), "scoped ANN query must never return the other scope's rows");
  }

  const plan = await pool.query<{ info: string }>(
    "EXPLAIN SELECT memory_id FROM memories WHERE scope_id = $1 ORDER BY embedding <-> $2::vector LIMIT 5",
    [scopeA, queryVector]
  );
  const planText = plan.rows.map((row) => row.info).join("\n");
  const usesVectorIndex = /memories_scope_embedding_idx|vector/i.test(planText);
  // Per the Step 4 spike finding, the planner may still choose a full scan
  // at small n - this is LOGGED, not asserted. Only query correctness (right
  // k, right scope, no cross-scope leakage) is asserted above.
  console.log(`[EXPLAIN @ ~${rowsPerScope * 2} rows] plan mentions vector index: ${usesVectorIndex}`);
  console.log(planText);
});
