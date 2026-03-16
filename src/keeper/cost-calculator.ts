import { STRATEGY_CONFIG } from "../config/vault";

export interface TradeEconomics {
  expectedFundingBps: number;
  holdingPeriodHours: number;
  positionSizeUsd: number;
  profitable: boolean;
  netProfitBps: number;
  roundTripCostBps: number;
  breakEvenHours: number;
  orderType: "maker" | "taker";
}

/**
 * Compute whether a basis trade is profitable after costs.
 *
 * v2: Uses maker (limit) order fees when useLimitOrders is enabled.
 * Maker rebate: -0.002% (we get paid) vs Taker: 0.035% (we pay)
 *
 * With maker orders:
 *   Round-trip cost = 2 × (slippage - |makerRebate|) = 2 × (1 - 0.2) = 1.6 bps
 * With taker orders (fallback):
 *   Round-trip cost = 2 × (slippage + takerFee) = 2 × (1 + 3.5) = 9 bps
 *
 * This dramatically lowers the break-even funding rate:
 *   Maker 7-day hold: 1.6 × 8760 / 168 = 83 bps (0.83% APY)
 *   Taker 7-day hold: 9 × 8760 / 168 = 469 bps (4.69% APY)
 */
export function evaluateTradeEconomics(
  annualizedFundingBps: number,
  estimatedHoldHours: number = STRATEGY_CONFIG.minHoldingPeriodHours
): TradeEconomics {
  const { estimatedSlippageBps, useLimitOrders, driftMakerFeeBps, driftTakerFeeBps } =
    STRATEGY_CONFIG;

  // Maker: slippage - |rebate| (rebate is negative = income)
  // Taker: slippage + fee
  const perTradeCostBps = useLimitOrders
    ? Math.max(0, estimatedSlippageBps + driftMakerFeeBps) // maker rebate reduces cost
    : estimatedSlippageBps + driftTakerFeeBps;

  const roundTripCostBps = 2 * perTradeCostBps;

  const hoursPerYear = 8760;
  const expectedFundingEarned =
    (annualizedFundingBps * estimatedHoldHours) / hoursPerYear;

  const netProfitBps = expectedFundingEarned - roundTripCostBps;
  const profitable = netProfitBps > 0;

  const breakEvenHours =
    annualizedFundingBps > 0
      ? (roundTripCostBps * hoursPerYear) / annualizedFundingBps
      : Infinity;

  return {
    expectedFundingBps: annualizedFundingBps,
    holdingPeriodHours: estimatedHoldHours,
    positionSizeUsd: 0,
    profitable,
    netProfitBps,
    roundTripCostBps,
    breakEvenHours,
    orderType: useLimitOrders ? "maker" : "taker",
  };
}

export function passesCostGate(annualizedFundingBps: number): boolean {
  const economics = evaluateTradeEconomics(annualizedFundingBps);
  return economics.profitable;
}

export function minProfitableFundingBps(holdHours: number): number {
  const { estimatedSlippageBps, useLimitOrders, driftMakerFeeBps, driftTakerFeeBps } =
    STRATEGY_CONFIG;

  const perTradeCostBps = useLimitOrders
    ? Math.max(0, estimatedSlippageBps + driftMakerFeeBps)
    : estimatedSlippageBps + driftTakerFeeBps;

  const roundTripCostBps = 2 * perTradeCostBps;
  return (roundTripCostBps * 8760) / holdHours;
}
