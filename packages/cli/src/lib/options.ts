import type { SimOptionsInput } from "@luxalgo/prop-firm-sim-core";
import { parseNumberFlag, parseSeedFlag } from "./parse.js";

/** Raw simulation flag values as commander hands them over. */
export interface SimFlags {
  paths?: string;
  seed?: string;
  attemptCap?: string;
  fundedHorizon?: string;
  /** commander's --no-funded: true by default, false when the flag is passed. */
  funded?: boolean;
}

/** Build core SimOptionsInput from CLI flags, validating ranges up front. */
export function buildSimOptionsFromFlags(flags: SimFlags): SimOptionsInput {
  return {
    ...(flags.paths !== undefined
      ? { paths: parseNumberFlag("--paths", flags.paths, { min: 100, max: 1_000_000, integer: true }) }
      : {}),
    ...(flags.seed !== undefined ? { seed: parseSeedFlag(flags.seed) } : {}),
    ...(flags.attemptCap !== undefined
      ? {
          attemptCap: parseNumberFlag("--attempt-cap", flags.attemptCap, {
            min: 1,
            max: 1000,
            integer: true,
          }),
        }
      : {}),
    ...(flags.fundedHorizon !== undefined
      ? {
          fundedHorizonDays: parseNumberFlag("--funded-horizon", flags.fundedHorizon, {
            min: 1,
            max: 2000,
            integer: true,
          }),
        }
      : {}),
    ...(flags.funded === false ? { simulateFunded: false } : {}),
  };
}
