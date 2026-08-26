/* Public surface of the trade-history import pipeline. */

export {
  GENERIC_CSV_HEADER,
  GENERIC_CSV_TEMPLATE,
  GENERIC_FORMAT_ADVICE,
  type CanonicalField,
  type DateOrder,
  type FormatConfidence,
  type ImportFormat,
  type ImportIssue,
  type ImportOptions,
  type ImportResult,
  type ImportRSummary,
  type ImportSeverity,
  type ImportStats,
  type ImportedTrade,
  type RiskSpec,
  type RSource,
  type RStatus,
} from "./model.js";
export { decodeImportBytes } from "./csv.js";
export {
  detectInputKind,
  importTradeHistory,
  parseTraderInput,
  toTradeLogEntries,
  type TraderInput,
} from "./import.js";
export { listImportAdapters } from "./adapters/index.js";
