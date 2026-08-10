// THE single write path to `memories` (CLAUDE.md rule 1): every mutation
// writes a memories row and a memory_versions row in the same transaction.
// Nothing outside src/store/** may issue SQL against these tables
// (docs/ARCHITECTURE.md Service Boundaries). Other store/** modules that
// need to mutate memories (consolidate.ts) do so by calling the tx-scoped
// helpers exported here (insertMemoryTx, consolidateSourceTx) on their own
// client/transaction, so the write SQL itself still lives only in this file.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPool, withTransientRetry } from "../db.js";
import { newUlid } from "../ulid.js";
import { embed } from "../embeddings.js";
import { strengthAt } from "./decay.js";

export { strengthAt } from "./decay.js";

export type MemoryLayer = "episodic" | "semantic";
export type MemoryStatus = "active" | "consolidated" | "deleted";

export interface Memory {
  scopeId: string;
  memoryId: string;
  content: string;
  embedding: number[];
  layer: MemoryLayer;
  strength: number;
  halfLifeDays: number;
  retrievalCount: number;
  createdAt: Date;
  lastRetrievedAt: Date;
  origin: string;
  tags: unknown[];
  status: MemoryStatus;
  consolidatedInto: string | null;
}

export interface RememberInput {
  scopeId: string;
  content: string;
  layer?: MemoryLayer;
  tags?: unknown[];
  origin?: string;
}

export interface MemoryRow {
  scope_id: string;
  memory_id: string;
  content: string;
  embedding: string;
  layer: MemoryLayer;
  strength: number;
  half_life_days: number;
  retrieval_count: string | number;
  created_at: Date;
  last_retrieved_at: Date;
  origin: string;
  tags: unknown[];
  status: MemoryStatus;
  consolidated_into: string | null;
}

const DEFAULT_HALF_LIFE_DAYS = 30;

export const MEMORY_COLUMNS = `scope_id, memory_id, content, embedding, layer, strength, half_life_days,
  retrieval_count, created_at, last_retrieved_at, origin, tags, status, consolidated_into`;

// CRDB VECTOR uses pgvector wire format: pass a '[0.1,0.2,...]' string with
// an explicit ::vector cast, not a JS array (CLAUDE.md "Common Mistakes to
// Avoid"). Verified round-trip shape against local CockroachDB directly.
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export function parseVectorLiteral(literal: string): number[] {
  return literal.slice(1, -1).split(",").map(Number);
}

export function rowToMemory(row: MemoryRow): Memory {
  return {
    scopeId: row.scope_id,
    memoryId: row.memory_id,
    content: row.content,
    embedding: parseVectorLiteral(row.embedding),
    layer: row.layer,
    strength: Number(row.strength),
    // retrieval_count is INT8; node-postgres returns bigint columns as JS
    // strings by default to avoid precision loss - coerce explicitly
    // (verified against local DB; the same gotcha broke migrate.ts's
    // idempotency check until fixed there).
    retrievalCount: Number(row.retrieval_count),
    halfLifeDays: Number(row.half_life_days),
    createdAt: row.created_at,
    lastRetrievedAt: row.last_retrieved_at,
    origin: row.origin,
    tags: row.tags,
    status: row.status,
    consolidatedInto: row.consolidated_into,
  };
}

function memorySnapshot(memory: Memory): Record<string, unknown> {
  // Embedding intentionally omitted: 1024 floats duplicated into every
  // version row is wasteful, and no op in this store ever mutates an
  // existing memory's embedding after insert (insertMemoryTx writes it once;
  // reinforceMemoryTx/consolidateSourceTx never touch the column) - so
  // timetravel.ts's replay path can always join the current
  // memories.embedding column for a surviving memory_id and get an exact
  // answer, not an approximation. Revisit if a future op mutates embedding.
  return {
    scopeId: memory.scopeId,
    memoryId: memory.memoryId,
    content: memory.content,
    layer: memory.layer,
    strength: memory.strength,
    halfLifeDays: memory.halfLifeDays,
    retrievalCount: memory.retrievalCount,
    createdAt: memory.createdAt,
    lastRetrievedAt: memory.lastRetrievedAt,
    origin: memory.origin,
    tags: memory.tags,
    status: memory.status,
    consolidatedInto: memory.consolidatedInto,
  };
}

