// MCP boundary (docs/plans/2026-08-09-phase-3-surfaces.md Step 3): a thin
// stdio adapter over src/store/**, exposing the same five operations the
// Hono HTTP boundary exposes (src/agent/routes.ts) as MCP tools. Same rules
// as that boundary: no SQL here, every input validated with the exact same
// caps (src/validate.ts) before it reaches the store, and memory content is
// never logged (CLAUDE.md Safety Rules). Tool handlers may throw - the SDK's
// McpServer converts any thrown error into a `{isError: true}` tool result
// automatically (verified against node_modules/@modelcontextprotocol/sdk
// dist/esm/server/mcp.js's setToolRequestHandlers try/catch), so there is no
// per-tool try/catch here; the server itself never crashes on bad input or a
// failed store call.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { recallMemories, rememberMemory, type Memory } from "../store/memories.js";
import { recallAsOf } from "../store/timetravel.js";
import { sleepScope } from "../store/consolidate.js";
import { getIntrospectStats } from "../store/introspect.js";
import { MAX_CONTENT_LEN, MAX_QUERY_LEN, optionalK, optionalLayer, optionalTags, parseAsOf, requireId, requireText } from "../validate.js";

const SERVER_NAME = "engram";
const SERVER_VERSION = "0.1.0";

// Same reasoning as src/agent/routes.ts's toApiMemory: the store's Memory
// carries its full 1024-float embedding for internal recall/consolidation
// use, but no tool response should ship it - large, write-only from the
// caller's perspective, never rendered by an MCP client.
function stripEmbedding(memory: Memory): Omit<Memory, "embedding"> {
  const { embedding, ...rest } = memory;
  return rest;
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Builds a fresh, unconnected McpServer with all five engram tools
 * registered. Exported (not just a side-effecting module) so tests can drive
 * it over an in-memory transport without spawning the stdio process.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description: "Store a new memory in a scope. Returns the created memory (without its embedding).",
      inputSchema: {
        scope_id: z.string().describe("Scope id, ^[A-Za-z0-9_-]{1,64}$"),
        content: z.string().describe(`Memory text, 1-${MAX_CONTENT_LEN} chars`),
        layer: z.string().optional().describe('"episodic" (default) or "semantic"'),
        tags: z.array(z.unknown()).optional(),
      },
    },
    async (args) => {
      const scopeId = requireId(args.scope_id, "scope_id");
      const content = requireText(args.content, "content", MAX_CONTENT_LEN);
      const layer = optionalLayer(args.layer);
      const tags = optionalTags(args.tags);
      const memory = await rememberMemory({ scopeId, content, layer, tags });
      return jsonResult(stripEmbedding(memory));
    }
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description: "Scoped vector recall of memories matching a query. Returns {recall_id, memories[]} (no embeddings).",
      inputSchema: {
        scope_id: z.string().describe("Scope id, ^[A-Za-z0-9_-]{1,64}$"),
        query: z.string().describe(`Query text, 1-${MAX_QUERY_LEN} chars`),
        k: z.number().optional().describe("Result count cap (default 8, max 20)"),
      },
    },
    async (args) => {
      const scopeId = requireId(args.scope_id, "scope_id");
      const query = requireText(args.query, "query", MAX_QUERY_LEN);
      const k = optionalK(args.k);
      const result = await recallMemories({ scopeId, query, k });
      return jsonResult({ recall_id: result.recallId, memories: result.memories.map(stripEmbedding) });
    }
  );

  server.registerTool(
    "recall_asof",
    {
      title: "Recall as of",
      description:
        "Historical recall as of a past timestamp: AS OF SYSTEM TIME inside the GC window, memory_versions replay " +
        "beyond it. Returns {memories[], used_replay} (no embeddings).",
      inputSchema: {
        scope_id: z.string().describe("Scope id, ^[A-Za-z0-9_-]{1,64}$"),
        query: z.string().describe(`Query text, 1-${MAX_QUERY_LEN} chars`),
        as_of: z.string().describe("ISO-8601 timestamp to recall as of"),
        k: z.number().optional().describe("Result count cap (default 8, max 20)"),
      },
    },
    async (args) => {
      const scopeId = requireId(args.scope_id, "scope_id");
      const query = requireText(args.query, "query", MAX_QUERY_LEN);
      const k = optionalK(args.k);
      const at = parseAsOf(args.as_of);
      if (!at) throw new Error("as_of must be a valid ISO date string");
      const result = await recallAsOf({ scopeId, query, at, k });
      return jsonResult({ memories: result.memories.map(stripEmbedding), used_replay: result.usedReplay });
    }
  );

  server.registerTool(
    "reflect",
    {
      title: "Reflect",
      description: "Sleep/consolidation job for a scope: clusters active episodic memories into semantic ones.",
      inputSchema: {
        scope_id: z.string().describe("Scope id, ^[A-Za-z0-9_-]{1,64}$"),
      },
    },
    async (args) => {
      const scopeId = requireId(args.scope_id, "scope_id");
      const result = await sleepScope({ scopeId });
      return jsonResult(result);
    }
  );

  server.registerTool(
    "introspect",
    {
      title: "Introspect",
      description: "Engine stats for a scope: memory counts by layer/status, version/recall/session/turn counts, GC window.",
      inputSchema: {
        scope_id: z.string().describe("Scope id, ^[A-Za-z0-9_-]{1,64}$"),
      },
    },
    async (args) => {
      const scopeId = requireId(args.scope_id, "scope_id");
      const stats = await getIntrospectStats(scopeId);
      return jsonResult(stats);
    }
  );

  return server;
}

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start the stdio transport when this file is run directly (`npx tsx
// src/mcp/server.ts`, or the `engram-mcp` bin launcher), never when
// tests/mcp.test.ts imports createMcpServer() to drive it over an in-memory
// transport instead.
const isEntrypoint = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch((err) => {
    console.error("engram-mcp: fatal error starting server:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
