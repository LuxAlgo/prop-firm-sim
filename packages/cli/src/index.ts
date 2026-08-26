#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { analyzeOverlap, compare, optimalRisk, simulate, type SimResult } from "@luxalgo/prop-firm-sim-core";
import { buildFirmsListing, fetchDirectory, requireAdaptedChallenge, resolveFirm } from "./lib/directory.js";
import { formatErrorMessage, UsageError } from "./lib/errors.js";
import { buildSimOptionsFromFlags, type SimFlags } from "./lib/options.js";
import { parseNumberFlag, parseRef } from "./lib/parse.js";
import { buildProfileFromFlags, type TraderFlags } from "./lib/profile.js";
import {
  renderCompareReport,
  renderFirmsList,
  renderOptimalRiskReport,
  renderOverlapReport,
  renderRulesReport,
  renderSimulateReport,
} from "./lib/render.js";
import { resolveTargetSpec, type TargetFlags } from "./lib/target.js";
import {
  assertNewsNeedsTradeLog,
  buildNewsComparison,
  buildTradeLogPlan,
  loadTradeLogs,
  MAX_TRADE_LOGS,
  type TradeLogFlags,
} from "./lib/tradelog.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version?: string };

/** Product classes the live directory serves. */
const PRODUCT_TYPES = ["futures", "cfd"] as const;

function useColor(): boolean {
  return process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Wrap a command action: user-facing errors become one clean line + exit(1). */
function runAction<Args extends unknown[]>(
  fn: (...args: Args) => void | Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await fn(...args);
    } catch (err) {
      process.stderr.write(`error: ${formatErrorMessage(err)}\n`);
      process.exit(1);
    }
  };
}

type CommonFlags = TraderFlags & TargetFlags & SimFlags & { json?: boolean };

/** Commander accumulator for a repeatable flag like --trade-log. */
function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function addTargetOptions(cmd: Command): Command {
  return cmd
    .option("--firm <firm>", "propfirmId or firm name in the live directory (see `prop-firm-sim firms`)")
    .option("--challenge <challengeId>", "directory challenge id for --firm")
    .option("--spec <path>", "path to a ChallengeSpec JSON file instead of --firm/--challenge (offline)");
}

function addTraderOptions(cmd: Command): Command {
  return cmd
    .option("--winrate <fraction>", "win rate as a fraction, e.g. 0.52 (win-rate model)")
    .option("--avg-win <R>", "average winner in R, e.g. 1.8 (win-rate model)")
    .option("--avg-loss <R>", "average loser in R, positive (default: 1)")
    .option("--win-std <R>", "std dev of winner size in R (default: 0)")
    .option("--loss-std <R>", "std dev of loser size in R (default: 0)")
    .option("--trades-per-day <n>", "average trades per trading day (required)")
    .option("--poisson", "draw each day's trade count from Poisson(trades-per-day)")
    .option("--r-series <values>", 'bootstrap instead: R-multiples as CSV/whitespace/JSON, "R" suffix ok')
    .option("--r-series-file <path>", "bootstrap from a file of R-multiples")
    .option("--block-length <n>", "mean block length of the bootstrap resampler (default: 5)")
    .option("--risk <value>", 'risk per trade: "0.5%" or 0.5; a currency amount for fixed-amount mode')
    .option(
      "--risk-mode <mode>",
      "percent-of-balance | percent-of-initial | fixed-amount (default: percent-of-balance)",
    );
}

function addSimOptions(cmd: Command): Command {
  return cmd
    .option("--paths <n>", "Monte Carlo paths (default: 10000)")
    .option("--seed <value>", "RNG seed, number or string (default: 42); same inputs + seed = same result")
    .option("--attempt-cap <n>", "max challenge attempts per path (default: 25)")
    .option("--funded-horizon <days>", "funded-stage horizon in trading days (default: 90)")
    .option("--no-funded", "skip the funded-stage simulation (EV then counts fees minus refunds only)");
}

const program = new Command();

program
  .name("prop-firm-sim")
  .description(
    "Open-source prop-firm challenge simulator by LuxAlgo. Monte Carlo over your trading statistics and a " +
      "firm's exact ruleset: pass probability, expected attempts and cost, EV, and optimal risk sizing. " +
      "Simulation, not prediction - every result states its assumptions.",
  )
  .version(pkg.version ?? "0.0.0");

