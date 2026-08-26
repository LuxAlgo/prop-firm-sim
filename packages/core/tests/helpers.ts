import type { ChallengeSpecInput, RiskSizing } from "../src/index.js";
import {
  Rng,
  ScriptedSource,
  simulateStep,
  resolveDailyLoss,
  resolveMaxLoss,
  type DrawdownTracker,
  type ResolvedStep,
  type StepOutcome,
} from "../src/index.js";
import { DailyLossRuleSchema, MaxLossRuleSchema } from "../src/spec/challenge.js";
import type { z } from "zod";

export const ACCOUNT = 100_000;

/** $1,000 risked per 1R, so scripted R values map 1:1 to thousands of dollars. */
export const FIXED_1K: RiskSizing = { mode: "fixed-amount", value: 1_000 };

/**
 * Run one evaluation step over a hand-written script of daily R outcomes.
 * Rules are parsed through the real zod schemas so defaults apply exactly as
 * they would for a dataset entry.
 */
export function runScriptedStep(params: {
  days: readonly (readonly number[])[];
  maxLoss: z.input<typeof MaxLossRuleSchema>;
  dailyLoss?: z.input<typeof DailyLossRuleSchema> | null;
  targetBalance?: number;
  minTradingDays?: number;
  maxDays?: number | null;
  /** Consistency rule: max best-day share of profit, in percent units. */
  consistencyPct?: number;
  sizing?: RiskSizing;
  unlimitedCap?: number;
}): StepOutcome {
  const step: ResolvedStep = {
    targetBalance: params.targetBalance ?? Number.POSITIVE_INFINITY,
    minTradingDays: params.minTradingDays ?? 0,
    maxDays: params.maxDays ?? null,
    consistencyFraction: params.consistencyPct !== undefined ? params.consistencyPct / 100 : null,
    rules: {
      daily: resolveDailyLoss(
        params.dailyLoss === undefined || params.dailyLoss === null
          ? null
          : DailyLossRuleSchema.parse(params.dailyLoss),
        ACCOUNT,
      ),
      max: resolveMaxLoss(MaxLossRuleSchema.parse(params.maxLoss), ACCOUNT),
    },
  };
  const source = new ScriptedSource(params.days);
  const rng = new Rng(1); // ScriptedSource never consumes randomness
  source.reset(rng);
  const dd: DrawdownTracker = { peak: ACCOUNT, maxDrawdown: 0 };
  return simulateStep(step, source, params.sizing ?? FIXED_1K, rng, ACCOUNT, params.unlimitedCap ?? 50, dd);
}

/** A plain 100k one-step challenge for statistical tests; override freely. */
export function baseSpec(overrides: Partial<ChallengeSpecInput> = {}): ChallengeSpecInput {
  return {
    challengeId: "test-100k",
    name: "Test 100K",
    accountSize: ACCOUNT,
    steps: [{ profitTargetPct: 8, minTradingDays: 0 }],
    dailyLoss: { pct: 5 },
    maxLoss: { pct: 10, mode: "static-initial" },
    fees: { price: 500 },
    funded: { profitSplitPct: 80, payoutFrequency: "biweekly", firstPayoutMinDays: 14 },
    ...overrides,
  };
}
