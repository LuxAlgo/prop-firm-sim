import { describe, expect, it } from "vitest";
import { optimalRisk, sensitivity, simulate, wilson95 } from "../src/index.js";
import type { TraderProfileInput } from "../src/index.js";
import { baseSpec } from "./helpers.js";

const marginalTrader: TraderProfileInput = {
  kind: "parametric",
  winRate: 0.45,
  avgWinR: 1.5,
  avgLossR: 1,
  tradesPerDay: 5,
  risk: { mode: "percent-of-initial", value: 1 },
};

const opts = { paths: 4000, seed: 7 } as const;

describe("statistical sanity", () => {
  it("a tiny profit target with room to breathe is passed almost surely", () => {
    const res = simulate(
      baseSpec({
        steps: [{ profitTargetPct: 0.5 }],
        dailyLoss: null,
        maxLoss: { pct: 20, mode: "static-initial" },
      }),
      marginalTrader,
      opts,
    );
    expect(res.perAttempt.passProbability).toBeGreaterThan(0.97);
  });

  it("a trailing max loss smaller than a single losing trade fails almost surely", () => {
    // 0.1% trailing max loss with 1% risked per trade: any -1R print from the
    // running peak is fatal, so passing needs six straight wins - about
    // 0.45^6 ≈ 0.8%. (A static floor would not shrink to zero the same way:
    // early wins build a cushion above it.)
    const res = simulate(
      baseSpec({ dailyLoss: null, maxLoss: { pct: 0.1, mode: "trailing-intraday-unrealized" } }),
      marginalTrader,
      opts,
    );
    expect(res.perAttempt.passProbability).toBeLessThan(0.02);
  });

  it("stricter drawdown semantics can only lower the pass probability: intraday-trailing ≤ locks-at-initial ≤ static, and intraday ≤ end-of-day ≤ static", () => {
    const at = (mode: string) =>
      simulate(baseSpec({ dailyLoss: null, maxLoss: { pct: 4, mode: mode as never } }), marginalTrader, opts)
        .perAttempt.passProbability;

    const staticP = at("static-initial");
    const eod = at("trailing-realized-eod");
    const intraday = at("trailing-intraday-unrealized");
    const locks = at("trailing-locks-at-initial");
    const slack = 0.02; // Monte Carlo noise guard; the ordering is structural

    expect(intraday).toBeLessThanOrEqual(locks + slack);
    expect(locks).toBeLessThanOrEqual(staticP + slack);
    expect(intraday).toBeLessThanOrEqual(eod + slack);
    expect(eod).toBeLessThanOrEqual(staticP + slack);
    // and the gaps are real, not noise
    expect(staticP - intraday).toBeGreaterThan(0.05);
  });

  it("raising the fee lowers EV by exactly the extra fee times expected attempts (fees never change the trading)", () => {
    const cheap = simulate(baseSpec({ fees: { price: 500 } }), marginalTrader, opts);
    const pricey = simulate(baseSpec({ fees: { price: 600 } }), marginalTrader, opts);
    expect(pricey.journey.attempts.mean).toBe(cheap.journey.attempts.mean);
    expect(cheap.ev.evTotal - pricey.ev.evTotal).toBeCloseTo(100 * cheap.journey.attempts.mean, 6);
  });

  it("a refundable fee shows up as lower cost for funded paths", () => {
    const noRefund = simulate(baseSpec(), marginalTrader, opts);
    const refund = simulate(baseSpec({ fees: { price: 500, refundableOnPass: true } }), marginalTrader, opts);
    expect(refund.journey.costGivenFunded!.mean).toBeCloseTo(noRefund.journey.costGivenFunded!.mean - 500, 6);
  });
});

