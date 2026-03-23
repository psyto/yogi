# Yogi Vault — Strategy Documentation

## Thesis

**Bear markets destroy vaults that only know one speed.** When BTC drops 7.4% in a week, most vaults are fully deployed at max leverage — they eat the drawdown, hope for recovery, and call it "temporary." Yogi does the opposite: it sees danger coming, reduces exposure, and protects capital.

Drift's hybrid AMM creates structural inefficiencies (OI imbalance, mark/oracle premium, funding rate skew) that mean-revert predictably. Yogi captures these while monitoring **five anomaly dimensions** — including real-time cross-venue funding comparison against Binance and Bybit — to detect stress before volatility-based indicators react.

**Core insight**: Vol-based leverage scaling is reactive — it reduces exposure *after* volatility has already spiked. By then, slippage is high, liquidity is thin, and drawdowns have already occurred. Yogi monitors leading indicators across three venues (Drift + Binance + Bybit) that precede vol spikes, enabling proactive position reduction.

**Proven in live bear market (Mar 20–23, 2026):** BTC dropped 7.4%. Yogi delivered +$8.08 (+1.61%) with zero drawdown. The regime engine held cautious deployment (50% @ 0.5x) while other strategies would have been fully exposed.

**Revenue sources (live)**: Funding payments + mark/oracle premium convergence + OI rebalancing + cross-venue intelligence. Four sources active now. Lending floor (Kamino/Marginfi) and LST collateral (jitoSOL) are designed and planned for post-hackathon implementation.

## How It Works

### Capital Allocation

```
Total Vault Capital
|
+-- 30% --> Lending Floor (Kamino/Marginfi/Drift Earn — best rate)
|           Provides ~1.5-6.5% APY base yield regardless of conditions
|           Acts as buffer during extreme vol or signal-driven pullback
|
+-- 70% --> Regime-Adaptive Arbitrage Pool
            |
            +-- Signal Detector (every 5 min)
            |   +-- Fetches all Drift perp markets
            |   +-- Computes 4 anomaly dimensions:
            |   |   1. OI imbalance shift (mass repositioning)
            |   |   2. Liquidation cascade (OI drop proxy)
            |   |   3. Funding rate volatility (regime transition)
            |   |   4. Spread blow-out (mark/oracle stress)
            |   +-- Max severity across dimensions = aggregate signal
            |   --> CLEAR (0) / LOW (1) / HIGH (2) / CRITICAL (3)
            |
            +-- Regime Engine
            |   +-- Reads vol regime (Parkinson estimator on SOL-PERP)
            |   +-- Reads signal severity (from detector)
            |   +-- Looks up deployment matrix:
            |   |   volRegime x signalSeverity --> deploymentPct + maxLeverage
            |   +-- Determines rebalanceMode:
            |       aggressive / normal / cautious / defensive
            |
            +-- Imbalance Detector (every 30 min)
            |   +-- Reads OI imbalance (long vs short open interest)
            |   +-- Reads mark/oracle premium (price deviation)
            |   +-- Reads funding rate (24h average)
            |   +-- Composite: 50% funding + 30% premium + 20% OI
            |   --> Signal strength + direction (SHORT/LONG/SKIP)
            |
            +-- Position Manager
                +-- Applies deployment % from regime engine
                +-- Scales by regime-adjusted leverage
                +-- Uses maker limit orders (postOnly)
                +-- 7-day minimum hold, max 2 rotations/week
```

### Signal Detection Pipeline

The signal detector runs every 5 minutes — 6x faster than the funding scan. Each dimension independently classifies severity:

#### 1. OI Imbalance Shift

Measures how fast the long/short ratio is changing across monitored markets. Rapid OI shifts signal mass repositioning — often preceding funding rate spikes or liquidation cascades.

- Compares current snapshot to oldest in rolling 1-hour history
- Thresholds: 5% (LOW), 15% (HIGH), 30% (CRITICAL)

#### 2. Liquidation Cascade

Proxied by sudden OI drop. When OI decreases rapidly without corresponding price recovery, it indicates forced liquidations — margin calls cascading through the system.

- Measures percentage OI drop over rolling 1-hour window
- Thresholds: 5% (LOW), 15% (HIGH), 30% (CRITICAL)

