# Yogi Vault

**Smarter than the average bear market vault. The vault that survives when others bleed.**

Yogi is a production-grade USDC vault on Solana that combines Drift funding rate arbitrage with a **5-dimensional anomaly detection engine** — including real-time cross-venue funding comparison against Binance and Bybit. While BTC dropped 7.4% in one week, Yogi delivered **+$8.08 (+1.61%) with zero drawdown**. It's not the highest yield — it's the one that survives.

**Live on Solana mainnet since March 20, 2026.** $500 deposited. Zero drawdown. Keeper running 24/7 on AWS EC2.

## Live Bear Market Performance (Mar 20–23, 2026)

During a week where BTC dropped 7.4% ($73,872 → $68,402), Yogi:

| Metric | Value |
|--------|-------|
| **P&L** | **+$8.08 (+1.61%)** |
| **Max Drawdown** | **$0.00** |
| **Account Health** | **98%** |
| **Net Funding** | $0.07 |
| **Positions** | 4 (SUI, BTC, AVAX, DOGE — rotating) |
| **Taker Volume** | $232.45 |

### Intelligence in Action — Real Events

**DOGE funding collapse:** Drift DOGE funding spiked to -3,271% APY. Yogi's cross-venue detector showed Binance at -6.4% and Bybit at -6.9% — confirming the distortion was Drift-specific. The keeper exited the DOGE SHORT and rotated to SUI (+1,034% APY).

**Bidirectional adaptation:** When SOL and ETH funding turned deeply negative (-2,000% and -1,700% APY on Drift), Yogi automatically opened LONG positions to collect from the other side. Shorts paying funding are exited immediately; longs replace them to keep collecting.

**Cross-venue divergence:** Drift BTC funding at +1,445% while Binance at -7.5% and Bybit at -9.6%. A +1,454% spread. Yogi sees this and flags convergence risk on every BTC entry decision.

**Regime discipline:** Vol stuck at 57-61% (high regime). Yogi automatically limited deployment to 50% at 0.5x leverage. Many vaults would be fully deployed — Yogi chose safety, and the bear market proved it right.

**Zero drawdown through a -7.4% BTC week.** That's the story.

## Strategy

Yogi stacks multiple yield sources across two capital pools, with an intelligence layer that dynamically adjusts exposure:

1. **Bidirectional Funding Harvesting** — SHORT when funding positive, LONG when funding negative. Collects from both sides of the market simultaneously.
2. **Lending Floor (30% — designed, not yet active)** — Architecture supports routing idle USDC to Kamino/Marginfi. Currently idle USDC stays as Drift collateral. Planned for post-hackathon.
2. **Regime-Adaptive Arbitrage (70%)** — Four stacked yield sources:
   - **Funding rate** — Bidirectional: SHORT when positive, LONG when negative
   - **Premium convergence** — Mark/oracle deviation mean-reverts
   - **OI rebalancing** — Position ahead of funding rate changes using OI imbalance
   - **LST collateral yield (designed, not yet active)** — jitoSOL as collateral for ~7-8% staking + MEV. Planned for post-hackathon.
3. **Intelligence Layer (Yogi-specific)** — Signal detection adjusts how much of pool #2 is deployed:
   - No anomalies: 100% deployed at full leverage
   - Low signals: 70-85% deployed, reduced leverage
   - Critical signals: 10-25% deployed, minimal leverage
   - Extreme vol: 0% deployed, lending only

### How It Works

```
User deposits USDC --> Voltr Vault
                       |
                       +-- 30% --> Lending Floor (Kamino/Marginfi — designed, post-hackathon)
                       |
                       +-- 70% --> Drift Perps (regime-adaptive arbitrage)
                                   |
                                   +-- Signal Detector (every 5 min)
                                   |   +-- OI imbalance shift (mass positioning)
                                   |   +-- Liquidation cascade (OI drop proxy)
                                   |   +-- Funding rate volatility (regime transition)
                                   |   +-- Spread blow-out (mark/oracle stress)
                                   |   +-- Cross-venue funding (Drift vs Binance/Bybit)
                                   |   --> Severity: CLEAR / LOW / HIGH / CRITICAL
                                   |
                                   +-- Regime Engine (vol x signal --> deployment)
                                   |   +-- Reads vol regime (Parkinson estimator)
                                   |   +-- Reads signal severity (detector output)
                                   |   --> deploymentPct + maxLeverage + rebalanceMode
                                   |
                                   +-- Imbalance Detector (OI + premium + funding)
                                   +-- Direction: SHORT or LONG based on composite signal
                                   +-- Maker limit orders (-0.002% rebate)
                                   +-- 30-second health monitoring
                                   +-- Low turnover: 7-day min hold
```

