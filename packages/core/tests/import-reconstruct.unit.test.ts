import { describe, expect, it } from "vitest";
import { findTableSections } from "../src/import/aliases.js";
import { decodeEntities, extractHtmlTables } from "../src/import/html.js";
import { parseNumberCell } from "../src/import/csv.js";
import {
  pairEvents,
  reconstructFromExecutions,
  type ExecutionFill,
  type TradeEvent,
} from "../src/import/reconstruct.js";
import { resolveR, riskFromStop } from "../src/import/rmultiple.js";
import type { ImportedTrade, ImportIssue } from "../src/import/model.js";

/*
  Reconstruction and R rules. These are the layers where a wrong guess turns
  into a wrong trade, so the negative assertions (drops, refusals, warnings)
  matter more than the happy paths.
*/

function event(overrides: Partial<TradeEvent>): TradeEvent {
  return {
    sourceRow: 1,
    id: null,
    symbol: null,
    direction: null,
    eventType: null,
    time: 0,
    price: null,
    quantity: null,
    pnl: null,
    fees: null,
    stopPrice: null,
    riskAmount: null,
    r: null,
    ...overrides,
  };
}

function closedTrade(overrides: Partial<ImportedTrade>): ImportedTrade {
  return {
    id: null,
    symbol: null,
    direction: null,
    entryTime: null,
    exitTime: null,
    entryPrice: null,
    exitPrice: null,
    quantity: null,
    pnl: null,
    fees: null,
    stopPrice: null,
    riskAmount: null,
    r: null,
    rSource: "unavailable",
    status: "closed",
    sourceRows: [1],
    ...overrides,
  };
}

describe("pairEvents with trade ids", () => {
  it("pairs a TradingView-style two-row trade (exit listed first, totals mirrored on both rows)", () => {
    const issues: ImportIssue[] = [];
    const t0 = Date.UTC(2026, 0, 5, 10, 0);
    const t1 = Date.UTC(2026, 0, 5, 12, 0);
    const { trades, openTrades } = pairEvents(
      [
        event({
          sourceRow: 2,
          id: "1",
          eventType: "exit",
          direction: "long",
          time: t1,
          price: 1.09,
          quantity: 1,
          pnl: 50,
          r: null,
        }),
        event({
          sourceRow: 3,
          id: "1",
          eventType: "entry",
          direction: "long",
          time: t0,
          price: 1.085,
          quantity: 1,
          pnl: 50,
        }),
      ],
      issues,
      { totalsOnExit: true },
    );
    expect(openTrades).toHaveLength(0);
    expect(trades).toHaveLength(1);
    const trade = trades[0]!;
    expect(trade.direction).toBe("long");
    expect(trade.entryTime).toBe(t0);
    expect(trade.exitTime).toBe(t1);
    expect(trade.entryPrice).toBeCloseTo(1.085);
    expect(trade.exitPrice).toBeCloseTo(1.09);
    expect(trade.pnl).toBe(50); // read once from the exit row, never doubled
    expect(trade.sourceRows).toEqual([2, 3]);
  });

  it("multiple fills per side become a volume-weighted entry", () => {
    const issues: ImportIssue[] = [];
    const { trades } = pairEvents(
      [
        event({ sourceRow: 1, id: "7", eventType: "entry", time: 1, price: 10, quantity: 100 }),
        event({ sourceRow: 2, id: "7", eventType: "entry", time: 2, price: 12, quantity: 300 }),
        event({ sourceRow: 3, id: "7", eventType: "exit", time: 3, price: 13, quantity: 400, pnl: 700 }),
      ],
      issues,
      { totalsOnExit: true },
    );
    expect(trades[0]!.entryPrice).toBeCloseTo(11.5); // (10*100 + 12*300) / 400
    expect(trades[0]!.quantity).toBe(400);
  });

  it("a trade id spanning two symbols is a mis-mapping and the group is dropped loudly", () => {
    const issues: ImportIssue[] = [];
    const { trades } = pairEvents(
      [
        event({ sourceRow: 1, id: "9", symbol: "EURUSD", eventType: "entry", time: 1, price: 1 }),
        event({ sourceRow: 2, id: "9", symbol: "GBPUSD", eventType: "exit", time: 2, price: 2 }),
      ],
      issues,
    );
    expect(trades).toHaveLength(0);
    expect(issues.some((i) => i.code === "trade-id-spans-symbols" && i.severity === "error")).toBe(true);
  });

  it("an exit with no entry is dropped with a diagnostic, never guessed into a trade", () => {
    const issues: ImportIssue[] = [];
    const { trades } = pairEvents(
      [event({ sourceRow: 4, id: "3", eventType: "exit", time: 5, price: 2 })],
      issues,
    );
    expect(trades).toHaveLength(0);
    expect(issues.some((i) => i.code === "unmatched-exit")).toBe(true);
  });

  it("an entry with no exit is an open trade, excluded from the closed list", () => {
    const issues: ImportIssue[] = [];
    const { trades, openTrades } = pairEvents(
      [event({ sourceRow: 1, id: "5", eventType: "entry", direction: "short", time: 1, price: 100 })],
      issues,
    );
    expect(trades).toHaveLength(0);
    expect(openTrades).toHaveLength(1);
    expect(openTrades[0]!.status).toBe("open");
  });

  it("opposing sides inside an id group identify the legs when no entry/exit markers exist", () => {
    const issues: ImportIssue[] = [];
    const { trades } = pairEvents(
      [
        event({ sourceRow: 1, id: "2", direction: "short", time: 1, price: 200, quantity: 1 }),
        event({ sourceRow: 2, id: "2", direction: "long", time: 2, price: 190, quantity: 1, pnl: 10 }),
      ],
      issues,
    );
    expect(trades).toHaveLength(1);
    expect(trades[0]!.direction).toBe("short");
    expect(trades[0]!.entryPrice).toBe(200);
    expect(trades[0]!.exitPrice).toBe(190);
  });
});