async function writeVersion(client: PoolClient, scopeId: string, memoryId: string, op: string, memory: Memory): Promise<void> {
  const versionId = newUlid();
  await client.query(
    `INSERT INTO memory_versions (scope_id, version_id, memory_id, op, snapshot, actor)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [scopeId, versionId, memoryId, op, JSON.stringify(memorySnapshot(memory)), "store"]
  );
}

export interface InsertMemoryTxInput {
  scopeId: string;
  memoryId: string;
  content: string;
  embedding: number[];
  layer: MemoryLayer;
  tags: unknown[];
  origin: string;
}

/**
 * Inserts a memory row + op='insert' version row on a caller-managed
 * client/transaction. Used by rememberMemory (its own single-mutation
 * transaction) and by consolidate.ts (one transaction per cluster covering
 * this insert plus every source's consolidateSourceTx update).
 */
export async function insertMemoryTx(client: PoolClient, input: InsertMemoryTxInput): Promise<Memory> {
  const { scopeId, memoryId, content, embedding, layer, tags, origin } = input;
  const insertResult = await client.query<MemoryRow>(
    `INSERT INTO memories (scope_id, memory_id, content, embedding, layer, strength, half_life_days,
       retrieval_count, origin, tags, status)
     VALUES ($1, $2, $3, $4::vector, $5, 1.0, $6, 0, $7, $8::jsonb, 'active')
     RETURNING ${MEMORY_COLUMNS}`,
    [scopeId, memoryId, content, toVectorLiteral(embedding), layer, DEFAULT_HALF_LIFE_DAYS, origin, JSON.stringify(tags)]
  );
  const memory = rowToMemory(insertResult.rows[0]);
  await writeVersion(client, scopeId, memoryId, "insert", memory);
  return memory;
}

/**
 * Embeds content and inserts a memory + its op='insert' version row in one
 * transaction. Creates the scope row if it does not already exist.
 */
export async function rememberMemory(input: RememberInput): Promise<Memory> {
  const scopeId = input.scopeId;
  const content = input.content;
  const layer = input.layer ?? "episodic";
  const tags = input.tags ?? [];
  const origin = input.origin ?? "api";

  const embedding = await embed(content);
  const memoryId = newUlid();

  try {
    // pool.connect() lives INSIDE the retried closure (not acquired once
    // outside it): a transient error can mean the connection itself is dead
    // (ECONNRESET / "Connection terminated"), so a retry must get a fresh
    // connection from the pool, not replay BEGIN on the same broken client.
    return await withTransientRetry(async () => {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        try {
          await client.query("INSERT INTO scopes (scope_id) VALUES ($1) ON CONFLICT DO NOTHING", [scopeId]);
          const memory = await insertMemoryTx(client, { scopeId, memoryId, content, embedding, layer, tags, origin });
          await client.query("COMMIT");
          return memory;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        }
      } finally {
        client.release();
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`rememberMemory: failed for scope ${scopeId}: ${message}`);
  }
}

/** Fetches one memory by (scopeId, memoryId), or null if it does not exist. */
export async function getMemory(scopeId: string, memoryId: string): Promise<Memory | null> {
  const result = await getPool().query<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS} FROM memories WHERE scope_id = $1 AND memory_id = $2`,
    [scopeId, memoryId]
  );
  if (result.rows.length === 0) return null;
  return rowToMemory(result.rows[0]);
}

export interface ReinforceMemoryTxInput {
  scopeId: string;
  memoryId: string;
  now: Date;
}

