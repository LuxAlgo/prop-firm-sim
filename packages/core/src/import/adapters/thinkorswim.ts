/*
  ThinkOrSwim / Schwab "Account Statement" exports: one CSV with titled
  sections (Cash Balance, Futures Statements, Account Order History, Account
  Trade History, Equities, Profits and Losses, ...).

  The trustworthy trade data:
  - "Account Trade History": one row per FILL (Exec Time, Side, signed Qty,
    Pos Effect, Symbol, Price) for stock legs. Fills replay into
    flat-to-flat trades; for STOCK rows price x quantity IS the cash P&L
    (multiplier 1), so nothing is approximated.
  - "Cash Balance": TRD rows carry the fees (Misc Fees, Commissions & Fees)
    and a description ("SOLD -500 TZA @3.81") matched back to fills by
    timestamp and symbol. When the Trade History section is missing, the
    TRD descriptions themselves rebuild the fills.

  Order History is never read for trades: it holds working, cancelled, and
  rejected orders. Non-stock legs (options, futures, forex) are refused
  loudly: their multipliers are not in the file, and a wrong P&L is worse
  than none.
*/

import { buildHeaderPlan, normalizeHeader, type HeaderPlan } from "../aliases.js";
import { cleanCell, neutralizeText, parseNumberCell } from "../csv.js";
import { addIssue } from "../model.js";
import { reconstructFromExecutions, type ExecutionFill } from "../reconstruct.js";
import { buildTimestampParser, mergeDateTimeCells, type BoundTimestampParser } from "../timestamps.js";
import type { AdapterBuildResult, AdapterContext, AdapterMatch, ImportAdapter, ImportDoc } from "./types.js";

interface TitledSection {
  titleRow: number;
  headerIndex: number;
  plan: HeaderPlan;
  start: number;
  end: number;
}

