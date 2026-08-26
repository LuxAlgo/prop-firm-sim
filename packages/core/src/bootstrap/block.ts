import type { Rng } from "../engine/rng.js";

/*
  Stationary block bootstrap (Politis & Romano 1994): resample the series in
  blocks whose lengths are geometric with mean `blockMeanLength`, wrapping
  around the end. Equivalent implementation: at each draw, with probability
  1/blockMeanLength jump to a uniformly random index, otherwise advance to the
  next index. Preserves the autocorrelation (streakiness) of the input series,
  which i.i.d. resampling destroys - and streaks are exactly what breach
  daily-loss and trailing-drawdown rules.
*/
export class StationaryBootstrapSampler {
  private readonly series: readonly number[];
  private readonly restartProbability: number;
  private index = -1;

  constructor(series: readonly number[], blockMeanLength: number) {
    if (series.length === 0) throw new Error("bootstrap: series must not be empty");
    if (!(blockMeanLength > 0)) throw new Error("bootstrap: blockMeanLength must be positive");
    this.series = series;
    this.restartProbability = 1 / blockMeanLength;
  }

  reset(): void {
    this.index = -1;
  }

  next(rng: Rng): number {
    if (this.index < 0 || rng.next() < this.restartProbability) {
      this.index = rng.int(this.series.length);
    } else {
      this.index = (this.index + 1) % this.series.length;
    }
    return this.series[this.index]!;
  }
}
