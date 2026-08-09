#!/usr/bin/env node
// Cross-session memory demo (docs/plans/2026-08-09-phase-2-agent-api.md Step
// 5): session A tells the agent a fact, a brand new session B (same scope)
// asks about it, and the reply / recalled memories surface the fact - proof
// memory persists across sessions, not just within one chat thread.
//
// This script starts nothing itself. Start the server first:
//   npx tsx src/server.ts
//
// Then run:
//   node scripts/demo-chat.mjs
//
// Optional: ENGRAM_DEMO_URL to point at a non-default server address.

const BASE_URL = process.env.ENGRAM_DEMO_URL ?? "http://localhost:8787";
const SCOPE_ID = `demo-${Date.now()}`;

async function postJson(pathname, body) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseResponse(pathname, res);
}

async function getJson(pathname) {
  const res = await fetch(`${BASE_URL}${pathname}`);
  return parseResponse(pathname, res);
}

async function parseResponse(pathname, res) {
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${pathname}: non-JSON response (status ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`${pathname}: HTTP ${res.status}: ${json.error ?? text}`);
  }
  return json;
}

async function main() {
  console.log(`engram cross-session demo - scope ${SCOPE_ID}`);
  console.log(`target: ${BASE_URL}`);

  console.log("\nsession A: remember: my dog is called Biscuit");
  const turnA = await postJson("/chat", { scope_id: SCOPE_ID, message: "remember: my dog is called Biscuit" });
  console.log(`  session_id: ${turnA.session_id}`);
  console.log(`  recall_id:  ${turnA.recall_id}`);
  console.log(`  remembered: ${JSON.stringify(turnA.remembered)}`);
  if (!turnA.remembered.some((fact) => fact.includes("Biscuit"))) {
    throw new Error(`expected session A to remember a fact about Biscuit, got: ${JSON.stringify(turnA.remembered)}`);
  }

  console.log("\nsession B (new session, same scope): what is my dog called");
  const turnB = await postJson("/chat", { scope_id: SCOPE_ID, message: "what is my dog called" });
  console.log(`  session_id: ${turnB.session_id}`);
  console.log(`  recall_id:  ${turnB.recall_id}`);
  console.log(`  reply:      ${turnB.reply}`);

  if (turnB.session_id === turnA.session_id) {
    throw new Error("session B unexpectedly reused session A's session_id");
  }

  const recall = await postJson("/api/recall", { scope_id: SCOPE_ID, query: "what is my dog called" });
  const recalledBiscuit = recall.memories.some((m) => m.content.includes("Biscuit"));
  const replyHasBiscuit = turnB.reply.includes("Biscuit");
  if (!recalledBiscuit && !replyHasBiscuit) {
    throw new Error(
      `cross-session recall failed: neither the reply nor the recalled memories mention Biscuit. ` +
        `reply="${turnB.reply}" memories=${JSON.stringify(recall.memories.map((m) => m.content))}`
    );
  }
  console.log(`\ncross-session recall confirmed (${recalledBiscuit ? "recalled memory" : "reply"} mentions Biscuit)`);

  console.log("\nrecall_id chain:");
  console.log(`  session A recall_id: ${turnA.recall_id}`);
  console.log(`  session B recall_id: ${turnB.recall_id}`);

  console.log("\nprovenance for session B's recall:");
  const provenance = await getJson(`/api/provenance/${turnB.recall_id}?scope_id=${SCOPE_ID}`);
  console.log(`  query_text: ${provenance.queryText}`);
  console.log(`  results:    ${provenance.results.length} memor${provenance.results.length === 1 ? "y" : "ies"}`);
  for (const result of provenance.results) {
    console.log(`    - ${result.memoryId} (score ${result.score.toFixed(3)}, strength ${result.strengthAtRecall.toFixed(3)})`);
  }

  console.log("\nPASS: cross-session memory demo succeeded");
}

main().catch((err) => {
  console.error(`\nFAIL: ${err.message}`);
  console.error("Is the local server running? Start it with: npx tsx src/server.ts");
  process.exit(1);
});
