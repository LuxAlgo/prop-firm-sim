/*
  MetaTrader statement rows: MT4 account statements (CSV or the HTML report,
  which is MetaTrader's only export button) and MT5 history reports'
  Positions section. One row per closed trade with a Ticket/Position id,
  duplicated Time/Price pairs, S/L, and Profit with signed Commission /
  Taxes / Swap columns:

    Net P&L = Profit + Commission + Taxes + Swap (all signed by the file).

  R from S/L without contract sizes: the currency-per-price-unit rate is
  derived from the trade's own gross P&L divided by its signed price move,
  and risk = stop distance x that rate (rmultiple.ts). A stop on the profit
  side or at entry is refused: MT history shows the LAST stop, not the
  initial one. Pending orders (buy limit, sell stop, ...) and
  balance/credit rows are skipped, and Open Trades / Working Orders
  sections never become closed trades.
*/

import { type TableSection } from "../aliases.js";
import { cleanCell, parseNumberCell, parseVolumeCell } from "../csv.js";
import { addIssue, type ImportedTrade } from "../model.js";
import { buildTimestampParser, type BoundTimestampParser } from "../timestamps.js";
import {
  normalizedNames,
  type AdapterBuildResult,
  type AdapterContext,
  type AdapterMatch,
  type ImportAdapter,
  type ImportDoc,
} from "./types.js";

function sectionMatches(section: TableSection): boolean {
  const fields = section.plan.fields;
  return (
    fields.tradeId !== undefined &&
    fields.stopPrice !== undefined &&
    fields.pnl !== undefined &&
    fields.entryPrice !== undefined &&
    fields.exitPrice !== undefined &&
    fields.entryTime !== undefined &&
    fields.direction !== undefined
  );
}

/** A title row like "Open Trades:" within the few rows above a header. */
function titledOpenSection(rows: readonly string[][], headerIndex: number): boolean {
  for (let back = 1; back <= 3; back++) {
    const row = rows[headerIndex - back];
    if (row === undefined) break;
    const cells = row.filter((cell) => cell.trim() !== "");
    if (cells.length === 0) continue;
    if (cells.length <= 2 && /open/i.test(cells[0]!)) return true;
  }
  return false;
}

type RowKind = "trade" | "pending" | "ledger" | "unknown";

function classifyType(raw: string): RowKind {
  const v = cleanCell(raw).toLowerCase();
  if (/^(buy|sell)$/.test(v)) return "trade";
  if (/^(buy|sell)\s+(limit|stop|stop\s*limit)$/.test(v)) return "pending";
  if (/^(balance|credit|deposit|withdrawal|rebate|correction)/.test(v)) return "ledger";
  return "unknown";
}

export const metatraderAdapter: ImportAdapter = {
  id: "metatrader",
  label: "MetaTrader 4/5 account statement",

  detect(doc: ImportDoc): AdapterMatch | null {
    for (let tableIndex = 0; tableIndex < doc.tables.length; tableIndex++) {
      for (const section of doc.tables[tableIndex]!.sections) {
        if (!sectionMatches(section)) continue;
        if (titledOpenSection(doc.tables[tableIndex]!.rows, section.headerIndex)) continue; // never claim Open Trades first
        const names = normalizedNames(section.plan.header);
        const idName = names.has("ticket") ? "Ticket" : names.has("position") ? "Position" : "id";
        return {
          table: tableIndex,
          section,
          signals: [
            `statement columns matched (${idName}, duplicated Time/Price, S/L, Profit)`,
            "buy/sell values found in the Type column",
          ],
        };
      }
    }
    return null;
  },

  build(doc: ImportDoc, match: AdapterMatch, ctx: AdapterContext): AdapterBuildResult {
    const table = doc.tables[match.table]!;
    const closed = buildSectionTrades(table, match.section, ctx, "closed");

    // Import a subsequent matching section titled "Open Trades" as open
    // positions; its floating P&L is NOT a realized result and stays null.
    const openTrades: ImportedTrade[] = [];
    for (const section of table.sections) {
      if (section === match.section || !sectionMatches(section)) continue;
      if (!titledOpenSection(table.rows, section.headerIndex)) continue;
      const open = buildSectionTrades(table, section, ctx, "open");
      openTrades.push(...open.trades);
      break;
    }

    return {
      trades: closed.trades,
      openTrades,
      header: match.section.plan.header,
      mapping: match.section.plan.fields,
      rows: closed.rows,
      skippedRows: closed.skippedRows,
      source: "trades",
    };
  },
};

