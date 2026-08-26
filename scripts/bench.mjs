#!/usr/bin/env node
/*
  Hot-loop benchmark: 10,000 paths × ~90 sim-days must stay well under a
  second so the web UI can sweep and re-simulate interactively in a worker.
  Requires core built: pnpm --filter @luxalgo/prop-firm-sim-core build
*/
const { simulate } = await import("../packages/core/dist/index.js");

const spec = {
  challengeId: "bench-100k",
  name: "Bench 100K",
  accountSize: 100_000,
  steps: [
    { profitTargetPct: 8, minTradingDays: 4 },
    { profitTargetPct: 5, minTradingDays: 4 },
  ],
  dailyLoss: { pct: 5 },
  maxLoss: { pct: 10, mode: "trailing-intraday-unrealized" },
  fees: { price: 500 },
  funded: { profitSplitPct: 80, payoutFrequency: "biweekly", firstPayoutMinDays: 14 },
};
const profile = {
  kind: "parametric",
  winRate: 0.48,
  avgWinR: 1.6,
  avgLossR: 1,
  tradesPerDay: 4,
  tradesPerDayModel: "poisson",
  risk: { mode: "percent-of-initial", value: 0.75 },
};

simulate(spec, profile, { paths: 1000, seed: 1 }); // warm up the JIT

const runs = 5;
const times = [];
for (let i = 0; i < runs; i++) {
  const t0 = performance.now();
  simulate(spec, profile, { paths: 10_000, seed: i });
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
console.log(`10,000 paths (2-step challenge + funded horizon), ${runs} runs:`);
console.log(`  best ${times[0].toFixed(0)} ms · median ${times[Math.floor(runs / 2)].toFixed(0)} ms`);
