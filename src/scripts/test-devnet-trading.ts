import { Connection, PublicKey } from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
  BulkAccountLoader,
  initialize,
  DriftEnv,
  PositionDirection,
  OrderType,
  MarketType,
  BN,
  getMarketsAndOraclesForSubscription,
} from "@drift-labs/sdk";
import { getConnection, loadKeypair, sleep } from "../utils/helpers";
import {
  fetchAllFundingRates,
  rankMarketsByFunding,
} from "../keeper/funding-scanner";
import { evaluateTradeEconomics, passesCostGate } from "../keeper/cost-calculator";
import {
  fetchReferenceVol,
  computeTargetLeverage,
  classifyVolRegime,
} from "../keeper/leverage-controller";
import { detectSignals, formatSignalState } from "../keeper/drift-signal-detector";
import { computeDriftRegime, formatRegime } from "../keeper/regime-engine";
import { STRATEGY_CONFIG } from "../config/vault";

async function main() {
  console.log("Yogi Devnet Trading Test\n");

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const manager = loadKeypair("MANAGER_KEYPAIR_PATH");

  console.log(`Manager: ${manager.publicKey.toBase58()}`);
  const balance = await connection.getBalance(manager.publicKey);
  console.log(`SOL balance: ${(balance / 1e9).toFixed(4)}\n`);

  const sdkConfig = initialize({ env: "devnet" as DriftEnv });
  const wallet = new Wallet(manager);

  const { perpMarketIndexes, spotMarketIndexes, oracleInfos } =
    getMarketsAndOraclesForSubscription("devnet" as DriftEnv);

  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
    accountSubscription: {
      type: "websocket",
    },
    env: "devnet",
    perpMarketIndexes,
    spotMarketIndexes,
    oracleInfos,
  });

  await driftClient.subscribe();
  console.log("Drift client connected.\n");

  // Step 1: Initialize user account
  console.log("=== Step 1: Initialize Drift User ===");
  try {
    const user = driftClient.getUser();
    const equity = user.getTotalCollateral().toNumber() / 1e6;
    console.log(`User account exists. Equity: $${equity.toFixed(2)}`);
  } catch {
    console.log("No user account found. Initializing...");
    try {
      const txSig = await driftClient.initializeUserAccount();
      console.log(`User account initialized: ${txSig}`);
      await sleep(2000);
    } catch (err) {
      console.error("Failed to initialize user account:", err);
      console.log("\nYou may need devnet USDC first. Get it from:");
      console.log("  https://faucet.solana.com (SOL)");
      console.log("  Then swap SOL->USDC on devnet Jupiter or use Drift's devnet faucet");
      await driftClient.unsubscribe();
      return;
    }
  }

  // Step 2: Funding scanner + cost gate
  console.log("\n=== Step 2: Funding Scanner + Cost Gate ===");
  const rates = await fetchAllFundingRates();
  const ranked = rankMarketsByFunding(
    rates,
    STRATEGY_CONFIG.minAnnualizedFundingBps
  );

  console.log(`Markets with positive funding: ${ranked.length}`);
  ranked.slice(0, 5).forEach((m) => {
    const econ = evaluateTradeEconomics(m.annualizedPct * 100);
    const gate = passesCostGate(m.annualizedPct * 100);
    console.log(
      `  ${m.market}: ${m.annualizedPct.toFixed(2)}% APY | ` +
        `net=${econ.netProfitBps.toFixed(1)} bps/day | ` +
        `break-even=${econ.breakEvenHours.toFixed(0)}h | ` +
        `cost gate: ${gate ? "PASS" : "FAIL"}`
    );
  });

  // Step 3: Dynamic leverage + signal detection + regime (Yogi-specific)
  console.log("\n=== Step 3: Leverage + Signals + Regime (Yogi) ===");
  try {
    const volBps = await fetchReferenceVol();
    const leverage = computeTargetLeverage(volBps);
    console.log(`SOL realized vol: ${(leverage.currentVol * 100).toFixed(1)}%`);
    console.log(`Vol regime: ${leverage.regime}`);

    const signals = await detectSignals(STRATEGY_CONFIG.monitoredMarkets);
    console.log(formatSignalState(signals));

    const regime = computeDriftRegime(leverage.regime, signals.severity);
    console.log(`Regime: ${formatRegime(regime)}`);
    console.log(`Deployment: ${regime.deploymentPct}% | Max leverage: ${regime.maxLeverage}x | Mode: ${regime.rebalanceMode}`);
  } catch (err) {
    console.error("Leverage/signal/regime error:", err);
  }

  // Step 4: Health monitor
  console.log("\n=== Step 4: Health Monitor ===");
  try {
    const user = driftClient.getUser();
    const equity = user.getTotalCollateral().toNumber() / 1e6;
    const margin = user.getMaintenanceMarginRequirement().toNumber() / 1e6;
    const pnl = user.getUnrealizedPNL(true).toNumber() / 1e6;
    const healthRatio = margin > 0 ? equity / margin : Infinity;

    console.log(`Total collateral: $${equity.toFixed(2)}`);
    console.log(`Maintenance margin: $${margin.toFixed(2)}`);
    console.log(`Health ratio: ${healthRatio === Infinity ? "Inf (no positions)" : healthRatio.toFixed(3)}`);
    console.log(`Unrealized PnL: $${pnl.toFixed(2)}`);

    const perpPositions = user.getActivePerpPositions();
    console.log(`Active perp positions: ${perpPositions.length}`);
    perpPositions.forEach((pos) => {
      console.log(
        `  Market ${pos.marketIndex}: size=${pos.baseAssetAmount.toString()} quote=${pos.quoteAssetAmount.toString()}`
      );
    });
  } catch (err) {
    console.error("Health check error:", err);
  }

  // Step 5: Trade test
  console.log("\n=== Step 5: Trade Test ===");
  try {
    const user = driftClient.getUser();
    const equity = user.getTotalCollateral().toNumber() / 1e6;

    if (equity > 0) {
      console.log(`Equity available: $${equity.toFixed(2)}`);
      console.log("Placing a small test SHORT on SOL-PERP (market 0)...");

      const oracle = driftClient.getOracleDataForPerpMarket(0);
      const price = oracle.price.toNumber() / 1e6;
      if (price <= 0) {
        console.error("Invalid oracle price, skipping trade test");
      } else {
        console.log(`SOL oracle price: $${price.toFixed(2)}`);

        const baseAmount = (1 / price) * 1e9;

        const txSig = await driftClient.placePerpOrder({
          orderType: OrderType.MARKET,
          marketType: MarketType.PERP,
          marketIndex: 0,
          direction: PositionDirection.SHORT,
          baseAssetAmount: new BN(Math.floor(baseAmount)),
        });

        console.log(`Trade executed: ${txSig}`);
        await sleep(3000);

        const pos = user.getPerpPosition(0);
        if (pos && !pos.baseAssetAmount.isZero()) {
          console.log(`Position opened: size=${pos.baseAssetAmount.toString()}`);

          console.log("Closing test position...");
          const closeTx = await driftClient.placePerpOrder({
            orderType: OrderType.MARKET,
            marketType: MarketType.PERP,
            marketIndex: 0,
            direction: PositionDirection.LONG,
            baseAssetAmount: pos.baseAssetAmount.abs(),
            reduceOnly: true,
          });
          console.log(`Position closed: ${closeTx}`);
        }
      }
    } else {
      console.log(
        "No collateral — skipping trade test. Deposit devnet USDC to test trading."
      );
      console.log(
        "Use Drift's devnet UI at https://beta.drift.trade to deposit devnet tokens."
      );
    }
  } catch (err) {
    console.error("Trade test error:", err);
  }

  console.log("\n=== Devnet Trading Test Complete ===");
  await driftClient.unsubscribe();
}

main().catch(console.error);
