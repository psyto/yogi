# Video 01: "I Built a Funding Rate Vault on Solana — Here's What It Looks Like Running Live"

**Duration:** ~5 minutes
**Format:** Screen recording (terminal + browser) with voiceover
**Tools needed:** QuickTime screen record + read script aloud (or ElevenLabs AI voice)

---

## SCENE 1: Hook (0:00 - 0:30)
**[Screen: Terminal showing keeper heartbeat logs scrolling]**

**Script:**
"This is a funding rate vault running live on Solana mainnet. Right now it's managing $500 across three perpetual futures positions on Drift Protocol. Every 30 seconds it checks health. Every 5 minutes it scans for anomalies across five dimensions. And every 4 hours it rebalances.

I built this in two weeks. Let me show you how it works."

---

## SCENE 2: What is a funding rate vault? (0:30 - 1:30)
**[Screen: Browser showing Drift funding rates page, or the keeper's funding scan output]**

**Script:**
"In perpetual futures, longs pay shorts when the market is bullish — that payment is the funding rate. Right now, DOGE-PERP on Drift is paying over 2000% APY to short sellers.

A funding rate vault captures this by automatically shorting assets with high positive funding. The key insight: you're not betting on price direction. You're collecting a payment that exists because of market structure.

But here's the problem every basis trade vault faces — what happens when the market crashes? Your short position is fine, but your collateral can get liquidated if you're not careful. That's where signal detection comes in."

---

## SCENE 3: The 5D Signal Detection (1:30 - 2:30)
**[Screen: Terminal showing signal detection output with cross-venue comparison]**

**Script:**
"Most vaults scale leverage based on volatility alone. Volatility is a lagging indicator — by the time vol spikes, you've already taken the hit.

My vault monitors five leading indicators every five minutes:
- OI imbalance shifts — are traders repositioning rapidly?
- Liquidation cascades — is open interest dropping from forced selling?
- Funding rate volatility — is the regime transitioning?
- Spread blow-outs — is mark price diverging from oracle?
- And this is the one no other Drift vault has — cross-venue funding comparison.

Look at this: DOGE on Drift is +1958%. On Binance it's -6%. On Bybit it's +3%. That 2000% spread tells me the short is profitable, but there's convergence risk. The vault sees this and factors it into every entry decision."

---

## SCENE 4: Regime Engine in Action (2:30 - 3:30)
**[Screen: Terminal showing regime transitions, deployment percentages]**

**Script:**
"The regime engine combines volatility with signal severity into a deployment decision. Right now, vol is 61% — that's 'high regime'. Signals are clear. So the vault deploys 50% of capital at 0.5x leverage. Cautious mode.

If vol drops to 30%, deployment goes up to 85% at 1.5x. If signals hit critical — say a liquidation cascade starts — deployment drops to 10% regardless of vol. The vault folds its sails before the storm arrives.

This is a 5-by-4 matrix. 5 vol regimes times 4 signal severities. Every combination has a specific deployment percentage and leverage cap. All configurable, no hardcoded magic numbers."

---

## SCENE 5: Live Performance (3:30 - 4:30)
**[Screen: Terminal showing positions, equity, and keeper logs]**

**Script:**
"Here's what it looks like right now. Three positions: DOGE-PERP short at $50, SUI-PERP short at $28, AVAX-PERP short at $6.50. Total deployed: about $85. Equity hovering around $500.

The vault is collecting funding every hour on these positions. At current rates, that's roughly $2-4 per day. On $500, that's 150-300% APY — though funding rates fluctuate and won't stay this high forever.

The important thing: every decision is on-chain. Every position, every funding payment, every entry and exit — verifiable through the vault's Drift account."

---

## SCENE 6: Close (4:30 - 5:00)
**[Screen: GitHub repo page]**

**Script:**
"This vault runs 24/7 on a $4 per month EC2 instance. The code is open source. I'm building this for the Ranger Build-A-Bear Hackathon on Drift Protocol.

If you want to learn how to build something like this — funding rate arbitrage, signal detection, regime engines — follow along. I'll be sharing more about what the vault does, what signals fire, and what I learn.

Link in the description."

---

## RECORDING INSTRUCTIONS

1. Open two terminal windows side by side:
   - Left: `ssh -i ~/.ssh/yogi-keeper-key.pem ec2-user@3.112.44.12 'pm2 logs yogi-keeper --lines 50 --nostream'`
   - Right: Same but with `--lines 100` for scrolling effect

2. Open browser tab with Drift UI or Solscan showing vault address

3. Start QuickTime screen recording (Cmd+Shift+5 on Mac)

4. Read the script above while showing relevant screens

5. No editing needed — raw terminal footage is authentic and technical audiences prefer it

6. Upload to YouTube with title, description below

## YOUTUBE METADATA

**Title:** I Built a Funding Rate Vault on Solana — Live Demo with 5D Signal Detection

**Description:**
A funding rate vault running live on Drift Protocol (Solana) with regime-adaptive signal detection. Built for the Ranger Build-A-Bear Hackathon.

The vault monitors 5 anomaly dimensions every 5 minutes — including cross-venue funding comparison against Binance and Bybit — to adapt deployment and leverage before stress hits.

Code: https://github.com/psyto/yogi
Vault: Deployed on Solana mainnet via Ranger Earn (Voltr)

Built with: Drift Protocol, Voltr Vault SDK, Helius RPC, AWS EC2

**Tags:** solana, drift protocol, defi, funding rate, perpetual futures, vault, trading bot, signal detection, ranger finance
