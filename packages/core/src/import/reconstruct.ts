/*
  Trade reconstruction: turn event rows (entry/exit pairs) or raw executions
  (fills) into canonical trades. Two engines:

  - pairEvents: for sources with one row per trade LEG. Groups strictly by
    trade/position id when at least 90% of rows carry one; otherwise falls
    back to FIFO within (symbol, direction) with lot splitting, loudly. Rows
    are never paired merely for being neighbors, and unmatched exits are
    dropped with a diagnostic instead of being guessed into trades.

  - reconstructFromExecutions: for fill-level sources. Replays a signed
    running position per symbol: scale-ins extend a volume-weighted basis,
    every reducing fill realizes P&L, fees are prorated by consumed quantity,
    crossing zero closes one trade and opens the reversal, and a round trip
    closes at flat. Leftover positions surface as open trades.
*/

import { addIssue, type ImportedTrade, type ImportIssue, type TradeDirection } from "./model.js";

/** One entry/exit leg row, as an adapter mapped it. */
export interface TradeEvent {
  sourceRow: number;
  id: string | null;
  symbol: string | null;
  direction: TradeDirection | null;
  eventType: "entry" | "exit" | null;
  time: number;
  price: number | null;
  quantity: number | null;
  /** Trade-level totals as carried on this row (see totalsOnExit). */
  pnl: number | null;
  fees: number | null;
  stopPrice: number | null;
  riskAmount: number | null;
  r: number | null;
}

export interface PairEventsOptions {
  /** Trade totals (pnl, fees, r) are trusted from EXIT rows only: sources
   *  like TradingView mirror them onto both legs. */
  totalsOnExit?: boolean;
}

export interface ReconstructionResult {
  trades: ImportedTrade[];
  openTrades: ImportedTrade[];
  skippedRows: number;
}

function blankTrade(): ImportedTrade {
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
    sourceRows: [],
  };
}

function vwap(legs: Array<{ price: number | null; quantity: number | null }>): number | null {
  let cost = 0;
  let qty = 0;
  let plain = 0;
  let count = 0;
  for (const leg of legs) {
    if (leg.price === null) continue;
    count++;
    plain += leg.price;
    if (leg.quantity !== null && leg.quantity > 0) {
      cost += leg.price * leg.quantity;
      qty += leg.quantity;
    }
  }
  if (qty > 0) return cost / qty;
  if (count > 0) return plain / count; // no quantities: plain average, better than nothing
  return null;
}

function sumOrNull(values: Array<number | null>): number | null {
  let sum = 0;
  let saw = false;
  for (const value of values) {
    if (value === null) continue;
    sum += value;
    saw = true;
  }
  return saw ? sum : null;
}

function firstNonNull<T>(values: Array<T | null>): T | null {
  for (const value of values) if (value !== null) return value;
  return null;
}

/**
 * Pair entry/exit event rows into trades. Strict id grouping when ids cover
 * at least 90% of rows; FIFO within (symbol, direction) otherwise, with a
 * warning that pairing is positional.
 */
export function pairEvents(
  events: readonly TradeEvent[],
  issues: ImportIssue[],
  options: PairEventsOptions = {},
): ReconstructionResult {
  const totalsOnExit = options.totalsOnExit ?? false;
  const withId = events.filter((event) => event.id !== null && event.id !== "");
  if (events.length === 0) return { trades: [], openTrades: [], skippedRows: 0 };

  if (withId.length / events.length >= 0.9) {
    return pairById(events, issues, totalsOnExit);
  }
  addIssue(
    issues,
    "warning",
    "pairing-positional",
    "No trade id column covers the rows, so entries and exits were paired first-in-first-out within " +
      "each (symbol, direction). Partial exits split lots. Check the reconstructed trades before " +
      "trusting them.",
  );
  return pairFifo(events, issues, totalsOnExit);
}

