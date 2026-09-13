# @luxalgo/prop-firm-sim-core

Seedable, browser-safe Monte Carlo engine for prop-firm challenge
simulation: pass probability, expected attempts, expected total cost, EV,
and optimal risk sizing - from a trader profile and a firm's **exact**
ruleset, with every assumption visible.

Pure math, zero dependencies on I/O: no network, no filesystem, no
telemetry, no keys. Runs identically in Node and the browser (web workers
included). Same seed + same inputs ⇒ byte-identical results on any platform.

Part of [LuxAlgo/prop-firm-sim](https://github.com/LuxAlgo/prop-firm-sim)
(MIT) - the repo README covers the rule semantics in depth, and the same
engine powers the [CLI](https://www.npmjs.com/package/@luxalgo/prop-firm-sim-cli),
the [MCP server](https://www.npmjs.com/package/@luxalgo/prop-firm-sim-mcp),
and the hosted simulator.

## Install

```bash
npm install @luxalgo/prop-firm-sim-core
```

## Quick start

```js
import { simulate } from "@luxalgo/prop-firm-sim-core";
import { adaptFirm } from "@luxalgo/prop-firm-sim-core/directory";

// Live rules from LuxAlgo's public prop-firm directory (keyless, read-only).
// The adapter is pure: structured rule columns are used verbatim, free text
// is inferred only when unambiguous (and disclosed), ambiguity is refused.
const { propfirms } = (await (await fetch("https://app.luxalgo.com/api/propfirms/list")).json()).data;
const challenge = adaptFirm(propfirms.find((f) => f.propfirmId === "topstep"))[0];

const result = simulate(
  challenge.spec,
  {
    kind: "parametric",
    winRate: 0.45, // fraction, not percent
    avgWinR: 1.4, // winners average 1.4x the risk
    avgLossR: 1,
    tradesPerDay: 4,
    tradesPerDayModel: "poisson",
    risk: { mode: "percent-of-initial", value: 1 }, // 1% of the initial account per trade
  },
  { seed: 42, paths: 10_000 },
);

console.log(result.perAttempt.passProbability); // same seed, same number, any platform
console.log(result.perAttempt.failureBreakdown); // which rule actually kills attempts
console.log(result.ev.evTotal); // payouts minus every fee
console.log(result.assumptions.flags); // everything NOT simulated, always visible
console.log(challenge.provenance, challenge.inferredFields); // where each rule came from
```

…or an inline spec for any ruleset:

```js
const custom = {
  challengeId: "my-100k",
  name: "My 100K 2-Step",
  accountSize: 100_000,
  steps: [{ profitTargetPct: 8 }, { profitTargetPct: 5 }],
  dailyLoss: { pct: 5 },
  maxLoss: { pct: 10, mode: "static-initial" },
  fees: { price: 500, refundableOnPass: true },
  funded: { profitSplitPct: 80, payoutFrequency: "biweekly" },
};
```

## What it simulates

- **All four "trailing drawdown" semantics** - `static-initial`,
  `trailing-realized-eod`, `trailing-intraday-unrealized`,
  `trailing-locks-at-initial`, plus composable locks (`locksAtInitial`,
  `lockOffsetAmount`). The gap between them is up to ~2x in pass
  probability at the same limit size.
- **Daily-loss mechanics** - anchor basis (prior-day balance vs equity),
  limit basis (fixed allowance vs recomputed), open-P&L inclusion,
  intraday vs end-of-day evaluation.
- **Consistency rules** - simulated with a rational stop rule, not
  footnoted: one outsized day raises your effective target.
- **The funded stage** - payout gating (winning-day minimums, caps,
  buffers, windowed consistency), profit splits, blowup risk, and a
  maximum-withdrawal model where balances and loss floors carry across
  payouts.
- **Your real trades** - a stationary block bootstrap resamples your actual
  R-multiple series with streaks preserved (streaks are what breach these
  rules; i.i.d. win-rate math flatters you).
- **Stagnation** - every result reports the longest stretch of days without
  a new equity high per attempt (`perAttempt.stagnationDays`); lower risk
  survives more and stagnates longer.
- **Trade-log context tools** - `parseTradeLog` (timestamped CSV/TSV),
  `filterTradesAroundNews` (recurring high-impact calendar, configurable
  pre/post minutes, impact and currency filters, disclosed approximation),
  and `mergeTradeLogs`/`analyzeOverlap` (combine up to five strategy
  histories and measure the same-direction position overlap a prop-firm
  reviewer would see, with disclosed heuristic audit-risk bands).

Also exported: `optimalRisk` (pass-optimal vs EV-optimal risk sweep -
they usually differ), `compare` (same trader across many rulesets),
`parseRSeries`, and the RNG/bootstrap primitives.

## Honesty contract

Every result carries `assumptions`: the fully-resolved spec/profile/options
the engine actually ran, flags for every rule it did **not** simulate, and a
disclaimer. Results are Monte Carlo distributions under stated assumptions -
never promises. Adapted directory challenges carry their provenance
(`directory` vs `directory+inferred` with the inferred fields named), pass
source citations through when the directory serves them, and are refused
outright when their loss rules are ambiguous. Firms change rules; the firm's
own page is always authoritative.

## License

MIT © LuxAlgo

## Chart traces

Set `tracePaths` above zero in simulation options to return `result.trace`.
Challenge and funded paths contain aligned `equity`, `floor` (maximum-loss
boundary), and `dailyFloor` arrays, with one entry per recorded day, including
a terminal breach day. `dailyFloor` is the equity level enforced for that day,
anchored before trades and any funded payout; `null` means no daily-loss rule
applies. It follows step and funded overrides and covers both intraday and
end-of-day daily-loss rules. Funded `equity` is recorded after any payout, while
that day's daily boundary remains the one established before trading.

Tracing only observes the simulation; enabling it does not change outcomes.
Chart rendering and visibility controls belong to the consuming application.
