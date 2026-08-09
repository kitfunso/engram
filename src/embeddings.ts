// Owns every embedding call (docs/ARCHITECTURE.md service boundaries).
// ENGRAM_FAKE_BEDROCK=1 is the only mode implemented in Phase 1: a
// deterministic character-trigram bag-of-words projection, not a content
// hash - it must preserve similarity structure (similar text -> nearby
// vectors) because recall/needle tests depend on it. The real Bedrock Titan
// path lands in Phase 2; calling embed() without the fake flag fails loudly
// rather than silently returning nonsense vectors.

const DIM = 1024;

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

/** Embeds text into a 1024-dim vector (CLAUDE.md rule 6: dimension is locked). */
export async function embed(text: string): Promise<number[]> {
  if (process.env.ENGRAM_FAKE_BEDROCK === "1") {
    return fakeEmbed(text);
  }
  throw new Error("real Bedrock path lands in phase 2");
}
