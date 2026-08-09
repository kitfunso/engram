# Engram - Product Requirements Document

## One-Line Description
Engram is a CockroachDB-native memory engine that gives AI agents durable, auditable, time-travelable memory - built for the CockroachDB x AWS "Build with Agentic Memory" hackathon.

## Problem Statement
AI agents forget everything between sessions, and the common fix (a messages table + a vector store bolted together) loses what matters: memories never consolidate, never decay, and cannot be audited after the fact. When an agent acts on remembered context, nobody can answer "what did it know, and when did it know it?" Teams running agents in production need memory that survives infrastructure failure and supports forensic replay - which is exactly what a distributed SQL database with historical reads provides, and what no agent memory layer currently uses.

## Target Users
- **Hackathon judges** (primary audience): expect meaningful CockroachDB integration, working demo, clear agentic-memory design.
- **Agent developers** (product persona): TypeScript-comfortable, run agents that need memory across sessions, want SQL-inspectable memory instead of a black-box vector store.
- **Platform/ops engineers** (secondary): need the audit story - who remembered what, when, and why.

## Core Features (MVP)
1. **Memory store on CockroachDB**: episodic + semantic memories with strength, half-life decay, retrieval reinforcement; all writes versioned. (Problem: agents forget / memory is a black box.)
2. **Vector recall via CRDB Distributed Vector Indexing**: `CREATE VECTOR INDEX` (C-SPANN) over embeddings, scoped per agent/user. (Problem: recall at production scale inside the same transactional DB.)
3. **Episodic-to-semantic consolidation ("sleep")**: similar episodic memories merge into semantic memories via LLM, with provenance links. (Problem: memory that only accumulates is noise, not knowledge.)
4. **Dual-layer time travel**: `AS OF SYSTEM TIME` for live historical reads inside the GC window + append-only `memory_versions` audit table for unbounded "what did the agent believe at time T" replay. (Problem: no forensic audit of agent knowledge.)
5. **Demo agent on Amazon Bedrock**: chat agent that remembers users across sessions, records recall provenance per reply. (Problem: proves memory produces production utility.)
6. **Observability dashboard**: single-file HTML memory browser - decay curves, consolidation lineage, recall provenance, time-travel slider. (Problem: memory you cannot see is memory you cannot trust.)
7. **MCP server wrapper**: any MCP-capable agent gets Engram memory (remember/recall/reflect tools). (Problem: adoption path beyond the demo.)

## What This Product IS NOT
1. **NOT a port of hippo.** Hippo is design pedigree (same author) and is disclosed as such; Engram is new code written during the submission period. No hippo code is copied.
2. **NOT a general RAG framework.** No document chunking, web ingestion, or corpus management. Memories are agent experiences, not documents.
3. **NOT database-agnostic.** CockroachDB-only by design - the product thesis is that CRDB primitives (vector index, AS OF SYSTEM TIME, resilience) ARE the memory features. No abstraction layer for other stores.
4. **NOT a hosted SaaS.** No auth provider, billing, org management, or user signup. Scopes are API-level tenancy, not accounts.
5. **NOT an eval/benchmark suite.** No LongMemEval runs, no leaderboards. Correctness is shown by tests and the demo, not benchmark claims.
6. **NOT a multi-LLM abstraction.** Bedrock only (one embedding model, one chat model). No provider registry.
7. **NOT a polished product UI.** The dashboard is a developer observability tool; no design system, no mobile support.

## Success Metrics
- Submission complete on Devpost by **Aug 17** (24h buffer): public repo + demo URL + video < 3 min.
- **>= 2 CockroachDB tools meaningfully integrated** (vector indexing in the recall path; managed MCP server and/or ccloud in the workflow), documented in a README mapping table.
- Demo agent answers with recalled context in **< 3 s** warm, recall query **p50 < 300 ms**.
- Time-travel demo reproducibly answers "what did the agent believe at T" for T older than the GC window (via versions) AND inside it (via AS OF SYSTEM TIME).
- Video shows 3 wow moments: cross-session recall, consolidation lineage, time-travel audit (+ node-kill resilience filmed on local 3-node cluster).

## Constraints
- **Deadline:** 2026-08-18 17:00 EDT; solo entrant; ~7 working days.
- **Newly created rule:** all project code written during the submission period; pre-existing work (hippo) disclosed, not incorporated.
- **Budget:** CRDB Cloud Basic free tier; AWS costs kept < $20 (Bedrock invocations + Lambda). Any paid step needs explicit operator approval.
- **Known gaps at kickoff:** Bedrock IAM policy missing on `armsmith-provisioner`; ccloud CLI not installed; vector-index syntax unverified on serverless -> day-1 E2E spike gates the schema.
- **Scope-cut order if behind:** MCP wrapper -> dashboard polish -> resilience film. Core store + agent + time travel are never cut.
