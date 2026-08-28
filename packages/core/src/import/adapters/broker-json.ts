/*
  Broker trade-history JSON: the shape the open-source @luxalgo/broker-sdk
  produces. Fills {symbol, side, quantity, price, fee?, executedAt?} arrive
  as a bare array, under {"trades": [...]} (one account, or the SDK's
  statement importer output), or inside a full snapshot
  ({"accounts": [{..., "trades": [...]}]}).

  Semantics encoded here:
  - Rows are FILLS, not round trips. The execution replay pairs them (FIFO,
    volume-weighted basis, reversal splitting), so scale-ins and partial
    exits reconstruct correctly.
  - The shape carries no realized P&L, so P&L comes from prices, and every
    result discloses when that is exact and when a contract multiplier
    scales it.
  - fee is a positive cost (a negative value is a rebate), prorated by the
    replay.
  - Fills without a usable executedAt are skipped loudly: an unordered fill
    cannot join the replay, and each skip can distort the pairing of every
    later fill, so the gap is disclosed in aggregate.
  - A snapshot with trades in more than one account is refused with
    instructions: accounts do not share one equity curve, so import one
    account at a time or use portfolio mode with one log per account.
  - "row" in diagnostics is the 1-based position in the trades array.
*/

import type { TableSection } from "../aliases.js";
import { addIssue, DEFAULT_MAX_ROWS } from "../model.js";
import { reconstructFromExecutions, type ExecutionFill } from "../reconstruct.js";
import { buildTimestampParser } from "../timestamps.js";
import type { AdapterBuildResult, AdapterContext, AdapterMatch, ImportAdapter, ImportDoc } from "./types.js";

interface BrokerTradeRow {
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  fee?: unknown;
  executedAt?: unknown;
}

function isBrokerTrade(value: unknown): value is BrokerTradeRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.symbol !== "string" || row.symbol.trim() === "") return false;
  if (typeof row.side !== "string") return false;
  const side = row.side.trim().toLowerCase();
  if (side !== "buy" && side !== "sell") return false;
  return typeof row.quantity === "number" && typeof row.price === "number";
}

function isTradeArray(value: unknown): value is BrokerTradeRow[] {
  return Array.isArray(value) && value.every(isBrokerTrade);
}

type Located =
  | { shape: "array" | "object"; trades: BrokerTradeRow[]; signals: string[] }
  | {
      shape: "snapshot";
      accounts: Array<{ label: string; trades: BrokerTradeRow[] }>;
      signals: string[];
    };

/** Hard fingerprint: the value IS one of the three broker-sdk shapes, every
 *  trade element carrying symbol, buy/sell side, quantity, and price. */
function locate(json: unknown): Located | null {
  if (Array.isArray(json)) {
    if (json.length === 0 || !isTradeArray(json)) return null;
    return {
      shape: "array",
      trades: json,
      signals: [`JSON array of ${json.length} broker-trade objects (symbol, side, quantity, price)`],
    };
  }
  if (typeof json !== "object" || json === null) return null;
  const value = json as Record<string, unknown>;
  if (Array.isArray(value.accounts)) {
    const accounts: Array<{ label: string; trades: BrokerTradeRow[] }> = [];
    for (const entry of value.accounts) {
      if (typeof entry !== "object" || entry === null) return null;
      const account = entry as Record<string, unknown>;
      if (!isTradeArray(account.trades)) return null; // a missing trades array included
      const label =
        typeof account.name === "string" && account.name.trim() !== ""
          ? account.name
          : typeof account.id === "string" && account.id.trim() !== ""
            ? account.id
            : `account ${accounts.length + 1}`;
      accounts.push({ label, trades: account.trades });
    }
    if (accounts.length === 0) return null;
    const withTrades = accounts.filter((account) => account.trades.length > 0).length;
    return {
      shape: "snapshot",
      accounts,
      signals: [
        "broker snapshot shape matched (accounts[].trades)",
        `${accounts.length} account(s), ${withTrades} with trades`,
      ],
    };
  }
  if (isTradeArray(value.trades)) {
    return {
      shape: "object",
      trades: value.trades,
      signals: [`JSON object with a trades array of ${value.trades.length} broker-trade objects`],
    };
  }
  return null;
}

/** JSON documents have no header section; the adapter contract requires one
 *  on the match, so this placeholder fills the slot. Nothing downstream
 *  reads it for this adapter. */
const EMPTY_SECTION: TableSection = {
  headerIndex: -1,
  start: 0,
  end: 0,
  plan: {
    header: [],
    fields: {},
    feeColumns: [],
    entryTimeParts: null,
    exitTimeParts: null,
    statusColumn: null,
    matchedFields: [],
    knownColumns: 0,
  },
};

