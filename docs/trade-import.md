# Trade-history import pipeline

Real broker exports are not "a CSV". A TradingView strategy-tester file has
two rows per trade with the exit listed first and totals mirrored on both
legs. MetaTrader's only export button produces HTML, saved as UTF-16LE, with
an 8-column hidden cell inside every MT5 position row. MT5 tester reports
bury their only trade data (a Deals table) behind tens of thousands of
cancelled orders, and a deal that _sells_ can be closing a _long_.
ThinkOrSwim statements are one file with eight titled sections, only two of
which hold trustworthy trade data. None of them carry an R-multiple column.

`packages/core/src/import/` is the layered ingestion system that turns all
of that into simulator input, governed by three rules:

1. **Never produce a plausible-looking but wrong trade.** Every heuristic is
   deterministic, every assumption surfaces as a diagnostic, and uncertainty
   is refused with a specific, actionable error instead of guessed away.
2. **Never fabricate an R-multiple.** R = realized P&L / initial risk. When
   the file has no risk information, R is null and the result says
   `needs-risk`; conversion happens only under an explicit user-chosen
   assumption, and every R value's provenance is labeled.
3. **Never throw on user data.** The importer returns a structured result
   with typed issues, garbage input included.

The old entry points are untouched: `parseRSeries` and `parseTradeLog` keep
their exact behavior, and the simulation engine is not involved at all. This
is purely a new input layer.

## Data flow

```
text ─► detectInputKind ─┬─ r-series ─► parseRSeries (unchanged fast path)
                         └─ tabular ─► encoding repair
                                       ─► HTML? table extraction : CSV tokenizing
                                       ─► header/section location
                                       ─► adapter (signature match; generic fallback)
                                       ─► trade reconstruction
                                       ─► validation + dedupe
                                       ─► R resolution ladder
                                       ─► ImportResult ─► toTradeLogEntries ─► simulator
```

Public entry points (exported from `@luxalgo/prop-firm-sim-core`):

- `parseTraderInput(text, options)`: routes everything a paste box receives.
  A bare R series (numbers, a JSON array, or a single numeric column under
  an r-ish header) never touches the tabular machinery.
- `importTradeHistory(text, options)`: the tabular pipeline. Never throws.
- `toTradeLogEntries(trades)`: bridge into the existing `TradeLogEntry`
  shape; reports how many closed trades were dropped so callers can refuse
  silently-thinned samples.
- `decodeImportBytes(bytes)`: the file-reading boundary. Decodes by BOM
  (FF FE is UTF-16LE, FE FF is UTF-16BE, anything else UTF-8). MetaTrader
  saves every report as UTF-16LE and a naive UTF-8 read mangles it; text
  that already suffered that fate is detected and repaired too.
- `listImportAdapters()`: ids and labels, for help text and refusals.

## Module map

| File             | Owns                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `model.ts`       | Canonical trade, `ImportResult` contract, issue type, the generic template constants                                     |
| `csv.ts`         | Encoding repair, BOM byte decoding, delimiter sniffing, quote-aware tokenizer, defensive number parsing, injection guard |
| `timestamps.ts`  | Slash-date order decision (once per file, from provable values), AM/PM, IBKR compact, split Date+Time merging            |
| `aliases.ts`     | Header normalization, the alias dictionary, value-based column resolution, header/section location                       |
| `html.ts`        | Deterministic tag walker: entities, colspan padding, `class="hidden"` drops, script/style discard, truncation survival   |
| `reconstruct.ts` | Event pairing (id-grouped, FIFO fallback) and execution replay (signed position, reversals, fee proration)               |
| `rmultiple.ts`   | The R trust ladder and the stop-distance risk derivation                                                                 |
| `adapters/`      | One file per source format plus the shared interface and registry                                                        |
| `import.ts`      | The orchestrator and the public entry points                                                                             |

## The canonical trade

