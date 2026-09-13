import { describe, expect, it } from "vitest";
import {
  ChallengeSpecSchema,
  Rng,
  ScriptedSource,
  resolveSteps,
  simulateStep,
  simulateFunded,
  simulate,
  type ChallengeSpecInput,
} from "../src/index.js";
import { TraceRecorder } from "../src/engine/trace.js";
import { ACCOUNT, FIXED_1K, baseSpec } from "./helpers.js";

function stepTrace(dailyLoss: ChallengeSpecInput["dailyLoss"], days: number[][]) {
  const spec = ChallengeSpecSchema.parse(
    baseSpec({
      steps: [{ profitTargetPct: 50, maxDays: days.length }],
      dailyLoss,
      maxLoss: { pct: 50, mode: "static-initial" },
    }),
  );
  const trace = new TraceRecorder();
  const result = simulateStep(
    resolveSteps(spec)[0]!,
    new ScriptedSource(days),
    FIXED_1K,
    new Rng(1),
    ACCOUNT,
    50,
    { peak: ACCOUNT, maxDrawdown: 0 },
    trace,
  );
  return { result, trace };
}

describe("daily-loss trace boundaries", () => {
  it.each([
    [{ pct: 5, limitBasis: "initial-balance" }, [95000, 105000]],
    [{ pct: 5, limitBasis: "anchor" }, [95000, 104500]],
    [{ amount: 2000 }, [98000, 108000]],
    [null, [null, null]],
  ] as const)("records the day's enforced boundary for %j", (rule, expected) => {
    const { trace } = stepTrace(rule, [[10], [1]]);
    expect(trace.equity).toEqual([110000, 111000]);
    expect(trace.dailyFloor).toEqual(expected);
    expect(trace.floor).toHaveLength(trace.dailyFloor.length);
  });

  it.each(["intraday", "end-of-day"] as const)("retains the boundary on a %s breach day", (evaluation) => {
    const { result, trace } = stepTrace({ amount: 2000, evaluation }, [[1], [-2]]);
    expect(result.failReason).toBe("daily-loss");
    expect(trace.equity).toEqual([101000, 99000]);
    expect(trace.dailyFloor).toEqual([98000, 99000]);
  });

  it("uses the funded override and anchors the next day after a payout", () => {
    const spec = ChallengeSpecSchema.parse(
      baseSpec({
        funded: {
          profitSplitPct: 80,
          payoutFrequency: "on-demand",
          firstPayoutMinDays: 0,
          dailyLoss: { amount: 2000 },
        },
      }),
    );
    const trace = new TraceRecorder();
    const result = simulateFunded(spec, new ScriptedSource([[10], [-2]]), FIXED_1K, new Rng(1), 2, trace);
    expect(result.payoutEvents).toBe(1);
    expect(result.blown).toBe(true);
    expect(trace.equity).toEqual([100000, 98000]);
    expect(trace.dailyFloor).toEqual([98000, 98000]);
  });

  it("exports aligned traces through step resets, risk-free days and funded overrides without changing outcomes", () => {
    const spec = baseSpec({
      steps: [
        { profitTargetPct: 1, minTradingDays: 2, dailyLoss: { amount: 2000 } },
        { profitTargetPct: 1, minTradingDays: 2, dailyLoss: null },
      ],
      funded: {
        profitSplitPct: 80,
        payoutFrequency: "biweekly",
        firstPayoutMinDays: 14,
        dailyLoss: { amount: 3000 },
      },
    });
    const profile = {
      kind: "parametric" as const,
      winRate: 1,
      avgWinR: 1,
      avgLossR: 1,
      tradesPerDay: 1,
      tradesPerDayModel: "fixed" as const,
      risk: FIXED_1K,
    };
    const options = { paths: 100, seed: 42, fundedHorizonDays: 2 };
    const traced = simulate(spec, profile, { ...options, tracePaths: 2 });
    const plain = simulate(spec, profile, options);
    for (const path of traced.trace!.challenge) {
      expect(path.stepBoundaries).toEqual([2, 4]);
      expect(path.dailyFloor).toEqual([98000, 99000, null, null]);
      expect(path.dailyFloor).toHaveLength(path.equity.length);
    }
    for (const path of traced.trace!.funded) {
      expect(path.dailyFloor).toEqual([97000, 98000]);
      expect(path.dailyFloor).toHaveLength(path.equity.length);
    }
    expect(traced.trace!.funded).toHaveLength(2);
    const { trace, ...rest } = traced;
    const normalize = (value: unknown) =>
      JSON.stringify(value, (key, v) => (key === "tracePaths" ? undefined : v));
    expect(normalize(rest)).toBe(normalize(plain));
    expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
    expect(simulate(spec, profile, { ...options, tracePaths: 2 })).toEqual(traced);
  });
});
