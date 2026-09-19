import type { ChallengeSpec } from "../spec/challenge.js";
import type { RiskSizing } from "../spec/trader.js";
import type { FailReason } from "../spec/result.js";
import type { Rng } from "./rng.js";
import type { TradeSource } from "./trades.js";
import { RuleState, resolveStepRules, type ResolvedRules } from "./rules.js";

export interface ResolvedStep {
  targetBalance: number;
  minTradingDays: number;
  /** null = no time limit (bounded by options.unlimitedStepDayCap). */
  maxDays: number | null;
  /** Consistency fraction (0.5 for a 50% rule), or null for none. */
  consistencyFraction: number | null;
  rules: ResolvedRules;
}

export function resolveSteps(spec: ChallengeSpec): ResolvedStep[] {
  return spec.steps.map((step, index) => ({
    targetBalance:
      spec.accountSize + (step.profitTargetAmount ?? (step.profitTargetPct! / 100) * spec.accountSize),
    minTradingDays: step.minTradingDays,
    maxDays: step.maxDays,
    consistencyFraction: step.consistency ? step.consistency.maxBestDayProfitPct / 100 : null,
    rules: resolveStepRules(spec, index),
  }));
}

export function riskAmount(sizing: RiskSizing, balance: number, initialBalance: number): number {
  switch (sizing.mode) {
    case "percent-of-balance":
      return (sizing.value / 100) * balance;
    case "percent-of-initial":
      return (sizing.value / 100) * initialBalance;
    case "fixed-amount":
      return sizing.value;
  }
}

export interface StepOutcome {
  passed: boolean;
  failReason: FailReason | null;
  tradingDays: number;
  daysUsed: number;
  endBalance: number;
  /** Longest run of day closes without a new day-close equity high while the
   *  step's objectives were still open (risk-free tail days don't count). */
  maxStagnationDays: number;
}

export interface DrawdownTracker {
  peak: number;
  maxDrawdown: number;
}

/** Collects day-close equity and the loss boundaries for fan charts. */
export interface DayRecorder {
  day(balance: number, maxFloor: number, dailyFloor: number | null): void;
  stepEnd?(): void;
}

/**
 * Simulate one evaluation step on a fresh account.
 *
 * Behavioral assumptions (flagged in every result): once every objective is
 * met - target, and consistency when the step has one - the trader stops
 * taking risk; remaining minimum trading days are satisfied with risk-free
 * days that still count as trading days. Under a consistency rule the trader
 * keeps trading past the target until the best day's share complies, and stops
 * a day early once further profit that day cannot improve compliance (adding
 * to what is already the best day only raises the requirement). Passes are
 * awarded at the close of the day all objectives hold - a breach earlier in
 * that same day still fails the step, matching continuous monitoring.
 */