/**
 * Retrieval reinforcement: bumps retrieval_count/last_retrieved_at/strength
 * and writes an op='retrieve_boost' version row, on a caller-managed
 * client/transaction (recallMemories shares this transaction with its
 * recall_log write). Guarded by status = 'active': a memory selected as a
 * recall candidate can be consolidated by a concurrent sleepScope run before
 * this UPDATE lands. Returns null (rather than throwing) in that case -
 * recallMemories treats a null as "drop this candidate", not a 500.
 */
export async function reinforceMemoryTx(client: PoolClient, input: ReinforceMemoryTxInput): Promise<Memory | null> {
  const { scopeId, memoryId, now } = input;
  const updateResult = await client.query<MemoryRow>(
    `UPDATE memories
     SET retrieval_count = retrieval_count + 1,
         last_retrieved_at = $3,
         strength = LEAST(strength + 0.1, 2.0)
     WHERE scope_id = $1 AND memory_id = $2 AND status = 'active'
     RETURNING ${MEMORY_COLUMNS}`,
    [scopeId, memoryId, now]
  );
  if (updateResult.rows.length === 0) return null;
  const memory = rowToMemory(updateResult.rows[0]);
  await writeVersion(client, scopeId, memoryId, "retrieve_boost", memory);
  return memory;
}

export interface ConsolidateSourceTxInput {
  scopeId: string;
  memoryId: string;
  consolidatedInto: string;
}

/**
 * Marks a source memory consolidated (status='consolidated' +
 * consolidated_into) and writes an op='consolidate' version row, on a
 * caller-managed client/transaction (consolidate.ts calls this once per
 * source inside the same transaction as the cluster's new semantic memory).
 * Guarded by status = 'active': consolidating an already-consolidated (or
 * deleted, or nonexistent) memory is a caller bug, not a silent no-op - it
 * throws rather than writing a version row off a row that RETURNING never
 * found.
 */
export async function consolidateSourceTx(client: PoolClient, input: ConsolidateSourceTxInput): Promise<Memory> {
  const { scopeId, memoryId, consolidatedInto } = input;
  const updateResult = await client.query<MemoryRow>(
    `UPDATE memories
     SET status = 'consolidated', consolidated_into = $3
     WHERE scope_id = $1 AND memory_id = $2 AND status = 'active'
     RETURNING ${MEMORY_COLUMNS}`,
    [scopeId, memoryId, consolidatedInto]
  );
  if (updateResult.rows.length === 0) {
    throw new Error(
      `consolidateSourceTx: memory ${memoryId} in scope ${scopeId} is not active (already consolidated/deleted, or does not exist)`
    );
  }
  const memory = rowToMemory(updateResult.rows[0]);
  await writeVersion(client, scopeId, memoryId, "consolidate", memory);
  return memory;
}

export interface RecallInput {
  scopeId: string;
  query: string;
  k?: number;
}

export interface RecallResult {
  recallId: string;
  memories: Memory[];
}

const DEFAULT_K = 8;
const CANDIDATE_MULTIPLIER = 3;

interface ScoredCandidate {
  memory: Memory;
  distance: number;
  strength: number;
  score: number;
}

// Both embed() modes (fakeEmbed today, Titan V2 in phase 2) unit-normalize
// their output, so L2 distance between two candidates is bounded in [0, 2]
// (||a-b||^2 = 2 - 2cos(theta) for unit vectors). Dividing by 2 gives a
// stable [0,1] term independent of the rest of the candidate batch.
function scoreCandidate(row: MemoryRow & { distance: number }, now: Date): ScoredCandidate {
  const memory = rowToMemory(row);
  const distance = Number(row.distance);
  const normalizedDistance = Math.min(1, Math.max(0, distance / 2));
  const strength = strengthAt(memory, now);
  // Documented re-rank formula (plan Step 9): both distance and current
  // strength are mandatory terms; the 0.7/0.3 split is this store's tuned
  // default, not a locked contract.
  const score = (1 - normalizedDistance) * 0.7 + strength * 0.3;
  return { memory, distance, strength, score };
}

