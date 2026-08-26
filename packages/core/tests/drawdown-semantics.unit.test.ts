import { describe, expect, it } from "vitest";
import { runScriptedStep } from "./helpers.js";

/*
  Hand-computed micro-cases: every drawdown/daily-loss semantic is pinned by a
  tiny worked example ($100k account, $1,000 risked per 1R, so R values map to
  thousands of dollars). Each case is verifiable with pen and paper - these
  are the tests that make the engine citable, and they are deliberately
  distinguishing: the same trade path passes under one semantic and fails
  under its neighbor.
*/

describe("static max loss (static-initial)", () => {
  it("fails the account only when equity touches the fixed floor from the initial balance", () => {
    // 10% max loss ⇒ floor $90,000. Day 1: 97, 94, 91 - survives.
    // Day 2: 89 ≤ 90 ⇒ max-loss breach on day 2.
    const out = runScriptedStep({
      days: [[-3, -3, -3], [-2]],
      maxLoss: { pct: 10, mode: "static-initial" },
    });
    expect(out.passed).toBe(false);
    expect(out.failReason).toBe("max-loss");
    expect(out.daysUsed).toBe(2);
    expect(out.endBalance).toBe(89_000);
  });

  it("touching the floor exactly counts as a breach, matching how firms enforce limits", () => {
    const out = runScriptedStep({ days: [[-10]], maxLoss: { pct: 10, mode: "static-initial" } });
    expect(out.failReason).toBe("max-loss");
  });
});

describe("daily loss", () => {
  it("a fixed daily allowance (percent of initial) breaches from the day's starting balance", () => {
    // 5% of initial ⇒ $5,000 allowance. Day 1 closes at 102k, so day 2's floor
    // is 97k. Day 2 trades: 99k, then 96.95k ≤ 97k ⇒ daily-loss.
    const out = runScriptedStep({
      days: [[+2], [-3, -2.05]],
      maxLoss: { pct: 20, mode: "static-initial" },
      dailyLoss: { pct: 5, limitBasis: "initial-balance" },
    });
    expect(out.failReason).toBe("daily-loss");
    expect(out.daysUsed).toBe(2);
  });

  it("an anchor-based daily allowance recomputes from each day's start and can survive the same path", () => {
    // Same path, but 5% of the day's anchor: day 2 allowance = 5% × 102k =
    // $5,100 ⇒ floor 96.9k. The 96.95k print survives; the step then dies of
    // its 2-day time limit, not of a loss breach.
    const out = runScriptedStep({
      days: [[+2], [-3, -2.05]],
      maxLoss: { pct: 20, mode: "static-initial" },
      dailyLoss: { pct: 5, limitBasis: "anchor" },
      maxDays: 2,
    });
    expect(out.failReason).toBe("time-limit");
  });

  it("an end-of-day daily check ignores an intraday dip that recovers by the close", () => {
    // $5,000 allowance, floor 95k. Intraday the account prints 94k (would
    // breach an intraday check) but closes at 96k.
    const out = runScriptedStep({
      days: [[-6, +2]],
      maxLoss: { pct: 20, mode: "static-initial" },
      dailyLoss: { pct: 5, evaluation: "end-of-day" },
      maxDays: 1,
    });
    expect(out.failReason).toBe("time-limit");

    const intraday = runScriptedStep({
      days: [[-6, +2]],
      maxLoss: { pct: 20, mode: "static-initial" },
      dailyLoss: { pct: 5, evaluation: "intraday" },
      maxDays: 1,
    });
    expect(intraday.failReason).toBe("daily-loss");
  });

  it("when one trade crosses both floors, the breach is attributed to the floor crossed first on the way down", () => {
    // Daily floor 98k sits above the static max floor 97k ⇒ daily-loss.
    const daily = runScriptedStep({
      days: [[-3.5]],
      maxLoss: { amount: 3_000, mode: "static-initial" },
      dailyLoss: { amount: 2_000 },
    });
    expect(daily.failReason).toBe("daily-loss");

    // Flip the floors: max floor 97k above daily floor 96k ⇒ max-loss.
    const max = runScriptedStep({
      days: [[-4.5]],
      maxLoss: { amount: 3_000, mode: "static-initial" },
      dailyLoss: { amount: 4_000 },
    });
    expect(max.failReason).toBe("max-loss");
  });
});

describe("trailing max loss - intraday unrealized (trailing-intraday-unrealized)", () => {
  it("the floor ratchets with every new equity high and kills a give-back the static rule would forgive", () => {
    // $3,000 trail. +2 ⇒ peak 102k, floor 99k. Then −3.5 ⇒ 98.5k ≤ 99k: dead.
    const trailing = runScriptedStep({
      days: [[+2, -3.5]],
      maxLoss: { amount: 3_000, mode: "trailing-intraday-unrealized" },
    });
    expect(trailing.failReason).toBe("max-loss");
    expect(trailing.daysUsed).toBe(1);

    // The identical path under a static $3,000 rule (floor 97k) survives.
    const staticRule = runScriptedStep({
      days: [[+2, -3.5]],
      maxLoss: { amount: 3_000, mode: "static-initial" },
      maxDays: 1,
    });
    expect(staticRule.failReason).toBe("time-limit");
  });

  it("a trade that sets a new peak can never breach the floor it just moved", () => {
    const out = runScriptedStep({
      days: [[+5, +5, +5]],
      maxLoss: { amount: 1_000, mode: "trailing-intraday-unrealized" },
      maxDays: 1,
    });
    expect(out.failReason).toBe("time-limit");
    expect(out.endBalance).toBe(115_000);
  });
});

