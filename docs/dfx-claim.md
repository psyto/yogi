# Claiming DFX for a Voltr vault

**Date:** November 21, 2026

This note is for anyone whose funds were frozen in the April 1, 2026 Drift exploit through a **Voltr vault**. Yogi was one of these vaults, and this is how its DFX allocation was claimed.

## What DFX is

After the exploit, Drift relaunched as Velocity. On October 1, 2026 it opened recovery claims:

- One DFX token per dollar lost.
- Only the account authority as of April 1, 2026 can claim.
- DFX can be redeemed for USDT from a recovery pool, sold, or held.
- Claims close on January 1, 2028. That is the `clawback_start_ts` of the merkle distributor, read on-chain. After it, unclaimed DFX can be clawed back.

Check the process against Velocity's official posts ([@VelocityDEX](https://x.com/VelocityDEX)). Fake claim sites are common after an exploit.

## Why your own key can't claim

For a Voltr vault, the Drift account's authority is not your wallet. It is the vault's **`vault_strategy_auth` PDA**, derived from the vault and the strategy. A PDA has no private key, so no wallet can sign as the claimant directly.

For Yogi, reading the Drift user account (`HURzSVDvBBA9VEZ1j1SQhn4iHUhxua3ZNhFejGgfpuq8`) on mainnet gives:

| Field | Value | Meaning |
|---|---|---|
| authority | `4dvzQ6Hux3YFJuWUcdqgYRddJFa8yo5EDzL7a49PyxLB` | Vault strategy auth (PDA). This is the claimant. |
| delegate | `9Rx3i7GyVFFUYGKCMDZQpqnoJgSzo3R1qwmsAN5aiiSu` | Vault manager. Trades only; cannot claim. |

You can check whether a claimant has an allocation with the eligibility endpoint the claim tool uses:

```
https://dfx.drift.trade/api/eligibility/<vault_strategy_auth>
```

HTTP 404 means no allocation.

## How to claim

Voltr published [voltrxyz/drift-dfx-claim](https://github.com/voltrxyz/drift-dfx-claim). It calls the Drift adaptor's `claim_dfx` through the vault program, signed by the vault **admin or manager** key. Follow its README. In short:

```bash
pnpm install --frozen-lockfile
export RPC_URL=<mainnet RPC>
export MANAGER_KEYPAIR=/path/to/admin-or-manager.json

pnpm cli -- dfx:status --vault <VAULT>                                   # read only
pnpm cli -- dfx:setup  --vault <VAULT> --recipient <OWNER> --mode execute  # creates two token accounts
pnpm cli -- dfx:claim  --vault <VAULT> --recipient <OWNER> --mode simulate
pnpm cli -- dfx:claim  --vault <VAULT> --recipient <OWNER> --mode execute
```

For Yogi this worked first try. Setup and claim together cost about 0.0042 SOL in fees and rent. The simulation log showed the full allocation claimed and nothing forgone before the real transaction was sent.

**If you deposited into someone else's vault:** the vault manager or admin runs the claim and chooses the recipient. The tool's README states that claimed DFX is *not* credited back to depositors automatically. Ask your vault's manager what they plan to do.

## Why redeeming now pays about 1%

DFX redeems pro-rata against the USDT in the recovery pool. When claims opened in October 2026, news reports put the pool at about $3.11M against about 299.5M DFX. That is about $0.01 per DFX, or roughly 1% of losses.

Redeemed DFX is burned, so it does not share in later top-ups. Tether reportedly pledged up to $127.5M (some reports say more, with other partners), but none of it had reached the pool when claims opened. These pool figures come from news coverage, not from Velocity's own documentation, and they may have changed since.

Yogi's DFX is being held, not redeemed, until the pool grows or the deadline approaches.

## Sources

- [voltrxyz/drift-dfx-claim](https://github.com/voltrxyz/drift-dfx-claim)
- [The Block: Drift opens exploit recovery claims](https://www.theblock.co/news/ecosystems/2026-10-02-drift-opens-exploit-recovery-claims-initial-payouts-just-over-1-user-losses-417581)
- [KuCoin: Velocity opens DFX claims](https://www.kucoin.com/news/flash/velocity-opens-dfx-claims-for-295m-drift-hack-sets-1-recovery-rate)
- [Crypto Briefing: DFX recovery token claims](https://cryptobriefing.com/drift-dfx-recovery-token-claims-april-exploit/)