describe("pairEvents FIFO fallback", () => {
  it("without ids, pairing is FIFO within (symbol, direction), split by lots, and says so", () => {
    const issues: ImportIssue[] = [];
    const { trades } = pairEvents(
      [
        event({
          sourceRow: 1,
          symbol: "ES",
          direction: "long",
          eventType: "entry",
          time: 1,
          price: 100,
          quantity: 300,
        }),
        event({
          sourceRow: 2,
          symbol: "ES",
          direction: "long",
          eventType: "exit",
          time: 2,
          price: 110,
          quantity: 100,
          pnl: 1000,
        }),
        event({
          sourceRow: 3,
          symbol: "ES",
          direction: "long",
          eventType: "exit",
          time: 3,
          price: 120,
          quantity: 200,
          pnl: 4000,
        }),
      ],
      issues,
      { totalsOnExit: true },
    );
    expect(issues.some((i) => i.code === "pairing-positional")).toBe(true);
    expect(trades).toHaveLength(2);
    expect(trades[0]!.quantity).toBe(100);
    expect(trades[1]!.quantity).toBe(200);
    expect(trades[0]!.entryPrice).toBe(100);
  });

  it("an exit larger than the open quantity drops the excess loudly", () => {
    const issues: ImportIssue[] = [];
    const { trades } = pairEvents(
      [
        event({
          sourceRow: 1,
          symbol: "ES",
          direction: "long",
          eventType: "entry",
          time: 1,
          price: 100,
          quantity: 100,
        }),
        event({
          sourceRow: 2,
          symbol: "ES",
          direction: "long",
          eventType: "exit",
          time: 2,
          price: 110,
          quantity: 150,
        }),
      ],
      issues,
    );
    expect(trades).toHaveLength(1);
    expect(trades[0]!.quantity).toBe(100);
    expect(issues.some((i) => i.code === "unmatched-exit")).toBe(true);
  });
});

