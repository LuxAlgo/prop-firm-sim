import { describe, expect, it } from "vitest";
import {
  analyzeOverlap,
  expandRecurringEvents,
  filterTradesAroundNews,
  mergeTradeLogs,
  parseTimestamp,
  parseTradeLog,
  simulate,
  toBootstrapInputs,
  type TradeLogEntry,
} from "../src/index.js";

/*
  Context tools around timestamped trade logs: parsing must be deterministic
  (UTC, no machine timezone), the recurring news calendar must land events on
  the documented schedule including DST shifts, window filtering must respect
  the user's pre/post minutes, and portfolio overlap must flag what a prop-firm
  reviewer would see. These defend behavior a trader relies on, not the code.
*/

const trade = (openedAt: string, r: number, extra: Partial<TradeLogEntry> = {}): TradeLogEntry => ({
  openedAt: parseTimestamp(openedAt),
  closedAt: null,
  direction: null,
  r,
  ...extra,
});

describe("trade log parsing", () => {
  it("parses CSV with loose headers, sorts by time, and reads times as UTC", () => {
    const { entries, warnings } = parseTradeLog(
      [
        "Open Time,Close Time,Side,R",
        "2026.03.10 14:05,2026.03.10 15:00,buy,1.8R",
        "2026.03.09 09:30,2026.03.09 10:00,sell,-1",
      ].join("\n"),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]!.direction).toBe("short"); // sorted: the 9th comes first
    expect(entries[0]!.r).toBe(-1);
    expect(entries[1]!.openedAt).toBe(Date.UTC(2026, 2, 10, 14, 5));
    expect(entries[1]!.closedAt).toBe(Date.UTC(2026, 2, 10, 15, 0));
    expect(warnings.some((w) => w.includes("UTC"))).toBe(true);
  });

  it("honors explicit timezone offsets and skips bad rows with a warning", () => {
    const { entries, warnings } = parseTradeLog(
      ["time,r", "2026-03-10T09:05:00-05:00,1.2", "not-a-date,1.0", "2026-03-10T14:05:00Z,0.5"].join("\n"),
    );
    expect(entries).toHaveLength(2);
    // 09:05 -05:00 equals 14:05 UTC: both rows are the same instant.
    expect(entries[0]!.openedAt).toBe(entries[1]!.openedAt);
    expect(warnings.some((w) => w.includes("Row 3 skipped"))).toBe(true);
    expect(warnings.some((w) => w.includes("UTC"))).toBe(false); // offsets were present
  });

  it("accepts fractional-second ISO timestamps, the format Date.toISOString produces", () => {
    // Platform exports (and anything built on toISOString) emit ".000Z";
    // rejecting them would bounce the most common machine-written log format.
    const { entries } = parseTradeLog(
      ["time,r", "2026-03-10T14:05:00.000Z,1.2", "2026-03-10T15:05:00.123456-05:00,-1"].join("\n"),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]!.openedAt).toBe(Date.UTC(2026, 2, 10, 14, 5));
    expect(entries[1]!.openedAt).toBe(Date.UTC(2026, 2, 10, 20, 5)); // fraction truncated, offset applied
  });

  it("derives bootstrap inputs: chronological R series and trades per distinct day", () => {
    const { entries } = parseTradeLog(
      ["time,r", "2026-01-05 10:00,1", "2026-01-05 12:00,-1", "2026-01-06 10:00,2"].join("\n"),
    );
    const inputs = toBootstrapInputs(entries);
    expect(inputs.rSeries).toEqual([1, -1, 2]);
    expect(inputs.distinctDays).toBe(2);
    expect(inputs.tradesPerDay).toBeCloseTo(1.5);
  });
});

