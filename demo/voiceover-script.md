# Yogi Vault — Voiceover Script

**Total duration: 80 seconds (8 slides x 10 seconds)**

---

## Slide 1: Title (0:00 - 0:10)

> Yogi Vault. A Drift basis trade strategy with intelligent signal detection.
> Smarter than the average bear market vault.

---

## Slide 2: The Problem (0:10 - 0:20)

> Most basis trade vaults scale leverage by volatility alone.
> They're reactive — they reduce exposure after damage is already done.
> In a calm market with building contagion, they stay fully deployed at two-x.
> Blind to the approaching storm.

---

## Slide 3: Intelligence Layer (0:20 - 0:30)

> Yogi monitors four Drift-specific anomaly dimensions every five minutes.
> OI shifts detect mass repositioning before squeezes.
> Liquidation cascades catch forced margin calls through OI drops.
> Funding volatility signals regime transitions.
> And spread blow-outs reveal thin liquidity and stress.

---

## Slide 4: Regime Engine (0:30 - 0:40)

> The regime engine combines vol regime with signal severity into a deployment decision.
> A five-by-four matrix maps every combination to a deployment percentage and leverage cap.
> Signals can only reduce deployment, never increase it.
> If deployment drops thirty percent in one cycle, an emergency rebalance triggers immediately.

---

## Slide 5: Kuma vs Yogi (0:40 - 0:50)

> In calm markets, Yogi performs identically to Kuma.
> But when OI starts shifting or liquidations cascade, Yogi pulls back —
> from one hundred percent at two-x down to twenty-five percent at half-x.
> Kuma stays fully deployed. Blind.
> Same alpha source. Smarter risk management.

---

## Slide 6: Backtest (0:50 - 1:00)

> Thirty-two day comparative backtest.
> Yogi achieved twenty-one percent lower max drawdown and sixteen percent lower trading costs.
> The trade-off: one-point-two percent less APY in a calm period.
> But in a real stress event, that relationship flips — Yogi avoids the drawdown entirely.
> Target APY in normal conditions: twenty to thirty percent.

---

## Slide 7: Architecture (1:00 - 1:10)

> Nine keeper modules. Two are new: the signal detector and regime engine.
> Seven are battle-tested from Kuma — imbalance detector, cost gate, position manager.
> All thresholds and matrices are configurable. No hardcoded magic numbers.
> Thirty-eight unit tests across six suites. All passing.

---

## Slide 8: CTA (1:10 - 1:20)

> Yogi Vault. Kuma's Drift arbitrage plus forward-looking signal detection.
> Five revenue sources. Four anomaly dimensions. One regime engine.
> Built for the Ranger Build-A-Bear Hackathon. Main track plus Drift side track.
> github dot com slash psyto slash yogi.