program
  .command("firms")
  .description("list firms and challenges from the live LuxAlgo directory (luxalgo.com/prop-firms)")
  .option("--product-type <type>", "filter: futures | cfd")
  .option("--json", "print the listing as JSON")
  .action(
    runAction(async (opts: { productType?: string; json?: boolean }) => {
      let filter: { productType: (typeof PRODUCT_TYPES)[number] } | undefined;
      if (opts.productType !== undefined) {
        const productType = PRODUCT_TYPES.find((t) => t === opts.productType);
        if (productType === undefined) {
          throw new UsageError(
            `--product-type must be one of ${PRODUCT_TYPES.join(", ")} (got "${opts.productType}")`,
          );
        }
        filter = { productType };
      }
      const listing = buildFirmsListing(await fetchDirectory(), filter);
      if (opts.json === true) {
        printJson(listing);
        return;
      }
      process.stdout.write(`${renderFirmsList(listing, { color: useColor() })}\n`);
    }),
  );

program
  .command("rules")
  .description("show a challenge's full ruleset, with provenance, citations and what is not simulated")
  .argument("<firm>", "propfirmId or firm name (case-insensitive), e.g. ftmo")
  .argument("<challengeId>", "challenge id, e.g. 100k-2step")
  .option("--json", "print the adapted challenge (spec + provenance) as JSON")
  .action(
    runAction(async (firmQuery: string, challengeId: string, opts: { json?: boolean }) => {
      const firm = resolveFirm(await fetchDirectory(), firmQuery);
      const adapted = requireAdaptedChallenge(firm, challengeId); // throws listing what exists
      if (opts.json === true) {
        printJson(adapted);
        return;
      }
      process.stdout.write(`${renderRulesReport(adapted, { color: useColor() })}\n`);
    }),
  );

addSimOptions(addTraderOptions(addTargetOptions(program.command("simulate"))))
  .description("simulate your stats against one challenge: pass probability, attempts, cost, EV")
  .option(
    "--trade-log <file>",
    `bootstrap from a trade-history file: the generic CSV template, plain timestamped CSV/TSV logs, or ` +
      `real exports (TradingView list of trades, MT4/MT5 statements incl. HTML, MT5 deals, ThinkOrSwim ` +
      `statements); repeat up to ${MAX_TRADE_LOGS} times to merge a portfolio`,
    collectRepeatable,
    [] as string[],
  )
  .option(
    "--import-risk <value>",
    'risk per trade for exports that carry P&L but no risk data: cash ("25") or percent of entry value ("1%")',
  )
  .option(
    "--avoid-news [impacts]",
    "also exclude trades opened around scheduled news and compare both scenarios; " +
      "optional comma list of impacts low,medium,high (default: high). Requires --trade-log",
  )
  .option("--news-pre <minutes>", "avoidance window before each news event, in minutes (default: 30)")
  .option("--news-post <minutes>", "avoidance window after each news event, in minutes (default: 30)")
  .option(
    "--news-currencies <list>",
    "comma list of event currencies to avoid (default: USD,EUR,GBP,JPY,AUD,CAD,CHF,NZD)",
  )
  .option("--json", "dump the raw SimResult as JSON")
  .action(
    runAction(async (opts: CommonFlags & TradeLogFlags) => {
      const target = await resolveTargetSpec(opts);
      const plan = (opts.tradeLog?.length ?? 0) > 0 ? buildTradeLogPlan(opts) : null;
      if (plan === null) assertNewsNeedsTradeLog(opts);
      for (const warning of plan?.warnings ?? []) process.stderr.write(`warning: ${warning}\n`);
      const profile = plan !== null ? plan.profile : buildProfileFromFlags(opts);
      const simOptions = buildSimOptionsFromFlags(opts);
      const result = simulate(target.spec, profile, simOptions);
      // With --avoid-news, `result` is the news-avoided scenario; the full
      // history runs once more on the same seed and options for comparison.
      let newsOriginal: SimResult | null = null;
      if (plan !== null && plan.news !== null && plan.originalProfile !== null) {
        newsOriginal = simulate(target.spec, plan.originalProfile, simOptions);
      }
      if (opts.json === true) {
        printJson({
          ...result,
          ...(plan?.overlap != null ? { portfolioOverlap: plan.overlap } : {}),
          ...(plan !== null && plan.news !== null && newsOriginal !== null
            ? { newsComparison: buildNewsComparison(newsOriginal, result, plan.news) }
            : {}),
        });
        return;
      }
      const ctx: Parameters<typeof renderSimulateReport>[1] = { ref: target.ref, color: useColor() };
      if (target.firmName !== undefined) ctx.firmName = target.firmName;
      if (target.provenance !== undefined) {
        ctx.provenance = target.provenance;
        ctx.inferredFields = target.inferredFields ?? [];
      }
      if (plan !== null) {
        ctx.tradeLog = {
          files: plan.files,
          trades: plan.simulatedEntries.length,
          distinctDays: plan.distinctDays,
          historyCount: plan.historyCount,
          derivedTradesPerDay: plan.derivedTradesPerDay,
        };
        if (plan.overlap !== null) ctx.overlap = plan.overlap;
        if (plan.news !== null && newsOriginal !== null) {
          ctx.news = { original: newsOriginal, filter: plan.news };
        }
      }
      process.stdout.write(`${renderSimulateReport(result, ctx)}\n`);
    }),
  );

