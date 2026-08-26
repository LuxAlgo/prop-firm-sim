import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/*
  The core must be isomorphic: the free static web UI and any embed run it in
  a browser Web Worker with zero servers. Bundling src/ for the browser
  platform fails on any node:* import, and executing the bundle proves the
  engine runs outside Node.
*/

describe("browser compatibility", () => {
  it("the engine bundles for the browser with no Node built-ins and runs a simulation inside the bundle", async () => {
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const out = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      globalName: "PropFirmSimCore",
      logLevel: "silent",
    });
    const code = out.outputFiles[0]!.text;
    expect(code).not.toMatch(/require\(["']node:/);
    expect(code).not.toMatch(/from\s*["']node:/);

    const factory = new Function(`${code}; return PropFirmSimCore;`);
    const core = factory() as typeof import("../src/index.js");
    const result = core.simulate(
      {
        challengeId: "browser-check",
        name: "Browser Check",
        accountSize: 50_000,
        steps: [{ profitTargetPct: 6 }],
        dailyLoss: { pct: 4 },
        maxLoss: { pct: 8, mode: "trailing-intraday-unrealized" },
        fees: { price: 300 },
        funded: { profitSplitPct: 80, payoutFrequency: "monthly" },
      },
      {
        kind: "parametric",
        winRate: 0.5,
        avgWinR: 1.4,
        tradesPerDay: 3,
        risk: { mode: "percent-of-initial", value: 1 },
      },
      { paths: 500, seed: 5 },
    );
    expect(result.engineVersion).toBeDefined();
    expect(result.journey.fundedProbability).toBeGreaterThan(0);
  }, 30_000);
});
