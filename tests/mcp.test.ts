// Real-DB tests against local CockroachDB (CLAUDE.md rule 7). Bedrock is
// mocked via ENGRAM_FAKE_BEDROCK=1 (set in .env) - zero AWS access required.
// Each test creates its own unique scope_id so parallel runs stay isolated.
//
// Drives src/mcp/server.ts's McpServer in-process over the SDK's
// InMemoryTransport (client + server pair), never spawning the stdio
// process - that path is covered by a manual smoke test instead
// (docs/plans/2026-08-09-phase-3-surfaces.md Step 3).

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createMcpServer } from "../src/mcp/server.js";
import { closePool } from "../src/db.js";
import { newUlid } from "../src/ulid.js";

after(async () => {
  await closePool();
});

interface Connected {
  client: Client;
  server: McpServer;
}

async function connect(): Promise<Connected> {
  const server = createMcpServer();
  const client = new Client({ name: "engram-mcp-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

async function disconnect({ client, server }: Connected): Promise<void> {
  await client.close();
  await server.close();
}

// Client.callTool()'s return type is a union that resolves `content` to
// `unknown` at the type level (one branch is a generic task-result shape
// with an index signature) - this local shape is what src/mcp/server.ts's
// jsonResult() actually produces: a single JSON text content block, plus
// the optional isError flag the SDK sets on a thrown tool error.
interface ToolTextResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseToolJson(result: ToolTextResult): any {
  const block = result.content[0];
  assert.equal(block?.type, "text", "expected a text content block");
  return JSON.parse(block!.text!);
}

test("tools/list exposes exactly the 5 engram tools", async () => {
  const conn = await connect();
  try {
    const { tools } = await conn.client.listTools();
    assert.equal(tools.length, 5);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["introspect", "recall", "recall_asof", "reflect", "remember"]);
  } finally {
    await disconnect(conn);
  }
});

test("remember then recall round-trips the remembered content with no embedding key", async () => {
  const conn = await connect();
  try {
    const scopeId = newUlid();
    const content = "the user's favourite tea is oolong";

    const rememberResult = await conn.client.callTool({
      name: "remember",
      arguments: { scope_id: scopeId, content },
    });
    assert.equal(rememberResult.isError, undefined, "remember should not be an error result");
    const memory = parseToolJson(rememberResult as ToolTextResult);
    assert.equal(memory.content, content);
    assert.equal(memory.scopeId, scopeId);
    assert.equal("embedding" in memory, false, "remember result must not include the raw embedding");

    const recallResult = await conn.client.callTool({
      name: "recall",
      arguments: { scope_id: scopeId, query: content, k: 3 },
    });
    assert.equal(recallResult.isError, undefined, "recall should not be an error result");
    const recall = parseToolJson(recallResult as ToolTextResult);
    assert.ok(recall.recall_id);
    assert.ok(Array.isArray(recall.memories));
    assert.ok(recall.memories.some((m: { content: string }) => m.content === content));
    assert.ok(
      recall.memories.every((m: Record<string, unknown>) => !("embedding" in m)),
      "recall result must not include raw embeddings"
    );
  } finally {
    await disconnect(conn);
  }
});

test("recall_asof with a just-now timestamp returns memories and used_replay", async () => {
  const conn = await connect();
  try {
    const scopeId = newUlid();
    const content = "recall_asof probe fact";
    await conn.client.callTool({ name: "remember", arguments: { scope_id: scopeId, content } });

    const result = await conn.client.callTool({
      name: "recall_asof",
      arguments: { scope_id: scopeId, query: content, as_of: new Date().toISOString(), k: 5 },
    });
    assert.equal(result.isError, undefined, "recall_asof should not be an error result");
    const body = parseToolJson(result as ToolTextResult);
    assert.equal(typeof body.used_replay, "boolean");
    assert.ok(Array.isArray(body.memories));
    assert.ok(
      body.memories.every((m: Record<string, unknown>) => !("embedding" in m)),
      "recall_asof result must not include raw embeddings"
    );
  } finally {
    await disconnect(conn);
  }
});

test("reflect returns a consolidation/cluster-stats shape", async () => {
  const conn = await connect();
  try {
    const scopeId = newUlid();
    const result = await conn.client.callTool({ name: "reflect", arguments: { scope_id: scopeId } });
    assert.equal(result.isError, undefined, "reflect should not be an error result");
    const body = parseToolJson(result as ToolTextResult);
    assert.equal(typeof body.clusters, "number");
    assert.equal(typeof body.consolidated, "number");
    assert.ok(Array.isArray(body.created));
  } finally {
    await disconnect(conn);
  }
});

test("introspect returns engine stats with counts for the scope", async () => {
  const conn = await connect();
  try {
    const scopeId = newUlid();
    await conn.client.callTool({ name: "remember", arguments: { scope_id: scopeId, content: "introspect probe one" } });
    await conn.client.callTool({ name: "remember", arguments: { scope_id: scopeId, content: "introspect probe two" } });

    const result = await conn.client.callTool({ name: "introspect", arguments: { scope_id: scopeId } });
    assert.equal(result.isError, undefined, "introspect should not be an error result");
    const stats = parseToolJson(result as ToolTextResult);
    assert.equal(stats.counts.byLayer.episodic, 2);
    assert.equal(stats.counts.byStatus.active, 2);
    assert.equal(typeof stats.versionsCount, "number");
    assert.equal(stats.embeddingDim, 1024);
    assert.equal(typeof stats.gcWindowMs, "number");
  } finally {
    await disconnect(conn);
  }
});

test("a malformed scope_id returns an MCP tool error instead of crashing the server", async () => {
  const conn = await connect();
  try {
    const result = (await conn.client.callTool({
      name: "remember",
      arguments: { scope_id: "bad scope!", content: "x" },
    })) as ToolTextResult;
    assert.equal(result.isError, true);
    const block = result.content[0];
    assert.equal(block?.type, "text");
    assert.ok(block!.text!.includes("scope_id"));

    // Server is still alive after the error - a second, valid call succeeds.
    const scopeId = newUlid();
    const followUp = await conn.client.callTool({ name: "remember", arguments: { scope_id: scopeId, content: "still alive" } });
    assert.equal(followUp.isError, undefined);
  } finally {
    await disconnect(conn);
  }
});
