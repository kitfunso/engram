// THE single write path to `memories` (CLAUDE.md rule 1): every mutation
// writes a memories row and a memory_versions row in the same transaction.
// Nothing outside src/store/** may issue SQL against these tables
// (docs/ARCHITECTURE.md Service Boundaries).

import { getPool } from "../db.js";
import { newUlid } from "../ulid.js";
import { embed } from "../embeddings.js";

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

interface MemoryRow {
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

const MEMORY_COLUMNS = `scope_id, memory_id, content, embedding, layer, strength, half_life_days,
  retrieval_count, created_at, last_retrieved_at, origin, tags, status, consolidated_into`;

// CRDB VECTOR uses pgvector wire format: pass a '[0.1,0.2,...]' string with
// an explicit ::vector cast, not a JS array (CLAUDE.md "Common Mistakes to
// Avoid"). Verified round-trip shape against local CockroachDB directly.
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function parseVectorLiteral(literal: string): number[] {
  return literal.slice(1, -1).split(",").map(Number);
}

function rowToMemory(row: MemoryRow): Memory {
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
  // version row is wasteful and it never changes across the ops this store
  // writes today (insert only, in this step). Revisit if a future op
  // mutates embedding.
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

/**
 * Inserts a memory (embedding it first) and its op='insert' version row in
 * one transaction. Creates the scope row if it does not already exist.
 */
export async function rememberMemory(input: RememberInput): Promise<Memory> {
  const scopeId = input.scopeId;
  const content = input.content;
  const layer = input.layer ?? "episodic";
  const tags = input.tags ?? [];
  const origin = input.origin ?? "api";

  const embedding = await embed(content);
  const memoryId = newUlid();
  const versionId = newUlid();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO scopes (scope_id) VALUES ($1) ON CONFLICT DO NOTHING", [scopeId]);

    const insertResult = await client.query<MemoryRow>(
      `INSERT INTO memories (scope_id, memory_id, content, embedding, layer, strength, half_life_days,
         retrieval_count, origin, tags, status)
       VALUES ($1, $2, $3, $4::vector, $5, 1.0, $6, 0, $7, $8::jsonb, 'active')
       RETURNING ${MEMORY_COLUMNS}`,
      [scopeId, memoryId, content, toVectorLiteral(embedding), layer, DEFAULT_HALF_LIFE_DAYS, origin, JSON.stringify(tags)]
    );
    const memory = rowToMemory(insertResult.rows[0]);

    await client.query(
      `INSERT INTO memory_versions (scope_id, version_id, memory_id, op, snapshot, actor)
       VALUES ($1, $2, $3, 'insert', $4::jsonb, $5)`,
      [scopeId, versionId, memoryId, JSON.stringify(memorySnapshot(memory)), "store"]
    );

    await client.query("COMMIT");
    return memory;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`rememberMemory: failed for scope ${scopeId}: ${message}`);
  } finally {
    client.release();
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
