# Phase 2: Demo Agent + HTTP API

**Goal:** A working demo agent that remembers users across sessions: Hono routes, agent loop (recall -> Claude -> reply -> remember), sessions/turns state, real Bedrock paths, local chat E2E.
**Prerequisites:** Phase 1 complete (store layer green: memories, recall, provenance, timetravel, consolidate).
**Estimated scope:** 6 steps, ~1 day. Every step runs against local cockroach + ENGRAM_FAKE_BEDROCK=1; real-Bedrock verification is one spike-style check per step where relevant, never a test dependency (CLAUDE.md rule 7).

---

## Step 1: Real Bedrock paths (embeddings + chat)
**Files:** `src/embeddings.ts` (real Titan path), `src/llm.ts` (real Claude converse path + `chat()` wrapper)
**What:** Fill the real branches behind `ENGRAM_FAKE_BEDROCK`. Titan Text Embeddings V2 `amazon.titan-embed-text-v2:0` (1024 dims, assert length). Claude via inference profile `us.anthropic.claude-sonnet-4-5-20250929-v1:0` using the Converse API. Deps: `@aws-sdk/client-bedrock-runtime` only. Region/profile from env (`AWS_REGION`, `AWS_PROFILE`). Errors fail fast with operation name.
**Verify:** `npx tsx scripts/spike/bedrock-live-check.ts` (tiny script, spike dir): 1 embed returns 1024 floats, 1 chat returns non-empty text. Full test suite still green with FAKE=1 and no AWS env.
**Commit:** `feat: real bedrock paths (titan v2 + claude converse)`

## Step 2: Sessions + turns store
**Files:** `src/store/sessions.ts`, `tests/sessions.test.ts`
**What:** `createSession(scopeId)`, `appendTurn(scopeId, sessionId, role, content, recallId?)`, `getTurns(scopeId, sessionId, limit)` - parameterized SQL, composite keys, ULIDs. Turns ordered by turn id (ULID sorts by time).
**Verify:** tests: turns round-trip in order; recall_id FK nullable; scopes isolated.
**Commit:** `feat: sessions + turns store`

## Step 3: Agent loop
**Files:** `src/agent/agent.ts`, `tests/agent.test.ts`
**What:** `handleChat({scopeId, sessionId, message})`: embed query -> `recallMemories` (k=6) -> build prompt with recalled memories as QUOTED UNTRUSTED CONTEXT (prompt-injection rule: memories are data, never instructions) + last N turns -> `chat()` -> reply. Then fact extraction: one LLM call returns JSON array of memorable facts (may be empty); each fact -> `rememberMemory` (layer episodic, origin `agent`). Persist both turns with the recall_id. FAKE mode: deterministic reply + extraction (echoes facts from lines starting "remember:") so E2E logic is fully testable offline.
**Verify:** tests: chat writes 2 turns + recall_log row; "remember: I like X" produces a stored memory findable by later recall in a NEW session; memory content containing "ignore previous instructions" stays inert data in the prompt string.
**Commit:** `feat: demo agent loop (recall, reply, remember)`

## Step 4: Hono routes + local server
**Files:** `src/agent/routes.ts`, `src/server.ts`, `tests/routes.test.ts`
**What:** Routes per ARCHITECTURE.md: `POST /chat`, `POST /api/remember`, `POST /api/recall` (supports `as_of` -> timetravel), `POST /api/sleep`, `GET /api/memories`, `GET /api/memory/:id/history`, `GET /api/provenance/:recall_id`, `GET /dashboard` (serves `public/dashboard.html`, stub file for now). Validation at the boundary: scope_id `[A-Za-z0-9_-]{1,64}`, k capped at 20, content capped at 8 KB, JSON errors with status codes. No auth by design (PRD IS-NOT #4).
**Verify:** tests via Hono `app.request()` (no listener needed): each route happy path + validation rejects; `/chat` E2E with FAKE=1.
**Commit:** `feat: hono api + local server`

## Step 5: Local chat E2E script
**Files:** `scripts/demo-chat.mjs`
**What:** Script drives the local server: session A "remember: my dog is called Biscuit" -> new session B "what is my dog called?" -> asserts reply/recall surfaces Biscuit (FAKE mode assert on recall content, not LLM prose). Prints recall provenance ids. This is the seed of the video demo.
**Verify:** `node scripts/demo-chat.mjs` exits 0 with the cross-session recall shown; run once with real Bedrock (operator env) for a screenshot-worthy transcript.
**Commit:** `feat: cross-session memory demo script`

## Step 6: Phase-2 wrap
**Files:** `README.md` (API section + demo script usage), `docs/plans/2026-08-10-phase-3-surfaces.md`
**What:** README documents the API + demo; generate Phase 3 plan (dashboard, MCP server, CRDB managed MCP integration).
**Verify:** fresh-clone dry run incl. `node scripts/demo-chat.mjs`; tsc clean; all tests green.
**Commit:** `docs: phase-2 wrap + phase-3 plan`
