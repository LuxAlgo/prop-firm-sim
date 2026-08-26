import type { ChallengeSpec } from "../spec/challenge.js";
import type { SimOptions } from "../spec/options.js";
import type { TraderProfile } from "../spec/trader.js";
import type {
  AssumptionFlag,
  DistSummary,
  FailReason,
  Histogram,
  SimResult,
  StepStats,
} from "../spec/result.js";
import { DISCLAIMER, ENGINE_VERSION } from "../version.js";
import { histogramSorted, standardError, summarizeSorted, wilson95 } from "../stats/summary.js";
import type { AttemptAccumulator } from "./journey.js";

export interface PathArrays {
  funded: Uint8Array;
  attempts: Float64Array;
  tradingDaysToFunded: Float64Array;
  cost: Float64Array;
  payoutTotal: Float64Array;
  payoutEvents: Float64Array;
  fundedBlown: Uint8Array;
  firstPayoutDay: Float64Array;
  maxDrawdownPct: Float64Array;
  net: Float64Array;
  anyAbandoned: boolean;
}

function sortedCopy(values: Float64Array): Float64Array {
  return Float64Array.from(values).sort();
}

function summarizeWithHistogram(
  values: Float64Array,
  includeHistograms: boolean,
): { summary: DistSummary; histogram: Histogram | null } {
  const sorted = sortedCopy(values);
  return {
    summary: summarizeSorted(sorted),
    histogram: includeHistograms ? histogramSorted(sorted) : null,
  };
}

function filterFinite(values: Float64Array): Float64Array {
  let count = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i]!)) count++;
  const out = new Float64Array(count);
  let j = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i]!)) out[j++] = values[i]!;
  return out;
}

function filterWhere(values: Float64Array, mask: Uint8Array): Float64Array {
  let count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) count++;
  const out = new Float64Array(count);
  let j = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) out[j++] = values[i]!;
  return out;
}

export function buildAssumptionFlags(
  spec: ChallengeSpec,
  profile: TraderProfile,
  options: SimOptions,
  anyAbandoned: boolean,
): AssumptionFlag[] {
  const flags: AssumptionFlag[] = [];

  for (const id of spec.flagsNotSimulated) {
    flags.push({
      id,
      detail: "Declared by the ruleset as present but not simulated. Real pass probability may be lower.",
      source: "dataset",
    });
  }

  const engine = (id: string, detail: string) => flags.push({ id, detail, source: "engine" });

  engine(
    "trades-resolve-same-day",
    "All trades are modeled as same-day round trips; overnight and weekend holding are not simulated.",
  );

  const usesIntradayRules =
    spec.maxLoss.mode === "trailing-intraday-unrealized" ||
    spec.maxLoss.mode === "trailing-locks-at-initial" ||
    spec.dailyLoss?.includesOpenPnl === true;
  if (usesIntradayRules) {
    engine(
      "intra-trade-excursions-not-modeled",
      "Equity is observed at each trade close; favorable/adverse excursions inside a trade are not modeled, " +
        "which slightly understates trailing-drawdown and open-PnL breach risk (real odds are somewhat worse).",
    );
  }

  if (spec.dailyLoss?.basis === "prior-day-equity") {
    engine(
      "daily-basis-equity-equals-balance",
      "With no overnight positions simulated, prior-day equity equals prior-day balance.",
    );
  }

  if (spec.steps.some((s) => s.minTradingDays > 0)) {
    engine(
      "post-target-min-days-risk-free",
      "After every objective is met, remaining minimum trading days are simulated as risk-free trading days.",
    );
  }

  if (spec.steps.some((s) => s.consistency != null)) {
    engine(
      "consistency-stop-rule",
      "Consistency rules are simulated with a rational stop rule: the trader stops a day once further profit " +
        "cannot improve compliance, and keeps trading across days until the best-day share satisfies the rule.",
    );
  }

  engine(
    "attempts-iid",
    "Attempts are independent draws from the same trader profile; no learning or tilt effects.",
  );

  if (spec.fees.billing === "monthly") {
    engine("monthly-billing-approximation", "Monthly billing is charged once per 21 simulated trading days.");
  }

  if (options.simulateFunded) {
    engine(
      "funded-withdrawal-model",
      "On each eligible payout day the trader withdraws the maximum the rules allow (profit above any buffer, " +
        "per-payout caps, never below the loss floor); balances and loss floors carry across payouts.",
    );
    if (spec.funded.payoutRules?.consistencyMaxBestDayPct !== undefined) {
      engine(
        "funded-consistency-window-approximated",
        "The funded consistency gate is evaluated per payout window rather than over the account's lifetime.",
      );
    }
    if (spec.funded.firstPayoutMinDays > 0) {
      engine(
        "calendar-days-approximated",
        "Calendar-day payout minimums convert to trading days at 5 per 7.",
      );
    }
  }

  if (anyAbandoned) {
    engine(
      "abandoned-attempts-are-failures",
      `Attempts still unresolved after ${options.unlimitedStepDayCap} trading days (no time limit) count as failed.`,
    );
  }

  if (profile.kind === "bootstrap") {
    engine(
      "bootstrap-resampling",
      "Outcomes are stationary-block-bootstrap resamples of the provided R-series; the future is assumed to look " +
        "like that sample, including its streakiness.",
    );
  }

  if (spec.constraints !== undefined) {
    const keys = Object.entries(spec.constraints)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    if (keys.length > 0) {
      engine(
        "trading-constraints-not-simulated",
        `Recorded but not simulated: ${keys.join(", ")}. They can restrict a real strategy in ways this model ignores.`,
      );
    }
  }

  return flags;
}

