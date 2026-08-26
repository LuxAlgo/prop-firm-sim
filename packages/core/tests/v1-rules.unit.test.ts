import { describe, expect, it } from "vitest";
import { ChallengeSpecSchema, Rng, ScriptedSource, simulate, simulateFunded } from "../src/index.js";
import type { ChallengeSpecInput, TraderProfileInput } from "../src/index.js";
import { ACCOUNT, FIXED_1K, baseSpec, runScriptedStep } from "./helpers.js";

/*
  v1.0 rule semantics, hand-computed like the rest of the micro-cases:
  consistency rules, payout gating (winning days, buffers, caps, the loss
  floor), locking EOD trails and lock offsets, and the path-tracing API.
  $100k account, $1,000 per 1R.
*/

describe("consistency rules (simulated)", () => {
  it("one outsized day forces the trader to keep trading until the best-day share complies", () => {
    // Target +$3k with a 50% consistency rule. Day 1's +3R hits the target but
    // is 100% of profit; day 2 (+1R) still leaves the best day at 75%; day 3
    // (+2R) reaches $6k profit, exactly 50% - pass on day 3.
    const out = runScriptedStep({
      days: [[+3], [+1], [+2]],
      maxLoss: { pct: 20, mode: "static-initial" },
      targetBalance: ACCOUNT + 3_000,
      consistencyPct: 50,
    });
    expect(out.passed).toBe(true);
    expect(out.daysUsed).toBe(3);
    expect(out.endBalance).toBe(106_000);

    // Without the rule the same script passes on day 1.
    const without = runScriptedStep({
      days: [[+3], [+1], [+2]],
      maxLoss: { pct: 20, mode: "static-initial" },
      targetBalance: ACCOUNT + 3_000,
    });
    expect(without.passed).toBe(true);
    expect(without.daysUsed).toBe(1);
  });

  it("a consistency rule can turn a pass into a blowup by forcing more days at risk", () => {
    // Trailing $3k floor. Day 1: +3R hits the target (a no-rule trader stops
    // and passes); the 50% rule forces day 2, whose -3.5R breaches the floor
    // that ratcheted to $100k.
    const withRule = runScriptedStep({
      days: [[+3], [-3.5]],
      maxLoss: { amount: 3_000, mode: "trailing-intraday-unrealized" },
      targetBalance: ACCOUNT + 3_000,
      consistencyPct: 50,
    });
    expect(withRule.passed).toBe(false);
    expect(withRule.failReason).toBe("max-loss");
    expect(withRule.daysUsed).toBe(2);

    const withoutRule = runScriptedStep({
      days: [[+3], [-3.5]],
      maxLoss: { amount: 3_000, mode: "trailing-intraday-unrealized" },
      targetBalance: ACCOUNT + 3_000,
    });
    expect(withoutRule.passed).toBe(true);
    expect(withoutRule.daysUsed).toBe(1);
  });
});

describe("locking trails and lock offsets", () => {
  it("an EOD trail that locks at the starting balance stops ratcheting there", () => {
    // $2k EOD trail, locksAtInitial. Day 1 closes +4k: the unlocked floor
    // would be $102k, the locked floor freezes at $100k. Day 2's dip to
    // $100.1k survives; day 3's $99.9k breaches.
    const locked = runScriptedStep({
      days: [[+4], [-3.9], [-0.2]],
      maxLoss: { amount: 2_000, mode: "trailing-realized-eod", locksAtInitial: true },
    });
    expect(locked.failReason).toBe("max-loss");
    expect(locked.daysUsed).toBe(3);

    const unlocked = runScriptedStep({
      days: [[+4], [-3.9], [-0.2]],
      maxLoss: { amount: 2_000, mode: "trailing-realized-eod" },
    });
    expect(unlocked.failReason).toBe("max-loss");
    expect(unlocked.daysUsed).toBe(2);
  });

  it("a lock offset freezes the floor above the starting balance (start + $100 style)", () => {
    // Intraday $2k trail locking at initial + $100 = $100,100. Day 2's
    // $100.15k survives; day 3's $100.05k is under the offset floor.
    const withOffset = runScriptedStep({
      days: [[+4], [-3.85], [-0.1]],
      maxLoss: { amount: 2_000, mode: "trailing-locks-at-initial", lockOffsetAmount: 100 },
    });
    expect(withOffset.failReason).toBe("max-loss");
    expect(withOffset.daysUsed).toBe(3);

    const withoutOffset = runScriptedStep({
      days: [[+4], [-3.85], [-0.1]],
      maxLoss: { amount: 2_000, mode: "trailing-locks-at-initial" },
      maxDays: 3,
    });
    expect(withoutOffset.failReason).toBe("time-limit"); // survives both dips
  });
});

function fundedSpec(overrides: Record<string, unknown> = {}) {
  return ChallengeSpecSchema.parse({
    ...baseSpec(),
    dailyLoss: null,
    funded: {
      profitSplitPct: 90,
      payoutFrequency: "weekly",
      firstPayoutMinDays: 0,
      ...overrides,
    },
  });
}

function runFunded(
  spec: ReturnType<typeof fundedSpec>,
  days: readonly (readonly number[])[],
  horizon: number,
) {
  const source = new ScriptedSource(days);
  const rng = new Rng(1);
  source.reset(rng);
  return simulateFunded(spec, source, FIXED_1K, rng, horizon);
}

