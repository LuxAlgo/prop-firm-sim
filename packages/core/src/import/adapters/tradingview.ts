/*
  TradingView strategy-tester "List of trades" exports, both generations:

    gen 1: Trade #,Type,Signal,Date/Time,Price,Contracts,Profit,...
    gen 2: Trade number,Type,Date and time,Signal,Price USD,Size (qty),
           Net PnL USD,... (any currency suffix)

  Two rows per trade share a trade number, the EXIT row is listed first, and
  trade totals are mirrored on BOTH rows, so totals are read from exit rows
  only. An open trade has an exit row whose date reads "Open" with an empty
  price; that row is dropped and the surviving entry surfaces as an open
  trade. No symbol column and no risk data exist, so the result is
  needs-risk by construction.
*/

import { buildHeaderPlan } from "../aliases.js";
import { cleanCell, parseNumberCell } from "../csv.js";
import { addIssue, isEmptyCell, type TradeDirection } from "../model.js";
import { pairEvents, type TradeEvent } from "../reconstruct.js";
import { buildTimestampParser } from "../timestamps.js";
import {
  normalizedNames,
  type AdapterBuildResult,
  type AdapterContext,
  type AdapterMatch,
  type ImportAdapter,
  type ImportDoc,
} from "./types.js";

function generationOf(names: Set<string>): 1 | 2 | null {
  const hasCore = names.has("type") && names.has("signal");
  if (!hasCore) return null;
  if (names.has("trade") && names.has("datetime")) return 1;
  if (names.has("tradenumber") && names.has("dateandtime")) return 2;
  return null;
}

function directionOf(typeValue: string): TradeDirection | null {
  const v = typeValue.toLowerCase();
  if (v.includes("long")) return "long";
  if (v.includes("short")) return "short";
  return null;
}

export const tradingviewAdapter: ImportAdapter = {
  id: "tradingview",
  label: "TradingView strategy tester (list of trades)",

  detect(doc: ImportDoc): AdapterMatch | null {
    for (let tableIndex = 0; tableIndex < doc.tables.length; tableIndex++) {
      for (const section of doc.tables[tableIndex]!.sections) {
        const names = normalizedNames(section.plan.header);
        const generation = generationOf(names);
        if (generation === null) continue;
        if (section.plan.fields.eventType === undefined) continue; // Type must hold Entry/Exit values
        return {
          table: tableIndex,
          section,
          signals: [
            `header matches the TradingView strategy tester list of trades (generation ${generation})`,
            'the "Type" column holds Entry/Exit values',
          ],
        };
      }
    }
    return null;
  },

  build(doc: ImportDoc, match: AdapterMatch, ctx: AdapterContext): AdapterBuildResult {
    const table = doc.tables[match.table]!;
    const section = match.section;
    const plan = section.plan;
    const fields = plan.fields;
    const rows = table.rows.slice(section.start, section.end);
    const rowNumbers = table.rowNumbers.slice(section.start, section.end);

    const timeIndex = fields.entryTime;
    const parser = buildTimestampParser(
      timeIndex === undefined ? [] : rows.map((row) => row[timeIndex] ?? ""),
      ctx.options.dateOrder,
      ctx.issues,
    );

    const events: TradeEvent[] = [];
    let skippedRows = 0;
    let openExitRows = 0;
    let dataRows = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const sourceRow = rowNumbers[i] ?? section.start + i + 1;
      if (row.every((cell) => cell.trim() === "")) continue;
      dataRows++;

      const cell = (index: number | undefined): string => (index === undefined ? "" : (row[index] ?? ""));
      const typeRaw = cleanCell(cell(fields.eventType));
      const typeLower = typeRaw.toLowerCase();
      const eventType = typeLower.startsWith("entry")
        ? "entry"
        : typeLower.startsWith("exit")
          ? "exit"
          : null;
      if (eventType === null) {
        addIssue(
          ctx.issues,
          "warning",
          "row-unrecognized-type",
          `Row skipped: "${typeRaw}" is neither an entry nor an exit.`,
          {
            row: sourceRow,
          },
        );
        skippedRows++;
        continue;
      }

      const timeRaw = cell(timeIndex);
      if (eventType === "exit" && cleanCell(timeRaw).toLowerCase() === "open") {
        openExitRows++; // the placeholder exit row of a still-open trade
        continue;
      }
      const time = parser.parse(timeRaw);
      if (!Number.isFinite(time)) {
        addIssue(
          ctx.issues,
          "warning",
          "row-bad-timestamp",
          `Row skipped: cannot read "${cleanCell(timeRaw)}" as a date and time.`,
          {
            row: sourceRow,
          },
        );
        skippedRows++;
        continue;
      }

      events.push({
        sourceRow,
        id: cleanCell(cell(fields.tradeId)) || null,
        symbol: null,
        direction: directionOf(typeRaw),
        eventType,
        time,
        price: isEmptyCell(cell(fields.entryPrice)) ? null : parseNumberCell(cell(fields.entryPrice)),
        quantity: parseNumberCell(cell(fields.quantity)),
        pnl: parseNumberCell(cell(fields.pnl)),
        fees: null,
        stopPrice: null,
        riskAmount: null,
        r: null,
      });
    }

    if (openExitRows > 0) {
      addIssue(
        ctx.issues,
        "info",
        "open-trades-in-source",
        `${openExitRows} trade(s) are still open in the export (exit date "Open"); they are reported as open trades and excluded from simulation input.`,
      );
    }

    const paired = pairEvents(events, ctx.issues, { totalsOnExit: true });
    return {
      trades: paired.trades,
      openTrades: paired.openTrades,
      header: plan.header,
      mapping: fields,
      rows: dataRows,
      skippedRows: skippedRows + paired.skippedRows,
      source: "events",
    };
  },
};

/** Test hook: a section fingerprint check without a full document. */
export function looksLikeTradingViewHeader(
  header: readonly string[],
  sampleRows: readonly string[][],
): boolean {
  const plan = buildHeaderPlan(header, sampleRows);
  const names = normalizedNames(header);
  return generationOf(names) !== null && plan.fields.eventType !== undefined;
}