### What Makes Yogi Different — Built for Bear Markets

Most vaults break in bear markets. They react *after* the crash, not before. Yogi is different:

1. **5D Signal Detection** — not just volatility, but OI shifts, liquidation cascades, funding instability, spread blow-outs, AND cross-venue funding divergence. Five early warning systems, checked every 5 minutes.

2. **Cross-Venue Intelligence** — the only Drift vault that compares funding rates against Binance and Bybit in real time. When Drift DOGE funding is +2,000% but Binance is -6%, Yogi knows that's a distortion, not an opportunity.

3. **CEX Open Interest Tracking** — monitors $9.3B of BTC open interest and $1.3B of SOL open interest across Binance and Bybit. OI surges signal incoming volatility before it hits Drift.

4. **Regime Discipline** — vol at 57%? Yogi goes cautious (50% deployed, 0.5x leverage). Not because it's told to, but because the deployment matrix says high vol + clear signals = protect capital. Other vaults stay fully deployed and eat the drawdown.

5. **Adaptive Rotation** — DOGE funding collapsed? Yogi exits the SHORT within 4 hours and rotates to SUI. No manual intervention. The keeper decides based on funding scans across 73 Drift markets.

6. **Bidirectional** — not just shorts. When SOL funding is -2,000% APY, Yogi goes LONG to collect. When SUI is +1,200%, Yogi goes SHORT. Always on the collecting side, regardless of market direction. The regime is loosened for bidirectional because shorts and longs partially offset price risk.

**Every other vault shows a backtest. Yogi shows live mainnet performance through a -7.4% BTC drawdown with zero loss.**

| Scenario | Vol-Only Baseline | Yogi |
|----------|-------------------|------|
| Low vol, no stress | 100% @ 2.0x | 100% @ 2.0x (same) |
| Low vol, OI shifting | 100% @ 2.0x (blind) | 80% @ 1.5x (cautious) |
| Low vol, liquidation cascade | 100% @ 2.0x (blind) | 25% @ 0.5x (defensive) |
| High vol, no stress | 50% @ 0.5x | 50% @ 0.5x (same) |
| High vol, critical signals | 50% @ 0.5x (blind) | 10% @ 0.0x (shut down) |

### Yield Stack

| Source | Mechanism | Est. APY | Status |
|--------|-----------|----------|--------|
| Bidirectional funding | SHORT positive + LONG negative markets simultaneously | 8-15% | **Live** |
| Premium convergence | Mark/oracle deviation mean-reverts | 2-4% | **Live** (via imbalance detector) |
| Cross-venue intelligence | Entry optimization via Binance/Bybit comparison | 1-2% | **Live** |
| Lending floor | Route idle USDC to Kamino/Marginfi | 1.5-2% | Designed, post-hackathon |
| LST collateral | jitoSOL staking + MEV | 1.5-2% | Designed, post-hackathon |
| **Live combined** | | **11-21%** | |
| **Full stack target** | | **14-24% (hostile) / 20-30% (normal)** | |

## Architecture

### Components