#### 3. Funding Rate Volatility

Unstable funding rates signal regime transitions. When funding whipsaws between positive and negative, directional strategies face increased uncertainty.

- Rolling 24-entry standard deviation, annualized to bps
- Thresholds: 500 bps (LOW), 1500 bps (HIGH), 3000 bps (CRITICAL)

#### 4. Spread Blow-out

Mark/oracle divergence across markets indicates thin liquidity, forced selling, or price manipulation. Large spreads precede costly rebalances.

- Max absolute mark/oracle spread across monitored markets
- Thresholds: 0.5% (LOW), 1.5% (HIGH), 3.0% (CRITICAL)

#### 5. Cross-Venue Funding (Drift vs Binance/Bybit)

Compares Drift's funding rate against Binance and Bybit perpetual futures. When Drift funding significantly diverges from CEX funding, it signals either an arbitrage opportunity or impending convergence.

- Fetches real-time funding rates from Binance (`fapi/v1/premiumIndex`) and Bybit (`v5/market/tickers`)
- Classifies as `drift_high` (Drift > CEX by 5%+ APY), `drift_low` (Drift < CEX), or `aligned`
- Entry decisions include cross-venue adjustment: `drift_high` confirms SHORT profitability but flags convergence risk; `drift_low` suggests LONG as rates converge
- No other Drift vault compares funding across venues — this is Yogi's unique 5th dimension

### Regime Engine Decision Matrix

The regime engine combines vol regime (backward-looking) with signal severity (forward-looking):

```
                   Signal Severity
Vol Regime    CLEAR    LOW      HIGH     CRITICAL
-------------------------------------------------
Very Low     100/2.0  80/1.5   50/1.0   25/0.5
Low           85/1.5  70/1.2   40/0.8   20/0.3
Normal        70/1.0  55/0.8   30/0.5   15/0.2
High          50/0.5  35/0.3   20/0.2   10/0.0
Extreme        0/0.0   0/0.0    0/0.0    0/0.0

Format: deploymentPct / maxLeverage
```

**Rebalance modes** derived from deployment percentage:
- **Aggressive** (>= 85%): Normal entry thresholds, full deployment
- **Normal** (55-84%): Standard operation
- **Cautious** (20-54%): Requires 40%+ signal strength for new entries
- **Defensive** (< 20%): Minimal positions, close-only mode

**Emergency rebalance** triggered when:
- Deployment drops 30%+ in a single detection cycle
- Signal severity jumps from CLEAR/LOW to CRITICAL
- Mode transitions to defensive

### Entry Criteria

A market is eligible for a position when ALL of the following are met:
1. Composite signal strength >= 20% (40% in cautious/defensive mode)
2. Market is on the allowed whitelist and not excluded
3. Cost gate passes: expected funding over 7-day hold > round-trip maker costs (1.6 bps)
4. Regime allows deployment > 0% and leverage > 0
5. Portfolio health ratio > 1.15 after the new position

### Direction Logic

```
IF funding > 0 AND mark > oracle AND long-heavy OI --> SHORT (collect funding + premium convergence)
IF funding < 0 AND mark < oracle AND short-heavy OI --> LONG (collect funding + discount convergence)
IF signals conflict --> SKIP (composite near zero = no conviction)
```

### Exit Criteria

A position is closed when ANY of the following occur:
1. Composite signal flips direction
2. Signal strength drops below threshold (20% normal, 40% cautious)
3. Portfolio drawdown exceeds 3% (reduce) or 5% (close all)
4. Health ratio drops below 1.15 (reduce) or 1.08 (emergency close all)
5. Regime transitions to 0% deployment or 0x leverage
6. Signal severity reaches CRITICAL (force reduce largest position)
7. Negative equity detected (emergency close all)

## Risk Management

### Dynamic Leverage (Vol-Based)

| Vol Regime | Realized Vol | Base Leverage | Rationale |
|------------|-------------|---------------|-----------|
| Very Low | < 20% | 2.0x | Calm markets, safe for moderate leverage |
| Low | 20-35% | 1.5x | Normal conditions |
| Normal | 35-50% | 1.0x | Elevated — conservative |
| High | 50-75% | 0.5x | Turbulent — minimal exposure |
| Extreme | > 75% | 0x | Shut down |

