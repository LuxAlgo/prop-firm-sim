import { describe, expect, it } from "vitest";
import { Rng, normalizeSeed, pathSeed } from "../src/index.js";

describe("seedable RNG", () => {
  it("identical seeds produce identical streams", () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    for (let i = 0; i < 1000; i++) expect(a.nextUint32()).toBe(b.nextUint32());
  });

  it("string seeds are supported and stable", () => {
    const a = new Rng("my-permalink-seed");
    const b = new Rng("my-permalink-seed");
    expect(a.next()).toBe(b.next());
    expect(normalizeSeed("my-permalink-seed")).toBe(normalizeSeed("my-permalink-seed"));
  });

  it("the first draws for seed 42 are pinned - a cross-engine determinism tripwire", () => {
    const rng = new Rng(42);
    const draws = Array.from({ length: 4 }, () => rng.nextUint32());
    // If these change, every stored permalink and golden result changes:
    // treat as a breaking engine change.
    expect(draws).toEqual([660444221, 3652823732, 77672526, 910233633]);
  });

  it("uniform draws look uniform", () => {
    const rng = new Rng(9);
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) sum += rng.next();
    expect(sum / n).toBeGreaterThan(0.49);
    expect(sum / n).toBeLessThan(0.51);
  });

  it("poisson draws have the requested mean", () => {
    const rng = new Rng(11);
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) sum += rng.poisson(3);
    expect(sum / n).toBeGreaterThan(2.9);
    expect(sum / n).toBeLessThan(3.1);
  });

  it("lognormal draws honor mean and positivity", () => {
    const rng = new Rng(13);
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const v = rng.lognormal(1.8, 0.9);
      expect(v).toBeGreaterThan(0);
      sum += v;
    }
    expect(sum / n).toBeGreaterThan(1.7);
    expect(sum / n).toBeLessThan(1.9);
    expect(rng.lognormal(1.8, 0)).toBe(1.8);
  });

  it("per-path seeds derived from one master seed give distinct streams", () => {
    const master = normalizeSeed(42);
    const s0 = pathSeed(master, 0);
    const s1 = pathSeed(master, 1);
    expect(s0).not.toBe(s1);
    expect(pathSeed(master, 0)).toBe(s0);
  });
});
