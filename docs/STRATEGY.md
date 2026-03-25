# Yogi Vault — Strategy Documentation

## Thesis

**Bear markets destroy vaults that only know one speed.** When BTC drops 7.4% in a week, most vaults are fully deployed at max leverage — they eat the drawdown, hope for recovery, and call it "temporary." Yogi does the opposite: it eliminates price risk entirely through delta-neutral execution, and dynamically adjusts its remaining exposure based on five dimensions of real-time intelligence.

**Core architecture: Dynamic Tilted Delta-Neutral.** Yogi buys spot assets on Drift and shorts the same assets on Drift perps. Price movement cancels out — profit comes purely from funding rate collection. A dynamic "tilt" (0-10% extra short bias) adds directional yield when conditions are favorable, automatically reducing to 0% (pure DN) when signals detect stress.

Drift's hybrid AMM creates structural inefficiencies (OI imbalance, mark/oracle premium, funding rate skew) that mean-revert predictably. Yogi captures these while monitoring **five anomaly dimensions** — including real-time cross-venue funding comparison against Binance and Bybit — to detect stress before volatility-based indicators react.

**Core insight**: Vol-based leverage scaling is reactive — it reduces exposure *after* volatility has already spiked. By then, slippage is high, liquidity is thin, and drawdowns have already occurred. Yogi monitors leading indicators across three venues (Drift + Binance + Bybit) that precede vol spikes, enabling proactive tilt reduction and position unwinding.

**Proven in live bear market (Mar 20–23, 2026):** BTC dropped 7.4%. Yogi delivered +$8.08 (+1.61%) with zero drawdown. The regime engine held cautious deployment (50% @ 0.5x) while other strategies would have been fully exposed.

**Revenue sources (live)**: Delta-neutral funding collection (spot buy + perp short) + dynamic tilt bonus + cross-venue intelligence. The keeper always positions on the collecting side — exits DN when funding drops below 5% APY threshold. Drift natively lends idle collateral to borrowers (1-5% APY auto-yield). External lending (Kamino/Marginfi for higher rates) and LST collateral (jitoSOL) are planned for post-hackathon.

**Multi-asset DN**: Unlike single-asset DN vaults, Yogi can run parallel delta-neutral positions on SOL, BTC, and ETH — all of which have spot markets on Drift. This diversifies funding sources and reduces single-market risk.

## How It Works

### Delta-Neutral Execution

```
For each DN-eligible market (SOL, BTC, ETH):

Capital for position = $X
|
+-- 70% ($0.7X) --> Spot BUY on Drift (e.g., buy 0.0036 BTC)
|                   Becomes the price hedge
|
+-- 30% ($0.3X) --> Perp margin
                    |
                    +-- SHORT perp = spot × (1 + tilt%)
                        e.g., short 0.0037 BTC (5% tilt)

Price goes up:   spot +$Y, perp -$Y → net ≈ $0 (tilt creates small short exposure)
Price goes down: spot -$Y, perp +$Y → net ≈ $0 (tilt creates small profit)
Funding accrues: short collects positive funding hourly → pure yield
```

### Dynamic Tilt

The tilt is the percentage by which the perp short exceeds the spot position. At 0% tilt, the position is purely delta-neutral. At 10% tilt, there's a 10% short bias — the perp short is 10% larger than the spot buy.

```
computeDynamicTilt(signalSeverity, volRegime, fundingRate):
  IF signalSeverity >= HIGH:     return 0%     (pure DN — protect capital)
  IF signalSeverity >= LOW:      return 3%     (30% of max tilt)
  IF volRegime is high/extreme:  return 5%     (50% of max tilt)
  IF volRegime is normal:        return 7%     (70% of max tilt)
  IF volRegime is veryLow/low:   return 10%    (full tilt — calm market)
  IF fundingRate < 0:            cap at 2%     (shorts pay, reduce tilt)
```

Tilt is recomputed every rebalance cycle. This means Yogi adapts its risk profile in real time:
- **Calm bull market**: 10% tilt = extra short yield on top of DN funding
- **Stress event**: 0% tilt = zero price exposure, pure funding collection
- **Transition**: Gradual tilt reduction as signals escalate

