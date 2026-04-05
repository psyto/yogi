/**
 * Shared state between keeper loop and API server.
 *
 * The keeper writes to sharedState after each detection cycle.
 * The Express server reads from it. Both run in the same process.
 */

export interface APIState {
  regime: Record<string, unknown> | null;
  signals: Record<string, unknown> | null;
  fundingRankings: Record<string, unknown>[] | null;
  crossVenue: Record<string, unknown>[] | null;
  leverageState: Record<string, unknown> | null;
  imbalances: Record<string, unknown>[] | null;
  updatedAt: Record<string, number>;
}

export const sharedState: APIState = {
  regime: null,
  signals: null,
  fundingRankings: null,
  crossVenue: null,
  leverageState: null,
  imbalances: null,
  updatedAt: {},
};

export function updateState(component: keyof Omit<APIState, "updatedAt">, data: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sharedState as any)[component] = data;
  sharedState.updatedAt[component] = Date.now();
}

export function isStale(component: string, maxAgeMs: number = 600_000): boolean {
  const ts = sharedState.updatedAt[component];
  if (!ts) return true;
  return Date.now() - ts > maxAgeMs;
}

export function getMeta(component: string): Record<string, unknown> {
  const ts = sharedState.updatedAt[component];
  return {
    source: "yogi",
    chain: "solana",
    updated_at: ts ?? null,
    stale: isStale(component),
  };
}
