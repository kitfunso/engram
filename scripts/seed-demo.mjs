#!/usr/bin/env node
// Seeds the `demo` scope with a small story arc (docs/plans/2026-08-09-phase-4-ship.md
// Step 2). Default target: CockroachDB Cloud, with REAL Bedrock embeddings/chat
// (profile h0) - pass --local to seed the local single-node cluster instead
// (offline, using whatever ENGRAM_FAKE_BEDROCK .env already sets - normally 1).
//
// Every write goes through src/store/** functions called directly (rememberMemory,
// createSession, appendTurn, sleepScope) - never HTTP - matching CLAUDE.md rule 1
// (memories.ts is the single write path) and the task brief's "api-level calls
// done directly via store functions, NOT via HTTP".
//
// Usage:
//   node scripts/seed-demo.mjs          (cloud, real Bedrock)
//   node scripts/seed-demo.mjs --local  (local cluster, fake Bedrock per .env)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const useLocal = process.argv.includes("--local");

function readDotEnv() {
  const envPath = path.join(repoRoot, ".env");
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const dotEnv = readDotEnv();

if (!useLocal) {
  const cloudUrl = dotEnv.ENGRAM_CLOUD_DATABASE_URL;
  if (!cloudUrl) {
    console.error("[seed-demo] FAIL: ENGRAM_CLOUD_DATABASE_URL not set in .env");
    process.exit(1);
  }
  // In-process env override, same pattern as scripts/deploy-lambda.mjs's env.json
  // and scripts/cloud-migrate.mjs's spawn env: set BEFORE the dynamic imports
  // below run (static top-of-file imports would execute before this script's
  // own body, per ESM import hoisting - dynamic import() is what lets this
  // override land first). src/db.ts's loadDotEnv only fills vars that are
  // still undefined, so these overrides win once db.ts loads.
  process.env.ENGRAM_DATABASE_URL = cloudUrl;
  process.env.ENGRAM_FAKE_BEDROCK = "0"; // real embeddings/chat required for a cloud seed
  process.env.AWS_REGION = process.env.AWS_REGION ?? dotEnv.AWS_REGION ?? "us-east-1";
  process.env.AWS_PROFILE = process.env.AWS_PROFILE ?? dotEnv.AWS_PROFILE ?? "h0";
}
// --local: no overrides: db.ts's own loadDotEnv fills ENGRAM_DATABASE_URL /
// ENGRAM_FAKE_BEDROCK straight from .env (local cluster, fake Bedrock).

const { rememberMemory, recallMemories } = await import("../src/store/memories.js");
const { createSession, appendTurn } = await import("../src/store/sessions.js");
const { sleepScope } = await import("../src/store/consolidate.js");
const { closePool } = await import("../src/db.js");

const SCOPE_ID = "demo";
const CONSOLIDATE_THRESHOLD = 0.35; // src/store/consolidate.ts's DEFAULT_SIMILARITY_THRESHOLD

// Fictional persona story arc: identity, dog, job, city, project, and a
// cluster of near-duplicate coffee-order facts meant to consolidate into one
// semantic memory. Indices 5-8 are the near-duplicates (COFFEE_INDICES below).
const EPISODIC_FACTS = [
  "My name is Priya Sharma.",
  "I have a dog named Biscuit, a golden retriever.",
  "I work as a backend engineer at a fintech startup called Ledgerly.",
  "I live in Austin, Texas.",
  "I'm currently leading the project to migrate our legacy Postgres database to CockroachDB.",
  "I prefer dark roast coffee over light roast.",
  "My go-to coffee order is an oat milk flat white.",
  "Every morning before work I get a flat white with oat milk.",
  "I usually order a dark roast oat milk flat white on my way into the office.",
  "On weekends I like to take Biscuit for long walks along Lady Bird Lake.",
  "I'm allergic to shellfish.",
  "My favorite programming language is Go, though I write a lot of TypeScript at work.",
  "I'm training for a half marathon this fall.",
  "I keep a running list of CockroachDB gotchas we've hit during the migration.",
];
const COFFEE_INDICES = [5, 6, 7, 8];

function l2(a, b) {
  return Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));
}