describe("execution replay", () => {
  const fill = (overrides: Partial<ExecutionFill>): ExecutionFill => ({
    sourceRow: 1,
    symbol: "TZA",
    time: 1,
    price: 0,
    signedQuantity: 0,
    fees: null,
    pnl: null,
    ...overrides,
  });

  it("a plain round trip realizes price P&L net of fees", () => {
    const issues: ImportIssue[] = [];
    const { trades } = reconstructFromExecutions(
      [
        fill({ sourceRow: 1, time: 1, price: 3.8, signedQuantity: 500 }),
        fill({ sourceRow: 2, time: 2, price: 3.81, signedQuantity: -500, fees: 0.29 }),
      ],
      issues,
      { pnlFrom: "prices" },
    );
    expect(trades).toHaveLength(1);
    expect(trades[0]!.pnl).toBeCloseTo(5 - 0.29, 10);
    expect(trades[0]!.direction).toBe("long");
  });

  it("scale-ins extend a volume-weighted basis", () => {
    const issues: ImportIssue[] = [];
    const { trades } = reconstructFromExecutions(
      [
        fill({ sourceRow: 1, time: 1, price: 10, signedQuantity: 100 }),
        fill({ sourceRow: 2, time: 2, price: 12, signedQuantity: 100 }),
        fill({ sourceRow: 3, time: 3, price: 13, signedQuantity: -200 }),
      ],
      issues,
      { pnlFrom: "prices" },
    );
    expect(trades).toHaveLength(1);
    expect(trades[0]!.pnl).toBeCloseTo(400); // basis 11, exit 13, qty 200
    expect(trades[0]!.quantity).toBe(200);
  });

  it("partial exits stay one flat-to-flat trade with a volume-weighted exit", () => {
    const issues: ImportIssue[] = [];
    const { trades } = reconstructFromExecutions(
      [
        fill({ sourceRow: 1, time: 1, price: 10, signedQuantity: 300 }),
        fill({ sourceRow: 2, time: 2, price: 11, signedQuantity: -100 }),
        fill({ sourceRow: 3, time: 3, price: 12, signedQuantity: -200 }),
      ],
      issues,
      { pnlFrom: "prices" },
    );
    expect(trades).toHaveLength(1);
    expect(trades[0]!.pnl).toBeCloseTo(100 + 400);
    expect(trades[0]!.exitPrice).toBeCloseTo((11 * 100 + 12 * 200) / 300);
    expect(trades[0]!.exitTime).toBe(3);
  });

  it("crossing zero closes one trade and opens the reversal, fees prorated by consumed quantity", () => {
    const issues: ImportIssue[] = [];
    const { trades, openTrades } = reconstructFromExecutions(
      [
        fill({ sourceRow: 1, time: 1, price: 10, signedQuantity: 100, fees: 1 }),
        fill({ sourceRow: 2, time: 2, price: 12, signedQuantity: -250, fees: 2.5 }),
        fill({ sourceRow: 3, time: 3, price: 11, signedQuantity: 150, fees: 1.5 }),
      ],
      issues,
      { pnlFrom: "prices" },
    );
    expect(trades).toHaveLength(2);
    // Long 100: +200 gross, fees 1 (entry) + 1.0 (100/250 of 2.5).
    expect(trades[0]!.direction).toBe("long");
    expect(trades[0]!.pnl).toBeCloseTo(200 - 2);
    // Short 150 from 12 to 11: +150 gross, fees 1.5 (opening share) + 1.5 (close).
    expect(trades[1]!.direction).toBe("short");
    expect(trades[1]!.pnl).toBeCloseTo(150 - 3);
    expect(openTrades).toHaveLength(0);
  });

  it("a leftover position surfaces as an open trade with no fabricated P&L", () => {
    const issues: ImportIssue[] = [];
    const { trades, openTrades } = reconstructFromExecutions(
      [fill({ sourceRow: 1, time: 1, price: 10, signedQuantity: 100 })],
      issues,
      { pnlFrom: "prices" },
    );
    expect(trades).toHaveLength(0);
    expect(openTrades).toHaveLength(1);
    expect(openTrades[0]!.pnl).toBeNull();
  });

  it('under pnlFrom "fills" the source books P&L on reducing fills, gross, fees separate', () => {
    const issues: ImportIssue[] = [];
    const { trades } = reconstructFromExecutions(
      [
        fill({ sourceRow: 1, symbol: "EURUSD", time: 1, price: 1.085, signedQuantity: 0.1, fees: 0.2 }),
        fill({
          sourceRow: 2,
          symbol: "EURUSD",
          time: 2,
          price: 1.09,
          signedQuantity: -0.1,
          fees: 0.2,
          pnl: 50,
        }),
      ],
      issues,
      { pnlFrom: "fills" },
    );
    expect(trades[0]!.pnl).toBeCloseTo(50 - 0.4);
  });

  it('a reducing fill with no booked P&L under pnlFrom "fills" is flagged, not silently zeroed', () => {
    const issues: ImportIssue[] = [];
    reconstructFromExecutions(
      [
        fill({ sourceRow: 1, time: 1, price: 10, signedQuantity: 1 }),
        fill({ sourceRow: 2, time: 2, price: 11, signedQuantity: -1 }),
      ],
      issues,
      { pnlFrom: "fills" },
    );
    expect(issues.some((i) => i.code === "fill-missing-profit")).toBe(true);
  });
});

