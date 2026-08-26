import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DISCLAIMER,
  NEWS_CALENDAR_CAVEAT,
  OVERLAP_DISCLOSURE,
  analyzeOverlap,
  compare,
  simulate,
} from "@luxalgo/prop-firm-sim-core";
import type { DirectoryChallengeRow, DirectoryFirmRow } from "@luxalgo/prop-firm-sim-core/directory";
import {
  buildFirmsListing,
  fetchDirectory,
  requireAdaptedChallenge,
  resolveFirm,
} from "../src/lib/directory.js";
import { UsageError } from "../src/lib/errors.js";
import { buildSimOptionsFromFlags } from "../src/lib/options.js";
import { parseRef, parseRiskFlag } from "../src/lib/parse.js";
import { buildProfileFromFlags } from "../src/lib/profile.js";
import {
  renderCompareReport,
  renderFirmsList,
  renderOverlapReport,
  renderRulesReport,
  renderSimulateReport,
} from "../src/lib/render.js";
import { resolveTargetSpec } from "../src/lib/target.js";
import {
  assertNewsNeedsTradeLog,
  buildNewsComparison,
  buildNewsOptions,
  buildTradeLogPlan,
  loadTradeLogs,
  parseImportRiskFlag,
} from "../src/lib/tradelog.js";

/** Whitespace-insensitive containment (reports wrap long strings to ~98 cols). */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

const TWELVE_TRADES = "1.8R, -1, 0.6, -1, 2.2, -1, 0.9, -1, 1.4, -1, 3.1, -0.5";

/* ------------------------------------------------------------------ */
/* Live-directory fixtures (tests never hit the network)              */
/* ------------------------------------------------------------------ */

/** Legacy free-text semantics only: adapts, with every inference disclosed. */
const INFERRED_ROW: DirectoryChallengeRow = {
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
  price: 480,
  interval: null,
  profitSplitPercent: 80,
  payoutFrequency: "Every 14 days",
  isFeeRefundable: true,
  sourceUrl: "https://firm-one.example/rules",
  lastVerifiedAt: "2026-08-20T10:00:00.000Z",
};

/** Bare "Trailing" max loss: exactly the ambiguity the adapter refuses to guess. */
const REFUSED_ROW: DirectoryChallengeRow = {
  challengeId: "vague-50k",
  challengeName: "Vague 50K",
  accountSize: 50_000,
  steps: 1,
  profitTarget: [8],
  profitTargetIsPercent: true,
  dailyLoss: 4,
  maxLoss: 8,
  maxLossType: "Trailing",
  lossIsPercent: true,
  price: 250,
  interval: null,
};

/** Structured rule columns throughout: adapts with nothing inferred. */
const STRUCTURED_ROW: DirectoryChallengeRow = {
  challengeId: "combine-50k",
  challengeName: "Combine 50K",
  accountSize: 50_000,
  steps: 1,
  profitTarget: [3000],
  profitTargetIsPercent: false,
  minTradingDays: 0,
  dailyLoss: 1100,
  maxLoss: 2000,
  lossIsPercent: false,
  price: null,
  interval: null,
  profitSplitPercent: 90,
  payoutFrequency: null,
  isFeeRefundable: null,
  maxLossMode: "trailing-realized-eod",
  maxLossLocksAtInitial: true,
  maxLossLockOffset: 100,
  maxLossIsPercent: false,
  dailyLossBasis: "prior-day-balance",
  dailyLossLimitBasis: "initial-balance",
  dailyLossIncludesOpenPnl: true,
  dailyLossEvaluation: "intraday",
  dailyLossIsPercent: false,
  payoutIntervalDays: 14,
  payoutMinWinningDays: 3,
  payoutWinningDayMinProfit: 100,
  payoutBufferAmount: 1000,
};

const FIRM_ONE: DirectoryFirmRow = {
  propfirmId: "firm-one",
  name: "Firm One",
  productTypes: ["CFD"],
  challenges: [INFERRED_ROW, REFUSED_ROW],
};

const NOVA: DirectoryFirmRow = {
  propfirmId: "nova-futures",
  name: "Nova Futures Funding",
  productTypes: ["Futures"],
  challenges: [STRUCTURED_ROW],
};

const DIRECTORY_FIRMS: DirectoryFirmRow[] = [FIRM_ONE, NOVA];

