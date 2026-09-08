# @luxalgo/prop-firm-sim-mcp

## 1.3.0

### Minor Changes

- Move the MCP server to `@modelcontextprotocol/server` 2 (MCP 2026-07-28) and zod 4.

  - Both transports speak the stateless 2026-07-28 protocol and still serve 2025-era clients (current Cursor builds included) through the SDK's per-request legacy fallback: stdio via `serveStdio`, `--http` via `createMcpHandler` + `@modelcontextprotocol/node`'s `toNodeHandler`. The public surface (`POST /mcp`, `PROP_FIRM_SIM_MCP_PORT`, the CLI flags) is unchanged.
  - One zod across the workspace: the package now shares core's zod 4, ending the v3/v4 split. Tool input schemas are unchanged in shape and semantics; the two `tradeLogTexts` array bounds carry explicit messages so the "at least 2 / at most 5" guidance no longer depends on zod's wording.
  - Package `exports` map added: `@luxalgo/prop-firm-sim-mcp` (server factory), `@luxalgo/prop-firm-sim-mcp/tools` (`toolDefinitions`, handlers), `@luxalgo/prop-firm-sim-mcp/directory` (`fetchDirectory`, `resolveFirm`). Deep imports of `dist/*.js` still resolve but are no longer the intended surface. `ToolDefinition.inputShape` is typed as `z.ZodRawShape`.

## 1.2.0

### Minor Changes

- Import broker trade-history JSON in the open-source @luxalgo/broker-sdk shape: a bare fills array, `{"trades": [...]}`, or a full account snapshot (`accounts[].trades`, exactly one account carrying trades). Fills replay FIFO into flat-to-flat round trips (volume-weighted basis, reversal splitting, fee proration); P&L comes from prices with a contract-multiplier disclosure in every result; fills without `executedAt` are skipped loudly; snapshots with trades in several accounts are refused with instructions instead of being merged. The CLI `--trade-log` flag and the MCP `tradeLogText`/`tradeLogTexts` inputs auto-detect the shape, so a live broker pull feeds the simulator directly; imports that carry P&L but no risk data still require `--import-risk`/`importRisk`, and R is never fabricated.

### Patch Changes

- Updated dependencies
  - @luxalgo/prop-firm-sim-core@1.2.0

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
