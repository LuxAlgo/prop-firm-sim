/*
  xoshiro128** seeded via splitmix32. Integer-only arithmetic (Math.imul,
  shifts), so streams are bit-identical across JS engines - determinism is a
  product feature: permalinks and golden tests depend on same seed ⇒ same
  result. Distribution draws (normal, poisson) use Math.exp/log/cos, which are
  fdlibm-derived in all major engines; the golden tests pin their output.
*/

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function splitmix32(state: number): () => number {
  let a = state >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export function normalizeSeed(seed: number | string): number {
  return typeof seed === "string" ? fnv1a(seed) : seed >>> 0;
}

/**
 * Derive an independent per-path seed from the master seed, so every path has
 * its own stream. Identical (seed, pathIndex) pairs yield identical streams
 * regardless of how many paths run - this is what makes common-random-numbers
 * work across risk-sweep grid points.
 */
export function pathSeed(masterSeed: number, pathIndex: number): number {
  const mix = splitmix32((masterSeed ^ Math.imul(pathIndex + 1, 0x9e3779b1)) >>> 0);
  return mix();
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private spareNormal: number | null = null;

  constructor(seed: number | string) {
    const mix = splitmix32(normalizeSeed(seed));
    this.s0 = mix();
    this.s1 = mix();
    this.s2 = mix();
    this.s3 = mix();
    // xoshiro state must not be all-zero; splitmix32 makes that astronomically
    // unlikely, but guard anyway.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s3 = 1;
  }

  nextUint32(): number {
    const s1 = this.s1;
    const r0 = Math.imul(s1, 5);
    const r1 = ((r0 << 7) | (r0 >>> 25)) >>> 0;
    const result = (Math.imul(r1, 9) >>> 0) >>> 0;

    const t = (s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;

    return result;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  bernoulli(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Standard normal via Box–Muller (caches the spare draw). */
  normal(): number {
    if (this.spareNormal !== null) {
      const v = this.spareNormal;
      this.spareNormal = null;
      return v;
    }
    let u1 = this.next();
    while (u1 === 0) u1 = this.next();
    const u2 = this.next();
    const mag = Math.sqrt(-2 * Math.log(u1));
    this.spareNormal = mag * Math.sin(2 * Math.PI * u2);
    return mag * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Lognormal with the given arithmetic mean and standard deviation.
   * sd = 0 degenerates to the constant mean.
   */
  lognormal(mean: number, sd: number): number {
    if (sd <= 0) return mean;
    const sigma2 = Math.log(1 + (sd * sd) / (mean * mean));
    const mu = Math.log(mean) - sigma2 / 2;
    return Math.exp(mu + Math.sqrt(sigma2) * this.normal());
  }

  /** Poisson via Knuth's method (fine for the small lambdas of trades/day). */
  poisson(lambda: number): number {
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > limit);
    return k - 1;
  }
}
