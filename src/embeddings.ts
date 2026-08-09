// Owns every embedding call (docs/ARCHITECTURE.md service boundaries).
// ENGRAM_FAKE_BEDROCK=1 is the offline mode (Phase 1): a deterministic
// character-trigram bag-of-words projection, not a content hash - it must
// preserve similarity structure (similar text -> nearby vectors) because
// recall/needle tests depend on it. The real path (Phase 2, below) calls
// Amazon Bedrock Titan Text Embeddings V2 and is exercised only by
// scripts/spike/bedrock-live-check.ts, never by the test suite (CLAUDE.md
// rule 7: tests run offline against the fake).

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
// Side-effect import only: db.ts loads .env at module-load time (its
// bottom-of-file `loadDotEnv()` call). embeddings.ts reads AWS_REGION
// directly below and must not depend on some OTHER already-imported module
// (e.g. store/memories.ts) having pulled db.ts in first - discovered via
// scripts/spike/bedrock-live-check.ts, which imports only this file and
// failed with "missing required env var AWS_REGION" before this import was
// added.
import "./db.js";

const DIM = 1024;
const MODEL_ID = "amazon.titan-embed-text-v2:0";

function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function trigramBucket(trigram: string): number {
  return fnv1a(trigram) % DIM;
}

function fakeEmbed(text: string): number[] {
  const vector = new Array<number>(DIM).fill(0);
  const normalized = text.toLowerCase();
  // Pad short inputs so at least one trigram exists, keeping embed() total
  // for any non-empty string.
  const padded = normalized.length < 3 ? normalized.padEnd(3, " ") : normalized;
  for (let i = 0; i <= padded.length - 3; i++) {
    vector[trigramBucket(padded.slice(i, i + 3))] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`embeddings: missing required env var ${name}`);
  }
  return value;
}

let client: BedrockRuntimeClient | undefined;

/** Lazy singleton: constructed once, on first real (non-fake) call. */
function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({ region: requireEnv("AWS_REGION") });
  }
  return client;
}

interface TitanEmbedResponse {
  embedding: number[];
}

async function realEmbed(text: string): Promise<number[]> {
  let response;
  try {
    response = await getClient().send(
      new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({ inputText: text, dimensions: DIM, normalize: true }),
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`embed: Bedrock InvokeModel failed: ${message}`);
  }
  if (!response.body) {
    throw new Error("embed: Bedrock InvokeModel returned no body");
  }
  const parsed = JSON.parse(new TextDecoder().decode(response.body)) as TitanEmbedResponse;
  // CLAUDE.md rule 6: dimension is locked at 1024 - the vector index and
  // every stored embedding depend on it, so a mismatch fails loudly here
  // rather than silently corrupting recall.
  if (!Array.isArray(parsed.embedding) || parsed.embedding.length !== DIM) {
    const gotLen = Array.isArray(parsed.embedding) ? parsed.embedding.length : typeof parsed.embedding;
    throw new Error(`embed: expected ${DIM}-dim vector from Titan, got ${gotLen}`);
  }
  return parsed.embedding;
}

/** Embeds text into a 1024-dim vector (CLAUDE.md rule 6: dimension is locked). */
export async function embed(text: string): Promise<number[]> {
  if (process.env.ENGRAM_FAKE_BEDROCK === "1") {
    return fakeEmbed(text);
  }
  return realEmbed(text);
}
