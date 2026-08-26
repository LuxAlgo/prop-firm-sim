import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeImportBytes,
  detectInputKind,
  GENERIC_CSV_TEMPLATE,
  importTradeHistory,
  parseTraderInput,
  toTradeLogEntries,
} from "../src/index.js";

/*
  End-to-end importer behavior on realistic export fixtures. Every file
  either imports cleanly or refuses with actionable diagnostics; nothing
  throws, nothing is silently mangled. The negative assertions are the
  point: a plausible-looking wrong trade is the one failure this layer must
  never produce.
*/

const FIXTURES = fileURLToPath(new URL("./fixtures/import/", import.meta.url));

function fixtureText(name: string): string {
  return decodeImportBytes(new Uint8Array(readFileSync(FIXTURES + name))).text;
}

function codes(result: { issues: Array<{ code: string }> }): string[] {
  return result.issues.map((issue) => issue.code);
}

describe("input routing", () => {
  it("plain R-series pastes never touch the tabular machinery", () => {
    expect(detectInputKind("1.8, -1, 2.4R")).toBe("r-series");
    expect(detectInputKind("[1.5, -1]")).toBe("r-series");
    const parsed = parseTraderInput("1.8, -1, 2.4R");
    expect(parsed.kind).toBe("r-series");
    if (parsed.kind === "r-series") expect(parsed.rSeries).toEqual([1.8, -1, 2.4]);
  });

  it("a single numeric column under an r-ish header is still an R-series", () => {
    const parsed = parseTraderInput("r\n1.5\n-1\n0.8");
    expect(parsed.kind).toBe("r-series");
    if (parsed.kind === "r-series") {
      expect(parsed.rSeries).toEqual([1.5, -1, 0.8]);
      expect(parsed.issues.some((i) => i.code === "r-header-skipped")).toBe(true);
    }
  });

  it("a TradingView CSV pasted into the same box routes to the importer instead of dying on a token", () => {
    const parsed = parseTraderInput(fixtureText("tradingview-gen2.csv"));
    expect(parsed.kind).toBe("import");
    if (parsed.kind === "import") expect(parsed.result.format.kind).toBe("tradingview");
  });

  it("an invalid JSON array reports an issue instead of throwing", () => {
    const parsed = parseTraderInput('["not", "numbers"]');
    expect(parsed.kind).toBe("r-series");
    if (parsed.kind === "r-series") {
      expect(parsed.rSeries).toEqual([]);
      expect(parsed.issues.some((i) => i.severity === "error")).toBe(true);
    }
  });
});

describe("TradingView strategy tester", () => {
  it("generation 2: two rows per trade pair up, totals read once, the open trade is separated", () => {
    const result = importTradeHistory(fixtureText("tradingview-gen2.csv"));
    expect(result.ok).toBe(true);
    expect(result.format.kind).toBe("tradingview");
    expect(result.format.confidence).toBe("exact");
    expect(result.trades).toHaveLength(3);
    expect(result.openTrades).toHaveLength(1);
    const pnls = result.trades.map((t) => t.pnl);
    expect(pnls).toEqual([45, -10.2, 19.6]); // chronological, never doubled by the mirror
    expect(result.trades[1]!.direction).toBe("short");
    expect(result.r.status).toBe("needs-risk"); // no risk data exists in the format
    expect(codes(result)).toContain("open-trades-in-source");
  });

  it("generation 1 headers parse the same trades", () => {
    const result = importTradeHistory(fixtureText("tradingview-gen1.csv"));
    expect(result.ok).toBe(true);
    expect(result.format.kind).toBe("tradingview");
    expect(result.trades).toHaveLength(2);
    expect(result.trades.map((t) => t.pnl)).toEqual([30, 50]);
    expect(result.trades[0]!.direction).toBe("short");
  });

  it("a user-chosen risk assumption converts a needs-risk file, labeled inferred", () => {
    const result = importTradeHistory(fixtureText("tradingview-gen2.csv"), {
      riskSpec: { type: "fixed-cash", amount: 20 },
    });
    expect(result.r.status).toBe("ready");
    expect(result.r.source).toBe("inferred");
    expect(result.trades[0]!.r).toBeCloseTo(45 / 20);
    const bridge = toTradeLogEntries(result.trades);
    expect(bridge.entries).toHaveLength(3);
    expect(bridge.dropped).toBe(0);
  });
});

