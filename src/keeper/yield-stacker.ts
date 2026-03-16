import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";

/**
 * Yield Stacker — Layer additional yield sources on top of the base strategy.
 *
 * Production-grade vaults don't rely on a single revenue source.
 * Gauntlet's SOL Basis earns: staking yield (7%) + funding rate (10-15%) = 17-22%
 *
 * Kuma v4 stacks:
 * 1. Lending floor (30% → 3-5% APY from Drift Earn or Kamino)
 * 2. Imbalance arbitrage (70% → funding + premium + OI convergence)
 * 3. LST staking yield (on collateral → 7-8% additional on deposited SOL)
 * 4. Maker rebates (on all trades → -0.002% per trade = income)
 *
 * Combined target: 20-30% APY in normal conditions
 */

export interface YieldBreakdown {
  lendingYieldAPY: number;
  fundingYieldAPY: number;
  premiumConvergenceAPY: number;
  lstStakingAPY: number;
  makerRebateAPY: number;
  totalAPY: number;
}

export interface LendingProtocol {
  name: string;
  asset: string;
  apy: number;
  available: boolean;
}

/**
 * Fetch current lending rates across protocols to find the best yield.
 * In production, this would query multiple protocols via their APIs.
 * For now, we use known rate ranges.
 */
export async function fetchBestLendingRate(): Promise<LendingProtocol> {
  // Drift USDC lending rate
  try {
    const res = await fetch(`${DRIFT_DATA_API}/stats/USDC/rateHistory/deposit`);
    if (res.ok) {
      const body = (await res.json()) as {
        success: boolean;
        records: Array<{ depositRate: string; ts: number }>;
      };
      if (body.success && body.records && body.records.length > 0) {
        const latestRate = parseFloat(body.records[0].depositRate);
        const driftAPY = latestRate * 100;

        // Compare with known protocol rates
        // In production, these would be fetched from each protocol's API
        const protocols: LendingProtocol[] = [
          { name: "Drift Earn", asset: "USDC", apy: driftAPY, available: true },
          { name: "Kamino Lend", asset: "USDC", apy: 6.5, available: true },
          { name: "Marginfi", asset: "USDC", apy: 5.0, available: true },
        ];

        // Return highest yield
        return protocols.sort((a, b) => b.apy - a.apy)[0];
      }
    }
  } catch {}

  // Fallback
  return { name: "Drift Earn", asset: "USDC", apy: 3.0, available: true };
}

/**
 * Compute the total yield breakdown for the vault.
 * This gives transparency on where each % of APY comes from.
 */
export function computeYieldBreakdown(
  lendingAPY: number,
  annualizedFundingBps: number,
  positionSizePct: number,
  leverage: number
): YieldBreakdown {
  const lendingAllocation = STRATEGY_CONFIG.lendingFloorPct / 100;
  const basisAllocation = STRATEGY_CONFIG.basisTradePct / 100;

  // Lending yield: lending allocation × best lending rate
  const lendingYieldAPY = lendingAllocation * lendingAPY;

  // Funding yield: basis allocation × funding rate × leverage
  const fundingYieldAPY =
    basisAllocation * (annualizedFundingBps / 100) * (positionSizePct / 100) * leverage;

  // Premium convergence: estimated 20-30% of funding yield as additional alpha
  // from mark/oracle mean reversion (conservative estimate)
  const premiumConvergenceAPY = fundingYieldAPY * 0.25;

  // LST staking yield: if using jitoSOL/dSOL as collateral
  // ~7-8% APY on the SOL portion of collateral
  // For USDC vaults, this requires a SOL swap + LST + hedge cycle
  // Estimated net after hedging: ~5% additional on 50% of basis allocation
  const lstStakingAPY = STRATEGY_CONFIG.enableLstYield
    ? basisAllocation * 0.5 * 5.0
    : 0;

  // Maker rebates: ~0.002% per trade × estimated trades per year
  // With 7-day holds and 2 rotations/week: ~100 trades/year
  // Average position size ~30% of equity
  // Rebate: 100 × 0.3 × 0.00002 × 100 = ~0.06% — negligible but positive
  const makerRebateAPY = 0.06;

  const totalAPY =
    lendingYieldAPY +
    fundingYieldAPY +
    premiumConvergenceAPY +
    lstStakingAPY +
    makerRebateAPY;

  return {
    lendingYieldAPY,
    fundingYieldAPY,
    premiumConvergenceAPY,
    lstStakingAPY,
    makerRebateAPY,
    totalAPY,
  };
}

/**
 * Log the yield breakdown for monitoring.
 */
export function logYieldBreakdown(breakdown: YieldBreakdown): void {
  console.log("\n--- Yield Breakdown (Estimated) ---");
  console.log(`  Lending floor:          ${breakdown.lendingYieldAPY.toFixed(2)}% APY`);
  console.log(`  Funding harvesting:     ${breakdown.fundingYieldAPY.toFixed(2)}% APY`);
  console.log(`  Premium convergence:    ${breakdown.premiumConvergenceAPY.toFixed(2)}% APY`);
  console.log(`  LST staking yield:      ${breakdown.lstStakingAPY.toFixed(2)}% APY`);
  console.log(`  Maker rebates:          ${breakdown.makerRebateAPY.toFixed(2)}% APY`);
  console.log(`  ────────────────────────────────`);
  console.log(`  Total estimated:        ${breakdown.totalAPY.toFixed(2)}% APY`);
}
