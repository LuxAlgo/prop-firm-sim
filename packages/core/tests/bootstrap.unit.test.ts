import { describe, expect, it } from "vitest";
import { Rng, StationaryBootstrapSampler, parseRSeries, simulate } from "../src/index.js";
import type { TraderProfileInput } from "../src/index.js";
import { baseSpec } from "./helpers.js";

/** 6 repeats of [5 wins, 5 losses]: a maximally streaky 50% win-rate series. */
const streakySeries = Array.from({ length: 60 }, (_, i) => (i % 10 < 5 ? 1 : -1));

function lag1Autocorrelation(values: number[]): number {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    den += (values[i]! - mean) ** 2;
    if (i > 0) num += (values[i]! - mean) * (values[i - 1]! - mean);
  }
  return num / den;
}

describe("stationary block bootstrap", () => {
  it("only ever emits values from the input series", () => {
    const sampler = new StationaryBootstrapSampler([1.5, -1, 0.25], 5);
    const rng = new Rng(1);
    for (let i = 0; i < 500; i++) {
      expect([1.5, -1, 0.25]).toContain(sampler.next(rng));
    }
  });

  it("preserves the streakiness of the input where i.i.d. resampling destroys it", () => {
    const rng = new Rng(21);
    const block = new StationaryBootstrapSampler(streakySeries, 5);
    const blockDraws = Array.from({ length: 5000 }, () => block.next(rng));

    const rng2 = new Rng(21);
    const iid = new StationaryBootstrapSampler(streakySeries, 1); // mean block length 1 ⇒ i.i.d.
    const iidDraws = Array.from({ length: 5000 }, () => iid.next(rng2));

    // Theory: adjacent draws stay in-series with prob 1 - 1/L = 0.8, and the
    // 5-5 square wave has lag-1 autocorrelation 0.6, so ≈ 0.8 × 0.6 = 0.48.
    expect(lag1Autocorrelation(blockDraws)).toBeGreaterThan(0.4);
    expect(Math.abs(lag1Autocorrelation(iidDraws))).toBeLessThan(0.1);
  });

  it("with a tight loss limit and a distant target, streaky losses fail far more often than the i.i.d. assumption predicts - the direction every naive calculator gets wrong", () => {
    // Max loss 4% with 1% risked per trade: one clustered run of five -1R
    // losses is fatal, while the same losses scattered i.i.d. usually are not.
    // The target (8%) is too far to grab inside a single win-run.
    const profile = (blockMeanLength: number): TraderProfileInput => ({
      kind: "bootstrap",
      rSeries: streakySeries,
      blockMeanLength,
      tradesPerDay: 5,
      risk: { mode: "percent-of-initial", value: 1 },
    });
    const opts = { paths: 6000, seed: 99, simulateFunded: false } as const;

    const spec = baseSpec({
      steps: [{ profitTargetPct: 8 }],
      dailyLoss: null,
      maxLoss: { pct: 4, mode: "static-initial" },
    });
    const streaky = simulate(spec, profile(5), opts);
    const iid = simulate(spec, profile(1), opts);
    expect(streaky.perAttempt.passProbability).toBeLessThan(iid.perAttempt.passProbability - 0.03);
    expect(streaky.assumptions.flags.map((f) => f.id)).toContain("bootstrap-resampling");
  });
});

describe("R-series parsing", () => {
  it("accepts CSV, whitespace and R-suffixed values", () => {
    expect(parseRSeries("1.8R, -1, 2.5\n-0.5r 3")).toEqual([1.8, -1, 2.5, -0.5, 3]);
  });

  it("accepts a JSON array", () => {
    expect(parseRSeries("[1, -1, 2.25]")).toEqual([1, -1, 2.25]);
  });

  it("rejects garbage with the offending token named", () => {
    expect(() => parseRSeries("1.5, banana, 2")).toThrow(/banana/);
  });

  it("returns an empty array for empty input", () => {
    expect(parseRSeries("  \n ")).toEqual([]);
  });
});