export function aggregate(
  spec: ChallengeSpec,
  profile: TraderProfile,
  options: SimOptions,
  paths: PathArrays,
  acc: AttemptAccumulator,
): SimResult {
  const stepStats: StepStats[] = acc.stepReached.map((reached, index) => {
    const passed = acc.stepPassed[index]!;
    return {
      index,
      reached,
      passed,
      passProbability: reached > 0 ? passed / reached : Number.NaN,
      passProbabilityCi: wilson95(passed, reached),
      failureBreakdown: acc.stepFailCounts[index]!,
    };
  });

  let fundedCount = 0;
  for (let i = 0; i < paths.funded.length; i++) fundedCount += paths.funded[i]!;

  const attemptsAgg = summarizeWithHistogram(paths.attempts, options.includeHistograms);
  const costAgg = summarizeWithHistogram(paths.cost, options.includeHistograms);
  const netAgg = summarizeWithHistogram(paths.net, options.includeHistograms);
  const ddPctAgg = summarizeWithHistogram(paths.maxDrawdownPct, options.includeHistograms);

  const daysToFundedSorted = sortedCopy(filterFinite(paths.tradingDaysToFunded));
  const costGivenFundedSorted = sortedCopy(filterWhere(paths.cost, paths.funded));

  let pPositive = 0;
  for (let i = 0; i < paths.net.length; i++) if (paths.net[i]! > 0) pPositive++;
  pPositive /= paths.net.length;

  let funded: SimResult["funded"] = null;
  if (options.simulateFunded) {
    const payoutSorted = sortedCopy(paths.payoutTotal);
    const payoutGivenFundedSorted = sortedCopy(filterWhere(paths.payoutTotal, paths.funded));
    let blown = 0;
    let events = 0;
    let pathsWithPayout = 0;
    for (let i = 0; i < paths.funded.length; i++) {
      if (paths.funded[i] === 1) {
        blown += paths.fundedBlown[i]!;
        events += paths.payoutEvents[i]!;
        if (paths.payoutEvents[i]! > 0) pathsWithPayout++;
      }
    }
    const firstPayoutSorted = sortedCopy(filterFinite(paths.firstPayoutDay));
    funded = {
      horizonTradingDays: options.fundedHorizonDays,
      payoutTotal: summarizeSorted(payoutSorted),
      payoutTotalGivenFunded: fundedCount > 0 ? summarizeSorted(payoutGivenFundedSorted) : null,
      blownProbability: fundedCount > 0 ? blown / fundedCount : Number.NaN,
      avgPayoutEvents: fundedCount > 0 ? events / fundedCount : Number.NaN,
      payoutProbability: fundedCount > 0 ? pathsWithPayout / fundedCount : Number.NaN,
      daysToFirstPayout: pathsWithPayout > 0 ? summarizeSorted(firstPayoutSorted) : null,
    };
  }

  const evMean = netAgg.summary.mean;

  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    perAttempt: {
      attemptsObserved: acc.attempts,
      passProbability: acc.attempts > 0 ? acc.passed / acc.attempts : Number.NaN,
      passProbabilityCi: wilson95(acc.passed, acc.attempts),
      failureBreakdown: acc.failCounts,
      avgDaysWhenPassed: acc.passed > 0 ? acc.daysWhenPassedSum / acc.passed : null,
      avgDaysWhenFailed:
        acc.attempts - acc.passed > 0 ? acc.daysWhenFailedSum / (acc.attempts - acc.passed) : null,
      stagnationDays: summarizeSorted([...acc.stagnationDays].sort((a, b) => a - b)),
      steps: stepStats,
    },
    journey: {
      fundedProbability: fundedCount / paths.funded.length,
      fundedProbabilityCi: wilson95(fundedCount, paths.funded.length),
      attemptCap: options.attemptCap,
      attempts: attemptsAgg.summary,
      attemptsHistogram: attemptsAgg.histogram,
      cost: costAgg.summary,
      costHistogram: costAgg.histogram,
      costGivenFunded: fundedCount > 0 ? summarizeSorted(costGivenFundedSorted) : null,
      daysToFunded: fundedCount > 0 ? summarizeSorted(daysToFundedSorted) : null,
    },
    funded,
    ev: {
      evTotal: evMean,
      evStandardError: standardError(paths.net, evMean),
      pPositive,
      net: netAgg.summary,
      netHistogram: netAgg.histogram,
    },
    drawdown: {
      maxDrawdownPct: ddPctAgg.summary,
      histogram: ddPctAgg.histogram,
    },
    assumptions: {
      spec,
      profile,
      options,
      flags: buildAssumptionFlags(spec, profile, options, paths.anyAbandoned),
      disclaimer: DISCLAIMER,
    },
    meta: {
      paths: options.paths,
      seed: options.seed,
    },
  };
}

export const FAIL_REASONS: readonly FailReason[] = ["daily-loss", "max-loss", "time-limit", "abandoned"];
