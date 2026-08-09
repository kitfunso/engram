# Engram

Engram is a CockroachDB-native memory engine for AI agents. It manages
memory decay with half-lives, consolidates episodic memories into semantic
ones, and recalls memories with scoped vector search. It keeps a dual-layer
time-travel audit of what an agent knew and when: `AS OF SYSTEM TIME` reads
inside the GC window, and append-only `memory_versions` replay beyond it.

Built for the CockroachDB x AWS Build with Agentic Memory hackathon.

## Quickstart

Requires Node 24+. From a clean clone:

```
npm install
scripts/test-db-up.ps1   # Windows; use scripts/test-db-up.sh on Linux/macOS
npx tsx src/migrate.ts
npm test
```

Tests need zero AWS access. `ENGRAM_FAKE_BEDROCK=1` (set in `.env.example`)
makes `src/embeddings.ts` and `src/llm.ts` return deterministic fake output
instead of calling Bedrock.

## API

No auth (the demo is public and unauthenticated by design). Every route
validates `scope_id` and caps input length at the boundary; bad input
returns `400 {"error": "..."}`.

| Method | Path | Body / params | Returns |
|---|---|---|---|
| POST | `/chat` | `scope_id`, `session_id?`, `message` | `{reply, recall_id, remembered[], session_id}` |
| POST | `/api/remember` | `scope_id`, `content`, `layer?`, `tags?` | the created memory |
| POST | `/api/recall` | `scope_id`, `query`, `k?`, `as_of?` | `{recallId, memories}`, or `{memories, usedReplay}` when `as_of` is set |
| POST | `/api/sleep` | `scope_id` | consolidation result: `{clusters, consolidated, created}` |
| GET | `/api/memories?scope_id=&status=&layer=&q=` | query params | list of memories, each with `strengthNow` |
| GET | `/api/memory/:id/history?scope_id=` | query param | version history for one memory |
| GET | `/api/provenance/:recall_id?scope_id=` | query param | the recall_log entry a reply was built from |
| GET | `/dashboard` | - | `public/dashboard.html` |
| GET | `/health` | - | `{ok: true}` |

### Cross-session demo

`scripts/demo-chat.mjs` proves memory persists across sessions: one session
tells the agent a fact, a brand new session (same scope) asks about it, and
the reply surfaces the fact.

```
scripts/test-db-up.ps1     # start local CockroachDB (scripts/test-db-up.sh on Linux/macOS)
npx tsx src/server.ts      # start the local server (port 8787 by default)
node scripts/demo-chat.mjs # run the demo against it
```

## CockroachDB tools + AWS services used

| Tool / service | Where used | Status |
|---|---|---|
| CockroachDB Distributed Vector Indexing | `migrations/0001_core.sql`, `migrations/0002_vector_index_status.sql`, `src/store/memories.ts` recall | SHIPPED |
| CockroachDB Cloud Managed MCP Server | Cluster introspection integration | phase 3, registered |
| ccloud CLI | Ops/setup | optional |
| Amazon Bedrock - Titan Text Embeddings V2 + Claude | `src/embeddings.ts`, `src/llm.ts` | fake mode shipped, real path phase 2 |
| AWS Lambda | Deploy | phase 4 |

## Disclosure

Engram's memory model (decay, consolidation, scoped recall, versioned audit)
follows the design of hippo (github.com/kitfunso/hippo-memory), an
open-source project by the same author. This is design pedigree only: all
code in this repository was newly written during the hackathon submission
period. No code is copied from hippo.

## Data growth

`memory_versions` and `recall_log` are append-only and grow unbounded by
design. Fine at demo scale; retention policy is deferred post-hackathon.