describe("MetaTrader statements", () => {
  it("MT4 CSV: net P&L folds commission and swap, R comes from the stop, pendings and balances skipped", () => {
    const result = importTradeHistory(fixtureText("mt4-statement.csv"));
    expect(result.ok).toBe(true);
    expect(result.format.kind).toBe("metatrader");
    expect(result.trades).toHaveLength(3);

    const first = result.trades[0]!;
    expect(first.pnl).toBeCloseTo(246.3); // 250 - 3.50 - 0.20
    expect(first.fees).toBeCloseTo(3.7);
    expect(first.r).toBeCloseTo(246.3 / 250, 6); // stop distance 0.005 at 50000/unit
    expect(first.rSource).toBe("calculated");

    const second = result.trades[1]!;
    expect(second.direction).toBe("short");
    expect(second.r).toBeCloseTo(-128.5 / 250, 6);

    // The third trade's stop sits AT entry: refused, so the file is partial.
    expect(result.trades[2]!.r).toBeNull();
    expect(codes(result)).toContain("stop-not-protective");
    expect(result.r.status).toBe("partial");
    expect(codes(result)).toContain("r-partial");
    expect(codes(result)).toContain("pending-orders-skipped");
    expect(codes(result)).toContain("ledger-rows-skipped");
  });

  it("a risk assumption fills the refused stop and the file becomes ready with mixed sources", () => {
    const result = importTradeHistory(fixtureText("mt4-statement.csv"), {
      riskSpec: { type: "fixed-cash", amount: 250 },
    });
    expect(result.r.status).toBe("ready");
    expect(result.r.source).toBe("mixed");
    expect(result.trades[2]!.rSource).toBe("inferred");
  });

  it("the MT4 HTML report (UTF-16LE bytes) imports Closed Transactions and keeps Open Trades out of them", () => {
    const decoded = decodeImportBytes(new Uint8Array(readFileSync(FIXTURES + "mt4-report.html")));
    expect(decoded.encoding).toBe("utf-16le");
    const result = importTradeHistory(decoded.text);
    expect(result.ok).toBe(true);
    expect(result.format.kind).toBe("metatrader");
    expect(result.trades).toHaveLength(2);
    expect(result.trades[0]!.pnl).toBeCloseTo(246.5); // &minus;3.50 decoded and folded in
    expect(result.openTrades).toHaveLength(1);
    expect(result.openTrades[0]!.pnl).toBeNull(); // floating P&L is not a result
    expect(result.trades.every((t) => t.symbol === "EURUSD")).toBe(true);
  });

  it("an MT5 history report lands on Positions (hidden cells dropped, S/L gives calculated R), not Deals", () => {
    const result = importTradeHistory(fixtureText("mt5-history.html"));
    expect(result.ok).toBe(true);
    expect(result.format.kind).toBe("metatrader");
    expect(result.trades).toHaveLength(2);
    const long = result.trades[0]!;
    expect(long.symbol).toBe("XAUUSD");
    expect(long.pnl).toBeCloseTo(104.3); // 105 - 0.70, columns aligned despite the hidden cell
    expect(long.r).toBeCloseTo(104.3 / 105, 6);
    expect(result.r.status).toBe("ready");
  });
});

describe("MT5 tester deals", () => {
  it("deals replay under netting: direction inversion, reversal split, netted fees, balance rows skipped", () => {
    const result = importTradeHistory(fixtureText("mt5-tester-deals.html"));
    expect(result.ok).toBe(true);
    expect(result.format.kind).toBe("mt5-deals");
    expect(result.trades).toHaveLength(3);

    const [long1, short1, long2] = result.trades as [
      (typeof result.trades)[number],
      (typeof result.trades)[number],
      (typeof result.trades)[number],
    ];
    expect(long1.direction).toBe("long");
    expect(long1.quantity).toBeCloseTo(0.06); // "0.06 / 0.06" volumes read the filled amount
    expect(long1.pnl).toBeCloseTo(30 - 0.22, 10); // gross 30, commissions both legs + swap

    expect(short1.direction).toBe("short"); // a buy deal that is "out" closes a SHORT
    expect(short1.pnl).toBeCloseTo(20 - 0.2, 10); // whole in/out profit books to the closing side

    expect(long2.direction).toBe("long"); // the reversal remainder
    expect(long2.entryPrice).toBeCloseTo(1.106);
    expect(long2.pnl).toBeCloseTo(18 - 0.12, 10);

    expect(codes(result)).toContain("ledger-rows-skipped");
    expect(result.r.status).toBe("needs-risk"); // deals carry no stop
  });
});

