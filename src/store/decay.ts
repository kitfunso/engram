// Exponential half-life decay math. Pure, no I/O - unit-testable in
// isolation from the DB (docs/plans/2026-08-09-phase-1-foundation.md Step 8).

const MS_PER_DAY = 86_400_000;

export interface DecayInput {
  strength: number;
  halfLifeDays: number;
  lastRetrievedAt: Date;
}

/**
 * Strength at time `at`, decayed exponentially from lastRetrievedAt:
 * strength * 0.5^((at - lastRetrievedAt) / (halfLifeDays * 86_400_000))
 */
export function strengthAt(memory: DecayInput, at: Date): number {
  const elapsedMs = at.getTime() - memory.lastRetrievedAt.getTime();
  const halfLifeMs = memory.halfLifeDays * MS_PER_DAY;
  return memory.strength * Math.pow(0.5, elapsedMs / halfLifeMs);
}
