import { DriftClient } from "@drift-labs/sdk";
import { STRATEGY_CONFIG } from "../config/vault";
import { PRICE_PRECISION } from "../config/constants";

export interface HealthState {
  totalCollateral: number; // USD
  maintenanceMargin: number; // USD
  healthRatio: number; // collateral / margin (>1.0 = healthy)
  unrealizedPnl: number; // USD
  status: "healthy" | "warning" | "critical" | "liquidatable";
  action: "none" | "reduce" | "close_all";
}

/**
 * Monitor Drift account health ratio.
 *
 * Addresses the critique: "Within Drift v2's cross-margin structure,
 * failing to precisely manage the offset between collateral value
 * fluctuations and unrealized PnL of short positions will lead to
 * rapid deterioration of the Health Ratio during a short squeeze."
 *
 * We check health every 30 seconds and act well before Drift's
 * liquidation threshold (1.0).
 */
export function computeHealthState(driftClient: DriftClient): HealthState {
  const user = driftClient.getUser();

  const totalCollateral = user.getTotalCollateral().toNumber() / 1e6;
  const maintenanceMargin =
    user.getMaintenanceMarginRequirement().toNumber() / 1e6;
  const unrealizedPnl = user.getUnrealizedPNL(true).toNumber() / 1e6;

  // Health ratio: total collateral / maintenance margin
  // Drift liquidates at 1.0
  const healthRatio =
    maintenanceMargin > 0 ? totalCollateral / maintenanceMargin : Infinity;

  let status: HealthState["status"];
  let action: HealthState["action"];

  if (healthRatio <= 1.0) {
    status = "liquidatable";
    action = "close_all";
  } else if (healthRatio <= STRATEGY_CONFIG.criticalHealthRatio) {
    status = "critical";
    action = "close_all";
  } else if (healthRatio <= STRATEGY_CONFIG.minHealthRatio) {
    status = "warning";
    action = "reduce";
  } else {
    status = "healthy";
    action = "none";
  }

  return {
    totalCollateral,
    maintenanceMargin,
    healthRatio,
    unrealizedPnl,
    status,
    action,
  };
}

/**
 * Compute drawdown from peak equity.
 */
export function computeDrawdown(
  currentEquity: number,
  peakEquity: number
): { drawdownPct: number; action: "none" | "reduce" | "close_all" } {
  if (peakEquity <= 0) return { drawdownPct: 0, action: "none" };

  const drawdownPct = ((peakEquity - currentEquity) / peakEquity) * 100;

  if (drawdownPct >= STRATEGY_CONFIG.severeDrawdownPct) {
    return { drawdownPct, action: "close_all" };
  }
  if (drawdownPct >= STRATEGY_CONFIG.maxDrawdownPct) {
    return { drawdownPct, action: "reduce" };
  }
  return { drawdownPct, action: "none" };
}