describe("ThinkOrSwim account statement", () => {
  it("the synthetic golden statement reconstructs 11 stock trades whose net P&L matches the cash total", () => {
    const result = importTradeHistory(fixtureText("thinkorswim-account-statement.csv"));
    expect(result.ok).toBe(true);
    expect(result.format.kind).toBe("thinkorswim");
    expect(result.format.confidence).toBe("exact");
    expect(result.trades).toHaveLength(11);
    expect(result.openTrades).toHaveLength(0);

    // The statement's own TOTAL row says $0.02, with each cash amount rounded
    // to cents; the price-based reconstruction is exact, so match at cents.
    const totalPnl = result.trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    expect(totalPnl).toBeCloseTo(0.02, 2);
    const totalFees = result.trades.reduce((sum, t) => sum + (t.fees ?? 0), 0);
    expect(totalFees).toBeCloseTo(1.16, 6); // Misc Fees column total

    const short = result.trades.find((t) => t.direction === "short");
    expect(short).toBeDefined();
    expect(short!.pnl).toBeCloseTo(-5.48, 6); // SOLD TO OPEN then BOT TO CLOSE

    expect(result.r.status).toBe("needs-risk");
    expect(codes(result)).toContain("date-order-assumed"); // 7/2/26 proves nothing
  });

  it("order-history rows (REJECTED, CANCELED, TRIGGERED) never become trades", () => {
    const result = importTradeHistory(fixtureText("thinkorswim-account-statement.csv"));
    // 23 fills exist in Account Trade History; the order history holds 8+ rows.
    expect(result.stats.rows).toBe(23);
  });
});

describe("generic fallback shapes", () => {
  it("a journal with reordered columns, quoted cells, and a result column imports as explicit R", () => {
    const result = importTradeHistory(fixtureText("generic-journal.csv"));
    expect(result.ok).toBe(true);
    expect(result.format.kind).toBe("generic-csv");
    expect(result.format.confidence).toBe("high");
    expect(result.trades).toHaveLength(3);
    expect(result.trades[0]!.symbol).toBe("MNQ");
    expect(result.trades[0]!.r).toBe(2); // "result" historically means R here
    expect(result.r.status).toBe("ready");
    expect(result.r.source).toBe("explicit");
  });

  it("raw executions rebuild flat-to-flat trades with the price-derived P&L disclosed", () => {
    const result = importTradeHistory(fixtureText("executions.csv"));
    expect(result.ok).toBe(true);
    expect(result.trades).toHaveLength(2);
    const aapl = result.trades.find((t) => t.symbol === "AAPL")!;
    expect(aapl.pnl).toBeCloseTo(800); // scale-in basis 181, exit 185 x 200
    const tsla = result.trades.find((t) => t.symbol === "TSLA")!;
    expect(tsla.direction).toBe("short");
    expect(tsla.pnl).toBeCloseTo(250);
    expect(result.openTrades).toHaveLength(2); // TSLA reversal remainder + MSFT
    expect(codes(result)).toContain("pnl-derived-from-prices");
    expect(result.r.status).toBe("needs-risk");
  });

  it("a Status column drops cancelled and working rows before they poison the replay", () => {
    const result = importTradeHistory(fixtureText("tradovate-orders.csv"));
    expect(result.ok).toBe(true);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.pnl).toBeCloseTo(60);
    expect(codes(result)).toContain("status-rows-dropped");
  });
});

describe("the generic template is a golden path", () => {
  it("imports with explicit R as written", () => {
    const result = importTradeHistory(GENERIC_CSV_TEMPLATE);
    expect(result.ok).toBe(true);
    expect(result.trades).toHaveLength(2);
    expect(result.r.status).toBe("ready");
    expect(result.r.source).toBe("explicit");
    expect(result.trades.map((t) => t.r)).toEqual([2, -1]);
  });

  it("with the r column removed the SAME R values come back, calculated from the stop", () => {
    const lines = GENERIC_CSV_TEMPLATE.split("\n").map((line) => line.split(",").slice(0, -1).join(","));
    const result = importTradeHistory(lines.join("\n"));
    expect(result.ok).toBe(true);
    expect(result.r.status).toBe("ready");
    expect(result.r.source).toBe("calculated");
    expect(result.trades[0]!.r).toBeCloseTo(2, 6);
    expect(result.trades[1]!.r).toBeCloseTo(-1, 6);
  });

  it("explicit generic-csv mode reports template coverage", () => {
    const result = importTradeHistory(GENERIC_CSV_TEMPLATE, { adapterId: "generic-csv" });
    expect(result.ok).toBe(true);
    const coverage = result.issues.find((issue) => issue.code === "template-coverage");
    expect(coverage).toBeDefined();
    expect(coverage!.message).toContain("missing [none]");
  });
});