describe("funded payout gating (simulated)", () => {
  it("a payout requires the winning days and pays only the profit above the buffer", () => {
    // Weekly cadence, 3 winning days of $150+, $2k buffer, 90% split.
    // Day P&Ls: +1000, +500, +100 (not a winning day), +500, 0.
    // Day 5 payout: profit $2,100 → withdrawable $100 → trader gets $90.
    const spec = fundedSpec({
      payoutRules: { minWinningDays: 3, winningDayMinProfit: 150, bufferAmount: 2_000 },
    });
    const out = runFunded(spec, [[+1], [+0.5], [+0.1], [+0.5], []], 5);
    expect(out.blown).toBe(false);
    expect(out.payoutEvents).toBe(1);
    expect(out.firstPayoutDay).toBe(5);
    expect(out.payoutTotal).toBeCloseTo(90, 6);
  });

  it("missing the winning-day minimum blocks the payout entirely", () => {
    const spec = fundedSpec({
      payoutRules: { minWinningDays: 4, winningDayMinProfit: 150, bufferAmount: 2_000 },
    });
    const out = runFunded(spec, [[+1], [+0.5], [+0.1], [+0.5], []], 5);
    expect(out.payoutEvents).toBe(0);
    expect(out.firstPayoutDay).toBeNull();
    expect(out.payoutTotal).toBe(0);
  });

  it("per-payout caps limit each withdrawal", () => {
    // Profit $2,100 at day 5; a 50%-of-profit cap allows $1,050 → $945 at 90%.
    const spec = fundedSpec({ payoutRules: { maxPayoutPctOfProfit: 50 } });
    const out = runFunded(spec, [[+1], [+0.5], [+0.1], [+0.5], []], 5);
    expect(out.payoutTotal).toBeCloseTo(945, 6);
  });

  it("a withdrawal can never take the balance below the loss floor", () => {
    // Locked trail: floor sits at the initial balance. Withdrawing the full
    // +$3k profit would land ON the floor, so the payout stops just above it.
    const spec = fundedSpec({
      profitSplitPct: 100,
      payoutFrequency: "on-demand",
      maxLoss: { amount: 2_000, mode: "trailing-locks-at-initial" },
    });
    const out = runFunded(spec, [[+3], []], 2);
    expect(out.blown).toBe(false);
    expect(out.payoutEvents).toBe(1);
    expect(out.payoutTotal).toBeGreaterThan(2_999);
    expect(out.payoutTotal).toBeLessThan(3_000);
  });

  it("the funded consistency gate delays a payout until the window's best day complies", () => {
    // 50% funded consistency. Window one: +2k in one day = 100% of window
    // profit → day-5 payout blocked. Window continues: +2k more by day 10
    // (spread), best day 2k ≤ 50% of 4k → payout at day 10.
    const spec = fundedSpec({
      payoutRules: { consistencyMaxBestDayPct: 50 },
    });
    const out = runFunded(spec, [[+2], [], [], [], [], [+1], [+1], [], [], []], 10);
    expect(out.payoutEvents).toBe(1);
    expect(out.firstPayoutDay).toBe(10);
    expect(out.payoutTotal).toBeCloseTo(4_000 * 0.9, 6);
  });
});

describe("path tracing", () => {
  const trader: TraderProfileInput = {
    kind: "parametric",
    winRate: 0.45,
    avgWinR: 1.5,
    avgLossR: 1,
    tradesPerDay: 5,
    risk: { mode: "percent-of-initial", value: 1 },
  };

  it("tracing records day-by-day equity and the moving floor without changing a single number", () => {
    const spec: ChallengeSpecInput = baseSpec({
      dailyLoss: null,
      maxLoss: { pct: 6, mode: "trailing-intraday-unrealized" },
    });
    const plain = simulate(spec, trader, { paths: 400, seed: 9 });
    const traced = simulate(spec, trader, { paths: 400, seed: 9, tracePaths: 8 });

    expect(traced.trace).toBeDefined();
    expect(traced.trace!.challenge).toHaveLength(8);
    // Identical up to the echoed tracePaths option - tracing is pure observation.
    const { trace, ...tracedRest } = traced;
    const normalize = (r: object) =>
      JSON.stringify(r, (key, value) => (key === "tracePaths" ? undefined : value));
    expect(normalize(tracedRest)).toBe(normalize(plain));

    for (const path of trace!.challenge) {
      expect(path.equity.length).toBeGreaterThan(0);
      expect(path.floor.length).toBe(path.equity.length);
      // Trailing floors only ever ratchet upward.
      for (let i = 1; i < path.floor.length; i++) {
        expect(path.floor[i]!).toBeGreaterThanOrEqual(path.floor[i - 1]!);
      }
      expect(["passed", "daily-loss", "max-loss", "time-limit", "abandoned"]).toContain(path.outcome);
    }
    for (const path of trace!.funded) {
      expect(["survived", "blown"]).toContain(path.outcome);
      expect(path.equity.length).toBeGreaterThan(0);
    }
  });

  it("challenge traces mark where each completed step ended", () => {
    const spec = baseSpec({
      steps: [{ profitTargetPct: 2 }, { profitTargetPct: 2 }],
      dailyLoss: null,
      maxLoss: { pct: 20, mode: "static-initial" },
    });
    const res = simulate(spec, trader, { paths: 200, seed: 3, tracePaths: 20 });
    const passed = res.trace!.challenge.find((p) => p.outcome === "passed");
    expect(passed).toBeDefined();
    expect(passed!.stepBoundaries).toHaveLength(2);
    expect(passed!.stepBoundaries!.at(-1)).toBe(passed!.equity.length);
  });
});