| Module | File | Purpose |
|--------|------|---------|
| Signal Detector | `src/keeper/drift-signal-detector.ts` | 4-dimension Drift anomaly detection (OI shift, liquidation, funding vol, spread) |
| Cross-Venue Detector | `src/keeper/cross-venue-detector.ts` | 5th dimension: compares Drift funding vs Binance/Bybit for convergence signals |
| Regime Engine | `src/keeper/regime-engine.ts` | Vol x signal severity --> deployment % and leverage cap |
| Imbalance Detector | `src/keeper/imbalance-detector.ts` | Reads OI, mark/oracle spread, funding — computes composite signal and direction |
| Yield Stacker | `src/keeper/yield-stacker.ts` | Multi-protocol lending optimization, LST yield (designed, post-hackathon) |
| Funding Scanner | `src/keeper/funding-scanner.ts` | Fetches and ranks all Drift perp markets by funding rate |
| Cost Calculator | `src/keeper/cost-calculator.ts` | Maker fee model — 1.6 bps round-trip cost |
| Leverage Controller | `src/keeper/leverage-controller.ts` | Dynamic leverage scaling by vol regime |
| Health Monitor | `src/keeper/health-monitor.ts` | 30-second health ratio and drawdown checks |
| Position Manager | `src/keeper/position-manager.ts` | Bidirectional position management with market orders |
| Keeper Loop | `src/keeper/index.ts` | Main event loop — signals, regime, cross-venue, imbalance, rebalance |
| Config | `src/config/` | Strategy parameters, signal thresholds, deployment matrices |

## Regime Engine

The regime engine is Yogi's core differentiator. It combines two inputs into a deployment decision:

### Deployment Matrix (Vol Regime x Signal Severity)

|  | CLEAR | LOW | HIGH | CRITICAL |
|--|-------|-----|------|----------|
| **Very Low** (< 20% vol) | 100% @ 2.0x | 80% @ 1.5x | 50% @ 1.0x | 25% @ 0.5x |
| **Low** (20-35%) | 85% @ 1.5x | 70% @ 1.2x | 40% @ 0.8x | 20% @ 0.3x |
| **Normal** (35-50%) | 70% @ 1.0x | 55% @ 0.8x | 30% @ 0.5x | 15% @ 0.2x |
| **High** (50-75%) | 50% @ 0.5x | 35% @ 0.3x | 20% @ 0.2x | 10% @ 0.0x |
| **Extreme** (> 75%) | 0% @ 0.0x | 0% @ 0.0x | 0% @ 0.0x | 0% @ 0.0x |

Key design principle: **signals can only reduce deployment, never increase it.** Extreme vol shuts down regardless. The intelligence layer catches danger *between* vol regime transitions.

### Signal Detection Thresholds

| Dimension | LOW | HIGH | CRITICAL |
|-----------|-----|------|----------|
| OI Imbalance Shift | 5% in 1h | 15% | 30% |
| Liquidation Cascade (OI drop) | 5% in 1h | 15% | 30% |
| Funding Rate Volatility | 500 bps annualized | 1500 bps | 3000 bps |
| Spread Blow-out (mark/oracle) | 0.5% | 1.5% | 3.0% |

**5th Dimension — Cross-Venue Funding:**

| Signal | Condition | Entry Adjustment |
|--------|-----------|-----------------|
| `drift_high` | Drift funding > CEX by 5%+ APY | SHORT profitable but flag convergence risk |
| `drift_low` | Drift funding < CEX by 5%+ APY | Potential LONG as Drift converges up |
| `aligned` | Drift ≈ CEX (within 5% APY) | High confidence — strengthen base signal |

Cross-venue data is fetched from Binance and Bybit funding rate APIs every 5 minutes. No other Drift vault compares funding across venues to optimize entry timing.

All thresholds are configurable in `STRATEGY_CONFIG` without recompilation.

## Execution Cost Gate

Currently using market orders for reliable fills at small position sizes. Maker limit orders (`postOnly`) are supported and will be re-enabled at larger AUM where fills are consistent:

| | Taker (legacy) | Maker (Yogi) |
|---|---|---|
| Drift fee | 0.035% (pay) | -0.002% (rebate) |
| Round-trip cost | 0.17% | 0.016% |
| Break-even (7-day hold) | 8.9% APY | 0.83% APY |

## Bear Market Resilience

