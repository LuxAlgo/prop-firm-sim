/*
  Portfolio analysis across multiple trade histories (strategy A, B, C…).

  Two jobs:
  1. Merge up to several timestamped histories into one chronological series
     so the combined account can be bootstrap-simulated (cross-strategy
     clustering survives, which is exactly what loss limits punish).
  2. Overlap audit-risk: prop firms look for accounts whose positions open in
     the same direction at around the same time (copied or correlated
     strategies) and can refuse payouts or audit over it. There are no public
     thresholds - firms are discretionary - so this reports the measured
     overlap and maps it to disclosed heuristic bands rather than pretending
     a hard rule exists.
*/

import type { TradeLogEntry } from "./log.js";

const MS_PER_MINUTE = 60_000;

export interface PortfolioMergeResult {
  /** All entries across histories, sorted by open time. */
  entries: TradeLogEntry[];
  /** Chronological R-multiple series of the merged portfolio. */
  rSeries: number[];
  /** Average merged trades per distinct UTC trading day. */
  tradesPerDay: number;
  distinctDays: number;
  historyCount: number;
}

/** Merge several histories into one chronological portfolio series. */
export function mergeTradeLogs(histories: readonly (readonly TradeLogEntry[])[]): PortfolioMergeResult {
  const entries = histories
    .flat()
    .slice()
    .sort((a, b) => a.openedAt - b.openedAt);
  const days = new Set<number>();
  for (const entry of entries) days.add(Math.floor(entry.openedAt / 86_400_000));
  return {
    entries,
    rSeries: entries.map((entry) => entry.r),
    tradesPerDay: days.size > 0 ? entries.length / days.size : 0,
    distinctDays: days.size,
    historyCount: histories.length,
  };
}

export type AuditRiskLevel = "low" | "elevated" | "high";

export interface OverlapPair {
  /** Indexes into the input histories array. */
  a: number;
  b: number;
  /** Trades of history `a` overlapping a same-direction trade of `b`, and vice versa. */
  overlappingA: number;
  overlappingB: number;
  /** overlapping / trades, per side. */
  shareA: number;
  shareB: number;
  /** Overlaps where both directions were known and equal. */
  sameDirection: number;
  /** Overlaps counted while one or both directions were unknown. */
  directionUnknown: number;
}

export interface OverlapReport {
  pairs: OverlapPair[];
  /** Share of ALL trades that overlap a trade of another history (same
   *  direction, or direction unknown on either side). */
  overallOverlapShare: number;
  /** Share counting only overlaps where both directions were known and equal. */
  sameDirectionShare: number;
  /** Share of trades whose direction column was missing. */
  unknownDirectionShare: number;
  auditRisk: AuditRiskLevel;
  /** Plain-language reading of the bands, for rendering next to the flag. */
  verdict: string;
  disclosure: string;
  toleranceMinutes: number;
}

export const OVERLAP_DISCLOSURE =
  "Heuristic bands, not a rule: prop firms are discretionary about correlated accounts and publish " +
  "no thresholds. This flags what a reviewer could see (same-direction positions open at around the " +
  "same time across your histories) so you are not surprised by an audit; it cannot predict any " +
  "specific firm's decision.";

function overlaps(
  a: TradeLogEntry,
  b: TradeLogEntry,
  toleranceMs: number,
): { hit: boolean; sameDirection: boolean; unknown: boolean } {
  const aEnd = a.closedAt ?? a.openedAt;
  const bEnd = b.closedAt ?? b.openedAt;
  const hit = a.openedAt - toleranceMs <= bEnd && b.openedAt - toleranceMs <= aEnd;
  if (!hit) return { hit: false, sameDirection: false, unknown: false };
  if (a.direction === null || b.direction === null) return { hit: true, sameDirection: false, unknown: true };
  if (a.direction === b.direction) return { hit: true, sameDirection: true, unknown: false };
  // Opposite directions at the same time is hedging, not copying - not counted.
  return { hit: false, sameDirection: false, unknown: false };
}

