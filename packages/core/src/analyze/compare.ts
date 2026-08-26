import type { ChallengeSpecInput } from "../spec/challenge.js";
import type { TraderProfileInput } from "../spec/trader.js";
import type { SimOptionsInput } from "../spec/options.js";
import type { SimResult } from "../spec/result.js";
import { simulate } from "../engine/simulate.js";

export interface CompareEntry {
  /** Optional label carried through to the row (e.g. the dataset firmId). */
  firmId?: string;
  firmName?: string;
  spec: ChallengeSpecInput;
}

export interface CompareRow {
  firmId: string | null;
  firmName: string | null;
  challengeId: string;
  name: string;
  perAttemptPassProbability: number;
  fundedProbability: number;
  expectedAttempts: number;
  expectedCost: number;
  evTotal: number;
  pEvPositive: number;
  daysToFundedP50: number | null;
  flagsNotSimulated: string[];
}

export interface CompareResult {
  /** Rows sorted by EV, best first. */
  rows: CompareRow[];
  /** Full results in the same order as `rows`, for callers that need detail. */
  results: SimResult[];
}

/**
 * Simulate the same trader across several challenges. This is an engine
 * primitive: it returns data for the caller's own comparison. It deliberately
 * ships no editorial ranking, endorsement, or default leaderboard.
 */
export function compare(
  entries: readonly CompareEntry[],
  profile: TraderProfileInput,
  options: SimOptionsInput = {},
): CompareResult {
  const simulated = entries.map((entry) => {
    const result = simulate(entry.spec, profile, { ...options, includeHistograms: false });
    const row: CompareRow = {
      firmId: entry.firmId ?? null,
      firmName: entry.firmName ?? null,
      challengeId: result.assumptions.spec.challengeId,
      name: result.assumptions.spec.name,
      perAttemptPassProbability: result.perAttempt.passProbability,
      fundedProbability: result.journey.fundedProbability,
      expectedAttempts: result.journey.attempts.mean,
      expectedCost: result.journey.cost.mean,
      evTotal: result.ev.evTotal,
      pEvPositive: result.ev.pPositive,
      daysToFundedP50: result.journey.daysToFunded?.p50 ?? null,
      flagsNotSimulated: result.assumptions.spec.flagsNotSimulated,
    };
    return { row, result };
  });

  simulated.sort((a, b) => b.row.evTotal - a.row.evTotal);

  return {
    rows: simulated.map((s) => s.row),
    results: simulated.map((s) => s.result),
  };
}
