// One-off live verification of the real Bedrock paths (Step 1 of
// docs/plans/2026-08-09-phase-2-agent-api.md). Run with ENGRAM_FAKE_BEDROCK
// unset/not "1" so src/embeddings.ts and src/llm.ts take their real
// branches. Prints only the embedding vector length and first 3 rounded
// values (never a full vector) and reply text - never credentials or
// connection strings (CLAUDE.md: never log secrets).
//
// Usage (PowerShell, one process only):
//   $env:ENGRAM_FAKE_BEDROCK = "0"; npx tsx scripts/spike/bedrock-live-check.ts

import { embed } from "../../src/embeddings.js";
import { chat, consolidateCluster } from "../../src/llm.js";

async function main(): Promise<void> {
  const vector = await embed("the cat sat on the mat");
  const first3 = vector.slice(0, 3).map((v) => Number(v.toFixed(4)));
  console.log(`embed: length=${vector.length} first3=${JSON.stringify(first3)}`);

  const reply = await chat({
    system: "You are a terse assistant. Answer in one short sentence.",
    messages: [{ role: "user", content: "Say hello in five words or fewer." }],
  });
  console.log(`chat reply: ${reply}`);

  const merged = await consolidateCluster([
    "the user's favourite colour is teal",
    "the user mentioned teal is their favourite colour again today",
  ]);
  console.log(`consolidateCluster: ${merged}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