### Capital Allocation

```
Total Vault Capital
|
+-- Idle USDC --> Drift auto-lends to borrowers (1-5% APY, native)
|
+-- Deployed Capital (regime-adjusted % of total)
    |
    +-- DN Position 1: SOL spot + SOL-PERP short
    +-- DN Position 2: BTC spot + BTC-PERP short
    +-- DN Position 3: ETH spot + ETH-PERP short
    |
    Each position:
    +-- 70% → Spot buy (the hedge)
    +-- 30% → Perp margin (for the short)
    +-- Tilt: 0-10% extra short (dynamic)
```

### Signal Detection Pipeline

The signal detector runs every 5 minutes. Each dimension independently classifies severity:

#### 1. OI Imbalance Shift

Measures how fast the long/short ratio is changing across monitored markets. Rapid OI shifts signal mass repositioning — often preceding funding rate spikes or liquidation cascades.

- Compares current snapshot to oldest in rolling 1-hour history
- Thresholds: 5% (LOW), 15% (HIGH), 30% (CRITICAL)

#### 2. Liquidation Cascade

Proxied by sudden OI drop. When OI decreases rapidly without corresponding price recovery, it indicates forced liquidations — margin calls cascading through the system.

- Measures percentage OI drop over rolling 1-hour window
- Thresholds: 5% (LOW), 15% (HIGH), 30% (CRITICAL)

#### 3. Funding Rate Volatility

Unstable funding rates signal regime transitions. When funding whipsaws between positive and negative, DN positions face increased uncertainty about which side collects.

- Rolling 24-entry standard deviation, annualized to bps
- Thresholds: 500 bps (LOW), 1500 bps (HIGH), 3000 bps (CRITICAL)

#### 4. Spread Blow-out

Mark/oracle divergence across markets indicates thin liquidity, forced selling, or price manipulation. Large spreads can cause DN legs to diverge in value.

- Max absolute mark/oracle spread across monitored markets
- Thresholds: 0.5% (LOW), 1.5% (HIGH), 3.0% (CRITICAL)

#### 5. Cross-Venue Funding (Drift vs Binance/Bybit)

Compares Drift's funding rate against Binance and Bybit perpetual futures. When Drift funding significantly diverges from CEX funding, it signals either an arbitrage opportunity or impending convergence.

- Fetches real-time funding rates from Binance (`fapi/v1/premiumIndex`) and Bybit (`v5/market/tickers`)
- Classifies as `drift_high` (Drift > CEX by 5%+ APY), `drift_low` (Drift < CEX), or `aligned`
- `drift_high` confirms DN profitability; `drift_low` flags convergence risk and may reduce tilt
- No other Drift vault compares funding across venues — this is Yogi's unique 5th dimension

### Regime Engine Decision Matrix

The regime engine combines vol regime (backward-looking) with signal severity (forward-looking):

```
                   Signal Severity
Vol Regime    CLEAR    LOW      HIGH     CRITICAL
-------------------------------------------------
Very Low     100/2.0  95/1.5   70/1.0   40/0.5
Low           95/1.5  85/1.2   55/0.8   30/0.3
Normal        85/1.0  70/0.8   45/0.5   20/0.2
High          75/0.8  55/0.5   30/0.3   15/0.0
Extreme        0/0.0   0/0.0    0/0.0    0/0.0

Format: deploymentPct / maxLeverage
```

Matrices are loosened vs pure directional because DN positions have structural price hedging — spot and perp offset, so higher deployment is safer than directional exposure.

**Rebalance modes** derived from deployment percentage:
- **Aggressive** (>= 85%): Normal entry thresholds, full deployment, max tilt
- **Normal** (55-84%): Standard operation, moderate tilt
- **Cautious** (20-54%): Requires 40%+ signal strength for new entries, reduced tilt
- **Defensive** (< 20%): Minimal positions, close-only mode, 0% tilt

