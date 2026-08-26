import { describe, expect, it } from "vitest";
import { adaptChallenge, adaptFirm } from "../src/directory/index.js";
import type { DirectoryChallengeRow } from "../src/directory/index.js";
import { simulate } from "../src/index.js";

/*
  The directory adapter is the trust boundary between LuxAlgo's live firm
  directory and the engine: structured columns are used verbatim, free text
  is only inferred when unambiguous (and disclosed), and ambiguity is refused
  rather than guessed. These tests defend that policy, not the mapping code.
*/

const baseRow: DirectoryChallengeRow = {
  challengeId: "eval-100k",
  challengeName: "Evaluation 100K",
  accountSize: 100_000,
  steps: 2,
  profitTarget: [8, 5],
  profitTargetIsPercent: true,
  minTradingDays: 4,
  dailyLoss: 5,
  maxLoss: 10,
  dailyLossType: "Balance based daily loss",
  maxLossType: "Static from initial balance",
  lossIsPercent: true,
  price: 500,
  interval: null,
  profitSplitPercent: 80,
  payoutFrequency: "Every 14 days",
  isFeeRefundable: true,
};

describe("structured columns beat free text", () => {
  it("a row with structured rule columns adapts with nothing inferred", () => {
    const adapted = adaptChallenge("firm-1", "Firm One", "futures", {
      ...baseRow,
      maxLossType: "utterly ambiguous prose",
      dailyLossType: "also ambiguous",
      maxLossMode: "trailing-realized-eod",
      maxLossLocksAtInitial: true,
      maxLossLockOffset: 100,
      maxLossIsPercent: false,
      maxLoss: 2000,
      dailyLossBasis: "prior-day-balance",
      dailyLossLimitBasis: "anchor",
      dailyLossIncludesOpenPnl: false,
      dailyLossEvaluation: "end-of-day",
      dailyLossIsPercent: false,
      dailyLoss: 1000,
      payoutIntervalDays: 14,
    });
    expect(adapted).not.toBeNull();
    expect(adapted!.provenance).toBe("directory");
    expect(adapted!.inferredFields).toEqual([]);
    expect(adapted!.spec.maxLoss).toMatchObject({
      amount: 2000,
      mode: "trailing-realized-eod",
      locksAtInitial: true,
      lockOffsetAmount: 100,
    });
    expect(adapted!.spec.dailyLoss).toMatchObject({
      amount: 1000,
      limitBasis: "anchor",
      includesOpenPnl: false,
      evaluation: "end-of-day",
    });
  });

  it("intraday trailing plus the lock flag composes into the spec's locking mode", () => {
    // The directory stores locking orthogonally to the three-value mode; the
    // engine ignores locksAtInitial on plain intraday trailing, so dropping
    // this composition would silently simulate a harsher rule than the firm's.
    const adapted = adaptChallenge("firm-1", "Firm One", "futures", {
      ...baseRow,
      maxLossMode: "trailing-intraday-unrealized",
      maxLossLocksAtInitial: true,
      maxLossLockOffset: 0,
    });
    expect(adapted!.spec.maxLoss).toMatchObject({ mode: "trailing-locks-at-initial" });
  });
});

describe("free-text inference is disclosed and ambiguity is refused", () => {
  it("unambiguous text infers the mode and discloses it", () => {
    const adapted = adaptChallenge("firm-1", "Firm One", "cfd", {
      ...baseRow,
      maxLossType: "Trailing, locks at starting balance",
    });
    expect(adapted!.spec.maxLoss).toMatchObject({ mode: "trailing-locks-at-initial" });
    expect(adapted!.provenance).toBe("directory+inferred");
    expect(adapted!.inferredFields).toContain("maxLoss.mode");
  });

  it("bare 'trailing' max loss is refused, not guessed", () => {
    const adapted = adaptChallenge("firm-1", "Firm One", "cfd", {
      ...baseRow,
      maxLossType: "Trailing",
    });
    expect(adapted).toBeNull();
  });

  it("a row with no max-loss value is not simulatable", () => {
    expect(adaptChallenge("firm-1", "Firm One", "cfd", { ...baseRow, maxLoss: null })).toBeNull();
  });

  it("daily loss without structured semantics is disclosed as inferred", () => {
    const adapted = adaptChallenge("firm-1", "Firm One", "cfd", baseRow);
    expect(adapted!.inferredFields).toContain("dailyLoss.semantics");
    expect(adapted!.provenance).toBe("directory+inferred");
  });
});

describe("adapted specs are complete engine inputs", () => {
  it("an adapted challenge simulates end to end and keeps citations", () => {
    const adapted = adaptChallenge("firm-1", "Firm One", "cfd", {
      ...baseRow,
      sourceUrl: "https://example-firm.test/rules",
      lastVerifiedAt: "2026-08-20T10:00:00.000Z",
    })!;
    const result = simulate(
      adapted.spec,
      {
        kind: "parametric",
        winRate: 0.5,
        avgWinR: 1.5,
        tradesPerDay: 3,
        risk: { mode: "percent-of-initial", value: 0.5 },
      },
      { seed: 7, paths: 500 },
    );
    expect(result.perAttempt.passProbability).toBeGreaterThan(0);
    expect(result.assumptions.spec.sources?.[0]).toMatchObject({
      url: "https://example-firm.test/rules",
      lastVerified: "2026-08-20",
    });
    // Monthly billing and payout gating survive the mapping into fees/funded.
    const monthly = adaptChallenge("firm-1", "Firm One", "futures", {
      ...baseRow,
      interval: "month",
      payoutMinWinningDays: 5,
      payoutWinningDayMinProfit: 200,
      payoutBufferAmount: 2000,
      fundedConsistencyPct: 50,
    })!;
    expect(monthly.spec.fees).toMatchObject({ billing: "monthly" });
    expect(monthly.spec.funded.payoutRules).toMatchObject({
      minWinningDays: 5,
      winningDayMinProfit: 200,
      bufferAmount: 2000,
      consistencyMaxBestDayPct: 50,
    });
  });

  it("adaptFirm maps every unambiguous challenge and skips refused ones", () => {
    const adapted = adaptFirm({
      propfirmId: "firm-1",
      name: "Firm One",
      productTypes: ["Futures"],
      challenges: [baseRow, { ...baseRow, challengeId: "vague", maxLossType: "Trailing" }],
    });
    expect(adapted.map((a) => a.challengeId)).toEqual(["eval-100k"]);
    expect(adapted[0]!.productType).toBe("futures");
  });
});