describe("trailing max loss that locks at breakeven (trailing-locks-at-initial)", () => {
  it("the floor stops rising once it reaches the initial balance", () => {
    // $3,000 trail. Day 1: +4 ⇒ peak 104k; unlocked floor would be 101k, but
    // it freezes at 100k. Day 2: 100.1k survives (a never-locking trail would
    // have killed it). Day 3: 99.9k ≤ 100k ⇒ dead.
    const locks = runScriptedStep({
      days: [[+4], [-3.9], [-0.2]],
      maxLoss: { amount: 3_000, mode: "trailing-locks-at-initial" },
    });
    expect(locks.failReason).toBe("max-loss");
    expect(locks.daysUsed).toBe(3);

    const neverLocks = runScriptedStep({
      days: [[+4], [-3.9], [-0.2]],
      maxLoss: { amount: 3_000, mode: "trailing-intraday-unrealized" },
    });
    expect(neverLocks.failReason).toBe("max-loss");
    expect(neverLocks.daysUsed).toBe(2);
  });
});

describe("trailing max loss - end-of-day realized (trailing-realized-eod)", () => {
  it("intraday highs do not move the floor; only end-of-day highs do", () => {
    // $3,000 trail. Day 1 spikes to 104k intraday but closes 99.5k: the floor
    // stays 97k (an intraday-trailing rule dies right here). Day 2 closes
    // 104.5k ⇒ floor ratchets to 101.5k at the close. Day 3: 101k ≤ 101.5k.
    const eod = runScriptedStep({
      days: [[+4, -4.5], [+5], [-3.5]],
      maxLoss: { amount: 3_000, mode: "trailing-realized-eod" },
    });
    expect(eod.failReason).toBe("max-loss");
    expect(eod.daysUsed).toBe(3);

    const intraday = runScriptedStep({
      days: [[+4, -4.5], [+5], [-3.5]],
      maxLoss: { amount: 3_000, mode: "trailing-intraday-unrealized" },
    });
    expect(intraday.failReason).toBe("max-loss");
    expect(intraday.daysUsed).toBe(1);
  });
});

describe("profit target, minimum trading days and time limits", () => {
  it("hitting the target early still requires the minimum trading days before the step passes", () => {
    // Target 8% hit on day 1; minimum 4 trading days ⇒ pass lands on day 4,
    // with the post-target days simulated risk-free.
    const out = runScriptedStep({
      days: [[+9]],
      maxLoss: { pct: 10, mode: "static-initial" },
      targetBalance: 108_000,
      minTradingDays: 4,
    });
    expect(out.passed).toBe(true);
    expect(out.tradingDays).toBe(4);
    expect(out.daysUsed).toBe(4);
    expect(out.endBalance).toBe(109_000);
  });

  it("running out of time fails the step as time-limit, not as a loss breach", () => {
    const out = runScriptedStep({
      days: [[+1], [+1], [+1]],
      maxLoss: { pct: 10, mode: "static-initial" },
      targetBalance: 108_000,
      maxDays: 3,
    });
    expect(out.failReason).toBe("time-limit");
    expect(out.tradingDays).toBe(3);
  });

  it("a trade that breaches on the way to the target fails the step even if it would also have hit the target that day", () => {
    // Trade 1 drops to 96.5k, breaching the 3k daily allowance before the
    // monster +12 print later that day could ever be reached.
    const out = runScriptedStep({
      days: [[-3.5, +12]],
      maxLoss: { pct: 10, mode: "static-initial" },
      dailyLoss: { amount: 3_000 },
      targetBalance: 108_000,
    });
    expect(out.passed).toBe(false);
    expect(out.failReason).toBe("daily-loss");
  });
});

describe("risk sizing", () => {
  it("percent-of-balance sizing compounds while percent-of-initial stays constant", () => {
    const compounding = runScriptedStep({
      days: [[+1, +1]],
      maxLoss: { pct: 50, mode: "static-initial" },
      sizing: { mode: "percent-of-balance", value: 1 },
      maxDays: 1,
    });
    expect(compounding.endBalance).toBeCloseTo(102_010, 6); // 100k → 101k → +1% of 101k

    const constant = runScriptedStep({
      days: [[+1, +1]],
      maxLoss: { pct: 50, mode: "static-initial" },
      sizing: { mode: "percent-of-initial", value: 1 },
      maxDays: 1,
    });
    expect(constant.endBalance).toBeCloseTo(102_000, 6);
  });
});