describe("the R ladder", () => {
  it("an explicit R column is validated and never recomputed", () => {
    const issues: ImportIssue[] = [];
    const trades = [closedTrade({ r: 1.5, pnl: 150, riskAmount: 50 })]; // riskAmount would say R=3
    const summary = resolveR(trades, undefined, issues);
    expect(trades[0]!.r).toBe(1.5);
    expect(trades[0]!.rSource).toBe("explicit");
    expect(summary.status).toBe("ready");
  });

  it("an implausible explicit R (|R| > 100) is discarded with a warning", () => {
    const issues: ImportIssue[] = [];
    const trades = [closedTrade({ r: 250, pnl: 100 })];
    const summary = resolveR(trades, undefined, issues);
    expect(trades[0]!.r).toBeNull();
    expect(issues.some((i) => i.code === "r-implausible")).toBe(true);
    expect(summary.status).toBe("needs-risk");
  });

  it("an explicit R whose sign disagrees with P&L is kept but flagged", () => {
    const issues: ImportIssue[] = [];
    resolveR([closedTrade({ r: 1.2, pnl: -80 })], undefined, issues);
    expect(issues.some((i) => i.code === "r-sign-mismatch")).toBe(true);
  });

  it("a risk-amount column calculates R from the file's own data", () => {
    const issues: ImportIssue[] = [];
    const trades = [closedTrade({ pnl: 240, riskAmount: 120 })];
    const summary = resolveR(trades, undefined, issues);
    expect(trades[0]!.r).toBeCloseTo(2);
    expect(trades[0]!.rSource).toBe("calculated");
    expect(summary.source).toBe("calculated");
  });

  it("a protective stop calculates risk through the file's own P&L, no contract sizes needed", () => {
    const issues: ImportIssue[] = [];
    const trades = [
      closedTrade({
        direction: "long",
        entryPrice: 1.085,
        exitPrice: 1.0874,
        stopPrice: 1.0838,
        pnl: 240,
        fees: 0,
      }),
      closedTrade({
        direction: "short",
        entryPrice: 1.088,
        exitPrice: 1.0892,
        stopPrice: 1.0892,
        pnl: -120,
        fees: 0,
      }),
    ];
    const summary = resolveR(trades, undefined, issues);
    expect(trades[0]!.r).toBeCloseTo(2, 6);
    expect(trades[1]!.r).toBeCloseTo(-1, 6);
    expect(summary.status).toBe("ready");
  });

  it("a stop at or beyond entry is refused: history shows the LAST stop, not the initial risk", () => {
    const issues: ImportIssue[] = [];
    const risk = riskFromStop(
      { direction: "long", entryPrice: 100, exitPrice: 110, stopPrice: 100, pnl: 50, fees: 0 },
      issues,
    );
    expect(risk).toBeNull();
    expect(issues.some((i) => i.code === "stop-not-protective")).toBe(true);
  });

  it("a P&L sign that contradicts the price move refuses the rate derivation", () => {
    const issues: ImportIssue[] = [];
    const risk = riskFromStop(
      { direction: "long", entryPrice: 100, exitPrice: 110, stopPrice: 95, pnl: -50, fees: 0 },
      issues,
    );
    expect(risk).toBeNull();
    expect(issues.some((i) => i.code === "pnl-move-mismatch")).toBe(true);
  });

  it("a RiskSpec converts needs-risk files, labeled inferred, and is never applied silently", () => {
    const issues: ImportIssue[] = [];
    const bare = [closedTrade({ pnl: 50 })];
    expect(resolveR(bare, undefined, issues).status).toBe("needs-risk");
    expect(bare[0]!.r).toBeNull();

    const fixed = [closedTrade({ pnl: 50 })];
    const summary = resolveR(fixed, { type: "fixed-cash", amount: 25 }, issues);
    expect(fixed[0]!.r).toBeCloseTo(2);
    expect(fixed[0]!.rSource).toBe("inferred");
    expect(summary.status).toBe("ready");

    const pct = [closedTrade({ pnl: -19, entryPrice: 3.8, quantity: 500 })];
    resolveR(pct, { type: "percent-of-entry-value", percent: 1 }, issues);
    expect(pct[0]!.r).toBeCloseTo(-1); // risk = 1900 * 1% = 19
  });

  it("partial coverage is refused with an error: simulating covered trades only biases the sample", () => {
    const issues: ImportIssue[] = [];
    const trades = [closedTrade({ r: 1 }), closedTrade({ pnl: 50 })];
    const summary = resolveR(trades, undefined, issues);
    expect(summary.status).toBe("partial");
    expect(issues.some((i) => i.code === "r-partial" && i.severity === "error")).toBe(true);
  });

  it("no R and no P&L anywhere is unavailable", () => {
    const issues: ImportIssue[] = [];
    expect(resolveR([closedTrade({})], undefined, issues).status).toBe("unavailable");
  });
});

