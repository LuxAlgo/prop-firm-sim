#!/usr/bin/env node
/*
  Generate docs/assets/risk-sweep.svg for the README: a real optimal-risk sweep
  from the engine on a realistic two-step ruleset, drawn as two stacked panels
  sharing the risk axis - pass probability above, EV below - with each argmax
  marked. The two argmaxes landing on different risks is the picture nobody
  selling challenges will publish.

  Requires core built. Run: node scripts/generate-readme-chart.mjs
*/
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const { optimalRisk } = await import("../packages/core/dist/index.js");

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

// A classic CFD two-step ruleset (10%/5% targets, 5% daily, 10% static max
// loss, fee refunded on pass). Frozen here so the chart regenerates
// byte-identically; not rules data - fetch live rules from the LuxAlgo
// directory via the CLI/MCP tools.
const spec = {
  challengeId: "100k-2step",
  name: "100K 2-Step Challenge",
  accountSize: 100_000,
  currency: "USD",
  steps: [
    { profitTargetPct: 10, minTradingDays: 4, maxDays: null },
    { profitTargetPct: 5, minTradingDays: 4, maxDays: null },
  ],
  dailyLoss: {
    pct: 5,
    basis: "prior-day-equity",
    limitBasis: "initial-balance",
    includesOpenPnl: true,
    evaluation: "intraday",
  },
  maxLoss: { pct: 10, mode: "static-initial", locksAtInitial: false, lockOffsetAmount: 0 },
  fees: { price: 540, billing: "one-time", resetFee: null, activationFee: 0, refundableOnPass: true },
  funded: { profitSplitPct: 80, payoutFrequency: "biweekly", firstPayoutMinDays: 14 },
};
const profile = {
  kind: "parametric",
  winRate: 0.48,
  avgWinR: 1.6,
  avgLossR: 1,
  tradesPerDay: 4,
  tradesPerDayModel: "poisson",
  risk: { mode: "percent-of-initial", value: 1 },
};
const options = { paths: 10_000, seed: 42 };
const grid = { min: 0.1, max: 3, step: 0.1 };

console.log(`sweeping ${spec.name} …`);
const sweep = optimalRisk(spec, profile, options, grid, (done, total) => {
  if (done % 10 === 0 || done === total) console.log(`  ${done}/${total}`);
});

// ---- layout ----------------------------------------------------------------
const W = 720;
const H = 470;
const M = { left: 56, right: 20, top: 44, gap: 42 };
const panelH = 150;
const p1Top = M.top + 14;
const p2Top = p1Top + panelH + M.gap;
const plotW = W - M.left - M.right;

const risks = sweep.points.map((p) => p.risk);
const passVals = sweep.points.map((p) => p.perAttemptPassProbability * 100);
const evVals = sweep.points.map((p) => p.evTotal);

const xMin = grid.min;
const xMax = grid.max;
const x = (r) => M.left + ((r - xMin) / (xMax - xMin)) * plotW;

function niceScale(min, max) {
  const span = max - min || 1;
  const step = 10 ** Math.floor(Math.log10(span / 4));
  const mult = span / 4 / step > 5 ? 10 : span / 4 / step > 2 ? 5 : 2;
  const s = step * mult;
  return { min: Math.floor(min / s) * s, max: Math.ceil(max / s) * s, step: s };
}

const passScale = niceScale(0, Math.max(...passVals));
const evScale = niceScale(Math.min(0, ...evVals), Math.max(0, ...evVals));
const yPass = (v) => p1Top + panelH - ((v - passScale.min) / (passScale.max - passScale.min)) * panelH;
const yEv = (v) => p2Top + panelH - ((v - evScale.min) / (evScale.max - evScale.min)) * panelH;

