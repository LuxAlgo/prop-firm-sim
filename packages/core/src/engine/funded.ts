import type { ChallengeSpec } from "../spec/challenge.js";
import type { RiskSizing } from "../spec/trader.js";
import type { Rng } from "./rng.js";
import type { TradeSource } from "./trades.js";
import { RuleState, resolveFundedRules } from "./rules.js";
import { riskAmount, type DayRecorder } from "./attempt.js";

/** Payout cadence in trading days (5 trading days ≈ 1 calendar week). */
const PAYOUT_INTERVAL_TRADING_DAYS = {
  weekly: 5,
  biweekly: 10,
  monthly: 21,
  "on-demand": 1,
} as const;

export interface FundedOutcome {
  /** Trader-share payouts collected over the horizon. */
  payoutTotal: number;
  payoutEvents: number;
  /** Whether the funded account breached its loss rules within the horizon. */
  blown: boolean;
  /** Funded trading day of the first payout, or null if none happened. */
  firstPayoutDay: number | null;
}

/**
 * Simulate the funded stage over a fixed horizon of trading days with the
 * same trader profile, against the funded account's own loss rules.
 *
 * Withdrawal model (flagged in every result): on each eligible payout day the
 * trader withdraws the maximum the rules allow - profit above the buffer,
 * capped per payout, never below the current loss floor - and receives their
 * split of it. Balances and loss floors carry across payouts; nothing resets.
 * Payout gating (winning-day minimums, funded consistency per payout window)
 * is enforced when the entry declares `payoutRules`. A blown account keeps
 * payouts already collected.
 */
export function simulateFunded(
  spec: ChallengeSpec,
  source: TradeSource,
  sizing: RiskSizing,
  rng: Rng,
  horizonTradingDays: number,
  recorder?: DayRecorder,
): FundedOutcome {
  const A = spec.accountSize;
  const rules = resolveFundedRules(spec);
  const splitFraction = spec.funded.profitSplitPct / 100;
  const payoutInterval = PAYOUT_INTERVAL_TRADING_DAYS[spec.funded.payoutFrequency];
  // Calendar-day minimum converted at 5 trading days per 7 calendar days.
  const firstPayoutMinTradingDays = Math.ceil((spec.funded.firstPayoutMinDays * 5) / 7);
  const epsilon = A * 1e-9;

  const pr = spec.funded.payoutRules;
  const minWinningDays = pr?.minWinningDays ?? 0;
  const winningDayMinProfit = pr?.winningDayMinProfit ?? 0;
  const maxPayoutFraction = pr?.maxPayoutPctOfProfit !== undefined ? pr.maxPayoutPctOfProfit / 100 : null;
  const maxPayoutAmount = pr?.maxPayoutAmount ?? null;
  const bufferAmount = pr?.bufferAmount ?? 0;
  const consistencyFraction =
    pr?.consistencyMaxBestDayPct !== undefined ? pr.consistencyMaxBestDayPct / 100 : null;

  let balance = A;
  const state = new RuleState(rules, A);
  let payoutTotal = 0;
  let payoutEvents = 0;
  let firstPayoutDay: number | null = null;

  // Per-payout-window tracking.
  let windowStartBalance = A;
  let winningDays = 0;
  let bestDayInWindow = 0;

  for (let day = 1; day <= horizonTradingDays; day++) {
    state.startDay(balance);
    const dayStartBalance = balance;

    const trades = source.nextDayTradeCount(rng);
    for (let t = 0; t < trades; t++) {
      const risk = riskAmount(sizing, balance, A);
      balance += source.nextTradeR(rng) * risk;
      const breach = state.onTradeClose(balance);
      if (breach !== null) {
        recorder?.day(balance, state.currentMaxFloor, state.currentDailyFloor);
        return { payoutTotal, payoutEvents, blown: true, firstPayoutDay };
      }
    }

    const breach = state.onDayClose(balance);
    if (breach !== null) {
      recorder?.day(balance, state.currentMaxFloor, state.currentDailyFloor);
      return { payoutTotal, payoutEvents, blown: true, firstPayoutDay };
    }

    const dayPnl = balance - dayStartBalance;
    if (dayPnl > bestDayInWindow) bestDayInWindow = dayPnl;
    if (dayPnl > 0 && dayPnl >= winningDayMinProfit) winningDays++;

    if (day >= firstPayoutMinTradingDays && day % payoutInterval === 0) {
      const profit = balance - A;
      const windowProfit = balance - windowStartBalance;
      const consistencyOk =
        consistencyFraction === null ||
        (windowProfit > 0 && bestDayInWindow <= consistencyFraction * windowProfit + epsilon);

      if (profit > bufferAmount + epsilon && winningDays >= minWinningDays && consistencyOk) {
        let withdrawal = profit - bufferAmount;
        if (maxPayoutFraction !== null) withdrawal = Math.min(withdrawal, maxPayoutFraction * profit);
        if (maxPayoutAmount !== null) withdrawal = Math.min(withdrawal, maxPayoutAmount);
        // A withdrawal may never take the balance to or below the loss floor.
        withdrawal = Math.min(withdrawal, balance - state.currentMaxFloor - epsilon);

        if (withdrawal > epsilon) {
          payoutTotal += withdrawal * splitFraction;
          payoutEvents++;
          firstPayoutDay ??= day;
          balance -= withdrawal;
          windowStartBalance = balance;
          winningDays = 0;
          bestDayInWindow = 0;
        }
      }
    }

    recorder?.day(balance, state.currentMaxFloor, state.currentDailyFloor);
  }

  return { payoutTotal, payoutEvents, blown: false, firstPayoutDay };
}
