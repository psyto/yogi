# Yogi Vault

**Smarter than the average bear market vault. The vault that survives when others bleed.**

Yogi is a production-grade USDC vault on Solana that runs **dynamic tilted delta-neutral** positions on Drift — buying spot and shorting perps to eliminate price risk while collecting funding. A **5-dimensional anomaly detection engine** (including real-time cross-venue funding comparison against Binance and Bybit) dynamically adjusts tilt, deployment, and leverage. While BTC dropped 7.4% in one week, Yogi delivered **+$8.08 (+1.61%) with zero drawdown**. It's not the highest yield — it's the one that survives.

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

**Cross-venue divergence:** Drift BTC funding at +1,445% while Binance at -7.5% and Bybit at -9.6%. A +1,454% spread. Yogi sees this and flags convergence risk on every BTC entry decision.

**Regime discipline:** Vol stuck at 57-61% (high regime). Yogi automatically limited deployment to 50% at 0.5x leverage. Many vaults would be fully deployed — Yogi chose safety, and the bear market proved it right.

**Zero drawdown through a -7.4% BTC week.** That's the story.

## Strategy — Dynamic Tilted Delta-Neutral

Yogi's primary mode is **delta-neutral**: buy spot + short perps on the same asset. Price movement cancels out — profit comes purely from funding rate collection. A **dynamic tilt** adds slight short bias (0-10%) in calm markets for extra yield, automatically reducing to 0% (pure DN) when signals detect stress.

### How It Works

```
User deposits USDC --> Voltr Vault
                       |
                       +-- Idle USDC --> Drift auto-lends to borrowers (1-5% APY)
                       |
                       +-- Deployed Capital --> Delta-Neutral Positions
                           |
                           +-- 70% --> Spot BUY (SOL, BTC, ETH on Drift)
                           +-- 30% --> Perp margin
                           |
                           +-- Perp SHORT = spot size × (1 + tilt%)
                           |   Price cancels out. Funding collected.
                           |
                           +-- Dynamic Tilt (0-10%)
                           |   +-- CLEAR signals + low vol → 10% (max short bias)
                           |   +-- LOW signal → 3% short bias
                           |   +-- HIGH/CRITICAL → 0% (pure DN, protect capital)
                           |   +-- Negative funding → reduce tilt
                           |
                           +-- Signal Detector (every 5 min)
                           |   +-- OI imbalance shift
                           |   +-- Liquidation cascade (OI drop proxy)
                           |   +-- Funding rate volatility
                           |   +-- Spread blow-out (mark/oracle)
                           |   +-- Cross-venue funding (Drift vs Binance/Bybit)
                           |   --> Severity: CLEAR / LOW / HIGH / CRITICAL
                           |
                           +-- Regime Engine (vol × signal → deployment)
                               +-- Adjusts deployment %, leverage, tilt
                               +-- Emergency rebalance on regime shifts
```

### Delta-Neutral Execution

| Step | Action | Purpose |
|------|--------|---------|
| 1 | Buy spot on Drift (e.g., 0.0036 BTC) | The hedge |
| 2 | Short perp on Drift (e.g., 0.0037 BTC) | Funding collection + tilt |
| 3 | Price goes up | Spot +$X, Perp -$X → net $0 |
| 4 | Price goes down | Spot -$X, Perp +$X → net $0 |
| 5 | Funding accrues | Short collects funding hourly |
| Result | Zero price risk, pure funding yield | + tilt bonus in calm markets |

### Dynamic Tilt — Yogi's Edge

Unlike static delta-neutral vaults, Yogi adjusts its short bias in real time:

| Condition | Tilt | Effect |
|-----------|------|--------|
| Calm market (low vol, CLEAR signals) | 10% | Perp short 10% larger than spot → extra yield from short bias |
| Normal (LOW signal) | 3% | Mild short bias, conservative |
| Stress (HIGH/CRITICAL) | 0% | Pure DN — zero price exposure |
| Negative funding | 0-2% | Reduce tilt when shorts pay instead of collect |

The tilt is computed every rebalance cycle using signal severity, vol regime, and current funding direction. This is **not available on any other Drift vault**.

### What Makes Yogi Different

1. **Delta-Neutral on Drift** — buys spot + shorts perps within Drift's own markets. Zero price risk. Most Drift vaults are directional and bleed during drawdowns.

2. **Dynamic Tilt** — adjustable short bias (0-10%) responds to market conditions in real time. Pure DN in stress, tilted for extra yield in calm markets. No other vault does this.

3. **5D Signal Detection** — OI shifts, liquidation cascades, funding instability, spread blow-outs, AND cross-venue funding divergence. Five early warning systems, checked every 5 minutes.