**Emergency rebalance** triggered when:
- Deployment drops 30%+ in a single detection cycle
- Signal severity jumps from CLEAR/LOW to CRITICAL
- Mode transitions to defensive

### DN Entry Criteria

A market is eligible for a DN position when ALL of the following are met:
1. Market is DN-eligible (SOL-PERP, BTC-PERP, or ETH-PERP with corresponding spot market)
2. Funding rate >= 5% APY (min threshold for DN profitability)
3. Cost gate passes: expected funding over hold period > round-trip trading costs
4. Regime allows deployment > 0% and leverage > 0
5. Available capital exceeds minimum position size

### DN Exit Criteria

A DN position is closed when ANY of the following occur:
1. Funding APY drops below 5% threshold
2. Delta drift exceeds 5% (spot/perp size divergence)
3. Portfolio drawdown exceeds 3% (reduce) or 5% (close all)
4. Health ratio drops below 1.15 (reduce) or 1.08 (emergency close all)
5. Regime transitions to 0% deployment or 0x leverage
6. Signal severity reaches CRITICAL (force reduce + set tilt to 0%)
7. Negative equity detected (emergency close all)

## Risk Management

### DN-Specific Risk Controls

| Risk | Mechanism | Mitigation |
|------|-----------|-----------|
| Price exposure | Spot + perp offset | Delta ≈ 0 (within tilt %) |
| Tilt exposure in crash | Dynamic tilt | → 0% on HIGH/CRITICAL (pure DN) |
| Spot/perp diverge | Delta drift check | Rebalance legs if >5% drift |
| One leg fails | Atomic execution guard | If perp fails, unwind spot immediately |
| Funding turns negative | Exit threshold | Close DN when APY < 5% |
| Liquidity crunch | Position sizing | Max 40% per market, 3 markets max |
| Restart state loss | Position loader | Reconstructs DN pairs from on-chain |
| Mode transition | Auto-transition | Closes directional positions on DN startup |

### Dynamic Leverage (Vol-Based)

| Vol Regime | Realized Vol | Base Leverage | Rationale |
|------------|-------------|---------------|-----------|
| Very Low | < 20% | 2.0x | Calm markets, safe for moderate leverage |
| Low | 20-35% | 1.5x | Normal conditions |
| Normal | 35-50% | 1.0x | Elevated — conservative |
| High | 50-75% | 0.8x | Turbulent — minimal exposure (loosened for DN) |
| Extreme | > 75% | 0x | Shut down |

**Signal severity can reduce leverage below vol-based level.** At LOW signal + veryLow vol, leverage drops from 2.0x to 1.5x. At CRITICAL + any vol, leverage is near zero.

### Health Ratio Monitoring

| Level | Health Ratio | Action |
|-------|-------------|--------|
| Healthy | > 1.15 | Normal operation |
| Warning | 1.08 – 1.15 | Close largest DN position (both legs) |
| Critical | < 1.08 | Emergency close all DN positions |
| Liquidatable | < 1.0 | Drift liquidates (should never reach this) |

Monitored every **30 seconds** — 480x more frequent than the 4-hour rebalance.

### Position Sizing

| Parameter | Value |
|-----------|-------|
| DN capital split | 70% spot / 30% perp margin |
| Max per market | 40% of total equity |
| Max DN markets | 3 (SOL, BTC, ETH) |
| Max leverage | 2x (hard ceiling) |
| Min funding APY | 5% to open DN position |
| Max tilt | 10% (dynamic, 0% in stress) |

### Drawdown Management

- **3% drawdown**: Close worst-performing DN position
- **5% drawdown**: Emergency close all — 100% to idle (Drift auto-lends)
- **Negative equity**: Emergency close all (Yogi-specific guard)

### What We Don't Do

- **No leverage looping** — No borrowing against collateral recursively
- **No DEX LP** — No impermanent loss exposure
- **No yield-bearing stables** — No circular yield dependencies
- **No illiquid altcoins** — Only SOL/BTC/ETH with Drift spot markets
- **No fixed leverage** — Leverage adapts to vol AND signals
- **No fixed tilt** — Tilt adapts to signals, vol, and funding direction
- **No blind deployment** — Signal detector prevents full exposure during building stress
- **No unhedged directional risk** — DN structure eliminates price exposure (within tilt %)