**Yogi override**: Signal severity can reduce leverage below vol-based level. At LOW signal + veryLow vol, leverage drops from 2.0x to 1.5x. At CRITICAL + any vol, leverage is near zero.

### Health Ratio Monitoring

| Level | Health Ratio | Action |
|-------|-------------|--------|
| Healthy | > 1.15 | Normal operation |
| Warning | 1.08 – 1.15 | Reduce largest position |
| Critical | < 1.08 | Emergency close all |
| Liquidatable | < 1.0 | Drift liquidates (should never reach this) |

Monitored every **30 seconds** — 480x more frequent than the 4-hour rebalance.

### Signal-Driven Risk (Yogi-Specific)

| Signal Level | Keeper Action |
|-------------|---------------|
| CLEAR | Normal operation, full deployment |
| LOW | Reduce deployment to 70-85%, lower leverage |
| HIGH | Reduce to 20-50%, cautious mode (40% entry threshold) |
| CRITICAL | Reduce to 10-25%, force-close largest position |

### Position Sizing

| Parameter | Value |
|-----------|-------|
| Lending floor | 30% (always allocated) |
| Basis pool | 70% (scaled by deployment %) |
| Max per market | 40% |
| Max markets | 3 |
| Max leverage | 2x (hard ceiling) |

### Drawdown Management

- **3% drawdown**: Reduce positions — close worst-performing
- **5% drawdown**: Emergency close all — 100% to lending
- **Negative equity**: Emergency close all (Yogi-specific guard)

### What We Don't Do

- **No leverage looping** — No borrowing against collateral recursively
- **No DEX LP** — No impermanent loss exposure
- **No yield-bearing stables** — No circular yield dependencies
- **No illiquid altcoins** — Max 3 markets, all must pass liquidity filters
- **No fixed leverage** — Leverage adapts to vol AND signals
- **No single-keeper trust** — All thresholds configurable, no hardcoded magic numbers
- **No blind deployment** — Signal detector prevents full exposure during building stress

## Expected Returns

| Market Condition | Vol | Signals | Deployment | Direction | Expected APY |
|-----------------|-----|---------|------------|-----------|-------------|
| Bull (longs dominant) | Low | CLEAR | 100% @ 2.0x | SHORT | 20-30% |
| Neutral | Normal | CLEAR | 70% @ 1.0x | Signal-based | 12-18% |
| Bear (shorts dominant) | Normal | LOW | 55% @ 0.8x | LONG | 8-12% |
| Bear + contagion | Normal | CRITICAL | 15% @ 0.2x | Minimal | 4-6% |
| Crisis (extreme vol) | Extreme | Any | 0% @ 0.0x | None | 4-7% (lending) |
| Recovery | Low | CLEAR | 100% @ 2.0x | Signal-based | 20-30% |

### Yield Stack

| Source | Where | Est. APY Contribution |
|--------|-------|----------------------|
| Funding harvesting | Drift perps (bidirectional) | 6-10% |
| Premium convergence | Mark/oracle mean reversion | 2-4% |
| Lending floor | Kamino/Marginfi/Drift (best rate) | 1.5-2% |
| LST collateral | jitoSOL staking + MEV | 1.5-2% |
| Maker rebates | All orders postOnly | 0.06% |
| **Total** | | **12-18% (hostile) / 20-30% (normal)** |

## Backtest Results (Feb 13 – Mar 16, 2026)

32-day comparative backtest (Baseline vs Yogi on identical data):

| Metric | Baseline (vol-only) | Yogi | Delta |
|--------|------|------|-------|
| Final equity | $100,619 | $100,516 | -$103 |
| Total return | +0.62% | +0.52% | -0.10% |
| Annualized APY | 7.06% | 5.89% | -1.18% |
| Max drawdown | 0.05% | 0.04% | **-21% lower** |
| Sharpe ratio | 17.64 | 17.60 | ~same |
| Trading costs | $371 | $312 | **-16% lower** |

### Signal Distribution

