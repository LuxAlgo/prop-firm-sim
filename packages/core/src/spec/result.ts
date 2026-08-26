import type { ChallengeSpec } from "./challenge.js";
import type { SimOptions } from "./options.js";
import type { TraderProfile } from "./trader.js";

/** Why an attempt (or funded account) ended in failure. */
export type FailReason = "daily-loss" | "max-loss" | "time-limit" | "abandoned";

export interface WilsonCi {
  /** Lower bound of the Wilson 95% confidence interval. */
  low: number;
  /** Upper bound of the Wilson 95% confidence interval. */
  high: number;
}

export interface DistSummary {
  mean: number;
  min: number;
  max: number;
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
}

export interface Histogram {
  min: number;
  max: number;
  binWidth: number;
  counts: number[];
}

export interface AssumptionFlag {
  /** Stable kebab-case id, e.g. "consistency-rule-40pct" or "intra-trade-excursions-not-modeled". */
  id: string;
  /** Human-readable explanation of what is simplified or skipped. */
  detail: string;
  /** Whether the flag was declared by the spec (source "dataset") or added by the engine. */
  source: "dataset" | "engine";
}

/** Per-step statistics pooled over every attempt observed across all paths. */
export interface StepStats {
  index: number;
  /** Attempts that reached this step. */
  reached: number;
  /** Attempts that passed this step. */
  passed: number;
  /** Pass probability conditional on reaching the step. */
  passProbability: number;
  passProbabilityCi: WilsonCi;
  failureBreakdown: Record<FailReason, number>;
}

export interface PerAttemptStats {
  /** Total attempts observed across all paths (attempts are i.i.d., so they pool). */
  attemptsObserved: number;
  /** Probability a single attempt passes every step (joint). */
  passProbability: number;
  passProbabilityCi: WilsonCi;
  failureBreakdown: Record<FailReason, number>;
  /** Average simulated days per attempt, split by verdict (null when unobserved). */
  avgDaysWhenPassed: number | null;
  avgDaysWhenFailed: number | null;
  /**
   * Stagnation per attempt: the longest run of simulated days without a new
   * day-close equity high (each step resets the reference with its fresh
   * account; risk-free days after a step's objectives are met don't count).
   * The dead time between progress is what traders feel most, and it grows
   * sharply as risk per trade shrinks.
   */
  stagnationDays: DistSummary;
  steps: StepStats[];
}

export interface JourneyStats {
  /** Probability of getting funded within `attemptCap` attempts. */
  fundedProbability: number;
  fundedProbabilityCi: WilsonCi;
  attemptCap: number;
  /** Attempts used per path (censored at attemptCap for never-funded paths). */
  attempts: DistSummary;
  attemptsHistogram: Histogram | null;
  /** Total fees paid per path: prices, resets, activation, monthly billing, minus refunds. */
  cost: DistSummary;
  costHistogram: Histogram | null;
  /** Cost conditional on getting funded; null when no path got funded. */
  costGivenFunded: DistSummary | null;
  /** Trading days from first attempt to funded, among funded paths; null when no path got funded. */
  daysToFunded: DistSummary | null;
}

export interface FundedStats {
  horizonTradingDays: number;
  /** Trader-share payout total per path over the horizon (0 for paths never funded). */
  payoutTotal: DistSummary;
  /** Payout total conditional on getting funded; null when no path got funded. */
  payoutTotalGivenFunded: DistSummary | null;
  /** Share of funded paths that breached the funded account's loss rules within the horizon. */
  blownProbability: number;
  /** Average number of payout events among funded paths. */
  avgPayoutEvents: number;
  /** Probability of collecting at least one payout, conditional on getting funded. */
  payoutProbability: number;
  /** Funded trading days until the first payout, among paths that collected one; null when none did. */
  daysToFirstPayout: DistSummary | null;
}

export interface EvStats {
  /** Mean of (payouts − total cost) across all paths. */
  evTotal: number;
  /** Standard error of evTotal (mean ± 1.96·se ≈ 95% CI). */
  evStandardError: number;
  /** Probability a path's net (payouts − cost) is positive. */
  pPositive: number;
  net: DistSummary;
  netHistogram: Histogram | null;
}

export interface DrawdownStats {
  /** Worst peak-to-trough drawdown experienced during evaluation, in percent of the initial account. */
  maxDrawdownPct: DistSummary;
  histogram: Histogram | null;
}

export interface Assumptions {
  /** The fully-resolved inputs the engine actually ran (defaults applied). Self-describing results. */
  spec: ChallengeSpec;
  profile: TraderProfile;
  options: SimOptions;
  /** Every simplification and every spec-declared unsimulated rule. Never empty in practice. */
  flags: AssumptionFlag[];
  disclaimer: string;
}

/** Day-by-day record of one traced path, for visualization (fan charts). */
export interface TracePath {
  /** Monte Carlo path index (aligns with the seed's per-path stream). */
  pathIndex: number;
  /** 'passed' or the FailReason for challenge traces; 'survived' | 'blown' for funded traces. */
  outcome: "passed" | "survived" | "blown" | FailReason;
  /** Day-close equity, one entry per simulated day. */
  equity: number[];
  /** Effective max-loss floor at each day close - this is the line that moves under trailing rules. */
  floor: number[];
  /** Challenge traces: cumulative day index where each completed step ended. */
  stepBoundaries?: number[];
}

export interface Trace {
  /** First attempt of each traced path. */
  challenge: TracePath[];
  /** Funded stretch of traced paths that got funded (empty when simulateFunded is false). */
  funded: TracePath[];
}

export interface SimResult {
  schemaVersion: 1;
  engineVersion: string;
  perAttempt: PerAttemptStats;
  journey: JourneyStats;
  /** null when options.simulateFunded is false. */
  funded: FundedStats | null;
  ev: EvStats;
  drawdown: DrawdownStats;
  /** Present when options.tracePaths > 0. Pure observation; never changes the numbers. */
  trace?: Trace;
  assumptions: Assumptions;
  meta: {
    paths: number;
    seed: number | string;
  };
}
