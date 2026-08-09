// Read-only memory listing for the dashboard browser (docs/ARCHITECTURE.md
// "GET /api/memories - dashboard browser"). Kept in its own file rather than
// added to memories.ts (plan Step 4): memories.ts stays the single WRITE
// path (CLAUDE.md rule 1); this module only reads, same boundary
// provenance.ts and timetravel.ts already follow. Parameterized SQL only;
// filters are pushed into the WHERE clause before LIMIT (CLAUDE.md "Common
// Mistakes to Avoid" - post-filtering in JS silently starves results).

import { getPool } from "../db.js";
import { strengthAt } from "./decay.js";
import { MEMORY_COLUMNS, rowToMemory, type Memory, type MemoryLayer, type MemoryRow, type MemoryStatus } from "./memories.js";

export interface ListMemoriesInput {
  scopeId: string;
  status?: MemoryStatus;
  layer?: MemoryLayer;
  q?: string;
  limit?: number;
}

export interface MemoryWithStrength extends Memory {
  strengthNow: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Lists memories for a scope, optionally filtered by status, layer, and a
 * case-insensitive substring match on content (q). Ordered newest-first,
 * capped at MAX_LIMIT regardless of the requested limit. Each row carries
 * strengthNow: current decayed strength computed via strengthAt(), so the
 * dashboard can sort/color by freshness without a second round trip.
 */
export async function listMemories(input: ListMemoriesInput): Promise<MemoryWithStrength[]> {
  const { scopeId, status, layer, q } = input;
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const conditions = ["scope_id = $1"];
  const params: unknown[] = [scopeId];

  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (layer) {
    params.push(layer);
    conditions.push(`layer = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`content ILIKE $${params.length}`);
  }
  params.push(limit);

  const result = await getPool().query<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS} FROM memories
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );

  const now = new Date();
  return result.rows.map(rowToMemory).map((memory) => ({ ...memory, strengthNow: strengthAt(memory, now) }));
}