program
  .command("overlap")
  .description(
    "audit-risk check across 2-5 trade-log files: same-direction position overlap a prop firm reviewer " +
      "could treat as correlated accounts (no simulation)",
  )
  .argument(
    "<files...>",
    "2-5 trade-history files (generic CSV, timestamped logs, or recognized broker exports)",
  )
  .option(
    "--import-risk <value>",
    'risk per trade for exports that carry P&L but no risk data: cash ("25") or percent of entry value ("1%")',
  )
  .option("--tolerance <minutes>", "overlap tolerance in minutes around each position (default: 5, max: 240)")
  .option("--json", "print the overlap report as JSON")
  .action(
    runAction((files: string[], opts: { tolerance?: string; json?: boolean; importRisk?: string }) => {
      const loaded = loadTradeLogs(files, {
        minLogs: 2,
        ...(opts.importRisk !== undefined ? { importRisk: opts.importRisk } : {}),
      });
      for (const warning of loaded.warnings) process.stderr.write(`warning: ${warning}\n`);
      const report = analyzeOverlap(
        loaded.histories,
        opts.tolerance !== undefined
          ? { toleranceMinutes: parseNumberFlag("--tolerance", opts.tolerance, { min: 0, max: 240 }) }
          : {},
      );
      if (opts.json === true) {
        printJson({ files: loaded.files, ...report });
        return;
      }
      process.stdout.write(
        `${renderOverlapReport(report, {
          files: loaded.files,
          tradeCounts: loaded.histories.map((history) => history.length),
          color: useColor(),
        })}\n`,
      );
    }),
  );

addSimOptions(addTraderOptions(addTargetOptions(program.command("optimal-risk"))))
  .description("sweep risk per trade and show where pass probability and EV each peak - they usually differ")
  .option("--min <risk>", "grid start (default: 0.1)")
  .option("--max <risk>", "grid end (default: 3)")
  .option("--step <risk>", "grid step (default: 0.1)")
  .option("--json", "dump the raw sweep result as JSON")
  .action(
    runAction(async (opts: CommonFlags & { min?: string; max?: string; step?: string }) => {
      const target = await resolveTargetSpec(opts);
      const profile = buildProfileFromFlags(opts, { riskRequired: false });
      const simOptions = buildSimOptionsFromFlags(opts);
      const grid = {
        min: opts.min !== undefined ? parseNumberFlag("--min", opts.min, { min: 1e-9 }) : 0.1,
        max: opts.max !== undefined ? parseNumberFlag("--max", opts.max, { min: 1e-9 }) : 3,
        step: opts.step !== undefined ? parseNumberFlag("--step", opts.step, { min: 1e-9 }) : 0.1,
      };
      if (grid.max < grid.min) {
        throw new UsageError(`--max (${grid.max}) must be greater than or equal to --min (${grid.min})`);
      }

      const showProgress = process.stderr.isTTY === true && opts.json !== true;
      const sweep = optimalRisk(
        target.spec,
        profile,
        simOptions,
        grid,
        showProgress
          ? (done, total) => {
              process.stderr.write(`\rsweeping risk grid ${done}/${total}`);
              if (done === total) process.stderr.write(`\r${" ".repeat(40)}\r`);
            }
          : undefined,
      );
      if (opts.json === true) {
        printJson(sweep);
        return;
      }
      // One reference run at the EV-maximizing risk supplies the assumption
      // flags and resolved context for the mandatory footer.
      const reference = simulate(
        target.spec,
        { ...profile, risk: { ...profile.risk, value: sweep.bestByEv.risk } },
        { ...simOptions, includeHistograms: false },
      );
      const ctx: Parameters<typeof renderOptimalRiskReport>[2] = {
        ref: target.ref,
        grid,
        color: useColor(),
      };
      if (target.firmName !== undefined) ctx.firmName = target.firmName;
      if (target.provenance !== undefined) {
        ctx.provenance = target.provenance;
        ctx.inferredFields = target.inferredFields ?? [];
      }
      process.stdout.write(`${renderOptimalRiskReport(sweep, reference, ctx)}\n`);
    }),
  );

