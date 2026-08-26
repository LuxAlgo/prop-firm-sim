# Rule semantics - where the odds actually live

Every prop-firm calculator you have seen multiplies a win rate into a binomial
formula and calls it a pass probability. That number is wrong, and it is wrong
in the house's favor, because the odds of a challenge are not in the profit
target - they are in the **exact mechanics of the loss rules**. Two challenges
with identical "8% target, 5% daily, 10% max" headlines can differ by tens of
percentage points of pass probability depending on semantics the marketing page
compresses into a single word like "trailing".

This document defines every semantic the engine simulates. Each worked example
below is also a hand-computed test case in
[`packages/core/tests/drawdown-semantics.unit.test.ts`](../packages/core/tests/drawdown-semantics.unit.test.ts) -
the numbers you can check with pen and paper are the numbers the engine is
pinned to.

All examples: $100,000 account, $1,000 risked per 1R.

## Max loss: the four modes

Encoded in `maxLoss.mode`. This single enum moves pass probability more than
any other field in a spec.

### `static-initial`

The floor is fixed at `initial − limit` forever. Classic CFD two-step rule
(a 10% max loss means the account fails at $90,000, full stop).

Consequence: **profits build cushion.** After you are up 4%, you can give all
of it back plus the original allowance. This is the most forgiving mode, and
the mode most blog calculators silently assume for every firm.

### `trailing-realized-eod`

The floor ratchets up with **end-of-day balance highs**: floor = highest daily
close − limit. Intraday spikes do not move it.

Worked example ($3,000 trail): day 1 spikes to $104,000 intraday but closes at
$99,500 → the floor is still $97,000. Day 2 closes at $104,500 → the floor
ratchets to $101,500 at that close. Day 3 touching $101,000 fails the account -
you can be **above breakeven and dead**.

### `trailing-intraday-unrealized`

The floor trails the **peak unrealized equity, intraday, and never stops**.
This is the futures-style rule, and it is the single most-miscalculated rule in
the industry.

Worked example ($3,000 trail): one trade floats you to +$2,000 (peak $102,000,
floor $99,000). The next trade gives back $3,500 → $98,500 ≤ $99,000: failed.
The identical sequence under `static-initial` (floor $97,000) survives easily.
Same trader, same trades, same headline "max loss $3,000" - one lives, one
doesn't.

At equal limit sizes this mode is strictly harsher than every other mode; in
our reference simulations it routinely cuts pass probability by a third to a
half versus static (see the ordering test in
[`engine-invariants.unit.test.ts`](../packages/core/tests/engine-invariants.unit.test.ts)).

### `trailing-locks-at-initial`

Trails like the intraday mode **until the floor reaches the initial balance,
then freezes** - once you are up by the trail amount, the worst case is
breakeven-and-out. Common futures variant.

Worked example ($3,000 trail): +$4,000 day one. A pure trailing floor would sit
at $101,000; the locking floor stops at $100,000. A pullback to $100,100
survives here and dies under pure trailing.

### Locks and offsets are exact

EOD trails can lock too: `maxLoss.locksAtInitial: true` freezes an
end-of-day-trailing floor at the starting balance (the convention several
futures firms use), and `lockOffsetAmount` models firms that lock at **start
plus a small offset** (e.g. +$100) exactly - a $100.15k dip survives a
start+$100 lock and a $100.05k print does not. Both are pinned by worked
examples in the test suite.

## Daily loss: four independent switches

A "5% daily loss" is not one rule - it is four choices multiplied together.
`dailyLoss` encodes each explicitly:

| Field             | Values                                   | The question it answers                                                                |
| ----------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `limitBasis`      | `initial-balance` / `anchor`             | 5% **of what**? A fixed $5,000 forever, or 5% of each day's starting balance?          |
| `basis`           | `prior-day-balance` / `prior-day-equity` | Which day-start number anchors today's floor? (Differs only with overnight positions.) |
| `includesOpenPnl` | `true` / `false`                         | Can a floating position breach you mid-trade?                                          |
| `evaluation`      | `intraday` / `end-of-day`                | Does touching the floor kill instantly, or does only the close count?                  |

Worked example (why `limitBasis` matters): allowance 5%, yesterday closed
$102,000. Under `initial-balance` the floor is $102,000 − $5,000 = **$97,000**;
under `anchor` it is $102,000 − $5,100 = **$96,900**. A day printing $96,950
fails the first firm and survives the second - same headline rule.

