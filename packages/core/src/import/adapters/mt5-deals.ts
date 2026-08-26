/*
  MetaTrader 5 "Deals" tables: the only trade data in MT5 strategy-tester
  reports, also present in history reports.

    Time, Deal, Symbol, Type, Direction, Volume, Price, Order, [Cost,]
    Commission, [Fee,] Swap, Profit, Balance, Comment

  Semantics a generic reading gets wrong, encoded here:
  - "Type" (buy/sell) is the FILL side; an "out" deal that sells closes a
    LONG, so the POSITION direction inverts on exits.
  - "Direction" is in / out / in-out; a reversal deal (in-out) splits into
    the exit of the old position and the entry of the new one.
  - Profit sits on "out" deals, GROSS; commissions sit on both legs; swap on
    the closing leg. Balance rows are skipped. Volumes may render
    "0.06 / 0.06" (filled / ordered).
  - Deals carry no position id: pairing replays the net position per symbol
    (correct under MT5 netting). No stop exists at deal level, so the result
    is needs-risk.
*/

import { type TableSection } from "../aliases.js";
import { cleanCell, parseNumberCell, parseVolumeCell } from "../csv.js";
import { addIssue } from "../model.js";
import { reconstructFromExecutions, type ExecutionFill } from "../reconstruct.js";
import { buildTimestampParser } from "../timestamps.js";
import {
  normalizedNames,
  type AdapterBuildResult,
  type AdapterContext,
  type AdapterMatch,
  type ImportAdapter,
  type ImportDoc,
} from "./types.js";

function sectionMatches(section: TableSection): boolean {
  const names = normalizedNames(section.plan.header);
  const fields = section.plan.fields;
  return (
    names.has("deal") &&
    names.has("direction") &&
    names.has("profit") &&
    names.has("time") &&
    fields.direction !== undefined && // Type resolved to buy/sell by values
    fields.eventType !== undefined && // Direction resolved to in/out by values
    fields.quantity !== undefined
  );
}

export const mt5DealsAdapter: ImportAdapter = {
  id: "mt5-deals",
  label: "MetaTrader 5 deals table",

  detect(doc: ImportDoc): AdapterMatch | null {
    for (let tableIndex = 0; tableIndex < doc.tables.length; tableIndex++) {
      for (const section of doc.tables[tableIndex]!.sections) {
        if (!sectionMatches(section)) continue;
        return {
          table: tableIndex,
          section,
          signals: [
            "deals columns matched (Time, Deal, Type, Direction, Volume, Price, Profit)",
            "in/out values found in the Direction column",
          ],
        };
      }
    }
    return null;
  },

  build(doc: ImportDoc, match: AdapterMatch, ctx: AdapterContext): AdapterBuildResult {
    const table = doc.tables[match.table]!;
    const section = match.section;
    const fields = section.plan.fields;
    const rows = table.rows.slice(section.start, section.end);
    const rowNumbers = table.rowNumbers.slice(section.start, section.end);

    const parser = buildTimestampParser(
      rows.map((row) => (fields.entryTime === undefined ? "" : (row[fields.entryTime] ?? ""))),
      ctx.options.dateOrder,
      ctx.issues,
    );

    const fills: ExecutionFill[] = [];
    let dataRows = 0;
    let skippedRows = 0;
    let ledgerRows = 0;
    let labelMismatches = 0;
    const positions = new Map<string, number>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const sourceRow = rowNumbers[i] ?? section.start + i + 1;
      if (row.every((cell) => cell.trim() === "")) continue;
      dataRows++;

      const cell = (index: number | undefined): string => (index === undefined ? "" : (row[index] ?? ""));
      const type = cleanCell(cell(fields.direction)).toLowerCase();
      if (type !== "buy" && type !== "sell") {
        ledgerRows++; // balance / credit / initial deposit deals
        continue;
      }
      const label = cleanCell(cell(fields.eventType))
        .toLowerCase()
        .replace(/[^a-z]/g, "");
      const time = parser.parse(cell(fields.entryTime));
      const price = parseNumberCell(cell(fields.entryPrice));
      const volume = parseVolumeCell(cell(fields.quantity));
      if (!Number.isFinite(time) || price === null || volume === null || volume <= 0) {
        addIssue(
          ctx.issues,
          "warning",
          "row-bad-values",
          "Deal skipped: unreadable time, price, or volume.",
          { row: sourceRow },
        );
        skippedRows++;
        continue;
      }
      const signedQuantity = type === "buy" ? volume : -volume;
      const symbol = cleanCell(cell(fields.symbol)).toUpperCase();

      // Cross-check the in/out label against the replayed net position:
      // a mismatch means the table is not what this adapter thinks it is.
      const before = positions.get(symbol) ?? 0;
      const after = before + signedQuantity;
      positions.set(symbol, Math.abs(after) < 1e-12 ? 0 : after);
      const crosses = before !== 0 && Math.sign(after) !== Math.sign(before) && after !== 0;
      const reduces = Math.abs(after) < Math.abs(before) || after === 0;
      const labelOk =
        label === "" ||
        (label === "in" && !reduces && !crosses) ||
        (label === "out" && reduces && !crosses) ||
        (label === "inout" && crosses);
      if (!labelOk) labelMismatches++;

      let costs = 0;
      for (const feeIndex of section.plan.feeColumns) {
        const value = parseNumberCell(row[feeIndex] ?? "");
        if (value !== null) costs += value;
      }
      const swap = fields.swap !== undefined ? parseNumberCell(cell(fields.swap)) : null;
      if (swap !== null) costs += swap;

      const profit = parseNumberCell(cell(fields.pnl));
      const reducing = reduces || crosses;
      fills.push({
        sourceRow,
        symbol,
        time,
        price,
        signedQuantity,
        fees: -costs, // the file signs costs negative; fills carry positive cost
        pnl: reducing ? profit : null, // a null here on a reducing fill is flagged by the replay
      });
    }

    if (ledgerRows > 0) {
      addIssue(
        ctx.issues,
        "info",
        "ledger-rows-skipped",
        `${ledgerRows} balance/credit deal row(s) were skipped.`,
      );
    }
    if (labelMismatches > 0) {
      addIssue(
        ctx.issues,
        "warning",
        "deal-direction-mismatch",
        `${labelMismatches} deal(s) carry an in/out label that contradicts the replayed net position. ` +
          "The replay was trusted; check whether this account really runs MT5 netting.",
      );
    }

    const replayed = reconstructFromExecutions(fills, ctx.issues, { pnlFrom: "fills" });
    return {
      trades: replayed.trades,
      openTrades: replayed.openTrades,
      header: section.plan.header,
      mapping: fields,
      rows: dataRows,
      skippedRows: skippedRows + replayed.skippedRows,
      source: "executions",
    };
  },
};