async function main() {
  console.log(`[seed-demo] target=${useLocal ? "local" : "cloud"} bedrock=${useLocal ? "per .env" : "real"} scope=${SCOPE_ID}`);

  const inserted = [];
  for (const content of EPISODIC_FACTS) {
    inserted.push(await rememberMemory({ scopeId: SCOPE_ID, content, layer: "episodic", origin: "seed" }));
  }
  console.log(`[seed-demo] inserted ${inserted.length} episodic memories`);

  // Session A: a coffee-order question, answered with a real recallMemories()
  // call so a recall_log row (+ provenance link on the turn) exists.
  const sessionA = await createSession(SCOPE_ID);
  const recall = await recallMemories({ scopeId: SCOPE_ID, query: "what is my usual coffee order", k: 5 });
  await appendTurn({ scopeId: SCOPE_ID, sessionId: sessionA, role: "user", content: "what's my usual coffee order?" });
  await appendTurn({
    scopeId: SCOPE_ID,
    sessionId: sessionA,
    role: "assistant",
    content: "An oat milk flat white, usually dark roast.",
    recallId: recall.recallId,
  });
  console.log(`[seed-demo] session A: 2 turns, recall_id=${recall.recallId}, ${recall.memories.length} memories recalled`);

  // Session B: a plain check-in, no recall tie - exercises turns without a
  // recall_log FK on every row (recall_id is nullable by design).
  const sessionB = await createSession(SCOPE_ID);
  await appendTurn({ scopeId: SCOPE_ID, sessionId: sessionB, role: "user", content: "how's the CockroachDB migration going?" });
  await appendTurn({
    scopeId: SCOPE_ID,
    sessionId: sessionB,
    role: "assistant",
    content: "Still in progress - tracking gotchas as we hit them.",
  });
  await appendTurn({ scopeId: SCOPE_ID, sessionId: sessionB, role: "user", content: "remind me to take Biscuit to the vet this week" });
  console.log(`[seed-demo] session B: 3 turns`);

  // Pairwise L2 distances among the near-duplicate coffee memories, from
  // their real stored embeddings (rememberMemory's return value, not
  // re-embedded) - reported unconditionally per the task brief, not just
  // when sleepScope finds 0 clusters.
  const coffeeMemories = COFFEE_INDICES.map((i) => inserted[i]);
  console.log(`[seed-demo] coffee-memory pairwise L2 distances (consolidate threshold = ${CONSOLIDATE_THRESHOLD}):`);
  for (let i = 0; i < coffeeMemories.length; i++) {
    for (let j = i + 1; j < coffeeMemories.length; j++) {
      const d = l2(coffeeMemories[i].embedding, coffeeMemories[j].embedding);
      console.log(`  [${COFFEE_INDICES[i]}]-[${COFFEE_INDICES[j]}]: ${d.toFixed(4)}${d <= CONSOLIDATE_THRESHOLD ? "  (within threshold)" : ""}`);
    }
  }

  const sleep = await sleepScope({ scopeId: SCOPE_ID });
  console.log(
    `[seed-demo] sleepScope: ${sleep.clusters} cluster(s) >= min size, ${sleep.consolidated} source memor${
      sleep.consolidated === 1 ? "y" : "ies"
    } consolidated, ${sleep.created.length} semantic memor${sleep.created.length === 1 ? "y" : "ies"} created`
  );
  if (sleep.created.length === 0) {
    console.log(
      "[seed-demo] NOTE: sleepScope created 0 semantic memories - see the pairwise distances above against the " +
        `${CONSOLIDATE_THRESHOLD} threshold. Not silently tuning the threshold; reporting as-is.`
    );
  }

  console.log(
    `[seed-demo] done: scope=${SCOPE_ID} episodic_active=${inserted.length - sleep.consolidated} ` +
      `consolidated=${sleep.consolidated} semantic=${sleep.created.length} sessions=2 turns=5 recall_log_rows=1`
  );
}

main()
  .catch((err) => {
    console.error("[seed-demo] FAIL:", err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(closePool);
