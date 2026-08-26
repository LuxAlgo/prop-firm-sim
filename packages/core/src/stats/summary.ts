import type { DistSummary, Histogram, WilsonCi } from "../spec/result.js";

/** Wilson score interval at 95% for k successes out of n trials. */
export function wilson95(k: number, n: number): WilsonCi {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.959963984540054;
  const z2 = z * z;
  const p = k / n;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** q-quantile (0..1) of a pre-sorted array, with linear interpolation. */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loVal = sorted[lo]!;
  if (lo === hi) return loVal;
  return loVal + (sorted[hi]! - loVal) * (pos - lo);
}

export function summarizeSorted(sorted: ArrayLike<number>): DistSummary {
  const n = sorted.length;
  if (n === 0) {
    return {
      mean: Number.NaN,
      min: Number.NaN,
      max: Number.NaN,
      p05: Number.NaN,
      p25: Number.NaN,
      p50: Number.NaN,
      p75: Number.NaN,
      p90: Number.NaN,
      p95: Number.NaN,
    };
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i]!;
  return {
    mean: sum / n,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    p05: quantileSorted(sorted, 0.05),
    p25: quantileSorted(sorted, 0.25),
    p50: quantileSorted(sorted, 0.5),
    p75: quantileSorted(sorted, 0.75),
    p90: quantileSorted(sorted, 0.9),
    p95: quantileSorted(sorted, 0.95),
  };
}

export function histogramSorted(sorted: ArrayLike<number>, bins = 20): Histogram | null {
  const n = sorted.length;
  if (n === 0) return null;
  const min = sorted[0]!;
  const max = sorted[n - 1]!;
  if (max === min) {
    return { min, max, binWidth: 0, counts: [n] };
  }
  const binWidth = (max - min) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (let i = 0; i < n; i++) {
    let bin = Math.floor((sorted[i]! - min) / binWidth);
    if (bin >= bins) bin = bins - 1;
    counts[bin]!++;
  }
  return { min, max, binWidth, counts };
}

export function standardError(values: ArrayLike<number>, mean: number): number {
  const n = values.length;
  if (n < 2) return Number.NaN;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i]! - mean;
    ss += d * d;
  }
  return Math.sqrt(ss / (n - 1) / n);
}