/** Stub global fetch with a canned directory envelope; returns the mock. */
function stubFetchDirectory(rows: DirectoryFirmRow[] = DIRECTORY_FIRMS): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { propfirms: rows } }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(outcome).toBeInstanceOf(Error);
  return outcome as Error;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("risk sizing flag", () => {
  it('a percent risk like "0.5%" risks that percent of the current balance by default', () => {
    expect(parseRiskFlag("0.5%")).toEqual({ mode: "percent-of-balance", value: 0.5 });
  });

  it("a bare number risk is read as a percent, not a currency amount", () => {
    expect(parseRiskFlag("0.5")).toEqual({ mode: "percent-of-balance", value: 0.5 });
  });

  it("the risk mode flag switches which balance the percent applies to", () => {
    expect(parseRiskFlag("1%", "percent-of-initial")).toEqual({
      mode: "percent-of-initial",
      value: 1,
    });
  });

  it("with fixed-amount sizing the risk is a currency amount, thousands separators allowed", () => {
    expect(parseRiskFlag("250", "fixed-amount")).toEqual({ mode: "fixed-amount", value: 250 });
    expect(parseRiskFlag("$1,250", "fixed-amount")).toEqual({ mode: "fixed-amount", value: 1250 });
  });

  it("a percent risk is rejected when sizing is a fixed currency amount", () => {
    expect(() => parseRiskFlag("0.5%", "fixed-amount")).toThrow(/currency amount/);
  });

  it("zero, negative, or unreadable risk is rejected with a readable message", () => {
    expect(() => parseRiskFlag("0")).toThrow(UsageError);
    expect(() => parseRiskFlag("-1%")).toThrow(/positive/);
    expect(() => parseRiskFlag("a lot")).toThrow(/positive number/);
  });

  it("an unknown risk mode is rejected and the valid modes are listed", () => {
    expect(() => parseRiskFlag("1%", "percent-of-vibes")).toThrow(/percent-of-balance.*fixed-amount/);
  });
});

describe("challenge references", () => {
  it('a compare reference is written as firm/challenge, like "ftmo/100k-2step"', () => {
    expect(parseRef("ftmo/100k-2step")).toEqual({ firmId: "ftmo", challengeId: "100k-2step" });
  });

  it("a reference missing either part is rejected with the expected shape shown", () => {
    for (const bad of ["ftmo", "ftmo/", "/100k-2step", "a/b/c"]) {
      expect(() => parseRef(bad)).toThrow(/expected <firmId>\/<challengeId>/);
    }
  });
});

describe("trader profile from flags", () => {
  it("win-rate flags build the parametric trader model", () => {
    const profile = buildProfileFromFlags({
      winrate: "0.52",
      avgWin: "1.8",
      avgLoss: "1",
      tradesPerDay: "3",
      risk: "0.5%",
    });
    expect(profile).toEqual({
      kind: "parametric",
      winRate: 0.52,
      avgWinR: 1.8,
      avgLossR: 1,
      tradesPerDay: 3,
      risk: { mode: "percent-of-balance", value: 0.5 },
    });
  });

  it("the poisson flag makes the daily trade count random instead of fixed", () => {
    const profile = buildProfileFromFlags({
      winrate: "0.5",
      avgWin: "1.5",
      tradesPerDay: "3",
      poisson: true,
      risk: "1%",
    });
    expect(profile).toMatchObject({ tradesPerDayModel: "poisson" });
  });

  it("an R-series of past trades builds the bootstrap trader model", () => {
    const profile = buildProfileFromFlags({ rSeries: TWELVE_TRADES, tradesPerDay: "3", risk: "0.5%" });
    expect(profile.kind).toBe("bootstrap");
    if (profile.kind === "bootstrap") {
      expect(profile.rSeries).toHaveLength(12);
      expect(profile.rSeries[0]).toBe(1.8);
    }
  });

  it("an R-series file is read and parsed the same way as an inline series", () => {
    const profile = buildProfileFromFlags(
      { rSeriesFile: "trades.csv", tradesPerDay: "2", risk: "1%", blockLength: "3" },
      { readFile: () => TWELVE_TRADES },
    );
    expect(profile).toMatchObject({ kind: "bootstrap", blockMeanLength: 3 });
  });

  it("win-rate flags and an R-series cannot be combined - they are different trader models", () => {
    expect(() =>
      buildProfileFromFlags({
        winrate: "0.52",
        rSeries: TWELVE_TRADES,
        tradesPerDay: "3",
        risk: "0.5%",
      }),
    ).toThrow(/pick one trader model/);
  });

  it("an inline R-series and an R-series file cannot both be given", () => {
    expect(() =>
      buildProfileFromFlags({
        rSeries: TWELVE_TRADES,
        rSeriesFile: "trades.csv",
        tradesPerDay: "3",
        risk: "0.5%",
      }),
    ).toThrow(/not both/);
  });

  it("with no trader statistics at all, the error explains both ways to provide them", () => {
    expect(() => buildProfileFromFlags({ tradesPerDay: "3", risk: "0.5%" })).toThrow(
      /--winrate.*--r-series/s,
    );
  });

  it("fewer than 10 recorded trades is not enough to bootstrap from", () => {
    expect(() =>
      buildProfileFromFlags({ rSeries: "1, -1, 2, -1, 1", tradesPerDay: "3", risk: "0.5%" }),
    ).toThrow(/at least 10/);
  });

  it("a win rate outside 0..1 is rejected - it is a fraction, not a percent", () => {
    expect(() =>
      buildProfileFromFlags({ winrate: "52", avgWin: "1.8", tradesPerDay: "3", risk: "0.5%" }),
    ).toThrow(/between 0 and 1/);
  });

  it("trades per day is always required", () => {
    expect(() => buildProfileFromFlags({ winrate: "0.5", avgWin: "1.5", risk: "0.5%" })).toThrow(
      /--trades-per-day/,
    );
  });

  it("risk per trade is required for a simulation, but optional where the command sweeps it", () => {
    const flags = { winrate: "0.5", avgWin: "1.5", tradesPerDay: "3" };
    expect(() => buildProfileFromFlags(flags)).toThrow(/--risk/);
    expect(buildProfileFromFlags(flags, { riskRequired: false }).risk).toMatchObject({
      mode: "percent-of-balance",
    });
  });
});