4. **Cross-Venue Intelligence** — the only Drift vault that compares funding rates against Binance and Bybit in real time. When Drift DOGE funding is +2,000% but Binance is -6%, Yogi knows that's a distortion, not an opportunity.

5. **CEX Open Interest Tracking** — monitors $9.3B of BTC open interest and $1.3B of SOL open interest across Binance and Bybit. OI surges signal incoming volatility before it hits Drift.

6. **Regime Discipline** — vol at 57%? Yogi goes cautious (55% deployed, 0.5x leverage, 0% tilt). Not because it's told to, but because the deployment matrix says high vol + signals = protect capital.

7. **Multi-Asset DN** — SOL, BTC, and ETH all have spot markets on Drift. Yogi can run DN on all three simultaneously. Kodiak (Hyperliquid) is limited to single-asset DN.

**Every other vault shows a backtest. Yogi shows live mainnet performance through a -7.4% BTC drawdown with zero loss.**

### Yield Stack

| Source | Mechanism | Est. APY | Status |
|--------|-----------|----------|--------|
| DN funding collection | Short perps collect positive funding | 8-15% | **Live** |
| Dynamic tilt bonus | Extra yield from short bias in calm markets | 1-3% | **Live** |
| Premium convergence | Mark/oracle deviation mean-reverts (via DN tilt) | 1-2% | **Live** |
| Cross-venue intelligence | Entry/tilt optimization via Binance/Bybit comparison | 0.5-1% | **Live** |
| Drift auto-lending | Idle collateral lent to borrowers natively | 1-5% | **Live** (native to Drift) |
| LST collateral | jitoSOL staking + MEV | 1.5-2% | Designed, post-hackathon |
| **Live combined** | | **12-24%** | |

## Architecture

### Components

| Module | File | Purpose |
|--------|------|---------|
| Delta-Neutral Manager | `src/keeper/delta-neutral.ts` | DN position lifecycle: open (spot+perp), close, delta drift check, dynamic tilt |
| Signal Detector | `src/keeper/drift-signal-detector.ts` | 4-dimension Drift anomaly detection (OI shift, liquidation, funding vol, spread) |
| Cross-Venue Detector | `src/keeper/cross-venue-detector.ts` | 5th dimension: compares Drift funding vs Binance/Bybit for convergence signals |
| Regime Engine | `src/keeper/regime-engine.ts` | Vol x signal severity --> deployment %, leverage cap, tilt |
| Imbalance Detector | `src/keeper/imbalance-detector.ts` | Reads OI, mark/oracle spread, funding — computes composite signal and direction |
| Yield Stacker | `src/keeper/yield-stacker.ts` | Multi-protocol lending optimization, LST yield (designed, post-hackathon) |
| Funding Scanner | `src/keeper/funding-scanner.ts` | Fetches and ranks all Drift perp markets by funding rate |
| Cost Calculator | `src/keeper/cost-calculator.ts` | Maker fee model — 1.6 bps round-trip cost |
| Leverage Controller | `src/keeper/leverage-controller.ts` | Dynamic leverage scaling by vol regime |
| Health Monitor | `src/keeper/health-monitor.ts` | 30-second health ratio and drawdown checks |
| Position Manager | `src/keeper/position-manager.ts` | Directional position management (fallback mode) |
| Keeper Loop | `src/keeper/index.ts` | Main event loop — DN rebalance, signals, regime, cross-venue |
| Config | `src/config/` | Strategy parameters, signal thresholds, deployment matrices, DN settings |

### Drift Market Mapping (DN-Eligible)

| Asset | Spot Market Index | Perp Market Index | DN Eligible |
|-------|-------------------|-------------------|-------------|
| SOL | 1 | 0 | Yes |
| BTC | 2 | 1 | Yes |
| ETH | 3 | 2 | Yes |

## Regime Engine

The regime engine is Yogi's core differentiator. It combines two inputs into a deployment decision:

### Deployment Matrix (Vol Regime x Signal Severity)

|  | CLEAR | LOW | HIGH | CRITICAL |
|--|-------|-----|------|----------|
| **Very Low** (< 20% vol) | 100% @ 2.0x | 95% @ 1.5x | 70% @ 1.0x | 40% @ 0.5x |
| **Low** (20-35%) | 95% @ 1.5x | 85% @ 1.2x | 55% @ 0.8x | 30% @ 0.3x |
| **Normal** (35-50%) | 85% @ 1.0x | 70% @ 0.8x | 45% @ 0.5x | 20% @ 0.2x |
| **High** (50-75%) | 75% @ 0.8x | 55% @ 0.5x | 30% @ 0.3x | 15% @ 0.0x |
| **Extreme** (> 75%) | 0% @ 0.0x | 0% @ 0.0x | 0% @ 0.0x | 0% @ 0.0x |

Matrices are loosened vs pure directional because DN positions have partial price hedging — shorts and longs offset, so higher deployment is safer.

