/*
  The generic fallback: alias-map the header, then pick the ROW SHAPE from
  which columns exist.

  - trade-per-row: journals and round-trip reports (an exit time, a P&L, or
    an R per row, no event-type column).
  - event rows: entry/exit legs, paired by trade id (FIFO within
    symbol+direction only as pairEvents' explicitly warned fallback).
  - raw executions: a side (or signed quantities), one time, one price, no
    outcome columns. P&L can only come from prices x quantity, which is
    disclosed: futures multipliers are unknown, so it may be scaled wrong.

  Also the EXPLICIT "generic-csv" import mode: detection is skipped and a
  template-coverage diagnostic reports which template columns matched.
*/

import { locateHeader, normalizeHeader, type HeaderPlan, type TableSection } from "../aliases.js";
import { cleanCell, neutralizeText, parseNumberCell } from "../csv.js";
import {
  addIssue,
  GENERIC_CSV_HEADER,
  GENERIC_FORMAT_ADVICE,
  isEmptyCell,
  type CanonicalField,
  type ImportedTrade,
  type TradeDirection,
} from "../model.js";
import {
  pairEvents,
  reconstructFromExecutions,
  type ExecutionFill,
  type TradeEvent,
} from "../reconstruct.js";
import { buildTimestampParser, mergeDateTimeCells, type BoundTimestampParser } from "../timestamps.js";
import type { AdapterBuildResult, AdapterContext, AdapterMatch, ImportAdapter, ImportDoc } from "./types.js";

const DROPPED_STATUSES = new Set(["canceled", "cancelled", "rejected", "expired", "working", "pending"]);

function parseDirection(raw: string): TradeDirection | null {
  const v = cleanCell(raw)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  if (/^(long|buy|b|bot|1|buytoopen|buytocover)$/.test(v)) return "long";
  if (/^(short|sell|s|sold|-1|selltoopen|sellshort)$/.test(v)) return "short";
  return null;
}

function bestSection(doc: ImportDoc): { table: number; section: TableSection } | null {
  let best: { table: number; section: TableSection; score: number } | null = null;
  for (let tableIndex = 0; tableIndex < doc.tables.length; tableIndex++) {
    const table = doc.tables[tableIndex]!;
    // Row 0 (or a preamble-buried header) via locateHeader, plus every
    // statement section: whichever reading maps the most canonical fields.
    const candidates: TableSection[] = [...table.sections];
    const located = locateHeader(table.rows);
    if (located !== null && !candidates.some((section) => section.headerIndex === located.rowIndex)) {
      let end = located.rowIndex + 1;
      while (end < table.rows.length && !table.rows[end]!.every((cell) => cell.trim() === "")) end++;
      candidates.push({
        headerIndex: located.rowIndex,
        plan: located.plan,
        start: located.rowIndex + 1,
        end,
      });
    }
    for (const section of candidates) {
      const score = section.plan.matchedFields.length;
      if (score >= 2 && (best === null || score > best.score)) {
        best = { table: tableIndex, section, score };
      }
    }
  }
  return best === null ? null : { table: best.table, section: best.section };
}