| Market Condition | Vol | Signals | Deployment | Direction | Revenue Sources |
|-----------------|-----|---------|------------|-----------|----------------|
| Bull (longs dominant) | Low | CLEAR | 100% @ 2.0x | SHORT | Funding + premium + cross-venue |
| Bear (shorts dominant) | Normal | LOW | 55% @ 0.8x | LONG | Funding + discount + cross-venue |
| Bear + contagion | Normal | CRITICAL | 15% @ 0.2x | LONG (minimal) | Lending (optimized) |
| Crisis (extreme vol) | Extreme | Any | 0% @ 0.0x | None | Lending only |
| Recovery | Low | CLEAR | 100% @ 2.0x | Signal-based | Full yield stack |

## Risk Management

| Parameter | Value |
|-----------|-------|
| Max drawdown | 3% reduce / 5% close all |
| Max leverage | 2x (regime-adaptive) |
| Health check | Every 30 seconds |
| Signal detection | Every 5 minutes |
| Health critical | Close all at 1.08 |
| Signal CRITICAL | Force reduce largest position |
| Max per market | 40% |
| Max markets | 3 (whitelist: SOL/BTC/ETH/DOGE/SUI/AVAX) |
| Min hold | 7 days |
| Max rotations | 2 per week |
| Min signal strength | 20% composite (40% in cautious/defensive mode) |
| Emergency rebalance | Triggered on 30%+ deployment drop |
| Negative equity | Emergency close all |

## Backtest Results

32-day comparative backtest (Feb 13 – Mar 16, 2026):

| Metric | Baseline (vol-only) | Yogi (intelligent) |
|--------|----------------|-------------------|
| Final equity | $100,619 | $100,516 |
| Total return | +0.62% | +0.52% |
| Annualized APY | 7.06% | 5.89% |
| Max drawdown | 0.05% | **0.04% (-21%)** |
| Sharpe ratio | 17.64 | 17.60 |
| Trading costs | $371 | **$312 (-16%)** |

**Why Yogi's APY is lower**: The 32-day period was calm — no HIGH or CRITICAL signals fired. Yogi's conservative LOW-signal deployment (70% vs 100%) reduced returns slightly. In a stress event, this relationship flips: Yogi avoids losses that vol-only strategies take.

**Backtest limitation**: Uses funding-only revenue with reconstructed signals. OI/premium/LST/lending yield not reflected. The backtest APY is a **conservative lower bound**.

## Fees

| Fee | Amount |
|-----|--------|
| Management fee | 1% annual |
| Performance fee | 20% of profits |
| Deposit fee | None |
| Withdrawal fee | 0.1% |
| Withdrawal period | 24 hours |

## Testing

**38 unit tests** across 6 test suites covering all strategy modules:

```bash
npm test
```

Tests validate: cost calculator (maker model), leverage controller, funding scanner (whitelist/blacklist), imbalance detector (signal scoring, direction logic, market filtering), regime engine (deployment matrix, emergency triggers, intelligence layer advantage), and drift signal detector (severity levels, formatting).

## Demo & Dashboard

- **Pitch presentation**: `demo/presentation.html` — 8-slide auto-advancing pitch (80 seconds)
- **Live dashboard**: `demo/dashboard.html` — real Drift data + signal detection, no server needed
- **Demo video**: `demo/yogi-demo.mp4` — generated from presentation slides
- **Voiceover script**: `demo/voiceover-script.md` — narration for each slide

```bash
open demo/presentation.html    # View pitch deck
open demo/dashboard.html       # Live monitoring dashboard
node demo/record.js            # Generate demo video (requires puppeteer + ffmpeg)
```

## Mainnet Deployment

Yogi is **live on Solana mainnet** with an automated keeper running 24/7 on AWS EC2.

### On-Chain Addresses

| Component | Address |
|-----------|---------|
| Voltr Vault | `BFDTTG8nJF7uLf3wsqFJpYCvC6wA6BahBRKjTgtKPy4n` |
| Vault Admin | `58dpPSAM3PuzziKgRkFGTFM3xY4fH4xFgzDBe3nnF6gg` |
| Vault Manager | `9Rx3i7GyVFFUYGKCMDZQpqnoJgSzo3R1qwmsAN5aiiSu` |
| Drift Strategy PDA | `FCxpLFtjChHjJ86V9mYFTN2QGXHPxR5LjLPGVGBA68rJ` |
| Vault Drift User | `HURzSVDvBBA9VEZ1j1SQhn4iHUhxua3ZNhFejGgfpuq8` |
| Voltr Program | `vVoLTRjQmtFpiYoegx285Ze4gsLJ8ZxgFKVcuvmG1a8` |
| Drift Adaptor | `EBN93eXs5fHGBABuajQqdsKRkCgaqtJa8vEFD6vKXiP` |
| Drift Program | `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH` |

