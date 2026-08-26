import type { ChallengeSpec } from "../spec/challenge.js";
import type { RiskSizing } from "../spec/trader.js";
import type { SimOptions } from "../spec/options.js";
import type { FailReason } from "../spec/result.js";
import type { Rng } from "./rng.js";
import type { TradeSource } from "./trades.js";
import { simulateAttempt, type DayRecorder, type DrawdownTracker, type ResolvedStep } from "./attempt.js";
import { simulateFunded } from "./funded.js";

/** Monthly billing approximation: one charge per ~21 simulated trading days. */
const TRADING_DAYS_PER_MONTH = 21;

/**
 * Pooled per-attempt counters. Attempts are i.i.d. draws from the same trader
 * profile, so attempts from every path pool into one sample - tighter Wilson
 * intervals than per-path stats would give.
 */
export interface AttemptAccumulator {
  attempts: number;
  passed: number;
  failCounts: Record<FailReason, number>;
  /** Sum of simulated days across passed / failed attempts, for verdict averages. */
  daysWhenPassedSum: number;
  daysWhenFailedSum: number;
  /** One value per attempt: its longest stagnation run (see AttemptOutcome). */
  stagnationDays: number[];
  stepReached: number[];
  stepPassed: number[];
  stepFailCounts: Record<FailReason, number>[];
}

export function makeAttemptAccumulator(stepCount: number): AttemptAccumulator {
  const zeroFails = (): Record<FailReason, number> => ({
    "daily-loss": 0,
    "max-loss": 0,
    "time-limit": 0,
    abandoned: 0,
  });
  return {
    attempts: 0,
    passed: 0,
    failCounts: zeroFails(),
    daysWhenPassedSum: 0,
    daysWhenFailedSum: 0,
    stagnationDays: [],
    stepReached: new Array<number>(stepCount).fill(0),
    stepPassed: new Array<number>(stepCount).fill(0),
    stepFailCounts: Array.from({ length: stepCount }, zeroFails),
  };
}

export interface JourneyRecord {
  funded: boolean;
  attempts: number;
  /** Trading days spent evaluating until funded; NaN when never funded. */
  tradingDaysToFunded: number;
  /** Total fees: prices + resets + activation + monthly billing − refunds. */
  cost: number;
  payoutTotal: number;
  payoutEvents: number;
  fundedBlown: boolean;
  /** Funded trading day of the first payout; NaN when none happened. */
  firstPayoutDay: number;
  /** Worst evaluation-phase drawdown as a fraction of the initial account. */
  maxDrawdownFraction: number;
  /** payoutTotal − cost. */
  net: number;
  /** True when any attempt ended as 'abandoned' (unlimited-time cap hit). */
  sawAbandoned: boolean;
  /** Verdict of the path's first attempt (what the challenge trace shows). */
  firstAttemptPassed: boolean;
  firstAttemptFailReason: FailReason | null;
}

/**
 * One Monte Carlo path: attempt the challenge until funded or the attempt cap,
 * paying fees along the way, then (optionally) trade the funded account over
 * the configured horizon.
 */
export function simulateJourney(
  spec: ChallengeSpec,
  steps: ResolvedStep[],
  source: TradeSource,
  sizing: RiskSizing,
  rng: Rng,
  options: SimOptions,
  acc: AttemptAccumulator,
  tracers?: { challenge: DayRecorder; funded: DayRecorder },
): JourneyRecord {
  const fees = spec.fees;
  let cost = 0;
  let attempts = 0;
  let evalTradingDays = 0;
  let evalDays = 0;
  let funded = false;
  let sawAbandoned = false;
  let firstAttemptPassed = false;
  let firstAttemptFailReason: FailReason | null = null;
  const dd: DrawdownTracker = { peak: spec.accountSize, maxDrawdown: 0 };

  for (let a = 1; a <= options.attemptCap; a++) {
    attempts = a;
    if (fees.billing === "one-time") {
      cost += a === 1 ? fees.price : (fees.resetFee ?? fees.price);
    }

    source.reset(rng);
    const outcome = simulateAttempt(
      steps,
      source,
      sizing,
      rng,
      spec.accountSize,
      options.unlimitedStepDayCap,
      dd,
      a === 1 ? tracers?.challenge : undefined,
    );
    if (a === 1) {
      firstAttemptPassed = outcome.passed;
      firstAttemptFailReason = outcome.failReason;
    }

    acc.attempts++;
    acc.stagnationDays.push(outcome.maxStagnationDays);
    for (let i = 0; i < outcome.stepOutcomes.length; i++) {
      const stepOutcome = outcome.stepOutcomes[i];
      if (stepOutcome === undefined) continue;
      acc.stepReached[i]!++;
      if (stepOutcome.passed) acc.stepPassed[i]!++;
      else acc.stepFailCounts[i]![stepOutcome.failReason!]++;
    }
    if (outcome.passed) {
      acc.passed++;
      acc.daysWhenPassedSum += outcome.daysUsed;
    } else {
      acc.failCounts[outcome.failReason!]++;
      acc.daysWhenFailedSum += outcome.daysUsed;
    }
    if (outcome.failReason === "abandoned") sawAbandoned = true;

    evalTradingDays += outcome.tradingDays;
    evalDays += outcome.daysUsed;

    if (outcome.passed) {
      funded = true;
      break;
    }
  }

  if (fees.billing === "monthly") {
    cost += Math.max(1, Math.ceil(evalDays / TRADING_DAYS_PER_MONTH)) * fees.price;
    if (fees.resetFee !== null) cost += (attempts - 1) * fees.resetFee;
  }

  let payoutTotal = 0;
  let payoutEvents = 0;
  let fundedBlown = false;
  let firstPayoutDay = Number.NaN;

  if (funded) {
    cost += fees.activationFee;
    if (fees.refundableOnPass && fees.billing === "one-time") {
      cost -= fees.price; // the challenge fee comes back with the first payout
    }
    if (options.simulateFunded) {
      const fundedOutcome = simulateFunded(
        spec,
        source,
        sizing,
        rng,
        options.fundedHorizonDays,
        tracers?.funded,
      );
      payoutTotal = fundedOutcome.payoutTotal;
      payoutEvents = fundedOutcome.payoutEvents;
      fundedBlown = fundedOutcome.blown;
      if (fundedOutcome.firstPayoutDay !== null) firstPayoutDay = fundedOutcome.firstPayoutDay;
    }
  }

  return {
    funded,
    attempts,
    tradingDaysToFunded: funded ? evalTradingDays : Number.NaN,
    cost,
    payoutTotal,
    payoutEvents,
    fundedBlown,
    firstPayoutDay,
    maxDrawdownFraction: dd.maxDrawdown / spec.accountSize,
    net: payoutTotal - cost,
    sawAbandoned,
    firstAttemptPassed,
    firstAttemptFailReason,
  };
}
