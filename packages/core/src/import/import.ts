/*
  The import orchestrator. Public entry points:

  - parseTraderInput(text, options): routes ANYTHING a paste box receives.
    A plain R-multiple series (or JSON array, or a single numeric column
    under an r-ish header) takes the unchanged fast path and never touches
    the tabular machinery; everything else goes through importTradeHistory.
  - importTradeHistory(text, options): the tabular pipeline. NEVER throws:
    every outcome, garbage included, is an ImportResult with typed issues.
  - toTradeLogEntries(trades): the bridge into the existing TradeLogEntry
    shape, reporting how many closed trades were dropped so callers can
    refuse silently-thinned samples.
*/

import type { TradeLogEntry } from "../trades/log.js";
import { parseRSeries } from "../bootstrap/parse.js";
import { findTableSections, normalizeHeader, HEADER_ALIASES } from "./aliases.js";
import { repairEncoding, sniffDelimiter, tokenizeDelimited } from "./csv.js";
import { extractHtmlTables } from "./html.js";
import {
  addIssue,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ROWS,
  GENERIC_FORMAT_ADVICE,
  type ImportedTrade,
  type ImportIssue,
  type ImportOptions,
  type ImportResult,
} from "./model.js";
import { resolveR } from "./rmultiple.js";
import { ALL_ADAPTERS, genericCsvAdapter, SIGNATURE_ADAPTERS } from "./adapters/index.js";
import { templateCoverage } from "./adapters/generic.js";
import type { AdapterBuildResult, DocTable, ImportDoc } from "./adapters/types.js";

const R_TOKEN = /^[+-]?(\d+(\.\d+)?|\.\d+)[rR]?$/;

/** Route pasted text: an R-multiple series or a tabular trade history. */
export function detectInputKind(text: string): "r-series" | "tabular" {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.startsWith("[")) return "r-series";
  const tokens = trimmed.split(/[\s,;]+/).filter((token) => token !== "");
  if (tokens.length > 0 && tokens.every((token) => R_TOKEN.test(token))) return "r-series";
  if (rSeriesHeaderLines(trimmed) !== null) return "r-series";
  return "tabular";
}

/** A single numeric column under an r-ish header is still an R-series. */
function rSeriesHeaderLines(trimmed: string): string[] | null {
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length < 2) return null;
  const headName = normalizeHeader(lines[0]!);
  if (HEADER_ALIASES[headName] !== "r") return null;
  const values = lines.slice(1);
  return values.every((line) => R_TOKEN.test(line)) ? values : null;
}

export type TraderInput =
  { kind: "r-series"; rSeries: number[]; issues: ImportIssue[] } | { kind: "import"; result: ImportResult };

/** Everything the old paste box accepted parses identically; everything else
 *  goes through the tabular importer. Never throws. */
export function parseTraderInput(text: string, options: ImportOptions = {}): TraderInput {
  if (detectInputKind(text) === "tabular") {
    return { kind: "import", result: importTradeHistory(text, options) };
  }
  const issues: ImportIssue[] = [];
  const headed = rSeriesHeaderLines(text.trim());
  try {
    const rSeries = headed !== null ? parseRSeries(headed.join("\n")) : parseRSeries(text);
    if (headed !== null) {
      addIssue(
        issues,
        "info",
        "r-header-skipped",
        "The first line looked like an R-column header and was skipped.",
      );
    }
    return { kind: "r-series", rSeries, issues };
  } catch (err) {
    addIssue(
      issues,
      "error",
      "r-series-invalid",
      err instanceof Error ? err.message : "The R-series could not be parsed.",
    );
    return { kind: "r-series", rSeries: [], issues };
  }
}

/** Convert closed trades with R into the simulator's TradeLogEntry shape.
 *  `dropped` counts closed trades left behind (no time or no R): callers
 *  must refuse silently-thinned samples. */
export function toTradeLogEntries(trades: readonly ImportedTrade[]): {
  entries: TradeLogEntry[];
  dropped: number;
} {
  const entries: TradeLogEntry[] = [];
  let closed = 0;
  for (const trade of trades) {
    if (trade.status !== "closed") continue;
    closed++;
    if (trade.entryTime === null || trade.r === null) continue;
    entries.push({
      openedAt: trade.entryTime,
      closedAt: trade.exitTime,
      direction: trade.direction,
      r: trade.r,
    });
  }
  entries.sort((a, b) => a.openedAt - b.openedAt);
  return { entries, dropped: closed - entries.length };
}

/** The tabular import pipeline. Never throws. */
export function importTradeHistory(text: string, options: ImportOptions = {}): ImportResult {
  try {
    return importInner(text, options);
  } catch (err) {
    const issues: ImportIssue[] = [];
    addIssue(
      issues,
      "error",
      "internal-error",
      `The importer hit an unexpected condition and stopped: ${err instanceof Error ? err.message : String(err)}. ` +
        "No trades were produced. Please report this file shape.",
    );
    return emptyResult("unknown", "unrecognized input", "low", [], issues);
  }
}

