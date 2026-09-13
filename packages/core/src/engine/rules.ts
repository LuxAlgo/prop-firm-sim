import type { ChallengeSpec, DailyLossRule, MaxLossRule } from "../spec/challenge.js";
import type { FailReason } from "../spec/result.js";

/*
  Rule enforcement shared by evaluation steps and the funded stage. Modeling
  granularity is trade-by-trade: equity is observed at each trade close (all
  trades are same-day round trips), and at each day close. Peaks for trailing
  modes therefore ratchet on trade-close equity - intra-trade excursions are
  not modeled, which is flagged in every result's assumptions.
*/

export interface ResolvedDailyLoss {
  /** Fixed currency limit (rule.amount, or pct of the initial balance). */
  fixedLimit: number | null;
  /** Fraction of the day's anchor (rule.pct with limitBasis 'anchor'). */
  anchorFraction: number | null;
  /** Only the day's closing balance is checked (evaluation 'end-of-day'). */
  endOfDayOnly: boolean;
}

export interface ResolvedMaxLoss {
  /** What the reference peak tracks. */
  trailing: "none" | "eod" | "intraday";
  /** Currency distance between the tracked reference and the floor. */
  amount: number;
  /** Equity level the floor freezes at, or null for a never-locking trail. */
  lockCap: number | null;
}

export interface ResolvedRules {
  daily: ResolvedDailyLoss | null;
  max: ResolvedMaxLoss;
}

export function resolveDailyLoss(rule: DailyLossRule | null, accountSize: number): ResolvedDailyLoss | null {
  if (rule === null) return null;
  if (rule.amount !== undefined) {
    return { fixedLimit: rule.amount, anchorFraction: null, endOfDayOnly: rule.evaluation === "end-of-day" };
  }
  const pct = rule.pct! / 100;
  if (rule.limitBasis === "initial-balance") {
    return {
      fixedLimit: pct * accountSize,
      anchorFraction: null,
      endOfDayOnly: rule.evaluation === "end-of-day",
    };
  }
  return { fixedLimit: null, anchorFraction: pct, endOfDayOnly: rule.evaluation === "end-of-day" };
}

export function resolveMaxLoss(rule: MaxLossRule, accountSize: number): ResolvedMaxLoss {
  const amount = rule.amount ?? (rule.pct! / 100) * accountSize;
  switch (rule.mode) {
    case "static-initial":
      return { trailing: "none", amount, lockCap: null };
    case "trailing-realized-eod":
      return {
        trailing: "eod",
        amount,
        lockCap: rule.locksAtInitial ? accountSize + rule.lockOffsetAmount : null,
      };
    case "trailing-intraday-unrealized":
      return { trailing: "intraday", amount, lockCap: null };
    case "trailing-locks-at-initial":
      return { trailing: "intraday", amount, lockCap: accountSize + rule.lockOffsetAmount };
  }
}

/** Effective rules for evaluation step `index`, applying per-step overrides. */
export function resolveStepRules(spec: ChallengeSpec, index: number): ResolvedRules {
  const step = spec.steps[index]!;
  const daily = step.dailyLoss !== undefined ? step.dailyLoss : spec.dailyLoss;
  const max = step.maxLoss ?? spec.maxLoss;
  return {
    daily: resolveDailyLoss(daily, spec.accountSize),
    max: resolveMaxLoss(max, spec.accountSize),
  };
}

/** Effective rules for the funded account (inherits challenge rules unless overridden). */
export function resolveFundedRules(spec: ChallengeSpec): ResolvedRules {
  const daily = spec.funded.dailyLoss !== undefined ? spec.funded.dailyLoss : spec.dailyLoss;
  const max = spec.funded.maxLoss ?? spec.maxLoss;
  return {
    daily: resolveDailyLoss(daily, spec.accountSize),
    max: resolveMaxLoss(max, spec.accountSize),
  };
}

/**
 * Tracks loss floors over one account's life (one evaluation step, or one
 * funded stretch) and reports breaches. Equity at or below a floor is a
 * breach - firms treat touching the limit as a violation.
 */
export class RuleState {
  private readonly rules: ResolvedRules;
  private readonly epsilon: number;

  /** Reference peak for trailing modes (trade-close equity or EOD balance). */
  private peak: number;
  /** Current max-loss floor (equity level). Monotonically non-decreasing. */
  private maxFloor: number;
  /** Today's daily-loss floor; -Infinity when no daily rule applies. */
  private dailyFloor = Number.NEGATIVE_INFINITY;

  constructor(rules: ResolvedRules, initialBalance: number) {
    this.rules = rules;
    this.epsilon = initialBalance * 1e-9;
    this.peak = initialBalance;
    this.maxFloor = initialBalance - rules.max.amount;
  }

  /** The current max-loss floor as an equity level (for tracing and payout caps). */
  get currentMaxFloor(): number {
    return this.maxFloor;
  }

  /** Daily-loss boundary enforced for the current day; null when no daily rule applies. */
  get currentDailyFloor(): number | null {
    return this.dailyFloor === Number.NEGATIVE_INFINITY ? null : this.dailyFloor;
  }

  private ratchet(): void {
    let floor = this.peak - this.rules.max.amount;
    const cap = this.rules.max.lockCap;
    if (cap !== null && floor > cap) floor = cap; // the threshold freezes here
    if (floor > this.maxFloor) this.maxFloor = floor;
  }

  /** Set the daily anchor from the day's starting balance (= prior day close). */
  startDay(dayStartBalance: number): void {
    const daily = this.rules.daily;
    if (daily === null) {
      this.dailyFloor = Number.NEGATIVE_INFINITY;
      return;
    }
    const limit = daily.fixedLimit ?? daily.anchorFraction! * dayStartBalance;
    this.dailyFloor = dayStartBalance - limit;
  }

  /**
   * Observe a trade-close equity level. Returns the breach reason, or null.
   * When both floors are crossed by the same trade, the higher floor was
   * crossed first as equity fell, so it gets the attribution.
   */
  onTradeClose(balance: number): FailReason | null {
    if (this.rules.max.trailing === "intraday" && balance > this.peak) {
      this.peak = balance;
      this.ratchet();
    }

    const daily = this.rules.daily;
    const dailyBreached = daily !== null && !daily.endOfDayOnly && balance <= this.dailyFloor + this.epsilon;
    const maxBreached = balance <= this.maxFloor + this.epsilon;

    if (dailyBreached && maxBreached) {
      return this.dailyFloor >= this.maxFloor ? "daily-loss" : "max-loss";
    }
    if (dailyBreached) return "daily-loss";
    if (maxBreached) return "max-loss";
    return null;
  }

  /**
   * Observe the day's closing balance: ratchets EOD-trailing floors and runs
   * end-of-day daily-loss checks. Returns the breach reason, or null.
   */
  onDayClose(balance: number): FailReason | null {
    if (this.rules.max.trailing === "eod" && balance > this.peak) {
      this.peak = balance;
      this.ratchet();
    }

    const daily = this.rules.daily;
    if (daily !== null && daily.endOfDayOnly && balance <= this.dailyFloor + this.epsilon) {
      return "daily-loss";
    }
    // A floor that just ratcheted cannot exceed the balance that set the peak,
    // so no max-loss re-check is needed here.
    return null;
  }
}