export function simulateStep(
  step: ResolvedStep,
  source: TradeSource,
  sizing: RiskSizing,
  rng: Rng,
  initialBalance: number,
  unlimitedStepDayCap: number,
  dd: DrawdownTracker,
  recorder?: DayRecorder,
): StepOutcome {
  const epsilon = initialBalance * 1e-9;
  const cFrac = step.consistencyFraction;
  let balance = initialBalance;
  const state = new RuleState(step.rules, initialBalance);
  let tradingDays = 0;
  let bestDayPnl = 0;
  let objectivesMet = false;
  // Stagnation: consecutive day closes without a new day-close equity high.
  let closePeak = initialBalance;
  let stagnationRun = 0;
  let maxStagnationDays = 0;

  const dayCap = step.maxDays ?? unlimitedStepDayCap;

  for (let day = 1; day <= dayCap; day++) {
    state.startDay(balance);
    const dayStartBalance = balance;

    if (!objectivesMet) {
      const trades = source.nextDayTradeCount(rng);
      if (trades > 0) tradingDays++;

      for (let t = 0; t < trades; t++) {
        const risk = riskAmount(sizing, balance, initialBalance);
        balance += source.nextTradeR(rng) * risk;

        if (balance > dd.peak) dd.peak = balance;
        else if (dd.peak - balance > dd.maxDrawdown) dd.maxDrawdown = dd.peak - balance;

        // Breach beats target when both are crossed by the same trade:
        // the account was monitored continuously on the way down.
        const breach = state.onTradeClose(balance);
        if (breach !== null) {
          recorder?.day(balance, state.currentMaxFloor, state.currentDailyFloor);
          return {
            passed: false,
            failReason: breach,
            tradingDays,
            daysUsed: day,
            endBalance: balance,
            maxStagnationDays,
          };
        }

        const profit = balance - initialBalance;
        if (balance >= step.targetBalance - epsilon) {
          if (cFrac === null) {
            objectivesMet = true;
            break; // stop taking risk for the rest of the step
          }
          const todayPnl = balance - dayStartBalance;
          const bestIncludingToday = todayPnl > bestDayPnl ? todayPnl : bestDayPnl;
          if (bestIncludingToday <= cFrac * profit + epsilon) {
            objectivesMet = true; // target AND consistency satisfied
            break;
          }
          // Consistency violated. If today is the binding best day, more profit
          // today only raises the requirement - stop and resume tomorrow.
          if (todayPnl >= bestDayPnl && todayPnl > cFrac * profit) break;
          // Otherwise a prior day binds; keep trading to grow total profit.
        }
      }
    } else {
      // Risk-free day to satisfy minTradingDays; still counts as a trading day.
      tradingDays++;
    }

    const dayPnl = balance - dayStartBalance;
    if (dayPnl > bestDayPnl) bestDayPnl = dayPnl;

    const breach = state.onDayClose(balance);
    if (breach !== null) {
      recorder?.day(balance, state.currentMaxFloor, state.currentDailyFloor);
      return {
        passed: false,
        failReason: breach,
        tradingDays,
        daysUsed: day,
        endBalance: balance,
        maxStagnationDays,
      };
    }

    recorder?.day(balance, state.currentMaxFloor, state.currentDailyFloor);

    if (!objectivesMet && cFrac !== null && balance >= step.targetBalance - epsilon) {
      const profit = balance - initialBalance;
      if (bestDayPnl <= cFrac * profit + epsilon) objectivesMet = true;
    }

    if (!objectivesMet) {
      if (balance > closePeak + epsilon) {
        closePeak = balance;
        stagnationRun = 0;
      } else {
        stagnationRun++;
        if (stagnationRun > maxStagnationDays) maxStagnationDays = stagnationRun;
      }
    }

    if (objectivesMet && tradingDays >= step.minTradingDays) {
      return {
        passed: true,
        failReason: null,
        tradingDays,
        daysUsed: day,
        endBalance: balance,
        maxStagnationDays,
      };
    }
  }

  return {
    passed: false,
    failReason: step.maxDays !== null ? "time-limit" : "abandoned",
    tradingDays,
    daysUsed: dayCap,
    endBalance: balance,
    maxStagnationDays,
  };
}

export interface AttemptOutcome {
  passed: boolean;
  failReason: FailReason | null;
  /** Step index the attempt failed at (or steps.length - 1 when passed). */
  endedAtStep: number;
  tradingDays: number;
  daysUsed: number;
  /** Longest stagnation (days without a new day-close equity high) in any
   *  step of this attempt - the dead time traders feel most at low risk. */
  maxStagnationDays: number;
  /** Per-step outcomes for pooled step statistics (undefined = not reached). */
  stepOutcomes: (StepOutcome | undefined)[];
}

/** Run one full attempt: every step in order, each on a fresh account. */
export function simulateAttempt(
  steps: ResolvedStep[],
  source: TradeSource,
  sizing: RiskSizing,
  rng: Rng,
  initialBalance: number,
  unlimitedStepDayCap: number,
  dd: DrawdownTracker,
  recorder?: DayRecorder,
): AttemptOutcome {
  const stepOutcomes: (StepOutcome | undefined)[] = new Array(steps.length).fill(undefined);
  let tradingDays = 0;
  let daysUsed = 0;
  let maxStagnationDays = 0;

  for (let i = 0; i < steps.length; i++) {
    // Each step starts a fresh account, so the drawdown reference resets too.
    dd.peak = initialBalance;
    const outcome = simulateStep(
      steps[i]!,
      source,
      sizing,
      rng,
      initialBalance,
      unlimitedStepDayCap,
      dd,
      recorder,
    );
    stepOutcomes[i] = outcome;
    tradingDays += outcome.tradingDays;
    daysUsed += outcome.daysUsed;
    if (outcome.maxStagnationDays > maxStagnationDays) maxStagnationDays = outcome.maxStagnationDays;
    recorder?.stepEnd?.();

    if (!outcome.passed) {
      return {
        passed: false,
        failReason: outcome.failReason,
        endedAtStep: i,
        tradingDays,
        daysUsed,
        maxStagnationDays,
        stepOutcomes,
      };
    }
  }

  return {
    passed: true,
    failReason: null,
    endedAtStep: steps.length - 1,
    tradingDays,
    daysUsed,
    maxStagnationDays,
    stepOutcomes,
  };
}
