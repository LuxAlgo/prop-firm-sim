/*
  --trade-log support: timestamped logs unlock what a bare R-series cannot do.
  Trade frequency is derived from the timestamps, --avoid-news compares odds
  with and without trading around scheduled releases, and 2-5 logs merge into
  one portfolio simulation with an always-on overlap audit (prop firms look
  for same-direction positions open at the same time across accounts and can
  audit or refuse payouts over it). Pure helpers; file reading is injectable
  for tests.
*/

import { readFileSync } from "node:fs";
import {
  analyzeOverlap,
  decodeImportBytes,
  filterTradesAroundNews,
  importTradeHistory,
  mergeTradeLogs,
  toBootstrapInputs,
  toTradeLogEntries,
  type ImportResult,
  type NewsCurrency,
  type NewsFilterOptions,
  type NewsFilterResult,
  type NewsImpact,
  type OverlapReport,
  type RiskSpec,
  type SimResult,
  type TradeLogEntry,
  type TraderProfileInput,
} from "@luxalgo/prop-firm-sim-core";
import { UsageError } from "./errors.js";
import { parseNumberFlag, parseRiskFlag } from "./parse.js";
import type { TraderFlags } from "./profile.js";

export const MAX_TRADE_LOGS = 5;

const NEWS_IMPACTS = ["low", "medium", "high"] as const;
const NEWS_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"] as const;

/** Raw trade-log and news flag values as commander hands them over. */
export interface TradeLogFlags {
  /** Accumulated --trade-log file paths (the flag repeats, up to 5 files). */
  tradeLog?: string[];
  /** --import-risk: risk per trade for exports that carry P&L but no risk. */
  importRisk?: string;
  /** --avoid-news: true when passed bare, a comma list of impacts otherwise. */
  avoidNews?: string | boolean;
  newsPre?: string;
  newsPost?: string;
  newsCurrencies?: string;
}

export interface TradeLogIo {
  /** Injectable for tests. Returning bytes decodes by BOM (MetaTrader saves
   *  reports as UTF-16LE); the default reads raw bytes from disk. */
  readFile?: (path: string) => string | Uint8Array;
}

export interface LoadedTradeLogs {
  files: string[];
  /** One parsed history per file, in flag order. */
  histories: TradeLogEntry[][];
  /** Non-fatal parse warnings, prefixed with the file they came from. */
  warnings: string[];
}

/**
 * Turn --import-risk into a RiskSpec: a bare number is cash risked per trade
 * ("25"), a percent is percent of entry value ("1%").
 */
export function parseImportRiskFlag(raw: string | undefined): RiskSpec | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(trimmed);
  if (pct !== null) {
    const percent = Number(pct[1]);
    if (!Number.isFinite(percent) || percent <= 0) {
      throw new UsageError(`--import-risk percent must be a positive number (got "${raw}")`);
    }
    return { type: "percent-of-entry-value", percent };
  }
  const amount = Number(trimmed);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new UsageError(
      `--import-risk takes cash risked per trade ("25") or a percent of entry value ("1%"), got "${raw}"`,
    );
  }
  return { type: "fixed-cash", amount };
}

/** Convert one ImportResult into simulator entries or refuse with the
 *  importer's own diagnostics. Shared by every file-loading path. */
export function entriesFromImport(result: ImportResult, path: string): TradeLogEntry[] {
  const errors = result.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message);
  if (!result.ok) {
    throw new UsageError(
      `"${path}" contains no parseable trades: ${errors.join(" ") || "no trades were recognized."}`,
    );
  }
  if (result.r.status === "needs-risk") {
    throw new UsageError(
      `"${path}" (${result.format.label}) carries P&L but no risk information, so trades cannot become ` +
        'R-multiples on their own. Pass --import-risk "25" (cash risked per trade) or --import-risk "1%" ' +
        "(percent of entry value) to convert under that stated assumption.",
    );
  }
  if (result.r.status !== "ready") {
    throw new UsageError(`"${path}": ${errors.join(" ") || "the file's R coverage is incomplete."}`);
  }
  const bridge = toTradeLogEntries(result.trades);
  if (bridge.dropped > 0) {
    throw new UsageError(
      `"${path}": ${bridge.dropped} trade(s) lack a timestamp or R value; refusing to simulate a silently thinned sample.`,
    );
  }
  if (bridge.entries.length === 0) {
    throw new UsageError(`"${path}" contains no parseable trades.`);
  }
  return bridge.entries;
}

/**
 * Read and import trade-log files: the generic template and plain timestamped
 * CSVs, and real exports (TradingView, MetaTrader statements incl. HTML, MT5
 * deals, ThinkOrSwim statements). Files are decoded by BOM. A file that
 * cannot be imported, or whose trades cannot honestly become R-multiples, is
 * a usage error carrying the importer's diagnostics.
 */
