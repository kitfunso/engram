# Devpost submission draft (CockroachDB x AWS: Build with Agentic Memory)

Fill the URL placeholders at submission time. Deadline 2026-08-18 17:00 EDT; target submit 2026-08-17.

## Project name
Engram

## Elevator pitch (one line)
A CockroachDB-native memory engine that gives AI agents memories that decay, consolidate, and answer for themselves.

## What it does
Engram treats agent memory as infrastructure instead of a bolted-on vector store. Memories carry strength and half-lives: recall reinforces them, neglect fades them. During sleep, near-duplicate episodic memories are merged by an LLM into semantic memories with full lineage. Every mutation writes an append-only version row in the same transaction, so the system can answer "what did the agent know at time T": recent history through CockroachDB's AS OF SYSTEM TIME, older history by replaying its own version log. Recall is scoped, ANN-served by a CockroachDB vector index, and every agent reply carries a recall id that resolves to the exact memories and strengths used. A live Bedrock-powered demo agent remembers users across sessions; a single-file dashboard shows the memory browser, decay curves, consolidation lineage, provenance, and a time-travel slider; and Engram is itself an MCP server, so any agent can use it.

## How CockroachDB tools are meaningfully integrated
1. Distributed Vector Indexing (C-SPANN): recall runs on CREATE VECTOR INDEX with a (scope_id, status, embedding) prefix so scope and liveness filters ride the index, verified by EXPLAIN showing vector search with prefix spans (migrations/0001+0002, src/store/memories.ts).
2. Cloud Managed MCP Server: the demo cluster is registered with CockroachDB Cloud's hosted MCP endpoint; any MCP client can introspect Engram's schema and data through it (README shows the registration pattern and a worked example).
3. ccloud CLI: documented ops path for cluster setup (scripts/spike/cloud-setup.md).
Also load-bearing: AS OF SYSTEM TIME (dual-layer time travel, gc.ttlseconds measured empirically at 4500s on serverless) and transactional guarantees (single-write-path audit invariant, client-side transient-retry).

## AWS services used
- Amazon Bedrock: Titan Text Embeddings V2 (1024-dim, normalized) for all embeddings; Claude for the demo agent's replies, fact extraction, and consolidation merges.
- AWS Lambda: hosts the demo agent + dashboard behind a public Function URL.

## Demo URL
<FUNCTION_URL>/dashboard (scope: demo)

## Video
<YOUTUBE_URL>

## Repo
https://github.com/kitfunso/engram (MIT, public)

## Newly-created statement + disclosure
All code was newly written during the submission period. Engram's memory model follows the design of hippo (github.com/kitfunso/hippo-memory), an open-source project by the same author; that prior work is design pedigree only and no code was copied. Disclosed in the README.

## What we learned / challenges (form field)
- Real embedding geometry beats assumptions: the consolidation threshold set before real data (0.35 L2) merged nothing; measured Titan V2 paraphrase distances (0.77-1.0) led to a 0.85 calibration, documented in code.
- AS OF SYSTEM TIME rejects bound parameters; the safe pattern is a regex-validated ISO literal, the single documented exception to parameterized-only SQL.
- A vector index prefix must carry every equality filter: adding status='active' to the WHERE clause silently dropped the planner to a full scan until status joined the index prefix.
- pg returns CockroachDB INT8 as strings; serverless GC windows (75 min) shape how far the fast time-travel path reaches.
