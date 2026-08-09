// Real-DB tests against local CockroachDB (CLAUDE.md rule 7). Bedrock is
// mocked via ENGRAM_FAKE_BEDROCK=1 (set in .env) - zero AWS access required.
// Each test creates its own unique scope_id so parallel runs stay isolated.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closePool, getPool } from "../src/db.js";
import { embed } from "../src/embeddings.js";
import { getMemory, rememberMemory, recallMemories } from "../src/store/memories.js";
import { getRecall } from "../src/store/provenance.js";
import { newUlid } from "../src/ulid.js";

after(async () => {
  await closePool();
});

test("planted needle is recalled top-1 for a matching query", async () => {
  const scopeId = newUlid();
  const needle = await rememberMemory({ scopeId, content: "the user's favourite colour is teal" });

  const decoyTopics = [
    "quarterly revenue increased by ten percent this year",
    "the server rack fan is rattling loudly again",
    "database migration completed successfully overnight",
    "flight departs from gate twenty two at noon",
    "compiling the project takes about ninety seconds",
    "the printer ran out of toner this morning",
  ];
  for (let i = 0; i < 30; i++) {
    await rememberMemory({ scopeId, content: `${decoyTopics[i % decoyTopics.length]} (batch ${i})` });
  }

  const { memories } = await recallMemories({ scopeId, query: "what colour does the user like", k: 8 });
  assert.ok(memories.length > 0, "expected at least one result");
  assert.equal(memories[0].memoryId, needle.memoryId, "expected the planted needle to rank first");
});

test("recall reinforces returned memories: retrieval_count +1, strength up, retrieve_boost version row", async () => {
  const scopeId = newUlid();
  const mem = await rememberMemory({ scopeId, content: "reinforcement probe memory about kites" });
  const before = await getMemory(scopeId, mem.memoryId);
  assert.ok(before);

  const { memories } = await recallMemories({ scopeId, query: "kites", k: 8 });
  assert.equal(memories.length, 1);
  const after1 = memories[0];
  assert.equal(after1.memoryId, mem.memoryId);
  assert.equal(after1.retrievalCount, before!.retrievalCount + 1, "retrieval_count should go up by exactly 1");
  assert.ok(after1.strength > before!.strength, `expected strength to increase, before=${before!.strength} after=${after1.strength}`);

  const pool = getPool();
  const versionRows = await pool.query(
    "SELECT * FROM memory_versions WHERE scope_id = $1 AND memory_id = $2 AND op = 'retrieve_boost'",
    [scopeId, mem.memoryId]
  );
  assert.equal(versionRows.rows.length, 1, "expected exactly 1 retrieve_boost version row");
});

test("recall reinforces every returned memory, not just the top hit", async () => {
  const scopeId = newUlid();
  const memA = await rememberMemory({ scopeId, content: "harbour probe alpha about boats" });
  const memB = await rememberMemory({ scopeId, content: "harbour probe beta about boats" });

  const { memories } = await recallMemories({ scopeId, query: "boats in the harbour", k: 8 });
  assert.equal(memories.length, 2);

  const pool = getPool();
  for (const mem of [memA, memB]) {
    const versionRows = await pool.query(
      "SELECT * FROM memory_versions WHERE scope_id = $1 AND memory_id = $2 AND op = 'retrieve_boost'",
      [scopeId, mem.memoryId]
    );
    assert.equal(versionRows.rows.length, 1, `expected a retrieve_boost row for ${mem.memoryId}`);
  }
});

test("recall_log row is written and its results match the returned memory set exactly", async () => {
  const scopeId = newUlid();
  await rememberMemory({ scopeId, content: "log probe alpha about rivers" });
  await rememberMemory({ scopeId, content: "log probe beta about rivers" });

  const { recallId, memories } = await recallMemories({ scopeId, query: "rivers", k: 8 });
  const recall = await getRecall(scopeId, recallId);
  assert.ok(recall, "expected a recall_log row for the returned recallId");
  assert.equal(recall!.scopeId, scopeId);
  assert.equal(recall!.queryText, "rivers");
  assert.equal(recall!.results.length, memories.length);

  const returnedIds = memories.map((m) => m.memoryId).sort();
  const loggedIds = recall!.results.map((r) => r.memoryId).sort();
  assert.deepEqual(loggedIds, returnedIds, "recall_log results must match the returned memory set exactly");
});

test("consolidated memories are never returned by recall", async () => {
  const scopeId = newUlid();
  const mem = await rememberMemory({ scopeId, content: "soon to be consolidated memory about badgers" });
  // Test fixture only: force status directly to verify the recall query's
  // filter behavior in isolation from the consolidation feature (Step 11).
  // Production code never mutates memories outside src/store/memories.ts.
  await getPool().query("UPDATE memories SET status = 'consolidated' WHERE scope_id = $1 AND memory_id = $2", [
    scopeId,
    mem.memoryId,
  ]);

  const { memories } = await recallMemories({ scopeId, query: "badgers", k: 8 });
  assert.ok(
    !memories.some((m) => m.memoryId === mem.memoryId),
    "consolidated memories must never be returned by recall"
  );
});

test("recall SQL EXPLAIN at ~300 rows: logs whether the vector index survives the status filter", async () => {
  // Interleaved across 2 scopes (same pattern as tests/memories.test.ts's
  // EXPLAIN test): CRDB's vector index maintains per-partition metadata, and
  // 300 *sequential* single-row transactions all hitting one scope's
  // partition back-to-back hit real write-contention retries
  // (WriteTooOldError) on this local single-node cluster - reproduced twice
  // while developing this test. Interleaving spreads writes across two
  // partitions and matches the already-passing established pattern; total
  // table size (~300 rows) is what the planner's row-count decision cares
  // about, not rows-per-scope.
  const scopeId = newUlid();
  const otherScopeId = newUlid();
  const rowsPerScope = 150;
  for (let i = 0; i < rowsPerScope; i++) {
    await rememberMemory({ scopeId, content: `bulk recall memory ${i} about topic ${i % 13}` });
    await rememberMemory({ scopeId: otherScopeId, content: `other scope memory ${i} about topic ${i % 13}` });
  }

  const pool = getPool();
  await pool.query("ANALYZE memories");

  const queryEmbedding = await embed("bulk recall memory 75 about topic 7");
  const queryVector = `[${queryEmbedding.join(",")}]`;

  const plan = await pool.query<{ info: string }>(
    `EXPLAIN SELECT memory_id FROM memories WHERE scope_id = $1 AND status = 'active'
     ORDER BY embedding <-> $2::vector LIMIT $3`,
    [scopeId, queryVector, 24]
  );
  const planText = plan.rows.map((row) => row.info).join("\n");
  const usesVectorIndex = /memories_scope_embedding_idx|vector/i.test(planText);
  // recallMemories' real SQL shape adds `status = 'active'` on top of the
  // (scope_id, embedding) index prefix - this may change planner behavior
  // vs the scope_id-only shape tested in tests/memories.test.ts. LOGGED per
  // house rule, not asserted; correctness of recallMemories itself is
  // asserted in the other tests in this file.
  console.log(`[EXPLAIN recall shape @ ${rowsPerScope * 2} rows] plan mentions vector index: ${usesVectorIndex}`);
  console.log(planText);
});
