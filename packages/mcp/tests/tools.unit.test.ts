import { beforeEach, describe, expect, it, vi } from "vitest";
import { DISCLAIMER, NEWS_CALENDAR_CAVEAT, OVERLAP_DISCLOSURE } from "@luxalgo/prop-firm-sim-core";
import {
  handleAnalyzePortfolioOverlap,
  handleBootstrapSimulate,
  handleCompareChallenges,
  handleGetChallengeRules,
  handleListFirms,
  handleOptimalRisk,
  handleSimulateChallenge,
  type ToolResult,
} from "../src/tools.js";
import { clearDirectoryCache } from "../src/directory.js";

/*
  These tests call the pure tool handlers directly - no MCP transport - and
  defend the product invariants of the tool surface: honest results (flags,
  provenance and disclaimer always attached), reproducibility, refusal of
  ambiguous rules, helpful errors, and compact transport. Firm data is a
  fixture served through a stubbed fetch: the live LuxAlgo directory is never
  hit, so the suite is deterministic and offline.
*/

const TRADER = {
  winRate: 0.5,
  avgWinR: 1.5,
  tradesPerDay: 4,
  riskValue: 0.5,
} as const;

const FAST = { seed: 7, paths: 1000 } as const;

/** A minimal but complete inline ruleset (the engine fills in defaults). */
const INLINE_SPEC = {
  challengeId: "test-50k-1step",
  name: "Test 50K 1-Step",
  accountSize: 50_000,
  steps: [{ profitTargetPct: 8 }],
  dailyLoss: { pct: 4 },
  maxLoss: { pct: 6, mode: "trailing-intraday-unrealized" },
  fees: { price: 300 },
  funded: { profitSplitPct: 80, payoutFrequency: "monthly" },
} as const;

/* Directory fixture, shaped like GET /api/propfirms/list. One legacy-text
   firm (rules inferred), one fully structured futures firm (rules verbatim,
   incl. locks + consistency + payout gating), and one ambiguous challenge
   that must be refused. */
const DIRECTORY_FIXTURE = {
  data: {
    propfirms: [
      {
        propfirmId: "ftmo",
        name: "FTMO",
        productTypes: ["CFD"],
        currency: "USD",
        challenges: [
          {
            challengeId: "100k-2step",
            challengeName: "100K 2-Step",
            accountSize: 100_000,
            steps: 2,
            profitTarget: [10, 5],
            profitTargetIsPercent: true,
            minTradingDays: 4,
            dailyLoss: 5,
            maxLoss: 10,
            dailyLossType: "Balance based daily loss",
            maxLossType: "Static from initial balance",
            lossIsPercent: true,
            price: 540,
            interval: null,
            profitSplitPercent: 80,
            payoutFrequency: "Every 14 days",
            isFeeRefundable: true,
            sourceUrl: "https://ftmo.example/rules",
            lastVerifiedAt: "2026-08-20T00:00:00.000Z",
          },
          {
            challengeId: "swing-vague",
            challengeName: "Swing (vague rules)",
            accountSize: 100_000,
            steps: 2,
            profitTarget: [10, 5],
            profitTargetIsPercent: true,
            dailyLoss: 5,
            maxLoss: 10,
            maxLossType: "Trailing",
            lossIsPercent: true,
            price: 600,
          },
        ],
      },
      {
        propfirmId: "topstep",
        name: "Topstep",
        productTypes: ["Futures"],
        currency: "USD",
        challenges: [
          {
            challengeId: "50k-trading-combine",
            challengeName: "50K Trading Combine",
            accountSize: 50_000,
            steps: 1,
            profitTarget: [3000],
            profitTargetIsPercent: false,
            minTradingDays: 2,
            dailyLoss: 1000,
            maxLoss: 2000,
            lossIsPercent: false,
            price: 49,
            interval: "month",
            profitSplitPercent: 90,
            maxLossMode: "trailing-realized-eod",
            maxLossLocksAtInitial: true,
            maxLossLockOffset: 0,
            maxLossIsPercent: false,
            dailyLossBasis: "prior-day-balance",
            dailyLossLimitBasis: "initial-balance",
            dailyLossIncludesOpenPnl: true,
            dailyLossEvaluation: "intraday",
            dailyLossIsPercent: false,
            consistencyMaxBestDayPct: 50,
            payoutIntervalDays: 14,
            payoutFrequency: "every 14 days",
            payoutMinWinningDays: 5,
            payoutWinningDayMinProfit: 150,
            payoutMaxPct: 50,
            payoutMaxAmount: 5000,
            payoutBufferAmount: 0,
          },
          {
            challengeId: "50k-xfa",
            challengeName: "50K Express Funded",
            accountSize: 50_000,
            steps: 1,
            profitTarget: [3000],
            profitTargetIsPercent: false,
            dailyLoss: null,
            maxLoss: 2000,
            lossIsPercent: false,
            price: 149,
            maxLossMode: "trailing-intraday-unrealized",
            maxLossLocksAtInitial: true,
            maxLossLockOffset: 100,
            maxLossIsPercent: false,
            fundedConsistencyPct: 30,
            payoutIntervalDays: 14,
            payoutFrequency: "biweekly",
            payoutMinWinningDays: 0,
            payoutBufferAmount: 500,
          },
        ],
      },
    ],
  },
};

