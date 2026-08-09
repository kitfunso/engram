// Real-DB tests against local CockroachDB (CLAUDE.md rule 7). Bedrock is
// mocked via ENGRAM_FAKE_BEDROCK=1 (set in .env) - zero AWS access required.
// Each test creates its own unique scope_id so parallel runs stay isolated.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closePool, getPool } from "../src/db.js";
import { getMemory, recallMemories, rememberMemory } from "../src/store/memories.js";
import { sleepScope } from "../src/store/consolidate.js";
import { newUlid } from "../src/ulid.js";

after(async () => {
  await closePool();
});

// These tests run on the shipped DEFAULT_SIMILARITY_THRESHOLD (0.85,
// calibrated 2026-08-10 against measured distances in both embedding modes -
// see consolidate.ts). Under the FAKE trigram embedding the 3 near-identical
// budget-meeting variants sit ~0.33-0.42 L2 apart (well inside 0.85) and the
// unrelated sentence sits ~1.33 away (well outside), so the fixture
// exercises the production default directly with clean separation.

test("sleepScope consolidates 3 near-identical episodics into 1 semantic memory, leaves the unrelated one active", async () => {
  const scopeId = newUlid();
  const budget1 = await rememberMemory({ scopeId, content: "meeting with Dana about the Q3 budget" });
  const budget2 = await rememberMemory({ scopeId, content: "meeting with Dana about the Q3 budget numbers" });
  const budget3 = await rememberMemory({ scopeId, content: "meeting with Dana about the Q3 budget plan" });
  const unrelated = await rememberMemory({ scopeId, content: "the server rack fan is rattling" });

  const result = await sleepScope({ scopeId });
  assert.equal(result.clusters, 1, "expected exactly 1 cluster to qualify");
  assert.equal(result.consolidated, 3, "expected exactly 3 sources consolidated");
  assert.equal(result.created.length, 1, "expected exactly 1 new semantic memory");
  const semanticId = result.created[0];

  const semantic = await getMemory(scopeId, semanticId);
  assert.ok(semantic);
  assert.equal(semantic?.layer, "semantic");
  assert.equal(semantic?.origin, "consolidation");
  assert.equal(semantic?.status, "active");
  assert.ok(semantic?.content.startsWith("Consolidated memory (n=3):"), `unexpected content: ${semantic?.content}`);

  for (const source of [budget1, budget2, budget3]) {
    const updated = await getMemory(scopeId, source.memoryId);
    assert.equal(updated?.status, "consolidated", `expected ${source.memoryId} to be consolidated`);
    assert.equal(
      updated?.consolidatedInto,
      semanticId,
      `expected ${source.memoryId}'s consolidated_into to point at the new semantic memory`
    );
  }

  const stillActiveUnrelated = await getMemory(scopeId, unrelated.memoryId);
  assert.equal(stillActiveUnrelated?.status, "active", "the unrelated memory must stay untouched");
  assert.equal(stillActiveUnrelated?.layer, "episodic");
});

test("sleepScope lineage: source memory_versions rows record op='consolidate', new memory records op='insert'", async () => {
  const scopeId = newUlid();
  const src1 = await rememberMemory({ scopeId, content: "meeting with Dana about the Q3 budget" });
  const src2 = await rememberMemory({ scopeId, content: "meeting with Dana about the Q3 budget numbers" });
  await rememberMemory({ scopeId, content: "the server rack fan is rattling" });

  const result = await sleepScope({ scopeId });
  const semanticId = result.created[0];

  const pool = getPool();
  for (const src of [src1, src2]) {
    const versionRows = await pool.query(
      "SELECT * FROM memory_versions WHERE scope_id = $1 AND memory_id = $2 AND op = 'consolidate'",
      [scopeId, src.memoryId]
    );
    assert.equal(versionRows.rows.length, 1, `expected exactly 1 consolidate version row for ${src.memoryId}`);
    assert.equal(versionRows.rows[0].snapshot.consolidatedInto, semanticId);
    assert.equal(versionRows.rows[0].snapshot.status, "consolidated");
  }

  const semanticVersionRows = await pool.query(
    "SELECT * FROM memory_versions WHERE scope_id = $1 AND memory_id = $2 AND op = 'insert'",
    [scopeId, semanticId]
  );
  assert.equal(semanticVersionRows.rows.length, 1, "expected exactly 1 insert version row for the new semantic memory");
});

test("recall no longer returns consolidated sources, but does return the semantic memory for a matching query", async () => {
  const scopeId = newUlid();
  await rememberMemory({ scopeId, content: "meeting with Dana about the Q3 budget" });
  await rememberMemory({ scopeId, content: "meeting with Dana about the Q3 budget numbers" });
  await rememberMemory({ scopeId, content: "meeting with Dana about the Q3 budget plan" });

  const beforeSourceIds = (
    await getPool().query<{ memory_id: string }>("SELECT memory_id FROM memories WHERE scope_id = $1", [scopeId])
  ).rows.map((r) => r.memory_id);

  const result = await sleepScope({ scopeId });
  const semanticId = result.created[0];

  const { memories } = await recallMemories({ scopeId, query: "budget meeting with Dana", k: 8 });
  const returnedIds = memories.map((m) => m.memoryId);

  for (const sourceId of beforeSourceIds) {
    assert.ok(!returnedIds.includes(sourceId), `recall must not return consolidated source ${sourceId}`);
  }
  assert.ok(returnedIds.includes(semanticId), "recall must return the new semantic memory for a matching query");
});

test("sleepScope is idempotent: running it again consolidates nothing further", async () => {
  const scopeId = newUlid();
  await rememberMemory({ scopeId, content: "meeting with Dana about the Q3 budget" });
  await rememberMemory({ scopeId, content: "meeting with Dana about the Q3 budget numbers" });
  await rememberMemory({ scopeId, content: "meeting with Dana about the Q3 budget plan" });
  await rememberMemory({ scopeId, content: "the server rack fan is rattling" });

  const first = await sleepScope({ scopeId });
  assert.equal(first.clusters, 1);
  assert.equal(first.consolidated, 3);

  const second = await sleepScope({ scopeId });
  assert.equal(second.clusters, 0, "a second run should find no qualifying clusters");
  assert.equal(second.consolidated, 0);
  assert.equal(second.created.length, 0);
});