Worked example (why `evaluation` matters): allowance $5,000, one day trades
−$6,000 then +$2,000. An `intraday` check kills at $94,000. An `end-of-day`
check sees only the $96,000 close and lets it live.

When one trade crosses both the daily floor and the max-loss floor, the engine
attributes the failure to the **higher floor** - the one that was crossed first
as equity fell.

## Consistency rules - simulated, not hand-waved

A consistency rule ("no single day may exceed X% of your total profit") is
equivalent to a moving target: pass requires total profit of at least
`bestDay ÷ (X/100)`, so one outsized day raises what you owe. The engine
simulates it with a rational trader model: stop a day at the point further
profit cannot improve compliance (adding to what is already your best day only
raises the requirement), and keep trading across days until the best-day share
complies.

Worked example (50% rule, +$3k target): day one prints +$3,000 - target hit,
but that day is 100% of profit. Day two adds +$1,000 (best day now 75% of
$4,000 - still short). Day three adds +$2,000: $6,000 total, best day exactly
50% - pass on day three. The same script without the rule passes on day one.

The dark side is also simulated: **the rule forces extra days at risk.** In
the paired test case, the extra day a 50% rule forces is the day the trailing
floor gets hit - the consistency rule converts a pass into a blowup. That
effect is invisible to any calculator that treats consistency as a footnote.

## The rest of the rulebook

- **Steps** (`steps[]`): each evaluation step runs on a fresh account at the
  initial balance. `minTradingDays` are enforced; after every objective is met
  the engine assumes the trader stops risking and grinds the remaining minimum
  days risk-free (flagged as an assumption in every result). `maxDays: null`
  means no time limit; the simulator caps unresolved attempts at a configurable
  `unlimitedStepDayCap` and counts them as failures, flagged.
- **Fees** (`fees`): one-time prices, discounted resets, activation fees on
  funding, refundable-on-pass credits, and `billing: "monthly"` subscriptions
  (futures evals) approximated at one charge per 21 simulated trading days.
  Expected total cost is a distribution, not `price × 1`.
- **Funded stage** (`funded`): the same trader profile runs against the funded
  account's own loss rules over a configurable horizon (default 90 trading
  days). **Payout gating is simulated** via `funded.payoutRules`: winning-day
  minimums (e.g. five $150+ days per payout window), per-payout caps (percent
  of profit and hard dollar), profit buffers that must stay in the account,
  and funded consistency evaluated per payout window. Withdrawals take the
  maximum the rules allow and **never cross the loss floor**; balances and
  floors carry across payouts. Results report `payoutProbability` and
  `daysToFirstPayout` - the numbers that decide whether a funded account ever
  pays for its own evaluation.
- **Not simulated, never silent**: scaling plans and anything else the engine
  cannot faithfully model are declared in the spec's `flagsNotSimulated` and
  echoed into `assumptions.flags` of every result. Where a rule is
  unsimulated, your real odds are usually worse than the simulated ones.

## Path tracing

`options.tracePaths` records day-by-day equity **and the effective loss
floor** for the first attempt (and funded stretch) of up to 2,000 paths - the
data behind the fan charts. Under trailing rules the floor line visibly
ratchets upward as paths make highs, which is precisely the mechanism traders
misjudge. Tracing is pure observation: the test suite verifies the numbers are
byte-identical with tracing on and off.

## Why bootstrap mode exists

Win-rate math assumes your trades are independent coin flips. Real trade logs
have **streaks** - and streaks are precisely what breach daily-loss and
trailing-drawdown rules. Paste a real R-multiple series and the engine resamples
it with a stationary block bootstrap (mean block length 5 by default),
preserving the autocorrelation your actual trading has.

The direction of the error is not academic: with a tight loss limit and a
distant target, i.i.d. math **overstates** your pass probability against the
same trade distribution (see
[`bootstrap.unit.test.ts`](../packages/core/tests/bootstrap.unit.test.ts)).
The naive calculator flatters you exactly where the rules bite.

## Determinism

Same spec + profile + options + seed ⇒ byte-identical result, in Node and in
the browser. Every result carries its seed; permalinks reproduce exactly.

---

_Everything here describes the engine's model of published rules. Firms change
rules without notice; the firm's own page is authoritative. See
[DISCLAIMER.md](../DISCLAIMER.md)._
