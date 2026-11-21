# Launch Radar — Token Launch Radar

[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/VeeGee27/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/VeeGee27/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

A token launch radar: 200 pre-token protocols ranked by fitted implied value, each with
a costed farm plan, on a sortable, filterable dashboard with a detail view per protocol.

## The model

`log10(implied) = a + b × log10(TVL) + category term + log10(growth × age)`, fitted by
ordinary least squares on the 128 protocols whose token already trades (positive market
cap and TVL). The category term is a shrunken median residual per category. Growth and
age are capped judgement nudges, never fitted coefficients. Two held-out tests (a random
80/20 split and a time split) are computed by the program on every run and printed on
the dashboard with their numbers. R² is about 0.19: TVL alone explains a fifth of
market-cap variance, and the dashboard says so.

## The board

All 40 protocols on the snapshot's watchlist, plus the 160 pre-token protocols below the
$50M floor with the most TVL. Pre-token means the sealed DefiLlama snapshot records no
token. Implied values are this entry's own claim, never a prediction that a token launches.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
```

`main.ts` (Node 22, standard library only) reads the sealed snapshot, writes
`board.json` and `data.js`, copies `dashboard/` and `screenshots/` to the output
directory, and writes `dossier.json` with the vendored make.fun library.
