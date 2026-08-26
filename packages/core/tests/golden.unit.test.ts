import { describe, expect, it } from "vitest";
import { simulate } from "../src/index.js";
import { baseSpec } from "./helpers.js";

/*
  Engine golden: a pinned snapshot of a full result for a fixed seed. Any
  engine change that moves these numbers must update the snapshot and justify
  itself in the PR - silent drift in simulated odds is the failure mode this
  file exists to catch.
*/

describe("engine golden", () => {
  it("a fixed spec, profile and seed reproduce the pinned result exactly", () => {
    const result = simulate(
      baseSpec({
        steps: [
          { profitTargetPct: 8, minTradingDays: 4 },
          { profitTargetPct: 5, minTradingDays: 4 },
        ],
        fees: { price: 500, refundableOnPass: true },
      }),
      {
        kind: "parametric",
        winRate: 0.47,
        avgWinR: 1.6,
        avgLossR: 1,
        winStdR: 0.4,
        tradesPerDay: 4,
        tradesPerDayModel: "poisson",
        risk: { mode: "percent-of-initial", value: 0.75 },
      },
      { paths: 1500, seed: 123, includeHistograms: false },
    );
    expect(result).toMatchSnapshot();
  });
});
