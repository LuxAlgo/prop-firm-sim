import type { ChallengeSpecInput } from "../spec/challenge.js";
import type { TraderProfileInput } from "../spec/trader.js";
import type { SimOptionsInput } from "../spec/options.js";
import { simulate } from "../engine/simulate.js";

export interface SensitivityPoint {
  /** Offset applied to the win rate, in percentage points. */
  offsetPct: number;
  winRate: number;
  perAttemptPassProbability: number;
  fundedProbability: number;
  evTotal: number;
}

export interface SensitivityResult {
  points: SensitivityPoint[];
  /**
   * ∂(per-attempt pass probability)/∂(win rate), per percentage point of win
   * rate, estimated by central difference at the input. Traders overestimate
   * their win rate; this gradient is what one point of overestimation costs.
   */
  passProbabilityGradientPerPoint: number | null;
  evGradientPerPoint: number | null;
}

/**
 * Perturb the win rate around the input (±1–3 points by default) and report
 * how pass probability and EV move. Parametric profiles only - a bootstrap
 * profile has no win-rate dial to turn.
 */
export function sensitivity(
  spec: ChallengeSpecInput,
  profile: TraderProfileInput,
  options: SimOptionsInput = {},
  offsetsPct: readonly number[] = [-3, -2, -1, 0, 1, 2, 3],
): SensitivityResult {
  if (profile.kind !== "parametric") {
    throw new Error("sensitivity: only parametric profiles have a win rate to perturb");
  }

  const points: SensitivityPoint[] = offsetsPct.map((offsetPct) => {
    const winRate = Math.min(1, Math.max(0, profile.winRate + offsetPct / 100));
    const result = simulate(spec, { ...profile, winRate }, { ...options, includeHistograms: false });
    return {
      offsetPct,
      winRate,
      perAttemptPassProbability: result.perAttempt.passProbability,
      fundedProbability: result.journey.fundedProbability,
      evTotal: result.ev.evTotal,
    };
  });

  const plus = points.find((p) => p.offsetPct === 1);
  const minus = points.find((p) => p.offsetPct === -1);
  const passProbabilityGradientPerPoint =
    plus && minus ? (plus.perAttemptPassProbability - minus.perAttemptPassProbability) / 2 : null;
  const evGradientPerPoint = plus && minus ? (plus.evTotal - minus.evTotal) / 2 : null;

  return { points, passProbabilityGradientPerPoint, evGradientPerPoint };
}