describe("recurring news calendar", () => {
  it("puts NFP on the first Friday at 8:30 New York time across the DST change", () => {
    const events = expandRecurringEvents(Date.UTC(2026, 0, 1), Date.UTC(2026, 3, 30), {
      impacts: ["high"],
      currencies: ["USD"],
    });
    const nfp = events.filter((e) => e.templateId === "usd-nfp");
    // January 2026: first Friday is the 2nd; EST puts 8:30 ET at 13:30 UTC.
    expect(nfp[0]!.at).toBe(Date.UTC(2026, 0, 2, 13, 30));
    // April 2026: first Friday is the 3rd; EDT puts 8:30 ET at 12:30 UTC.
    const april = nfp.find((e) => new Date(e.at).getUTCMonth() === 3)!;
    expect(april.at).toBe(Date.UTC(2026, 3, 3, 12, 30));
  });

  it("expands weekly events every week and respects impact/currency filters", () => {
    const events = expandRecurringEvents(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31), {
      impacts: ["medium"],
      currencies: ["USD"],
    });
    const claims = events.filter((e) => e.templateId === "usd-jobless");
    expect(claims.length).toBeGreaterThanOrEqual(51); // every Thursday of the year
    expect(events.every((e) => e.impact === "medium" && e.currency === "USD")).toBe(true);
  });
});

describe("news-window filtering", () => {
  // NFP for June 2026: first Friday is the 5th, 8:30 ET = 12:30 UTC (EDT).
  const NFP = Date.UTC(2026, 5, 5, 12, 30);

  it("excludes trades opened inside the configurable pre/post window and keeps the rest", () => {
    const entries = [
      trade("2026-06-05 12:25", 1), // 5 min before: inside a 10-min pre window
      trade("2026-06-05 12:45", -1), // 15 min after: inside a 30-min post window
      trade("2026-06-05 11:00", 0.5), // 90 min before: outside
      trade("2026-06-04 12:30", 2), // wrong day entirely
    ];
    const result = filterTradesAroundNews(entries, {
      preMinutes: 10,
      postMinutes: 30,
      impacts: ["high"],
      currencies: ["USD"],
    });
    expect(result.excluded.map((x) => x.entry.r).sort()).toEqual([-1, 1]);
    expect(result.kept.map((x) => x.r).sort()).toEqual([0.5, 2]);
    expect(result.excluded.every((x) => x.event.at === NFP)).toBe(true);
    expect(result.caveat).toContain("recurring-template");
  });

  it("a tighter pre window keeps a trade a looser one would exclude", () => {
    const entries = [trade("2026-06-05 12:22", 1)]; // 8 minutes before NFP
    const loose = filterTradesAroundNews(entries, { preMinutes: 10, postMinutes: 10, currencies: ["USD"] });
    const tight = filterTradesAroundNews(entries, { preMinutes: 3, postMinutes: 10, currencies: ["USD"] });
    expect(loose.excluded).toHaveLength(1);
    expect(tight.excluded).toHaveLength(0);
  });

  it("counts positions held through an event separately instead of excluding them", () => {
    const entries = [
      trade("2026-06-05 10:00", 1, { closedAt: Date.UTC(2026, 5, 5, 14, 0) }), // held through NFP
    ];
    const result = filterTradesAroundNews(entries, { preMinutes: 30, postMinutes: 30, currencies: ["USD"] });
    expect(result.kept).toHaveLength(1);
    expect(result.heldThroughCount).toBe(1);
  });

  it("custom exact event times work without any built-in template", () => {
    const at = Date.UTC(2026, 5, 10, 9, 0);
    const entries = [trade("2026-06-10 09:05", 1), trade("2026-06-10 12:00", -1)];
    const result = filterTradesAroundNews(entries, {
      impacts: [],
      customEventTimes: [at],
      preMinutes: 15,
      postMinutes: 15,
    });
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]!.event.templateId).toBe("custom");
  });
});