describe("simulation options from flags", () => {
  it("--no-funded turns off the funded-stage simulation", () => {
    expect(buildSimOptionsFromFlags({ funded: false })).toEqual({ simulateFunded: false });
  });

  it("path counts outside the engine's supported range are rejected up front", () => {
    expect(() => buildSimOptionsFromFlags({ paths: "5" })).toThrow(/between 100 and 1000000/);
  });
});

describe("live directory fetch layer", () => {
  it("reads the keyless public directory endpoint and unwraps the data envelope", async () => {
    const fetchMock = stubFetchDirectory();
    const rows = await fetchDirectory();
    expect(rows.map((r) => r.propfirmId)).toEqual(["firm-one", "nova-futures"]);
    expect(fetchMock).toHaveBeenCalledWith("https://app.luxalgo.com/api/propfirms/list");
  });

  it("LUXALGO_APP_ORIGIN overrides where the directory is fetched from", async () => {
    vi.stubEnv("LUXALGO_APP_ORIGIN", "https://staging.example");
    const fetchMock = stubFetchDirectory();
    await fetchDirectory();
    expect(fetchMock).toHaveBeenCalledWith("https://staging.example/api/propfirms/list");
  });

  it("an unreachable directory says so and points at the fully offline --spec path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const err = await rejectionOf(fetchDirectory());
    expect(err.message).toContain("the live LuxAlgo directory is unreachable");
    expect(err.message).toContain("fetch failed");
    expect(err.message).toContain("work fully offline");
    expect(err.message).toContain("--spec");
  });

  it("an HTTP error carries the status and the same offline fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    const err = await rejectionOf(fetchDirectory());
    expect(err.message).toContain("HTTP 503");
    expect(err.message).toContain("--spec");
  });

  it("errors reported inside the API envelope are surfaced, not swallowed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: {}, errors: [{ message: "directory temporarily disabled" }] }),
      })),
    );
    await expect(fetchDirectory()).rejects.toThrow(/directory temporarily disabled/);
  });

  it("a response without the propfirms array is rejected, never treated as an empty directory", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) })),
    );
    await expect(fetchDirectory()).rejects.toThrow(/data\.propfirms/);
  });
});