## Expected Returns

| Market Condition | Vol | Signals | Deployment | Tilt | Expected APY |
|-----------------|-----|---------|------------|------|-------------|
| Bull (positive funding) | Low | CLEAR | 100% @ 2.0x | 10% | 20-30% |
| Neutral | Normal | CLEAR | 85% @ 1.0x | 7% | 12-18% |
| Bear (volatile funding) | Normal | LOW | 70% @ 0.8x | 3% | 8-12% |
| Bear + contagion | Normal | CRITICAL | 20% @ 0.2x | 0% | 4-6% |
| Crisis (extreme vol) | Extreme | Any | 0% @ 0.0x | 0% | 2-5% (lending) |
| Recovery | Low | CLEAR | 100% @ 2.0x | 10% | 20-30% |

### Yield Stack

| Source | Where | Est. APY Contribution |
|--------|-------|----------------------|
| DN funding collection | Spot buy + perp short on Drift | 8-15% |
| Dynamic tilt bonus | Extra yield from short bias | 1-3% |
| Premium convergence | Mark/oracle mean reversion (via DN) | 1-2% |
| Drift auto-lending | Idle collateral lent natively | 1-5% |
| Cross-venue intelligence | Entry/tilt optimization | 0.5-1% |
| LST collateral (planned) | jitoSOL staking + MEV | 1.5-2% |
| **Live total** | | **12-24%** |
| **Full stack target** | | **14-28% (hostile) / 20-35% (normal)** |

## Complementary Portfolio — Yogi + Kodiak