function firstNonEmpty(row: readonly string[]): string {
  for (const cell of row) {
    const trimmed = cell.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

function findTitledSection(rows: readonly string[][], title: string): TitledSection | null {
  const wanted = title.toLowerCase();
  for (let index = 0; index < rows.length; index++) {
    if (firstNonEmpty(rows[index]!).toLowerCase() !== wanted) continue;
    let headerIndex = index + 1;
    while (headerIndex < rows.length && rows[headerIndex]!.every((cell) => cell.trim() === "")) headerIndex++;
    if (headerIndex >= rows.length) return null;
    const header = rows[headerIndex]!;
    if (header.filter((cell) => cell.trim() !== "").length < 3) return null;
    let end = headerIndex + 1;
    while (end < rows.length) {
      const row = rows[end]!;
      const nonEmpty = row.filter((cell) => cell.trim() !== "").length;
      if (nonEmpty === 0) break;
      if (nonEmpty === 1) break; // the next section title (or a lone total line)
      end++;
    }
    const plan = buildHeaderPlan(header, rows.slice(headerIndex + 1, end));
    return { titleRow: index, headerIndex, plan, start: headerIndex + 1, end };
  }
  return null;
}

const DESCRIPTION_FILL = /^(BOT|SOLD)\s+([+-]?[\d,]+(?:\.\d+)?)\s+(\S+)\s+@([\d.,]+)/i;

export const thinkorswimAdapter: ImportAdapter = {
  id: "thinkorswim",
  label: "ThinkOrSwim account statement",

  detect(doc: ImportDoc): AdapterMatch | null {
    for (let tableIndex = 0; tableIndex < doc.tables.length; tableIndex++) {
      const rows = doc.tables[tableIndex]!.rows;
      const hasBanner = rows.some((row) => /^account statement for /i.test(firstNonEmpty(row)));
      if (!hasBanner) continue;
      const tradeHistory = findTitledSection(rows, "Account Trade History");
      const cashBalance = findTitledSection(rows, "Cash Balance");
      const chosen = tradeHistory ?? cashBalance;
      if (chosen === null) continue;
      const signals = ['the "Account Statement for ..." banner is present'];
      if (tradeHistory !== null) signals.push("an Account Trade History section was found (fills)");
      else signals.push("a Cash Balance section was found (TRD rows rebuild the fills)");
      return {
        table: tableIndex,
        signals,
        section: { headerIndex: chosen.headerIndex, plan: chosen.plan, start: chosen.start, end: chosen.end },
      };
    }
    return null;
  },

  build(doc: ImportDoc, match: AdapterMatch, ctx: AdapterContext): AdapterBuildResult {
    const table = doc.tables[match.table]!;
    const rows = table.rows;
    const tradeHistory = findTitledSection(rows, "Account Trade History");
    const cashBalance = findTitledSection(rows, "Cash Balance");

    const result =
      tradeHistory !== null
        ? buildFromTradeHistory(table, tradeHistory, cashBalance, ctx)
        : cashBalance !== null
          ? buildFromCashBalance(table, cashBalance, ctx)
          : null;
    if (result === null) {
      addIssue(
        ctx.issues,
        "error",
        "no-trade-section",
        "Neither an Account Trade History nor a Cash Balance section holds readable trades.",
      );
      return {
        trades: [],
        openTrades: [],
        header: null,
        mapping: {},
        rows: 0,
        skippedRows: 0,
        source: "executions",
      };
    }
    return result;
  },
};

/** Fee lookup from Cash Balance TRD rows, keyed by "epochMs|SYMBOL". */
function collectCashFees(
  table: { rows: string[][] },
  cash: TitledSection,
  parser: BoundTimestampParser,
): Map<string, number> {
  const fees = new Map<string, number>();
  const plan = cash.plan;
  const typeIndex = plan.header.findIndex((cell) => normalizeHeader(cell) === "type");
  const descriptionIndex = plan.header.findIndex((cell) => normalizeHeader(cell) === "description");
  if (plan.entryTimeParts === null || descriptionIndex === -1) return fees;
  const [dateIndex, timeIndex] = plan.entryTimeParts;

  for (let index = cash.start; index < cash.end; index++) {
    const row = table.rows[index]!;
    if (typeIndex !== -1 && cleanCell(row[typeIndex] ?? "").toUpperCase() !== "TRD") continue;
    const description = cleanCell(row[descriptionIndex] ?? "");
    const fill = DESCRIPTION_FILL.exec(description);
    if (fill === null) continue;
    const time = parser.parse(mergeDateTimeCells(row[dateIndex] ?? "", row[timeIndex] ?? ""));
    if (!Number.isFinite(time)) continue;
    let cost = 0;
    for (const feeIndex of plan.feeColumns) {
      const value = parseNumberCell(row[feeIndex] ?? "");
      if (value !== null) cost += -value; // the statement signs fees negative
    }
    if (cost === 0) continue;
    const key = `${time}|${neutralizeText(fill[3]!).value.toUpperCase()}`;
    fees.set(key, (fees.get(key) ?? 0) + cost);
  }
  return fees;
}

function buildFromTradeHistory(
  table: { rows: string[][]; rowNumbers: number[] },
  section: TitledSection,
  cash: TitledSection | null,
  ctx: AdapterContext,
): AdapterBuildResult {
  const plan = section.plan;
  const fields = plan.fields;
  const spreadIndex = plan.header.findIndex((cell) => normalizeHeader(cell) === "spread");
  const timeIndex = fields.entryTime;

  const timeSamples: string[] = [];
  for (let index = section.start; index < section.end; index++) {
    if (timeIndex !== undefined) timeSamples.push(table.rows[index]![timeIndex] ?? "");
  }
  if (cash !== null && cash.plan.entryTimeParts !== null) {
    const [dateIndex] = cash.plan.entryTimeParts;
    for (let index = cash.start; index < cash.end; index++)
      timeSamples.push(table.rows[index]![dateIndex] ?? "");
  }
  const parser = buildTimestampParser(timeSamples, ctx.options.dateOrder, ctx.issues);
  const cashFees = cash !== null ? collectCashFees(table, cash, parser) : new Map<string, number>();

  const fills: ExecutionFill[] = [];
  let dataRows = 0;
  let skippedRows = 0;
  let nonStock = 0;

  for (let index = section.start; index < section.end; index++) {
    const row = table.rows[index]!;
    const sourceRow = table.rowNumbers[index] ?? index + 1;
    if (row.every((cell) => cell.trim() === "")) continue;
    dataRows++;

    const cell = (i: number | undefined): string => (i === undefined ? "" : (row[i] ?? ""));
    if (spreadIndex !== -1 && cleanCell(row[spreadIndex] ?? "").toUpperCase() !== "STOCK") {
      nonStock++;
      continue;
    }
    const time = parser.parse(cell(timeIndex));
    const price = parseNumberCell(cell(fields.entryPrice));
    let quantity = parseNumberCell(cell(fields.quantity));
    const side = cleanCell(cell(fields.direction)).toUpperCase();
    if (!Number.isFinite(time) || price === null || quantity === null || quantity === 0) {
      addIssue(
        ctx.issues,
        "warning",
        "row-bad-values",
        "Fill skipped: unreadable time, price, or quantity.",
        { row: sourceRow },
      );
      skippedRows++;
      continue;
    }
    if (side === "SELL" && quantity > 0) quantity = -quantity;
    if (side === "BUY" && quantity < 0) {
      addIssue(
        ctx.issues,
        "warning",
        "side-quantity-mismatch",
        "Fill skipped: a BUY row carries a negative quantity.",
        {
          row: sourceRow,
        },
      );
      skippedRows++;
      continue;
    }
    const symbol = neutralizeText(cell(fields.symbol)).value.toUpperCase();
    fills.push({
      sourceRow,
      symbol,
      time,
      price,
      signedQuantity: quantity,
      fees: cashFees.get(`${time}|${symbol}`) ?? null,
      pnl: null,
    });
  }

  if (nonStock > 0) {
    addIssue(
      ctx.issues,
      "warning",
      "unsupported-instrument",
      `${nonStock} non-stock leg(s) (options, futures, or forex) were refused: the statement does not ` +
        "carry their contract multipliers, and a scaled-wrong P&L is worse than none.",
    );
  }

  const replayed = reconstructFromExecutions(fills, ctx.issues, { pnlFrom: "prices" });
  return {
    trades: replayed.trades,
    openTrades: replayed.openTrades,
    header: plan.header,
    mapping: fields,
    rows: dataRows,
    skippedRows: skippedRows + nonStock + replayed.skippedRows,
    source: "executions",
  };
}

function buildFromCashBalance(
  table: { rows: string[][]; rowNumbers: number[] },
  cash: TitledSection,
  ctx: AdapterContext,
): AdapterBuildResult {
  const plan = cash.plan;
  const typeIndex = plan.header.findIndex((cell) => normalizeHeader(cell) === "type");
  const descriptionIndex = plan.header.findIndex((cell) => normalizeHeader(cell) === "description");
  if (plan.entryTimeParts === null || descriptionIndex === -1) {
    addIssue(
      ctx.issues,
      "error",
      "no-trade-section",
      "The Cash Balance section is missing its DATE/TIME or DESCRIPTION columns.",
    );
    return {
      trades: [],
      openTrades: [],
      header: plan.header,
      mapping: plan.fields,
      rows: 0,
      skippedRows: 0,
      source: "executions",
    };
  }
  const [dateIndex, timeIndex] = plan.entryTimeParts;

  const timeSamples: string[] = [];
  for (let index = cash.start; index < cash.end; index++)
    timeSamples.push(table.rows[index]![dateIndex] ?? "");
  const parser = buildTimestampParser(timeSamples, ctx.options.dateOrder, ctx.issues);

  const fills: ExecutionFill[] = [];
  let dataRows = 0;
  let skippedRows = 0;
  let unparsedTrd = 0;

  for (let index = cash.start; index < cash.end; index++) {
    const row = table.rows[index]!;
    const sourceRow = table.rowNumbers[index] ?? index + 1;
    if (row.every((cell) => cell.trim() === "")) continue;
    const type = typeIndex === -1 ? "" : cleanCell(row[typeIndex] ?? "").toUpperCase();
    if (type !== "TRD") continue; // balances, journals, totals
    dataRows++;

    const description = cleanCell(row[descriptionIndex] ?? "");
    const fill = DESCRIPTION_FILL.exec(description);
    if (fill === null) {
      unparsedTrd++;
      continue;
    }
    const time = parser.parse(mergeDateTimeCells(row[dateIndex] ?? "", row[timeIndex] ?? ""));
    const quantityRaw = parseNumberCell(fill[2]!);
    const price = parseNumberCell(fill[4]!);
    if (!Number.isFinite(time) || quantityRaw === null || quantityRaw === 0 || price === null) {
      addIssue(
        ctx.issues,
        "warning",
        "row-bad-values",
        "TRD row skipped: unreadable time, quantity, or price.",
        { row: sourceRow },
      );
      skippedRows++;
      continue;
    }
    const bot = fill[1]!.toUpperCase() === "BOT";
    const signedQuantity = bot ? Math.abs(quantityRaw) : -Math.abs(quantityRaw);
    let cost = 0;
    for (const feeIndex of plan.feeColumns) {
      const value = parseNumberCell(row[feeIndex] ?? "");
      if (value !== null) cost += -value;
    }
    fills.push({
      sourceRow,
      symbol: neutralizeText(fill[3]!).value.toUpperCase(),
      time,
      price,
      signedQuantity,
      fees: cost !== 0 ? cost : null,
      pnl: null,
    });
  }

  if (unparsedTrd > 0) {
    addIssue(
      ctx.issues,
      "warning",
      "unsupported-instrument",
      `${unparsedTrd} TRD row(s) did not match the "BOT/SOLD <qty> <symbol> @<price>" stock pattern ` +
        "(options and futures descriptions carry strikes and multipliers this importer refuses to guess).",
    );
  }

  const replayed = reconstructFromExecutions(fills, ctx.issues, { pnlFrom: "prices" });
  return {
    trades: replayed.trades,
    openTrades: replayed.openTrades,
    header: plan.header,
    mapping: plan.fields,
    rows: dataRows,
    skippedRows: skippedRows + unparsedTrd + replayed.skippedRows,
    source: "executions",
  };
}
