import {
  ChallengeSpecSchema,
  DISCLAIMER,
  type AssumptionFlag,
  type CompareResult,
  type DailyLossRule,
  type DistSummary,
  type FailReason,
  type FeeSpec,
  type MaxLossRule,
  type NewsFilterResult,
  type OptimalRiskResult,
  type OverlapReport,
  type PayoutRules,
  type RiskSizing,
  type SimResult,
  type StepSpec,
  type TraderProfile,
} from "@luxalgo/prop-firm-sim-core";
import type { AdaptedChallenge, DirectoryProvenance } from "@luxalgo/prop-firm-sim-core/directory";
import type { FirmsListing } from "./directory.js";
import {
  bold,
  dim,
  fmtCi,
  fmtInt,
  fmtMoney,
  fmtNum,
  fmtPct,
  renderTable,
  wrap,
  type RenderOptions,
} from "./format.js";

const FAIL_REASONS: readonly FailReason[] = ["daily-loss", "max-loss", "time-limit", "abandoned"];

/* ------------------------------------------------------------------ */
/* Shared building blocks                                             */
/* ------------------------------------------------------------------ */

type ReportEntry = { label: string; value: string } | string;

/** Align `{label, value}` entries on a shared column; strings pass through. */
function renderAligned(entries: ReportEntry[]): string {
  const rows = entries.filter((e): e is { label: string; value: string } => typeof e !== "string");
  const width = rows.length > 0 ? Math.max(...rows.map((e) => e.label.length)) + 3 : 0;
  return entries
    .map((e) => (typeof e === "string" ? e : (e.label.padEnd(width) + e.value).trimEnd()))
    .join("\n");
}

function bulleted(text: string): string {
  const wrapped = wrap(text, 98, "    ");
  return `  • ${wrapped.slice(4)}`;
}

/** The mandatory tail of every human-readable results view. */
export function renderAssumptionsAndDisclaimer(
  flags: readonly AssumptionFlag[],
  disclaimer: string,
  opts?: RenderOptions,
): string {
  const lines: string[] = ["Not simulated / assumptions:"];
  for (const flag of flags) lines.push(bulleted(`${flag.id}: ${flag.detail}`));
  if (flags.length === 0) lines.push("  • none declared");
  return `${lines.join("\n")}\n\n${dim(wrap(disclaimer, 98), opts)}`;
}

export function describeRisk(risk: RiskSizing, currency: string): string {
  switch (risk.mode) {
    case "percent-of-balance":
      return `risk ${fmtNum(risk.value, 2)}% of balance per trade`;
    case "percent-of-initial":
      return `risk ${fmtNum(risk.value, 2)}% of initial per trade`;
    case "fixed-amount":
      return `risk ${fmtMoney(risk.value, currency)} per trade`;
  }
}

export function describeProfile(
  profile: TraderProfile,
  currency: string,
  { includeRisk = true }: { includeRisk?: boolean } = {},
): string {
  const parts: string[] = [];
  if (profile.kind === "parametric") {
    parts.push(`win rate ${fmtPct(profile.winRate)}`);
    parts.push(
      `avg win ${fmtNum(profile.avgWinR, 2)}R${profile.winStdR > 0 ? ` (σ ${fmtNum(profile.winStdR, 2)}R)` : ""}`,
    );
    parts.push(
      `avg loss ${fmtNum(profile.avgLossR, 2)}R${profile.lossStdR > 0 ? ` (σ ${fmtNum(profile.lossStdR, 2)}R)` : ""}`,
    );
  } else {
    parts.push(
      `bootstrap of ${profile.rSeries.length} recorded trades (mean block ${fmtNum(profile.blockMeanLength, 1)})`,
    );
  }
  parts.push(
    profile.tradesPerDayModel === "poisson"
      ? `~${fmtNum(profile.tradesPerDay, 2)} trades/day (Poisson)`
      : `${fmtNum(profile.tradesPerDay, 2)} trades/day`,
  );
  if (includeRisk) parts.push(describeRisk(profile.risk, currency));
  return parts.join(" · ");
}

function feeBrief(fees: FeeSpec, currency: string): string {
  return fees.billing === "monthly"
    ? `fee ${fmtMoney(fees.price, currency)}/month`
    : `fee ${fmtMoney(fees.price, currency)} one-time`;
}

function stepTarget(step: StepSpec, currency: string): string {
  return step.profitTargetPct !== undefined
    ? `+${fmtNum(step.profitTargetPct, 2)}%`
    : `+${fmtMoney(step.profitTargetAmount ?? null, currency)}`;
}

function distLine(
  summary: DistSummary,
  currency: string | null,
  quantiles: readonly ["mean" | "p50" | "p75" | "p90" | "p95", string][],
): string {
  return quantiles
    .map(([key, label]) => {
      const value = summary[key];
      return `${label} ${currency === null ? fmtNum(value, 1) : fmtMoney(value, currency)}`;
    })
    .join(" · ");
}

