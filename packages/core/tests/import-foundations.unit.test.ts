import { describe, expect, it } from "vitest";
import {
  cleanCell,
  decodeImportBytes,
  neutralizeText,
  parseNumberCell,
  parseVolumeCell,
  repairEncoding,
  sniffDelimiter,
  tokenizeDelimited,
} from "../src/import/csv.js";
import {
  buildHeaderPlan,
  classifyValueColumn,
  locateHeader,
  normalizeHeader,
} from "../src/import/aliases.js";
import { buildTimestampParser, parseImportTimestamp, scanDateOrder } from "../src/import/timestamps.js";
import type { ImportIssue } from "../src/import/model.js";

/*
  Foundation layers of the trade-history importer. These defend the contract
  that real, messy exports parse deterministically or fail loudly: nothing
  here may guess silently, and nothing may throw on user data.
*/

function utf16leBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    bytes[2 + i * 2] = unit & 0xff;
    bytes[3 + i * 2] = unit >> 8;
  }
  return bytes;
}

describe("file encoding", () => {
  it("a MetaTrader-style UTF-16LE file decodes correctly by its BOM", () => {
    const decoded = decodeImportBytes(utf16leBytes("Ticket;Profit\n1;25.00"));
    expect(decoded.encoding).toBe("utf-16le");
    expect(decoded.text).toBe("Ticket;Profit\n1;25.00");
  });

  it("a UTF-16BE BOM decodes too, and plain bytes fall back to UTF-8", () => {
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0x00, 0x42]);
    expect(decodeImportBytes(be).text).toBe("AB");
    expect(decodeImportBytes(new TextEncoder().encode("héllo")).text).toBe("héllo");
  });

  it("UTF-16 text mistakenly read as UTF-8 (NUL-interleaved) is repaired with a warning", () => {
    const mangled = "T\u0000i\u0000c\u0000k\u0000e\u0000t\u0000;\u0000P\u0000";
    const repaired = repairEncoding(mangled);
    expect(repaired.text).toBe("Ticket;P");
    expect(repaired.issues.some((i) => i.code === "encoding-repaired")).toBe(true);
  });

  it("a plain UTF-8 BOM is stripped silently", () => {
    const repaired = repairEncoding("﻿Trade number,Type");
    expect(repaired.text).toBe("Trade number,Type");
    expect(repaired.issues).toHaveLength(0);
  });
});

describe("delimiter sniffing and tokenizing", () => {
  it("semicolon and tab files are recognized by column-count consistency", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3\n4;5;6")).toBe(";");
    expect(sniffDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(sniffDelimiter("a,b,c\n1,2,3")).toBe(",");
  });

  it("quoted cells keep delimiters, doubled quotes, and embedded newlines", () => {
    const { rows } = tokenizeDelimited('a,"x, y","he said ""hi""","line1\nline2"\n1,2,3,4', ",");
    expect(rows[0]).toEqual(["a", "x, y", 'he said "hi"', "line1\nline2"]);
    expect(rows[1]).toEqual(["1", "2", "3", "4"]);
  });

  it("a trailing newline does not create a phantom empty row", () => {
    const { rows } = tokenizeDelimited("a,b\n1,2\n", ",");
    expect(rows).toHaveLength(2);
  });

  it("an unterminated quote is recovered and reported instead of thrown", () => {
    const { rows, issues } = tokenizeDelimited('a,b\n1,"unclosed', ",");
    expect(rows).toHaveLength(2);
    expect(rows[1]![1]).toBe("unclosed");
    expect(issues.some((i) => i.code === "unterminated-quote")).toBe(true);
  });
});

describe("defensive number parsing", () => {
  const cases: Array<[string, number | null]> = [
    ["217.131", 217.131], // a GBPJPY price, never 217131
    ["1.234,56", 1234.56],
    ["1,234.56", 1234.56],
    ["1.234.567", 1234567],
    ["12,345", 12345],
    ["1234,56", 1234.56],
    ["0,5", 0.5],
    ["1 000.00", 1000],
    ["($1,900.00)", -1900],
    ["−45.2", -45.2],
    ["$1,904.71", 1904.71],
    ["3.8%", 3.8],
    ["1.8R", 1.8],
    ["-0.29", -0.29],
    ["+5", 5],
    ["540 USD", 540],
    ["abc", null],
    ["NaN", null],
    ["Infinity", null],
    ["—", null],
    ["", null],
    ["1/2", null],
  ];
  for (const [raw, expected] of cases) {
    it(`"${raw.replace(/ /g, " ")}" parses to ${expected === null ? "null (refused)" : expected}`, () => {
      expect(parseNumberCell(raw)).toBe(expected);
    });
  }

  it('MT5 "filled / ordered" volumes read the filled amount', () => {
    expect(parseVolumeCell("0.06 / 0.06")).toBe(0.06);
    expect(parseVolumeCell("1.5")).toBe(1.5);
  });

  it('the Excel text guard ="00123" unwraps to the plain value', () => {
    expect(cleanCell('="19876543210"')).toBe("19876543210");
  });

  it("formula-injection prefixes are stripped from retained text, numbers untouched", () => {
    expect(neutralizeText("=HYPERLINK(evil)").value).toBe("HYPERLINK(evil)");
    expect(neutralizeText("@SUM(A1)").value).toBe("SUM(A1)");
    expect(neutralizeText("+EURUSD").value).toBe("EURUSD");
    expect(neutralizeText("-1.5")).toEqual({ value: "-1.5", changed: false });
    expect(neutralizeText("EURUSD").changed).toBe(false);
  });
});