function emptyResult(
  kind: string,
  label: string,
  confidence: "exact" | "high" | "low",
  signals: string[],
  issues: ImportIssue[],
): ImportResult {
  return {
    ok: false,
    format: { kind, label, confidence, signals },
    header: null,
    mapping: {},
    trades: [],
    openTrades: [],
    r: { status: "unavailable", source: null, withR: 0, withoutR: 0 },
    issues,
    stats: { rows: 0, parsedTrades: 0, skippedRows: 0, duplicatesRemoved: 0 },
  };
}

function importInner(rawText: string, options: ImportOptions): ImportResult {
  const issues: ImportIssue[] = [];
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;

  let text = rawText;
  if (text.length > maxBytes) {
    const cut = text.lastIndexOf("\n", maxBytes);
    text = text.slice(0, cut > 0 ? cut : maxBytes);
    addIssue(
      issues,
      "warning",
      "input-truncated",
      `The input exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB cap and was truncated; trades past the cap were ignored.`,
    );
  }
  const repaired = repairEncoding(text);
  issues.push(...repaired.issues);
  text = repaired.text;

  if (text.trim() === "") {
    addIssue(issues, "error", "empty-input", "The input is empty.");
    return emptyResult("unknown", "empty input", "low", [], issues);
  }

  // Parse into a document: tables of rows.
  let doc: ImportDoc;
  const head = text.slice(0, 4096);
  if (/^\s*</.test(text) && /<\s*(!doctype|html|head|body|table|meta|div|title)/i.test(head)) {
    const tables = extractHtmlTables(text, issues, { maxRows });
    if (tables.length === 0) {
      addIssue(
        issues,
        "error",
        "no-table-found",
        `The HTML contains no readable table. ${GENERIC_FORMAT_ADVICE}`,
      );
      return emptyResult("unknown", "HTML without tables", "low", [], issues);
    }
    doc = {
      kind: "html",
      tables: tables.map((table): DocTable => ({
        rows: table.rows,
        rowNumbers: table.rowNumbers,
        sections: findTableSections(table.rows),
      })),
    };
  } else {
    const delimiter = sniffDelimiter(text);
    const tokenized = tokenizeDelimited(text, delimiter);
    issues.push(...tokenized.issues);
    let rows = tokenized.rows;
    let rowLines = tokenized.rowLines;
    if (rows.length > maxRows) {
      rows = rows.slice(0, maxRows);
      rowLines = rowLines.slice(0, maxRows);
      addIssue(
        issues,
        "warning",
        "input-truncated",
        `The file exceeds the ${maxRows} row cap and was truncated; rows past the cap were ignored.`,
      );
    }
    doc = { kind: "csv", tables: [{ rows, rowNumbers: rowLines, sections: findTableSections(rows) }] };
  }

  const ctx = { issues, options };

  // Adapter selection: an explicit id skips detection entirely.
  let build: AdapterBuildResult | null = null;
  let kind = "unknown";
  let label = "unrecognized input";
  let confidence: "exact" | "high" | "low" = "low";
  let signals: string[] = [];

  if (options.adapterId !== undefined) {
    const adapter = ALL_ADAPTERS.find((candidate) => candidate.id === options.adapterId);
    if (adapter === undefined) {
      addIssue(
        issues,
        "error",
        "unknown-adapter",
        `Unknown adapter id "${options.adapterId}". Known ids: ${ALL_ADAPTERS.map((a) => a.id).join(", ")}. ${GENERIC_FORMAT_ADVICE}`,
      );
      return emptyResult("unknown", "unknown adapter", "low", [], issues);
    }
    const match = adapter.detect(doc);
    if (match === null) {
      addIssue(
        issues,
        "error",
        "adapter-mismatch",
        `The input does not look like ${adapter.label} (forced via adapterId "${adapter.id}"). ` +
          `Remove the override to let detection choose, or reformat. ${adapter.id === "generic-csv" ? GENERIC_FORMAT_ADVICE : ""}`.trim(),
      );
      return emptyResult(adapter.id, adapter.label, "low", [], issues);
    }
    if (adapter.id === "generic-csv") {
      const coverage = templateCoverage(match.section.plan);
      addIssue(
        issues,
        "info",
        "template-coverage",
        `Generic template coverage: matched [${coverage.matched.join(", ") || "none"}]; ` +
          `missing [${coverage.missing.join(", ") || "none"}].`,
      );
    }
    build = adapter.build(doc, match, ctx);
    kind = adapter.id;
    label = adapter.label;
    confidence = "exact";
    signals = [...match.signals, "adapter forced via adapterId"];
  } else {
    for (const adapter of SIGNATURE_ADAPTERS) {
      const match = adapter.detect(doc);
      if (match === null) continue;
      build = adapter.build(doc, match, ctx);
      kind = adapter.id;
      label = adapter.label;
      confidence = "exact";
      signals = match.signals;
      break;
    }
    if (build === null) {
      const match = genericCsvAdapter.detect(doc);
      if (match !== null) {
        build = genericCsvAdapter.build(doc, match, ctx);
        kind = genericCsvAdapter.id;
        label = genericCsvAdapter.label;
        signals = match.signals;
        confidence = build.trades.length > 0 ? "high" : "low";
      } else {
        addIssue(
          issues,
          "error",
          "no-recognized-format",
          `No known export format matched and no usable header row was found. ${GENERIC_FORMAT_ADVICE}`,
        );
        return emptyResult("unknown", "unrecognized input", "low", [], issues);
      }
    }
  }

  // Cross-field validation: catch wrong INTERPRETATION, not just bad cells.
  const validTrades: ImportedTrade[] = [];
  let droppedByValidation = 0;
  let pnlMismatches = 0;
  let firstMismatchRow: number | undefined;
  for (const trade of build.trades) {
    if (trade.entryTime !== null && trade.exitTime !== null && trade.exitTime < trade.entryTime) {
      addIssue(
        issues,
        "error",
        "exit-before-entry",
        "Trade dropped: it closes before it opens. Check the date order and the time columns.",
        {
          row: trade.sourceRows[0],
        },
      );
      droppedByValidation++;
      continue;
    }
    if (
      trade.direction !== null &&
      trade.entryPrice !== null &&
      trade.exitPrice !== null &&
      trade.pnl !== null &&
      trade.entryPrice !== trade.exitPrice
    ) {
      const moveSign = Math.sign(
        (trade.exitPrice - trade.entryPrice) * (trade.direction === "long" ? 1 : -1),
      );
      const material = Math.abs(trade.pnl) > 2 * Math.abs(trade.fees ?? 0) + 0.01;
      if (material && trade.pnl !== 0 && moveSign !== 0 && Math.sign(trade.pnl) !== moveSign) {
        pnlMismatches++;
        firstMismatchRow = firstMismatchRow ?? trade.sourceRows[0];
      }
    }
    validTrades.push(trade);
  }
  if (pnlMismatches > 0) {
    addIssue(
      issues,
      "warning",
      "pnl-direction-mismatch",
      `${pnlMismatches} trade(s) have a P&L whose sign contradicts direction times price move. The values ` +
        "were kept, but check whether the direction or price columns are what they seem.",
      firstMismatchRow !== undefined ? { row: firstMismatchRow } : undefined,
    );
  }

  // Dedupe identical trades, except for execution sources, where identical
  // fills are legitimate.
  let trades = validTrades;
  let duplicatesRemoved = 0;
  if (build.source !== "executions") {
    const seen = new Set<string>();
    trades = [];
    for (const trade of validTrades) {
      const key =
        trade.id !== null
          ? `id:${trade.id}|${String(trade.entryTime)}|${String(trade.quantity)}`
          : `t:${String(trade.symbol)}|${String(trade.entryTime)}|${String(trade.exitTime)}|${String(trade.quantity)}|${String(trade.pnl)}|${String(trade.r)}`;
      if (seen.has(key)) {
        duplicatesRemoved++;
        continue;
      }
      seen.add(key);
      trades.push(trade);
    }
    if (duplicatesRemoved > 0) {
      addIssue(
        issues,
        "warning",
        "duplicates-removed",
        `${duplicatesRemoved} duplicate trade row(s) were removed.`,
      );
    }
  }

  const r = resolveR(trades, options.riskSpec, issues);

  if (trades.length > 0) {
    addIssue(
      issues,
      "info",
      "times-read-as-utc",
      "Timestamps without an explicit offset were read as UTC. If the file is in another timezone, " +
        "day boundaries and news-window matching shift by that offset.",
    );
  } else if (!issues.some((issue) => issue.severity === "error")) {
    addIssue(
      issues,
      "error",
      "no-trades-found",
      `The format was recognized (${label}) but no completed trades could be built from the rows` +
        `${build.openTrades.length > 0 ? ` (${build.openTrades.length} open position(s) were found, which cannot be simulated)` : ""}. ` +
        `${GENERIC_FORMAT_ADVICE}`,
    );
  }

  return {
    ok: trades.length > 0,
    format: { kind, label, confidence, signals },
    header: build.header,
    mapping: build.mapping,
    trades,
    openTrades: build.openTrades,
    r,
    issues,
    stats: {
      rows: build.rows,
      parsedTrades: trades.length,
      skippedRows: build.skippedRows + droppedByValidation,
      duplicatesRemoved,
    },
  };
}