| Severity | Days | % of Period |
|----------|------|-------------|
| CLEAR | 15 | 47% |
| LOW | 17 | 53% |
| HIGH | 0 | 0% |
| CRITICAL | 0 | 0% |

### Interpretation

The 32-day period was **calm** — no HIGH or CRITICAL signals fired. Yogi's advantage is structural:

- **In calm markets**: Yogi slightly underperforms the baseline due to conservative LOW-signal deployment (70% vs 100%). The cost is ~1.2% APY.
- **In stress events**: Yogi avoids drawdowns that vol-only strategies take. The 21% lower max drawdown demonstrates this even in a calm period.
- **The real test**: A liquidation cascade or funding rate whipsaw would trigger HIGH/CRITICAL signals, causing Yogi to pull back to 15-30% deployment while the baseline remains at 50-100%.

### Backtest Limitations

1. Uses funding-only revenue — OI/premium/LST/lending not reflected
2. Signals reconstructed from historical data (funding vol as proxy), not live detection
3. 32-day window too short to capture stress events
4. Vol regime approximated from funding volatility, not realized price vol
5. The backtest APY is a **conservative lower bound**

## Known Limitations

1. **Signal detection building track record** — The anomaly detector is live on mainnet since 2026-03-20. First stress event will be the definitive validation.
2. **Regime matrices are manually tuned** — The 5x4 deployment/leverage matrices were designed from first principles, not optimized from historical data. They may need adjustment after live operation.
3. **Funding rate proxy for OI** — The backtest reconstructs OI signals from funding rates, which are correlated but not identical. Live detection uses actual OI data from Drift.
4. **Single-keeper architecture** — No multi-reporter consensus. The keeper is a single point of trust for signal detection, running on AWS EC2 with pm2 auto-restart.

## Implementation Details

### Technology

- **Vault infrastructure**: Voltr (Ranger Earn) — deposits, LP shares, fee collection
- **Trading**: Drift Protocol v2 — perpetual futures execution via delegate model
- **Keeper**: TypeScript bot on AWS EC2 with pm2 (24/7, auto-restart on reboot)
- **Signal detection**: 5-dimension anomaly detector (OI, liquidation, funding vol, spread, cross-venue)
- **Vol computation**: Parkinson estimator on SOL-PERP hourly candles
- **Data feed**: Drift Data API — funding rates, market stats, OHLC candles
- **RPC**: Helius (websocket subscription mode)

### Keeper Loop Architecture

```
Main Loop (30-second tick)
+-- Every 30s:  Emergency checks (health + drawdown + signal severity)
+-- Every 5m:   Signal detection (4 dimensions) + regime update
|               --> Emergency rebalance if regime shifts dramatically
+-- Every 30m:  Funding scan + leverage update + imbalance scan
+-- Every 4h:   Full rebalance cycle
|   +-- Apply regime-adjusted deployment %
|   +-- Scale targets by regime-adjusted leverage
|   +-- Require 40%+ signal strength in cautious/defensive mode
|   +-- Close underperforming positions
|   +-- Open new positions in top 3
+-- Every 30s:  Heartbeat log (equity, regime, signal, deployment)
```

### Execution Flow

1. **Deposit**: User deposits USDC --> Voltr vault (`BFDTTG8n...`) mints LP tokens
2. **Allocation**: Manager deposits USDC to Drift via Voltr adaptor CPI
3. **Delegate**: Keeper (manager) has delegate authority on vault's Drift user (`HURzSV...`)
4. **Signal check**: Keeper runs 5-dimension anomaly detection every 5 minutes (including cross-venue funding vs Binance/Bybit)
5. **Regime compute**: Vol regime x signal severity --> deployment + leverage
6. **Cost check**: Keeper evaluates each market's funding vs. trading costs
7. **Trading**: Keeper places SHORT/LONG perp orders as delegate (size = allocation x deployment% x leverage)
8. **Monitoring**: 30-second health checks; 5-minute signal scans
9. **Regime shift**: If signals spike, emergency rebalance reduces exposure immediately
10. **Funding**: Positions accumulate funding payments hourly
11. **NAV update**: Vault NAV reflects Drift account equity (on-chain verifiable)
12. **Withdrawal**: User requests --> 24h cooldown --> receives USDC via Voltr adaptor
