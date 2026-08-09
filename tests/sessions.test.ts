// Real-DB tests against local CockroachDB (CLAUDE.md rule 7). Each test
// creates its own unique scope_id so parallel runs stay isolated.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closePool } from "../src/db.js";
import { recallMemories, rememberMemory } from "../src/store/memories.js";
import { appendTurn, createSession, getTurns } from "../src/store/sessions.js";
import { newUlid } from "../src/ulid.js";

after(async () => {
  await closePool();
});

test("turns round-trip in chronological order", async () => {
  const scopeId = newUlid();
  const sessionId = await createSession(scopeId);

  await appendTurn({ scopeId, sessionId, role: "user", content: "hello" });
  await appendTurn({ scopeId, sessionId, role: "assistant", content: "hi there" });
  await appendTurn({ scopeId, sessionId, role: "user", content: "how are you" });

  const turns = await getTurns(scopeId, sessionId, 20);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((t) => t.content), ["hello", "hi there", "how are you"]);
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user"]);
  for (let i = 1; i < turns.length; i++) {
    assert.ok(turns[i].turnId > turns[i - 1].turnId, "turn ids must sort strictly ascending");
  }
});

test("getTurns returns the MOST RECENT `limit` turns, still ordered oldest-first", async () => {
  const scopeId = newUlid();
  const sessionId = await createSession(scopeId);
  for (let i = 0; i < 5; i++) {
    await appendTurn({ scopeId, sessionId, role: "user", content: `turn ${i}` });
  }

  const turns = await getTurns(scopeId, sessionId, 2);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => t.content), ["turn 3", "turn 4"], "expected the last 2 turns, oldest-first");
});

test("recall_id is nullable and round-trips both null and a real recall_id", async () => {
  const scopeId = newUlid();
  const sessionId = await createSession(scopeId);

  const withoutRecall = await appendTurn({ scopeId, sessionId, role: "user", content: "no recall here" });
  assert.equal(withoutRecall.recallId, null);

  await rememberMemory({ scopeId, content: "a fact to recall" });
  const { recallId } = await recallMemories({ scopeId, query: "a fact to recall", k: 1 });
  const withRecall = await appendTurn({ scopeId, sessionId, role: "assistant", content: "reply", recallId });
  assert.equal(withRecall.recallId, recallId);

  const turns = await getTurns(scopeId, sessionId, 20);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].recallId, null);
  assert.equal(turns[1].recallId, recallId);
});

test("sessions/turns are isolated by scope_id", async () => {
  const scopeA = newUlid();
  const scopeB = newUlid();
  const sessionA = await createSession(scopeA);
  const sessionB = await createSession(scopeB);

  await appendTurn({ scopeId: scopeA, sessionId: sessionA, role: "user", content: "scope A message" });
  await appendTurn({ scopeId: scopeB, sessionId: sessionB, role: "user", content: "scope B message" });

  const turnsA = await getTurns(scopeA, sessionA, 20);
  const turnsB = await getTurns(scopeB, sessionB, 20);
  assert.equal(turnsA.length, 1);
  assert.equal(turnsB.length, 1);
  assert.equal(turnsA[0].content, "scope A message");
  assert.equal(turnsB[0].content, "scope B message");

  // Composite-key filter, not session_id alone: scope A must never resolve
  // scope B's session id.
  const cross = await getTurns(scopeA, sessionB, 20);
  assert.equal(cross.length, 0);
});
