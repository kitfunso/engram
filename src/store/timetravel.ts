// Dual-layer time travel: AS OF SYSTEM TIME fast path for in-window history,
// memory_versions replay for anything the GC window has aged out
// (docs/ARCHITECTURE.md "Time semantics"; plan Step 10). Read-only: no
// writes, no reinforcement, no recall_log here - CLAUDE.md rule 1 only binds
// mutations, and this module makes none.

import { AOST_SAFE_WINDOW_MS, aostClause, getPool } from "../db.js";
import { embed } from "../embeddings.js";
import { strengthAt } from "./decay.js";
import { MEMORY_COLUMNS, parseVectorLiteral, rowToMemory, toVectorLiteral, type Memory, type MemoryRow } from "./memories.js";

const DEFAULT_K = 8;

// Two past-window error classes both route to replay, matched on message
// substring per the task's established facts: (a) the GC threshold wording
// CRDB uses once a timestamp ages past gc.ttlseconds on a live table
// (measured on CockroachDB Cloud, scripts/spike/RESULTS-cloud.md's zone
// config: gc.ttlseconds = 4500 -> GC_WINDOW_MS in src/db.ts); (b) an
// object-existence wording ("... does not exist") when the timestamp
// predates the table/database's own creation - reproduced locally: querying
// ~400 days back errors `database "engram" does not exist`, not any
// GC-specific message.
export function isPastWindowError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("GC threshold") || message.includes("does not exist");
}

export interface RecallAsOfInput {
  scopeId: string;
  query?: string;
  at: Date;
  k?: number;
  forceReplay?: boolean;
}

export interface RecallAsOfResult {
  memories: Memory[];
  usedReplay: boolean;
  // True when the replay path's version scan hit REPLAY_VERSION_SCAN_LIMIT:
  // more memory_ids may have had history at T than were reconstructed.
  // Always false when the fast (AOST) path served the request.
  truncated: boolean;
}

/**
 * Historical recall. In-window reads (Date.now() - at < AOST_SAFE_WINDOW_MS)
 * use a single AS OF SYSTEM TIME statement (fast, exact); anything older, or
 * that hits either past-window error class on the fast attempt, replays
 * memory_versions instead. Both paths return the same Memory[] shape. No
 * writes, no reinforcement, no recall_log - this is a pure historical read.
 */
export async function recallAsOf(input: RecallAsOfInput): Promise<RecallAsOfResult> {
  const { scopeId, query, at, k = DEFAULT_K, forceReplay = false } = input;
  const inWindow = Date.now() - at.getTime() < AOST_SAFE_WINDOW_MS;

  if (!forceReplay && inWindow) {
    try {
      const memories = await recallAsOfFast(scopeId, query, at, k);
      return { memories, usedReplay: false, truncated: false };
    } catch (err) {
      if (!isPastWindowError(err)) throw err;
      // fall through to replay
    }
  }

  const { memories, truncated } = await recallAsOfReplay(scopeId, query, at, k);
  return { memories, usedReplay: true, truncated };
}

// Both branches map through strengthAt(memory, at): the memories.strength
// column holds the raw value written at last mutation (insert=1.0, each
// retrieve_boost bumps it), not a continuously-decayed value. AS OF SYSTEM
// TIME returns that raw column exactly as it stood at `at`, so without this
// step the fast path would report un-decayed strength while
// recallAsOfReplay (snapshotToMemory) already decays via strengthAt - the
// two paths would disagree on strength for the identical T. Decaying here
// makes them report identical values (see tests/timetravel.test.ts's
// fast-path/forceReplay equivalence test).
async function recallAsOfFast(scopeId: string, query: string | undefined, at: Date, k: number): Promise<Memory[]> {
  const pool = getPool();
  const clause = aostClause(at);

  if (query !== undefined) {
    const queryEmbedding = await embed(query);
    const queryVector = toVectorLiteral(queryEmbedding);
    const result = await pool.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM memories ${clause}
       WHERE scope_id = $1 AND status = 'active'
       ORDER BY embedding <-> $2::vector
       LIMIT $3`,
      [scopeId, queryVector, k]
    );
    return result.rows.map(rowToMemory).map((memory) => ({ ...memory, strength: strengthAt(memory, at) }));
  }

  const result = await pool.query<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS} FROM memories ${clause}
     WHERE scope_id = $1 AND status = 'active'
     ORDER BY last_retrieved_at DESC
     LIMIT $2`,
    [scopeId, k]
  );
  return result.rows.map(rowToMemory).map((memory) => ({ ...memory, strength: strengthAt(memory, at) }));
}