describe("determinism", () => {
  it("the same seed reproduces a byte-identical result - permalinks depend on this", () => {
    const a = simulate(baseSpec(), marginalTrader, { paths: 1000, seed: "share-me" });
    const b = simulate(baseSpec(), marginalTrader, { paths: 1000, seed: "share-me" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("a different seed produces a different sample", () => {
    const a = simulate(baseSpec(), marginalTrader, { paths: 1000, seed: 1 });
    const b = simulate(baseSpec(), marginalTrader, { paths: 1000, seed: 2 });
    expect(a.ev.evTotal).not.toBe(b.ev.evTotal);
  });
});

describe("confidence intervals", () => {
  it("the Wilson interval matches the textbook value and always contains the point estimate", () => {
    const ci = wilson95(50, 100);
    expect(ci.low).toBeCloseTo(0.4038, 3);
    expect(ci.high).toBeCloseTo(0.5962, 3);
    expect(wilson95(0, 0)).toEqual({ low: 0, high: 1 });
    const res = simulate(baseSpec(), marginalTrader, opts);
    expect(res.perAttempt.passProbabilityCi.low).toBeLessThanOrEqual(res.perAttempt.passProbability);
    expect(res.perAttempt.passProbabilityCi.high).toBeGreaterThanOrEqual(res.perAttempt.passProbability);
  });
});

describe("analysis layer", () => {
  it("the risk that maximizes pass probability is lower than the risk that maximizes EV - the divergence the sweep exists to show", () => {
    const sweep = optimalRisk(
      baseSpec(),
      marginalTrader,
      { paths: 1500, seed: 3 },
      { min: 0.25, max: 3, step: 0.25 },
    );
    expect(sweep.points).toHaveLength(12);
    expect(sweep.diverges).toBe(true);
    expect(sweep.bestByEv.risk).toBeGreaterThan(sweep.bestByPassProbability.risk);
  });

  it("pass probability rises with win rate, and the sensitivity gradient says so", () => {
    const sens = sensitivity(baseSpec(), marginalTrader, { paths: 1500, seed: 3 });
    expect(sens.passProbabilityGradientPerPoint).not.toBeNull();
    expect(sens.passProbabilityGradientPerPoint!).toBeGreaterThan(0);
    const sorted = [...sens.points].sort((a, b) => a.offsetPct - b.offsetPct);
    expect(sorted.at(-1)!.perAttemptPassProbability).toBeGreaterThan(sorted[0]!.perAttemptPassProbability);
  });

  it("sensitivity refuses a bootstrap profile - there is no win-rate dial to turn", () => {
    const bootstrap: TraderProfileInput = {
      kind: "bootstrap",
      rSeries: [1, -1, 2, -1, 1.5, -1, 1, -1, 2, -1],
      tradesPerDay: 3,
      risk: { mode: "percent-of-initial", value: 1 },
    };
    expect(() => sensitivity(baseSpec(), bootstrap)).toThrow(/parametric/);
  });
});

describe("spec validation", () => {
  it("a rule must set exactly one of pct or amount", () => {
    expect(() =>
      simulate(
        baseSpec({ maxLoss: { pct: 10, amount: 5000, mode: "static-initial" } as never }),
        marginalTrader,
        {
          paths: 100,
        },
      ),
    ).toThrow();
    expect(() =>
      simulate(baseSpec({ maxLoss: { mode: "static-initial" } as never }), marginalTrader, { paths: 100 }),
    ).toThrow();
  });

  it("every result echoes its inputs, flags and disclaimer - results are self-describing", () => {
    const res = simulate(baseSpec(), marginalTrader, { paths: 200, seed: 5 });
    expect(res.assumptions.spec.accountSize).toBe(100_000);
    expect(res.assumptions.options.paths).toBe(200);
    expect(res.assumptions.disclaimer).toMatch(/not prediction/i);
    expect(res.assumptions.flags.map((f) => f.id)).toContain("trades-resolve-same-day");
    expect(res.assumptions.flags.map((f) => f.id)).toContain("attempts-iid");
  });

  it("dataset-declared unsimulated rules surface in the result flags", () => {
    const res = simulate(baseSpec({ flagsNotSimulated: ["consistency-rule-40pct"] }), marginalTrader, {
      paths: 200,
    });
    const flag = res.assumptions.flags.find((f) => f.id === "consistency-rule-40pct");
    expect(flag).toBeDefined();
    expect(flag!.source).toBe("dataset");
  });
});
