import { ChallengeSpecSchema, type ChallengeSpecInput } from "../spec/challenge.js";
import { TraderProfileSchema, type TraderProfileInput } from "../spec/trader.js";
import { SimOptionsSchema, type SimOptionsInput } from "../spec/options.js";
import type { SimResult, Trace } from "../spec/result.js";
import { Rng, normalizeSeed, pathSeed } from "./rng.js";
import { makeSource } from "./trades.js";
import { resolveSteps } from "./attempt.js";
import { makeAttemptAccumulator, simulateJourney } from "./journey.js";
import { aggregate, type PathArrays } from "./aggregate.js";
import { TraceRecorder } from "./trace.js";

/**
 * Run the full Monte Carlo simulation.
 *
 * Deterministic: identical (spec, profile, options) including `seed` produce a
 * byte-identical result object, on any platform. Pure and browser-safe: no
 * I/O, no globals, no Node-only APIs - run it in a Web Worker for large path
 * counts.
 */
export function simulate(
  specInput: ChallengeSpecInput,
  profileInput: TraderProfileInput,
  optionsInput: SimOptionsInput = {},
): SimResult {
  const spec = ChallengeSpecSchema.parse(specInput);
  const profile = TraderProfileSchema.parse(profileInput);
  const options = SimOptionsSchema.parse(optionsInput);

  const steps = resolveSteps(spec);
  const source = makeSource(profile);
  const masterSeed = normalizeSeed(options.seed);
  const n = options.paths;

  const paths: PathArrays = {
    funded: new Uint8Array(n),
    attempts: new Float64Array(n),
    tradingDaysToFunded: new Float64Array(n),
    cost: new Float64Array(n),
    payoutTotal: new Float64Array(n),
    payoutEvents: new Float64Array(n),
    fundedBlown: new Uint8Array(n),
    firstPayoutDay: new Float64Array(n),
    maxDrawdownPct: new Float64Array(n),
    net: new Float64Array(n),
    anyAbandoned: false,
  };
  const acc = makeAttemptAccumulator(steps.length);

  const traceCount = Math.min(options.tracePaths, n);
  const trace: Trace | null = traceCount > 0 ? { challenge: [], funded: [] } : null;

  for (let p = 0; p < n; p++) {
    const rng = new Rng(pathSeed(masterSeed, p));
    const tracers =
      trace !== null && p < traceCount
        ? { challenge: new TraceRecorder(), funded: new TraceRecorder() }
        : undefined;
    const record = simulateJourney(spec, steps, source, profile.risk, rng, options, acc, tracers);

    if (trace !== null && tracers !== undefined) {
      trace.challenge.push({
        pathIndex: p,
        outcome: record.firstAttemptPassed ? "passed" : record.firstAttemptFailReason!,
        equity: tracers.challenge.equity,
        floor: tracers.challenge.floor,
        dailyFloor: tracers.challenge.dailyFloor,
        stepBoundaries: tracers.challenge.stepBoundaries,
      });
      if (tracers.funded.equity.length > 0) {
        trace.funded.push({
          pathIndex: p,
          outcome: record.fundedBlown ? "blown" : "survived",
          equity: tracers.funded.equity,
          floor: tracers.funded.floor,
          dailyFloor: tracers.funded.dailyFloor,
        });
      }
    }

    paths.funded[p] = record.funded ? 1 : 0;
    paths.attempts[p] = record.attempts;
    paths.tradingDaysToFunded[p] = record.tradingDaysToFunded;
    paths.cost[p] = record.cost;
    paths.payoutTotal[p] = record.payoutTotal;
    paths.payoutEvents[p] = record.payoutEvents;
    paths.fundedBlown[p] = record.fundedBlown ? 1 : 0;
    paths.firstPayoutDay[p] = record.firstPayoutDay;
    paths.maxDrawdownPct[p] = record.maxDrawdownFraction * 100;
    paths.net[p] = record.net;
    if (record.sawAbandoned) paths.anyAbandoned = true;
  }

  const result = aggregate(spec, profile, options, paths, acc);
  if (trace !== null) result.trace = trace;
  return result;
}