beforeEach(() => {
  clearDirectoryCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => DIRECTORY_FIXTURE,
    })),
  );
});

function text(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

function structured(result: ToolResult): Record<string, any> {
  expect(result.isError ?? false).toBe(false);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, any>;
}

describe("list_firms", () => {
  it("lists the live directory with provenance and refuses ambiguous challenges by name", async () => {
    const result = await handleListFirms({});
    const data = structured(result);

    expect(data.firms.map((f: any) => f.firmId)).toEqual(["ftmo", "topstep"]);
    const ftmo = data.firms[0];
    expect(ftmo.challenges.map((c: any) => c.challengeId)).toEqual(["100k-2step"]);
    expect(ftmo.challenges[0].provenance).toBe("directory+inferred");
    expect(ftmo.challenges[0].lastVerified).toBe("2026-08-20");
    expect(ftmo.notSimulatable).toEqual(["swing-vague"]);
    const topstep = data.firms[1];
    expect(topstep.challenges.map((c: any) => c.provenance)).toEqual(["directory", "directory"]);
    expect(data.disclaimer).toBe(DISCLAIMER);
    expect(text(result)).toContain("not endorsement");
    expect(text(result)).toContain("not simulatable");
  });

  it("filters by product type", async () => {
    const result = await handleListFirms({ productType: "futures" });
    const data = structured(result);
    expect(data.firms.map((f: any) => f.firmId)).toEqual(["topstep"]);
  });

  it("fails with an offline hint when the directory is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }),
    );
    const result = await handleListFirms({});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("unreachable");
    expect(text(result)).toContain("offline");
  });
});

