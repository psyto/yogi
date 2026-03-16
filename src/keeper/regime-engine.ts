import { SignalSeverity, SIGNAL_NONE, SIGNAL_LOW, SIGNAL_HIGH, SIGNAL_CRITICAL } from "./drift-signal-detector";
import { STRATEGY_CONFIG } from "../config/vault";

/**
 * Regime Engine — Yogi's decision matrix.
 *
 * Combines two independent inputs:
 * 1. Vol Regime (from the leverage controller) — backward-looking realized vol
 * 2. Signal Severity (from Drift signal detector) — forward-looking anomaly detection
 *
 * The combination produces a DriftRegime that determines:
 * - deploymentPct: how much capital to deploy (0-100%)
 * - maxLeverage: maximum allowed leverage
 * - rebalanceMode: normal, cautious, or defensive
 *
 * All matrices are configurable via STRATEGY_CONFIG.deploymentMatrix / leverageMatrix.
 */

export type VolRegime = "veryLow" | "low" | "normal" | "high" | "extreme";

export type RebalanceMode = "aggressive" | "normal" | "cautious" | "defensive";

export interface DriftRegime {
  volRegime: VolRegime;
  signalSeverity: SignalSeverity;
  deploymentPct: number;
  maxLeverage: number;
  rebalanceMode: RebalanceMode;
  reason: string;
}

/**
 * Compute the current Drift regime from vol + signals.
 * Reads deployment and leverage matrices from STRATEGY_CONFIG.
 */
export function computeDriftRegime(
  volRegime: VolRegime,
  signalSeverity: SignalSeverity
): DriftRegime {
  const deployRow = STRATEGY_CONFIG.deploymentMatrix[volRegime] ?? [0, 0, 0, 0];
  const leverageRow = STRATEGY_CONFIG.leverageMatrix[volRegime] ?? [0, 0, 0, 0];

  const deploymentPct = deployRow[signalSeverity] ?? 0;
  const maxLeverage = leverageRow[signalSeverity] ?? 0;

  let rebalanceMode: RebalanceMode;
  if (deploymentPct >= 85) {
    rebalanceMode = "aggressive";
  } else if (deploymentPct >= 55) {
    rebalanceMode = "normal";
  } else if (deploymentPct >= 20) {
    rebalanceMode = "cautious";
  } else {
    rebalanceMode = "defensive";
  }

  const severityLabels = ["clear", "low", "high", "critical"];
  const reason =
    signalSeverity === SIGNAL_NONE
      ? `${volRegime} vol, no anomalies -> ${deploymentPct}% deployed @ ${maxLeverage}x`
      : `${volRegime} vol + ${severityLabels[signalSeverity]} signal -> ${deploymentPct}% deployed @ ${maxLeverage}x (${rebalanceMode})`;

  return {
    volRegime,
    signalSeverity,
    deploymentPct,
    maxLeverage,
    rebalanceMode,
    reason,
  };
}

/**
 * Determine if regime change warrants immediate action.
 * Returns true if we should trigger an out-of-cycle rebalance.
 */
export function shouldTriggerEmergencyRebalance(
  previous: DriftRegime | undefined,
  current: DriftRegime
): boolean {
  if (!previous) return false;

  const deploymentDrop = previous.deploymentPct - current.deploymentPct;
  if (deploymentDrop >= STRATEGY_CONFIG.emergencyDeploymentDropPct) return true;

  if (previous.signalSeverity <= SIGNAL_LOW && current.signalSeverity >= SIGNAL_CRITICAL) {
    return true;
  }

  if (previous.rebalanceMode !== "defensive" && current.rebalanceMode === "defensive") {
    return true;
  }

  return false;
}

/**
 * Format regime for logging.
 */
export function formatRegime(regime: DriftRegime): string {
  const modeEmoji: Record<RebalanceMode, string> = {
    aggressive: ">>",
    normal: "->",
    cautious: "~~",
    defensive: "!!",
  };

  return `[${modeEmoji[regime.rebalanceMode]}] ${regime.reason}`;
}