export function loadTradeLogs(
  paths: readonly string[],
  io: TradeLogIo & { minLogs?: number; importRisk?: string } = {},
): LoadedTradeLogs {
  const minLogs = io.minLogs ?? 1;
  if (paths.length < minLogs) {
    throw new UsageError(`at least ${minLogs} trade-log files are required (got ${paths.length})`);
  }
  if (paths.length > MAX_TRADE_LOGS) {
    throw new UsageError(`at most ${MAX_TRADE_LOGS} trade logs are supported (got ${paths.length})`);
  }
  const riskSpec = parseImportRiskFlag(io.importRisk);
  const readFile = io.readFile ?? ((path: string): Uint8Array => new Uint8Array(readFileSync(path)));
  const files: string[] = [];
  const histories: TradeLogEntry[][] = [];
  const warnings: string[] = [];
  for (const path of paths) {
    let raw: string | Uint8Array;
    try {
      raw = readFile(path);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new UsageError(`cannot read trade log "${path}": ${reason}`);
    }
    const text = typeof raw === "string" ? raw : decodeImportBytes(raw).text;
    const result = importTradeHistory(text, riskSpec !== undefined ? { riskSpec } : {});
    const entries = entriesFromImport(result, path);
    for (const issue of result.issues) {
      if (issue.severity === "error") continue;
      warnings.push(`${path}: ${issue.message}`);
    }
    files.push(path);
    histories.push(entries);
  }
  return { files, histories, warnings };
}

/**
 * Fail fast when news flags are passed without --trade-log: news windows are
 * matched against the log's timestamps, which a bare R-series does not have.
 */
export function assertNewsNeedsTradeLog(flags: TradeLogFlags): void {
  const given = (
    [
      ["--avoid-news", flags.avoidNews],
      ["--news-pre", flags.newsPre],
      ["--news-post", flags.newsPost],
      ["--news-currencies", flags.newsCurrencies],
    ] as const
  )
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);
  if (given.length > 0) {
    throw new UsageError(
      `${given.join(", ")} require${given.length === 1 ? "s" : ""} --trade-log: news windows are ` +
        "matched against the log's timestamps",
    );
  }
}

/** Build core NewsFilterOptions from the news flags; undefined without --avoid-news. */
export function buildNewsOptions(flags: TradeLogFlags): NewsFilterOptions | undefined {
  if (flags.avoidNews === undefined) {
    const orphaned =
      flags.newsPre !== undefined || flags.newsPost !== undefined || flags.newsCurrencies !== undefined;
    if (orphaned) {
      throw new UsageError(
        "--news-pre, --news-post, and --news-currencies only apply together with --avoid-news",
      );
    }
    return undefined;
  }
  const options: NewsFilterOptions = {};
  if (typeof flags.avoidNews === "string") {
    const impacts = flags.avoidNews
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0);
    for (const impact of impacts) {
      if (!(NEWS_IMPACTS as readonly string[]).includes(impact)) {
        throw new UsageError(
          `--avoid-news takes a comma list of impacts among ${NEWS_IMPACTS.join(", ")} (got "${impact}")`,
        );
      }
    }
    if (impacts.length > 0) options.impacts = impacts as NewsImpact[];
  }
  if (flags.newsPre !== undefined) {
    options.preMinutes = parseNumberFlag("--news-pre", flags.newsPre, { min: 0, max: 1440 });
  }
  if (flags.newsPost !== undefined) {
    options.postMinutes = parseNumberFlag("--news-post", flags.newsPost, { min: 0, max: 1440 });
  }
  if (flags.newsCurrencies !== undefined) {
    const currencies = flags.newsCurrencies
      .split(",")
      .map((token) => token.trim().toUpperCase())
      .filter((token) => token.length > 0);
    if (currencies.length === 0) {
      throw new UsageError("--news-currencies needs at least one currency code");
    }
    for (const currency of currencies) {
      if (!(NEWS_CURRENCIES as readonly string[]).includes(currency)) {
        throw new UsageError(
          `--news-currencies takes a comma list among ${NEWS_CURRENCIES.join(", ")} (got "${currency}")`,
        );
      }
    }
    options.currencies = currencies as NewsCurrency[];
  }
  return options;
}

/** Everything the simulate command needs to run and render a --trade-log request. */
export interface TradeLogPlan {
  files: string[];
  warnings: string[];
  historyCount: number;
  /** All entries (merged across logs), before any news filtering. */
  entries: TradeLogEntry[];
  /** Entries behind the primary run (news-avoided when --avoid-news is set). */
  simulatedEntries: TradeLogEntry[];
  /** Always set in portfolio mode (2+ logs); the audit-risk block must render. */
  overlap: OverlapReport | null;
  /** Set when --avoid-news is given. */
  news: NewsFilterResult | null;
  /** Bootstrap profile of the primary run. */
  profile: TraderProfileInput;
  /** Full-history profile for the comparison run; set only with --avoid-news. */
  originalProfile: TraderProfileInput | null;
  distinctDays: number;
  /** Trades/day derived from timestamps; null when --trades-per-day was given. */
  derivedTradesPerDay: number | null;
}

const CONFLICTING_TRADER_FLAGS = [
  ["--winrate", "winrate"],
  ["--avg-win", "avgWin"],
  ["--avg-loss", "avgLoss"],
  ["--win-std", "winStd"],
  ["--loss-std", "lossStd"],
  ["--r-series", "rSeries"],
  ["--r-series-file", "rSeriesFile"],
] as const;