describe("failure modes refuse loudly, never throw, never guess", () => {
  const nasty: Array<[string, string]> = [
    ["empty input", ""],
    ["prose", "hello there\nthis is not a trade log at all\njust words"],
    ["header only", "open time,close time,symbol,r"],
    ["no header", "1,2,3\n4,5,6\n7,8,9"],
    ["binary-ish garbage", " PK"],
    ["html without tables", "<html><body><p>statement</p></body></html>"],
  ];
  for (const [label, text] of nasty) {
    it(`${label}: a structured refusal with an error issue`, () => {
      const result = importTradeHistory(text);
      expect(result.ok).toBe(false);
      expect(result.trades).toHaveLength(0);
      expect(result.issues.some((issue) => issue.severity === "error")).toBe(true);
    });
  }

  it("an unknown adapter id is refused with the known ids and the template advice", () => {
    const result = importTradeHistory(GENERIC_CSV_TEMPLATE, { adapterId: "ninja-trader-9000" });
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === "unknown-adapter")!;
    expect(issue.message).toContain("generic-csv");
    expect(issue.message).toContain("open time,close time");
  });

  it("a forced adapter that does not match the file refuses instead of guessing", () => {
    const result = importTradeHistory(GENERIC_CSV_TEMPLATE, { adapterId: "tradingview" });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("adapter-mismatch");
  });

  it("formula injection in retained text fields is neutralized", () => {
    const result = importTradeHistory(
      "open time,symbol,direction,pnl\n2026-01-05 10:00,=HYPERLINK(evil),long,50\n2026-01-06 10:00,@SUM(A1),short,-25",
    );
    expect(result.ok).toBe(true);
    expect(result.trades[0]!.symbol).toBe("HYPERLINK(EVIL)");
    expect(result.trades[1]!.symbol).toBe("SUM(A1)");
  });

  it("duplicate rows are removed with a warning for row-per-trade sources", () => {
    const row = "2026-01-05 10:00,2026-01-05 11:00,EURUSD,long,1,1.085,1.086,1.084,100,0,1";
    const result = importTradeHistory(`${GENERIC_CSV_TEMPLATE.split("\n")[0]}\n${row}\n${row}`);
    expect(result.trades).toHaveLength(1);
    expect(result.stats.duplicatesRemoved).toBe(1);
    expect(codes(result)).toContain("duplicates-removed");
  });

  it("a trade that closes before it opens is dropped as a date-order symptom", () => {
    const result = importTradeHistory(
      "open time,close time,symbol,r\n2026-01-05 10:00,2026-01-04 09:00,EURUSD,1.5",
    );
    expect(result.trades).toHaveLength(0);
    expect(codes(result)).toContain("exit-before-entry");
  });

  it("the row cap truncates with a disclosure instead of hanging or failing", () => {
    const rows = ["open time,r"];
    for (let i = 0; i < 60; i++) rows.push(`2026-01-05 10:${String(i % 60).padStart(2, "0")},1`);
    const result = importTradeHistory(rows.join("\n"), { maxRows: 20 });
    expect(codes(result)).toContain("input-truncated");
    expect(result.ok).toBe(true);
    expect(result.trades.length).toBeLessThanOrEqual(19);
  });
});

describe("the fixture corpus never throws and never silently mangles", () => {
  const files = readdirSync(FIXTURES);
  for (const name of files) {
    it(`${name}: imports cleanly or refuses cleanly`, () => {
      const text = decodeImportBytes(new Uint8Array(readFileSync(FIXTURES + name))).text;
      const result = importTradeHistory(text);
      expect(codes(result)).not.toContain("internal-error");
      if (!result.ok) {
        expect(result.issues.some((issue) => issue.severity === "error")).toBe(true);
      } else {
        expect(result.trades.length).toBeGreaterThan(0);
      }
    });
  }
});