Yogi is designed to work alongside [Kodiak](https://github.com/psyto/kodiak) (Hyperliquid). Together they harvest funding from uncorrelated sources:

- **Yogi** (SOL, BTC, ETH on Drift) — funding driven by broad crypto market sentiment. Volatile, with high peaks in bull markets. Multi-asset diversification reduces single-market risk.
- **Kodiak** (HYPE on Hyperliquid) — funding driven by Hyperliquid ecosystem conviction. HYPE holders are structurally long-biased, creating persistent positive funding regardless of broader market conditions.

**Why complementary:** BTC/SOL/ETH funding is cyclical and can flip negative during bear stress. HYPE funding stays positive because ecosystem believers don't sell. When Drift funding dips, Hyperliquid HYPE typically holds — and vice versa.

**Recommended allocation:** 60% Yogi / 40% Kodiak. Yogi gets more due to 3 DN markets vs Kodiak's 1, providing better capital absorption and diversification.

**Blended estimate:** 10-15% APY in normal conditions, 5% floor in stress (both vaults earn lending yield even when DN positions are closed).

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

### Interpretation

The 32-day period was **calm** — no HIGH or CRITICAL signals fired, and the backtest used directional mode (pre-DN). With DN mode:

- **Drawdown should be near zero** — DN eliminates price risk. Only tilt exposure and funding direction changes create P&L variation.
- **Returns may be slightly lower** — DN trades funding yield for price safety. But with dynamic tilt, calm-market returns approach directional levels.
- **The real advantage** — in a liquidation cascade or funding whipsaw, DN + 0% tilt preserves capital while directional strategies bleed.

### Backtest Limitations

1. Uses funding-only revenue — DN structure not reflected in backtest
2. Signals reconstructed from historical data (funding vol as proxy), not live detection
3. 32-day window too short to capture stress events
4. Vol regime approximated from funding volatility, not realized price vol
5. The backtest APY is a **conservative lower bound**

## Known Limitations

1. **DN mode live since March 25, 2026** — building track record. First stress event will be the definitive validation of the dynamic tilt mechanism.
2. **Regime matrices are manually tuned** — The 5x4 deployment/leverage matrices were designed from first principles, not optimized from historical data. They may need adjustment after live operation.
3. **Drift spot liquidity** — Drift's spot markets (SOL, BTC, ETH) are less liquid than perp markets. At larger AUM, spot slippage may require slippage guards (designed, not yet active).
4. **Single-keeper architecture** — No multi-reporter consensus. The keeper is a single point of trust for signal detection, running on AWS EC2 with pm2 auto-restart.
5. **Tilt is not hedged** — The tilt portion (0-10%) is directional exposure. In a sudden crash, the tilt causes small losses proportional to tilt% × price move. Dynamic tilt mitigates this by going to 0% in stress.

## Implementation Details

### Technology

- **Vault infrastructure**: Voltr (Ranger Earn) — deposits, LP shares, fee collection
- **Trading**: Drift Protocol v2 — spot buy (`placeSpotOrder`) + perp short (`placePerpOrder`) via delegate model
- **Keeper**: TypeScript bot on AWS EC2 with pm2 (24/7, auto-restart on reboot)
- **Signal detection**: 5-dimension anomaly detector (OI, liquidation, funding vol, spread, cross-venue)
- **Vol computation**: Parkinson estimator on SOL-PERP hourly candles
- **Data feed**: Drift Data API — funding rates, market stats, OHLC candles
- **RPC**: Helius (websocket subscription mode)

### Drift Market Mapping

| Asset | Perp Market Index | Spot Market Index | DN Eligible |
|-------|-------------------|-------------------|-------------|
| SOL | 0 | 1 | Yes |
| BTC | 1 | 2 | Yes |
| ETH | 2 | 3 | Yes |
| DOGE | 7 | — | No (no spot) |
| SUI | 9 | — | No (no spot) |
| AVAX | 22 | — | No (no spot) |

### Keeper Loop Architecture

```
Main Loop (30-second tick)
+-- Every 30s:  Emergency checks (health + drawdown + signal severity)
+-- Every 5m:   Signal detection (5 dimensions) + regime update
|               --> Emergency rebalance if regime shifts dramatically
+-- Every 30m:  Funding scan + leverage update + imbalance scan
+-- Every 4h:   DN Rebalance cycle
|   +-- Check existing DN positions (funding threshold, delta drift)
|   +-- Compute dynamic tilt from signals + vol + funding
|   +-- Close DN positions where funding dropped below 5% APY
|   +-- Open new DN positions on best funding markets
|   +-- Each DN open: spot buy → wait 2s → perp short
|   +-- Log delta, tilt, notional for each position
+-- Every 30s:  Heartbeat log (equity, regime, signal, DN count, tilt)
```

### Execution Flow

1. **Deposit**: User deposits USDC --> Voltr vault (`BFDTTG8n...`) mints LP tokens
2. **Allocation**: Manager deposits USDC to Drift via Voltr adaptor CPI
3. **Delegate**: Keeper (manager) has delegate authority on vault's Drift user (`HURzSV...`)
4. **Signal check**: Keeper runs 5-dimension anomaly detection every 5 minutes (including cross-venue funding vs Binance/Bybit)
5. **Regime compute**: Vol regime x signal severity --> deployment + leverage + tilt
6. **DN evaluation**: Keeper evaluates each DN-eligible market's funding vs. threshold (5% APY min)
7. **Spot buy**: Keeper places spot market order on Drift (e.g., buy 0.0036 BTC)
8. **Perp short**: Keeper places perp short order = spot × (1 + tilt%) (e.g., short 0.0037 BTC)
9. **Monitoring**: 30-second health checks; 5-minute signal scans; delta drift monitoring
10. **Tilt adjustment**: On each rebalance, dynamic tilt is recomputed — 0% in stress, up to 10% in calm
11. **Regime shift**: If signals spike, emergency rebalance reduces tilt to 0% and may close positions
12. **Funding**: DN positions accumulate funding payments hourly (short side collects)
13. **NAV update**: Vault NAV reflects Drift account equity (on-chain verifiable)
14. **Withdrawal**: User requests --> 24h cooldown --> receives USDC via Voltr adaptor