/**
 * Turn --trade-log (plus the news flags) into a bootstrap simulation plan:
 * parse the files, merge 2+ histories into a portfolio (always analyzing
 * overlap), optionally split off news-window trades, and build the trader
 * profile(s) with trades/day derived from the timestamps unless overridden.
 */
export function buildTradeLogPlan(flags: TraderFlags & TradeLogFlags, io: TradeLogIo = {}): TradeLogPlan {
  const conflicting = CONFLICTING_TRADER_FLAGS.filter(
    ([, key]) => (flags as Record<string, unknown>)[key] !== undefined,
  ).map(([name]) => name);
  if (conflicting.length > 0) {
    throw new UsageError(
      `cannot mix --trade-log with ${conflicting.join(", ")}: the trade log is itself the trader ` +
        "model (a bootstrap over its R column), so pick one",
    );
  }

  const loaded = loadTradeLogs(flags.tradeLog ?? [], {
    ...io,
    ...(flags.importRisk !== undefined ? { importRisk: flags.importRisk } : {}),
  });
  const merged = loaded.histories.length > 1 ? mergeTradeLogs(loaded.histories) : null;
  const entries = merged !== null ? merged.entries : loaded.histories[0]!;
  const overlap = loaded.histories.length > 1 ? analyzeOverlap(loaded.histories) : null;

  const newsOptions = buildNewsOptions(flags);
  const news = newsOptions !== undefined ? filterTradesAroundNews(entries, newsOptions) : null;
  const simulatedEntries = news !== null ? news.kept : entries;
  if (simulatedEntries.length < 10) {
    throw new UsageError(
      news !== null
        ? `avoiding news excluded ${news.excluded.length} of ${entries.length} trades and left only ` +
            `${simulatedEntries.length}; at least 10 are needed to bootstrap (narrow --news-pre/--news-post, ` +
            "the impacts, or --news-currencies)"
        : `the trade log needs at least 10 trades to bootstrap from (got ${simulatedEntries.length})`,
    );
  }

  if (flags.risk === undefined) {
    throw new UsageError(
      'risk per trade is required: --risk "0.5%" (percent of balance by default; see --risk-mode)',
    );
  }
  const risk = parseRiskFlag(flags.risk, flags.riskMode);
  let flagTradesPerDay: number | undefined;
  if (flags.tradesPerDay !== undefined) {
    flagTradesPerDay = parseNumberFlag("--trades-per-day", flags.tradesPerDay, { min: 0 });
    if (flagTradesPerDay <= 0) {
      throw new UsageError(`--trades-per-day must be greater than 0 (got "${flags.tradesPerDay}")`);
    }
  }

  const buildProfile = (inputs: ReturnType<typeof toBootstrapInputs>): TraderProfileInput => ({
    kind: "bootstrap",
    rSeries: inputs.rSeries,
    ...(flags.blockLength !== undefined
      ? { blockMeanLength: parseNumberFlag("--block-length", flags.blockLength, { min: 1 }) }
      : {}),
    tradesPerDay: flagTradesPerDay ?? inputs.tradesPerDay,
    ...(flags.poisson ? { tradesPerDayModel: "poisson" as const } : {}),
    risk,
  });

  const primaryInputs = toBootstrapInputs(simulatedEntries);
  return {
    files: loaded.files,
    warnings: loaded.warnings,
    historyCount: loaded.histories.length,
    entries,
    simulatedEntries,
    overlap,
    news,
    profile: buildProfile(primaryInputs),
    originalProfile: news !== null ? buildProfile(toBootstrapInputs(entries)) : null,
    distinctDays: primaryInputs.distinctDays,
    derivedTradesPerDay: flagTradesPerDay === undefined ? primaryInputs.tradesPerDay : null,
  };
}

/** Headline numbers of one scenario in the with/without-news comparison. */
export interface NewsScenarioNumbers {
  passProbability: number;
  fundedProbability: number;
  evTotal: number;
}

/** The comparison block carried in --json output alongside the SimResult. */
export interface NewsComparison {
  original: NewsScenarioNumbers;
  newsAvoided: NewsScenarioNumbers;
  excludedTrades: number;
  heldThroughCount: number;
  eventsInRange: number;
  options: NewsFilterResult["options"];
  caveat: string;
}

export function buildNewsComparison(
  original: SimResult,
  newsAvoided: SimResult,
  filter: NewsFilterResult,
): NewsComparison {
  const numbersOf = (result: SimResult): NewsScenarioNumbers => ({
    passProbability: result.perAttempt.passProbability,
    fundedProbability: result.journey.fundedProbability,
    evTotal: result.ev.evTotal,
  });
  return {
    original: numbersOf(original),
    newsAvoided: numbersOf(newsAvoided),
    excludedTrades: filter.excluded.length,
    heldThroughCount: filter.heldThroughCount,
    eventsInRange: filter.eventsInRange,
    options: filter.options,
    caveat: filter.caveat,
  };
}
