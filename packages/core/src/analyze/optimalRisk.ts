import type { ChallengeSpecInput } from "../spec/challenge.js";
import type { TraderProfileInput } from "../spec/trader.js";
import type { SimOptionsInput } from "../spec/options.js";
import { simulate } from "../engine/simulate.js";

export interface RiskGrid {
  /** Grid start, in the profile's risk units (percent for percent modes). */
  min?: number;
  max?: number;
  step?: number;
}

export interface RiskSweepPoint {
  risk: number;
  perAttemptPassProbability: number;
  fundedProbability: number;
  evTotal: number;
  pEvPositive: number;
  expectedCost: number;
}

export interface OptimalRiskResult {
  points: RiskSweepPoint[];
  /** Risk that maximizes per-attempt pass probability. */
  bestByPassProbability: RiskSweepPoint;
  /** Risk that maximizes EV. */
  bestByEv: RiskSweepPoint;
  /** True when the two argmaxes differ - they usually do, and that gap is the point. */
  diverges: boolean;
}

/**
 * Sweep risk-per-trade over a grid and report pass probability and EV per
 * point, with the argmax of each reported separately: the risk that maximizes
 * your chance of passing is generally NOT the risk that maximizes your
 * expected value, and no one selling challenges will show you that curve.
 *
 * Uses common random numbers (same seed per grid point), so curves are smooth
 * and the argmax is stable rather than Monte Carlo noise.
 */
export function optimalRisk(
  spec: ChallengeSpecInput,
  profile: TraderProfileInput,
  options: SimOptionsInput = {},
  grid: RiskGrid = {},
  onProgress?: (done: number, total: number) => void,
): OptimalRiskResult {
  const min = grid.min ?? 0.1;
  const max = grid.max ?? 3;
  const step = grid.step ?? 0.1;
  if (!(min > 0) || !(max >= min) || !(step > 0)) {
    throw new Error("optimalRisk: grid must satisfy 0 < min <= max and step > 0");
  }

  const count = Math.floor((max - min) / step + 1e-9) + 1;
  const points: RiskSweepPoint[] = [];

  for (let i = 0; i < count; i++) {
    const risk = Math.round((min + i * step) * 1e9) / 1e9;
    const result = simulate(
      spec,
      { ...profile, risk: { ...profile.risk, value: risk } },
      { ...options, includeHistograms: false },
    );
    points.push({
      risk,
      perAttemptPassProbability: result.perAttempt.passProbability,
      fundedProbability: result.journey.fundedProbability,
      evTotal: result.ev.evTotal,
      pEvPositive: result.ev.pPositive,
      expectedCost: result.journey.cost.mean,
    });
    onProgress?.(i + 1, count);
  }

  let bestByPassProbability = points[0]!;
  let bestByEv = points[0]!;
  for (const point of points) {
    if (point.perAttemptPassProbability > bestByPassProbability.perAttemptPassProbability) {
      bestByPassProbability = point;
    }
    if (point.evTotal > bestByEv.evTotal) bestByEv = point;
  }

  return {
    points,
    bestByPassProbability,
    bestByEv,
    diverges: bestByPassProbability.risk !== bestByEv.risk,
  };
}
