# Yogi Vault — Voiceover Script (v2)

**Total duration: ~3 minutes (10 slides x 18 seconds)**

---

## Slide 1: Title (0:00 - 0:18)

> Yogi Vault. Dynamic tilted delta-neutral on Drift.
> We built the same strategy on both Drift and Hyperliquid.
> We broke things. We fixed them. We taught others to avoid the same mistakes.
> This is what production looks like.

---

## Slide 2: The Problem (0:18 - 0:36)

> Bear markets destroy directional vaults.
> BTC dropped seven-point-four percent in one week.
> Every vault that was fully deployed at max leverage ate the drawdown.
> Institutions are asking: where can I park capital for yield with zero price risk?
> Delta-neutral is the answer. Drift is the platform.

---

## Slide 3: We Built on Both (0:36 - 0:54)

> Yogi on Drift. Kodiak on Hyperliquid. Same strategy, two venues.
> On Drift: delta-neutral on five markets — SOL, BTC, ETH, POPCAT, and DRIFT.
> Including DN on Drift's own token. Only possible on Drift.
> On Hyperliquid: HYPE only. One market, needs bridges.
> Drift has twenty-plus spot-perp pairs. That's a long tail no other venue offers.

---

## Slide 4: Delta-Neutral + Dynamic Tilt (0:54 - 1:12)

> Buy spot. Short perp. Same asset. Price cancels out.
> Profit comes purely from funding rates. Zero price risk.
> Yogi adds a dynamic tilt: the perp short is slightly larger than the spot.
> Ten percent in calm markets for extra yield. Zero in stress for pure protection.
> The tilt adjusts every four hours based on five dimensions of real-time signals.
> No other Drift vault does this.

---

## Slide 5: 5D Signal Detection (1:12 - 1:30)

> Five anomaly dimensions, checked every five minutes.
> OI shifts detect mass repositioning. Liquidation cascades catch forced margin calls.
> Funding volatility signals regime transitions. Spread blow-outs reveal thin liquidity.
> And the fifth: cross-venue funding comparison against Binance and Bybit.
> When Drift funding diverges from CEX consensus, Yogi sees it and adjusts.

---

## Slide 6: Regime Engine (1:30 - 1:48)

> Vol regime times signal severity maps to deployment, leverage, and tilt.
> A five-by-four matrix. Signals can only reduce exposure, never increase it.
> At critical signals, tilt drops to zero. Pure delta-neutral. Zero price exposure.
> Delta-neutral is safer than directional, so deployment stays higher at the same risk level.
> Emergency rebalance triggers on thirty-percent deployment drops.

---

## Slide 7: What Went Wrong (1:48 - 2:12)

> We ran into real production bugs. Here are the four that matter.
> First: the emergency close only closed directional positions. Delta-neutral positions were ignored.
> The keeper got stuck in an infinite loop — closing nothing, every thirty seconds, for hours.
> Second: an orphaned SOL position of zero-point-zero-nine-nine-nine was below Drift's minimum order size.
> Every restart tried to sell it, failed, and threw an error.
> Third: opening delta-neutral positions temporarily drops equity — Drift's collateral doesn't settle instantly.
> The drawdown check saw a false twelve-percent drop and emergency-closed freshly opened positions.
> Fourth: POPCAT and DRIFT funding looked great — eighty-four and one-oh-six percent APY.
> But funding flipped within hours. Open-close churn cost seventy dollars in trading fees.
> Every one of these bugs was found in production, fixed, tested, and documented.

---

## Slide 8: What We Learned (2:12 - 2:36)

> Sixty-two unit tests across seven suites. Including regression tests for every production bug.
> Emergency decisions extracted into pure functions — testable without a Drift client.
> Twenty-four-hour minimum hold prevents churn from temporary funding dips.
> Peak equity reset after opening positions prevents false drawdown triggers.
> Orphaned spot check against Drift's minimum order size.
> We documented every mistake in PerpU — eight lessons in the Builder Mistakes track.
> Spot precision. Restart bugs. Dust borrows. Transaction limits.
> If you build on Drift after us, you won't make the same errors.

---

## Slide 9: Live Proof (2:36 - 2:50)

> Live on Solana mainnet since March twentieth. Running twenty-four-seven on EC2.
> Five DN-eligible markets. Currently running DRIFT and ETH delta-neutral.
> Dynamic tilt at five percent. Cross-venue intelligence active.
> Vault address and Drift user account — all on-chain, all verifiable.
> On-chain since day one. Not a backtest.

---

## Slide 10: Close (2:50 - 3:00)

> Yogi Vault. Dynamic tilted delta-neutral on Drift.
> Five markets. Five signal dimensions. Dynamic tilt. Sixty-two tests.
> Eight lessons in PerpU from eight production mistakes.
> Every other vault shows a backtest. Yogi shows scars.
> github dot com slash psyto slash yogi.

