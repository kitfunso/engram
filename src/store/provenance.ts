// Read-only provenance queries over recall_log and memory_versions
// (docs/ARCHITECTURE.md: recall_log feeds "what did the agent know";
// memory_versions is the audit trail). No writes here - the single write
// path stays in memories.ts (CLAUDE.md rule 1); this module only reads.

import { getPool } from "../db.js";

export interface RecallResultEntry {
  memoryId: string;
  distance: number;
  strengthAtRecall: number;
  score: number;
}

export interface RecallLogEntry {
  scopeId: string;
  recallId: string;
  queryText: string;
  queryEmbeddingHash: string;
  results: RecallResultEntry[];
  at: Date;
}

interface RecallLogRow {
  scope_id: string;
  recall_id: string;
  query_text: string;
  query_embedding_hash: string;
  results: { memory_id: string; distance: number; strength_at_recall: number; score: number }[];
  at: Date;
}

function rowToRecallLog(row: RecallLogRow): RecallLogEntry {
  return {
    scopeId: row.scope_id,
    recallId: row.recall_id,
    queryText: row.query_text,
    queryEmbeddingHash: row.query_embedding_hash,
    results: row.results.map((r) => ({
      memoryId: r.memory_id,
      distance: Number(r.distance),
      strengthAtRecall: Number(r.strength_at_recall),
      score: Number(r.score),
    })),
    at: row.at,
  };
}

/** Fetches one recall_log row by (scopeId, recallId), or null if not found. */
export async function getRecall(scopeId: string, recallId: string): Promise<RecallLogEntry | null> {
  const result = await getPool().query<RecallLogRow>(
    `SELECT scope_id, recall_id, query_text, query_embedding_hash, results, at
     FROM recall_log WHERE scope_id = $1 AND recall_id = $2`,
    [scopeId, recallId]
  );
  if (result.rows.length === 0) return null;
  return rowToRecallLog(result.rows[0]);
}

export interface MemoryVersionEntry {
  scopeId: string;
  versionId: string;
  memoryId: string;
  op: string;
  snapshot: Record<string, unknown>;
  actor: string;
  at: Date;
}

interface MemoryVersionRow {
  scope_id: string;
  version_id: string;
  memory_id: string;
  op: string;
  snapshot: Record<string, unknown>;
  actor: string;
  at: Date;
}

// Snapshot numeric fields are written from already-Number()-coerced Memory
// objects (src/store/memories.ts's memorySnapshot()), so they round-trip
// through JSONB as JSON numbers already, not INT8 strings. Coerced again
// here defensively so a caller never has to know whether a given snapshot
// predates that convention - same belt-and-braces reasoning as
// rowToMemory's retrieval_count coercion in memories.ts.
function normalizeSnapshot(raw: Record<string, unknown>): Record<string, unknown> {
  const snapshot = { ...raw };
  for (const key of ["strength", "halfLifeDays", "retrievalCount"]) {
    if (snapshot[key] !== undefined && snapshot[key] !== null) {
      snapshot[key] = Number(snapshot[key]);
    }
  }
  return snapshot;
}

/** Fetches the full version history for one memory, oldest first. */
export async function getMemoryHistory(scopeId: string, memoryId: string): Promise<MemoryVersionEntry[]> {
  const result = await getPool().query<MemoryVersionRow>(
    `SELECT scope_id, version_id, memory_id, op, snapshot, actor, at
     FROM memory_versions
     WHERE scope_id = $1 AND memory_id = $2
     ORDER BY at ASC`,
    [scopeId, memoryId]
  );
  return result.rows.map((row) => ({
    scopeId: row.scope_id,
    versionId: row.version_id,
    memoryId: row.memory_id,
    op: row.op,
    snapshot: normalizeSnapshot(row.snapshot),
    actor: row.actor,
    at: row.at,
  }));
}
