# Phase 3: Surfaces (Dashboard + MCP)

**Goal:** The two visible surfaces: single-file observability dashboard and the MCP server, plus CRDB Cloud Managed MCP Server integration for agent self-introspection.
**Prerequisites:** Phase 2 complete (agent loop + Hono API green).
**Estimated scope:** 5 steps, ~1 day. Scope-cut order if the deadline bites (PRD): MCP wrapper -> dashboard polish. The dashboard browser + provenance view and the MCP remember/recall tools are the never-cut core of this phase.

---

## Step 1: Dashboard data endpoints hardening
**Files:** `src/agent/routes.ts` (additions only), `tests/routes.test.ts`
**What:** Confirm the dashboard JSON endpoints return everything the UI needs in one round trip each: `/api/memories` gains `?layer=&q=` filters and per-memory `strength_now` (computed server-side via `strengthAt`); `/api/memory/:id/history` returns version rows ordered by `at`; `/api/provenance/:recall_id` joins recall_log results to current memory content. All read-only, parameterized, k/limit capped.
**Verify:** route tests for each shape; tsc clean.
**Commit:** `feat: dashboard data endpoints`

## Step 2: Dashboard single-file HTML
**Files:** `public/dashboard.html`
**What:** One self-contained file (vanilla JS + inline CSS + inline SVG, no CDN): memory browser table (scope selector, layer/status filters, strength bars), decay curves (SVG line per memory from strength/half-life), version lineage view (click memory -> history timeline incl. consolidation links), provenance view (paste recall_id or click from browser), time-travel slider (calls `/api/recall` with `as_of`), "Sleep now" button (`POST /api/sleep` then refresh). Fetches only the phase-3 JSON endpoints. No build step.
**Verify:** manual: serve locally, exercise every panel against seeded data; screenshot for README.
**Commit:** `feat: single-file observability dashboard`

## Step 3: MCP server
**Files:** `src/mcp/server.ts`, `tests/mcp.test.ts`
**What:** `@modelcontextprotocol/sdk` stdio server exposing 4 tools mirroring the store: `remember` {scope_id, content, layer?, tags?}, `recall` {scope_id, query, k?}, `recall_asof` {scope_id, query, as_of}, `reflect` {scope_id} (sleep). Thin adapter over `src/store/**`, no business logic, same validation caps as the HTTP boundary. Bin entry in package.json (`engram-mcp`).
**Verify:** tests drive the server in-process via the SDK client over an in-memory transport; each tool round-trips against local DB with FAKE=1.
**Commit:** `feat: mcp server (remember, recall, recall_asof, reflect)`

## Step 4: CRDB Cloud Managed MCP Server integration
**Files:** `src/agent/introspect.ts`, `README.md` (tool-mapping row update)
**What:** The demo agent's "how is my memory doing" self-introspection path: registered Managed MCP Server (`https://cockroachlabs.cloud/mcp`, header `mcp-cluster-id`) is documented + wired as the operator-facing introspection route (Claude Code / any MCP client can query the engram cluster schema and stats directly). In-app: `/api/introspect` returns engine stats (memory counts by layer/status, versions count, recall volume, GC window) computed via our own SQL so the demo URL works without OAuth; README documents the Managed MCP registration command as the judge-facing CRDB tool #2 with a worked example query.
**Verify:** README instructions re-run cleanly against the live cluster; `/api/introspect` route test green.
**Commit:** `feat: introspection + managed mcp integration docs`

## Step 5: Phase-3 wrap
**Files:** `README.md` (dashboard screenshot + MCP usage), `docs/plans/2026-08-10-phase-4-ship.md`
**What:** README gains dashboard + MCP sections; generate phase-4 plan (Lambda deploy, demo URL, seed data, resilience film, video, Devpost).
**Verify:** fresh working-tree dry run; all tests green; tsc clean.
**Commit:** `docs: phase-3 wrap + phase-4 plan`
