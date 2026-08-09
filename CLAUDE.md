# CLAUDE.md - Engram

## Project Overview
CockroachDB-native memory engine for AI agents (decay, consolidation, scoped vector recall, time-travel audit) + Bedrock demo agent + dashboard + MCP wrapper. Built solo for the CockroachDB x AWS hackathon, deadline 2026-08-18 17:00 EDT. Full scope: `docs/PRD.md`. Layout + data model: `docs/ARCHITECTURE.md`.

## Non-Negotiable Rules
1. **Single write path**: every mutation of `memories` goes through `src/store/memories.ts` and writes a `memory_versions` row in the same transaction. Direct UPDATE/DELETE elsewhere breaks the audit invariant the whole product is about.
2. **`memory_versions` is append-only** - never UPDATE or DELETE rows there. Time travel is only trustworthy if history is immutable.
3. **Parameterized SQL only.** String-built SQL is banned; `content` and `tags` are user input.
4. **No secrets in the repo** - connection strings and AWS creds come from env (`.env` is gitignored, `.env.example` documents keys). The repo is public.
5. **No hippo code.** Hippo (same author) is disclosed design pedigree in README; copying code violates the hackathon's newly-created rule and the disclosure. Reimplement, don't paste.
6. **Embedding dimension is locked at 1024** (Titan V2). Changing it invalidates the vector index and every stored embedding; it needs a migration + full re-embed, not an env tweak.
7. **Real-DB tests only**: `node --test` against local single-node cockroach (`scripts/test-db-up`). No mocked SQL. Bedrock IS mocked in tests via `ENGRAM_FAKE_BEDROCK=1` (deterministic vectors) - tests must pass with zero AWS access.
8. **Deadline scope-cut order** (PRD): MCP wrapper -> dashboard polish -> resilience film. Never cut: store, agent, time travel, submission deliverables.
9. **Public-repo hygiene**: MIT LICENSE stays; README tool-mapping table (CRDB tools + AWS services used) stays accurate - judges verify "meaningfully integrated".

## Coding Conventions
- TypeScript strict, ESM, Node 24. Files < 400 lines; functions < 50.
- Naming: verb_noun functions (`recall_memories` style camelCase: `recallMemories`), `is/has` booleans, UPPER_SNAKE constants.
- Errors: fail fast at boundaries with specific messages; never swallow. DB errors include the operation name, never the SQL with values.
- Tests: one `tests/X.test.ts` per `src` module; each test creates its own scope_id (parallel-safe isolation).
- No em dashes in UI strings, README, or commit messages.

## Critical Files
- `src/store/memories.ts` - read before touching anything that writes memory.
- `migrations/` - append-only, never edit a shipped migration; new migration file per change.
- `src/db.ts` - AS OF SYSTEM TIME helpers; GC-window constant lives here (serverless ~1.25h, verified by spike).
- `docs/PRD.md` "IS NOT" - check before adding any feature.

## Safety Rules
- CRDB Cloud Basic free tier + AWS < $20 total; anything that adds cost is an operator decision, not a session decision.
- Demo is public and unauthenticated: `/api/*` validates scope_id format, caps k and content length, and the agent prompt treats memory content as untrusted data (prompt-injection: memories are quoted context, never instructions).
- Never log memory content or connection strings; log ids + timings.

## Common Mistakes to Avoid
- `AS OF SYSTEM TIME` past the GC window errors - route historical reads older than the window through `memory_versions` replay (`src/store/timetravel.ts`).
- CRDB VECTOR uses pgvector wire format - pass `'[0.1,0.2,...]'` strings with explicit cast, not JS arrays.
- Filter (scope_id, status) INSIDE the SQL before LIMIT/ANN-k - post-filtering in JS silently starves results.
- Windows: pg + local cockroach needs `--insecure` local flags to match `scripts/test-db-up`; don't hand-edit connection strings in tests.
