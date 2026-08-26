/*
  The R-multiple ladder: R = realized P&L / initial risk, resolved per trade
  under a strict trust order, labeled in rSource:

  1. explicit    the file's own R column, validated and never recomputed
  2. calculated  from the file's own data (risk-amount column, or a stop
                 distance priced through the file's own P&L)
  3. inferred    from a user-chosen RiskSpec, never applied silently
  4. unavailable r stays null

  The aggregate verdict tells downstream what it may do: "ready" simulates,
  "needs-risk" asks the user for a risk assumption, "partial" MUST be
  refused (simulating only the covered trades biases the sample), and
  "unavailable" cannot be converted at all.
*/

import {
  addIssue,
  type ImportedTrade,
  type ImportIssue,
  type ImportRSummary,
  type RiskSpec,
  type RSource,
  type TradeDirection,
} from "./model.js";

const R_SANITY_LIMIT = 100;

/**
 * Derive the initial risk (account currency) from a protective stop, priced
 * through the file's OWN gross P&L: currency-per-price-unit = gross P&L /
 * signed price move, risk = stop distance * that rate. Works without
 * contract sizes. Refuses (null, with a diagnostic) a stop on the profit
 * side or at entry: trade history shows the LAST stop, not the initial one,
 * so a moved or breakeven stop cannot recover the risk taken.
 */
export function riskFromStop(
  trade: {
    entryPrice: number | null;
    exitPrice: number | null;
    stopPrice: number | null;
    direction: TradeDirection | null;
    pnl: number | null;
    fees: number | null;
  },
  issues: ImportIssue[],
  row?: number,
): number | null {
  const { entryPrice, exitPrice, stopPrice, direction } = trade;
  if (
    entryPrice === null ||
    exitPrice === null ||
    stopPrice === null ||
    direction === null ||
    trade.pnl === null
  ) {
    return null;
  }
  const sign = direction === "long" ? 1 : -1;
  const move = (exitPrice - entryPrice) * sign;
  if (move === 0) return null; // flat exit: no rate derivable
  const grossPnl = trade.pnl + (trade.fees ?? 0);
  const currencyPerUnit = grossPnl / move;
  if (!Number.isFinite(currencyPerUnit) || currencyPerUnit <= 0) {
    addIssue(
      issues,
      "warning",
      "pnl-move-mismatch",
      "The P&L sign does not match the price move, so no currency-per-point rate can be derived for " +
        "the stop-based risk. R stays unavailable for this trade.",
      row !== undefined ? { row } : undefined,
    );
    return null;
  }
  const stopDistance = (entryPrice - stopPrice) * sign;
  if (stopDistance <= 0) {
    addIssue(
      issues,
      "warning",
      "stop-not-protective",
      "The recorded stop sits at or beyond the entry (breakeven or trailed): history shows the LAST " +
        "stop, not the initial one, so the initial risk cannot be recovered. R stays unavailable for " +
        "this trade.",
      row !== undefined ? { row } : undefined,
    );
    return null;
  }
  return stopDistance * currencyPerUnit;
}

/**
 * Resolve R for every closed trade under the trust ladder and return the
 * aggregate verdict. Mutates trades in place (r, rSource, riskAmount for
 * inferred risks) and never throws.
 */
export function resolveR(
  trades: ImportedTrade[],
  riskSpec: RiskSpec | undefined,
  issues: ImportIssue[],
): ImportRSummary {
  let withR = 0;
  let withoutR = 0;
  let anyPnl = false;
  const sources = new Set<RSource>();

  for (const trade of trades) {
    if (trade.status !== "closed") continue;
    if (trade.pnl !== null) anyPnl = true;

    if (trade.r !== null) {
      // Rung 1: explicit. Validate, never recompute.
      if (!Number.isFinite(trade.r) || Math.abs(trade.r) > R_SANITY_LIMIT) {
        addIssue(
          issues,
          "warning",
          "r-implausible",
          `An explicit R of ${String(trade.r)} fails the sanity check (|R| <= ${R_SANITY_LIMIT}); the value ` +
            "was discarded for this trade.",
          { row: trade.sourceRows[0] },
        );
        trade.r = null;
      } else {
        if (
          trade.pnl !== null &&
          trade.pnl !== 0 &&
          trade.r !== 0 &&
          Math.sign(trade.pnl) !== Math.sign(trade.r)
        ) {
          addIssue(
            issues,
            "warning",
            "r-sign-mismatch",
            "An explicit R disagrees in sign with the row's P&L. The explicit value was kept (never " +
              "recomputed), but check which column really holds R.",
            { row: trade.sourceRows[0] },
          );
        }
        trade.rSource = "explicit";
        sources.add("explicit");
        withR++;
        continue;
      }
    }

    // Rung 2: calculated from the file's own data.
    let risk = trade.riskAmount;
    if (risk === null) {
      risk = riskFromStop(trade, issues, trade.sourceRows[0]);
      if (risk !== null) trade.riskAmount = risk;
    }
    if (risk !== null && risk > 0 && trade.pnl !== null) {
      trade.r = trade.pnl / risk;
      trade.rSource = "calculated";
      sources.add("calculated");
      withR++;
      continue;
    }

    // Rung 3: inferred from an explicit, user-chosen assumption.
    if (riskSpec !== undefined && trade.pnl !== null) {
      let inferredRisk: number | null = null;
      if (riskSpec.type === "fixed-cash" && riskSpec.amount > 0) {
        inferredRisk = riskSpec.amount;
      } else if (riskSpec.type === "percent-of-entry-value" && riskSpec.percent > 0) {
        if (trade.entryPrice !== null && trade.quantity !== null) {
          inferredRisk = Math.abs(trade.entryPrice * trade.quantity) * (riskSpec.percent / 100);
        }
      }
      if (inferredRisk !== null && inferredRisk > 0) {
        trade.riskAmount = inferredRisk;
        trade.r = trade.pnl / inferredRisk;
        trade.rSource = "inferred";
        sources.add("inferred");
        withR++;
        continue;
      }
    }

    trade.rSource = "unavailable";
    withoutR++;
  }

  let status: ImportRSummary["status"];
  if (withR > 0 && withoutR === 0) status = "ready";
  else if (withR > 0) status = "partial";
  else if (anyPnl) status = "needs-risk";
  else status = "unavailable";

  if (status === "partial") {
    addIssue(
      issues,
      "error",
      "r-partial",
      `${withR} trades carry an R value and ${withoutR} do not. Simulating only the covered trades would ` +
        "bias the sample, so this import must not feed a simulation as-is: fix the gaps (or supply a " +
        "risk assumption that covers every trade) first.",
    );
  } else if (status === "needs-risk") {
    addIssue(
      issues,
      "info",
      "needs-risk",
      "The file carries P&L but no risk information, so R-multiples cannot be computed from it alone. " +
        "Supply the risk you took per trade (a fixed cash amount, or a percent of entry value) to convert.",
    );
  }

  const source: ImportRSummary["source"] =
    sources.size === 0 ? null : sources.size === 1 ? [...sources][0]! : "mixed";
  return { status, source, withR, withoutR };
}
