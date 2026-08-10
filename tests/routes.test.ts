// Real-DB tests against local CockroachDB (CLAUDE.md rule 7), driven via
// Hono's app.request() - no listening socket needed. Bedrock is mocked via
// ENGRAM_FAKE_BEDROCK=1. Each test creates its own unique scope_id so
// parallel runs stay isolated.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { app } from "../src/agent/routes.js";
import { closePool } from "../src/db.js";
import { newUlid } from "../src/ulid.js";

after(async () => {
  await closePool();
});

async function postJson(pathname: string, body: unknown): Promise<Response> {
  return app.request(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Response bodies are ad-hoc JSON shapes owned by src/agent/routes.ts, not
// typed DTOs - `any` here keeps the tests reading each field directly rather
// than re-declaring a parallel type per route just to satisfy the compiler.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}

// --- health / 404 / dashboard ----------------------------------------------

test("GET /health returns ok", async () => {
  const res = await app.request("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
});

test("unknown route returns 404 JSON", async () => {
  const res = await app.request("/nope");
  assert.equal(res.status, 404);
  const body = await json(res);
  assert.equal(body.error, "not found");
});

test("GET /dashboard serves the observability dashboard", async () => {
  const res = await app.request("/dashboard");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Engram"));
});

// --- /api/remember -----------------------------------------------------------

test("POST /api/remember creates a memory and returns it", async () => {
  const scopeId = newUlid();
  const res = await postJson("/api/remember", { scope_id: scopeId, content: "the sky is blue" });
  assert.equal(res.status, 200);
  const memory = await json(res);
  assert.equal(memory.scopeId, scopeId);
  assert.equal(memory.content, "the sky is blue");
  assert.equal(memory.layer, "episodic");
  assert.equal("embedding" in memory, false, "response must not include the raw embedding");
});

test("POST /api/remember rejects a malformed scope_id", async () => {
  const res = await postJson("/api/remember", { scope_id: "bad scope!", content: "x" });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.ok(body.error);
});

test("POST /api/remember rejects content over the length cap", async () => {
  const scopeId = newUlid();
  const res = await postJson("/api/remember", { scope_id: scopeId, content: "x".repeat(8193) });
  assert.equal(res.status, 400);
});

test("POST /api/remember rejects more than 16 tags", async () => {
  const scopeId = newUlid();
  const res = await postJson("/api/remember", {
    scope_id: scopeId,
    content: "x",
    tags: Array.from({ length: 17 }, (_, i) => `tag${i}`),
  });
  assert.equal(res.status, 400);
});

test("POST /api/remember rejects a non-string tag", async () => {
  const scopeId = newUlid();
  const res = await postJson("/api/remember", { scope_id: scopeId, content: "x", tags: ["ok", 42] });
  assert.equal(res.status, 400);
});

test("POST /api/remember rejects tags whose JSON exceeds the size cap", async () => {
  const scopeId = newUlid();
  const res = await postJson("/api/remember", { scope_id: scopeId, content: "x", tags: ["a".repeat(1100)] });
  assert.equal(res.status, 400);
});

test("POST /api/remember accepts exactly 16 short string tags", async () => {
  const scopeId = newUlid();
  const res = await postJson("/api/remember", {
    scope_id: scopeId,
    content: "x",
    tags: Array.from({ length: 16 }, (_, i) => `tag${i}`),
  });
  assert.equal(res.status, 200);
});

// --- /api/recall ---------------------------------------------------------------

test("POST /api/recall returns the remembered memory for a matching query", async () => {
  const scopeId = newUlid();
  await postJson("/api/remember", { scope_id: scopeId, content: "my dog is called Biscuit" });

  const res = await postJson("/api/recall", { scope_id: scopeId, query: "my dog is called Biscuit", k: 3 });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.ok(body.recallId);
  assert.ok(body.memories.some((m: { content: string }) => m.content === "my dog is called Biscuit"));
  assert.ok(
    body.memories.every((m: Record<string, unknown>) => !("embedding" in m)),
    "recall response must not include raw embeddings"
  );
});

test("POST /api/recall with as_of routes to a historical (timetravel) read", async () => {
  const scopeId = newUlid();
  await postJson("/api/remember", { scope_id: scopeId, content: "as of test fact" });

  const res = await postJson("/api/recall", {
    scope_id: scopeId,
    query: "as of test fact",
    as_of: new Date().toISOString(),
  });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(typeof body.usedReplay, "boolean");
  assert.equal(typeof body.truncated, "boolean");
  assert.ok(Array.isArray(body.memories));
});

test("POST /api/recall rejects k above the cap", async () => {
  const scopeId = newUlid();
  const res = await postJson("/api/recall", { scope_id: scopeId, query: "x", k: 21 });
  assert.equal(res.status, 400);
});

test("POST /api/recall rejects a malformed as_of", async () => {
  const scopeId = newUlid();
  const res = await postJson("/api/recall", { scope_id: scopeId, query: "x", as_of: "not-a-date" });
  assert.equal(res.status, 400);
});

test("POST /api/recall rejects an as_of timestamp in the future", async () => {
  const scopeId = newUlid();
  const future = new Date(Date.now() + 60_000).toISOString();
  const res = await postJson("/api/recall", { scope_id: scopeId, query: "x", as_of: future });
  assert.equal(res.status, 400);
});

// --- /api/sleep -----------------------------------------------------------------

test("POST /api/sleep returns a consolidation result", async () => {
  const scopeId = newUlid();
  const res = await postJson("/api/sleep", { scope_id: scopeId });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(typeof body.clusters, "number");
  assert.equal(typeof body.consolidated, "number");
  assert.ok(Array.isArray(body.created));
  assert.equal(body.candidatesTruncated, false, "a fresh scope is well under MAX_CANDIDATES");
  assert.equal(body.clustersSkipped, 0, "a fresh scope has no clusters to skip");
});

// --- /api/memories, /api/memory/:id/history, /api/provenance/:recall_id -------

test("GET /api/memories lists memories for a scope, filtered by q", async () => {
  const scopeId = newUlid();
  await postJson("/api/remember", { scope_id: scopeId, content: "apples are red" });
  await postJson("/api/remember", { scope_id: scopeId, content: "bananas are yellow" });

  const res = await app.request(`/api/memories?scope_id=${scopeId}&q=apples`);
  assert.equal(res.status, 200);
  const memories = await json(res);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content, "apples are red");
  assert.equal(typeof memories[0].strengthNow, "number");
  assert.equal("embedding" in memories[0], false, "response must not include the raw embedding");
});

test("GET /api/memories rejects an invalid status filter", async () => {
  const scopeId = newUlid();
  const res = await app.request(`/api/memories?scope_id=${scopeId}&status=bogus`);
  assert.equal(res.status, 400);
});

test("GET /api/memory/:id/history returns the insert version", async () => {
  const scopeId = newUlid();
  const created = await json(await postJson("/api/remember", { scope_id: scopeId, content: "history test" }));

  const res = await app.request(`/api/memory/${created.memoryId}/history?scope_id=${scopeId}`);
  assert.equal(res.status, 200);
  const history = await json(res);
  assert.equal(history.length, 1);
  assert.equal(history[0].op, "insert");
});

test("GET /api/provenance/:recall_id returns the recall log entry joined to current memory content", async () => {
  const scopeId = newUlid();
  await postJson("/api/remember", { scope_id: scopeId, content: "provenance test fact" });
  const recallRes = await postJson("/api/recall", { scope_id: scopeId, query: "provenance test fact" });
  const { recallId } = await json(recallRes);

  const res = await app.request(`/api/provenance/${recallId}?scope_id=${scopeId}`);
  assert.equal(res.status, 200);
  const entry = await json(res);
  assert.equal(entry.recallId, recallId);
  assert.ok(entry.results.length > 0);
  assert.ok(
    entry.results.some((r: { content: string }) => r.content === "provenance test fact"),
    "provenance results must join to current memory content"
  );
});

test("GET /api/provenance/:recall_id returns 404 for an unknown recall_id", async () => {
  const scopeId = newUlid();
  const res = await app.request(`/api/provenance/${newUlid()}?scope_id=${scopeId}`);
  assert.equal(res.status, 404);
});

// --- /api/introspect ---------------------------------------------------------

test("GET /api/introspect returns engine stats for a scope", async () => {
  const scopeId = newUlid();
  await postJson("/api/remember", { scope_id: scopeId, content: "introspect fact one" });
  await postJson("/api/remember", { scope_id: scopeId, content: "introspect fact two" });
  await postJson("/api/recall", { scope_id: scopeId, query: "introspect fact one" });

  const res = await app.request(`/api/introspect?scope_id=${scopeId}`);
  assert.equal(res.status, 200);
  const stats = await json(res);
  assert.equal(stats.counts.byLayer.episodic, 2);
  assert.equal(stats.counts.byStatus.active, 2);
  assert.equal(typeof stats.versionsCount, "number");
  assert.ok(stats.versionsCount >= 2);
  assert.equal(typeof stats.recallCount, "number");
  assert.ok(stats.recallCount >= 1);
  assert.equal(typeof stats.sessionsCount, "number");
  assert.equal(typeof stats.turnsCount, "number");
  assert.equal(typeof stats.gcWindowMs, "number");
  assert.equal(stats.embeddingDim, 1024);
});

test("GET /api/introspect rejects a malformed scope_id", async () => {
  const res = await app.request(`/api/introspect?scope_id=${encodeURIComponent("bad scope!")}`);
  assert.equal(res.status, 400);
});

// --- /chat -----------------------------------------------------------------

test("POST /chat creates a session when session_id is omitted", async () => {
  const scopeId = newUlid();
  const res = await postJson("/chat", { scope_id: scopeId, message: "hello there" });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.ok(body.session_id);
  assert.ok(body.recall_id);
  assert.ok(Array.isArray(body.remembered));
  assert.equal(typeof body.reply, "string");
});

test("POST /chat surfaces a fact remembered in one session to a new session (same scope)", async () => {
  const scopeId = newUlid();
  await postJson("/chat", { scope_id: scopeId, message: "remember: my dog is called Biscuit" });

  const res = await postJson("/chat", { scope_id: scopeId, message: "what is my dog called" });
  const body = await json(res);
  assert.ok(body.reply.includes("Biscuit"), `expected reply to surface Biscuit, got: ${body.reply}`);
});

test("POST /chat rejects a missing message", async () => {
  const scopeId = newUlid();
  const res = await postJson("/chat", { scope_id: scopeId });
  assert.equal(res.status, 400);
});

test("POST /chat rejects a malformed scope_id", async () => {
  const res = await postJson("/chat", { scope_id: "bad!", message: "hi" });
  assert.equal(res.status, 400);
});

test("POST /chat rejects a malformed session_id when provided", async () => {
  const scopeId = newUlid();
  const res = await postJson("/chat", { scope_id: scopeId, message: "hi", session_id: "not a valid id!" });
  assert.equal(res.status, 400);
});

test("POST /chat rejects a well-formed but unknown session_id before any extraction side effects run", async () => {
  const scopeId = newUlid();
  const res = await postJson("/chat", { scope_id: scopeId, message: "remember: this must never be written", session_id: newUlid() });
  assert.equal(res.status, 400);

  // Confirms extraction never ran: no memory exists for this fresh scope.
  const memoriesRes = await app.request(`/api/memories?scope_id=${scopeId}`);
  const memories = await json(memoriesRes);
  assert.equal(memories.length, 0, "an unknown session_id must be rejected before handleChat's side effects run");
});

test("POST /chat accepts a session_id created via a prior /chat call", async () => {
  const scopeId = newUlid();
  const first = await json(await postJson("/chat", { scope_id: scopeId, message: "hello" }));
  const res = await postJson("/chat", { scope_id: scopeId, message: "hello again", session_id: first.session_id });
  assert.equal(res.status, 200);
});