const linePath = (vals, yFn) =>
  vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(risks[i]).toFixed(1)},${yFn(v).toFixed(1)}`).join("");

const ticks = (scale) => {
  const out = [];
  for (let v = scale.min; v <= scale.max + 1e-9; v += scale.step) out.push(Math.round(v * 100) / 100);
  return out;
};
const fmtMoney = (v) =>
  `${v < 0 ? "−" : ""}$${Math.abs(v) >= 1000 ? `${Math.round(Math.abs(v) / 100) / 10}k` : Math.round(Math.abs(v))}`;

const bestPass = sweep.bestByPassProbability;
const bestEv = sweep.bestByEv;

const gridLines = (scale, yFn) =>
  ticks(scale)
    .map(
      (v) =>
        `<line class="grid" x1="${M.left}" x2="${W - M.right}" y1="${yFn(v).toFixed(1)}" y2="${yFn(v).toFixed(1)}"/>` +
        `<text class="tick" x="${M.left - 8}" y="${(yFn(v) + 3.5).toFixed(1)}" text-anchor="end">${
          scale === passScale ? `${v}%` : fmtMoney(v)
        }</text>`,
    )
    .join("\n    ");

const xTicks = [0.5, 1, 1.5, 2, 2.5, 3]
  .map(
    (r) =>
      `<text class="tick" x="${x(r).toFixed(1)}" y="${p2Top + panelH + 18}" text-anchor="middle">${r}%</text>`,
  )
  .join("\n    ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" role="img" aria-label="Risk sweep: pass probability and expected value versus risk per trade. The risk that maximizes pass probability (${bestPass.risk}%) differs from the risk that maximizes EV (${bestEv.risk}%).">
  <style>
    :root { color-scheme: light dark; }
    text { fill: #52514e; font-size: 12px; }
    .tick { fill: #898781; font-size: 11px; font-variant-numeric: tabular-nums; }
    .title { fill: #0b0b0b; font-size: 15px; font-weight: 600; }
    .subtitle { fill: #52514e; font-size: 12px; }
    .panel-label { fill: #0b0b0b; font-size: 12px; font-weight: 600; }
    .grid { stroke: #e1e0d9; stroke-width: 1; }
    .zero { stroke: #c3c2b7; stroke-width: 1; }
    .pass { stroke: #2a78d6; }
    .pass-fill { fill: #2a78d6; }
    .ev { stroke: #eb6834; }
    .ev-fill { fill: #eb6834; }
    .ring { stroke: #ffffff; }
    .marker-line { stroke-width: 1; stroke-dasharray: 3 4; opacity: 0.75; }
    @media (prefers-color-scheme: dark) {
      text { fill: #c3c2b7; }
      .tick { fill: #898781; }
      .title { fill: #ffffff; }
      .subtitle { fill: #c3c2b7; }
      .panel-label { fill: #ffffff; }
      .grid { stroke: #2c2c2a; }
      .zero { stroke: #383835; }
      .pass { stroke: #3987e5; }
      .pass-fill { fill: #3987e5; }
      .ev { stroke: #d95926; }
      .ev-fill { fill: #d95926; }
      .ring { stroke: #0d1117; }
    }
  </style>

  <text class="title" x="${M.left}" y="22">The risk that maximizes passing is not the risk that maximizes EV</text>
  <text class="subtitle" x="${M.left}" y="40">${spec.name} · 48% win rate · 1.6R avg win · 4 trades/day · 10,000 paths · seed 42</text>

  <!-- panel 1: pass probability -->
  <text class="panel-label" x="${M.left}" y="${p1Top - 6}">Pass probability per attempt</text>
  <g>
    ${gridLines(passScale, yPass)}
  </g>
  <line class="marker-line pass" x1="${x(bestPass.risk).toFixed(1)}" x2="${x(bestPass.risk).toFixed(1)}" y1="${p1Top}" y2="${p2Top + panelH}"/>
  <line class="marker-line ev" x1="${x(bestEv.risk).toFixed(1)}" x2="${x(bestEv.risk).toFixed(1)}" y1="${p1Top}" y2="${p2Top + panelH}"/>
  <path class="pass" d="${linePath(passVals, yPass)}" fill="none" stroke-width="2" stroke-linejoin="round"/>
  <circle class="pass-fill ring" cx="${x(bestPass.risk).toFixed(1)}" cy="${yPass(bestPass.perAttemptPassProbability * 100).toFixed(1)}" r="4.5" stroke-width="2"/>
  <text class="tick" x="${(x(bestPass.risk) + 8).toFixed(1)}" y="${(yPass(bestPass.perAttemptPassProbability * 100) + (yPass(bestPass.perAttemptPassProbability * 100) < p1Top + 24 ? 18 : -8)).toFixed(1)}">max pass @ ${bestPass.risk}% risk</text>

  <!-- panel 2: EV -->
  <text class="panel-label" x="${M.left}" y="${p2Top - 6}">Expected value (fees vs funded payouts, ${options.paths.toLocaleString("en-US")} simulated journeys)</text>
  <g>
    ${gridLines(evScale, yEv)}
  </g>
  <line class="zero" x1="${M.left}" x2="${W - M.right}" y1="${yEv(0).toFixed(1)}" y2="${yEv(0).toFixed(1)}"/>
  <path class="ev" d="${linePath(evVals, yEv)}" fill="none" stroke-width="2" stroke-linejoin="round"/>
  <circle class="ev-fill ring" cx="${x(bestEv.risk).toFixed(1)}" cy="${yEv(bestEv.evTotal).toFixed(1)}" r="4.5" stroke-width="2"/>
  <text class="tick" x="${(x(bestEv.risk) + 8).toFixed(1)}" y="${(yEv(bestEv.evTotal) + (yEv(bestEv.evTotal) < p2Top + 24 ? 18 : -8)).toFixed(1)}">max EV @ ${bestEv.risk}% risk</text>

  <text class="tick" x="${M.left + plotW / 2}" y="${H - 8}" text-anchor="middle">risk per trade (% of initial account)</text>
  ${xTicks}
</svg>
`;

await mkdir(path.join(root, "docs", "assets"), { recursive: true });
await writeFile(path.join(root, "docs", "assets", "risk-sweep.svg"), svg);
console.log(
  `✓ docs/assets/risk-sweep.svg - max pass @ ${bestPass.risk}% (${(bestPass.perAttemptPassProbability * 100).toFixed(1)}%), max EV @ ${bestEv.risk}% (${fmtMoney(bestEv.evTotal)})${sweep.diverges ? " - diverges" : ""}`,
);