describe("get_challenge_rules", () => {
  it("returns the adapted ruleset with provenance, inferred fields, and citations", async () => {
    const result = await handleGetChallengeRules({ firmId: "ftmo", challengeId: "100k-2step" });
    const data = structured(result);

    expect(data.provenance).toBe("directory+inferred");
    expect(data.inferredFields).toContain("maxLoss.mode");
    expect(data.challenge.maxLoss).toMatchObject({ pct: 10, mode: "static-initial" });
    expect(data.challenge.sources[0]).toMatchObject({
      url: "https://ftmo.example/rules",
      lastVerified: "2026-08-20",
    });
    expect(data.disclaimer).toBe(DISCLAIMER);
    expect(text(result)).toContain("authoritative");
    expect(text(result)).toContain("Inferred from directory free text");
  });

  it("spells out simulated consistency, payout gating, and floor locking for rulesets that have them", async () => {
    const topstep = await handleGetChallengeRules({ firmId: "topstep", challengeId: "50k-trading-combine" });
    const topstepText = text(topstep);
    expect(topstepText).toContain("consistency (simulated): best day <= 50% of total profit");
    expect(topstepText).toContain("locks once the floor reaches the starting balance");
    expect(topstepText).toContain("Payout gating (simulated):");
    expect(topstepText).toContain("5 winning days of $150+ each");
    expect(topstepText).toContain("each payout capped at 50% of accrued profit and $5,000");
    expect(structured(topstep).provenance).toBe("directory");

    const xfa = await handleGetChallengeRules({ firmId: "Topstep", challengeId: "50k-xfa" });
    const xfaText = text(xfa);
    // Intraday trailing + lock flag composes into the locking mode; offset renders.
    expect(structured(xfa).challenge.maxLoss.mode).toBe("trailing-locks-at-initial");
    expect(xfaText).toContain("the floor locks at the starting balance + $100");
    expect(xfaText).toContain("funded consistency: best day <= 30% of the window's profit");
  });

  it("refuses ambiguous rule text instead of guessing", async () => {
    const result = await handleGetChallengeRules({ firmId: "ftmo", challengeId: "swing-vague" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not simulatable");
    expect(text(result)).toContain("inline `spec`");
  });

  it("fails with the known ids when the firm or challenge is unknown", async () => {
    const unknownFirm = await handleGetChallengeRules({ firmId: "not-a-firm", challengeId: "100k-2step" });
    expect(unknownFirm.isError).toBe(true);
    expect(text(unknownFirm)).toContain("Unknown firm 'not-a-firm'");
    expect(text(unknownFirm)).toContain("ftmo");

    const unknownChallenge = await handleGetChallengeRules({ firmId: "ftmo", challengeId: "nope" });
    expect(unknownChallenge.isError).toBe(true);
    expect(text(unknownChallenge)).toContain("Simulatable challenges:");
    expect(text(unknownChallenge)).toContain("100k-2step");
  });
});

describe("simulate_challenge", () => {
  it("returns a full result carrying the disclaimer, flags, and provenance", async () => {
    const result = await handleSimulateChallenge({
      firmId: "ftmo",
      challengeId: "100k-2step",
      ...TRADER,
      ...FAST,
    });
    const data = structured(result);

    expect(data.perAttempt.passProbability).toBeGreaterThan(0);
    expect(data.perAttempt.passProbabilityCi.low).toBeLessThanOrEqual(data.perAttempt.passProbability);
    expect(data.assumptions.disclaimer).toBe(DISCLAIMER);
    expect(data.assumptions.flags.length).toBeGreaterThan(0);
    expect(data.provenance).toBe("directory+inferred");
    expect(data.inferredFields).toContain("maxLoss.mode");
    // The human summary must surface the disclaimer, the flags, and the inference.
    expect(text(result)).toContain("Simulation, not prediction");
    expect(text(result)).toContain("relay these to the user");
    expect(text(result)).toContain("Inferred from directory free text");
    expect(text(result)).toContain("Seed 7");
  });

  it("reproduces byte-identical results for the same seed, and different ones otherwise", async () => {
    const args = { firmId: "ftmo", challengeId: "100k-2step", ...TRADER, ...FAST };
    const first = await handleSimulateChallenge(args);
    const second = await handleSimulateChallenge(args);
    expect(JSON.stringify(structured(second))).toBe(JSON.stringify(structured(first)));

    const otherSeed = await handleSimulateChallenge({ ...args, seed: 8 });
    expect(JSON.stringify(structured(otherSeed))).not.toBe(JSON.stringify(structured(first)));
  });

  it("accepts an inline ruleset instead of a directory reference", async () => {
    const result = await handleSimulateChallenge({ spec: INLINE_SPEC, ...TRADER, ...FAST });
    const data = structured(result);
    expect(data.assumptions.spec.challengeId).toBe("test-50k-1step");
    expect(data.provenance).toBe("inline");
  });

  it("fails when the firm id is unknown, naming the known firms", async () => {
    const result = await handleSimulateChallenge({
      firmId: "not-a-firm",
      challengeId: "100k-2step",
      ...TRADER,
      ...FAST,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Known directory firms:");
  });

  it("requires exactly one of a directory reference or an inline ruleset", async () => {
    const both = await handleSimulateChallenge({
      firmId: "ftmo",
      challengeId: "100k-2step",
      spec: INLINE_SPEC,
      ...TRADER,
      ...FAST,
    });
    expect(both.isError).toBe(true);
    expect(text(both)).toContain("not both");

    const neither = await handleSimulateChallenge({ ...TRADER, ...FAST });
    expect(neither.isError).toBe(true);
    expect(text(neither)).toContain("list_firms");
  });

  it("rejects an incomplete inline ruleset with a readable field-level message", async () => {
    const { maxLoss: _dropped, ...withoutMaxLoss } = INLINE_SPEC;
    const result = await handleSimulateChallenge({ spec: withoutMaxLoss, ...TRADER, ...FAST });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("maxLoss");
  });

  it("an inline spec's consistency, floor-lock, and payout-gating rules reach the engine instead of being silently stripped", async () => {
    // Regression guard: the local zod mirror must not strip unknown/new spec
    // fields - a plain z.object() would drop them and the simulation would
    // silently run a different (easier) ruleset than the caller asked for.
    const result = await handleSimulateChallenge({
      spec: {
        ...INLINE_SPEC,
        challengeId: "test-50k-v1-rules",
        steps: [{ profitTargetPct: 8, consistency: { maxBestDayProfitPct: 40 } }],
        maxLoss: { amount: 2000, mode: "trailing-realized-eod", locksAtInitial: true, lockOffsetAmount: 100 },
        funded: {
          profitSplitPct: 80,
          payoutFrequency: "monthly",
          payoutRules: { minWinningDays: 3, winningDayMinProfit: 100, maxPayoutPctOfProfit: 50 },
        },
      },
      ...TRADER,
      ...FAST,
    });
    const data = structured(result);
    const spec = data.assumptions.spec;

    expect(spec.steps[0].consistency).toEqual({ maxBestDayProfitPct: 40 });
    expect(spec.maxLoss.locksAtInitial).toBe(true);
    expect(spec.maxLoss.lockOffsetAmount).toBe(100);
    expect(spec.funded.payoutRules).toMatchObject({
      minWinningDays: 3,
      winningDayMinProfit: 100,
      maxPayoutPctOfProfit: 50,
    });
    // The engine acknowledges it actually simulated the consistency rule.
    const flagIds = data.assumptions.flags.map((f: any) => f.id);
    expect(flagIds).toContain("consistency-stop-rule");
    expect(flagIds).toContain("funded-withdrawal-model");
  });

  it("the summary reports the chance and timing of an actual payout once funded", async () => {
    const result = await handleSimulateChallenge({
      firmId: "topstep",
      challengeId: "50k-trading-combine",
      winRate: 0.55,
      avgWinR: 1.6,
      tradesPerDay: 4,
      riskValue: 0.5,
      riskMode: "percent-of-initial",
      ...FAST,
    });
    const data = structured(result);

    expect(data.funded.payoutProbability).toBeGreaterThan(0);
    expect(data.funded.payoutProbability).toBeLessThanOrEqual(1);
    expect(text(result)).toContain("P(at least one payout | funded)");
    expect(text(result)).toContain("first payout");
  });

  it("keeps responses compact: histograms are excluded unless explicitly requested", async () => {
    const args = { firmId: "ftmo", challengeId: "100k-2step", ...TRADER, ...FAST };
    const compact = structured(await handleSimulateChallenge(args));
    expect(compact.journey.attemptsHistogram).toBeNull();
    expect(compact.ev.netHistogram).toBeNull();

    const withHists = structured(await handleSimulateChallenge({ ...args, includeHistograms: true }));
    expect(withHists.journey.attemptsHistogram).not.toBeNull();
  });

  it("caps the number of Monte Carlo paths a single tool call may request", async () => {
    const result = await handleSimulateChallenge({
      firmId: "ftmo",
      challengeId: "100k-2step",
      ...TRADER,
      seed: 7,
      paths: 200_000,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("paths");
  });
});

describe("optimal_risk", () => {
  it("reports the pass-maximizing and the EV-maximizing risk separately, with assumptions", async () => {
    const result = await handleOptimalRisk({
      firmId: "ftmo",
      challengeId: "100k-2step",
      winRate: 0.45,
      avgWinR: 1.6,
      tradesPerDay: 4,
      min: 0.5,
      max: 2,
      step: 0.5,
      seed: 7,
      paths: 800,
    });
    const data = structured(result);

    expect(data.points.length).toBe(4);
    expect(data.bestByPassProbability.risk).toBeGreaterThan(0);
    expect(data.bestByEv.risk).toBeGreaterThan(0);
    expect(typeof data.diverges).toBe("boolean");
    expect(data.assumptions.disclaimer).toBe(DISCLAIMER);
    expect(data.provenance).toBe("directory+inferred");
    expect(text(result)).toContain("Best per-attempt pass probability");
    expect(text(result)).toContain("Best EV");
  });
});

describe("compare_challenges", () => {
  it("sorts by expected value for the given trader and says it is not a ranking", async () => {
    const result = await handleCompareChallenges({
      challenges: [{ firmId: "ftmo", challengeId: "100k-2step" }, { spec: INLINE_SPEC }],
      ...TRADER,
      ...FAST,
    });
    const data = structured(result);

    expect(data.rows.length).toBe(2);
    for (let i = 1; i < data.rows.length; i++) {
      expect(data.rows[i - 1].evTotal).toBeGreaterThanOrEqual(data.rows[i].evTotal);
    }
    expect(data.disclaimer).toBe(DISCLAIMER);
    expect(data.assumptionsByChallenge.length).toBe(2);
    const ftmoRow = data.assumptionsByChallenge.find((a: any) => a.firmId === "ftmo");
    expect(ftmoRow.provenance).toBe("directory+inferred");
    expect(ftmoRow.inferredFields).toContain("maxLoss.mode");
    expect(text(result)).toContain("not a ranking");
  });
});

describe("bootstrap_simulate", () => {
  const R_SERIES_TEXT = "1.8R, -1R, 0.4R, 2.2R, -1R, -1R, 0.9R, 3.1R, -1R, 1.2R, -0.5R, 0.7R";

  it("accepts a pasted R-multiple series as text and simulates from the real trades", async () => {
    const result = await handleBootstrapSimulate({
      firmId: "ftmo",
      challengeId: "100k-2step",
      rSeriesText: R_SERIES_TEXT,
      tradesPerDay: 4,
      riskValue: 0.5,
      ...FAST,
    });
    const data = structured(result);

    expect(data.assumptions.profile.kind).toBe("bootstrap");
    expect(data.assumptions.profile.rSeries).toHaveLength(12);
    expect(data.assumptions.profile.rSeries[0]).toBe(1.8);
    expect(data.assumptions.disclaimer).toBe(DISCLAIMER);
    expect(text(result)).toContain("12 real trades");
    expect(text(result)).toContain("streaks preserved");
  });

  it("requires the trade series in exactly one form and enough trades to resample", async () => {
    const base = { firmId: "ftmo", challengeId: "100k-2step", tradesPerDay: 4, riskValue: 0.5, ...FAST };

    const neither = await handleBootstrapSimulate(base);
    expect(neither.isError).toBe(true);
    expect(text(neither)).toContain("rSeries");

    const both = await handleBootstrapSimulate({
      ...base,
      rSeries: [1, -1, 1, -1, 1, -1, 1, -1, 1, -1],
      rSeriesText: R_SERIES_TEXT,
    });
    expect(both.isError).toBe(true);
    expect(text(both)).toContain("exactly one");

    const tooFew = await handleBootstrapSimulate({ ...base, rSeries: [1, -1, 1] });
    expect(tooFew.isError).toBe(true);
  });
});

/*
  Timestamped-log fixtures. June 2026 puts one deterministic high-impact USD
  event inside the range: Non-Farm Payrolls on the first Friday (June 5) at
  8:30 ET = 12:30 UTC (US DST active), so the default 30-minute windows cover
  12:00-13:00 UTC exactly.
*/
function tradeLogCsv(rows: string[]): string {
  return ["openedAt,closedAt,direction,r", ...rows].join("\n");
}

const LOG_A = tradeLogCsv([
  "2026-06-01 09:00,2026-06-01 09:45,long,1.2",
  "2026-06-01 13:00,2026-06-01 13:30,short,-1",
  "2026-06-02 09:15,2026-06-02 10:00,long,0.8",
  "2026-06-02 14:00,2026-06-02 14:20,long,-1",
  "2026-06-03 09:30,2026-06-03 10:15,short,2.1",
  "2026-06-03 15:00,2026-06-03 15:40,long,-0.5",
  "2026-06-04 09:00,2026-06-04 09:30,long,1.5",
  "2026-06-04 14:30,2026-06-04 15:00,short,-1",
  "2026-06-05 11:00,2026-06-05 14:00,long,0.9", // opened before the NFP window, held through the release
  "2026-06-05 12:10,2026-06-05 12:20,long,-1", // opened inside the NFP window
  "2026-06-05 12:45,2026-06-05 13:10,short,1.1", // opened inside the NFP window
  "2026-06-05 15:30,2026-06-05 16:00,long,0.6",
]);

/** LOG_A shifted by two minutes with the same directions: a near-copy account. */
const LOG_B = tradeLogCsv([
  "2026-06-01 09:02,2026-06-01 09:47,long,1.1",
  "2026-06-01 13:02,2026-06-01 13:32,short,-1",
  "2026-06-02 09:17,2026-06-02 10:02,long,0.7",
  "2026-06-02 14:02,2026-06-02 14:22,long,-1",
  "2026-06-03 09:32,2026-06-03 10:17,short,1.9",
  "2026-06-03 15:02,2026-06-03 15:42,long,-0.4",
  "2026-06-04 09:02,2026-06-04 09:32,long,1.4",
  "2026-06-04 14:32,2026-06-04 15:02,short,-1",
  "2026-06-05 11:02,2026-06-05 14:02,long,0.8",
  "2026-06-05 12:12,2026-06-05 12:22,long,-1",
  "2026-06-05 12:47,2026-06-05 13:12,short,1",
  "2026-06-05 15:32,2026-06-05 16:02,long,0.5",
]);

/** Trades in a different month entirely: zero overlap with LOG_A. */
const LOG_DISJOINT = tradeLogCsv([
  "2026-07-06 09:00,2026-07-06 09:30,long,1",
  "2026-07-07 09:00,2026-07-07 09:30,short,-1",
  "2026-07-08 09:00,2026-07-08 09:30,long,2",
  "2026-07-09 09:00,2026-07-09 09:30,short,-1",
]);

describe("bootstrap_simulate from a timestamped trade log", () => {
  const REF = { firmId: "ftmo", challengeId: "100k-2step" } as const;

  it("parses a pasted timestamped log, derives trades per day, and surfaces parse warnings", async () => {
    const result = await handleBootstrapSimulate({ ...REF, tradeLogText: LOG_A, riskValue: 0.5, ...FAST });
    const data = structured(result);

    expect(data.assumptions.profile.kind).toBe("bootstrap");
    expect(data.assumptions.profile.rSeries).toHaveLength(12);
    expect(data.assumptions.profile.rSeries[0]).toBe(1.2);
    // 12 trades over 5 distinct UTC days = 2.4 trades/day, derived, and said so.
    expect(data.assumptions.profile.tradesPerDay).toBeCloseTo(2.4, 6);
    expect(data.tradeLog).toMatchObject({ trades: 12, distinctDays: 5, historyCount: 1 });
    expect(data.tradeLog.derivedTradesPerDay).toBeCloseTo(2.4, 6);
    expect(text(result)).toContain("DERIVED from the log's timestamps");
    // The log has no timezone offsets; the assumed-UTC parse warning must be relayed.
    expect(text(result)).toContain("read as UTC");
  });

  it("an explicit tradesPerDay overrides the rate derived from the log", async () => {
    const result = await handleBootstrapSimulate({
      ...REF,
      tradeLogText: LOG_A,
      tradesPerDay: 3,
      riskValue: 0.5,
      ...FAST,
    });
    const data = structured(result);
    expect(data.assumptions.profile.tradesPerDay).toBe(3);
    expect(data.tradeLog.derivedTradesPerDay).toBeNull();
    expect(text(result)).not.toContain("DERIVED from the log's timestamps");
  });

  it("accepts exactly one series input, and bare series still require tradesPerDay", async () => {
    const logPlusText = await handleBootstrapSimulate({
      ...REF,
      tradeLogText: LOG_A,
      rSeriesText: "1, -1, 1, -1, 1, -1, 1, -1, 1, -1",
      riskValue: 0.5,
      ...FAST,
    });
    expect(logPlusText.isError).toBe(true);
    expect(text(logPlusText)).toContain("exactly one");

    const portfolioPlusSeries = await handleBootstrapSimulate({
      ...REF,
      tradeLogTexts: [LOG_A, LOG_B],
      rSeries: [1, -1, 1, -1, 1, -1, 1, -1, 1, -1],
      riskValue: 0.5,
      ...FAST,
    });
    expect(portfolioPlusSeries.isError).toBe(true);
    expect(text(portfolioPlusSeries)).toContain("exactly one");

    const noRate = await handleBootstrapSimulate({
      ...REF,
      rSeriesText: "1, -1, 1, -1, 1, -1, 1, -1, 1, -1",
      riskValue: 0.5,
      ...FAST,
    });
    expect(noRate.isError).toBe(true);
    expect(text(noRate)).toContain("tradesPerDay is required");
    expect(text(noRate)).toContain("tradeLogText");
  });

  it("an unparseable log fails with the parser's reason instead of simulating nothing", async () => {
    const result = await handleBootstrapSimulate({
      ...REF,
      tradeLogText: "this is not a trade log",
      riskValue: 0.5,
      ...FAST,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("no parseable trades");
  });
});

describe("bootstrap_simulate news-window comparison", () => {
  const REF = { firmId: "ftmo", challengeId: "100k-2step" } as const;

  it("runs original and news-avoided scenarios around the June 2026 NFP and reports both with the caveat", async () => {
    const result = await handleBootstrapSimulate({
      ...REF,
      tradeLogText: LOG_A,
      newsFilter: { currencies: ["USD"] },
      riskValue: 0.5,
      ...FAST,
    });
    const data = structured(result);
    const cmp = data.newsComparison;

    // NFP is the only USD high-impact event in range; its window is 12:00-13:00 UTC on June 5.
    expect(cmp.eventsInRange).toBe(1);
    expect(cmp.excludedTrades).toBe(2); // opened 12:10 and 12:45 UTC
    expect(cmp.heldThroughCount).toBe(1); // opened 11:00, closed 14:00, held through 12:30
    expect(cmp.original.passProbability).toBeGreaterThan(0);
    expect(cmp.newsAvoided.passProbability).toBeGreaterThan(0);
    expect(typeof cmp.original.fundedProbability).toBe("number");
    expect(typeof cmp.original.evTotal).toBe("number");
    expect(typeof cmp.newsAvoided.fundedProbability).toBe("number");
    expect(typeof cmp.newsAvoided.evTotal).toBe("number");
    expect(cmp.options).toMatchObject({ preMinutes: 30, postMinutes: 30, impacts: ["high"] });
    expect(cmp.caveat).toBe(NEWS_CALENDAR_CAVEAT);

    // The primary SimResult is the news-avoided run: 12 - 2 excluded = 10 kept trades.
    expect(data.assumptions.profile.rSeries).toHaveLength(10);
    expect(text(result)).toContain("news-AVOIDED");
    expect(text(result)).toContain("original");
    expect(text(result)).toContain(NEWS_CALENDAR_CAVEAT);
  });

  it("refuses a news filter without timestamps to match against", async () => {
    const result = await handleBootstrapSimulate({
      ...REF,
      rSeries: [1, -1, 1, -1, 1, -1, 1, -1, 1, -1],
      tradesPerDay: 4,
      riskValue: 0.5,
      newsFilter: {},
      ...FAST,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("timestamps");
    expect(text(result)).toContain("tradeLogText");
  });
});

describe("bootstrap_simulate portfolio mode", () => {
  it("merges the logs, simulates the combined account, and always reports overlap audit risk", async () => {
    const result = await handleBootstrapSimulate({
      firmId: "ftmo",
      challengeId: "100k-2step",
      tradeLogTexts: [LOG_A, LOG_B],
      riskValue: 0.5,
      ...FAST,
    });
    const data = structured(result);

    // The merged chronological series drives the simulation: 12 + 12 trades over 5 days.
    expect(data.assumptions.profile.kind).toBe("bootstrap");
    expect(data.assumptions.profile.rSeries).toHaveLength(24);
    expect(data.assumptions.profile.tradesPerDay).toBeCloseTo(4.8, 6);
    expect(data.tradeLog).toMatchObject({ trades: 24, historyCount: 2 });

    // Near-identical accounts: the overlap report is attached and reads as a warning.
    expect(data.portfolioOverlap.auditRisk).toBe("high");
    expect(data.portfolioOverlap.overallOverlapShare).toBeGreaterThan(0.3);
    expect(data.portfolioOverlap.disclosure).toBe(OVERLAP_DISCLOSURE);
    expect(text(result)).toContain("Portfolio mode");
    expect(text(result)).toContain("AUDIT RISK: HIGH");
    expect(text(result)).toContain("audit or refuse payouts");
    expect(text(result)).toContain(OVERLAP_DISCLOSURE);
  });
});

describe("analyze_portfolio_overlap", () => {
  it("flags near-identical histories as high audit risk with per-pair shares and the disclosure", async () => {
    const result = await handleAnalyzePortfolioOverlap({ tradeLogTexts: [LOG_A, LOG_B] });
    const data = structured(result);

    expect(data.auditRisk).toBe("high");
    expect(data.pairs).toHaveLength(1);
    expect(data.pairs[0]).toMatchObject({ a: 0, b: 1 });
    expect(data.pairs[0].shareA).toBeGreaterThan(0.3);
    expect(data.pairs[0].sameDirection).toBeGreaterThan(0);
    expect(data.overallOverlapShare).toBeGreaterThan(0.3);
    expect(data.sameDirectionShare).toBeGreaterThan(0.3);
    expect(data.toleranceMinutes).toBe(5);
    expect(data.disclosure).toBe(OVERLAP_DISCLOSURE);
    expect(data.histories).toEqual([
      { index: 0, trades: 12 },
      { index: 1, trades: 12 },
    ]);
    expect(text(result)).toContain("AUDIT RISK: HIGH");
    expect(text(result)).toContain("audit or refuse payouts");
    expect(text(result)).toContain(OVERLAP_DISCLOSURE);
  });

  it("labels histories that never trade at the same time as low audit risk", async () => {
    const result = await handleAnalyzePortfolioOverlap({
      tradeLogTexts: [LOG_A, LOG_DISJOINT],
      toleranceMinutes: 30,
    });
    const data = structured(result);
    expect(data.auditRisk).toBe("low");
    expect(data.overallOverlapShare).toBe(0);
    expect(data.toleranceMinutes).toBe(30);
    expect(text(result)).toContain("Audit risk: LOW");
  });

  it("requires between 2 and 5 histories and refuses unparseable logs", async () => {
    const one = await handleAnalyzePortfolioOverlap({ tradeLogTexts: [LOG_A] });
    expect(one.isError).toBe(true);
    expect(text(one)).toContain("at least 2");

    const six = await handleAnalyzePortfolioOverlap({
      tradeLogTexts: [LOG_A, LOG_B, LOG_A, LOG_B, LOG_A, LOG_B],
    });
    expect(six.isError).toBe(true);
    expect(text(six)).toContain("at most 5");

    const garbage = await handleAnalyzePortfolioOverlap({ tradeLogTexts: [LOG_A, "not a log"] });
    expect(garbage.isError).toBe(true);
    expect(text(garbage)).toContain("no parseable trades");
  });
});