describe("target resolution", () => {
  it("--firm/--challenge resolves through the live directory and carries its provenance", async () => {
    stubFetchDirectory();
    const target = await resolveTargetSpec({ firm: "firm-one", challenge: "eval-100k" });
    expect(target.ref).toBe("firm-one/eval-100k");
    expect(target.firmName).toBe("Firm One");
    expect(target.provenance).toBe("directory+inferred");
    expect(target.inferredFields).toContain("maxLoss.mode");
    expect(target.spec).toMatchObject({ accountSize: 100_000 });
  });

  it("a firm can be referenced by its name, case-insensitively", async () => {
    stubFetchDirectory();
    const target = await resolveTargetSpec({ firm: "nova futures funding", challenge: "combine-50k" });
    expect(target.ref).toBe("nova-futures/combine-50k");
    expect(target.provenance).toBe("directory");
    expect(target.inferredFields).toEqual([]);
  });

  it("unknown firms fail listing the firms that exist", async () => {
    stubFetchDirectory();
    await expect(resolveTargetSpec({ firm: "no-such-firm", challenge: "x" })).rejects.toThrow(
      /Known firms: firm-one \(Firm One\), nova-futures \(Nova Futures Funding\)/,
    );
  });

  it("with many firms, unknown-firm errors suggest nearest matches instead of the full list", () => {
    const filler: DirectoryFirmRow[] = Array.from({ length: 15 }, (_, i) => ({
      propfirmId: `filler-funding-${i}`,
      name: `Filler Funding ${i}`,
      productTypes: ["CFD"],
      challenges: [INFERRED_ROW],
    }));
    expect(() => resolveFirm([...DIRECTORY_FIRMS, ...filler], "frim-one")).toThrow(
      /Nearest matches: firm-one \(Firm One\)/,
    );
  });

  it("unknown challenges fail listing the firm's simulatable and refused challenges", async () => {
    stubFetchDirectory();
    await expect(resolveTargetSpec({ firm: "firm-one", challenge: "nope" })).rejects.toThrow(
      /Known challenges: eval-100k.*Not simulatable \(ambiguous rule text\): vague-50k/s,
    );
  });

  it("a challenge whose rule text is ambiguous is refused, not guessed", async () => {
    stubFetchDirectory();
    const err = await rejectionOf(resolveTargetSpec({ firm: "firm-one", challenge: "vague-50k" }));
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toContain("not simulatable: ambiguous rule text, refused rather than guessed");
    expect(err.message).toContain("Known challenges: eval-100k");
  });

  it("a directory target and a spec file cannot both be given", async () => {
    await expect(
      resolveTargetSpec({ firm: "firm-one", challenge: "eval-100k", spec: "x.json" }),
    ).rejects.toThrow(/not both/);
  });

  it("a spec file that is not valid JSON fails with the file named", async () => {
    await expect(resolveTargetSpec({ spec: "bad.json" }, { readFile: () => "{nope" })).rejects.toThrow(
      /bad\.json.*JSON/,
    );
  });

  it("inline spec files never touch the network", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network disabled");
    });
    vi.stubGlobal("fetch", fetchMock);
    const target = await resolveTargetSpec(
      { spec: "my-challenge.json" },
      { readFile: () => JSON.stringify({ challengeId: "diy", accountSize: 25_000 }) },
    );
    expect(target.ref).toBe("my-challenge.json");
    expect(target.provenance).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("firms listing", () => {
  it("the listing shows adapted challenges with provenance, and refused ones separately", () => {
    const listing = buildFirmsListing(DIRECTORY_FIRMS);
    expect(listing.challenges.map((c) => c.challengeId)).toEqual(["eval-100k", "combine-50k"]);
    expect(listing.challenges[0]).toMatchObject({ provenance: "directory+inferred", price: 480 });
    expect(listing.challenges[1]).toMatchObject({ provenance: "directory", price: null });
    expect(listing.notSimulatable).toEqual([
      {
        propfirmId: "firm-one",
        firmName: "Firm One",
        challengeId: "vague-50k",
        challengeName: "Vague 50K",
        reason: "ambiguous rule text",
      },
    ]);

    const view = renderFirmsList(listing);
    expect(view).toContain("firm-one");
    expect(view).toContain("Firm One");
    expect(view).toContain("eval-100k");
    expect(view).toContain("Evaluation 100K");
    expect(view).toContain("100,000 USD");
    expect(view).toContain("480 USD");
    expect(view).toContain("n/a"); // combine-50k has no listed price
    expect(view).toContain("directory+inferred");
    expect(flat(view)).toContain("not simulatable: ambiguous rule text");
    expect(flat(view)).toContain("firm-one/vague-50k (Vague 50K)");
    expect(flat(view)).toContain("live LuxAlgo directory, the data behind luxalgo.com/prop-firms");
    expect(flat(view)).toContain("own pages are authoritative");
    expect(flat(view)).toContain(flat(DISCLAIMER));
  });

  it("the product-type filter narrows the listing to matching firms", () => {
    const futuresOnly = buildFirmsListing(DIRECTORY_FIRMS, { productType: "futures" });
    expect(futuresOnly.challenges.map((c) => c.challengeId)).toEqual(["combine-50k"]);
    expect(futuresOnly.notSimulatable).toEqual([]);
  });
});

describe("simulate report", () => {
  const adapted = requireAdaptedChallenge(FIRM_ONE, "eval-100k");
  const profile = buildProfileFromFlags({
    winrate: "0.52",
    avgWin: "1.8",
    avgLoss: "1",
    tradesPerDay: "3",
    risk: "0.5%",
  });

  it("a firm+challenge reference resolves through the live directory, runs, and states its provenance", async () => {
    stubFetchDirectory();
    const target = await resolveTargetSpec({ firm: "firm-one", challenge: "eval-100k" });
    const result = simulate(target.spec, profile, { paths: 500, seed: 7 });
    expect(result.perAttempt.passProbability).toBeGreaterThan(0);
    const report = renderSimulateReport(result, {
      ref: target.ref,
      firmName: target.firmName ?? "",
      provenance: target.provenance ?? "directory",
      inferredFields: target.inferredFields ?? [],
    });
    expect(report).toContain("Pass probability per attempt");
    expect(report).toMatch(/95% CI \d+\.\d–\d+\.\d%/);
    expect(report).toContain("Step 1 · target +8%");
    expect(report).toContain("Step 2 · target +5%");
    expect(report).toContain("USD");
    expect(report).toContain("firm-one/eval-100k");
    expect(flat(report)).toContain("Data: live LuxAlgo directory");
    expect(flat(report)).toContain(
      "inferred from free text: maxLoss.mode, dailyLoss.semantics, funded.payoutFrequency",
    );
  });

  it("the report always ends with every assumption flag and the core disclaimer", () => {
    const result = simulate(adapted.spec, profile, { paths: 500, seed: 7 });
    const report = renderSimulateReport(result, { ref: "firm-one/eval-100k" });
    expect(report).toContain("Not simulated / assumptions:");
    expect(result.assumptions.flags.length).toBeGreaterThan(0);
    for (const flag of result.assumptions.flags) {
      expect(report).toContain(flag.id);
      expect(flat(report)).toContain(flat(flag.detail));
    }
    expect(flat(report)).toContain(flat(DISCLAIMER));
    // The disclaimer is the last thing on screen.
    expect(flat(report).trimEnd().endsWith(flat(DISCLAIMER))).toBe(true);
  });

  it("the report shows the chance and timing of a first payout once funded, and average attempt lengths", () => {
    const combine = requireAdaptedChallenge(NOVA, "combine-50k");
    const trader = buildProfileFromFlags({
      winrate: "0.55",
      avgWin: "1.6",
      tradesPerDay: "4",
      risk: "0.5%",
      riskMode: "percent-of-initial",
    });
    const result = simulate(combine.spec, trader, { paths: 500, seed: 11 });
    const report = renderSimulateReport(result, { ref: "nova-futures/combine-50k" });

    expect(result.funded?.payoutProbability).toBeGreaterThan(0);
    expect(report).toContain("Payout probability | funded");
    expect(report).toContain("Days to 1st payout");
    expect(report).toMatch(/Avg days per attempt\s+[\d.]+ when passed · [\d.]+ when failed/);
  });

  it("the report shows how long equity typically stagnates without a new high", () => {
    const result = simulate(adapted.spec, profile, { paths: 500, seed: 7 });
    const report = renderSimulateReport(result, { ref: "firm-one/eval-100k" });
    expect(report).toMatch(
      /Stagnation \(days without a new equity high\)\s+p50 \d+(\.\d+)? · p90 \d+(\.\d+)?/,
    );
  });

  it("a run where no path gets funded still renders, with n/a instead of numbers", () => {
    const hopeless = buildProfileFromFlags({
      winrate: "0.01",
      avgWin: "0.5",
      tradesPerDay: "2",
      risk: "0.25%",
    });
    const result = simulate(adapted.spec, hopeless, { paths: 200, seed: 3, attemptCap: 1 });
    expect(result.journey.fundedProbability).toBe(0);
    const report = renderSimulateReport(result);
    expect(report).toContain("n/a: no path got funded");
    expect(flat(report)).toContain(flat(DISCLAIMER));
  });
});

describe("rules and compare views", () => {
  it("the rules view shows provenance, the inferred fields, and the directory citation", () => {
    const adapted = requireAdaptedChallenge(FIRM_ONE, "eval-100k");
    const view = renderRulesReport(adapted);
    expect(view).toContain("Firm One · Evaluation 100K");
    expect(view).toContain("firm-one/eval-100k · cfd · account 100,000 USD · live LuxAlgo directory");
    expect(flat(view)).toContain(
      "directory+inferred, inferred from free text: maxLoss.mode, dailyLoss.semantics, funded.payoutFrequency",
    );
    expect(view).toContain("https://firm-one.example/rules");
    expect(view).toContain("2026-08-20");
    expect(flat(view)).toContain("the firm's own page is always authoritative");
    expect(flat(view)).toContain(flat(DISCLAIMER));
  });

  it("a fully structured challenge shows directory provenance, its locking trail, and payout gating", () => {
    const adapted = requireAdaptedChallenge(NOVA, "combine-50k");
    const view = renderRulesReport(adapted);
    expect(flat(view)).toContain("directory, every simulated rule read from a structured directory column");
    expect(flat(view)).not.toContain("inferred from free text");
    expect(flat(view)).toContain("locks once the floor reaches the starting balance + 100 USD");
    expect(flat(view)).toContain("payout gating (simulated): requires 3 winning days of 100 USD+ each");
    expect(flat(view)).toContain("a 1,000 USD profit buffer stays in the account");
    expect(flat(view)).toContain("none served by the directory for this challenge");
  });

  it("the compare view labels itself as sorted by EV for the user's inputs, and states each ref's provenance", () => {
    const evalAdapted = requireAdaptedChallenge(FIRM_ONE, "eval-100k");
    const combineAdapted = requireAdaptedChallenge(NOVA, "combine-50k");
    const profile = buildProfileFromFlags({
      winrate: "0.52",
      avgWin: "1.8",
      tradesPerDay: "3",
      risk: "0.5%",
    });
    const comparison = compare(
      [
        { firmId: "firm-one", firmName: "Firm One", spec: evalAdapted.spec },
        { firmId: "nova-futures", firmName: "Nova Futures Funding", spec: combineAdapted.spec },
      ],
      profile,
      { paths: 300, seed: 5 },
    );
    const view = renderCompareReport(comparison, {
      provenance: [
        {
          ref: "firm-one/eval-100k",
          provenance: evalAdapted.provenance,
          inferredFields: evalAdapted.inferredFields,
        },
        {
          ref: "nova-futures/combine-50k",
          provenance: combineAdapted.provenance,
          inferredFields: combineAdapted.inferredFields,
        },
      ],
    });
    expect(view).toContain("Sorted by EV for your inputs, not a ranking.");
    expect(view).toContain("Data: live LuxAlgo directory");
    expect(flat(view)).toContain(
      "firm-one/eval-100k: directory+inferred, inferred from free text: maxLoss.mode",
    );
    expect(flat(view)).toContain("nova-futures/combine-50k: directory,");
    expect(view).toContain("firm-one");
    expect(view).toContain("PAYOUT%"); // chance of at least one payout once funded
    expect(flat(view)).toContain(flat(DISCLAIMER));
  });
});

/* ------------------------------------------------------------------ */
/* Trade logs, news windows, and multi-account overlap                */
/* ------------------------------------------------------------------ */

/*
  Timestamped-log fixtures. June 2026 puts one deterministic high-impact USD
  event inside the range: Non-Farm Payrolls on the first Friday (June 5) at
  8:30 ET = 12:30 UTC (US DST active), so the default 30-minute windows cover
  12:00-13:00 UTC exactly.
*/
function tradeLogCsv(rows: string[]): string {
  return ["openedAt,closedAt,direction,r", ...rows].join("\n");
}

const LOG_A_CSV = tradeLogCsv([
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
const LOG_B_CSV = tradeLogCsv([
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

const TRADE_LOG_FILES: Record<string, string> = {
  "a.csv": LOG_A_CSV,
  "b.csv": LOG_B_CSV,
  "bad.csv": "this is not a trade log",
};

function readTradeLog(path: string): string {
  const text = TRADE_LOG_FILES[path];
  if (text === undefined) throw new Error(`ENOENT: no such file "${path}"`);
  return text;
}

describe("trade-log trader model", () => {
  it("a timestamped trade-log file builds the bootstrap trader and derives trades per day from its timestamps", () => {
    const plan = buildTradeLogPlan({ tradeLog: ["a.csv"], risk: "0.5%" }, { readFile: readTradeLog });
    expect(plan.profile.kind).toBe("bootstrap");
    if (plan.profile.kind === "bootstrap") {
      expect(plan.profile.rSeries).toHaveLength(12);
      expect(plan.profile.rSeries[0]).toBe(1.2);
      // 12 trades over 5 distinct UTC days = 2.4 trades/day.
      expect(plan.profile.tradesPerDay).toBeCloseTo(2.4, 6);
    }
    expect(plan.derivedTradesPerDay).toBeCloseTo(2.4, 6);
    expect(plan.historyCount).toBe(1);
    expect(plan.overlap).toBeNull();
    expect(plan.news).toBeNull();
    // The log has no timezone offsets; the assumed-UTC warning is passed on, file-tagged.
    expect(plan.warnings.some((w) => w.startsWith("a.csv:") && w.includes("read as UTC"))).toBe(true);
  });

  it("--trades-per-day overrides the trade frequency derived from the log", () => {
    const plan = buildTradeLogPlan(
      { tradeLog: ["a.csv"], tradesPerDay: "3", risk: "0.5%" },
      { readFile: readTradeLog },
    );
    if (plan.profile.kind === "bootstrap") expect(plan.profile.tradesPerDay).toBe(3);
    expect(plan.derivedTradesPerDay).toBeNull();
  });

  it("trade logs cannot be mixed with win-rate or R-series flags, because the log is the trader model", () => {
    expect(() =>
      buildTradeLogPlan(
        { tradeLog: ["a.csv"], winrate: "0.5", avgWin: "1.5", risk: "0.5%" },
        { readFile: readTradeLog },
      ),
    ).toThrow(/--winrate.*pick one/s);
    expect(() =>
      buildTradeLogPlan(
        { tradeLog: ["a.csv"], rSeries: TWELVE_TRADES, risk: "0.5%" },
        { readFile: readTradeLog },
      ),
    ).toThrow(/--r-series/);
  });

  it("at most five trade logs can be merged into a portfolio", () => {
    expect(() =>
      buildTradeLogPlan(
        { tradeLog: ["a.csv", "b.csv", "a.csv", "b.csv", "a.csv", "b.csv"], risk: "0.5%" },
        { readFile: readTradeLog },
      ),
    ).toThrow(/at most 5/);
  });

  it("a file with no parseable trades is refused with the parser's reason", () => {
    expect(() =>
      buildTradeLogPlan({ tradeLog: ["bad.csv"], risk: "0.5%" }, { readFile: readTradeLog }),
    ).toThrow(/"bad\.csv" contains no parseable trades/);
    expect(() =>
      buildTradeLogPlan({ tradeLog: ["missing.csv"], risk: "0.5%" }, { readFile: readTradeLog }),
    ).toThrow(/cannot read trade log "missing\.csv"/);
  });

  it("two heavily overlapping logs merge into one portfolio series and flag high audit risk", () => {
    const plan = buildTradeLogPlan(
      { tradeLog: ["a.csv", "b.csv"], risk: "0.5%" },
      { readFile: readTradeLog },
    );
    expect(plan.historyCount).toBe(2);
    expect(plan.entries).toHaveLength(24);
    if (plan.profile.kind === "bootstrap") {
      expect(plan.profile.rSeries).toHaveLength(24);
      expect(plan.profile.tradesPerDay).toBeCloseTo(4.8, 6); // 24 trades over 5 days
    }
    expect(plan.overlap).not.toBeNull();
    expect(plan.overlap?.auditRisk).toBe("high");
    expect(plan.overlap?.disclosure).toBe(OVERLAP_DISCLOSURE);
  });
});

describe("importing real broker exports through --trade-log", () => {
  const TV_EXPORT = [
    "Trade number,Type,Date and time,Signal,Price USD,Size (qty),Net PnL USD",
    ...Array.from({ length: 12 }, (_, i) => {
      const day = String(2 + i).padStart(2, "0");
      const pnl = i % 3 === 0 ? -20 : 25;
      return [
        `${12 - i},Exit long,2026-06-${day} 15:00,TP,101.00,1,${pnl}`,
        `${12 - i},Entry long,2026-06-${day} 10:00,Long,100.00,1,${pnl}`,
      ].join("\n");
    }),
  ].join("\n");

  it("a TradingView export with no risk data is refused with the exact flag to pass", () => {
    expect(() => loadTradeLogs(["tv.csv"], { readFile: () => TV_EXPORT })).toThrow(/--import-risk/);
  });

  it("--import-risk converts it, and the trades bootstrap like any timestamped log", () => {
    const loaded = loadTradeLogs(["tv.csv"], { readFile: () => TV_EXPORT, importRisk: "25" });
    expect(loaded.histories[0]).toHaveLength(12);
    expect(loaded.histories[0]![0]!.r).toBeCloseTo(-20 / 25);
    const plan = buildTradeLogPlan(
      { tradeLog: ["tv.csv"], risk: "0.5%", importRisk: "25" },
      { readFile: () => TV_EXPORT },
    );
    expect(plan.profile.kind).toBe("bootstrap");
  });

  it("UTF-16LE bytes (MetaTrader's save format) decode by BOM on the way in", () => {
    const csv = [
      "Ticket,Open Time,Type,Size,Item,Price,S/L,T/P,Close Time,Price,Commission,Taxes,Swap,Profit",
      ...Array.from({ length: 10 }, (_, i) => {
        const day = String(2 + i).padStart(2, "0");
        return `${i},2026.02.${day} 10:00,buy,0.50,EURUSD,1.08000,1.07500,0,2026.02.${day} 14:00,1.09000,-3.50,0.00,0.00,250.00`;
      }),
    ].join("\n");
    const bytes = new Uint8Array(2 + csv.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < csv.length; i++) {
      bytes[2 + i * 2] = csv.charCodeAt(i) & 0xff;
      bytes[3 + i * 2] = csv.charCodeAt(i) >> 8;
    }
    const loaded = loadTradeLogs(["statement.csv"], { readFile: () => bytes });
    expect(loaded.histories[0]).toHaveLength(10);
    expect(loaded.histories[0]![0]!.r).toBeCloseTo(246.5 / 125, 6); // stop 0.005 away, move 0.010: risk 125
  });

  it("--import-risk validates its shape before any file is read", () => {
    expect(parseImportRiskFlag("25")).toEqual({ type: "fixed-cash", amount: 25 });
    expect(parseImportRiskFlag("1%")).toEqual({ type: "percent-of-entry-value", percent: 1 });
    expect(() => parseImportRiskFlag("-3")).toThrow(UsageError);
    expect(() => parseImportRiskFlag("lots")).toThrow(UsageError);
  });
});

describe("news avoidance", () => {
  it("news flags without a trade log are rejected, because windows match against timestamps", () => {
    expect(() => assertNewsNeedsTradeLog({ avoidNews: true })).toThrow(/--trade-log/);
    expect(() => assertNewsNeedsTradeLog({ newsPre: "15" })).toThrow(/--trade-log/);
    expect(() => assertNewsNeedsTradeLog({})).not.toThrow();
  });

  it("avoiding news excludes only trades opened inside event windows and keeps both scenarios comparable", () => {
    const plan = buildTradeLogPlan(
      { tradeLog: ["a.csv"], risk: "0.5%", avoidNews: true, newsCurrencies: "usd" },
      { readFile: readTradeLog },
    );
    expect(plan.news).not.toBeNull();
    const news = plan.news!;
    expect(news.eventsInRange).toBe(1); // NFP, Friday June 5 2026, 12:30 UTC
    expect(news.excluded).toHaveLength(2); // opened 12:10 and 12:45 UTC
    expect(news.heldThroughCount).toBe(1); // opened 11:00, closed 14:00
    expect(plan.simulatedEntries).toHaveLength(10);
    expect(plan.originalProfile).not.toBeNull();
    if (plan.profile.kind === "bootstrap") expect(plan.profile.rSeries).toHaveLength(10);
    if (plan.originalProfile?.kind === "bootstrap") {
      expect(plan.originalProfile.rSeries).toHaveLength(12);
    }

    const adapted = requireAdaptedChallenge(FIRM_ONE, "eval-100k");
    const options = { paths: 300, seed: 5 };
    const original = simulate(adapted.spec, plan.originalProfile!, options);
    const avoided = simulate(adapted.spec, plan.profile, options);
    const comparison = buildNewsComparison(original, avoided, news);
    expect(comparison.original.passProbability).toBe(original.perAttempt.passProbability);
    expect(comparison.newsAvoided.passProbability).toBe(avoided.perAttempt.passProbability);
    expect(comparison.excludedTrades).toBe(2);
    expect(comparison.options).toMatchObject({ preMinutes: 30, postMinutes: 30, impacts: ["high"] });
    expect(comparison.caveat).toBe(NEWS_CALENDAR_CAVEAT);
  });

  it("invalid impact and currency lists are rejected with the valid values listed", () => {
    expect(() => buildNewsOptions({ avoidNews: "extreme" })).toThrow(/low, medium, high/);
    expect(() => buildNewsOptions({ avoidNews: true, newsCurrencies: "USD,XYZ" })).toThrow(/USD, EUR/);
    expect(() => buildNewsOptions({ newsPre: "10" })).toThrow(/--avoid-news/);
    expect(buildNewsOptions({ avoidNews: "medium,high", newsPre: "45" })).toEqual({
      impacts: ["medium", "high"],
      preMinutes: 45,
    });
  });
});

describe("overlap report", () => {
  it("the overlap view shows per-pair shares, a prominent high-risk verdict, and the disclosure", () => {
    const loaded = loadTradeLogs(["a.csv", "b.csv"], { readFile: readTradeLog, minLogs: 2 });
    const report = analyzeOverlap(loaded.histories);
    expect(report.auditRisk).toBe("high");

    const view = renderOverlapReport(report, {
      files: loaded.files,
      tradeCounts: loaded.histories.map((history) => history.length),
    });
    expect(view).toContain("Multi-account position overlap");
    expect(view).toContain("a.csv (12 trades)");
    expect(view).toContain("b.csv (12 trades)");
    expect(view).toContain("1x2");
    expect(view).toContain("AUDIT RISK: HIGH");
    expect(flat(view)).toContain("the firm may audit or refuse payouts for correlated accounts");
    expect(flat(view)).toContain(flat(OVERLAP_DISCLOSURE));
  });

  it("the overlap command needs at least two trade logs to compare", () => {
    expect(() => loadTradeLogs(["a.csv"], { readFile: readTradeLog, minLogs: 2 })).toThrow(/at least 2/);
  });
});

describe("simulate report with trade logs", () => {
  it("renders the log source, the overlap warning, and the news comparison, with the disclaimer still last", () => {
    const plan = buildTradeLogPlan(
      { tradeLog: ["a.csv", "b.csv"], risk: "0.5%", avoidNews: true, newsCurrencies: "USD" },
      { readFile: readTradeLog },
    );
    const adapted = requireAdaptedChallenge(FIRM_ONE, "eval-100k");
    const options = { paths: 300, seed: 7 };
    const result = simulate(adapted.spec, plan.profile, options); // news-avoided run
    const original = simulate(adapted.spec, plan.originalProfile!, options);

    const report = renderSimulateReport(result, {
      ref: "firm-one/eval-100k",
      tradeLog: {
        files: plan.files,
        trades: plan.simulatedEntries.length,
        distinctDays: plan.distinctDays,
        historyCount: plan.historyCount,
        derivedTradesPerDay: plan.derivedTradesPerDay,
      },
      overlap: plan.overlap!,
      news: { original, filter: plan.news! },
    });

    expect(flat(report)).toContain("Trade log: 2 logs merged: a.csv, b.csv");
    expect(flat(report)).toContain("derived from timestamps");
    expect(report).toContain("AUDIT RISK: HIGH");
    expect(flat(report)).toContain("the firm may audit or refuse payouts for correlated accounts");
    expect(flat(report)).toContain(flat(OVERLAP_DISCLOSURE));
    expect(report).toContain("News avoidance");
    expect(report).toMatch(/Pass\/attempt: original \d+\.\d% vs news-avoided \d+\.\d%/);
    expect(report).toContain("Excluded trades: 4"); // both logs trade inside the NFP window
    expect(flat(report)).toContain(flat(NEWS_CALENDAR_CAVEAT));
    // The honesty tail still closes the report.
    expect(flat(report).trimEnd().endsWith(flat(DISCLAIMER))).toBe(true);
  });
});
