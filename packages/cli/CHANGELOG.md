# @luxalgo/prop-firm-sim-cli

## 1.1.0

### Minor Changes

- `--trade-log` now imports real platform exports (TradingView, MT4/MT5
  statements including HTML, MT5 deals, ThinkOrSwim statements) in addition
  to plain timestamped CSVs, decoding files by BOM. New `--import-risk`
  ("25" cash per trade, or "1%" of entry value) converts exports that carry
  P&L but no risk data; without it such files are refused with the reason
  and the generic template.
- Report typography: em-dash separators become middle dots and colons.

### Patch Changes

- Updated dependencies: `@luxalgo/prop-firm-sim-core@1.1.0`.

## 1.0.0

### Major Changes

- v1.0: first stable release on engine 1.0.0: consistency rules, funded
  payout gating, and locking trails are simulated, not just flagged.
  `simulate`, `optimal-risk` (pass-optimal vs EV-optimal sweep), `compare`,
  `overlap`, and
  `firms`/`rules` commands; deterministic seeds printed with every result;
  JSON and table output. Firm and challenge data comes live from LuxAlgo's
  public keyless directory API, the data behind luxalgo.com/prop-firms
  (origin overridable with `LUXALGO_APP_ORIGIN`). Rule semantics are used
  verbatim when the directory serves structured rule columns, inferred from
  disclosed free text only when one reasonable reading exists (and disclosed
  as such next to every result), and refused as not simulatable otherwise.
  Inline `--spec` ruleset files remain fully offline.

- Timestamped trade logs, news windows, and portfolio mode in `simulate`:
  `--trade-log <file>` (repeatable, up to 5 files) bootstraps from a
  CSV/TSV log with a header row, derives `--trades-per-day` from the
  timestamps when the flag is omitted, and prints parse warnings to stderr.
  With 2 to 5 logs the histories merge into one simulated portfolio and the
  report always includes a multi-account overlap block whose high band reads
  as a warning (firms may audit or refuse payouts for correlated accounts);
  `--json` carries it as `portfolioOverlap`. `--avoid-news [impacts]` (with
  `--news-pre`, `--news-post`, `--news-currencies`) runs original and
  news-avoided scenarios on the same seed and renders a compact comparison
  with the calendar caveat; `--json` carries `newsComparison`. The new
  `overlap <files...>` command runs the same audit-risk analysis standalone
  (`--tolerance <minutes>`, `--json`), with the 10%/30% bands disclosed as
  heuristics rather than any firm's policy. The simulate report also gained a
  stagnation line (median and p90 of the longest run of days without a new
  equity high per attempt).