/* ------------------------------------------------------------------ */
/* directory provenance                                               */
/* ------------------------------------------------------------------ */

/**
 * One-line provenance statement shared by every directory-sourced view:
 * either every rule came from structured columns, or the named spec paths
 * were inferred from disclosed free text.
 */
export function describeProvenance(
  provenance: DirectoryProvenance,
  inferredFields: readonly string[],
): string {
  return provenance === "directory+inferred"
    ? `directory+inferred, inferred from free text: ${inferredFields.join(", ")}`
    : "directory, every simulated rule read from a structured directory column";
}

function directoryDataLine(provenance: DirectoryProvenance, inferredFields: readonly string[]): string {
  return wrap(
    `Data: live LuxAlgo directory · provenance ${describeProvenance(provenance, inferredFields)}`,
    98,
  );
}

/* ------------------------------------------------------------------ */
/* firms                                                              */
/* ------------------------------------------------------------------ */

export function renderFirmsList(listing: FirmsListing, opts?: RenderOptions): string {
  const { challenges, notSimulatable } = listing;
  if (challenges.length === 0 && notSimulatable.length === 0) {
    return `No challenges in the live LuxAlgo directory match that filter.\n\n${dim(wrap(DISCLAIMER, 98), opts)}`;
  }
  const blocks: string[] = [];
  if (challenges.length > 0) {
    blocks.push(
      renderTable(
        [
          { header: "FIRM" },
          { header: "FIRM NAME" },
          { header: "CHALLENGE" },
          { header: "CHALLENGE NAME" },
          { header: "PRODUCT" },
          { header: "SIZE", align: "right" },
          { header: "PRICE", align: "right" },
          { header: "PROVENANCE" },
        ],
        challenges.map((c) => [
          c.propfirmId,
          c.firmName,
          c.challengeId,
          c.challengeName,
          c.productType,
          fmtMoney(c.accountSize, "USD"),
          c.price === null ? "n/a" : fmtMoney(c.price, "USD"),
          c.provenance,
        ]),
      ),
    );
  }
  if (notSimulatable.length > 0) {
    blocks.push(
      "In the directory but not simulatable: ambiguous rule text, refused rather than guessed.\n" +
        notSimulatable
          .map((c) => bulleted(`${c.propfirmId}/${c.challengeId} (${c.challengeName})`))
          .join("\n"),
    );
  }
  const firmCount = new Set(challenges.map((c) => c.propfirmId)).size;
  const counts =
    `${challenges.length} simulatable challenge${challenges.length === 1 ? "" : "s"} from ` +
    `${firmCount} firm${firmCount === 1 ? "" : "s"}. ` +
    "Source: the live LuxAlgo directory, the data behind luxalgo.com/prop-firms. " +
    "Provenance directory+inferred means some semantics were inferred from disclosed free text. " +
    "Data, not endorsement; each firm's own pages are authoritative.";
  const hint =
    "Inspect rules:  prop-firm-sim rules <FIRM> <CHALLENGE>\n" +
    "Simulate:       prop-firm-sim simulate --firm <FIRM> --challenge <CHALLENGE> --winrate 0.52 --avg-win 1.8 --trades-per-day 3 --risk 0.5%";
  blocks.push(`${wrap(counts, 98)}\n${hint}`);
  blocks.push(dim(wrap(DISCLAIMER, 98), opts));
  return blocks.join("\n\n");
}

/* ------------------------------------------------------------------ */
/* rules                                                              */
/* ------------------------------------------------------------------ */

const MAX_LOSS_MODE_EXPLANATION: Record<MaxLossRule["mode"], string> = {
  "static-initial": "measured from the initial balance and never moves",
  "trailing-realized-eod":
    "the floor ratchets up with end-of-day balance highs; intraday highs do not move it",
  "trailing-intraday-unrealized":
    "the floor trails the peak unrealized equity tick by tick and never stops trailing",
  "trailing-locks-at-initial":
    "the floor trails peak intraday equity until it reaches the initial balance, then freezes",
};

export function describeDailyLoss(rule: DailyLossRule, accountSize: number, currency: string): string {
  const parts: string[] = [];
  if (rule.pct !== undefined) {
    parts.push(
      rule.limitBasis === "initial-balance"
        ? `${fmtNum(rule.pct, 2)}% of the initial balance (${fmtMoney((accountSize * rule.pct) / 100, currency)} fixed allowance)`
        : `${fmtNum(rule.pct, 2)}% of each day's anchor (allowance recomputed daily)`,
    );
  } else {
    parts.push(`${fmtMoney(rule.amount ?? null, currency)} fixed allowance`);
  }
  parts.push(
    rule.basis === "prior-day-equity"
      ? "anchored to the prior day's closing equity"
      : "anchored to the prior day's closing balance",
  );
  parts.push(
    rule.includesOpenPnl
      ? "floating PnL counts (a breach can happen mid-trade)"
      : "realized PnL only (open positions cannot breach it)",
  );
  parts.push(
    rule.evaluation === "intraday"
      ? "checked intraday: touching the floor fails the account"
      : "checked at the daily close only",
  );
  return parts.join(" · ");
}

