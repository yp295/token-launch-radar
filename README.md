# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/yp295/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/yp295/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Build the best token launch radar: read a sealed snapshot of every
protocol DefiLlama tracks, find the ones that still record no token and
are not a wrapped or staked product of one that trades, rank them by what
their launch would be worth, and hand in a web dashboard with the board,
a detail view per protocol, and the steps to farm each one.

## The model (patient-3)

One function scores every protocol, from the snapshot figures only:

```
implied = round( launch × odds(age, tvl) )
launch  = round( tvl_usd × multiple(tvl_usd)
                 × (1 + 0.30 × ln(1 + clamp(change_7d, -50, 200) / 100))
                 × (0.60 + 0.40 × age / (age + 365)) )
```

- **Base multiple, fitted** — `log10(mcap/TVL)` regressed on `log10(TVL)`
  across the live-token protocols in the snapshot itself (n = 128).
  Big protocols trade at a smaller fraction of TVL than small ones;
  the fit says so with the snapshot's own numbers. Clamped to 0.03–0.70.
- **Growth, log-damped** — a week's change is noisy (one protocol is up
  4,448% in this snapshot), so it passes through a logarithm first.
- **Maturity, saturating** — the overdue premium flattens instead of
  growing forever; an unlisted age uses 513 days, the snapshot's median
  pre-token age.
- **Rankable means launchable** — pre-token, and not a wrapped, staked
  or bridged product of a token that already trades. The board ranks all
  198 protocols that pass: 40 watchlist + 158 early rows.
- **Token odds, from the peers** — the share of launch-eligible
  protocols in the same age-and-size cell that already record a token.
- **A range on every value** — from the leave-one-out residuals of the
  size curve (P25–P75 and P10–P90).
- **A farm verdict at a deposit-sized stake** — 0.1% of the protocol's
  TVL ($500–$25,000), netted against gas and a 4.5% T-bill; the
  dashboard lets the reader pick another stake and recomputes live.
- **Rank stability** — every rank is re-derived under 200 bootstrap
  refits of the size curve, and each row reports its P10–P90 rank range.

The full specification, with the calibration numbers and the top 20, is
in [MODEL.md](../MODEL.md) — kept in the project notes, not the repo.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

Node 22, standard library only, no network. The program reads the
snapshot, writes `board.json`, `data.js`, `dashboard/`, `screenshots/`
and `dossier.json` to the output directory. Run it twice and both runs
write the same bytes.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ygqbwvx0&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