Adapters convert INTO one internal representation; nothing downstream sees
source vocabulary. Fields are null when the source does not carry them,
never guessed: `id, symbol, direction, entryTime, exitTime` (epoch ms UTC),
`entryPrice, exitPrice, quantity, pnl` (net, account currency), `fees`
(positive cost), `stopPrice, riskAmount, r, rSource, status`
(closed or open), `sourceRows` (1-based lines for diagnostics). Open trades
are reported separately and never feed the simulator.

## Detection, in order

1. Input kind: all tokens numeric (optional R suffix) is an R series; `[`
   opens a JSON array; a single numeric column under an r-ish header is
   still an R series; anything else is tabular.
2. Encoding repair: strip a UTF-8 BOM; detect NUL-interleaved wrong-charset
   text and repair it with a warning.
3. HTML detection and table extraction, or delimiter sniffing
   (comma/semicolon/tab/pipe by column-count consistency) and tokenizing.
4. Header/section location: headers are found behind statement preambles,
   and the WHOLE table is scanned for section headers because a real MT5
   tester report lists ~60,000 cancelled orders before its Deals section.
5. Adapter signatures: each `detect()` is a hard fingerprint (header names
   plus sample values) returning evidence or null. Registry order breaks
   ties; there is no fuzzy inter-adapter scoring.
6. The generic fallback maps the header through the alias dictionary;
   confidence is `high` only when trades were actually built, else `low`
   with an actionable error quoting the template.

## Bundled adapters

