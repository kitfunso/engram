# Engram demo video script (target 2:50, hard cap 3:00)

Transcript-driven: record narration to THIS script, capture screen to match. One take per segment, assemble. Captions burned in. All shots at the deployed Function URL except the resilience segment (local 3-node, labelled).

## 0:00-0:25 Problem (title card + repo)
> Agents forget. Every session starts from zero, and "memory" is usually a vector store bolted on with no idea how memories should age, merge, or be audited. Engram treats agent memory as infrastructure: it is a memory engine built natively on CockroachDB, with Amazon Bedrock doing the thinking.

Shot: title card (name + one-liner), quick cut to the GitHub repo README.

## 0:25-1:00 Cross-session memory (live demo URL)
> Here is a live agent on AWS Lambda. In this session I tell it about my dog. Watch the extraction: the fact becomes an episodic memory with an embedding stored in CockroachDB. Now a completely new session: "what is my dog called?" It recalls Biscuit, and every reply carries a recall id, so you can see exactly which memories it used.

Shot: dashboard chat panel: session A remember, new session B recall, click the recall_id into the provenance panel.

## 1:00-1:55 The memory lifecycle (dashboard)
> Memories decay. Each one has a strength and a half-life; recall reinforces it, neglect fades it. These are the live decay curves. When the agent sleeps, near-duplicate episodic memories consolidate: Bedrock merges them into one semantic memory, and the lineage is preserved: click the semantic memory and you see exactly which episodics went in, with an append-only version history for every mutation.

Shot: browser table with strength bars, decay curves, click the semantic coffee memory, history timeline showing consolidate ops + sources.

## 1:55-2:20 Time travel (dashboard)
> What did the agent know yesterday? Recent history is served by CockroachDB's AS OF SYSTEM TIME, exact and fast. Beyond the garbage-collection window, Engram replays its own append-only version log. Same question, two engines, one answer: what the agent knew at time T.

Shot: time-travel panel, pick a timestamp from before the consolidation, run recall, point at the "served via" note (AOST vs replay).

## 2:20-2:40 Resilience (local 3-node, labelled "local cluster")
> Memory is infrastructure, so it should survive failure. Three nodes, and I kill one mid-conversation: requests keep flowing, because CockroachDB's replication holds quorum. Kill two and writes stall honestly; bring them back and it heals.

Shot: resilience-demo.ps1 phase banners + the request loop, node kill, OK lines continuing.

## 2:40-2:55 Architecture + tools card
> Under the hood: CockroachDB distributed vector indexing serves scoped recall through a prefix-filtered vector index; the CockroachDB Cloud managed MCP server gives any agent introspection over the cluster; and Engram itself is an MCP server, so any agent can remember and recall. Bedrock's Titan and Claude do embeddings and consolidation. It is open source, MIT, built new for this hackathon: the design follows my prior project hippo, with zero code copied.

Shot: architecture card (one static slide: CRDB tools + AWS services + MCP), EXPLAIN excerpt showing `vector search ... prefix spans`.

## 2:55-3:00 Close
> Engram: give your agents a memory that ages, consolidates, and answers for itself. Repo and live demo linked below.

Shot: close card: repo URL + demo URL.

## Production notes
- Record narration first (ElevenLabs or own voice), then screen-capture to the narration timing.
- Dashboard shots use the seeded `demo` scope on the cloud cluster (real embeddings, 1 semantic memory with lineage).
- The resilience segment must carry a visible "local 3-node cluster" label (serverless cannot kill nodes; honesty rule).
- Judging criteria checklist: 2+ CRDB tools shown by name (vector indexing @ 2:40, managed MCP @ 2:40), AWS services shown (Lambda @ 0:25, Bedrock @ 1:00/2:40), working demo URL on screen (0:25-2:20), newly-created + hippo disclosure spoken (2:40).
