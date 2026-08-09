// Sleep job: clusters a scope's active episodic memories by vector
// similarity and merges each cluster into one semantic memory via llm.ts.
// Mutations go through memories.ts's exported tx-scoped helpers
// (insertMemoryTx, consolidateSourceTx) so every write still lands a
// memory_versions row in the same transaction (CLAUDE.md rule 1) even
// though the transaction lifecycle is managed here, not inside memories.ts.

import { getPool, withTransientRetry } from "../db.js";
import { embed } from "../embeddings.js";
import { consolidateCluster } from "../llm.js";
import { newUlid } from "../ulid.js";
import { MEMORY_COLUMNS, consolidateSourceTx, insertMemoryTx, rowToMemory, type Memory, type MemoryRow } from "./memories.js";

export interface SleepScopeInput {
  scopeId: string;
  similarityThreshold?: number;
  minClusterSize?: number;
}

export interface SleepScopeResult {
  clusters: number;
  consolidated: number;
  created: string[];
}

// Calibrated against measured L2 distances between unit-normalized embeddings
// (2026-08-10). Real Titan V2: paraphrase-level near-duplicates land at
// 0.77-1.0, unrelated content at >=1.3 (measured on the cloud demo seed's
// coffee facts, closest pair 0.77). Fake trigram embeddings: near-duplicates
// 0.33-0.42, unrelated >=1.3. The original 0.35 only merged near-exact
// duplicates under real embeddings (cos >= 0.94) and consolidated nothing in
// practice; 0.85 merges genuine paraphrases in both modes while keeping a
// wide margin below the ~1.3 unrelated floor.
const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
const DEFAULT_MIN_CLUSTER_SIZE = 2;

function l2(a: number[], b: number[]): number {
  return Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));
}

/**
 * Greedy single-pass clustering over active episodic memories (already
 * ordered by created_at ASC): for each unclustered memory, absorb every
 * still-unclustered memory within `threshold` L2 distance into its cluster.
 * Pairwise in JS on already-fetched embeddings, not a per-seed SQL ANN query
 * - deterministic and fine at hackathon scale: a scope's episodic set fits
 * in memory and O(n^2) pairs is cheap at that size.
 */
function clusterMemories(memories: Memory[], threshold: number): Memory[][] {
  const clustered = new Set<string>();
  const clusters: Memory[][] = [];

  for (const seed of memories) {
    if (clustered.has(seed.memoryId)) continue;
    const cluster = [seed];
    clustered.add(seed.memoryId);
    for (const candidate of memories) {
      if (clustered.has(candidate.memoryId)) continue;
      if (l2(seed.embedding, candidate.embedding) <= threshold) {
        cluster.push(candidate);
        clustered.add(candidate.memoryId);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

async function consolidateOneCluster(scopeId: string, cluster: Memory[]): Promise<string> {
  const mergedContent = await consolidateCluster(cluster.map((m) => m.content));
  const mergedEmbedding = await embed(mergedContent);
  const newMemoryId = newUlid();

  const client = await getPool().connect();
  try {
    return await withTransientRetry(async () => {
      await client.query("BEGIN");
      try {
        await insertMemoryTx(client, {
          scopeId,
          memoryId: newMemoryId,
          content: mergedContent,
          embedding: mergedEmbedding,
          layer: "semantic",
          tags: [],
          origin: "consolidation",
        });
        for (const source of cluster) {
          await consolidateSourceTx(client, { scopeId, memoryId: source.memoryId, consolidatedInto: newMemoryId });
        }
        await client.query("COMMIT");
        return newMemoryId;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`sleepScope: failed consolidating cluster for scope ${scopeId}: ${message}`);
  } finally {
    client.release();
  }
}

/**
 * Consolidates a scope's episodic memories into semantic ones. Each
 * qualifying cluster (size >= minClusterSize) becomes one new semantic
 * memory (op='insert'); its sources are marked status='consolidated'
 * (op='consolidate' per source) - one transaction per cluster. Clusters
 * smaller than minClusterSize are left untouched. Idempotent: a second run
 * only sees still-active episodic memories, so nothing already consolidated
 * (status != active) or already semantic (layer != episodic) is reconsidered.
 */
export async function sleepScope(input: SleepScopeInput): Promise<SleepScopeResult> {
  const scopeId = input.scopeId;
  const threshold = input.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const minClusterSize = input.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;

  const activeResult = await getPool().query<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS} FROM memories
     WHERE scope_id = $1 AND status = 'active' AND layer = 'episodic'
     ORDER BY created_at ASC`,
    [scopeId]
  );
  const active = activeResult.rows.map(rowToMemory);
  const clusters = clusterMemories(active, threshold).filter((cluster) => cluster.length >= minClusterSize);

  const created: string[] = [];
  let consolidated = 0;
  for (const cluster of clusters) {
    created.push(await consolidateOneCluster(scopeId, cluster));
    consolidated += cluster.length;
  }

  return { clusters: clusters.length, consolidated, created };
}
