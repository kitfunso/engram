// Shared request/tool-input validation caps for every API boundary this repo
// exposes (src/agent/routes.ts's HTTP boundary, src/mcp/server.ts's MCP
// boundary). Extracted from routes.ts (docs/plans/2026-08-09-phase-3-surfaces.md
// Step 3) so both surfaces enforce identical caps from one place instead of
// maintaining two copies - CLAUDE.md Safety Rules: "/api/* validates scope_id
// format, caps k and content length" applies to the MCP tools too, since they
// are the same store operations exposed over a second transport.

import type { MemoryLayer } from "./store/memories.js";

// Shared shape for every id-like field (scope_id, session_id, memory id,
// recall_id): ULIDs fit this comfortably. scope_id's exact pattern is
// spelled out in docs/plans/2026-08-09-phase-2-agent-api.md Step 4; the same
// pattern is reused as the "well-formed" check for the other id fields since
// no separate pattern was specified for them.
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_K = 20;
export const MAX_CONTENT_LEN = 8192;
export const MAX_QUERY_LEN = 256;
export const MEMORY_LAYERS: MemoryLayer[] = ["episodic", "semantic"];
export const MEMORY_STATUSES = ["active", "consolidated", "deleted"] as const;
export type MemoryStatusFilter = (typeof MEMORY_STATUSES)[number];

export class ValidationError extends Error {}

export function badRequest(message: string): never {
  throw new ValidationError(message);
}

export function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    badRequest(`${field} must match ^[A-Za-z0-9_-]{1,64}$`);
  }
  return value as string;
}

export function requireText(value: unknown, field: string, maxLen: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) {
    badRequest(`${field} must be a non-empty string up to ${maxLen} chars`);
  }
  return value as string;
}

export function optionalText(value: unknown, field: string, maxLen: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireText(value, field, maxLen);
}

export function optionalK(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const k = Number(value);
  if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
    badRequest(`k must be an integer between 1 and ${MAX_K}`);
  }
  return k;
}

export function optionalLayer(value: unknown): MemoryLayer | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !MEMORY_LAYERS.includes(value as MemoryLayer)) {
    badRequest(`layer must be one of ${MEMORY_LAYERS.join(", ")}`);
  }
  return value as MemoryLayer;
}

export function optionalStatus(value: unknown): MemoryStatusFilter | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !MEMORY_STATUSES.includes(value as MemoryStatusFilter)) {
    badRequest(`status must be one of ${MEMORY_STATUSES.join(", ")}`);
  }
  return value as MemoryStatusFilter;
}

export function optionalTags(value: unknown): unknown[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) badRequest("tags must be an array");
  return value as unknown[];
}

export function parseAsOf(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") badRequest("as_of must be an ISO date string");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) badRequest("as_of must be a valid date");
  return date;
}
