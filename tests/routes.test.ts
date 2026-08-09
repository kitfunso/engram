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

test("GET /dashboard serves the placeholder page", async () => {
  const res = await app.request("/dashboard");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Engram dashboard"));
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

// --- /api/recall ---------------------------------------------------------------

test("POST /api/recall returns the remembered memory for a matching query", async () => {
  const scopeId = newUlid();
  await postJson("/api/remember", { scope_id: scopeId, content: "my dog is called Biscuit" });

  const res = await postJson("/api/recall", { scope_id: scopeId, query: "my dog is called Biscuit", k: 3 });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.ok(body.recallId);
  assert.ok(body.memories.some((m: { content: string }) => m.content === "my dog is called Biscuit"));
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

// --- /api/sleep -----------------------------------------------------------------

test("POST /api/sleep returns a consolidation result", async () => {
  const scopeId = newUlid();
  const res = await postJson("/api/sleep", { scope_id: scopeId });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(typeof body.clusters, "number");
  assert.equal(typeof body.consolidated, "number");
  assert.ok(Array.isArray(body.created));
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

test("GET /api/provenance/:recall_id returns the recall log entry", async () => {
  const scopeId = newUlid();
  await postJson("/api/remember", { scope_id: scopeId, content: "provenance test fact" });
  const recallRes = await postJson("/api/recall", { scope_id: scopeId, query: "provenance test fact" });
  const { recallId } = await json(recallRes);

  const res = await app.request(`/api/provenance/${recallId}?scope_id=${scopeId}`);
  assert.equal(res.status, 200);
  const entry = await json(res);
  assert.equal(entry.recallId, recallId);
});

test("GET /api/provenance/:recall_id returns 404 for an unknown recall_id", async () => {
  const scopeId = newUlid();
  const res = await app.request(`/api/provenance/${newUlid()}?scope_id=${scopeId}`);
  assert.equal(res.status, 404);
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
