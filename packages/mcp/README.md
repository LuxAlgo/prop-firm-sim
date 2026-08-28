# @luxalgo/prop-firm-sim-mcp

MCP server for [Prop Firm Sim](https://github.com/LuxAlgo/prop-firm-sim) - an open-source prop-firm
challenge simulator. It gives AI agents tools to Monte Carlo–simulate a trader's statistics through a
firm's exact ruleset and answer, with numbers: _what is my chance of passing, how many attempts and how
much money should I expect, is this challenge positive expected value for me, and what risk per trade
should I use?_

Every result is a distribution under stated assumptions - never a promise. Each tool response carries the
engine's assumption flags (rules a spec declares but the engine does not simulate, plus engine
simplifications), the rule-data provenance, and a disclaimer, and instructs the calling agent to surface
them to the user. Results are deterministic: the same inputs and seed reproduce byte-identical numbers.

## Install

### Claude Code

```bash
claude mcp add prop-firm-sim -- npx -y @luxalgo/prop-firm-sim-mcp
```

### Any MCP client (generic JSON config)

```json
{
  "mcpServers": {
    "prop-firm-sim": {
      "command": "npx",
      "args": ["-y", "@luxalgo/prop-firm-sim-mcp"]
    }
  }
}
```

The default transport is stdio. For remote setups, `--http [port]` serves the same server over the MCP
Streamable HTTP transport on `POST /mcp` (default port 3711, or set `PROP_FIRM_SIM_MCP_PORT`):

```bash
npx -y @luxalgo/prop-firm-sim-mcp --http 3711
```