export const genericCsvAdapter: ImportAdapter = {
  id: "generic-csv",
  label: "generic delimited trade history",

  detect(doc: ImportDoc): AdapterMatch | null {
    const found = bestSection(doc);
    if (found === null) return null;
    return {
      table: found.table,
      section: found.section,
      signals: [
        `header row recognized with ${found.section.plan.matchedFields.length} mapped column(s): ` +
          found.section.plan.matchedFields.join(", "),
      ],
    };
  },

  build(doc: ImportDoc, match: AdapterMatch, ctx: AdapterContext): AdapterBuildResult {
    const table = doc.tables[match.table]!;
    const section = match.section;
    const plan = section.plan;
    const fields: Partial<Record<CanonicalField, number>> = { ...plan.fields, ...ctx.options.mapping };

    const rows = table.rows.slice(section.start, section.end);
    const rowNumbers = table.rowNumbers.slice(section.start, section.end);

    // File-level fee sign convention: any negative fee value means the file
    // signs costs negative; otherwise fees are positive costs already.
    let feeSign = 1;
    outer: for (const row of rows) {
      for (const feeIndex of plan.feeColumns) {
        const value = parseNumberCell(row[feeIndex] ?? "");
        if (value !== null && value < 0) {
          feeSign = -1;
          break outer;
        }
      }
    }
    const rowFees = (row: string[]): number | null => {
      let sum = 0;
      let saw = false;
      for (const feeIndex of plan.feeColumns) {
        const value = parseNumberCell(row[feeIndex] ?? "");
        if (value !== null) {
          sum += value;
          saw = true;
        }
      }
      return saw ? feeSign * sum : null;
    };

    const timeSamples: string[] = [];
    for (const row of rows) {
      if (plan.entryTimeParts !== null)
        timeSamples.push(
          mergeDateTimeCells(row[plan.entryTimeParts[0]] ?? "", row[plan.entryTimeParts[1]] ?? ""),
        );
      else if (fields.entryTime !== undefined) timeSamples.push(row[fields.entryTime] ?? "");
      if (plan.exitTimeParts !== null)
        timeSamples.push(
          mergeDateTimeCells(row[plan.exitTimeParts[0]] ?? "", row[plan.exitTimeParts[1]] ?? ""),
        );
      else if (fields.exitTime !== undefined) timeSamples.push(row[fields.exitTime] ?? "");
    }
    const parser = buildTimestampParser(timeSamples, ctx.options.dateOrder, ctx.issues);
    const entryTimeOf = (row: string[]): number =>
      plan.entryTimeParts !== null
        ? parser.parse(
            mergeDateTimeCells(row[plan.entryTimeParts[0]] ?? "", row[plan.entryTimeParts[1]] ?? ""),
          )
        : fields.entryTime !== undefined
          ? parser.parse(row[fields.entryTime] ?? "")
          : Number.NaN;
    const exitTimeOf = (row: string[]): number =>
      plan.exitTimeParts !== null
        ? parser.parse(mergeDateTimeCells(row[plan.exitTimeParts[0]] ?? "", row[plan.exitTimeParts[1]] ?? ""))
        : fields.exitTime !== undefined
          ? parser.parse(row[fields.exitTime] ?? "")
          : Number.NaN;

    // The required minimum: an open time plus SOME outcome.
    const hasOutcome =
      fields.r !== undefined ||
      fields.pnl !== undefined ||
      fields.riskAmount !== undefined ||
      (fields.entryPrice !== undefined && fields.exitPrice !== undefined) ||
      (fields.direction !== undefined && fields.entryPrice !== undefined);
    if (fields.entryTime === undefined || !hasOutcome) {
      const matched = plan.matchedFields.length > 0 ? plan.matchedFields.join(", ") : "none";
      addIssue(
        ctx.issues,
        "error",
        "unmapped-required-fields",
        `The header was found but the required minimum is not mapped (need an open time plus an outcome: ` +
          `an r column, a pnl column, or prices). Mapped: ${matched}. ${GENERIC_FORMAT_ADVICE}`,
        { row: table.rowNumbers[section.headerIndex] ?? section.headerIndex + 1 },
      );
      return {
        trades: [],
        openTrades: [],
        header: plan.header,
        mapping: fields,
        rows: 0,
        skippedRows: 0,
        source: "trades",
      };
    }

    // Row-shape decision, from which columns exist.
    const shape: "events" | "executions" | "trades" =
      fields.eventType !== undefined
        ? "events"
        : fields.exitTime === undefined &&
            fields.exitPrice === undefined &&
            fields.pnl === undefined &&
            fields.r === undefined &&
            fields.entryPrice !== undefined &&
            fields.quantity !== undefined
          ? "executions"
          : "trades";

    let statusDropped = 0;
    const keepRow = (row: string[]): boolean => {
      if (plan.statusColumn === null) return true;
      const status = cleanCell(row[plan.statusColumn] ?? "").toLowerCase();
      if (DROPPED_STATUSES.has(status)) {
        statusDropped++;
        return false;
      }
      return true;
    };

    let built: { trades: ImportedTrade[]; openTrades: ImportedTrade[]; skippedRows: number };
    let dataRows = 0;
    let skippedRows = 0;
    let derivedPnl = 0;

    if (shape === "events") {
      const events: TradeEvent[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const sourceRow = rowNumbers[i] ?? section.start + i + 1;
        if (row.every((cell) => cell.trim() === "")) continue;
        dataRows++;
        if (!keepRow(row)) continue;
        const cell = (index: number | undefined): string => (index === undefined ? "" : (row[index] ?? ""));
        const typeRaw = cleanCell(cell(fields.eventType))
          .toLowerCase()
          .replace(/[^a-z]/g, "");
        const eventType = /^(entry|in|open|buytoopen|selltoopen|toopen)$/.test(typeRaw)
          ? "entry"
          : /^(exit|out|close|toclose|buytoclose|selltoclose)$/.test(typeRaw)
            ? "exit"
            : null;
        const time = entryTimeOf(row);
        if (!Number.isFinite(time) || eventType === null) {
          addIssue(
            ctx.issues,
            "warning",
            "row-bad-values",
            "Row skipped: unreadable time or entry/exit marker.",
            { row: sourceRow },
          );
          skippedRows++;
          continue;
        }
        events.push({
          sourceRow,
          id: cleanCell(cell(fields.tradeId)) || null,
          symbol: neutralizeText(cell(fields.symbol)).value.toUpperCase() || null,
          direction: parseDirection(cell(fields.direction)),
          eventType,
          time,
          price: parseNumberCell(cell(fields.entryPrice)),
          quantity: absOrNull(parseNumberCell(cell(fields.quantity))),
          pnl: parseNumberCell(cell(fields.pnl)),
          fees: rowFees(row),
          stopPrice: parseNumberCell(cell(fields.stopPrice)),
          riskAmount: parseNumberCell(cell(fields.riskAmount)),
          r: parseNumberCell(cell(fields.r)),
        });
      }
      built = pairEvents(events, ctx.issues, { totalsOnExit: true });
    } else if (shape === "executions") {
      addIssue(
        ctx.issues,
        "warning",
        "pnl-derived-from-prices",
        "This file holds raw executions with no P&L column, so P&L is computed as price change times " +
          "quantity. That assumes one currency unit per price unit per unit of quantity: futures and CFD " +
          "multipliers are unknown to the file, so the P&L scale may be wrong for them.",
      );
      const fills: ExecutionFill[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const sourceRow = rowNumbers[i] ?? section.start + i + 1;
        if (row.every((cell) => cell.trim() === "")) continue;
        dataRows++;
        if (!keepRow(row)) continue;
        const cell = (index: number | undefined): string => (index === undefined ? "" : (row[index] ?? ""));
        const time = entryTimeOf(row);
        const price = parseNumberCell(cell(fields.entryPrice));
        const quantityRaw = parseNumberCell(cell(fields.quantity));
        const direction = parseDirection(cell(fields.direction));
        if (!Number.isFinite(time) || price === null || quantityRaw === null || quantityRaw === 0) {
          addIssue(
            ctx.issues,
            "warning",
            "row-bad-values",
            "Execution skipped: unreadable time, price, or quantity.",
            { row: sourceRow },
          );
          skippedRows++;
          continue;
        }
        // Side column wins; otherwise the signed-quantity convention.
        let signedQuantity: number;
        if (direction !== null)
          signedQuantity = direction === "long" ? Math.abs(quantityRaw) : -Math.abs(quantityRaw);
        else signedQuantity = quantityRaw;
        fills.push({
          sourceRow,
          symbol: neutralizeText(cell(fields.symbol)).value.toUpperCase(),
          time,
          price,
          signedQuantity,
          fees: rowFees(row),
          pnl: null,
        });
      }
      built = reconstructFromExecutions(fills, ctx.issues, { pnlFrom: "prices" });
    } else {
      const trades: ImportedTrade[] = [];
      const openTrades: ImportedTrade[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const sourceRow = rowNumbers[i] ?? section.start + i + 1;
        if (row.every((cell) => cell.trim() === "")) continue;
        dataRows++;
        if (!keepRow(row)) continue;
        const cell = (index: number | undefined): string => (index === undefined ? "" : (row[index] ?? ""));
        const entryTime = entryTimeOf(row);
        if (!Number.isFinite(entryTime)) {
          addIssue(
            ctx.issues,
            "warning",
            "row-bad-timestamp",
            `Row skipped: cannot read "${cleanCell(cell(fields.entryTime))}" as the open time.`,
            {
              row: sourceRow,
            },
          );
          skippedRows++;
          continue;
        }
        const exitTime = exitTimeOf(row);
        const direction = parseDirection(cell(fields.direction));
        const entryPrice = parseNumberCell(cell(fields.entryPrice));
        const exitPrice = parseNumberCell(cell(fields.exitPrice));
        const quantity = absOrNull(parseNumberCell(cell(fields.quantity)));
        let pnl = parseNumberCell(cell(fields.pnl));
        const fees = rowFees(row);
        if (
          pnl === null &&
          fields.pnl === undefined &&
          direction !== null &&
          entryPrice !== null &&
          exitPrice !== null &&
          quantity !== null
        ) {
          pnl = (exitPrice - entryPrice) * quantity * (direction === "long" ? 1 : -1) - (fees ?? 0);
          derivedPnl++;
        }
        const open =
          !Number.isFinite(exitTime) &&
          exitPrice === null &&
          pnl === null &&
          parseNumberCell(cell(fields.r)) === null;
        const trade: ImportedTrade = {
          id: cleanCell(cell(fields.tradeId)) || null,
          symbol: neutralizeText(cell(fields.symbol)).value.toUpperCase() || null,
          direction,
          entryTime,
          exitTime: Number.isFinite(exitTime) ? exitTime : null,
          entryPrice,
          exitPrice,
          quantity,
          pnl,
          fees,
          stopPrice: emptyToNull(cell(fields.stopPrice)),
          riskAmount: parseNumberCell(cell(fields.riskAmount)),
          r: parseNumberCell(cell(fields.r)),
          rSource: "unavailable",
          status: open ? "open" : "closed",
          sourceRows: [sourceRow],
        };
        if (open) openTrades.push(trade);
        else trades.push(trade);
      }
      built = { trades, openTrades, skippedRows: 0 };
    }

    if (statusDropped > 0) {
      addIssue(
        ctx.issues,
        "info",
        "status-rows-dropped",
        `${statusDropped} row(s) with a cancelled/rejected/working status were dropped: they never filled.`,
      );
    }
    if (derivedPnl > 0) {
      addIssue(
        ctx.issues,
        "warning",
        "pnl-derived-from-prices",
        `${derivedPnl} trade(s) carry no P&L column, so P&L was computed from prices times quantity. ` +
          "Futures and CFD multipliers are unknown to the file, so the scale may be wrong for them.",
      );
    }

    return {
      trades: built.trades,
      openTrades: built.openTrades,
      header: plan.header,
      mapping: fields,
      rows: dataRows,
      skippedRows: skippedRows + built.skippedRows + statusDropped,
      source: shape,
    };
  },
};

