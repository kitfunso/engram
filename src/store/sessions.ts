// Sessions + turns store (docs/ARCHITECTURE.md Service Boundaries: all SQL
// against sessions/turns lives in src/store/**, same rule that keeps
// memories.ts the sole write path for memories). Parameterized SQL only.
// Turn ids are ULIDs (src/ulid.ts), which sort by creation time, so ordering
// by turn_id is equivalent to chronological order without a secondary
// timestamp sort.

import { getPool } from "../db.js";
import { newUlid } from "../ulid.js";

export type TurnRole = "user" | "assistant";

export interface Turn {
  scopeId: string;
  turnId: string;
  sessionId: string;
  role: TurnRole;
  content: string;
  recallId: string | null;
  createdAt: Date;
}

interface TurnRow {
  scope_id: string;
  turn_id: string;
  session_id: string;
  role: TurnRole;
  content: string;
  recall_id: string | null;
  created_at: Date;
}

function rowToTurn(row: TurnRow): Turn {
  return {
    scopeId: row.scope_id,
    turnId: row.turn_id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    recallId: row.recall_id,
    createdAt: row.created_at,
  };
}

/**
 * Creates a new session for scopeId (and the scope row, if it doesn't
 * already exist yet - mirrors rememberMemory's ON CONFLICT DO NOTHING
 * pattern), returns the new session id.
 */
export async function createSession(scopeId: string): Promise<string> {
  const sessionId = newUlid();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("INSERT INTO scopes (scope_id) VALUES ($1) ON CONFLICT DO NOTHING", [scopeId]);
      await client.query("INSERT INTO sessions (scope_id, session_id) VALUES ($1, $2)", [scopeId, sessionId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`createSession: failed for scope ${scopeId}: ${message}`);
  } finally {
    client.release();
  }
  return sessionId;
}

export interface AppendTurnInput {
  scopeId: string;
  sessionId: string;
  role: TurnRole;
  content: string;
  recallId?: string | null;
}

/** Appends one turn to a session. recallId is nullable (FK to recall_log). */
export async function appendTurn(input: AppendTurnInput): Promise<Turn> {
  const { scopeId, sessionId, role, content } = input;
  const recallId = input.recallId ?? null;
  const turnId = newUlid();
  try {
    const result = await getPool().query<TurnRow>(
      `INSERT INTO turns (scope_id, turn_id, session_id, role, content, recall_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING scope_id, turn_id, session_id, role, content, recall_id, created_at`,
      [scopeId, turnId, sessionId, role, content, recallId]
    );
    return rowToTurn(result.rows[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`appendTurn: failed for scope ${scopeId} session ${sessionId}: ${message}`);
  }
}

const DEFAULT_TURN_LIMIT = 20;

/**
 * Fetches the most recent `limit` turns for (scopeId, sessionId), returned
 * oldest-first (chronological order, suitable for feeding straight into a
 * chat message history). Ordering by turn_id DESC LIMIT first and then
 * re-sorting ASC (rather than a plain ASC LIMIT) matters once a session has
 * more turns than `limit`: a plain ASC LIMIT would return the OLDEST turns,
 * not the most recent ones.
 */
export async function getTurns(scopeId: string, sessionId: string, limit = DEFAULT_TURN_LIMIT): Promise<Turn[]> {
  const result = await getPool().query<TurnRow>(
    `SELECT scope_id, turn_id, session_id, role, content, recall_id, created_at FROM (
       SELECT scope_id, turn_id, session_id, role, content, recall_id, created_at
       FROM turns
       WHERE scope_id = $1 AND session_id = $2
       ORDER BY turn_id DESC
       LIMIT $3
     ) recent
     ORDER BY turn_id ASC`,
    [scopeId, sessionId, limit]
  );
  return result.rows.map(rowToTurn);
}