describe("HTML statement extraction", () => {
  it("decodes entities, pads colspans, and keeps column indices aligned", () => {
    const issues: ImportIssue[] = [];
    const tables = extractHtmlTables(
      "<table><tr><th colspan=2>Head</th><th>P/L</th></tr>" +
        "<tr><td>a</td><td>b</td><td>1&nbsp;000.50</td></tr></table>",
      issues,
    );
    expect(tables).toHaveLength(1);
    expect(tables[0]!.rows[0]).toEqual(["Head", "", "P/L"]);
    expect(parseNumberCell(tables[0]!.rows[1]![2]!)).toBe(1000.5);
  });

  it('class="hidden" cells and rows are dropped ENTIRELY so columns do not shift', () => {
    const issues: ImportIssue[] = [];
    const tables = extractHtmlTables(
      "<table>" +
        '<tr><td>Time</td><td class="hidden" colspan="8">secret comment</td><td>Profit</td></tr>' +
        '<tr class="hidden"><td>whole row gone</td></tr>' +
        "<tr><td>t1</td><td>25</td></tr>" +
        "</table>",
      issues,
    );
    expect(tables[0]!.rows).toEqual([
      ["Time", "Profit"],
      ["t1", "25"],
    ]);
  });

  it("script and style content is discarded wholesale", () => {
    const issues: ImportIssue[] = [];
    const tables = extractHtmlTables(
      "<style>td{color:red}</style><table><tr><td>ok</td><script>document.write('<td>evil</td>')</script></tr></table>",
      issues,
    );
    expect(tables[0]!.rows).toEqual([["ok"]]);
  });

  it("survives truncated markup: whatever was open at end of input is closed", () => {
    const issues: ImportIssue[] = [];
    const tables = extractHtmlTables("<table><tr><td>a</td><td>brok", issues);
    expect(tables[0]!.rows).toEqual([["a", "brok"]]);
  });

  it("&minus; decodes to a Unicode minus the number parser understands", () => {
    expect(decodeEntities("&minus;3.50")).toBe("−3.50");
    expect(parseNumberCell(decodeEntities("&minus;3.50"))).toBe(-3.5);
  });
});

describe("statement section finding", () => {
  it("each strong header opens a section running to the next title, summary, or header", () => {
    const rows = [
      ["Closed Transactions:"],
      [
        "Ticket",
        "Open Time",
        "Type",
        "Size",
        "Item",
        "Price",
        "S/L",
        "T/P",
        "Close Time",
        "Price",
        "Commission",
        "Taxes",
        "Swap",
        "Profit",
      ],
      [
        "1",
        "2026.01.05 10:00",
        "buy",
        "0.5",
        "EURUSD",
        "1.0850",
        "1.0800",
        "0",
        "2026.01.05 12:00",
        "1.0900",
        "-3.50",
        "0",
        "0",
        "50.00",
      ],
      [
        "2",
        "2026.01.06 10:00",
        "sell",
        "0.5",
        "EURUSD",
        "1.0900",
        "1.0950",
        "0",
        "2026.01.06 12:00",
        "1.0850",
        "-3.50",
        "0",
        "0",
        "25.00",
      ],
      ["Closed P/L:", "75.00"],
      ["Open Trades:"],
      [
        "Ticket",
        "Open Time",
        "Type",
        "Size",
        "Item",
        "Price",
        "S/L",
        "T/P",
        "",
        "Price",
        "Commission",
        "Taxes",
        "Swap",
        "Profit",
      ],
      [
        "3",
        "2026.01.07 10:00",
        "buy",
        "0.5",
        "EURUSD",
        "1.0800",
        "1.0750",
        "0",
        "",
        "1.0820",
        "0",
        "0",
        "0",
        "10.00",
      ],
    ];
    const sections = findTableSections(rows);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.headerIndex).toBe(1);
    expect(sections[0]!.start).toBe(2);
    expect(sections[0]!.end).toBe(4); // stops at the Closed P/L: summary row
    expect(sections[1]!.headerIndex).toBe(6);
  });
});