describe("timestamps", () => {
  it("slash dates parse under the decided month/day order", () => {
    expect(parseImportTimestamp("7/2/26 13:31:05", "MDY")).toBe(Date.UTC(2026, 6, 2, 13, 31, 5));
    expect(parseImportTimestamp("7/2/26 13:31:05", "DMY")).toBe(Date.UTC(2026, 1, 7, 13, 31, 5));
    expect(parseImportTimestamp("02.07.2026 09:00", "DMY")).toBe(Date.UTC(2026, 6, 2, 9, 0, 0));
  });

  it("12-hour times honor AM/PM including the 12 o'clock edge cases", () => {
    expect(parseImportTimestamp("3/4/2026 1:29:50 PM", "MDY")).toBe(Date.UTC(2026, 2, 4, 13, 29, 50));
    expect(parseImportTimestamp("3/4/2026 12:05 AM", "MDY")).toBe(Date.UTC(2026, 2, 4, 0, 5, 0));
    expect(parseImportTimestamp("3/4/2026 12:05 PM", "MDY")).toBe(Date.UTC(2026, 2, 4, 12, 5, 0));
  });

  it("IBKR compact yyyyMMdd;HHmmss and ISO/epoch formats parse", () => {
    expect(parseImportTimestamp("20260702;133105", "MDY")).toBe(Date.UTC(2026, 6, 2, 13, 31, 5));
    expect(parseImportTimestamp("2026-07-02T13:31:05Z", "MDY")).toBe(Date.UTC(2026, 6, 2, 13, 31, 5));
    expect(parseImportTimestamp("2026.07.02 13:31", "MDY")).toBe(Date.UTC(2026, 6, 2, 13, 31, 0));
  });

  it("impossible calendar dates are refused, never rolled over", () => {
    expect(Number.isNaN(parseImportTimestamp("2/31/2026", "MDY"))).toBe(true);
    expect(Number.isNaN(parseImportTimestamp("13/13/2026", "MDY"))).toBe(true);
  });

  it("the date order is decided once per file from provable values", () => {
    expect(scanDateOrder(["25/12/2026", "3/4/2026"]).order).toBe("DMY");
    expect(scanDateOrder(["12/25/2026"]).order).toBe("MDY");
    const ambiguous = scanDateOrder(["3/4/2026", "5/6/2026"]);
    expect(ambiguous.order).toBeNull();
    expect(ambiguous.sawAmbiguous).toBe(true);
  });

  it("an unprovable order assumes month-first WITH a warning; provable files stay silent", () => {
    const issues: ImportIssue[] = [];
    const parser = buildTimestampParser(["3/4/2026 10:00"], undefined, issues);
    expect(parser.order).toBe("MDY");
    expect(parser.assumed).toBe(true);
    expect(issues.some((i) => i.code === "date-order-assumed")).toBe(true);

    const provenIssues: ImportIssue[] = [];
    const proven = buildTimestampParser(["25/12/2026"], undefined, provenIssues);
    expect(proven.order).toBe("DMY");
    expect(provenIssues).toHaveLength(0);
  });

  it("a file proving both orders gets a conflict warning and the majority reading", () => {
    const issues: ImportIssue[] = [];
    const parser = buildTimestampParser(["25/12/2026", "12/25/2026", "12/26/2026"], undefined, issues);
    expect(parser.order).toBe("MDY");
    expect(issues.some((i) => i.code === "date-order-conflict")).toBe(true);
  });

  it("an explicit dateOrder override beats everything and stays silent", () => {
    const issues: ImportIssue[] = [];
    const parser = buildTimestampParser(["3/4/2026"], "DMY", issues);
    expect(parser.order).toBe("DMY");
    expect(issues).toHaveLength(0);
  });
});

