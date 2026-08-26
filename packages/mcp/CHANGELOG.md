# @luxalgo/prop-firm-sim-mcp

## 1.1.0

### Minor Changes

- `tradeLogText` / `tradeLogTexts` now accept real platform exports
  (TradingView, MT4/MT5 statements including pasted HTML, MT5 deals,
  ThinkOrSwim statements) in addition to plain timestamped CSVs. New
  `importRisk` argument ("25" cash per trade, or "1%" of entry value)
  converts exports that carry P&L but no risk data; refusals carry the
  importer's diagnostics.

### Patch Changes

- Updated dependencies: `@luxalgo/prop-firm-sim-core@1.1.0`.

## 1.0.0

### Major Changes

- v1.0: first stable release on engine 1.0.0: consistency rules, funded
  payout gating, and locking trails are simulated, not just flagged. Seven
  tools: `list_firms`, `get_challenge_rules`, `simulate_challenge`,
  `optimal_risk`, `compare_challenges`, `bootstrap_simulate` (stationary
  block bootstrap over the trader's real R-multiple series), and
  `analyze_portfolio_overlap`. Firm data comes
  live from LuxAlgo's public, keyless prop-firm directory API (origin
  overridable via `LUXALGO_APP_ORIGIN`) with provenance and inferred-field
  disclosure; ambiguous rules are refused as not simulatable. Inline `spec`
  simulations stay fully offline. Every result carries assumptions, flags,
  provenance, seed, and disclaimer.

- Timestamped trade logs, news windows, and portfolio mode in
  `bootstrap_simulate`: `tradeLogText` parses a pasted CSV/TSV log (loose
  header names; timestamps without an offset are read as UTC) and derives
  `tradesPerDay` when it is not supplied; `newsFilter` runs the same seed
  twice (original vs news-avoided, on a recurring-template calendar that
  always carries its approximation caveat), returns the news-avoided
  scenario, and attaches a `newsComparison` block; `tradeLogTexts` (2 to 5
  logs) merges histories into one simulated portfolio and always attaches a
  `portfolioOverlap` audit-risk report, with a prominent warning when the
  overlap band is high. The new `analyze_portfolio_overlap` tool measures
  same-direction position overlap across accounts without simulating,
  because firms can audit or refuse payouts over correlated accounts; its
  bands (10%/30%) are disclosed as heuristics, not policy. Text summaries
  now also report per-attempt stagnation (the longest run of days without a
  new equity high).