export function describeMaxLoss(rule: MaxLossRule, accountSize: number, currency: string): string {
  const limit =
    rule.pct !== undefined
      ? `${fmtNum(rule.pct, 2)}% of the initial balance (${fmtMoney((accountSize * rule.pct) / 100, currency)})`
      : `${fmtMoney(rule.amount ?? null, currency)}`;
  const parts = [limit, `${rule.mode}: ${MAX_LOSS_MODE_EXPLANATION[rule.mode]}`];
  const locksViaMode = rule.mode === "trailing-locks-at-initial";
  if (rule.locksAtInitial || locksViaMode) {
    const lockLevel =
      rule.lockOffsetAmount > 0
        ? `the starting balance + ${fmtMoney(rule.lockOffsetAmount, currency)}`
        : "the starting balance";
    if (!locksViaMode) parts.push(`locks once the floor reaches ${lockLevel}`);
    else if (rule.lockOffsetAmount > 0) parts.push(`the floor locks at ${lockLevel}`);
  }
  return parts.join(" · ");
}

/** Human line for the funded stage's payout gating - simulated since engine v1. */
export function describePayoutRules(rules: PayoutRules, currency: string): string {
  const parts: string[] = [];
  if (rules.minWinningDays > 0) {
    parts.push(
      `requires ${rules.minWinningDays} winning day${rules.minWinningDays === 1 ? "" : "s"}` +
        (rules.winningDayMinProfit > 0 ? ` of ${fmtMoney(rules.winningDayMinProfit, currency)}+ each` : ""),
    );
  } else if (rules.winningDayMinProfit > 0) {
    parts.push(`a day counts as winning from ${fmtMoney(rules.winningDayMinProfit, currency)} profit`);
  }
  const caps: string[] = [];
  if (rules.maxPayoutPctOfProfit !== undefined)
    caps.push(`${fmtNum(rules.maxPayoutPctOfProfit, 2)}% of accrued profit`);
  if (rules.maxPayoutAmount !== undefined) caps.push(fmtMoney(rules.maxPayoutAmount, currency));
  if (caps.length > 0) parts.push(`each payout capped at ${caps.join(" and ")}`);
  if (rules.bufferAmount > 0) {
    parts.push(`a ${fmtMoney(rules.bufferAmount, currency)} profit buffer stays in the account`);
  }
  if (rules.consistencyMaxBestDayPct !== undefined) {
    parts.push(
      `funded consistency: best day ≤ ${fmtNum(rules.consistencyMaxBestDayPct, 2)}% of the window's profit`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "payouts on request (no gating conditions)";
}

function describeFees(fees: FeeSpec, currency: string): string {
  const parts: string[] = [];
  parts.push(
    fees.billing === "monthly"
      ? `${fmtMoney(fees.price, currency)} per month while evaluating`
      : `${fmtMoney(fees.price, currency)} per attempt (one-time)`,
  );
  if (fees.resetFee !== null) {
    parts.push(`discounted reset ${fmtMoney(fees.resetFee, currency)} after a failed attempt`);
  } else {
    parts.push(
      fees.billing === "monthly"
        ? "no reset fee (failed attempts continue on the subscription)"
        : "no discounted reset (a failed attempt costs full price again)",
    );
  }
  parts.push(
    fees.activationFee > 0
      ? `activation fee ${fmtMoney(fees.activationFee, currency)} when funded`
      : "no activation fee",
  );
  parts.push(fees.refundableOnPass ? "challenge fee refunded once funded" : "challenge fee not refunded");
  return parts.join(" · ");
}

function section(title: string, body: string): string {
  return `${title}\n${body}`;
}

export function renderRulesReport(adapted: AdaptedChallenge, opts?: RenderOptions): string {
  // The adapter emits spec *input*; parsing applies the schema defaults the
  // engine would apply, so the view describes exactly what gets simulated.
  const spec = ChallengeSpecSchema.parse(adapted.spec);
  const { accountSize, currency } = spec;
  const blocks: string[] = [];

  blocks.push(
    `${bold(`${adapted.firmName} · ${adapted.challengeName}`, opts)}\n` +
      `${adapted.propfirmId}/${adapted.challengeId} · ${adapted.productType} · account ${fmtMoney(accountSize, currency)} · live LuxAlgo directory`,
  );

  blocks.push(
    section(
      "Provenance",
      wrap(
        describeProvenance(adapted.provenance, adapted.inferredFields) +
          (adapted.provenance === "directory+inferred"
            ? ". Inference only happens when the disclosed rule text has one reasonable reading; ambiguous rows are refused instead."
            : "."),
        98,
        "  ",
      ),
    ),
  );

  const stepLines = spec.steps.map((step, i) => {
    const parts: string[] = [];
    const amount =
      step.profitTargetPct !== undefined
        ? (accountSize * step.profitTargetPct) / 100
        : step.profitTargetAmount;
    parts.push(`target ${stepTarget(step, currency)} (${fmtMoney(amount ?? null, currency)})`);
    parts.push(
      step.minTradingDays > 0 ? `min ${step.minTradingDays} trading days` : "no minimum trading days",
    );
    parts.push(step.maxDays !== null ? `${step.maxDays}-trading-day time limit` : "no time limit");
    if (step.dailyLoss === null) parts.push("daily loss: none in this step");
    else if (step.dailyLoss !== undefined)
      parts.push(`daily loss override: ${describeDailyLoss(step.dailyLoss, accountSize, currency)}`);
    if (step.maxLoss !== undefined)
      parts.push(`max loss override: ${describeMaxLoss(step.maxLoss, accountSize, currency)}`);
    if (step.consistency != null)
      parts.push(
        `consistency: best day ≤ ${fmtNum(step.consistency.maxBestDayProfitPct, 2)}% of total profit (simulated)`,
      );
    return wrap(`${i + 1}. ${parts.join(" · ")}`, 98, "  ");
  });
  blocks.push(section(`Steps (${spec.steps.length})`, stepLines.join("\n")));

  blocks.push(
    section(
      "Daily loss (every step unless overridden)",
      spec.dailyLoss === null
        ? "  none"
        : wrap(describeDailyLoss(spec.dailyLoss, accountSize, currency), 98, "  "),
    ),
  );
  blocks.push(section("Max loss", wrap(describeMaxLoss(spec.maxLoss, accountSize, currency), 98, "  ")));
  blocks.push(section("Fees", wrap(describeFees(spec.fees, currency), 98, "  ")));

  const funded = spec.funded;
  const fundedLines: string[] = [];
  fundedLines.push(
    wrap(
      `profit split ${fmtNum(funded.profitSplitPct, 1)}% to the trader · payouts ${funded.payoutFrequency}` +
        (funded.firstPayoutMinDays > 0
          ? ` · first payout after ≥ ${funded.firstPayoutMinDays} days`
          : " · no minimum before the first payout"),
      98,
      "  ",
    ),
  );
  fundedLines.push(
    wrap(
      `daily loss: ${
        funded.dailyLoss === undefined
          ? "inherited from the challenge rule"
          : funded.dailyLoss === null
            ? "none"
            : describeDailyLoss(funded.dailyLoss, accountSize, currency)
      }`,
      98,
      "  ",
    ),
  );
  fundedLines.push(
    wrap(
      `max loss: ${
        funded.maxLoss === undefined
          ? "inherited from the challenge rule"
          : describeMaxLoss(funded.maxLoss, accountSize, currency)
      }`,
      98,
      "  ",
    ),
  );
  if (funded.payoutRules !== undefined) {
    fundedLines.push(
      wrap(`payout gating (simulated): ${describePayoutRules(funded.payoutRules, currency)}`, 98, "  "),
    );
  }
  if (funded.notes !== undefined) fundedLines.push(wrap(`notes: ${funded.notes}`, 98, "  "));
  blocks.push(section("Funded stage", fundedLines.join("\n")));

  const constraints = spec.constraints;
  if (constraints !== undefined) {
    const entries = Object.entries(constraints).filter(([, v]) => v !== undefined);
    if (entries.length > 0) {
      blocks.push(
        section(
          "Constraints (recorded, NOT simulated)",
          entries.map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join("\n"),
        ),
      );
    }
  }

  if (spec.flagsNotSimulated.length > 0) {
    blocks.push(
      section(
        "Declared but NOT simulated: treat simulated pass rates as optimistic",
        spec.flagsNotSimulated.map((id) => `  • ${id}`).join("\n"),
      ),
    );
  }

  const sources = spec.sources ?? [];
  blocks.push(
    section(
      "Sources (the firm's own page is always authoritative)",
      sources.length > 0
        ? sources
            .map((s) =>
              bulleted(`${s.url} · verified ${s.lastVerified}${s.note !== undefined ? `. ${s.note}` : ""}`),
            )
            .join("\n")
        : "  none served by the directory for this challenge; check the firm's own site directly",
    ),
  );

  blocks.push(dim(wrap(DISCLAIMER, 98), opts));
  return blocks.join("\n\n");
}

/* ------------------------------------------------------------------ */
/* simulate                                                           */
/* ------------------------------------------------------------------ */

/** Where the trader series came from when --trade-log files were given. */
export interface TradeLogRenderInfo {
  files: readonly string[];
  /** Trades in the simulated series (news-avoided when --avoid-news is set). */
  trades: number;
  distinctDays: number;
  historyCount: number;
  /** Trades/day derived from timestamps; null when --trades-per-day was given. */
  derivedTradesPerDay: number | null;
}

export interface SimulateRenderContext extends RenderOptions {
  /** Short target label for the header, e.g. "ftmo/100k-2step" or a file path. */
  ref?: string;
  firmName?: string;
  /** Set when the spec came from the live directory; adds the data line. */
  provenance?: DirectoryProvenance;
  inferredFields?: readonly string[];
  /** Set when the trader came from --trade-log files; adds the source line. */
  tradeLog?: TradeLogRenderInfo;
  /** Portfolio overlap report; always rendered when 2+ logs were merged. */
  overlap?: OverlapReport;
  /** News comparison context; the rendered result is the news-avoided run. */
  news?: { original: SimResult; filter: NewsFilterResult };
}

export function renderSimulateReport(result: SimResult, ctx: SimulateRenderContext = {}): string {
  const spec = result.assumptions.spec;
  const options = result.assumptions.options;
  const currency = spec.currency;
  const { perAttempt, journey, funded, ev, drawdown } = result;

  const titleParts = [ctx.firmName, spec.name].filter((p): p is string => p !== undefined);
  const headerBits = [
    ctx.ref,
    spec.productType,
    `account ${fmtMoney(spec.accountSize, currency)}`,
    feeBrief(spec.fees, currency),
  ]
    .filter((p): p is string => p !== undefined)
    .join(" · ");

  const entries: ReportEntry[] = [];
  entries.push(bold(titleParts.join(" · "), ctx));
  entries.push(headerBits);
  if (ctx.provenance !== undefined) {
    entries.push(directoryDataLine(ctx.provenance, ctx.inferredFields ?? []));
  }
  entries.push(`Trader: ${describeProfile(result.assumptions.profile, currency)}`);
  if (ctx.tradeLog !== undefined) {
    const log = ctx.tradeLog;
    const source =
      log.historyCount > 1
        ? `${log.historyCount} logs merged: ${log.files.join(", ")}`
        : (log.files[0] ?? "");
    entries.push(
      wrap(
        `Trade log: ${source} · ${log.trades} trades over ${log.distinctDays} days · ` +
          (log.derivedTradesPerDay !== null
            ? `trades/day ${fmtNum(log.derivedTradesPerDay, 2)} derived from timestamps`
            : "trades/day from --trades-per-day"),
        98,
      ),
    );
  }
  entries.push(
    `Run: ${fmtInt(options.paths)} paths · seed ${String(options.seed)} · attempt cap ${options.attemptCap} · engine ${result.engineVersion}`,
  );
  entries.push("");

  entries.push({
    label: "Pass probability per attempt",
    value: `${fmtPct(perAttempt.passProbability)} (${fmtCi(perAttempt.passProbabilityCi)})`,
  });
  for (const step of perAttempt.steps) {
    const specStep = spec.steps[step.index];
    const label = `  Step ${step.index + 1} · target ${specStep ? stepTarget(specStep, currency) : "?"}`;
    if (step.reached === 0) {
      entries.push({ label, value: "never reached" });
      continue;
    }
    const fails = FAIL_REASONS.filter((reason) => step.failureBreakdown[reason] > 0)
      .map((reason) => `${reason} ${fmtPct(step.failureBreakdown[reason] / step.reached)}`)
      .join(", ");
    entries.push({
      label,
      value:
        `${fmtPct(step.passProbability)} (${fmtCi(step.passProbabilityCi)})` +
        (fails.length > 0 ? ` · fails: ${fails}` : ""),
    });
  }
  entries.push({
    label: "Avg days per attempt",
    value: `${fmtNum(perAttempt.avgDaysWhenPassed, 1)} when passed · ${fmtNum(perAttempt.avgDaysWhenFailed, 1)} when failed`,
  });
  entries.push("");

  entries.push({
    label: `Funded within ${journey.attemptCap} attempts`,
    value: `${fmtPct(journey.fundedProbability)} (${fmtCi(journey.fundedProbabilityCi)})`,
  });
  entries.push({
    label: "Attempts until funded",
    value: distLine(journey.attempts, null, [
      ["mean", "mean"],
      ["p50", "p50"],
      ["p90", "p90"],
    ]),
  });
  entries.push({
    label: "Total cost",
    value: distLine(journey.cost, currency, [
      ["mean", "mean"],
      ["p50", "p50"],
      ["p90", "p90"],
      ["p95", "p95"],
    ]),
  });
  entries.push({
    label: "Cost when funded",
    value:
      journey.costGivenFunded === null
        ? "n/a: no path got funded"
        : distLine(journey.costGivenFunded, currency, [
            ["mean", "mean"],
            ["p50", "p50"],
            ["p90", "p90"],
          ]),
  });
  entries.push({
    label: "Days to funded (trading days)",
    value:
      journey.daysToFunded === null
        ? "n/a: no path got funded within the attempt cap"
        : distLine(journey.daysToFunded, null, [
            ["p50", "p50"],
            ["p75", "p75"],
            ["p90", "p90"],
          ]),
  });
  entries.push({
    label: "Stagnation (days without a new equity high)",
    value: distLine(perAttempt.stagnationDays, null, [
      ["p50", "p50"],
      ["p90", "p90"],
    ]),
  });
  entries.push("");

  entries.push(
    funded === null
      ? "EV · challenge journey only (funded stage not simulated; EV counts fees minus refunds)"
      : `EV · challenge journey + funded horizon of ${funded.horizonTradingDays} trading days`,
  );
  entries.push({
    label: "  EV total",
    value: `${fmtMoney(ev.evTotal, currency, { sign: true })} ± ${fmtMoney(1.96 * ev.evStandardError, currency)} (95% CI)`,
  });
  entries.push({ label: "  P(EV > 0)", value: fmtPct(ev.pPositive) });
  if (funded !== null) {
    entries.push({
      label: "  Payout if funded",
      value:
        funded.payoutTotalGivenFunded === null
          ? "n/a: no path got funded"
          : `${distLine(funded.payoutTotalGivenFunded, currency, [
              ["mean", "mean"],
              ["p50", "p50"],
            ])} · avg ${fmtNum(funded.avgPayoutEvents, 1)} payout events`,
    });
    entries.push({
      label: "  Payout probability | funded",
      value: fmtPct(funded.payoutProbability),
    });
    entries.push({
      label: "  Days to 1st payout",
      value:
        funded.daysToFirstPayout === null
          ? "n/a: no simulated path collected a payout"
          : distLine(funded.daysToFirstPayout, null, [
              ["p50", "p50"],
              ["p90", "p90"],
            ]),
    });
    entries.push({
      label: "  Funded accounts blown",
      value: `${fmtPct(funded.blownProbability)} within the horizon`,
    });
  }
  entries.push({
    label: "Max drawdown while evaluating",
    value: `p50 ${fmtNum(drawdown.maxDrawdownPct.p50, 1)}% · p95 ${fmtNum(drawdown.maxDrawdownPct.p95, 1)}% of initial balance`,
  });
  entries.push("");

  const extraBlocks: string[] = [];
  if (ctx.overlap !== undefined) extraBlocks.push(renderOverlapSection(ctx.overlap, ctx));
  if (ctx.news !== undefined) {
    extraBlocks.push(renderNewsSection(result, ctx.news.original, ctx.news.filter, ctx));
  }

  return (
    renderAligned(entries) +
    "\n" +
    (extraBlocks.length > 0 ? `${extraBlocks.join("\n\n")}\n\n` : "") +
    renderAssumptionsAndDisclaimer(result.assumptions.flags, result.assumptions.disclaimer, ctx)
  );
}

/* ------------------------------------------------------------------ */
/* trade-log extras: portfolio overlap + news comparison              */
/* ------------------------------------------------------------------ */

/**
 * Compact audit-risk block for the simulate report. A "high" band is the one
 * verdict a user must not scroll past, so it gets the loud treatment.
 */
export function renderOverlapSection(report: OverlapReport, opts?: RenderOptions): string {
  const lines: string[] = [];
  if (report.auditRisk === "high") {
    lines.push(bold(`Multi-account overlap · AUDIT RISK: HIGH`, opts));
    lines.push(bold("  Warning: the firm may audit or refuse payouts for correlated accounts.", opts));
  } else {
    lines.push(`Multi-account overlap · audit risk: ${report.auditRisk.toUpperCase()}`);
  }
  lines.push(wrap(report.verdict, 98, "  "));
  lines.push(
    wrap(
      `Overall overlap ${fmtPct(report.overallOverlapShare)} · same direction ${fmtPct(report.sameDirectionShare)} · ` +
        `direction unknown ${fmtPct(report.unknownDirectionShare)} · tolerance ±${fmtNum(report.toleranceMinutes, 0)} min`,
      98,
      "  ",
    ),
  );
  lines.push(dim(wrap(report.disclosure, 98, "  "), opts));
  return lines.join("\n");
}

/**
 * Compact with/without-news comparison. The surrounding report shows the
 * news-avoided run; this block carries the original numbers, the delta, and
 * the mandatory calendar caveat.
 */
function renderNewsSection(
  avoided: SimResult,
  original: SimResult,
  filter: NewsFilterResult,
  opts?: RenderOptions,
): string {
  const currency = avoided.assumptions.spec.currency;
  const windowOptions = filter.options;
  const deltaPts = (avoided.perAttempt.passProbability - original.perAttempt.passProbability) * 100;
  const lines: string[] = [];
  lines.push(bold("News avoidance (this report simulates the news-avoided history)", opts));
  lines.push(
    wrap(
      `Windows: ${windowOptions.preMinutes} min before / ${windowOptions.postMinutes} min after · ` +
        `impacts: ${windowOptions.impacts.join(", ")} · currencies: ${windowOptions.currencies.join(", ")}`,
      98,
      "  ",
    ),
  );
  lines.push(
    `  Pass/attempt: original ${fmtPct(original.perAttempt.passProbability)} vs news-avoided ` +
      `${fmtPct(avoided.perAttempt.passProbability)} (${deltaPts >= 0 ? "+" : ""}${deltaPts.toFixed(1)} pts)`,
  );
  lines.push(
    `  EV: original ${fmtMoney(original.ev.evTotal, currency, { sign: true })} vs news-avoided ` +
      `${fmtMoney(avoided.ev.evTotal, currency, { sign: true })}`,
  );
  lines.push(
    `  Excluded trades: ${filter.excluded.length} opened inside a window · held through an event: ` +
      `${filter.heldThroughCount} · calendar events matched: ${filter.eventsInRange}`,
  );
  lines.push(dim(wrap(filter.caveat, 98, "  "), opts));
  return lines.join("\n");
}

export interface OverlapRenderContext extends RenderOptions {
  /** The trade-log files, in the order they were given. */
  files: readonly string[];
  /** Trades per file, parallel to `files`. */
  tradeCounts: readonly number[];
}

/** Full standalone view for the `overlap` command. No simulation involved. */
export function renderOverlapReport(report: OverlapReport, ctx: OverlapRenderContext): string {
  const totalTrades = ctx.tradeCounts.reduce((acc, count) => acc + count, 0);
  const blocks: string[] = [];

  blocks.push(
    `${bold("Multi-account position overlap", ctx)}\n` +
      `${ctx.files.length} histories · ${totalTrades} trades · tolerance ±${fmtNum(report.toleranceMinutes, 0)} min around each position`,
  );
  blocks.push(
    section(
      "Histories",
      ctx.files.map((file, i) => `  ${i + 1}. ${file} (${ctx.tradeCounts[i]} trades)`).join("\n"),
    ),
  );
  blocks.push(
    renderTable(
      [
        { header: "PAIR" },
        { header: "OVERLAP A", align: "right" },
        { header: "OVERLAP B", align: "right" },
        { header: "SAME-DIR", align: "right" },
        { header: "DIR-UNKNOWN", align: "right" },
      ],
      report.pairs.map((pair) => [
        `${pair.a + 1}x${pair.b + 1}`,
        `${pair.overlappingA}/${ctx.tradeCounts[pair.a]} (${fmtPct(pair.shareA)})`,
        `${pair.overlappingB}/${ctx.tradeCounts[pair.b]} (${fmtPct(pair.shareB)})`,
        String(pair.sameDirection),
        String(pair.directionUnknown),
      ]),
    ),
  );
  blocks.push(renderOverlapSection(report, ctx));
  if (report.unknownDirectionShare > 0) {
    blocks.push(
      wrap(
        `${fmtPct(report.unknownDirectionShare)} of trades carry no direction column, so their overlaps ` +
          "could only be counted as direction-unknown. Add a direction/side column (long/short or " +
          "buy/sell) to measure same-direction overlap, the signal firms actually look for.",
        98,
      ),
    );
  }
  return blocks.join("\n\n");
}

/* ------------------------------------------------------------------ */
/* optimal-risk                                                       */
/* ------------------------------------------------------------------ */

export interface OptimalRiskRenderContext extends RenderOptions {
  ref?: string;
  firmName?: string;
  /** Set when the spec came from the live directory; adds the data line. */
  provenance?: DirectoryProvenance;
  inferredFields?: readonly string[];
  grid: { min: number; max: number; step: number };
}

function riskLabel(value: number, mode: RiskSizing["mode"], currency: string): string {
  return mode === "fixed-amount" ? fmtMoney(value, currency) : `${fmtNum(value, 2)}%`;
}

/**
 * `reference` is a full simulate() run at the EV-maximizing risk - it supplies
 * the spec/profile context and the assumption flags for the mandatory footer.
 */
export function renderOptimalRiskReport(
  sweep: OptimalRiskResult,
  reference: SimResult,
  ctx: OptimalRiskRenderContext,
): string {
  const spec = reference.assumptions.spec;
  const currency = spec.currency;
  const mode = reference.assumptions.profile.risk.mode;
  const options = reference.assumptions.options;

  const title = [ctx.firmName, spec.name].filter((p): p is string => p !== undefined).join(" · ");
  const head =
    `${bold(`Risk sweep · ${title}`, ctx)}\n` +
    [ctx.ref, `account ${fmtMoney(spec.accountSize, currency)}`, feeBrief(spec.fees, currency)]
      .filter((p): p is string => p !== undefined)
      .join(" · ") +
    (ctx.provenance !== undefined ? `\n${directoryDataLine(ctx.provenance, ctx.inferredFields ?? [])}` : "") +
    `\nTrader: ${describeProfile(reference.assumptions.profile, currency, { includeRisk: false })}` +
    `\nRun: ${fmtInt(options.paths)} paths per grid point · seed ${String(options.seed)} · risk mode ${mode} · ` +
    `grid ${riskLabel(ctx.grid.min, mode, currency)} → ${riskLabel(ctx.grid.max, mode, currency)} by ${riskLabel(ctx.grid.step, mode, currency)}`;

  const table = renderTable(
    [
      { header: "RISK", align: "right" },
      { header: "PASS/ATTEMPT", align: "right" },
      { header: "EV", align: "right" },
      { header: "P(EV>0)", align: "right" },
    ],
    sweep.points.map((p) => [
      riskLabel(p.risk, mode, currency),
      fmtPct(p.perAttemptPassProbability),
      fmtMoney(p.evTotal, currency, { sign: true }),
      fmtPct(p.pEvPositive),
    ]),
  );

  const callouts: string[] = [];
  callouts.push(
    `Pass probability is maximized at ${riskLabel(sweep.bestByPassProbability.risk, mode, currency)} ` +
      `(${fmtPct(sweep.bestByPassProbability.perAttemptPassProbability)} per attempt).`,
  );
  callouts.push(
    `EV is maximized at ${riskLabel(sweep.bestByEv.risk, mode, currency)} ` +
      `(${fmtMoney(sweep.bestByEv.evTotal, currency, { sign: true })}).`,
  );
  if (sweep.diverges) {
    callouts.push(
      wrap(
        "They diverge, and that divergence is the point: the risk that maximizes your chance of passing " +
          "is not the risk that maximizes expected value, so pick your sizing by which objective you are " +
          "actually optimizing.",
        98,
      ),
    );
  }

  return (
    `${head}\n\n${table}\n\n${callouts.join("\n")}\n\n` +
    renderAssumptionsAndDisclaimer(reference.assumptions.flags, reference.assumptions.disclaimer, ctx)
  );
}

/* ------------------------------------------------------------------ */
/* compare                                                            */
/* ------------------------------------------------------------------ */

export interface CompareProvenanceNote {
  /** The reference the note belongs to, e.g. "ftmo/100k-2step". */
  ref: string;
  provenance: DirectoryProvenance;
  inferredFields: readonly string[];
}

export interface CompareRenderContext extends RenderOptions {
  /** One note per directory-sourced entry, shown under the header. */
  provenance?: readonly CompareProvenanceNote[];
}

export function renderCompareReport(comparison: CompareResult, ctx: CompareRenderContext = {}): string {
  const { rows, results } = comparison;
  const first = results[0];
  if (first === undefined) return dim(wrap(DISCLAIMER, 98), ctx);
  const options = first.assumptions.options;

  const provenanceLines =
    ctx.provenance !== undefined && ctx.provenance.length > 0
      ? "\nData: live LuxAlgo directory, each firm's own pages are authoritative:\n" +
        ctx.provenance
          .map((note) =>
            wrap(`${note.ref}: ${describeProvenance(note.provenance, note.inferredFields)}`, 98, "  "),
          )
          .join("\n")
      : "";

  const head =
    `${bold("Sorted by EV for your inputs, not a ranking.", ctx)}\n` +
    `Trader: ${describeProfile(first.assumptions.profile, first.assumptions.spec.currency)}\n` +
    `Run: ${fmtInt(options.paths)} paths each · seed ${String(options.seed)} · attempt cap ${options.attemptCap} · ` +
    `funded horizon ${options.fundedHorizonDays} trading days` +
    provenanceLines;

  const table = renderTable(
    [
      { header: "FIRM" },
      { header: "CHALLENGE" },
      { header: "PASS/ATTEMPT", align: "right" },
      { header: "ATTEMPTS", align: "right" },
      { header: "COST", align: "right" },
      { header: "EV", align: "right" },
      { header: "P(EV>0)", align: "right" },
      { header: "PAYOUT%", align: "right" },
      { header: "DAYS", align: "right" },
      { header: "FLAGS" },
    ],
    rows.map((row, i) => {
      const currency = results[i]?.assumptions.spec.currency ?? "USD";
      return [
        row.firmId ?? "-",
        row.challengeId,
        fmtPct(row.perAttemptPassProbability),
        fmtNum(row.expectedAttempts, 1),
        fmtMoney(row.expectedCost, currency),
        fmtMoney(row.evTotal, currency, { sign: true }),
        fmtPct(row.pEvPositive),
        fmtPct(results[i]?.funded?.payoutProbability),
        row.daysToFundedP50 === null ? "n/a" : fmtNum(row.daysToFundedP50, 0),
        row.flagsNotSimulated.length > 0 ? row.flagsNotSimulated.join(",") : "-",
      ];
    }),
  );

  // Union of assumption flags across all compared challenges, deduped by id.
  const flagById = new Map<string, AssumptionFlag>();
  for (const result of results) {
    for (const flag of result.assumptions.flags) {
      if (!flagById.has(flag.id)) flagById.set(flag.id, flag);
    }
  }

  const legend = wrap(
    "PASS/ATTEMPT per single attempt · ATTEMPTS mean until funded (capped) · COST mean total fees · " +
      "PAYOUT% chance of at least one payout once funded · DAYS p50 trading days to funded · " +
      "FLAGS rules the ruleset declares but the engine does not simulate.",
    98,
  );

  return (
    `${head}\n\n${table}\n\n${dim(legend, ctx)}\n\n` +
    renderAssumptionsAndDisclaimer([...flagById.values()], first.assumptions.disclaimer, ctx)
  );
}