addSimOptions(addTraderOptions(program.command("compare")))
  .description("simulate your stats across several live-directory challenges (refs like ftmo/100k-2step)")
  .argument("<refs...>", "challenge references: <firm>/<challengeId>, firm id or case-insensitive name")
  .option("--json", "dump rows and full results as JSON")
  .action(
    runAction(async (refs: string[], opts: CommonFlags) => {
      const parsedRefs = refs.map((raw) => parseRef(raw));
      const rows = await fetchDirectory();
      const entries = parsedRefs.map(({ firmId, challengeId }) => {
        const firm = resolveFirm(rows, firmId);
        const adapted = requireAdaptedChallenge(firm, challengeId); // throws listing what exists
        return { firmId: firm.propfirmId, firmName: firm.name, adapted };
      });
      const profile = buildProfileFromFlags(opts);
      const simOptions = buildSimOptionsFromFlags(opts);
      const result = compare(
        entries.map(({ firmId, firmName, adapted }) => ({ firmId, firmName, spec: adapted.spec })),
        profile,
        simOptions,
      );
      if (opts.json === true) {
        printJson(result);
        return;
      }
      const provenance = entries.map(({ firmId, adapted }) => ({
        ref: `${firmId}/${adapted.challengeId}`,
        provenance: adapted.provenance,
        inferredFields: adapted.inferredFields,
      }));
      process.stdout.write(`${renderCompareReport(result, { color: useColor(), provenance })}\n`);
    }),
  );

program.addHelpText(
  "after",
  `
Examples:
  prop-firm-sim firms
  prop-firm-sim rules ftmo 100k-2step
  prop-firm-sim simulate --firm ftmo --challenge 100k-2step \\
    --winrate 0.52 --avg-win 1.8 --trades-per-day 3 --risk 0.5%
  prop-firm-sim simulate --firm ftmo --challenge 100k-2step \\
    --r-series-file my-trades.csv --trades-per-day 3 --risk 0.5%
  prop-firm-sim simulate --firm ftmo --challenge 100k-2step \\
    --trade-log journal.csv --avoid-news --risk 0.5%
  prop-firm-sim simulate --firm ftmo --challenge 100k-2step \\
    --trade-log strategy-a.csv --trade-log strategy-b.csv --risk 0.5%
  prop-firm-sim overlap account-a.csv account-b.csv --tolerance 10
  prop-firm-sim optimal-risk --firm ftmo --challenge 100k-2step \\
    --winrate 0.48 --avg-win 1.6 --trades-per-day 4 --min 0.25 --max 2 --step 0.25
  prop-firm-sim compare ftmo/100k-2step --winrate 0.52 --avg-win 1.8 --trades-per-day 3 --risk 0.5%

Firm and challenge data comes from LuxAlgo's public directory API (keyless, read-only;
origin overridable with LUXALGO_APP_ORIGIN). Offline, pass your own ruleset with --spec.
`,
);

await program.parseAsync(process.argv);