| Adapter       | Handles                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thinkorswim` | Account statements: fills from Account Trade History (or rebuilt from Cash Balance TRD descriptions), fees matched back by timestamp and symbol, order-history noise never read, non-stock legs refused (multipliers are not in the file)   |
| `tradingview` | Strategy-tester list of trades, both generations, any currency suffix: exit-first row pairs, mirrored totals read once, "Open" placeholder exits become open trades. No symbol, no risk data, so needs-risk by construction                 |
| `metatrader`  | MT4 statements (CSV/HTML) and MT5 history Positions: net P&L = Profit + Commission + Taxes + Swap, R derived from S/L through the trade's own P&L, pendings and ledger rows skipped, Open Trades sections imported as open, never as closed |
| `mt5-deals`   | MT5 Deals tables (the only trade data in tester reports): fill side inverts position direction on "out" deals, in/out labels cross-checked against a replayed net position, reversal deals split, gross profit netted with both legs' fees  |
| `generic-csv` | Everything else: row shape chosen from which columns exist (trade-per-row, entry/exit events, raw executions), Status-column noise dropped, split Date+Time merged, price-derived P&L only with a disclosed assumption                      |

Header subtleties encoded in `aliases.ts` rather than in any one adapter:
ambiguous `Type`/`Side`/`Action`/`Direction` columns are resolved by
inspecting VALUES (buy/sell means a direction, entry/exit/in/out means an
event type), an identical repeated header maps its second occurrence to the
exit leg (MetaTrader's duplicated Time/Price pairs) while different names
are never promoted (`Date` + `Time` is ONE timestamp and merges), and
`result` keeps its historical meaning in this project: an R-multiple.

## The R ladder

Strict trust order, labeled per trade in `rSource`:

1. `explicit`: the file's own R column. Validated (finite, |R| <= 100, sign
   cross-checked against P&L) and never recomputed.
2. `calculated`: from the file's own data. Either P&L / risk-amount column,
   or a protective stop priced through the trade's own gross P&L:
   currency-per-price-unit = gross P&L / signed price move, risk = stop
   distance x that rate. No contract sizes needed. A stop at or beyond
   entry is refused: trade history shows the LAST stop, not the initial
   one, so a moved or breakeven stop cannot recover the risk taken.
3. `inferred`: from a user-chosen RiskSpec, `{type:"fixed-cash", amount}`
   or `{type:"percent-of-entry-value", percent}`. Never applied silently.
4. `unavailable`: r stays null.

The aggregate verdict is `ready`, `needs-risk` (P&L present, risk absent:
prompt the user), `partial` (REFUSED downstream: simulating only the
covered trades biases the sample), or `unavailable`.

## The generic template

One canonical fallback format ships as exported constants
(`GENERIC_CSV_HEADER`, `GENERIC_CSV_TEMPLATE`, `GENERIC_FORMAT_ADVICE`):

```
open time,close time,symbol,direction,quantity,entry price,exit price,stop loss,pnl,fees,r
```

One row per completed trade; only `open time` plus an outcome (`r`, or
`pnl` with a stop or risk amount) are required; times are
`YYYY-MM-DD HH:mm`, UTC unless an offset is present. It is quoted in every
terminal failure, and it is also an explicit mode: `adapterId:"generic-csv"`
skips detection and emits a `template-coverage` diagnostic. The template is
golden-tested: it imports with explicit R as written, and with the r column
removed the same rows yield the same values, calculated from the stop.

## Security and robustness

- Formula-injection prefixes (`=`, `@`, tab, `+`/`-` on non-numeric text)
  are stripped from retained text fields (symbol, id).
- Hard size caps (about 20 MB / 200k rows) truncate with a disclosed
  warning; unterminated quotes recover; NUL and BOM damage is repaired.
- Numbers are parsed defensively: currency symbols and codes, parentheses
  negatives, Unicode minus (what `&minus;` decodes to), percent and R
  suffixes, and thousands separators in all three real conventions. A
  single dot is ALWAYS a decimal point: `217.131` is a GBPJPY price.
- Ambiguous slash dates are decided ONCE per file from provable values
  (any component above 12); an unprovable file assumes month-first WITH a
  warning and a `dateOrder` override exists.
- Cross-field validation catches wrong interpretation, not just bad cells:
  exits before entries are dropped, P&L signs that contradict direction
  and price move are flagged, a trade id spanning two symbols kills its
  group, and duplicates are removed (never for execution sources, where
  identical fills are legitimate).
- Everything is pure and browser-safe: no Node APIs, no dependencies, and
  the browser-compat test executes the importer inside an esbuild bundle.

## Adding an adapter

1. Create `adapters/<source>.ts` implementing `ImportAdapter`: `detect()`
   must be a hard fingerprint of the header (plus sample values when names
   are ambiguous) and return null otherwise; `build()` converts the claimed
   section into canonical trades, using `pairEvents` or
   `reconstructFromExecutions` instead of hand-rolling pairing.
2. Register it in `adapters/index.ts`. Order matters: put it before the
   generic fallback, and mind overlapping fingerprints (the statement
   adapter deliberately outranks the deals adapter so MT5 history reports
   land on Positions).
3. Add a fixture under `tests/fixtures/import/` and end-to-end assertions,
   including the negative ones: what the adapter must REFUSE matters more
   than what it accepts. The corpus sweep test picks the fixture up
   automatically and asserts it never throws.

## Integration points

- CLI: `--trade-log` (repeatable, any recognized format, BOM-decoded) with
  `--import-risk "25"` or `--import-risk "1%"` for needs-risk files, on
  `simulate` and `overlap`. Unrecognized files are refused with the
  importer's diagnostics plus the template advice.
- MCP: `tradeLogText` / `tradeLogTexts` accept every recognized format;
  `importRisk` mirrors the CLI flag. Refusals carry the same diagnostics.
- Web (the hosted simulator): the paste/upload box routes through
  `parseTraderInput`; uploads are decoded with `decodeImportBytes`. The
  richer flows the `ImportResult` enables (format banner with detection
  signals, mapping review, trade preview) are optional future work.

## Known limitations

- XLSX workbooks are out of scope; export CSV or paste instead.
- Multi-section CSVs are handled for ThinkOrSwim statements specifically;
  other section-style reports (IBKR Activity Statements) need a future
  section splitter and currently land on the generic fallback or a refusal.
- Price-derived P&L assumes one currency unit per price unit per unit of
  quantity. That is exact for stocks and wrong for futures and CFD
  multipliers, which the files do not carry; it is always disclosed as
  `pnl-derived-from-prices`, and ThinkOrSwim non-stock legs are refused
  outright.
- Broker-server timezones are not shifted: no-offset timestamps are read
  as UTC and every result says so. News-window matching can be off by the
  server offset.
