# Engram - Architecture

## System Overview
```
                       +--------------------+
  Chat UI / curl  ---> |  Hono HTTP app     | ---> Amazon Bedrock (Claude chat +
  Dashboard (HTML) --> |  (Node 24, TS)     |       Titan embeddings)
  MCP clients  ------> |  MCP server (SDK)  |
                       +---------+----------+
                                 |  pg (node-postgres, pooled)
                                 v
                       +--------------------+
                       |   CockroachDB      |  memories (VECTOR 1024 + C-SPANN index)
                       |   Cloud Basic      |  memory_versions (append-only audit)
                       |   (serverless)     |  recall_log, scopes, sessions, turns
                       +--------------------+
  Local dev/tests: single-node cockroach binary (scripts/test-db-up)
  Resilience film: local 3-node cluster, kill a node mid-conversation
```

## Tech Stack
| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Language | TypeScript (Node 24, ESM) | Solo speed; matches author's toolchain |
| DB | CockroachDB Cloud Basic (serverless) | Hackathon requirement; vector index + AS OF SYSTEM TIME are product features |
| DB driver | `pg` (node-postgres) | CRDB-documented client; pgvector-compatible wire format for VECTOR |
| HTTP | Hono | Tiny, TS-native, same code runs local Node server and AWS Lambda adapter |
| LLM + embeddings | Amazon Bedrock: Claude (chat), Titan Text Embeddings V2 @ 1024 dims | One AWS service covers both; single provider (PRD IS-NOT #6) |
| MCP | `@modelcontextprotocol/sdk` | Official SDK; stdio + HTTP transports |
| Dashboard | Single-file static HTML + vanilla JS + inline SVG | HTML-first; no build step; served by the same app |
| Tests | `node --test` against real local cockroach | Real-DB convention; zero test-framework deps |
| Deploy | AWS Lambda + Function URL (Hono adapter) | Cheap persistent demo URL; Lambda = 2nd AWS service |
| Migrations | Plain SQL files + tiny runner (`src/migrate.ts`) | Small enough not to need a framework (search-first: node-pg-migrate overkill at 2 migrations) |

## Repository Structure
```
engram/
  CLAUDE.md                # AI session rules (this repo)
  LICENSE                  # MIT (hackathon requirement)
  README.md                # pitch, setup, CRDB/AWS tool mapping table, hippo disclosure
  package.json
  docs/
    PRD.md                 # scope guard
    ARCHITECTURE.md        # this file
    plans/                 # dated implementation plans
  migrations/              # 000N_*.sql, ordered, append-only
  scripts/
    test-db-up.ps1         # start local single-node cockroach for tests (Windows)
    test-db-up.sh          # same, POSIX
    spike/                 # day-1 E2E spike scripts (vector index, GC TTL, Bedrock)
  src/
    db.ts                  # pg pool, connection config, AS OF SYSTEM TIME helpers
    migrate.ts             # migration runner
    embeddings.ts          # Bedrock Titan client (1024-dim, batched)
    llm.ts                 # Bedrock Claude client (chat + consolidation prompts)
    store/
      memories.ts          # versioned writer + recall (THE only write path to memories)
      consolidate.ts       # sleep job: cluster episodics -> semantic merge via LLM
      timetravel.ts        # recallAsOf: AS OF SYSTEM TIME fast path + versions replay
      provenance.ts        # recall_log writer/reader
    agent/
      agent.ts             # demo agent loop: recall -> prompt -> reply -> remember
      routes.ts            # Hono routes: /chat, /api/* (dashboard JSON), /dashboard
    mcp/
      server.ts            # MCP tools: remember, recall, reflect, recall_asof
    server.ts              # local Node entry
    lambda.ts              # AWS Lambda entry (Hono adapter)
  public/
    dashboard.html         # single-file observability dashboard
  tests/                   # *.test.ts, real-DB, one file per module
```

## Data Model
All tables carry `scope_id` (tenant/agent isolation). Join/child tables use composite FKs including `scope_id`.

- **scopes** (`scope_id` STRING PK, `name`, `created_at`)
- **memories** (`scope_id`, `memory_id` STRING ULID, PK(`scope_id`,`memory_id`); `content` TEXT; `embedding` VECTOR(1024); `layer` STRING CHECK in (episodic, semantic); `strength` FLOAT; `half_life_days` FLOAT; `retrieval_count` INT; `created_at`, `last_retrieved_at` TIMESTAMPTZ; `origin` STRING (avoids any reserved-word ambiguity - checked against CRDB keyword list at migration time); `tags` JSONB; `status` STRING CHECK in (active, consolidated, deleted); `consolidated_into` STRING NULL, composite FK -> memories)
  - `CREATE VECTOR INDEX ... ON memories (embedding)` - exact syntax + scope prefiltering settled by the day-1 spike (per-scope filter in query vs index config).
  - Secondary index (`scope_id`, `status`, `last_retrieved_at`) for decay sweeps (filter pushed into SQL before any LIMIT).
- **memory_versions** (append-only; `scope_id`, `version_id` ULID PK-part, `memory_id`, `op` STRING CHECK in (insert, update, retrieve_boost, consolidate, decay, delete), `snapshot` JSONB (full row), `actor` STRING, `at` TIMESTAMPTZ; composite FK -> memories). Transaction-time history. Never updated, never deleted.
- **recall_log** (`scope_id`, `recall_id` ULID, `query_text`, `query_embedding_hash`, `results` JSONB [{memory_id, distance, strength_at_recall}], `at`; composite FK -> scopes). Feeds provenance + "what did the agent know".
- **sessions / turns** (demo agent conversation state; `scope_id`, ids, `role`, `content`, `recall_id` NULL FK, timestamps). Transactional task-state story.

**Time semantics (valid-time vs transaction-time):** `memory_versions.at` is transaction time; `recallAsOf(T)` uses `AS OF SYSTEM TIME T` when `now() - T < GC window` (fast, exact) else replays `memory_versions` (`at <= T`, latest version per memory, statuses active-at-T only). Granularity: TIMESTAMPTZ microseconds. Decayed-but-not-swept memories are included with their strength as-of-T recomputed from the snapshot.

## API Design
No auth (PRD IS-NOT #4); scope_id is an explicit parameter; the Lambda URL is rate-limited by AWS defaults. Parameterized SQL only.
- `POST /chat` {scope_id, session_id, message} -> {reply, recall_id, remembered[]}
- `POST /api/remember` {scope_id, content, layer?, tags?}
- `POST /api/recall` {scope_id, query, k?, as_of?}
- `POST /api/sleep` {scope_id} - trigger consolidation (dashboard "Sleep now" button)
- `GET /api/memories?scope_id=&status=` - dashboard browser
- `GET /api/memory/:id/history?scope_id=` - version lineage
- `GET /api/provenance/:recall_id?scope_id=` - what a reply was built from
- `GET /dashboard` - serves public/dashboard.html
- MCP tools mirror the API: `remember`, `recall`, `reflect` (sleep), `recall_asof`.

## Service Boundaries
- `src/store/**` owns ALL SQL against memories/memory_versions/recall_log. Nothing else writes these tables; `memories.ts` is the single versioned write path (audit invariant).
- `src/agent/**` owns conversation flow and prompts; it calls store + llm, never SQL.
- `src/mcp/**` is a thin adapter over store; no business logic.
- `src/embeddings.ts` / `src/llm.ts` own every Bedrock call; mockable for tests (env `ENGRAM_FAKE_BEDROCK=1` returns deterministic vectors/replies so the test suite runs without AWS).

## Data Flow (primary use case: agent reply with memory)
1. `/chat` receives message -> `embeddings.ts` embeds query (Titan).
2. `store/memories.recall`: vector ANN query (scope-filtered, strength-weighted re-rank) -> writes `recall_log` row.
3. `agent.ts` builds prompt: recalled memories + session turns -> Bedrock Claude -> reply.
4. `agent.ts` extracts memorable facts from the exchange -> `store/memories.remember` (versioned insert + embedding).
5. Reply returns with `recall_id`; dashboard provenance view resolves it to the exact memories and strengths used. Periodic/manual `sleep` consolidates; every mutation lands one `memory_versions` row.
