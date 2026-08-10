// Generates the voiceover clips from the locked script (docs/video-script.md)
// via local Kokoro TTS, then prints each clip's real duration vs its scene
// budget. Real durations drive the edit; overruns get regenerated faster.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const voDir = path.join(here, "vo");
fs.mkdirSync(voDir, { recursive: true });

const VOICE = "bm_george";

// Narration blocks, verbatim from docs/video-script.md; budget = scene length
// implied by the script's segment boundaries. speed starts at 1.0 and is
// overridden per clip after the first measurement pass (armshith recipe:
// re-generate overruns faster rather than guessing globally).
const SEGMENTS = [
  { id: "01-problem", budget: 25, speed: 1.0, text: "Agents forget. Every session starts from zero, and memory is usually a vector store bolted on with no idea how memories should age, merge, or be audited. Engram treats agent memory as infrastructure: it is a memory engine built natively on CockroachDB, with Amazon Bedrock doing the thinking." },
  { id: "02-cross-session", budget: 35, speed: 1.0, text: "Here is a live agent on AWS Lambda. In this session I tell it about my dog. Watch the extraction: the fact becomes an episodic memory with an embedding stored in CockroachDB. Now a completely new session: what is my dog called? It recalls Biscuit, and every reply carries a recall id, so you can see exactly which memories it used." },
  { id: "03-lifecycle", budget: 55, speed: 1.0, text: "Memories decay. Each one has a strength and a half-life; recall reinforces it, neglect fades it. These are the live decay curves. When the agent sleeps, near-duplicate episodic memories consolidate: Bedrock merges them into one semantic memory, and the lineage is preserved: click the semantic memory and you see exactly which episodics went in, with an append-only version history for every mutation." },
  { id: "04-timetravel", budget: 25, speed: 1.0, text: "What did the agent know yesterday? Recent history is served by CockroachDB's AS OF SYSTEM TIME, exact and fast. Beyond the garbage collection window, Engram replays its own append-only version log. Same question, two engines, one answer: what the agent knew at time T." },
  { id: "05-resilience", budget: 20, speed: 1.0, text: "Memory is infrastructure, so it should survive failure. Three nodes, and I kill one mid-conversation: requests keep flowing, because CockroachDB's replication holds quorum. Kill two and writes stall honestly; bring them back and it heals." },
  { id: "06-architecture", budget: 20, speed: 1.0, text: "Under the hood: CockroachDB distributed vector indexing serves scoped recall through a prefix-filtered vector index; the CockroachDB Cloud managed MCP server gives any agent introspection over the cluster; and Engram itself is an MCP server. Bedrock's Titan and Claude do embeddings and consolidation. It is open source, MIT, built new for this hackathon: the design follows my prior project hippo, with zero code copied." },
  { id: "07-close", budget: 8, speed: 1.0, text: "Engram: give your agents a memory that ages, consolidates, and answers for itself. Repo and live demo linked below." },
];

const overrides = fs.existsSync(path.join(here, "vo-speeds.json"))
  ? JSON.parse(fs.readFileSync(path.join(here, "vo-speeds.json"), "utf8"))
  : {};

let total = 0;
for (const seg of SEGMENTS) {
  const speed = overrides[seg.id] ?? seg.speed;
  const out = path.join(voDir, `${seg.id}.wav`);
  // Direct node invocation of the cached pinned CLI: shell:true mangles the
  // long text args on Windows (sub-second garbage clips), and Node blocks
  // .cmd spawns without a shell (EINVAL). node + args array has neither
  // problem. Path = the npx cache of the project's pinned 0.7.105.
  const CLI = "C:/Users/skf_s/AppData/Local/npm-cache/_npx/702923228c2ce1e6/node_modules/hyperframes/bin/hyperframes.mjs";
  const r = spawnSync("node", [CLI, "tts", seg.text, "-v", VOICE, "-s", String(speed), "-o", out], { encoding: "utf8" });
  if (r.status !== 0) { console.error(`TTS FAILED ${seg.id}:`, (r.stderr || r.stdout || "").slice(-400)); process.exit(1); }
  const probe = spawnSync("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", out], { encoding: "utf8" });
  const dur = parseFloat(probe.stdout.trim());
  total += dur;
  const flag = dur > seg.budget ? `OVER budget ${seg.budget}s -> raise speed` : `ok (budget ${seg.budget}s)`;
  console.log(`${seg.id}: ${dur.toFixed(1)}s @ s=${speed} ${flag}`);
}
console.log(`TOTAL narration: ${total.toFixed(1)}s (video cap 180s incl. gaps)`);
