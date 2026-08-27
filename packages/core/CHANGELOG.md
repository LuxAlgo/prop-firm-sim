# @luxalgo/prop-firm-sim-core

## 1.1.2

### Patch Changes

- Results report the correct engine version: the ENGINE_VERSION constant echoed in every SimResult now matches the published package version, and a test keeps the two aligned so they cannot drift again. Version 1.1.1 still reported itself as engine 1.1.0; the simulated numbers were unaffected.

## 1.1.1

### Patch Changes

- Restore the em dash in the import pipeline's character handling: `&mdash;` decodes to a real em dash again, and an em dash placeholder cell counts as empty in statement tables, matching hyphen and en dash. Both literals had regressed to plain hyphens in a documentation typography pass; they are now written as unicode escapes, with a regression test pinning the behavior.

## 1.1.0

### Minor Changes

- Multi-format trade-history import pipeline (`importTradeHistory`,
  `parseTraderInput`, `toTradeLogEntries`, `decodeImportBytes`): TradingView
  strategy-tester exports (both generations), MT4/MT5 account statements
  (CSV and HTML, UTF-16 decoded by BOM), MT5 deals tables (netting replay
  with reversal splits), ThinkOrSwim account statements, and a generic
  fallback with a published template (`GENERIC_CSV_TEMPLATE`). R-multiples
  resolve through a strict trust ladder (explicit, calculated from the
  file's own risk data, inferred from an explicit `RiskSpec`, or refused),
  every assumption surfaces as a typed diagnostic, and garbage input returns
  a structured refusal instead of throwing. See `docs/trade-import.md`.
- `parseTimestamp` accepts fractional seconds (truncated), so logs written
  with `Date.toISOString()` parse instead of being skipped row by row.
- Output typography: the disclaimer and the overlap verdict/disclosure
  sentences drop em dashes for plain punctuation (text-only change, no
  simulated number moved).
- The firm-file JSON schema no longer advertises a `$id` pointing at the
  dataset path removed in the directory pivot.

## 1.0.0

### Major Changes

- v1.0: previously-flagged rules are now simulated, and results carry the data
  to draw them.

  - Consistency rules (`steps[].consistency`) are simulated with a rational
    stop rule: one outsized day effectively raises the target, exactly as
    firms compute it.
  - Funded payout gating (`funded.payoutRules`) is simulated: winning-day
    minimums, per-payout caps, profit buffers, funded consistency per payout
    window, and withdrawals that respect the loss floor. New stats:
    `funded.payoutProbability` and `funded.daysToFirstPayout`.
  - Locking trails: `maxLoss.locksAtInitial` extends the lock to EOD trails,
    and `lockOffsetAmount` models "locks at start + $100" exactly.
  - Funded withdrawal model: balances and loss floors carry across payouts
    (replaces the reset-on-payout simplification).
  - Path tracing (`options.tracePaths`): day-by-day equity and the moving
    loss floor per path, for fan-chart visualization; pure observation,
    verified to change no numbers.
  - `perAttempt.avgDaysWhenPassed` / `avgDaysWhenFailed` for verdict
    summaries.
  - `perAttempt.stagnationDays`: the longest run of days without a new
    day-close equity high per attempt, as a full distribution. Pure
    observation, verified to change no existing numbers.
  - Trade-log context tools: `parseTradeLog` (timestamped CSV/TSV, UTC,
    deterministic), `filterTradesAroundNews` (recurring-template economic
    calendar with algorithmic DST, configurable pre/post windows, impact
    and currency filters, custom event times, disclosed approximation),
    and `mergeTradeLogs`/`analyzeOverlap` (portfolio merge across up to
    five histories plus same-direction overlap audit-risk with disclosed
    heuristic bands).
  - The `/directory` subpath replaces the previously planned bundled
    dataset: a pure adapter that maps rows from LuxAlgo's public prop-firm
    directory API into simulatable specs. Structured rule columns are used
    verbatim; unambiguous free text is inferred and disclosed
    (`provenance`, `inferredFields`); ambiguous loss rules are refused.
    Fetching stays in the callers; the engine remains I/O-free.
