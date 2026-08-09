// Read-only engine stats for the dashboard's introspect panel and
// /api/introspect (docs/plans/2026-08-09-phase-3-surfaces.md Step 4). No
// writes - same read-only boundary as provenance.ts and list.ts. Six small
// count queries run in parallel rather than one large join: each table is
// scoped by scope_id on its own primary-key/FK prefix, so this stays cheap
// at hackathon scale without inventing a cross-table aggregate query.

import { GC_WINDOW_MS, getPool } from "../db.js";

export interface IntrospectStats {
  counts: {
    byLayer: Record<string, number>;
    byStatus: Record<string, number>;
  };
  versionsCount: number;
  recallCount: number;
  sessionsCount: number;
  turnsCount: number;
  gcWindowMs: number;
  embeddingDim: number;
}

// Locked at 1024 (Titan V2), CLAUDE.md rule 6. Not read from the DB: the
// column is VECTOR(1024) by schema, this just surfaces that fixed contract
// to the dashboard rather than re-deriving it per request.
const EMBEDDING_DIM = 1024;

interface CountByKeyRow {
  key: string;
  count: string;
}

interface CountRow {
  count: string;
}

function toCountMap(rows: CountByKeyRow[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const row of rows) {
    map[row.key] = Number(row.count);
  }
  return map;
}

/**
 * Aggregate stats for one scope: memory counts by layer and status, total
 * version/recall/session/turn rows, and the fixed engine constants (GC
 * window, embedding dimension) the dashboard's introspect strip shows
 * alongside them.
 */
export async function getIntrospectStats(scopeId: string): Promise<IntrospectStats> {
  const pool = getPool();
  const [byLayerResult, byStatusResult, versionsResult, recallResult, sessionsResult, turnsResult] = await Promise.all([
    pool.query<CountByKeyRow>(`SELECT layer AS key, count(*) AS count FROM memories WHERE scope_id = $1 GROUP BY layer`, [
      scopeId,
    ]),
    pool.query<CountByKeyRow>(`SELECT status AS key, count(*) AS count FROM memories WHERE scope_id = $1 GROUP BY status`, [
      scopeId,
    ]),
    pool.query<CountRow>(`SELECT count(*) AS count FROM memory_versions WHERE scope_id = $1`, [scopeId]),
    pool.query<CountRow>(`SELECT count(*) AS count FROM recall_log WHERE scope_id = $1`, [scopeId]),
    pool.query<CountRow>(`SELECT count(*) AS count FROM sessions WHERE scope_id = $1`, [scopeId]),
    pool.query<CountRow>(`SELECT count(*) AS count FROM turns WHERE scope_id = $1`, [scopeId]),
  ]);

  return {
    counts: {
      byLayer: toCountMap(byLayerResult.rows),
      byStatus: toCountMap(byStatusResult.rows),
    },
    versionsCount: Number(versionsResult.rows[0].count),
    recallCount: Number(recallResult.rows[0].count),
    sessionsCount: Number(sessionsResult.rows[0].count),
    turnsCount: Number(turnsResult.rows[0].count),
    gcWindowMs: GC_WINDOW_MS,
    embeddingDim: EMBEDDING_DIM,
  };
}
