# Phase 1: Foundation + De-risking Spikes

**Goal:** Working scaffold with all platform risks retired: local + cloud CockroachDB reachable, vector index proven E2E, GC window measured, Bedrock path decided, core schema migrated, versioned store with passing real-DB tests.
**Prerequisites:** Episode 01KZM4DR4YNTVZTA6SWM8X33YF open; AWS CLI authed; operator actions pending (Bedrock IAM, ccloud auth) tracked in Step 3/6.
**Estimated scope:** 12 steps, ~1.5 days. Phases 2-4 sketched at the bottom; each gets its own dated plan when reached.

---

## Step 1: Repo scaffold
**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `LICENSE` (MIT), `README.md` (stub with hippo disclosure + tool-mapping table placeholders)
**What:** npm init, deps: `hono @hono/node-server pg @modelcontextprotocol/sdk`, dev: `typescript tsx @types/pg @types/node`. Node built-in test runner (no test framework).
**Verify:** `npx tsc --noEmit` clean on empty src; `node --test` runs 0 tests green.
**Commit:** `chore: scaffold engram (TS, hono, pg, MIT)`

## Step 2: Local cockroach + test-db scripts
**Files:** `scripts/test-db-up.ps1`, `scripts/test-db-up.sh`, `scripts/test-db-down.ps1`
**What:** Download pinned cockroach Windows binary (v25.3+; record exact version + sha in script comment) to a tools dir; start single-node `--insecure` on :26257 with fixed data dir; idempotent (running instance detected, not duplicated).
**Verify:** `cockroach sql -e "SELECT version()"` returns; re-running the script is a no-op.
**Commit:** `chore: local cockroach test-db scripts (pinned v25.x)`

## Step 3: CRDB Cloud cluster (OPERATOR GATE: ccloud auth login is interactive)
**Files:** `scripts/spike/cloud-setup.md` (commands log)
**What:** Install ccloud CLI; operator runs `! ccloud auth login` in-session; `ccloud cluster create engram --cloud aws` (Basic/free tier, AWS region close to eu). Record connection string shape in `.env.example` (secret itself only in `.env`).
**Verify:** `ccloud cluster list` shows engram; `psql`-style connect via `cockroach sql --url $ENGRAM_DATABASE_URL` returns version.
**Commit:** `docs: cloud cluster setup log (ccloud)`

## Step 4: SPIKE - vector index E2E on BOTH local and serverless
**Files:** `scripts/spike/vector-spike.ts`, `scripts/spike/RESULTS.md`
**What:** Create throwaway table with `VECTOR(1024)`; `CREATE VECTOR INDEX`; insert 1k random vectors; ANN query with scope_id filter; EXPLAIN to confirm index use; measure p50 latency. Settle exact syntax + whether scope prefilter needs index config. Run against local AND cloud.
**Verify:** `RESULTS.md` records: syntax that worked, EXPLAIN output, p50 both targets. Index confirmed used (not full scan).
**Commit:** `spike: CRDB vector index E2E (syntax + latency, local + serverless)`

## Step 5: SPIKE - AS OF SYSTEM TIME + GC window measurement
**Files:** extend `scripts/spike/vector-spike.ts` or `scripts/spike/timetravel-spike.ts`, `RESULTS.md`
**What:** Write row, update it, read `AS OF SYSTEM TIME` between the two; then query intentionally past the GC window on serverless and record the exact error (this error string gates the fallback in `timetravel.ts`). Confirm actual serverless GC TTL empirically (SHOW ZONE CONFIGURATION).
**Verify:** `RESULTS.md` records measured TTL + the past-window error text.
**Commit:** `spike: AS OF SYSTEM TIME semantics + measured GC window`

## Step 6: SPIKE - Bedrock access (OPERATOR GATE: IAM policy)
**Files:** `scripts/spike/bedrock-spike.ts`, `RESULTS.md`
**What:** Operator attaches Bedrock policy (or provides admin profile) + enables model access for Claude + Titan Embeddings V2 in one region. Spike: one Titan embed call (assert 1024 floats) + one Claude chat call. If blocked > half a day: flip `docs/PRD.md` AWS story to Lambda-only + local embeddings fallback (feature-flagged), record decision.
**Verify:** `RESULTS.md` records region, model IDs, latency, cost estimate per call.
**Commit:** `spike: bedrock titan+claude E2E (region + model ids pinned)`

