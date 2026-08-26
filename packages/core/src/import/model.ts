/*
  Canonical import model: the one internal representation every adapter
  converts INTO, so nothing downstream ever sees source vocabulary. Three
  rules govern everything in this directory:

  1. Never produce a plausible-looking but wrong trade. Heuristics are
     deterministic, assumptions surface as diagnostics, and uncertainty is
     refused with a specific, actionable error instead of guessed away.
  2. Never fabricate an R-multiple. R = realized P&L / initial risk. Without
     risk information r stays null and the result says "needs-risk";
     conversion happens only under an explicit user-chosen RiskSpec, and the
     provenance of every R value is labeled in rSource.
  3. Never throw on user data. The importer returns a structured result with
     typed issues, even for garbage input.
*/

/** Severity of one import diagnostic. Errors block simulation of the affected
 *  rows (or the whole file); warnings disclose assumptions and skipped rows;
 *  info notes context that changes nothing. */
export type ImportSeverity = "error" | "warning" | "info";

/** One structured diagnostic. `code` is a stable machine code (kebab-case)
 *  callers can branch on; `message` is the human explanation. */
export interface ImportIssue {
  severity: ImportSeverity;
  code: string;
  message: string;
  /** 1-based source line (CSV) or table row (HTML) the issue points at. */
  row?: number;
  /** Header name or canonical field the issue points at. */
  column?: string;
}

/** Canonical column meanings the header mapper can assign. */
export type CanonicalField =
  | "tradeId"
  | "orderId"
  | "symbol"
  | "direction"
  | "eventType"
  | "quantity"
  | "entryTime"
  | "exitTime"
  | "entryPrice"
  | "exitPrice"
  | "stopPrice"
  | "pnl"
  | "fees"
  | "swap"
  | "riskAmount"
  | "r"
  | "returnPct";

export type TradeDirection = "long" | "short";

/** Where a trade's R value came from; the trust ladder in rmultiple.ts. */
export type RSource = "explicit" | "calculated" | "inferred" | "unavailable";

/**
 * One reconstructed trade. Every field is null when the source does not
 * carry it; nothing is guessed. Times are epoch milliseconds, read as UTC
 * unless the source carried an explicit offset. `pnl` is net, in the
 * account's currency. `sourceRows` are 1-based source lines (CSV) or table
 * rows (HTML) so diagnostics can point back at the file.
 */
export interface ImportedTrade {
  id: string | null;
  symbol: string | null;
  direction: TradeDirection | null;
  entryTime: number | null;
  exitTime: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  quantity: number | null;
  pnl: number | null;
  fees: number | null;
  stopPrice: number | null;
  riskAmount: number | null;
  r: number | null;
  rSource: RSource;
  status: "closed" | "open";
  sourceRows: number[];
}

/** How sure detection is. "exact" = a signature adapter fingerprinted the
 *  file; "high" = the generic fallback built trades; "low" = nothing usable. */
export type FormatConfidence = "exact" | "high" | "low";

export interface ImportFormat {
  /** Adapter id ("tradingview", "generic-csv", ...) or "r-series". */
  kind: string;
  /** Human-readable format name. */
  label: string;
  confidence: FormatConfidence;
  /** Human-readable detection evidence ("header matches MT4 statement", ...). */
  signals: string[];
}

/** Aggregate R verdict for the import. "partial" means some trades carry R
 *  and some do not; downstream MUST refuse it, because simulating only the
 *  covered trades biases the sample. */
export type RStatus = "ready" | "partial" | "needs-risk" | "unavailable";

export interface ImportRSummary {
  status: RStatus;
  /** Uniform source of the R values, "mixed" when they differ, null when none. */
  source: RSource | "mixed" | null;
  withR: number;
  withoutR: number;
}

export interface ImportStats {
  /** Data rows seen by the adapter (excluding headers/sections/blank rows). */
  rows: number;
  parsedTrades: number;
  skippedRows: number;
  duplicatesRemoved: number;
}