describe("header aliases", () => {
  it("normalization strips punctuation, currency suffixes, and turns % into pct", () => {
    expect(normalizeHeader("Net PnL USD")).toBe("netpnl");
    expect(normalizeHeader("Price USDT")).toBe("price");
    expect(normalizeHeader("Profit %")).toBe("profitpct");
    expect(normalizeHeader("Size (qty)")).toBe("sizeqty");
    expect(normalizeHeader("S/L")).toBe("sl");
    expect(normalizeHeader("Commissions & Fees")).toBe("commissionsfees");
    expect(normalizeHeader("Pos Effect")).toBe("poseffect");
  });

  it('"result" keeps its historical meaning in this project: an R-multiple', () => {
    const plan = buildHeaderPlan(["time", "result"], [["2026-01-05 10:00", "1.5"]]);
    expect(plan.fields.r).toBe(1);
  });

  it("Type columns are resolved by their values, never by name alone", () => {
    expect(classifyValueColumn(["buy", "sell", "buy"])).toBe("direction");
    expect(classifyValueColumn(["Entry long", "Exit long", "Entry short"])).toBe("eventType");
    expect(classifyValueColumn(["in", "out", "in/out"])).toBe("eventType");
    expect(classifyValueColumn(["STOCK", "STOCK"])).toBeNull();
  });

  it("an identical repeated header maps its second occurrence to the exit leg", () => {
    const header = [
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
    ];
    const plan = buildHeaderPlan(header, [
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
        "-0.10",
        "50.00",
      ],
    ]);
    expect(plan.fields.entryPrice).toBe(5);
    expect(plan.fields.exitPrice).toBe(9);
    expect(plan.fields.entryTime).toBe(1);
    expect(plan.fields.exitTime).toBe(8);
    expect(plan.fields.direction).toBe(2);
    expect(plan.fields.stopPrice).toBe(6);
    expect(plan.feeColumns).toEqual([10, 11]); // Commission and Taxes both count
    expect(plan.fields.swap).toBe(12);
  });

  it("a Date column next to a Time column is ONE timestamp, not an exit leg", () => {
    const plan = buildHeaderPlan(
      [
        "DATE",
        "TIME",
        "TYPE",
        "REF #",
        "DESCRIPTION",
        "Misc Fees",
        "Commissions & Fees",
        "AMOUNT",
        "BALANCE",
      ],
      [["7/2/26", "13:31:05", "TRD", "123", "BOT +500 TZA @3.8", "", "", "(1900.00)", "8100.00"]],
    );
    expect(plan.entryTimeParts).toEqual([0, 1]);
    expect(plan.fields.exitTime).toBeUndefined();
    expect(plan.feeColumns).toEqual([5, 6]);
  });

  it("a bare Time column with no Date column is a full timestamp (MT5 deals)", () => {
    const plan = buildHeaderPlan(
      [
        "Time",
        "Deal",
        "Symbol",
        "Type",
        "Direction",
        "Volume",
        "Price",
        "Order",
        "Commission",
        "Fee",
        "Swap",
        "Profit",
        "Balance",
        "Comment",
      ],
      [
        [
          "2026.01.05 10:00:00",
          "2",
          "EURUSD",
          "buy",
          "in",
          "0.10",
          "1.0850",
          "2",
          "-0.20",
          "0.00",
          "0.00",
          "0.00",
          "",
          "",
        ],
        [
          "2026.01.05 12:00:00",
          "3",
          "EURUSD",
          "sell",
          "out",
          "0.10",
          "1.0900",
          "3",
          "-0.20",
          "0.00",
          "0.00",
          "50.00",
          "",
          "",
        ],
      ],
    );
    expect(plan.fields.entryTime).toBe(0);
    expect(plan.entryTimeParts).toBeNull();
    expect(plan.fields.direction).toBe(3); // Type resolved by buy/sell values
    expect(plan.fields.eventType).toBe(4); // Direction resolved by in/out values
    expect(plan.fields.quantity).toBe(5);
  });

  it("the header row is located behind statement preambles, requiring zero numeric cells", () => {
    const rows = [
      ["This document is a statement export."],
      [""],
      ["Account Statement for 462XXXXXX (Individual) since 7/2/26 through 7/2/26"],
      ["Cash Balance"],
      [
        "DATE",
        "TIME",
        "TYPE",
        "REF #",
        "DESCRIPTION",
        "Misc Fees",
        "Commissions & Fees",
        "AMOUNT",
        "BALANCE",
      ],
      ["7/2/26", "13:31:05", "TRD", "1", "BOT +500 TZA @3.8", "", "", "(1900.00)", "8100.00"],
    ];
    const located = locateHeader(rows);
    expect(located?.rowIndex).toBe(4);
  });

  it("TradingView generation-2 headers map, currency suffixes and all", () => {
    const plan = buildHeaderPlan(
      [
        "Trade number",
        "Type",
        "Date and time",
        "Signal",
        "Price USD",
        "Size (qty)",
        "Net PnL USD",
        "Run-up USD",
        "Drawdown USD",
      ],
      [
        ["1", "Exit long", "2026-01-05 12:00", "Close", "1.0900", "1", "50.00", "60.00", "10.00"],
        ["1", "Entry long", "2026-01-05 10:00", "Open", "1.0850", "1", "50.00", "60.00", "10.00"],
      ],
    );
    expect(plan.fields.tradeId).toBe(0);
    expect(plan.fields.eventType).toBe(1);
    expect(plan.fields.entryTime).toBe(2);
    expect(plan.fields.entryPrice).toBe(4);
    expect(plan.fields.quantity).toBe(5);
    expect(plan.fields.pnl).toBe(6);
  });
});
