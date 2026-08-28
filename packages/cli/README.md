# @luxalgo/prop-firm-sim-cli

Terminal front-end for [Prop Firm Sim](https://github.com/LuxAlgo/prop-firm-sim), the open-source
prop-firm challenge simulator. It runs a Monte Carlo simulation of **your** trading statistics
against a firm's **exact ruleset** (daily-loss semantics, trailing max-loss modes - including
floors that lock at the starting balance or at an offset above it, consistency rules, time limits,
fees, refunds, payout gating) and reports the distributions that matter before you buy a challenge:
pass probability per attempt, expected attempts and total cost, days to funded, EV, and the risk
size at which pass probability and EV each peak. Firm data comes live from LuxAlgo's public
prop-firm directory, the data behind [luxalgo.com/prop-firms](https://luxalgo.com/prop-firms),
through one keyless, read-only API call. The simulation itself runs locally and deterministically:
zero telemetry, same seed in = same numbers out, and inline `--spec` rulesets skip the network
entirely.

## Install

```sh
npx @luxalgo/prop-firm-sim-cli firms
# or
npm install -g @luxalgo/prop-firm-sim-cli
prop-firm-sim --help
```

## Commands

### `firms` - list the live LuxAlgo directory

```sh
prop-firm-sim firms [--product-type futures|cfd] [--json]
```

```text
FIRM  FIRM NAME  CHALLENGE   CHALLENGE NAME       PRODUCT         SIZE    PRICE  PROVENANCE
ftmo  FTMO       100k-2step  FTMO Challenge 100K  cfd      100,000 USD  540 USD  directory+inferred

1 simulatable challenge from 1 firm. Source: the live LuxAlgo directory, the data behind
luxalgo.com/prop-firms. Provenance directory+inferred means some semantics were inferred from
disclosed free text. Data, not endorsement; each firm's own pages are authoritative.
```

Challenges whose rule text is too ambiguous to map are listed separately as "not simulatable:
ambiguous rule text" instead of being guessed at. The directory origin defaults to
`https://app.luxalgo.com` and can be overridden with the `LUXALGO_APP_ORIGIN` environment
variable.

### `rules <firm> <challengeId>` - the full ruleset, with provenance and citations

```sh
prop-firm-sim rules ftmo 100k-2step [--json]   # <firm> is a propfirmId or a case-insensitive name
```

```text
FTMO - FTMO Challenge 100K (2-step)
ftmo/100k-2step · cfd · account 100,000 USD · live LuxAlgo directory

Provenance
  directory+inferred, inferred from free text: maxLoss.mode. Inference only happens when the
  disclosed rule text has one reasonable reading; ambiguous rows are refused instead.

Steps (2)
  1. target +10% (10,000 USD) · min 4 trading days · no time limit
  2. target +5% (5,000 USD) · min 4 trading days · no time limit

Daily loss (every step unless overridden)
  5% of the initial balance (5,000 USD fixed allowance) · anchored to the prior day's closing
  equity · floating PnL counts (a breach can happen mid-trade) · checked intraday - touching the
  floor fails the account

Max loss
  10% of the initial balance (10,000 USD) · static-initial - measured from the initial balance
  and never moves
…
Sources - the firm's own page is always authoritative
  • https://ftmo.com/en/trading-objectives/ - verified 2026-08-24
```

### `simulate` - your stats vs one challenge

```sh
prop-firm-sim simulate --firm ftmo --challenge 100k-2step \
  --winrate 0.45 --avg-win 1.5 --trades-per-day 4 --risk 1%
```

```text
FTMO - FTMO Challenge 100K (2-step)
ftmo/100k-2step · cfd · account 100,000 USD · fee 540 USD one-time
Data: live LuxAlgo directory · provenance directory+inferred, inferred from free text: maxLoss.mode
Trader: win rate 45.0% · avg win 1.5R · avg loss 1R · 4 trades/day · risk 1% of balance per trade
Run: 10,000 paths · seed 42 · attempt cap 25 · engine 1.0.0

Pass probability per attempt                  74.9% (95% CI 74.2–75.6%)
  Step 1 · target +10%                        84.5% (95% CI 83.9–85.1%) · fails: max-loss 15.5%
  Step 2 · target +5%                         88.6% (95% CI 88.0–89.2%) · fails: max-loss 11.4%
Avg days per attempt                          23.2 when passed · 20.9 when failed

Funded within 25 attempts                     100.0% (95% CI 100.0–100.0%)
Attempts until funded                         mean 1.3 · p50 1 · p90 2
Total cost                                    mean 181 USD · p50 0 USD · p90 540 USD · p95 1,080 USD
Days to funded (trading days)                 p50 24 · p75 38 · p90 58
Stagnation (days without a new equity high)   p50 8 · p90 17

EV - challenge journey + funded horizon of 90 trading days
  EV total                                    +30,020 USD ± 440 USD (95% CI)
  P(EV > 0)                                   87.3%
  Payout if funded                            mean 30,201 USD · p50 29,100 USD · avg 4.1 payout events
  Payout probability | funded                 87.3%
  Days to 1st payout                          p50 10 · p90 20
  Funded accounts blown                       59.0% within the horizon
Max drawdown while evaluating                 p50 8.5% · p95 16.3% of initial balance

Not simulated / assumptions:
  • profit-split-scaling - Declared by the ruleset as present but not simulated. …
  …
Simulation, not prediction. Results are Monte Carlo distributions under the stated assumptions…
```

Trader model flags: `--winrate --avg-win [--avg-loss] [--win-std] [--loss-std]`, or bootstrap from
your own trade log instead with `--r-series "1.8R, -1, 0.6, …"` / `--r-series-file trades.csv`
(≥ 10 R-multiples; `[--block-length 5]`), or timestamped `--trade-log` files (below). Always:
`--trades-per-day` (`[--poisson]`; optional with `--trade-log`, where it is derived) and `--risk`
(`"0.5%"` of current balance by default; `--risk-mode percent-of-initial` or
`--risk-mode fixed-amount` with a currency amount). Target a live-directory entry with
`--firm/--challenge` (propfirmId or case-insensitive firm name) or your own ruleset with
`--spec my-challenge.json`, which works fully offline. Simulation knobs:
`--paths --seed --attempt-cap --funded-horizon --no-funded`. `--json` dumps the raw `SimResult`.

#### Timestamped trade logs: `--trade-log`, portfolios, and news windows

```sh
prop-firm-sim simulate --spec my-challenge.json --risk 0.5% \
  --trade-log journal.csv --avoid-news --news-pre 45 --news-post 45 --news-currencies USD,EUR
prop-firm-sim simulate --spec my-challenge.json --risk 0.5% \
  --trade-log strategy-a.csv --trade-log strategy-b.csv
```

`--trade-log <file>` bootstraps from a timestamped log instead of a bare R-series: CSV/TSV with a
header row, an open-time column and an R column required, close time and direction optional
(loose header names like `openedAt`/`entry`/`time`, `closedAt`/`exit`, `r`/`result`,
`direction`/`side` are matched). Real platform exports (TradingView list of trades, MT4/MT5
statements including HTML, MT5 deals tables, ThinkOrSwim statements) and broker trade-history
JSON in the [@luxalgo/broker-sdk](https://github.com/LuxAlgo/broker-sdk) shape are auto-detected
too; files that carry P&L but no risk data need `--import-risk` (cash per trade like `25`, or a
percent of entry value like `1%`). Timestamps without an explicit offset are read as UTC, and
parse warnings go to stderr. Timestamps unlock three things:

- **Derived trade frequency.** `--trades-per-day` becomes optional; when omitted it is computed
  from the log's own timestamps and the report says so.
- **Portfolio mode.** Repeat `--trade-log` (2 to 5 files) to merge several histories into one
  chronological series and simulate the combined account, preserving cross-strategy loss
  clustering. The report then always includes a multi-account overlap block with an audit-risk
  verdict, because prop firms look for same-direction positions open at around the same time
  across accounts and can audit or refuse payouts over correlated trading. `--json` includes the
  full report as `portfolioOverlap`.
- **News windows.** `--avoid-news [impacts]` (default `high`; also `--news-pre <minutes>`,
  `--news-post <minutes>`, both default 30, and `--news-currencies <list>`) runs the simulation
  twice on the same seed: once on the full history and once without the trades opened inside the
  windows around scheduled releases, from a built-in recurring-template calendar. The report shows
  the news-avoided scenario plus a compact comparison (original vs news-avoided pass probability,
  EV, excluded trades, events matched), and `--json` carries it as `newsComparison`. The calendar
  is an approximation, not a historical feed; the report repeats that caveat every time.

### `overlap <files...>`: would a reviewer treat these accounts as correlated?

```sh
prop-firm-sim overlap account-a.csv account-b.csv [--tolerance 10] [--json]
```

```text
Multi-account position overlap
2 histories · 24 trades · tolerance ±10 min around each position

Histories
  1. account-a.csv (12 trades)
  2. account-b.csv (12 trades)

PAIR       OVERLAP A       OVERLAP B  SAME-DIR  DIR-UNKNOWN
1x2   12/12 (100.0%)  12/12 (100.0%)        13            0

Multi-account overlap · AUDIT RISK: HIGH
  Warning: the firm may audit or refuse payouts for correlated accounts.
  100.0% of trades overlap across histories (100.0% in the same direction) - a reviewer comparing
  these accounts would likely treat them as correlated. Expect scrutiny or an audit before payouts.
  …
```

Takes 2 to 5 timestamped trade-log files and measures how often positions are open in the same
direction at around the same time across them, with no simulation involved. The audit-risk bands
are disclosed heuristics (overall overlap under 10% is low, 10% to 30% elevated, over 30% high):
prop firms are discretionary about correlated accounts and publish no thresholds, so the verdict
describes what a reviewer could see, not any firm's policy. Direction columns in the logs make the
result much more meaningful, since same-direction overlap is the signal firms actually look for.

### `optimal-risk` - where pass probability and EV each peak

```sh
prop-firm-sim optimal-risk --firm ftmo --challenge 100k-2step \
  --winrate 0.48 --avg-win 1.6 --trades-per-day 4 --min 0.25 --max 2 --step 0.25
```

```text
 RISK  PASS/ATTEMPT           EV  P(EV>0)
0.25%        100.0%  +18,253 USD   100.0%
 0.5%         99.7%  +36,850 USD   100.0%
   1%         92.7%  +66,932 USD    95.5%
 1.5%         53.9%   +9,900 USD    36.1%
   2%         43.1%   +4,065 USD    15.3%

Pass probability is maximized at 0.25% (100.0% per attempt).
EV is maximized at 1% (+66,932 USD).
They diverge - and that divergence is the point: the risk that maximizes your chance of passing
is not the risk that maximizes expected value, so pick your sizing by which objective you are
actually optimizing.
```

### `compare <refs...>` - one trader, several rulesets

```sh
prop-firm-sim compare ftmo/100k-2step --winrate 0.5 --avg-win 1.5 --trades-per-day 3 --risk 1%
```

```text
Sorted by EV for your inputs - not a ranking.

Data: live LuxAlgo directory, each firm's own pages are authoritative:
  ftmo/100k-2step: directory+inferred, inferred from free text: maxLoss.mode

FIRM  CHALLENGE   PASS/ATTEMPT  ATTEMPTS       COST           EV  P(EV>0)  PAYOUT%  DAYS  FLAGS
ftmo  100k-2step         94.9%       1.1  29.11 USD  +52,799 USD    97.1%    97.1%    19  -
```

The table is ordered by expected value **for the inputs you provided** - it is not an editorial
ranking or an endorsement of any firm. Each reference accepts a propfirmId or a case-insensitive
firm name before the slash.

## Honesty guarantees

- Every human-readable result ends with the full list of assumption flags (what the engine
  simplifies, and any rules a ruleset declares but the engine does not simulate) and the
  engine's disclaimer. Distributions and assumptions, never promises.
- Firm data comes from LuxAlgo's public, keyless directory API, the data behind
  [luxalgo.com/prop-firms](https://luxalgo.com/prop-firms). Rule semantics are used verbatim when
  the directory serves structured rule columns. When only disclosed free text exists, a rule is
  inferred solely when one reasonable reading exists, and every inferred field is stated next to
  the results ("inferred from free text: ..."). Anything more ambiguous is refused as not
  simulatable rather than guessed. Citations with `lastVerified` dates pass through when the
  directory serves them (`prop-firm-sim rules <firm> <challenge>` shows them), and the firm's own
  published rules are always authoritative.
- The simulation runs locally and deterministically. The only network call is the read-only
  directory fetch, and inline `--spec` rulesets remain fully offline. No telemetry, no affiliate
  anything.

## License

MIT © [LuxAlgo](https://luxalgo.com) - source and issues at
[github.com/LuxAlgo/prop-firm-sim](https://github.com/LuxAlgo/prop-firm-sim).