function absOrNull(value: number | null): number | null {
  return value === null ? null : Math.abs(value);
}

function emptyToNull(raw: string): number | null {
  if (isEmptyCell(raw)) return null;
  const value = parseNumberCell(raw);
  return value === 0 ? null : value; // 0 means "no stop" in every real export
}

/** The template columns, for the explicit-mode coverage diagnostic. */
export function templateCoverage(plan: HeaderPlan): { matched: string[]; missing: string[] } {
  const templateFields: Array<[string, CanonicalField]> = GENERIC_CSV_HEADER.split(",").map((name) => {
    const canonical: Record<string, CanonicalField> = {
      "open time": "entryTime",
      "close time": "exitTime",
      symbol: "symbol",
      direction: "direction",
      quantity: "quantity",
      "entry price": "entryPrice",
      "exit price": "exitPrice",
      "stop loss": "stopPrice",
      pnl: "pnl",
      fees: "fees",
      r: "r",
    };
    return [name, canonical[name]!];
  });
  const matched: string[] = [];
  const missing: string[] = [];
  for (const [name, field] of templateFields) {
    const present =
      field === "entryTime"
        ? plan.fields.entryTime !== undefined || plan.entryTimeParts !== null
        : field === "fees"
          ? plan.feeColumns.length > 0
          : plan.fields[field] !== undefined;
    if (present) matched.push(name);
    else missing.push(name);
  }
  return { matched, missing };
}