The only outbound network call is the firm-data fetch: `GET /api/propfirms/list` on LuxAlgo's public,
keyless directory API (the data behind [luxalgo.com/prop-firms](https://www.luxalgo.com/prop-firms/);
origin overridable via `LUXALGO_APP_ORIGIN`). Inline `spec` simulations make no network calls at all.
Zero telemetry.

## Tools

| Tool                        | What it answers                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_firms`                | Which firms and challenges are in the live LuxAlgo directory, with account sizes, prices, and each challenge's rule-semantics provenance (and which challenges are refused as not simulatable)?                                                                                                                                                                                                                                                                                      |
| `get_challenge_rules`       | What are this challenge's exact rules - drawdown mode (including trails that lock at the start or at an offset above it), daily-loss semantics, consistency rules, fees, funded terms and payout gating - with citations and unsimulated-rule flags?                                                                                                                                                                                                                                 |
| `simulate_challenge`        | Given my win rate, R-multiples, trade frequency and risk sizing: pass probability (with CI), expected attempts, expected total cost, EV, the chance and timing of an actual payout once funded, and which rule kills my attempts.                                                                                                                                                                                                                                                    |
| `optimal_risk`              | Which risk per trade maximizes my chance of passing, which maximizes EV - and how far apart are they?                                                                                                                                                                                                                                                                                                                                                                                |
| `compare_challenges`        | Across several challenges, which is the best expected value _for my inputs_? (Sorted by EV for the caller's stats - explicitly not a ranking of firms.)                                                                                                                                                                                                                                                                                                                              |
| `bootstrap_simulate`        | Given my actual trade history as R-multiples, what are my odds? Uses a stationary block bootstrap so real losing streaks - what actually breach daily-loss and trailing-drawdown rules - survive into the simulation. Also accepts timestamped trade logs (`tradeLogText`, or `tradeLogTexts` for a 2-5 account portfolio): trade frequency is derived from the timestamps, `newsFilter` compares original vs news-avoided odds, and portfolio runs always include an overlap audit. |
| `analyze_portfolio_overlap` | Would a prop firm reviewer see my accounts as correlated? Measures same-direction position overlap across 2 to 5 timestamped trade logs and maps it to disclosed heuristic audit-risk bands, with no simulation involved.                                                                                                                                                                                                                                                            |

Directory challenges are referenced by `firmId` + `challengeId`; every simulation tool also accepts a
full inline ruleset (`spec`) in the exact shape `get_challenge_rules` returns, so an agent can fetch a
challenge, tweak one rule, and quantify the difference. Rule semantics from the directory follow a
strict honesty policy: structured columns are used verbatim, free text is inferred only when one
reasonable reading exists (each inferred field is disclosed in `inferredFields`), and ambiguous rules
are refused rather than guessed.

Since engine v1, consistency rules (`steps[].consistency`) and funded payout gating
(`funded.payoutRules` - winning-day minimums, per-payout caps, profit buffers, a windowed funded
consistency gate) are **simulated**, not just flagged: one outsized day effectively raises the target,
and payouts follow a maximum-withdrawal model where balances and loss floors carry across payouts.
Results include `funded.payoutProbability` (P(at least one payout | funded)) and
`funded.daysToFirstPayout` - with gated payouts, getting funded is not the same as getting paid. The
engine states how it models these via the assumption flags `consistency-stop-rule`,
`funded-withdrawal-model`, and `funded-consistency-window-approximated` (the pre-1.0 flag
`funded-payout-resets-account` no longer exists).

## News windows & portfolio

`bootstrap_simulate` also accepts timestamped trade logs instead of a bare R-multiple series:
`tradeLogText` (one pasted CSV/TSV log with a header row; open time and R required, close time and
direction optional, timestamps without an offset are read as UTC) or `tradeLogTexts` (2 to 5 logs,
portfolio mode). Real platform exports (TradingView, MT4/MT5 statements, MT5 deals, ThinkOrSwim)
and broker trade-history JSON in the [@luxalgo/broker-sdk](https://github.com/LuxAlgo/broker-sdk)
shape are auto-detected; imports that carry P&L but no risk data need `importRisk`. Timestamps
unlock three things:

- **Derived trade frequency.** `tradesPerDay` becomes optional: when omitted it is derived from the
  log's own timestamps, and the output says so.
- **News-window what-ifs.** `newsFilter` runs the simulation twice with the same seed, once on the
  full history and once without trades opened inside configurable windows around scheduled releases
  (built-in recurring templates for high- and medium-impact events across USD, EUR, GBP, JPY, AUD,
  CAD, CHF and NZD, plus custom event times). The returned result is the news-avoided scenario and
  `newsComparison` carries both sets of numbers. The calendar is a recurring-template approximation,
  not a historical feed, and every result carries that caveat.
- **Portfolio merge with an always-on overlap audit.** Portfolio mode merges the histories into one
  chronological series and simulates the combined account, so cross-strategy loss clustering
  survives. Overlap across the histories is always analyzed (`portfolioOverlap`), because prop firms
  look for same-direction positions open at around the same time across accounts and can audit or
  refuse payouts over correlated trading.

`analyze_portfolio_overlap` runs the same overlap analysis standalone, without a simulation:
per-pair overlap shares, overall and same-direction shares, and an audit-risk band (low under 10%,
elevated from 10% to 30%, high above 30%). The bands are disclosed heuristics, not any firm's
policy: enforcement is discretionary and no thresholds are published. Direction columns in the logs
make the analysis much more meaningful, since same-direction overlap is the signal firms look for.

## Composing with other tools

The simulation tools are built to sit downstream of whatever knows the user's real trading. If another
MCP server exposes broker round-trip statistics (win rate, average win, average loss) or a raw R-multiple
series from actual trades, feed those straight into `simulate_challenge` or `bootstrap_simulate` to
answer "given my actual trading, what are my odds on this challenge and what risk should I use?" -
convert currency stats to R-multiples by dividing by the average amount risked per trade.

Mind the units: rule fields and risk values are in percent units (`0.5` = 0.5%), while `winRate` is a
fraction in `[0, 1]`.

## Disclaimer

Simulation, not prediction. Results are Monte Carlo distributions under the stated assumptions and the
encoded ruleset - not financial advice and not a guarantee of passing any challenge. Firms change their
rules; the firm's own published pages are always authoritative - check the source citation when a
result carries one. Directory data is data, not an endorsement of any firm, and nothing here ranks or
recommends firms.

---

MIT © [LuxAlgo](https://luxalgo.com) · Source, issues and the full simulator (core engine, CLI):
[github.com/LuxAlgo/prop-firm-sim](https://github.com/LuxAlgo/prop-firm-sim)
