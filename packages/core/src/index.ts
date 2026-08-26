export * from "./spec/index.js";
export { simulate } from "./engine/simulate.js";
export { Rng, pathSeed, normalizeSeed } from "./engine/rng.js";
export {
  ParametricSource,
  BootstrapSource,
  ScriptedSource,
  makeSource,
  type TradeSource,
} from "./engine/trades.js";
export {
  resolveSteps,
  simulateStep,
  simulateAttempt,
  riskAmount,
  type ResolvedStep,
  type StepOutcome,
  type AttemptOutcome,
  type DrawdownTracker,
} from "./engine/attempt.js";
export {
  RuleState,
  resolveDailyLoss,
  resolveMaxLoss,
  resolveStepRules,
  resolveFundedRules,
  type ResolvedRules,
  type ResolvedDailyLoss,
  type ResolvedMaxLoss,
} from "./engine/rules.js";
export { simulateFunded, type FundedOutcome } from "./engine/funded.js";
export { simulateJourney, makeAttemptAccumulator, type JourneyRecord } from "./engine/journey.js";
export { StationaryBootstrapSampler } from "./bootstrap/block.js";
export { parseRSeries } from "./bootstrap/parse.js";
export {
  parseTradeLog,
  parseTimestamp,
  toBootstrapInputs,
  type TradeLogEntry,
  type ParsedTradeLog,
} from "./trades/log.js";
export {
  NEWS_EVENT_TEMPLATES,
  NEWS_CALENDAR_CAVEAT,
  expandRecurringEvents,
  filterTradesAroundNews,
  type NewsEvent,
  type NewsEventTemplate,
  type NewsFilterOptions,
  type NewsFilterResult,
  type NewsImpact,
  type NewsCurrency,
} from "./trades/news.js";
export {
  OVERLAP_DISCLOSURE,
  mergeTradeLogs,
  analyzeOverlap,
  type PortfolioMergeResult,
  type OverlapPair,
  type OverlapReport,
  type AuditRiskLevel,
} from "./trades/portfolio.js";
export {
  optimalRisk,
  type OptimalRiskResult,
  type RiskGrid,
  type RiskSweepPoint,
} from "./analyze/optimalRisk.js";
export { sensitivity, type SensitivityResult, type SensitivityPoint } from "./analyze/sensitivity.js";
export { compare, type CompareEntry, type CompareRow, type CompareResult } from "./analyze/compare.js";
export { wilson95, quantileSorted, summarizeSorted, histogramSorted } from "./stats/summary.js";
export {
  GENERIC_CSV_HEADER,
  GENERIC_CSV_TEMPLATE,
  GENERIC_FORMAT_ADVICE,
  decodeImportBytes,
  detectInputKind,
  importTradeHistory,
  listImportAdapters,
  parseTraderInput,
  toTradeLogEntries,
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
  type TraderInput,
} from "./import/index.js";
export { ENGINE_VERSION, DISCLAIMER } from "./version.js";
