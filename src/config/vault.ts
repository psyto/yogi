import dotenv from "dotenv";
dotenv.config();
import { PublicKey } from "@solana/web3.js";
import { USDC_MINT, SPL_TOKEN_PROGRAM_ID } from "./constants";
import BN from "bn.js";

// Vault configuration
export const VAULT_CONFIG = {
  name: "Yogi",
  description:
    "Drift basis trade alpha with intelligent signal detection",

  assetMintAddress: USDC_MINT,
  assetTokenProgram: SPL_TOKEN_PROGRAM_ID,

  maxCap: new BN(1_000_000 * 1e6), // 1M USDC

  managementFee: new BN(100), // 1% annual
  issuanceFee: new BN(0),
  redemptionFee: new BN(10), // 0.1% withdrawal fee
  performanceFee: new BN(2000), // 20% performance fee on profits

  withdrawalWaitingPeriod: new BN(86400),
  lockedProfitDegradationDuration: new BN(3600),
};

// Strategy parameters
export const STRATEGY_CONFIG = {
  // Capital allocation (base — regime engine may override deploymentPct)
  lendingFloorPct: 30,
  basisTradePct: 70,

  // Funding rate thresholds
  minAnnualizedFundingBps: 500, // 5% minimum
  exitFundingBps: -50, // -0.5% exit

  // LST staking yield
  enableLstYield: true,

  // Multi-protocol lending optimization
  enableLendingOptimization: true,

  // AMM imbalance signals
  minSignalStrength: 20,
  useImbalanceSignals: true,

  // Order execution (maker-first)
  useLimitOrders: false,
  driftMakerFeeBps: -0.2,
  driftTakerFeeBps: 3.5,
  limitOrderSpreadBps: 2,
  limitOrderTimeoutMs: 60_000,
  estimatedSlippageBps: 1,

  // Low-turnover model
  minHoldingPeriodHours: 168,
  minFundingAdvantageToRotateBps: 200,
  maxRotationsPerWeek: 2,

  // Market quality filters
  maxMarketsSimultaneous: 3,
  minMarketOI: 5_000_000,
  minMarketVolume24h: 10_000_000,
  allowedMarkets: [
    "SOL-PERP", "BTC-PERP", "ETH-PERP",
    "DOGE-PERP", "SUI-PERP", "AVAX-PERP",
  ] as string[],
  excludeMarkets: [
    "1MBONK-PERP", "1KPUMP-PERP", "1KMON-PERP", "MET-PERP",
    "CLOUD-PERP", "2Z-PERP", "TNSR-PERP", "KMNO-PERP",
  ] as string[],

  // Dynamic leverage control (base — regime engine may override)
  leverageByVolRegime: {
    veryLow: 2.0,
    low: 1.5,
    normal: 1.0,
    high: 0.5,
    extreme: 0.0,
  } as Record<string, number>,
  maxLeverage: 2,

  volRegimeThresholds: {
    veryLow: 2000,
    low: 3500,
    normal: 5000,
    high: 7500,
  },

  // Risk limits
  maxDrawdownPct: 3,
  severeDrawdownPct: 5,
  maxPositionPctPerMarket: 40,

  // Health ratio monitoring
  minHealthRatio: 1.15,
  criticalHealthRatio: 1.08,
  healthCheckIntervalMs: 30 * 1000,

  // Timing
  rebalanceIntervalMs: 4 * 60 * 60 * 1000, // 4 hours
  fundingScanIntervalMs: 30 * 60 * 1000,    // 30 min
  emergencyCheckIntervalMs: 30 * 1000,       // 30s

  // --- YOGI-SPECIFIC: Signal detection ---
  signalDetectionIntervalMs: 5 * 60 * 1000, // 5 min — faster than funding scan
  monitoredMarkets: ["SOL-PERP", "BTC-PERP", "ETH-PERP"] as string[],
  signalHistorySize: 12,          // Rolling snapshots (12 × 5min = 1 hour)
  fundingHistorySize: 168,        // 7 days of hourly funding samples
  fundingVolWindow: 24,           // Recent entries for funding vol calculation

  // Signal thresholds — severity levels for each anomaly dimension
  signalThresholds: {
    oiShift:    { low: 5, high: 15, critical: 30 },       // % shift in OI imbalance
    oiDrop:     { low: 5, high: 15, critical: 30 },       // % OI drop (liquidation proxy)
    fundingVol: { low: 500, high: 1500, critical: 3000 }, // Annualized bps
    spread:     { low: 0.5, high: 1.5, critical: 3.0 },   // % mark/oracle divergence
  },

  // Imbalance signal scoring weights
  signalWeights: {
    funding: 0.5,
    premium: 0.3,
    oi: 0.2,
  },

  // Signal scoring scale factors (maps raw values to -1..+1 range)
  signalScaleFactors: {
    funding: 500,   // fundingRate × 500 → [-1, 1]
    premium: 10,    // premiumPct × 10 → [-1, 1]
    oi: 10,         // oiImbalancePct / 10 → [-1, 1]
  },

  // Regime deployment matrix: volRegime × signalSeverity → % capital deployed
  deploymentMatrix: {
    veryLow: [100, 80, 50, 25],  // [NONE, LOW, HIGH, CRITICAL]
    low:     [ 85, 70, 40, 20],
    normal:  [ 70, 55, 30, 15],
    high:    [ 50, 35, 20, 10],
    extreme: [  0,  0,  0,  0],
  } as Record<string, number[]>,

  // Regime leverage matrix: volRegime × signalSeverity → max leverage
  leverageMatrix: {
    veryLow: [2.0, 1.5, 1.0, 0.5],
    low:     [1.5, 1.2, 0.8, 0.3],
    normal:  [1.0, 0.8, 0.5, 0.2],
    high:    [0.5, 0.3, 0.2, 0.0],
    extreme: [0.0, 0.0, 0.0, 0.0],
  } as Record<string, number[]>,

  // Cautious mode signal strength minimum (higher bar for entries)
  cautiousMinSignalStrength: 40,

  // Emergency rebalance trigger: min deployment drop to force out-of-cycle rebalance
  emergencyDeploymentDropPct: 30,
};

export let vaultAddress = process.env.VAULT_ADDRESS
  ? new PublicKey(process.env.VAULT_ADDRESS)
  : PublicKey.default;

export let lookupTableAddress = process.env.LOOKUP_TABLE_ADDRESS
  ? new PublicKey(process.env.LOOKUP_TABLE_ADDRESS)
  : PublicKey.default;