/** The importer's structured result. A data API: rich enough for review UIs,
 *  but nothing here requires one. */
export interface ImportResult {
  /** True when at least one closed trade was reconstructed. */
  ok: boolean;
  format: ImportFormat;
  /** The located header row, verbatim, null when none was found. */
  header: string[] | null;
  /** Canonical field to 0-based column index, as actually used. */
  mapping: Partial<Record<CanonicalField, number>>;
  trades: ImportedTrade[];
  /** Still-open positions: reported, never fed to the simulator. */
  openTrades: ImportedTrade[];
  r: ImportRSummary;
  issues: ImportIssue[];
  stats: ImportStats;
}

/** Explicit, user-chosen risk assumption for files that carry P&L but no
 *  risk information. Never applied silently. */
export type RiskSpec =
  { type: "fixed-cash"; amount: number } | { type: "percent-of-entry-value"; percent: number };

export type DateOrder = "MDY" | "DMY";

export interface ImportOptions {
  /** Force a specific adapter (skips detection). "generic-csv" also emits a
   *  template-coverage diagnostic. Unknown ids fail with unknown-adapter. */
  adapterId?: string;
  /** Manual column overrides (canonical field to 0-based column index),
   *  merged over the detected mapping. A hook for callers; nothing requires it. */
  mapping?: Partial<Record<CanonicalField, number>>;
  /** Explicit risk assumption for the inferred rung of the R ladder. */
  riskSpec?: RiskSpec;
  /** Override the per-file slash-date order decision. */
  dateOrder?: DateOrder;
  /** Hard input caps; larger inputs are truncated with a disclosed warning. */
  maxBytes?: number;
  maxRows?: number;
}

/** Input size defaults: past these the input is truncated, loudly. */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_ROWS = 200_000;

/* ---- The generic template: the one guaranteed-readable fallback format. ---- */

export const GENERIC_CSV_HEADER =
  "open time,close time,symbol,direction,quantity,entry price,exit price,stop loss,pnl,fees,r";

/**
 * Canonical example of the generic format. Numerically self-consistent on
 * purpose: with the r column present it imports with explicit R, and with
 * the r column removed the same rows still yield the same R values,
 * calculated from the stop distance and the price-derived currency-per-unit.
 */
export const GENERIC_CSV_TEMPLATE = [
  GENERIC_CSV_HEADER,
  "2026-01-05 14:30,2026-01-05 15:40,EURUSD,long,1,1.0850,1.0874,1.0838,240.00,0.00,2.00",
  "2026-01-06 09:15,2026-01-06 10:05,EURUSD,short,1,1.0880,1.0892,1.0892,-120.00,0.00,-1.00",
].join("\n");

export const GENERIC_FORMAT_ADVICE =
  "If your platform's export is not recognized, convert it to the generic CSV format (one row per " +
  `completed trade):\n${GENERIC_CSV_HEADER}\nOnly "open time" plus an outcome are required: either an ` +
  '"r" value, or "pnl" together with a "stop loss" (or a risk amount per trade supplied at import). ' +
  "Other cells may stay empty. Times are YYYY-MM-DD HH:mm, read as UTC unless they carry an explicit offset.";

/** Placeholder cells that mean "no value" in real exports. */
const EMPTY_CELL_TOKENS = new Set(["", "-", "-", "–", "n/a", "na", "null", "none", "nan"]);

/** True when a cell is empty or a known no-value placeholder. */
export function isEmptyCell(raw: string): boolean {
  return EMPTY_CELL_TOKENS.has(raw.trim().toLowerCase());
}

/** Issue-list helper: push and return, so adapters can one-line diagnostics. */
export function addIssue(
  issues: ImportIssue[],
  severity: ImportSeverity,
  code: string,
  message: string,
  at?: { row?: number; column?: string },
): void {
  issues.push({
    severity,
    code,
    message,
    ...(at?.row !== undefined ? { row: at.row } : {}),
    ...(at?.column !== undefined ? { column: at.column } : {}),
  });
}