describe("portfolio merge and overlap audit risk", () => {
  const dupe = (minutesShift: number, direction: "long" | "short"): TradeLogEntry[] =>
    [0, 1, 2, 3, 4].map((i) => ({
      openedAt: Date.UTC(2026, 2, 2, 10, i * 30 + minutesShift),
      closedAt: Date.UTC(2026, 2, 2, 10, i * 30 + minutesShift + 20),
      direction,
      r: i % 2 === 0 ? 1.5 : -1,
    }));

  it("near-identical same-direction histories flag high audit risk", () => {
    const report = analyzeOverlap([dupe(0, "long"), dupe(2, "long")], { toleranceMinutes: 5 });
    expect(report.overallOverlapShare).toBe(1);
    expect(report.sameDirectionShare).toBe(1);
    expect(report.auditRisk).toBe("high");
    expect(report.verdict).toContain("audit");
    expect(report.disclosure).toContain("discretionary");
  });

  it("opposite-direction simultaneous trades are hedging, not copying", () => {
    const report = analyzeOverlap([dupe(0, "long"), dupe(2, "short")]);
    expect(report.sameDirectionShare).toBe(0);
    expect(report.auditRisk).toBe("low");
  });

  it("time-disjoint histories are low risk", () => {
    const morning = dupe(0, "long");
    const evening = morning.map((t) => ({
      ...t,
      openedAt: t.openedAt + 8 * 3_600_000,
      closedAt: t.closedAt! + 8 * 3_600_000,
    }));
    const report = analyzeOverlap([morning, evening]);
    expect(report.overallOverlapShare).toBe(0);
    expect(report.auditRisk).toBe("low");
  });

  it("missing direction columns still count time overlap, labeled unknown", () => {
    const a = dupe(0, "long").map((t) => ({ ...t, direction: null }));
    const report = analyzeOverlap([a, dupe(2, "long")]);
    expect(report.overallOverlapShare).toBe(1);
    expect(report.sameDirectionShare).toBe(0);
    expect(report.unknownDirectionShare).toBeCloseTo(0.5);
    expect(report.pairs[0]!.directionUnknown).toBeGreaterThan(0);
  });

  it("merges histories chronologically for a combined-account simulation", () => {
    const merged = mergeTradeLogs([dupe(0, "long"), dupe(7, "short")]);
    expect(merged.entries).toHaveLength(10);
    expect(merged.historyCount).toBe(2);
    for (let i = 1; i < merged.entries.length; i++) {
      expect(merged.entries[i]!.openedAt).toBeGreaterThanOrEqual(merged.entries[i - 1]!.openedAt);
    }
    expect(merged.tradesPerDay).toBe(10); // one distinct trading day
  });
});

describe("stagnation metric", () => {
  const spec = (maxDays: number) => ({
    challengeId: "stagnation-probe",
    name: "Stagnation Probe",
    accountSize: 100_000,
    steps: [{ profitTargetPct: 8, maxDays }],
    dailyLoss: null,
    maxLoss: { pct: 90, mode: "static-initial" as const },
    fees: { price: 100 },
    funded: { profitSplitPct: 80, payoutFrequency: "monthly" as const },
  });

  it("a trader who only loses stagnates for the whole capped step; one who only wins never does", () => {
    const loser = simulate(
      spec(10),
      {
        kind: "parametric",
        winRate: 0,
        avgWinR: 1,
        tradesPerDay: 1,
        risk: { mode: "percent-of-initial", value: 0.1 },
      },
      { paths: 100, seed: 1, simulateFunded: false, includeHistograms: false },
    );
    expect(loser.perAttempt.stagnationDays.min).toBe(10);
    expect(loser.perAttempt.stagnationDays.max).toBe(10);

    const winner = simulate(
      spec(10),
      {
        kind: "parametric",
        winRate: 1,
        avgWinR: 1,
        tradesPerDay: 1,
        risk: { mode: "percent-of-initial", value: 1 },
      },
      { paths: 100, seed: 1, simulateFunded: false, includeHistograms: false },
    );
    expect(winner.perAttempt.stagnationDays.max).toBe(0);
  });

  it("stagnation grows as risk per trade shrinks (the user-facing claim)", () => {
    const profile = (risk: number) => ({
      kind: "parametric" as const,
      winRate: 0.5,
      avgWinR: 1.5,
      tradesPerDay: 3,
      risk: { mode: "percent-of-initial" as const, value: risk },
    });
    const options = { paths: 2000, seed: 42, simulateFunded: false, includeHistograms: false };
    const small = simulate(spec(200), profile(0.25), options);
    const large = simulate(spec(200), profile(2), options);
    expect(small.perAttempt.stagnationDays.p50).toBeGreaterThan(large.perAttempt.stagnationDays.p50);
  });
});