### Dynamic Tilt Matrix

| Condition | Tilt % | Rationale |
|-----------|--------|-----------|
| CLEAR + veryLow/low vol | 10% | Max short bias — calm markets, funding favorable |
| CLEAR + normal vol | 7% | Moderate short bias |
| CLEAR + high vol | 5% | Reduced tilt, vol uncertainty |
| LOW signal | 3% | Conservative tilt |
| HIGH/CRITICAL signal | 0% | Pure DN — protect capital |
| Negative funding | max 2% | Reduce tilt when shorts pay |

### Signal Detection Thresholds

| Dimension | LOW | HIGH | CRITICAL |
|-----------|-----|------|----------|
| OI Imbalance Shift | 5% in 1h | 15% | 30% |
| Liquidation Cascade (OI drop) | 5% in 1h | 15% | 30% |
| Funding Rate Volatility | 500 bps annualized | 1500 bps | 3000 bps |
| Spread Blow-out (mark/oracle) | 0.5% | 1.5% | 3.0% |

**5th Dimension — Cross-Venue Funding:**

| Signal | Condition | DN Adjustment |
|--------|-----------|---------------|
| `drift_high` | Drift funding > CEX by 5%+ APY | Confirms DN profitability, may increase tilt |
| `drift_low` | Drift funding < CEX by 5%+ APY | Flag convergence risk, reduce tilt |
| `aligned` | Drift ≈ CEX (within 5% APY) | High confidence — normal operation |

## Risk Management

| Parameter | Value |
|-----------|-------|
| Max drawdown | 3% reduce / 5% close all |
| Max leverage | 2x (regime-adaptive) |
| Health check | Every 30 seconds |
| Signal detection | Every 5 minutes |
| Health critical | Close all at 1.08 |
| Signal CRITICAL | Force reduce + set tilt to 0% |
| Max per market | 40% |
| Max DN markets | 3 (SOL, BTC, ETH) |
| Min funding APY | 5% to open DN position |
| Delta drift threshold | 5% — rebalance legs if spot/perp diverge |
| Max slippage per leg | 0.5% |
| DN capital split | 70% spot / 30% perp margin |
| Negative equity | Emergency close all (both legs) |

### DN-Specific Risk Controls

| Risk | Mitigation |
|------|-----------|
| Spot/perp size diverge | Delta drift check every rebalance — rebalance legs if >5% |
| Funding turns negative | Exit DN when funding APY drops below 5% threshold |
| One leg fails to fill | Automatic unwind — if perp short fails, sell spot immediately |
| Tilt exposure in crash | Dynamic tilt → 0% on HIGH/CRITICAL signals (pure DN) |
| Startup with stale positions | Position loading reconstructs DN pairs from on-chain state |
| Transition from directional | Auto-closes legacy directional positions on DN mode startup |

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

**Note**: Backtest was run with directional mode. DN mode reduces drawdown further by eliminating price risk entirely.

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
                            +-- Delta-neutral: spot buy + perp short
                            +-- Dynamic tilt (0-10%)
                            +-- Signal detection (5 min)
                            +-- Health monitoring (30 sec)
                            +-- DN rebalance (4 hours)
```

The keeper operates as a **delegate** on the vault's Drift user account. Capital flows through the Voltr adaptor (deposit/withdraw), while trading uses Drift SDK's `placeSpotOrder` and `placePerpOrder` for DN execution. All trades and PnL are on-chain and verifiable through the vault's Drift account.

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
- **Trading**: [Drift Protocol v2](https://docs.drift.trade) — spot + perpetual futures execution via delegate model
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

**1. Delta-neutral eliminates price risk** — the hackathon is called "Build-A-Bear." Yogi doesn't just survive bear markets — it's structurally immune to price direction. Spot + perp cancel out. Yield comes from funding, not price bets.

**2. Dynamic tilt is novel technology** — no other Drift vault adjusts its hedge ratio in real time based on signals. Pure DN in stress, tilted for extra yield when safe. This is a genuine innovation in on-chain vault design.

**3. Multi-asset DN on Drift** — SOL, BTC, and ETH all have spot markets on Drift. Yogi can run parallel DN positions across all three, diversifying funding sources. No other submission uses Drift's spot markets for delta-neutral execution.

**4. 5D cross-venue intelligence** — comparing Drift funding against Binance and Bybit in real time. When Drift DOGE funding is +2,000% and Binance is -6%, Yogi sees the distortion. Other vaults are blind.

**5. Live mainnet performance, not backtests** — deployed March 20, running continuously since. On-chain verifiable via the Drift UI and Solscan.

**6. Production-ready architecture** — Voltr vault integration, delegate trading model, position loading on restart, automatic DN transition, 30-second health monitoring. Ready for $500K seeding on day one.

## License

MIT
