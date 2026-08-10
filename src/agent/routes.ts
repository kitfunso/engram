// Hono HTTP boundary (docs/ARCHITECTURE.md API Design + Service Boundaries:
// "src/agent/** owns conversation flow and prompts; it calls store + llm,
// never SQL"). This file validates every input at the boundary and calls
// agent.ts / src/store/** for everything else - it issues no SQL of its own.
// No auth by design (PRD IS-NOT #4): scope_id is an explicit parameter on
// every route, and every route validates it plus the other boundary rules
// below (CLAUDE.md Safety Rules).

import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { Context } from "hono";

import { handleChat } from "./agent.js";
import { recallMemories, rememberMemory } from "../store/memories.js";
import { listMemories } from "../store/list.js";
import { recallAsOf } from "../store/timetravel.js";
import { sleepScope } from "../store/consolidate.js";
import { getMemoryHistory, getRecallWithContent } from "../store/provenance.js";
import { getIntrospectStats } from "../store/introspect.js";
import { createSession, sessionExists } from "../store/sessions.js";
import {
  MAX_CONTENT_LEN,
  MAX_QUERY_LEN,
  ValidationError,
  badRequest,
  optionalK,
  optionalLayer,
  optionalStatus,
  optionalTags,
  optionalText,
  parseAsOf,
  requireId,
  requireText,
} from "../validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// Resolves public/dashboard.html two ways, same reasoning as
// src/db.ts's resolveCaPath: esbuild bundling collapses this file's
// import.meta.url into the bundle's own location, so `here` stops meaning
// "src/agent" once scripts/deploy-lambda.mjs bundles src/lambda.ts (which
// imports this route table) into dist/lambda-package/index.mjs. The deploy
// script copies public/dashboard.html to a `public/` sibling of that bundle,
// so trying `here`-relative first resolves correctly in the Lambda zip
// (/var/task/public/dashboard.html); the repoRoot-relative fallback is the
// path that resolves when running from src/ directly (local dev, tests).
function resolveDashboardPath(): string {
  const candidates = [path.join(here, "public", "dashboard.html"), path.join(repoRoot, "public", "dashboard.html")];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[candidates.length - 1];
}

const DASHBOARD_PATH = resolveDashboardPath();

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    badRequest("request body must be valid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    badRequest("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

// Route-boundary response mapper: every store Memory carries its full
// 1024-float embedding (needed internally for recall/consolidation), but no
// API response should ship it - it is large, write-only from the client's
// perspective, and never rendered by the dashboard. Strips it at the one
// place responses leave the store layer, rather than teaching every route
// (or the store) about response shaping.
function toApiMemory<T extends { embedding: number[] }>(memory: T): Omit<T, "embedding"> {
  const { embedding, ...rest } = memory;
  return rest;
}

export const app = new Hono();

app.post("/chat", async (c) => {
  const body = await readJsonBody(c);
  const scopeId = requireId(body.scope_id, "scope_id");
  const message = requireText(body.message, "message", MAX_CONTENT_LEN);

  let sessionId: string;
  if (body.session_id !== undefined) {
    sessionId = requireId(body.session_id, "session_id");
    // Verified up front, before handleChat runs: an unknown session_id
    // would otherwise only surface as an FK violation on the turn INSERT at
    // the end of handleChat, after its recall/chat/extraction side effects
    // (including new memories written by extraction) already landed.
    if (!(await sessionExists(scopeId, sessionId))) {
      badRequest("session_id not found for this scope");
    }
  } else {
    sessionId = await createSession(scopeId);
  }

  const result = await handleChat({ scopeId, sessionId, message });
  return c.json({
    reply: result.reply,
    recall_id: result.recallId,
    remembered: result.remembered,
    session_id: sessionId,
  });
});

app.post("/api/remember", async (c) => {
  const body = await readJsonBody(c);
  const scopeId = requireId(body.scope_id, "scope_id");
  const content = requireText(body.content, "content", MAX_CONTENT_LEN);
  const layer = optionalLayer(body.layer);
  const tags = optionalTags(body.tags);

  const memory = await rememberMemory({ scopeId, content, layer, tags });
  return c.json(toApiMemory(memory));
});

app.post("/api/recall", async (c) => {
  const body = await readJsonBody(c);
  const scopeId = requireId(body.scope_id, "scope_id");
  const query = requireText(body.query, "query", MAX_QUERY_LEN);
  const k = optionalK(body.k);
  const asOf = parseAsOf(body.as_of);

  if (asOf) {
    const result = await recallAsOf({ scopeId, query, at: asOf, k });
    return c.json({ memories: result.memories.map(toApiMemory), usedReplay: result.usedReplay, truncated: result.truncated });
  }
  const result = await recallMemories({ scopeId, query, k });
  return c.json({ recallId: result.recallId, memories: result.memories.map(toApiMemory) });
});

app.post("/api/sleep", async (c) => {
  const body = await readJsonBody(c);
  const scopeId = requireId(body.scope_id, "scope_id");
  const result = await sleepScope({ scopeId });
  return c.json(result);
});

app.get("/api/memories", async (c) => {
  const scopeId = requireId(c.req.query("scope_id"), "scope_id");
  const status = optionalStatus(c.req.query("status"));
  const layer = optionalLayer(c.req.query("layer"));
  const q = optionalText(c.req.query("q"), "q", MAX_QUERY_LEN);

  const memories = await listMemories({ scopeId, status, layer, q });
  return c.json(memories.map(toApiMemory));
});

app.get("/api/memory/:id/history", async (c) => {
  const scopeId = requireId(c.req.query("scope_id"), "scope_id");
  const memoryId = requireId(c.req.param("id"), "id");
  const history = await getMemoryHistory(scopeId, memoryId);
  return c.json(history);
});

app.get("/api/provenance/:recall_id", async (c) => {
  const scopeId = requireId(c.req.query("scope_id"), "scope_id");
  const recallId = requireId(c.req.param("recall_id"), "recall_id");
  const recall = await getRecallWithContent(scopeId, recallId);
  if (!recall) return c.json({ error: "not found" }, 404);
  return c.json(recall);
});

app.get("/api/introspect", async (c) => {
  const scopeId = requireId(c.req.query("scope_id"), "scope_id");
  const stats = await getIntrospectStats(scopeId);
  return c.json(stats);
});

app.get("/dashboard", async (c) => {
  const html = await readFile(DASHBOARD_PATH, "utf8");
  return c.html(html);
});

app.get("/health", (c) => c.json({ ok: true }));

app.notFound((c) => c.json({ error: "not found" }, 404));

// Internal errors are logged server-side with the operation + scope_id only,
// never memory content (CLAUDE.md Safety Rules: "Never log memory content or
// connection strings; log ids + timings"). Store-layer errors already wrap
// their message as "<op>: failed for scope <id>: <driver message>" (e.g.
// src/store/memories.ts), which excludes bound SQL values by construction
// (parameterized SQL only, CLAUDE.md rule 3), so the message itself is safe
// to log here too.
app.onError((err, c) => {
  if (err instanceof ValidationError) {
    return c.json({ error: err.message }, 400);
  }
  const operation = `${c.req.method} ${c.req.path}`;
  console.error(`[routes] ${operation} failed:`, err instanceof Error ? err.message : String(err));
  return c.json({ error: "internal" }, 500);
});
