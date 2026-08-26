import { readFileSync } from "node:fs";
import { parseRSeries, type RiskSizing, type TraderProfileInput } from "@luxalgo/prop-firm-sim-core";
import { UsageError } from "./errors.js";
import { parseNumberFlag, parseRiskFlag, parseRiskMode } from "./parse.js";

/** Raw trader-model flag values as commander hands them over (strings). */
export interface TraderFlags {
  winrate?: string;
  avgWin?: string;
  avgLoss?: string;
  winStd?: string;
  lossStd?: string;
  tradesPerDay?: string;
  poisson?: boolean;
  risk?: string;
  riskMode?: string;
  rSeries?: string;
  rSeriesFile?: string;
  blockLength?: string;
}

export interface BuildProfileOptions {
  /**
   * When false (optimal-risk), --risk may be omitted: the sweep overrides the
   * value anyway, so a placeholder in the requested mode is used.
   */
  riskRequired?: boolean;
  /** Injectable for tests; defaults to reading the file from disk as UTF-8. */
  readFile?: (path: string) => string;
}

const PARAMETRIC_FLAGS = ["--winrate", "--avg-win", "--avg-loss", "--win-std", "--loss-std"] as const;
const BOOTSTRAP_FLAGS = ["--r-series", "--r-series-file", "--block-length"] as const;

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

function presentFlags(flags: TraderFlags, names: readonly string[]): string[] {
  const byName: Record<string, string | undefined> = {
    "--winrate": flags.winrate,
    "--avg-win": flags.avgWin,
    "--avg-loss": flags.avgLoss,
    "--win-std": flags.winStd,
    "--loss-std": flags.lossStd,
    "--r-series": flags.rSeries,
    "--r-series-file": flags.rSeriesFile,
    "--block-length": flags.blockLength,
  };
  return names.filter((name) => byName[name] !== undefined);
}

function resolveRisk(flags: TraderFlags, riskRequired: boolean): RiskSizing {
  if (flags.risk !== undefined) return parseRiskFlag(flags.risk, flags.riskMode);
  const mode = parseRiskMode(flags.riskMode) ?? "percent-of-balance";
  if (!riskRequired) return { mode, value: 1 }; // placeholder; the sweep sets the value
  throw new UsageError(
    'risk per trade is required: --risk "0.5%" (percent of balance by default; see --risk-mode)',
  );
}

/**
 * Build the core TraderProfileInput from CLI flags. Parametric
 * (--winrate/--avg-win/...) and bootstrap (--r-series/--r-series-file) flags
 * are mutually exclusive; --trades-per-day and (usually) --risk are required.
 */
export function buildProfileFromFlags(
  flags: TraderFlags,
  opts: BuildProfileOptions = {},
): TraderProfileInput {
  const parametricGiven = presentFlags(flags, PARAMETRIC_FLAGS);
  const bootstrapGiven = presentFlags(flags, BOOTSTRAP_FLAGS);
  if (parametricGiven.length > 0 && bootstrapGiven.length > 0) {
    throw new UsageError(
      `cannot mix win-rate flags (${parametricGiven.join(", ")}) with R-series flags ` +
        `(${bootstrapGiven.join(", ")}) - pick one trader model`,
    );
  }
  if (parametricGiven.length === 0 && bootstrapGiven.length === 0) {
    throw new UsageError(
      "trader profile required: pass --winrate and --avg-win (win-rate model), " +
        "or --r-series / --r-series-file (bootstrap from your own R-multiples)",
    );
  }

  if (flags.tradesPerDay === undefined) {
    throw new UsageError("--trades-per-day is required (average trades per simulated trading day)");
  }
  const tradesPerDay = parseNumberFlag("--trades-per-day", flags.tradesPerDay, { min: 0 });
  if (tradesPerDay <= 0) {
    throw new UsageError(`--trades-per-day must be greater than 0 (got "${flags.tradesPerDay}")`);
  }
  const risk = resolveRisk(flags, opts.riskRequired ?? true);
  const shared = {
    tradesPerDay,
    ...(flags.poisson ? { tradesPerDayModel: "poisson" as const } : {}),
    risk,
  };

  if (bootstrapGiven.length > 0) {
    if (flags.rSeries !== undefined && flags.rSeriesFile !== undefined) {
      throw new UsageError("pass either --r-series or --r-series-file, not both");
    }
    let text = flags.rSeries;
    if (text === undefined) {
      if (flags.rSeriesFile === undefined) {
        throw new UsageError("bootstrap mode needs the series itself: --r-series or --r-series-file");
      }
      try {
        text = (opts.readFile ?? defaultReadFile)(flags.rSeriesFile);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new UsageError(`cannot read --r-series-file "${flags.rSeriesFile}": ${reason}`);
      }
    }
    let rSeries: number[];
    try {
      rSeries = parseRSeries(text);
    } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
    if (rSeries.length < 10) {
      throw new UsageError(`the R-series needs at least 10 trades to bootstrap from (got ${rSeries.length})`);
    }
    return {
      kind: "bootstrap",
      rSeries,
      ...(flags.blockLength !== undefined
        ? { blockMeanLength: parseNumberFlag("--block-length", flags.blockLength, { min: 1 }) }
        : {}),
      ...shared,
    };
  }

  if (flags.winrate === undefined || flags.avgWin === undefined) {
    throw new UsageError(
      "the win-rate model needs both --winrate (e.g. 0.52) and --avg-win (average winner in R, e.g. 1.8)",
    );
  }
  const winRate = parseNumberFlag("--winrate", flags.winrate, { min: 0, max: 1 });
  const avgWinR = parseNumberFlag("--avg-win", flags.avgWin, { min: 0 });
  if (avgWinR <= 0) throw new UsageError(`--avg-win must be greater than 0 (got "${flags.avgWin}")`);
  let avgLossR: number | undefined;
  if (flags.avgLoss !== undefined) {
    avgLossR = parseNumberFlag("--avg-loss", flags.avgLoss, { min: 0 });
    if (avgLossR <= 0) {
      throw new UsageError(
        `--avg-loss must be greater than 0 - express the average loser as a positive R size (got "${flags.avgLoss}")`,
      );
    }
  }
  return {
    kind: "parametric",
    winRate,
    avgWinR,
    ...(avgLossR !== undefined ? { avgLossR } : {}),
    ...(flags.winStd !== undefined
      ? { winStdR: parseNumberFlag("--win-std", flags.winStd, { min: 0 }) }
      : {}),
    ...(flags.lossStd !== undefined
      ? { lossStdR: parseNumberFlag("--loss-std", flags.lossStd, { min: 0 }) }
      : {}),
    ...shared,
  };
}