function pairById(
  events: readonly TradeEvent[],
  issues: ImportIssue[],
  totalsOnExit: boolean,
): ReconstructionResult {
  const trades: ImportedTrade[] = [];
  const openTrades: ImportedTrade[] = [];
  let skippedRows = 0;

  const groups = new Map<string, TradeEvent[]>();
  for (const event of events) {
    if (event.id === null || event.id === "") {
      addIssue(
        issues,
        "warning",
        "event-missing-id",
        "Row skipped: it carries no trade id while the rest of the file does.",
        {
          row: event.sourceRow,
        },
      );
      skippedRows++;
      continue;
    }
    const group = groups.get(event.id);
    if (group === undefined) groups.set(event.id, [event]);
    else group.push(event);
  }

  for (const [id, group] of groups) {
    const symbols = new Set(group.map((event) => event.symbol).filter((s): s is string => s !== null));
    if (symbols.size > 1) {
      addIssue(
        issues,
        "error",
        "trade-id-spans-symbols",
        `Trade id "${id}" spans ${symbols.size} symbols (${[...symbols].join(", ")}); this usually means a ` +
          "mis-mapped id column. The group was dropped.",
        { row: group[0]!.sourceRow },
      );
      skippedRows += group.length;
      continue;
    }
    group.sort((a, b) => a.time - b.time || a.sourceRow - b.sourceRow);

    let entries: TradeEvent[];
    let exits: TradeEvent[];
    const typed = group.some((event) => event.eventType !== null);
    if (typed) {
      entries = group.filter((event) => event.eventType === "entry");
      exits = group.filter((event) => event.eventType === "exit");
      const untyped = group.length - entries.length - exits.length;
      if (untyped > 0) {
        addIssue(
          issues,
          "warning",
          "event-type-missing",
          `Trade id "${id}": ${untyped} row(s) carry no entry/exit marker and were ignored.`,
          { row: group[0]!.sourceRow },
        );
        skippedRows += untyped;
      }
    } else {
      // No entry/exit markers: sides in both directions identify the legs
      // (the earliest row opens the position, opposite-side rows close it).
      const directions = new Set(
        group.map((event) => event.direction).filter((d): d is TradeDirection => d !== null),
      );
      if (directions.size === 2) {
        const positionDirection = group[0]!.direction;
        entries = group.filter((event) => event.direction === positionDirection);
        exits = group.filter((event) => event.direction !== positionDirection);
      } else {
        addIssue(
          issues,
          "error",
          "event-legs-unidentifiable",
          `Trade id "${id}": the rows carry no entry/exit markers and no opposing sides, so the legs ` +
            "cannot be identified. The group was dropped rather than paired by position.",
          { row: group[0]!.sourceRow },
        );
        skippedRows += group.length;
        continue;
      }
    }

    if (entries.length === 0) {
      addIssue(issues, "warning", "unmatched-exit", `Trade id "${id}" has exit rows but no entry; dropped.`, {
        row: group[0]!.sourceRow,
      });
      skippedRows += group.length;
      continue;
    }

    const trade = blankTrade();
    trade.id = id;
    trade.symbol = firstNonNull(group.map((event) => event.symbol));
    trade.direction =
      firstNonNull(entries.map((event) => event.direction)) ??
      firstNonNull(group.map((event) => event.direction));
    trade.entryTime = Number.isFinite(entries[0]!.time) ? entries[0]!.time : null;
    trade.entryPrice = vwap(entries);
    trade.quantity = sumOrNull(entries.map((event) => event.quantity));
    trade.stopPrice = firstNonNull(group.map((event) => event.stopPrice));
    trade.riskAmount = firstNonNull(group.map((event) => event.riskAmount));
    trade.sourceRows = group.map((event) => event.sourceRow).sort((a, b) => a - b);

    if (exits.length === 0) {
      trade.status = "open";
      openTrades.push(trade);
      continue;
    }
    trade.exitTime = Number.isFinite(exits[exits.length - 1]!.time) ? exits[exits.length - 1]!.time : null;
    trade.exitPrice = vwap(exits);
    const totalRows = totalsOnExit ? exits : group;
    trade.pnl = sumOrNull(totalRows.map((event) => event.pnl));
    trade.fees = sumOrNull(totalRows.map((event) => event.fees));
    trade.r = firstNonNull(totalRows.map((event) => event.r));
    trades.push(trade);
  }

  trades.sort((a, b) => (a.entryTime ?? 0) - (b.entryTime ?? 0));
  return { trades, openTrades, skippedRows };
}