## Step 7: Migration runner + core schema
**Files:** `src/migrate.ts`, `migrations/0001_core.sql`, `src/db.ts`
**What:** Tiny ordered runner (schema_migrations table). 0001: scopes, memories (with VECTOR 1024 + vector index syntax from Step 4 + secondary decay-sweep index), memory_versions, recall_log, sessions, turns - composite PKs/FKs with scope_id throughout; CHECK constraints per ARCHITECTURE.md. Column names checked against CRDB reserved words.
**Verify:** `npx tsx src/migrate.ts` clean on fresh local db; re-run is no-op; `SHOW CREATE TABLE memories` matches doc.
**Commit:** `feat: migration runner + core schema (0001)`

## Step 8: Versioned store - remember/get
**Files:** `src/store/memories.ts`, `src/ulid.ts`, `tests/memories.test.ts`
**What:** `remember()` (insert memory + version row, same tx), `getMemory()`, strength/decay math helpers (`strengthAt(t)`). ENGRAM_FAKE_BEDROCK deterministic embedding stub in `src/embeddings.ts`.
**Verify:** tests: remember writes exactly 1 memories row + 1 versions row atomically; decay math matches hand-computed values; parallel scopes isolated.
**Commit:** `feat: versioned memory writer + decay math`

## Step 9: Vector recall + provenance
**Files:** `src/store/memories.ts` (recall), `src/store/provenance.ts`, `tests/recall.test.ts`
**What:** `recall()`: ANN k-NN scope-filtered in SQL, strength-weighted re-rank, retrieval reinforcement (count+strength boost + version row op=retrieve_boost), recall_log write.
**Verify:** tests: planted needle recalled first; reinforcement bumps strength + writes version; recall_log row matches returned set.
**Commit:** `feat: scoped vector recall + provenance log`

## Step 10: Time travel dual-layer
**Files:** `src/store/timetravel.ts`, `tests/timetravel.test.ts`
**What:** `recallAsOf(T)`: AS OF SYSTEM TIME fast path when in-window (window constant from Step 5), versions-replay path otherwise; identical result shape. Statuses active-at-T; strength recomputed as-of-T.
**Verify:** tests: mutate a memory 3x, assert state at each historical T via BOTH paths (in-window T uses AOST, forced-replay flag covers the other).
**Commit:** `feat: dual-layer time travel (AOST + versions replay)`

## Step 11: Consolidation (sleep)
**Files:** `src/store/consolidate.ts`, `src/llm.ts`, `tests/consolidate.test.ts`
**What:** Cluster episodic memories by vector similarity (SQL, threshold), LLM-merge each cluster into one semantic memory (FAKE_BEDROCK: deterministic merge), mark sources status=consolidated + consolidated_into, version rows op=consolidate.
**Verify:** tests: 3 similar episodics -> 1 semantic with lineage; unrelated memory untouched; versions trace the merge.
**Commit:** `feat: episodic-to-semantic consolidation`

## Step 12: Phase-1 wrap - README + plan for Phase 2
**Files:** `README.md` (real setup steps, tool-mapping table v1), `docs/plans/2026-08-11-phase-2-agent-api.md`
**What:** README quickstart works from clean clone; generate Phase 2 plan.
**Verify:** Fresh-clone dry run: `npm i && scripts/test-db-up && npx tsx src/migrate.ts && node --test` all green.
**Commit:** `docs: phase-1 wrap (readme quickstart) + phase-2 plan`

---

## Later phases (one-line scope; dated plan each when reached)
- **Phase 2 (agent + API):** Hono routes, demo agent loop (recall -> Claude -> remember), sessions/turns, fact-extraction prompt, local chat E2E.
- **Phase 3 (surfaces):** dashboard.html (browser, decay curves, lineage, provenance, time-travel slider, Sleep button), MCP server (remember/recall/reflect/recall_asof), CRDB managed MCP server integration for agent self-introspection.
- **Phase 4 (ship):** Lambda deploy + Function URL, seed demo data, resilience film on local 3-node, sub-3-min video (transcript-driven pipeline), README/diagram polish, Devpost submission by Aug 17.