export const brokerJsonAdapter: ImportAdapter = {
  id: "broker-json",
  label: "broker trades JSON (broker-sdk shape)",

  detect(doc: ImportDoc): AdapterMatch | null {
    if (doc.kind !== "json") return null;
    const located = locate(doc.json);
    if (located === null) return null;
    return { table: 0, section: EMPTY_SECTION, signals: located.signals };
  },

  build(doc: ImportDoc, _match: AdapterMatch, ctx: AdapterContext): AdapterBuildResult {
    const empty: AdapterBuildResult = {
      trades: [],
      openTrades: [],
      header: null,
      mapping: {},
      rows: 0,
      skippedRows: 0,
      source: "executions",
    };
    const located = locate(doc.json);
    if (located === null) return empty; // unreachable behind detect()

    let rows: BrokerTradeRow[];
    if (located.shape === "snapshot") {
      const withTrades = located.accounts.filter((account) => account.trades.length > 0);
      if (withTrades.length > 1) {
        addIssue(
          ctx.issues,
          "error",
          "snapshot-multi-account",
          `The snapshot carries trades for ${withTrades.length} accounts (${withTrades
            .map((account) => account.label)
            .join(
              ", ",
            )}). Accounts do not share one equity curve, so import one account's trades at a time, ` +
            "or pass each account as its own log in portfolio mode.",
        );
        return empty;
      }
      if (withTrades.length === 0) return empty; // recognized format, no trades: the orchestrator reports it
      rows = withTrades[0]!.trades;
      if (located.accounts.length > 1) {
        addIssue(
          ctx.issues,
          "info",
          "snapshot-account-selected",
          `Imported the ${rows.length} trade(s) of account "${withTrades[0]!.label}"; the snapshot's ` +
            `other ${located.accounts.length - 1} account(s) carry none.`,
        );
      }
    } else {
      rows = located.trades;
    }

    const maxRows = ctx.options.maxRows ?? DEFAULT_MAX_ROWS;
    if (rows.length > maxRows) {
      rows = rows.slice(0, maxRows);
      addIssue(
        ctx.issues,
        "warning",
        "input-truncated",
        `The trades array exceeds the ${maxRows} row cap and was truncated; trades past the cap were ignored.`,
      );
    }

    const parser = buildTimestampParser(
      rows.map((row) => (typeof row.executedAt === "string" ? row.executedAt : "")),
      ctx.options.dateOrder,
      ctx.issues,
    );

    const fills: ExecutionFill[] = [];
    let skippedRows = 0;
    let missingTime = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const sourceRow = i + 1;
      if (typeof row.executedAt !== "string" || row.executedAt.trim() === "") {
        missingTime++;
        skippedRows++;
        continue;
      }
      const time = parser.parse(row.executedAt);
      if (
        !Number.isFinite(time) ||
        !Number.isFinite(row.quantity) ||
        row.quantity <= 0 ||
        !Number.isFinite(row.price) ||
        row.price < 0
      ) {
        addIssue(
          ctx.issues,
          "warning",
          "row-bad-values",
          "Trade skipped: unreadable executedAt, a non-positive quantity, or a negative price.",
          { row: sourceRow },
        );
        skippedRows++;
        continue;
      }
      fills.push({
        sourceRow,
        symbol: row.symbol.trim().toUpperCase(),
        time,
        price: row.price,
        signedQuantity: row.side.trim().toLowerCase() === "buy" ? row.quantity : -row.quantity,
        fees: typeof row.fee === "number" && Number.isFinite(row.fee) ? row.fee : null,
        pnl: null,
      });
    }

    if (missingTime > 0) {
      addIssue(
        ctx.issues,
        "warning",
        "fills-missing-time",
        `${missingTime} trade(s) carry no executedAt and were skipped. Skipped fills leave gaps in the ` +
          "position replay, so the pairing of the remaining trades may be off; prefer an export that " +
          "timestamps every fill.",
      );
    }

    const replayed = reconstructFromExecutions(fills, ctx.issues, { pnlFrom: "prices" });
    if (replayed.trades.length > 0) {
      addIssue(
        ctx.issues,
        "info",
        "pnl-from-prices",
        "This shape carries no realized P&L, so P&L was computed from prices as (exit minus entry basis) " +
          "times quantity. That is exact when one point of price equals one unit of currency per unit of " +
          "quantity (stocks, spot crypto). For instruments with a contract multiplier (futures, some " +
          "CFDs) the currency P&L is scaled by the missing multiplier; a percent-of-entry-value risk " +
          "assumption largely cancels that scale, a fixed cash amount does not.",
      );
    }

    return {
      trades: replayed.trades,
      openTrades: replayed.openTrades,
      header: null,
      mapping: {},
      rows: rows.length,
      skippedRows: skippedRows + replayed.skippedRows,
      source: "executions",
    };
  },
};