function pairFifo(
  events: readonly TradeEvent[],
  issues: ImportIssue[],
  totalsOnExit: boolean,
): ReconstructionResult {
  interface OpenLot {
    event: TradeEvent;
    remaining: number;
  }
  const trades: ImportedTrade[] = [];
  const openTrades: ImportedTrade[] = [];
  let skippedRows = 0;

  const sorted = [...events].sort((a, b) => a.time - b.time || a.sourceRow - b.sourceRow);
  const queues = new Map<string, OpenLot[]>();
  const keyOf = (event: TradeEvent): string => `${event.symbol ?? ""}|${event.direction ?? "?"}`;

  for (const event of sorted) {
    if (event.eventType === "entry") {
      const key = keyOf(event);
      const queue = queues.get(key) ?? [];
      queue.push({ event, remaining: event.quantity ?? 1 });
      queues.set(key, queue);
      continue;
    }
    if (event.eventType !== "exit") {
      skippedRows++;
      continue;
    }
    const key = keyOf(event);
    const queue = queues.get(key) ?? [];
    let need = event.quantity ?? 1;
    const consumed: Array<{ lot: OpenLot; amount: number }> = [];
    while (need > 1e-12 && queue.length > 0) {
      const lot = queue[0]!;
      const amount = Math.min(lot.remaining, need);
      lot.remaining -= amount;
      need -= amount;
      consumed.push({ lot, amount });
      if (lot.remaining <= 1e-12) queue.shift();
    }
    if (consumed.length === 0) {
      addIssue(
        issues,
        "warning",
        "unmatched-exit",
        "Exit row has no open entry to match under FIFO pairing; dropped.",
        {
          row: event.sourceRow,
        },
      );
      skippedRows++;
      continue;
    }
    if (need > 1e-12) {
      addIssue(
        issues,
        "warning",
        "unmatched-exit",
        "Exit quantity exceeds the open quantity under FIFO pairing; the excess was dropped.",
        { row: event.sourceRow },
      );
    }
    const totalConsumed = consumed.reduce((sum, part) => sum + part.amount, 0);
    const trade = blankTrade();
    trade.symbol = event.symbol ?? consumed[0]!.lot.event.symbol;
    trade.direction = consumed[0]!.lot.event.direction ?? event.direction;
    trade.entryTime = Number.isFinite(consumed[0]!.lot.event.time) ? consumed[0]!.lot.event.time : null;
    trade.entryPrice = vwap(consumed.map((part) => ({ price: part.lot.event.price, quantity: part.amount })));
    trade.exitTime = Number.isFinite(event.time) ? event.time : null;
    trade.exitPrice = event.price;
    trade.quantity =
      event.quantity !== null || consumed.some((part) => part.lot.event.quantity !== null)
        ? totalConsumed
        : null;
    trade.pnl = event.pnl;
    trade.fees = sumOrNull([
      event.fees,
      ...consumed.map((part) => {
        const lotQty = part.lot.event.quantity ?? 1;
        const fee = part.lot.event.fees;
        return fee === null ? null : (fee * part.amount) / lotQty;
      }),
    ]);
    trade.stopPrice = firstNonNull([consumed[0]!.lot.event.stopPrice, event.stopPrice]);
    trade.riskAmount = firstNonNull([consumed[0]!.lot.event.riskAmount, event.riskAmount]);
    trade.r = totalsOnExit ? event.r : firstNonNull([event.r, consumed[0]!.lot.event.r]);
    trade.sourceRows = [
      ...new Set([...consumed.map((part) => part.lot.event.sourceRow), event.sourceRow]),
    ].sort((a, b) => a - b);
    trades.push(trade);
  }

  for (const queue of queues.values()) {
    for (const lot of queue) {
      if (lot.remaining <= 1e-12) continue;
      const trade = blankTrade();
      trade.status = "open";
      trade.symbol = lot.event.symbol;
      trade.direction = lot.event.direction;
      trade.entryTime = Number.isFinite(lot.event.time) ? lot.event.time : null;
      trade.entryPrice = lot.event.price;
      trade.quantity = lot.event.quantity === null ? null : lot.remaining;
      trade.stopPrice = lot.event.stopPrice;
      trade.riskAmount = lot.event.riskAmount;
      trade.sourceRows = [lot.event.sourceRow];
      openTrades.push(trade);
    }
  }

  return { trades, openTrades, skippedRows };
}

/* ---- Execution replay ---------------------------------------------------- */

/** One fill. signedQuantity is positive for buys, negative for sells. */
export interface ExecutionFill {
  sourceRow: number;
  symbol: string;
  time: number;
  price: number;
  signedQuantity: number;
  /** Cost of the fill as a POSITIVE number (a credit goes negative).
   *  Adapters normalize the file's sign convention before handing fills over. */
  fees: number | null;
  /** GROSS realized P&L carried by the SOURCE for this fill (MT5 "out"
   *  deals). Used only under pnlFrom: "fills". */
  pnl: number | null;
}

export interface ExecutionReplayOptions {
  /** "prices": P&L = (exit - basis) * qty from prices (exact only when one
   *  price unit equals one currency unit per unit of quantity; the caller
   *  discloses otherwise). "fills": P&L = the source's own realized numbers. */
  pnlFrom: "prices" | "fills";
}

interface PositionState {
  direction: 1 | -1;
  position: number;
  basisPrice: number;
  totalEntered: number;
  entryCost: number;
  firstEntryTime: number;
  fees: number;
  realized: number;
  exitCost: number;
  exitQty: number;
  lastExitTime: number;
  rows: number[];
}

/**
 * Replay raw executions into flat-to-flat trades: a signed running position
 * per symbol, volume-weighted basis on scale-ins, realized P&L on every
 * reducing fill, fee proration by consumed quantity, and a reversal split
 * when a fill crosses zero.
 */
