/**
 * Pure decision functions for emergency logic.
 * No DriftClient, no async, no side effects — fully testable.
 */

export type EmergencyAction =
  | { kind: "none" }
  | { kind: "close_all"; resetPeak: boolean }
  | { kind: "reduce_health" }
  | { kind: "reduce_drawdown" }
  | { kind: "reduce_signal" };

/**
 * Decide what emergency action to take based on current state.
 * Priority: health close > negative equity > health reduce > drawdown close > drawdown reduce > signal.
 */
export function decideEmergencyAction(params: {
  healthAction: "none" | "reduce" | "close_all";
  equity: number;
  peakEquity: number;
  drawdownAction: "none" | "reduce" | "close_all";
  signalSeverity: number;
  hasActivePositions: boolean;
}): EmergencyAction {
  // 1. Health critical — close everything
  if (params.healthAction === "close_all") {
    return { kind: "close_all", resetPeak: false };
  }

  // 2. Health reduce — shed largest basis position
  if (params.healthAction === "reduce") {
    return { kind: "reduce_health" };
  }

  // 3. Negative equity — close everything
  if (params.equity < 0) {
    return { kind: "close_all", resetPeak: false };
  }

  // 4. Severe drawdown — close everything and reset peak
  if (params.drawdownAction === "close_all") {
    return { kind: "close_all", resetPeak: true };
  }

  // 5. Moderate drawdown — shed worst position
  if (params.drawdownAction === "reduce") {
    return { kind: "reduce_drawdown" };
  }

  // 6. Signal critical — shed largest position
  if (params.signalSeverity >= 3 && params.hasActivePositions) {
    return { kind: "reduce_signal" };
  }

  return { kind: "none" };
}

/**
 * Decide whether an orphaned spot position is too small to sell.
 */
export function shouldSkipOrphanedSpot(params: {
  spotSizeCoins: number;
  spotPrecision: number;
  minOrderSize: number;
}): { skip: boolean; baseAmount: number } {
  const baseAmount = Math.floor(params.spotSizeCoins * params.spotPrecision);
  return {
    skip: baseAmount < params.minOrderSize,
    baseAmount,
  };
}