interface VersionRow {
  memory_id: string;
  op: string;
  snapshot: Record<string, unknown>;
}

// Bounds the replay path's version scan (cost ceiling on a public,
// unauthenticated endpoint - a scope with unbounded memory_versions history
// must not turn one /api/recall?as_of=... request into an unbounded scan).
const REPLAY_VERSION_SCAN_LIMIT = 2000;

/**
 * Reconstructs Memory objects from a memory_versions snapshot: no stored
 * embedding (memorySnapshot() in memories.ts omits it - see its comment for
 * why joining the current column is exact, not approximate, for every op
 * this store writes), strength recomputed as strengthAt(snapshot, at).
 */
function snapshotToMemory(memoryId: string, snapshot: Record<string, unknown>, embedding: number[], at: Date): Memory {
  const lastRetrievedAt = new Date(snapshot.lastRetrievedAt as string);
  const halfLifeDays = Number(snapshot.halfLifeDays);
  const strength = Number(snapshot.strength);
  return {
    scopeId: snapshot.scopeId as string,
    memoryId,
    content: snapshot.content as string,
    embedding,
    layer: snapshot.layer as Memory["layer"],
    strength: strengthAt({ strength, halfLifeDays, lastRetrievedAt }, at),
    halfLifeDays,
    retrievalCount: Number(snapshot.retrievalCount),
    createdAt: new Date(snapshot.createdAt as string),
    lastRetrievedAt,
    origin: snapshot.origin as string,
    tags: snapshot.tags as unknown[],
    status: snapshot.status as Memory["status"],
    consolidatedInto: (snapshot.consolidatedInto as string | null) ?? null,
  };
}

/**
 * For each memory_id in scope, takes the latest memory_versions row with
 * at <= T. A memory exists at T iff that version's op is not 'delete' and
 * its snapshot.status is 'active'. Embeddings are joined from the current
 * memories table (see snapshotToMemory); ranking mirrors recallMemories'
 * shape (vector order when a query is given, else last_retrieved_at DESC).
 * `version_id DESC` is a deterministic tiebreak for `at DESC`: memory_versions
 * rows can share the same HLC timestamp under concurrent writes, and
 * DISTINCT ON's "latest" pick must be stable across runs rather than
 * depending on incidental row order.
 */
async function recallAsOfReplay(
  scopeId: string,
  query: string | undefined,
  at: Date,
  k: number
): Promise<{ memories: Memory[]; truncated: boolean }> {
  const pool = getPool();
  const versionsResult = await pool.query<VersionRow>(
    `SELECT DISTINCT ON (memory_id) memory_id, op, snapshot
     FROM memory_versions
     WHERE scope_id = $1 AND at <= $2
     ORDER BY memory_id, at DESC, version_id DESC
     LIMIT $3`,
    [scopeId, at, REPLAY_VERSION_SCAN_LIMIT]
  );
  const truncated = versionsResult.rows.length >= REPLAY_VERSION_SCAN_LIMIT;

  const liveMemoryIds: string[] = [];
  const snapshots = new Map<string, Record<string, unknown>>();
  for (const row of versionsResult.rows) {
    if (row.op === "delete") continue;
    if (row.snapshot.status !== "active") continue;
    liveMemoryIds.push(row.memory_id);
    snapshots.set(row.memory_id, row.snapshot);
  }
  if (liveMemoryIds.length === 0) return { memories: [], truncated };

  const embeddingRows = await pool.query<{ memory_id: string; embedding: string }>(
    `SELECT memory_id, embedding FROM memories WHERE scope_id = $1 AND memory_id = ANY($2)`,
    [scopeId, liveMemoryIds]
  );
  const embeddings = new Map<string, number[]>();
  for (const row of embeddingRows.rows) {
    embeddings.set(row.memory_id, parseVectorLiteral(row.embedding));
  }

  const reconstructed = liveMemoryIds
    .filter((id) => embeddings.has(id))
    .map((id) => snapshotToMemory(id, snapshots.get(id)!, embeddings.get(id)!, at));

  if (query !== undefined) {
    const queryEmbedding = await embed(query);
    reconstructed.sort((a, b) => l2(a.embedding, queryEmbedding) - l2(b.embedding, queryEmbedding));
  } else {
    reconstructed.sort((a, b) => b.lastRetrievedAt.getTime() - a.lastRetrievedAt.getTime());
  }

  return { memories: reconstructed.slice(0, k), truncated };
}

function l2(a: number[], b: number[]): number {
  return Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));
}