export function reconstructFromExecutions(
  fills: readonly ExecutionFill[],
  issues: ImportIssue[],
  options: ExecutionReplayOptions,
): ReconstructionResult {
  const trades: ImportedTrade[] = [];
  const openTrades: ImportedTrade[] = [];
  let skippedRows = 0;

  const sorted = [...fills].sort((a, b) => a.time - b.time || a.sourceRow - b.sourceRow);
  const positions = new Map<string, PositionState>();

  const closeTrade = (symbol: string, state: PositionState): void => {
    const trade = blankTrade();
    trade.symbol = symbol === "" ? null : symbol;
    trade.direction = state.direction > 0 ? "long" : "short";
    trade.entryTime = state.firstEntryTime;
    trade.exitTime = state.lastExitTime;
    trade.entryPrice = state.totalEntered > 0 ? state.entryCost / state.totalEntered : null;
    trade.exitPrice = state.exitQty > 0 ? state.exitCost / state.exitQty : null;
    trade.quantity = state.totalEntered;
    trade.fees = state.fees;
    trade.pnl = state.realized - state.fees;
    trade.sourceRows = [...new Set(state.rows)].sort((a, b) => a - b);
    trades.push(trade);
  };

  for (const fill of sorted) {
    if (!Number.isFinite(fill.time) || !Number.isFinite(fill.price) || fill.signedQuantity === 0) {
      addIssue(
        issues,
        "warning",
        "fill-skipped",
        "Execution row skipped: missing time, price, or quantity.",
        {
          row: fill.sourceRow,
        },
      );
      skippedRows++;
      continue;
    }
    const symbol = fill.symbol;
    let state = positions.get(symbol);
    const fillSign: 1 | -1 = fill.signedQuantity > 0 ? 1 : -1;
    let qty = Math.abs(fill.signedQuantity);
    const fee = fill.fees ?? 0;

    if (state === undefined || state.position === 0) {
      state = {
        direction: fillSign,
        position: qty,
        basisPrice: fill.price,
        totalEntered: qty,
        entryCost: fill.price * qty,
        firstEntryTime: fill.time,
        fees: fee,
        realized: 0,
        exitCost: 0,
        exitQty: 0,
        lastExitTime: fill.time,
        rows: [fill.sourceRow],
      };
      positions.set(symbol, state);
      continue;
    }

    if (fillSign === state.direction) {
      // Scale-in: extend the volume-weighted basis.
      state.basisPrice = (state.basisPrice * state.position + fill.price * qty) / (state.position + qty);
      state.position += qty;
      state.totalEntered += qty;
      state.entryCost += fill.price * qty;
      state.fees += fee;
      state.rows.push(fill.sourceRow);
      continue;
    }

    // Reducing fill (possibly crossing zero into a reversal).
    const reduce = Math.min(qty, state.position);
    const closingFeeShare = (fee * reduce) / qty;
    state.fees += closingFeeShare;
    state.rows.push(fill.sourceRow);
    state.exitCost += fill.price * reduce;
    state.exitQty += reduce;
    state.lastExitTime = fill.time;
    if (options.pnlFrom === "prices") {
      state.realized += (fill.price - state.basisPrice) * reduce * state.direction;
    } else if (fill.pnl !== null) {
      state.realized += fill.pnl; // the source books the whole fill's P&L on the reducing leg
    } else {
      addIssue(
        issues,
        "warning",
        "fill-missing-profit",
        "A reducing fill carries no realized P&L in a source that should book it there; the trade's " +
          "P&L is undercounted and should not be trusted.",
        { row: fill.sourceRow },
      );
    }
    state.position -= reduce;
    qty -= reduce;

    if (state.position <= 1e-12) {
      closeTrade(symbol, state);
      if (qty > 1e-12) {
        // Reversal: the remainder opens the opposite position.
        positions.set(symbol, {
          direction: fillSign,
          position: qty,
          basisPrice: fill.price,
          totalEntered: qty,
          entryCost: fill.price * qty,
          firstEntryTime: fill.time,
          fees: fee - closingFeeShare,
          realized: 0,
          exitCost: 0,
          exitQty: 0,
          lastExitTime: fill.time,
          rows: [fill.sourceRow],
        });
      } else {
        positions.delete(symbol);
      }
    }
  }

  for (const [symbol, state] of positions) {
    if (state.position <= 1e-12) continue;
    const trade = blankTrade();
    trade.status = "open";
    trade.symbol = symbol === "" ? null : symbol;
    trade.direction = state.direction > 0 ? "long" : "short";
    trade.entryTime = state.firstEntryTime;
    trade.entryPrice = state.basisPrice;
    trade.quantity = state.position;
    trade.fees = state.fees;
    trade.sourceRows = [...new Set(state.rows)].sort((a, b) => a - b);
    openTrades.push(trade);
  }

  trades.sort((a, b) => (a.entryTime ?? 0) - (b.entryTime ?? 0));
  return { trades, openTrades, skippedRows };
}