### Deployment Architecture

```
User deposits USDC --> Voltr Vault (BFDTTG8n...)
                       |
                       +-- manager-deposit-strategy --> Drift Adaptor CPI
                       |                                |
                       |                                +-- Vault Drift User (HURzSV...)
                       |                                    |
                       +-- Keeper (EC2, 24/7)               |
                            |                               |
                            +-- Delegate trading authority --+
                            +-- Signal detection (5 min)
                            +-- Health monitoring (30 sec)
                            +-- Rebalance (4 hours)
```

The keeper operates as a **delegate** on the vault's Drift user account. Capital flows through the Voltr adaptor (deposit/withdraw), while trading uses Drift SDK's delegate model for order placement. This means all trades and PnL are on-chain and verifiable through the vault's Drift account.

### Deployment Steps

```bash
# 1. Clone and install
git clone https://github.com/psyto/yogi.git
cd yogi
npm install

# 2. Configure
cp .env.example .env
# Edit .env with RPC URL, keypair paths, vault address

# 3. Initialize vault (one-time)
npm run admin:init-vault        # Creates Voltr vault, outputs VAULT_ADDRESS
npm run admin:add-adaptor       # Registers Drift adaptor
npx tsx src/scripts/manager-init-strategy.ts  # Initializes Drift user for vault

# 4. Deposit USDC
npx tsx src/scripts/user-deposit-vault.ts           # User deposits to vault
npx tsx src/scripts/manager-deposit-strategy.ts     # Manager moves funds to Drift

# 5. Run keeper
npm run keeper                  # Local
# Or with pm2 for production:
pm2 start 'npx tsx src/keeper/index.ts' --name yogi-keeper
pm2 save && pm2 startup
```

## Tech Stack

- **Vault infrastructure**: [Voltr / Ranger Earn](https://vaults.ranger.finance) — deposits, LP shares, fee collection
- **Trading**: [Drift Protocol v2](https://docs.drift.trade) — perpetual futures execution via delegate model
- **Keeper**: TypeScript bot on AWS EC2 with pm2 process management
- **Signal detection**: 5-dimension anomaly detector + cross-venue (Binance/Bybit) + CEX OI tracking
- **Vol computation**: Parkinson estimator on SOL-PERP hourly candles
- **Data feed**: [Drift Data API](https://data.api.drift.trade) — funding rates, market stats, OHLC candles
- **RPC**: Helius (websocket subscription mode)

## Hackathon

Built for the [Ranger Build-A-Bear Hackathon](https://ranger.finance/build-a-bear-hackathon) (Mar 9 – Apr 6, 2026).

- **Track**: Main + Drift Side Track
- **Base asset**: USDC
- **Lock period**: 3-month rolling
- **Vault on-chain**: `BFDTTG8nJF7uLf3wsqFJpYCvC6wA6BahBRKjTgtKPy4n`

### Why Yogi Should Win

**1. Built for bear markets** — the hackathon is called "Build-A-Bear." Yogi delivered +1.61% during a -7.4% BTC week with zero drawdown. That's the thesis.

**2. No other submission has cross-venue intelligence** — comparing Drift funding against Binance and Bybit in real time. When Drift DOGE funding is +2,000% and Binance is -6%, Yogi sees the distortion. Other vaults are blind.

**3. Live mainnet performance, not backtests** — deployed March 20, running continuously since. On-chain verifiable via the Drift UI and Solscan.

**4. Production-ready architecture** — Voltr vault integration, delegate trading model, position loading on restart, 30-second health monitoring. Ready for $500K seeding on day one.

**5. 5D anomaly detection is genuinely novel** — OI shifts, liquidation cascades, funding volatility, spread blow-outs, AND cross-venue CEX comparison. Five dimensions of early warning that no Drift vault has.

## License

MIT