function hashEmbedding(embedding: number[]): string {
  return createHash("sha256").update(embedding.join(",")).digest("hex");
}

interface ReinforceAndLogInput {
  scopeId: string;
  recallId: string;
  query: string;
  queryEmbedding: number[];
  top: ScoredCandidate[];
  now: Date;
}

/**
 * Reinforces every candidate in `top` and writes the recall_log row in one
 * transaction, so the log always matches exactly what recallMemories
 * returns. strength_at_recall logs the decayed strength USED to rank (as of
 * the moment of recall, before this recall's own reinforcement side effect)
 * - "what did the agent know", not the post-boost value. A candidate whose
 * reinforceMemoryTx returns null (consolidated by a concurrent sleepScope
 * run between candidate selection and this UPDATE) is dropped here, from
 * both the returned Memory[] and the recall_log row - a memory that stopped
 * being active mid-recall is a benign race, not a 500.
 */
async function reinforceAndLog(pool: Pool, input: ReinforceAndLogInput): Promise<Memory[]> {
  const { scopeId, recallId, query, queryEmbedding, top, now } = input;
  try {
    // pool.connect() lives INSIDE the retried closure (not acquired once
    // outside it): a transient error can mean the connection itself is dead
    // (ECONNRESET / "Connection terminated"), so a retry must get a fresh
    // connection from the pool, not replay BEGIN on the same broken client.
    return await withTransientRetry(async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        try {
          const boosted: ScoredCandidate[] = [];
          for (const item of top) {
            const memory = await reinforceMemoryTx(client, { scopeId, memoryId: item.memory.memoryId, now });
            if (memory === null) continue;
            boosted.push({ ...item, memory });
          }

          const results = boosted.map((b) => ({
            memory_id: b.memory.memoryId,
            distance: b.distance,
            strength_at_recall: b.strength,
            score: b.score,
          }));
          await client.query(
            `INSERT INTO recall_log (scope_id, recall_id, query_text, query_embedding_hash, results)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [scopeId, recallId, query, hashEmbedding(queryEmbedding), JSON.stringify(results)]
          );

          await client.query("COMMIT");
          return boosted.map((b) => b.memory);
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        }
      } finally {
        client.release();
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`recallMemories: failed for scope ${scopeId}: ${message}`);
  }
}

/**
 * Scoped vector recall: ANN-orders scope_id+status='active' candidates in
 * SQL before LIMIT (CLAUDE.md "Common Mistakes to Avoid" - post-filtering in
 * JS silently starves results), re-ranks the top k*3 in JS by
 * scoreCandidate(), then reinforces every returned memory and writes the
 * recall_log row via reinforceAndLog() (one transaction).
 */
export async function recallMemories(input: RecallInput): Promise<RecallResult> {
  const scopeId = input.scopeId;
  const query = input.query;
  const k = input.k ?? DEFAULT_K;
  const candidateLimit = k * CANDIDATE_MULTIPLIER;

  const queryEmbedding = await embed(query);
  const queryVector = toVectorLiteral(queryEmbedding);

  const pool = getPool();
  const candidatesResult = await pool.query<MemoryRow & { distance: number }>(
    `SELECT ${MEMORY_COLUMNS}, embedding <-> $2::vector AS distance
     FROM memories
     WHERE scope_id = $1 AND status = 'active'
     ORDER BY embedding <-> $2::vector
     LIMIT $3`,
    [scopeId, queryVector, candidateLimit]
  );

  const now = new Date();
  const scored = candidatesResult.rows.map((row) => scoreCandidate(row, now));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);
  const recallId = newUlid();

  const memories = await reinforceAndLog(pool, { scopeId, recallId, query, queryEmbedding, top, now });
  return { recallId, memories };
}
