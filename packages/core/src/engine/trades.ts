import type { ParametricProfile, TraderProfile } from "../spec/trader.js";
import { StationaryBootstrapSampler } from "../bootstrap/block.js";
import type { Rng } from "./rng.js";

/**
 * A stream of daily trade counts and per-trade R outcomes. All engine paths
 * (evaluation steps, funded stage) consume trades through this interface, so
 * tests can drive the rule enforcement with hand-written sequences.
 */
export interface TradeSource {
  /** Called at the start of every path so per-path state resets. */
  reset(rng: Rng): void;
  /** Number of trades for the next simulated day. */
  nextDayTradeCount(rng: Rng): number;
  /** Outcome of the next trade, in R (positive = win, negative = loss). */
  nextTradeR(rng: Rng): number;
}

function dayCount(rng: Rng, tradesPerDay: number, model: "fixed" | "poisson"): number {
  return model === "poisson" ? rng.poisson(tradesPerDay) : Math.round(tradesPerDay);
}

export class ParametricSource implements TradeSource {
  constructor(private readonly p: ParametricProfile) {}

  reset(): void {
    // Stateless between days; nothing to reset.
  }

  nextDayTradeCount(rng: Rng): number {
    return dayCount(rng, this.p.tradesPerDay, this.p.tradesPerDayModel);
  }

  nextTradeR(rng: Rng): number {
    if (rng.bernoulli(this.p.winRate)) {
      return rng.lognormal(this.p.avgWinR, this.p.winStdR);
    }
    return -rng.lognormal(this.p.avgLossR, this.p.lossStdR);
  }
}

export class BootstrapSource implements TradeSource {
  private readonly sampler: StationaryBootstrapSampler;
  private readonly tradesPerDay: number;
  private readonly model: "fixed" | "poisson";

  constructor(
    rSeries: readonly number[],
    blockMeanLength: number,
    tradesPerDay: number,
    model: "fixed" | "poisson",
  ) {
    this.sampler = new StationaryBootstrapSampler(rSeries, blockMeanLength);
    this.tradesPerDay = tradesPerDay;
    this.model = model;
  }

  reset(): void {
    this.sampler.reset();
  }

  nextDayTradeCount(rng: Rng): number {
    return dayCount(rng, this.tradesPerDay, this.model);
  }

  nextTradeR(rng: Rng): number {
    return this.sampler.next(rng);
  }
}

/**
 * Deterministic source for tests and worked examples: `days[d]` is the exact
 * list of R outcomes for day d. Once the script is exhausted it returns
 * zero-trade days.
 */
export class ScriptedSource implements TradeSource {
  private day = -1;
  private trade = 0;

  constructor(private readonly days: readonly (readonly number[])[]) {}

  reset(): void {
    this.day = -1;
    this.trade = 0;
  }

  nextDayTradeCount(): number {
    this.day++;
    this.trade = 0;
    return this.day < this.days.length ? this.days[this.day]!.length : 0;
  }

  nextTradeR(): number {
    const today = this.days[this.day];
    if (!today || this.trade >= today.length) {
      throw new Error("ScriptedSource: more trades requested than scripted for this day");
    }
    return today[this.trade++]!;
  }
}

export function makeSource(profile: TraderProfile): TradeSource {
  if (profile.kind === "parametric") return new ParametricSource(profile);
  return new BootstrapSource(
    profile.rSeries,
    profile.blockMeanLength,
    profile.tradesPerDay,
    profile.tradesPerDayModel,
  );
}