function buildSectionTrades(
  table: { rows: string[][]; rowNumbers: number[] },
  section: TableSection,
  ctx: AdapterContext,
  status: "closed" | "open",
): { trades: ImportedTrade[]; rows: number; skippedRows: number } {
  const fields = section.plan.fields;
  const rows = table.rows.slice(section.start, section.end);
  const rowNumbers = table.rowNumbers.slice(section.start, section.end);

  const timeSamples: string[] = [];
  for (const row of rows) {
    if (fields.entryTime !== undefined) timeSamples.push(row[fields.entryTime] ?? "");
    if (fields.exitTime !== undefined) timeSamples.push(row[fields.exitTime] ?? "");
  }
  const parser: BoundTimestampParser = buildTimestampParser(timeSamples, ctx.options.dateOrder, ctx.issues);

  const trades: ImportedTrade[] = [];
  let dataRows = 0;
  let skippedRows = 0;
  let pendingRows = 0;
  let ledgerRows = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const sourceRow = rowNumbers[i] ?? section.start + i + 1;
    if (row.every((cell) => cell.trim() === "")) continue;
    dataRows++;

    const cell = (index: number | undefined): string => (index === undefined ? "" : (row[index] ?? ""));
    const kind = classifyType(cell(fields.direction));
    if (kind === "pending") {
      pendingRows++;
      continue;
    }
    if (kind === "ledger") {
      ledgerRows++;
      continue;
    }
    if (kind === "unknown") {
      addIssue(
        ctx.issues,
        "warning",
        "row-unrecognized-type",
        `Row skipped: unrecognized order type "${cleanCell(cell(fields.direction))}".`,
        {
          row: sourceRow,
        },
      );
      skippedRows++;
      continue;
    }

    const direction = cleanCell(cell(fields.direction)).toLowerCase() === "buy" ? "long" : "short";
    const entryTime = parser.parse(cell(fields.entryTime));
    if (!Number.isFinite(entryTime)) {
      addIssue(ctx.issues, "warning", "row-bad-timestamp", "Row skipped: unreadable open time.", {
        row: sourceRow,
      });
      skippedRows++;
      continue;
    }

    const profit = parseNumberCell(cell(fields.pnl));
    const feeAdjustments: number[] = [];
    for (const feeIndex of section.plan.feeColumns) {
      const value = parseNumberCell(row[feeIndex] ?? "");
      if (value !== null) feeAdjustments.push(value);
    }
    const swap = fields.swap !== undefined ? parseNumberCell(cell(fields.swap)) : null;
    if (swap !== null) feeAdjustments.push(swap);
    const adjustment = feeAdjustments.reduce((sum, value) => sum + value, 0);

    const stopRaw = parseNumberCell(cell(fields.stopPrice));

    const trade: ImportedTrade = {
      id: cleanCell(cell(fields.tradeId)) || null,
      symbol: cleanCell(cell(fields.symbol)).toUpperCase() || null,
      direction,
      entryTime,
      exitTime: status === "closed" ? nanToNull(parser.parse(cell(fields.exitTime))) : null,
      entryPrice: parseNumberCell(cell(fields.entryPrice)),
      exitPrice: status === "closed" ? parseNumberCell(cell(fields.exitPrice)) : null,
      quantity: parseVolumeCell(cell(fields.quantity)),
      pnl: status === "closed" && profit !== null ? profit + adjustment : null,
      fees: feeAdjustments.length > 0 ? -adjustment : null,
      stopPrice: stopRaw === null || stopRaw === 0 ? null : stopRaw,
      riskAmount: null,
      r: null,
      rSource: "unavailable",
      status,
      sourceRows: [sourceRow],
    };
    trades.push(trade);
  }

  if (pendingRows > 0) {
    addIssue(
      ctx.issues,
      "info",
      "pending-orders-skipped",
      `${pendingRows} pending order row(s) (buy/sell limit or stop) were skipped: they are not trades.`,
    );
  }
  if (ledgerRows > 0) {
    addIssue(
      ctx.issues,
      "info",
      "ledger-rows-skipped",
      `${ledgerRows} balance/credit ledger row(s) were skipped.`,
    );
  }

  return { trades, rows: dataRows, skippedRows };
}

function nanToNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}
