# Engram

Engram is a CockroachDB-native memory engine for AI agents. It handles
memory decay, episodic-to-semantic consolidation, scoped vector recall,
and time-travel audit of what an agent knew and when, all inside
CockroachDB (vector search, `AS OF SYSTEM TIME`, append-only version
history), fronted by a small Hono API, an MCP server, and a browser
dashboard.

Built for the CockroachDB x AWS Build with Agentic Memory hackathon.

## CockroachDB tools + AWS services used

| Tool / service | How it is used | Status |
|---|---|---|
| CockroachDB vector index (`VECTOR` + `CREATE VECTOR INDEX`) | Scoped ANN recall over memory embeddings | TODO |
| CockroachDB `AS OF SYSTEM TIME` | Fast-path historical reads within the GC window | TODO |
| CockroachDB Cloud (serverless) | Primary deployed database | TODO |
| Amazon Bedrock - Titan Text Embeddings V2 | 1024-dim memory embeddings | TODO |
| Amazon Bedrock - Claude | Demo agent chat + consolidation merge | TODO |
| AWS Lambda + Function URL | Hosted demo deployment | TODO |

## Disclosure

Engram is new code written during the hackathon submission period. Its
memory model (decay, consolidation, scoped recall, versioned audit) is
informed by design ideas from hippo-memory
(github.com/kitfunso/hippo-memory), an open-source project by the same
author. No code is copied from hippo; this repository is an independent
implementation built on CockroachDB.

## Quickstart

TODO: fill in once Step 7 (migrations) and Step 12 (wrap-up) land.
