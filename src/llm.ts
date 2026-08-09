// Owns every Bedrock chat/consolidation call (docs/ARCHITECTURE.md service
// boundaries). ENGRAM_FAKE_BEDROCK=1 is the only mode implemented in Phase 1
// (mirrors src/embeddings.ts): a deterministic merge so consolidation tests
// are stable without AWS access. The real Bedrock Claude path lands in
// Phase 2.

const SNIPPET_LENGTH = 60;

function fakeConsolidate(contents: string[]): string {
  const snippets = contents.map((content) => content.slice(0, SNIPPET_LENGTH));
  return `Consolidated memory (n=${contents.length}): ${snippets.join("; ")}`;
}

/** Merges a cluster of episodic memory contents into one semantic memory. */
export async function consolidateCluster(contents: string[]): Promise<string> {
  if (process.env.ENGRAM_FAKE_BEDROCK === "1") {
    return fakeConsolidate(contents);
  }
  throw new Error("real Bedrock path lands in phase 2");
}