/**
 * Measure position overlap across histories. A trade "overlaps" when its
 * [open, close] interval (padded by toleranceMinutes) intersects a trade of
 * another history in the SAME direction; when a direction column is missing
 * the time overlap is still counted, labeled direction-unknown. Bands:
 * overall overlap share < 10% = low, 10-30% = elevated, over 30% = high.
 */
export function analyzeOverlap(
  histories: readonly (readonly TradeLogEntry[])[],
  options: { toleranceMinutes?: number } = {},
): OverlapReport {
  const toleranceMinutes = options.toleranceMinutes ?? 5;
  const toleranceMs = toleranceMinutes * MS_PER_MINUTE;
  const pairs: OverlapPair[] = [];

  const overlappedFlags = histories.map((history) => new Array<boolean>(history.length).fill(false));
  const sameDirFlags = histories.map((history) => new Array<boolean>(history.length).fill(false));
  let totalTrades = 0;
  let unknownDirection = 0;
  for (const history of histories) {
    totalTrades += history.length;
    for (const entry of history) if (entry.direction === null) unknownDirection++;
  }

  for (let i = 0; i < histories.length; i++) {
    for (let j = i + 1; j < histories.length; j++) {
      const a = histories[i]!;
      const b = histories[j]!;
      const aHit = new Array<boolean>(a.length).fill(false);
      const bHit = new Array<boolean>(b.length).fill(false);
      let sameDirection = 0;
      let directionUnknown = 0;

      for (let x = 0; x < a.length; x++) {
        for (let y = 0; y < b.length; y++) {
          const result = overlaps(a[x]!, b[y]!, toleranceMs);
          if (!result.hit) continue;
          if (!aHit[x] || !bHit[y]) {
            if (result.sameDirection) sameDirection++;
            else directionUnknown++;
          }
          aHit[x] = true;
          bHit[y] = true;
          overlappedFlags[i]![x] = true;
          overlappedFlags[j]![y] = true;
          if (result.sameDirection) {
            sameDirFlags[i]![x] = true;
            sameDirFlags[j]![y] = true;
          }
        }
      }

      const overlappingA = aHit.filter(Boolean).length;
      const overlappingB = bHit.filter(Boolean).length;
      pairs.push({
        a: i,
        b: j,
        overlappingA,
        overlappingB,
        shareA: a.length > 0 ? overlappingA / a.length : 0,
        shareB: b.length > 0 ? overlappingB / b.length : 0,
        sameDirection,
        directionUnknown,
      });
    }
  }

  const overlappedCount = overlappedFlags.flat().filter(Boolean).length;
  const sameDirCount = sameDirFlags.flat().filter(Boolean).length;
  const overallOverlapShare = totalTrades > 0 ? overlappedCount / totalTrades : 0;
  const sameDirectionShare = totalTrades > 0 ? sameDirCount / totalTrades : 0;

  const auditRisk: AuditRiskLevel =
    overallOverlapShare >= 0.3 ? "high" : overallOverlapShare >= 0.1 ? "elevated" : "low";
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const verdict =
    auditRisk === "high"
      ? `${pct(overallOverlapShare)} of trades overlap across histories (${pct(sameDirectionShare)} in the ` +
        "same direction): a reviewer comparing these accounts would likely treat them as correlated. " +
        "Expect scrutiny or an audit before payouts."
      : auditRisk === "elevated"
        ? `${pct(overallOverlapShare)} of trades overlap across histories (${pct(sameDirectionShare)} in the ` +
          "same direction): enough coincidence that a reviewer could flag it. Worth spacing entries out."
        : `${pct(overallOverlapShare)} of trades overlap across histories: little for a reviewer to ` +
          "correlate at this tolerance.";

  return {
    pairs,
    overallOverlapShare,
    sameDirectionShare,
    unknownDirectionShare: totalTrades > 0 ? unknownDirection / totalTrades : 0,
    auditRisk,
    verdict,
    disclosure: OVERLAP_DISCLOSURE,
    toleranceMinutes,
  };
}
