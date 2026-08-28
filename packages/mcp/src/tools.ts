/*
  Pure tool implementations: local zod (v3) input schemas + transport-free
  handlers that return MCP-shaped results. server.ts wires these onto an
  McpServer; tests call the handlers directly.

  IMPORTANT version note: this package's zod is v3.25 (what the MCP SDK
  expects); the core package internally uses zod v4. Core's schemas are NEVER
  passed to the SDK - every tool input schema below is defined locally, and
  handlers pass plain parsed objects into core, which re-validates everything
  itself. The local challenge-spec mirror is deliberately permissive
  (passthrough objects, engine defaults not duplicated) so core stays the
  single source of validation truth.
*/

import { z } from "zod";
import {
  DISCLAIMER,
  ENGINE_VERSION,
  analyzeOverlap,
  compare,
  filterTradesAroundNews,
  mergeTradeLogs,
  optimalRisk,
  parseRSeries,
  importTradeHistory,
  toTradeLogEntries,
  type RiskSpec,
  simulate,
  toBootstrapInputs,
  type AssumptionFlag,
  type ChallengeSpecInput,
  type CompareEntry,
  type NewsFilterResult,
  type OverlapReport,
  type SimOptionsInput,
  type SimResult,
  type TradeLogEntry,
  type TraderProfileInput,
} from "@luxalgo/prop-firm-sim-core";
import { adaptFirm } from "@luxalgo/prop-firm-sim-core/directory";
import { fetchDirectory, resolveFirm } from "./directory.js";

/* ------------------------------------------------------------------------ *
 * Result plumbing
 * ------------------------------------------------------------------------ */

export interface ToolTextContent {
  type: "text";
  text: string;
}

/** Subset of the MCP CallToolResult shape that every handler returns. */
export interface ToolResult {
  content: ToolTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** zod v3 raw shape, owned by this package - never core's zod v4 schemas. */
  inputShape: Record<string, z.ZodTypeAny>;
  handler: (input: unknown) => Promise<ToolResult>;
}

function ok(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Format any thrown value, including zod errors from either zod version. */
function formatError(err: unknown): string {
  if (typeof err === "object" && err !== null && "issues" in err) {
    const issues = (err as { issues: unknown }).issues;
    if (Array.isArray(issues)) {
      const lines = issues.map((issue) => {
        const path = Array.isArray((issue as { path?: unknown }).path)
          ? ((issue as { path: unknown[] }).path.join(".") as string)
          : "";
        const message = String((issue as { message?: unknown }).message ?? "invalid value");
        return path === "" ? message : `${path}: ${message}`;
      });
      return `Invalid input: ${lines.join("; ")}`;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

async function safely(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return toolError(formatError(err));
  }
}

function parseInput<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw parsed.error;
  return parsed.data as z.infer<S>;
}

/* ------------------------------------------------------------------------ *
 * Shared description blocks - descriptions are the product for MCP
 * ------------------------------------------------------------------------ */

const UNITS_DOC =
  "UNITS: every *Pct rule field and every percent-mode risk value is in PERCENT UNITS (5 = 5%, 0.5 = 0.5%). " +
  "The one exception is winRate, which is a FRACTION in [0, 1] (0.55 = 55% winners). " +
  "Probabilities in results are fractions in [0, 1].";

const SEED_DOC =
  "DETERMINISM: identical inputs including `seed` reproduce byte-identical results on any platform. " +
  "Include the seed and path count when reporting numbers so users can reproduce them exactly; " +
  "re-run with a few different seeds to gauge Monte Carlo spread.";

const ASSUMPTIONS_DOC =
  "ASSUMPTIONS: every result carries assumptions.flags - dataset-declared rules the engine does NOT " +
  "simulate (e.g. scaling plans or soft daily lockouts, which make real odds worse than simulated) plus " +
  "engine simplifications - and assumptions.disclaimer. These are material: always surface the flags and " +
  "the disclaimer to the user alongside the numbers, never just the headline probability. Results are " +
  "distributions under stated assumptions, not promises.";

const SIMULATED_RULES_DOC =
  "SIMULATED RULES (engine v1): consistency rules (steps[].consistency) and funded payout gating " +
  "(funded.payoutRules) are actually SIMULATED, not merely flagged - a distinguishing feature of this " +
  "engine. Consistency uses a rational stop rule (the trader stops a day once more profit cannot help " +
  "and keeps trading until the best-day share complies - flag 'consistency-stop-rule'); payouts follow " +
  "a maximum-withdrawal model (withdraw everything the rules allow above buffer/caps, never below the " +
  "loss floor; balances and floors carry across payouts - flag 'funded-withdrawal-model'); a funded " +
  "consistency gate is checked per payout window (flag 'funded-consistency-window-approximated'). The " +
  "pre-1.0 flag id 'funded-payout-resets-account' no longer exists.";

const SPEC_CHOICE_DOC =
  "Identify the challenge EITHER by directory reference (firmId + challengeId, discovered via " +
  "list_firms; firmId accepts the directory id or the firm's name) OR by a full inline `spec` object - " +
  "the exact shape get_challenge_rules returns, so you can fetch a directory entry, change one rule, " +
  "and re-simulate to model rule variations. Provide exactly one of the two forms; providing both or " +
  "neither is an error. Directory references need network access; inline specs are fully offline.";

const PROVENANCE_DOC =
  "DATA SOURCE & PROVENANCE: firm data comes live from LuxAlgo's public, keyless prop-firm directory " +
  "API - the data behind luxalgo.com/prop-firms (origin overridable via the LUXALGO_APP_ORIGIN env " +
  "var). Rule semantics are used verbatim where the directory serves structured rule columns; where it " +
  "serves only free text, semantics are inferred ONLY when one reasonable reading exists, and every " +
  "inferred field is disclosed in `inferredFields` (provenance 'directory+inferred') - relay those to " +
  "the user next to any numbers. Challenges whose loss rules cannot be established are refused as not " +
  "simulatable rather than guessed. Firms change rules; each firm's own page is always authoritative.";

const COMPOSITION_DOC =
  "Composes with any broker-statistics tool: if another MCP server exposes round-trip statistics " +
  "(winRate, avgWin, avgLoss) or a raw R-multiple series from the user's real trades, feed them here to " +
  'answer "given my actual trading, what are my odds on this challenge and what risk should I use?". ' +
  "Convert currency statistics to R-multiples by dividing by the average amount risked per trade: " +
  "winRate stays a fraction, avgWinR = avgWin / avgRisk, avgLossR = |avgLoss| / avgRisk.";

const MAX_LOSS_MODE_DOC =
  "How the max-loss floor behaves - the single most consequential rule difference between firms. " +
  "'static-initial': floor fixed at initial balance minus the limit; never moves (classic CFD two-step). " +
  "'trailing-realized-eod': floor ratchets up with end-of-day balance highs; intraday highs do not move " +
  "it. 'trailing-intraday-unrealized': floor trails the peak unrealized equity intraday and never stops " +
  "trailing (futures-style; the most-miscalculated rule in the industry: it cuts pass probability " +
  "dramatically). 'trailing-locks-at-initial': trails intraday peak equity until the floor reaches the " +
  "initial balance, then freezes (common futures variant). Locking is also composable: locksAtInitial " +
  "adds the same lock to an EOD trail, and lockOffsetAmount shifts the lock level to initial balance + " +
  "that amount (e.g. 100 models 'stops trailing $100 above the start').";

/* ------------------------------------------------------------------------ *
 * Local zod v3 input schemas
 * ------------------------------------------------------------------------ */

const productTypeSchema = z
  .enum(["futures", "cfd", "equities"])
  .describe("Instrument class the challenge is traded on: 'futures', 'cfd' (forex/CFD), or 'equities'.");

/*
  The daily-loss and max-loss rule schemas appear at several places inside a
  ChallengeSpec (challenge level, per step, funded stage). They are factories
  returning fresh instances so the SDK's JSON-schema conversion inlines every
  occurrence instead of emitting internal $refs, which some MCP clients
  flatten poorly - the enums and unit notes must be visible at every site.
*/
const makeDailyLossRuleSchema = () =>
  z
    .object({
      pct: z
        .number()
        .positive()
        .max(100)
        .optional()
        .describe(
          "Daily loss limit in PERCENT UNITS (5 = 5%); what it is a percent OF is set by limitBasis. " +
            "Exactly one of pct/amount.",
        ),
      amount: z
        .number()
        .positive()
        .optional()
        .describe("Daily loss limit as a fixed currency amount (alternative to pct)."),
      basis: z
        .enum(["prior-day-balance", "prior-day-equity"])
        .optional()
        .describe(
          "Anchor today's loss is measured from: prior day's closing balance or closing equity " +
            "(they differ only with overnight positions). Default 'prior-day-balance'.",
        ),
      limitBasis: z
        .enum(["initial-balance", "anchor"])
        .optional()
        .describe(
          "What a percentage limit is a percent OF. 'initial-balance': a fixed currency allowance " +
            "(always e.g. 5% of the starting account). 'anchor': recomputed daily from the day's anchor. " +
            "Default 'initial-balance'.",
        ),
      includesOpenPnl: z
        .boolean()
        .optional()
        .describe(
          "Whether floating (unrealized) P&L counts toward the daily loss, i.e. breach can happen " +
            "intra-position. Default true.",
        ),
      evaluation: z
        .enum(["intraday", "end-of-day"])
        .optional()
        .describe(
          "'intraday': fails the moment equity touches the daily floor. 'end-of-day': only the close is " +
            "checked. Default 'intraday'.",
        ),
    })
    .passthrough()
    .describe(
      "Daily loss rule: the daily floor is anchor minus limit, reset at each trading-day boundary. " +
        "Exactly one of pct/amount must be set.",
    );

const makeMaxLossRuleSchema = () =>
  z
    .object({
      pct: z
        .number()
        .positive()
        .max(100)
        .optional()
        .describe(
          "Max loss in PERCENT UNITS of the initial account size (10 = 10%). Exactly one of pct/amount.",
        ),
      amount: z
        .number()
        .positive()
        .optional()
        .describe("Max loss as a fixed currency amount (alternative to pct)."),
      mode: z
        .enum([
          "static-initial",
          "trailing-realized-eod",
          "trailing-intraday-unrealized",
          "trailing-locks-at-initial",
        ])
        .describe(MAX_LOSS_MODE_DOC),
      locksAtInitial: z
        .boolean()
        .optional()
        .describe(
          "For trailing modes: once the trailing floor climbs up to the initial balance (plus " +
            "lockOffsetAmount), it locks there and stops trailing. Default false. " +
            "'trailing-locks-at-initial' locks by definition; set this to add the same lock to " +
            "'trailing-realized-eod' (e.g. an EOD trail that stops at the starting balance).",
        ),
      lockOffsetAmount: z
        .number()
        .min(0)
        .optional()
        .describe(
          "Currency offset of the lock level: the floor locks at initial balance + this amount, " +
            "modeling rules like 'the trailing threshold stops $100 above the start'. Default 0. Only " +
            "meaningful when the rule locks (mode 'trailing-locks-at-initial' or locksAtInitial=true).",
        ),
    })
    .passthrough()
    .describe("Max (overall) loss rule. `mode` decides whether and how the floor trails the account's peak.");

const stepSchema = z
  .object({
    profitTargetPct: z
      .number()
      .positive()
      .optional()
      .describe(
        "Profit target in PERCENT UNITS of the initial account size (8 = 8%). " +
          "Exactly one of profitTargetPct/profitTargetAmount.",
      ),
    profitTargetAmount: z
      .number()
      .positive()
      .optional()
      .describe("Profit target as a fixed currency amount (alternative to profitTargetPct)."),
    minTradingDays: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Minimum days with at least one trade before the step can be passed. Default 0."),
    maxDays: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe("Trading-day limit for the step; null (the default) = unlimited time."),
    dailyLoss: makeDailyLossRuleSchema()
      .nullable()
      .optional()
      .describe(
        "Per-step override of the challenge-level daily loss rule. Omit to inherit; " +
          "null = no daily loss rule in this step.",
      ),
    maxLoss: makeMaxLossRuleSchema()
      .optional()
      .describe("Per-step override of the challenge-level max loss rule. Omit to inherit."),
    consistency: z
      .object({
        maxBestDayProfitPct: z
          .number()
          .positive()
          .max(100)
          .describe(
            "Maximum share of the step's total profit the best single day may contribute, in PERCENT " +
              "UNITS (40 = the best day may be at most 40% of total profit).",
          ),
      })
      .passthrough()
      .nullable()
      .optional()
      .describe(
        "Consistency rule - SIMULATED (engine v1), not just flagged: one outsized day effectively " +
          "raises the target (total profit must reach best day / pct), and the simulated trader keeps " +
          "trading - rationally stopping days early when that helps - until the best-day share " +
          "complies (see flag 'consistency-stop-rule'). null or omitted = no consistency rule.",
      ),
  })
  .passthrough()
  .describe("One evaluation step. Each step starts on a fresh account at the initial balance.");

const feesSchema = z
  .object({
    price: z
      .number()
      .min(0)
      .describe("Challenge price in account currency. Under 'monthly' billing: price per month."),
    billing: z
      .enum(["one-time", "monthly"])
      .optional()
      .describe(
        "'one-time' (default): the price buys one attempt; failed attempts are re-bought or reset. " +
          "'monthly': recurring subscription while evaluating (common for futures firms).",
      ),
    resetFee: z
      .number()
      .min(0)
      .nullable()
      .optional()
      .describe(
        "Discounted fee to reset a failed attempt. null (default) = no reset offer: a failed one-time " +
          "attempt costs full price again; a failed monthly attempt rides on the subscription.",
      ),
    activationFee: z
      .number()
      .min(0)
      .optional()
      .describe("One-time fee charged when the funded account is activated. Default 0."),
    refundableOnPass: z
      .boolean()
      .optional()
      .describe(
        "Whether the one-time challenge fee is refunded once funded (credited back in cost/EV). " +
          "Default false.",
      ),
  })
  .passthrough()
  .describe("Fees - everything that goes into expected total cost.");

const fundedTermsSchema = z
  .object({
    profitSplitPct: z
      .number()
      .min(0)
      .max(100)
      .describe("Trader's share of funded profits in PERCENT UNITS (80 = 80%)."),
    payoutFrequency: z
      .enum(["weekly", "biweekly", "monthly", "on-demand"])
      .describe("How often funded profits can be withdrawn."),
    firstPayoutMinDays: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Minimum days on the funded account before the first payout. Default 0."),
    dailyLoss: makeDailyLossRuleSchema()
      .nullable()
      .optional()
      .describe("Funded-account override of the daily loss rule. Omit to inherit; null = none."),
    maxLoss: makeMaxLossRuleSchema()
      .optional()
      .describe("Funded-account override of the max loss rule. Omit to inherit."),
    payoutRules: z
      .object({
        minWinningDays: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Winning days required in a payout window before a payout can be requested. Default 0."),
        winningDayMinProfit: z
          .number()
          .min(0)
          .optional()
          .describe("Minimum profit for a day to count as a winning day. Default 0 (any positive day)."),
        maxPayoutPctOfProfit: z
          .number()
          .positive()
          .max(100)
          .optional()
          .describe(
            "Cap on each payout in PERCENT UNITS of accrued profit (50 = at most half the profit per " +
              "request). Omit for no percentage cap.",
          ),
        maxPayoutAmount: z
          .number()
          .positive()
          .optional()
          .describe("Absolute currency cap per payout request. Omit for no fixed cap."),
        bufferAmount: z
          .number()
          .min(0)
          .optional()
          .describe(
            "Profit buffer that must remain in the account; only profit above it is withdrawable. " +
              "Default 0.",
          ),
        consistencyMaxBestDayPct: z
          .number()
          .positive()
          .max(100)
          .optional()
          .describe(
            "Funded consistency gate in PERCENT UNITS: the best day may contribute at most this share " +
              "of the payout window's profit. Evaluated per window (see flag " +
              "'funded-consistency-window-approximated').",
          ),
      })
      .passthrough()
      .optional()
      .describe(
        "Payout gating - SIMULATED (engine v1), not just flagged: a payout happens only when these " +
          "conditions are met, and on each eligible payout day the trader withdraws the maximum the " +
          "rules allow (profit above the buffer, under the caps, never below the loss floor); balances " +
          "and loss floors carry across payouts (see flag 'funded-withdrawal-model'). Omit for " +
          "ungated payouts.",
      ),
    notes: z.string().optional().describe("Free-text funded-stage details that are not simulated."),
  })
  .passthrough()
  .describe("Funded-stage terms used for the payout/EV simulation.");

const challengeSpecSchema = z
  .object({
    challengeId: z.string().min(1).describe("Stable kebab-case id for this ruleset, e.g. '100k-2step'."),
    name: z.string().min(1).describe("Display name, e.g. '100K 2-Step'."),
    productType: productTypeSchema.optional(),
    accountSize: z.number().positive().describe("Initial account balance in account currency."),
    currency: z
      .string()
      .optional()
      .describe("ISO currency code all amounts are denominated in. Default USD."),
    steps: z
      .array(stepSchema)
      .min(1)
      .describe("Evaluation steps in order. Passing the last step means funded."),
    dailyLoss: makeDailyLossRuleSchema()
      .nullable()
      .describe(
        "Challenge-level daily loss rule applied to every step unless a step overrides it. " +
          "null = no daily loss rule. This field is required (pass null explicitly for none).",
      ),
    maxLoss: makeMaxLossRuleSchema().describe(
      "Challenge-level max loss rule applied to every step unless a step overrides it. Required.",
    ),
    fees: feesSchema,
    funded: fundedTermsSchema,
    constraints: z
      .record(z.unknown())
      .optional()
      .describe(
        "Informational trading constraints (maxLeverage, newsTrading, weekendHolding, ...). " +
          "Recorded and flagged, never simulated.",
      ),
    flagsNotSimulated: z
      .array(z.string())
      .optional()
      .describe(
        "Honesty channel: ids of rules this entry has that the engine does not simulate " +
          "(e.g. 'scaling-plan', 'soft-daily-lockout'). Surfaced in every result's assumption flags. " +
          "Consistency rules and payout gating do NOT belong here - the engine simulates them.",
      ),
    sources: z
      .array(
        z
          .object({
            url: z.string().describe("Public page documenting the rule."),
            lastVerified: z.string().describe("ISO date the rules were last checked against that page."),
            note: z.string().optional(),
          })
          .passthrough(),
      )
      .optional()
      .describe("Public citations. Optional for inline specs; dataset entries always carry them."),
  })
  .passthrough()
  .describe(
    "A complete, simulatable challenge ruleset (ChallengeSpec) - the exact shape get_challenge_rules " +
      "returns. The engine re-validates it and applies documented defaults. " +
      UNITS_DOC,
  );

/** Fields shared by every tool that targets one challenge (ref XOR inline). */
const specRefFields = {
  firmId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Directory firm id or firm name (e.g. 'ftmo' or 'FTMO'); discover with list_firms. Must be " +
        "paired with challengeId. Mutually exclusive with `spec`.",
    ),
  challengeId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Directory challenge id; discover with list_firms. Must be paired with firmId. " +
        "Mutually exclusive with `spec`.",
    ),
  spec: challengeSpecSchema
    .optional()
    .describe(
      "Inline challenge ruleset, for challenges not in the directory or for what-if rule edits. " +
        "Mutually exclusive with firmId/challengeId. " +
        SPEC_CHOICE_DOC,
    ),
};

const parametricTraderFields = {
  winRate: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Probability a trade is a winner, as a FRACTION in [0, 1] (0.55 = 55% winners) - NOT percent " +
        "units. The most impactful input: traders routinely overestimate it by a few points, which can " +
        "flip EV negative, so prefer measured stats over self-reported ones.",
    ),
  avgWinR: z
    .number()
    .positive()
    .describe(
      "Average winning trade in R-multiples, i.e. multiples of the amount risked per trade " +
        "(1.5 = winners average 1.5x the risk).",
    ),
  avgLossR: z
    .number()
    .positive()
    .optional()
    .describe(
      "Average losing trade in R, as a POSITIVE number. Default 1 (losers lose exactly the risked " +
        "amount, i.e. stops are honored). Raise above 1 to model slippage or blown stops.",
    ),
  winStdR: z
    .number()
    .min(0)
    .optional()
    .describe(
      "Standard deviation of winner sizes in R (0 = every winner is exactly avgWinR). Default 0. " +
        "Adding spread makes streak damage more realistic.",
    ),
  lossStdR: z
    .number()
    .min(0)
    .optional()
    .describe("Standard deviation of loser sizes in R (0 = every loser is exactly avgLossR). Default 0."),
  tradesPerDay: z
    .number()
    .positive()
    .describe(
      "Average trades per simulated trading day. More trades per day means more ways to hit the daily " +
        "loss limit within a single day.",
    ),
  tradesPerDayModel: z
    .enum(["fixed", "poisson"])
    .optional()
    .describe(
      "'fixed' (default): the same count every day. 'poisson': daily count drawn Poisson(tradesPerDay); " +
        "days can then have zero trades, which do not count as trading days.",
    ),
};

const riskModeField = z
  .enum(["percent-of-balance", "percent-of-initial", "fixed-amount"])
  .optional()
  .describe(
    "How riskValue is interpreted. 'percent-of-balance' (default): risk compounds with the current " +
      "balance. 'percent-of-initial': constant currency risk derived from the initial account size - how " +
      "most prop traders size, since loss limits are fixed in currency. 'fixed-amount': explicit currency " +
      "risked per 1R.",
  );

const riskValueField = z
  .number()
  .positive()
  .describe(
    "Risk per trade - the value of 1R. PERCENT UNITS for percent modes (0.5 = 0.5% risked per trade; a " +
      "typical prop range is 0.25-2), or a currency amount for 'fixed-amount'. NOT a fraction.",
  );

const simOptionFields = {
  seed: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe(
      "RNG seed (integer or string). Default 42. Same inputs + seed reproduce byte-identical results - " +
        "include the seed when reporting so users can reproduce the numbers.",
    ),
  paths: z
    .number()
    .int()
    .min(100)
    .max(100_000)
    .optional()
    .describe(
      "Monte Carlo paths (independent simulated trader journeys). Default 10,000 (well under a second); " +
        "capped at 100,000 per tool call. Confidence intervals shrink roughly with the square root of " +
        "paths.",
    ),
  attemptCap: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Maximum challenge attempts per path before that path gives up. Default 25. Journey statistics " +
        "(expected attempts/cost, P(funded)) are censored at this cap.",
    ),
  simulateFunded: z
    .boolean()
    .optional()
    .describe(
      "Whether to simulate the funded stage (payouts, blowup risk) after passing. Default true - EV is " +
        "only meaningful with it on; set false to study the evaluation alone.",
    ),
  fundedHorizonDays: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      "Funded-stage horizon in trading days for the payout/EV simulation. Default 90 (about 4 calendar " +
        "months). EV scales with this choice - state it when reporting EV.",
    ),
};

const includeHistogramsField = z
  .boolean()
  .optional()
  .describe(
    "Include histogram arrays (attempts, cost, net, drawdown) in the result. Default FALSE for this " +
      "tool to keep responses compact; summary quantiles (p05...p95) are always included.",
  );

/* ------------------------------------------------------------------------ *
 * Formatting helpers for the human summaries
 * ------------------------------------------------------------------------ */

function fmtPct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

function fmtMoney(x: number, currency: string): string {
  const rounded = Math.round(x);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(rounded);
  } catch {
    return `${rounded.toLocaleString("en-US")} ${currency}`;
  }
}

function fmtNum(x: number, digits = 1): string {
  return x.toFixed(digits);
}

function flagsLine(flags: AssumptionFlag[]): string {
  if (flags.length === 0) return "Assumptions: none flagged.";
  const shown = flags.slice(0, 6).map((f) => (f.source === "dataset" ? `${f.id} (dataset)` : f.id));
  const more = flags.length > 6 ? ` +${flags.length - 6} more` : "";
  return `Assumptions (${flags.length} flags - relay these to the user): ${shown.join(", ")}${more}.`;
}

const MAX_LOSS_MODE_TEXT: Record<string, string> = {
  "static-initial": "static from the initial balance (never trails)",
  "trailing-realized-eod": "trails end-of-day balance highs (intraday highs do not move it)",
  "trailing-intraday-unrealized": "trails peak intraday unrealized equity and never stops (harshest variant)",
  "trailing-locks-at-initial":
    "trails intraday peak equity until the floor reaches the initial balance, then locks",
};

function simulationSummary(headline: string, result: SimResult): string {
  const spec = result.assumptions.spec;
  const currency = spec.currency;
  const pa = result.perAttempt;
  const j = result.journey;
  const lines: string[] = [];

  lines.push(headline);
  lines.push(
    `Per-attempt pass probability: ${fmtPct(pa.passProbability)} ` +
      `(95% CI ${fmtPct(pa.passProbabilityCi.low)}-${fmtPct(pa.passProbabilityCi.high)})` +
      (pa.steps.length > 1
        ? ` | per step (conditional on reaching): ${pa.steps
            .map((s) => `step ${s.index + 1} ${fmtPct(s.passProbability)}`)
            .join(", ")}`
        : ""),
  );

  const failures = Object.entries(pa.failureBreakdown).filter(([, n]) => n > 0);
  const failedTotal = failures.reduce((acc, [, n]) => acc + n, 0);
  if (failedTotal > 0) {
    lines.push(
      `Failure causes (share of failed attempts): ${failures
        .map(([reason, n]) => `${reason} ${fmtPct(n / failedTotal, 0)}`)
        .join(", ")}`,
    );
  }

  lines.push(
    `Stagnation (longest stretch of days without a new equity high, per attempt): ` +
      `median ${fmtNum(pa.stagnationDays.p50, 0)} days, p90 ${fmtNum(pa.stagnationDays.p90, 0)} - ` +
      `grows sharply at lower risk per trade.`,
  );

  lines.push(
    `P(funded within ${j.attemptCap} attempts): ${fmtPct(j.fundedProbability)} | ` +
      `expected attempts: ${fmtNum(j.attempts.mean)} (median ${fmtNum(j.attempts.p50, 0)}) | ` +
      `expected total cost: ${fmtMoney(j.cost.mean, currency)}` +
      (j.costGivenFunded ? ` (given funded: ${fmtMoney(j.costGivenFunded.mean, currency)})` : ""),
  );
  if (j.daysToFunded) {
    lines.push(`Trading days to funded (funded paths): median ${fmtNum(j.daysToFunded.p50, 0)}`);
  }

  if (result.funded) {
    const f = result.funded;
    lines.push(
      `Funded stage over ${f.horizonTradingDays} trading days: ` +
        (f.payoutTotalGivenFunded
          ? `payout given funded mean ${fmtMoney(f.payoutTotalGivenFunded.mean, currency)} ` +
            `(median ${fmtMoney(f.payoutTotalGivenFunded.p50, currency)}) | `
          : "") +
        `P(funded account blown in horizon): ${fmtPct(f.blownProbability)}`,
    );
    if (Number.isFinite(f.payoutProbability)) {
      lines.push(
        `P(at least one payout | funded): ${fmtPct(f.payoutProbability)}` +
          (f.daysToFirstPayout
            ? ` | funded trading days to first payout: median ${fmtNum(f.daysToFirstPayout.p50, 0)} ` +
              `(p90 ${fmtNum(f.daysToFirstPayout.p90, 0)})`
            : " | no simulated path collected a payout"),
      );
    }
    const ci = 1.96 * result.ev.evStandardError;
    lines.push(
      `EV (payouts minus all fees): ${fmtMoney(result.ev.evTotal, currency)} +/- ${fmtMoney(ci, currency)} ` +
        `(95% CI) | P(net > 0): ${fmtPct(result.ev.pPositive)}`,
    );
  } else {
    lines.push(
      "Funded stage not simulated (simulateFunded=false); EV reflects costs only, so it is not " +
        "comparable to full-journey EV.",
    );
  }

  lines.push(flagsLine(result.assumptions.flags));
  lines.push(
    `Seed ${String(result.meta.seed)}, ${result.meta.paths} paths, engine v${result.engineVersion}.`,
  );
  lines.push(result.assumptions.disclaimer);
  return lines.join("\n");
}

/* ------------------------------------------------------------------------ *
 * Spec / profile / options assembly
 * ------------------------------------------------------------------------ */

interface SpecRefInput {
  firmId?: string | undefined;
  challengeId?: string | undefined;
  spec?: Record<string, unknown> | undefined;
}

interface ResolvedSpec {
  spec: ChallengeSpecInput;
  firmId: string | null;
  firmName: string | null;
  /** "directory" | "directory+inferred" for directory refs; "inline" otherwise. */
  provenance: "directory" | "directory+inferred" | "inline";
  /** Spec paths inferred from directory free text - relay next to results. */
  inferredFields: string[];
  headline: string;
}

/** One line disclosing inferred rule semantics, or null when nothing was. */
function inferredNote(resolved: ResolvedSpec): string | null {
  if (resolved.inferredFields.length === 0) return null;
  return (
    `Inferred from directory free text (verify against the firm's page): ` +
    `${resolved.inferredFields.join(", ")}.`
  );
}

async function resolveSpec(input: SpecRefInput): Promise<ResolvedSpec> {
  const hasRef = input.firmId !== undefined || input.challengeId !== undefined;
  const hasInline = input.spec !== undefined;
  if (hasRef && hasInline) {
    throw new Error(
      "Provide either firmId + challengeId (a directory challenge) or an inline `spec`, not both.",
    );
  }
  if (!hasRef && !hasInline) {
    throw new Error(
      "No challenge given. Provide firmId + challengeId (discover them with list_firms) or an inline " +
        "`spec` object (the shape get_challenge_rules returns).",
    );
  }
  if (hasRef) {
    if (input.firmId === undefined || input.challengeId === undefined) {
      throw new Error(
        "A directory reference needs BOTH firmId and challengeId. Use list_firms to discover valid " +
          "pairs, or pass an inline `spec` instead.",
      );
    }
    // Throws with the known firms when the id is unknown - surfaced as the tool error.
    const firm = resolveFirm(await fetchDirectory(), input.firmId);
    const adapted = adaptFirm(firm);
    const challenge = adapted.find((c) => c.challengeId === input.challengeId);
    if (!challenge) {
      const raw = firm.challenges.find((c) => c.challengeId === input.challengeId);
      if (raw) {
        throw new Error(
          `Challenge '${input.challengeId}' exists in the directory but is not simulatable: its ` +
            "loss-rule semantics are ambiguous and this server refuses to guess them. If the user can " +
            "confirm the rules from the firm's page, pass them as an inline `spec` instead.",
        );
      }
      const known = adapted.map((c) => c.challengeId).join(", ");
      throw new Error(
        `Unknown challengeId '${input.challengeId}' for ${firm.name}. Simulatable challenges: ${known}.`,
      );
    }
    const currency = (challenge.spec as { currency?: string }).currency ?? "USD";
    return {
      spec: challenge.spec,
      firmId: firm.propfirmId,
      firmName: firm.name,
      provenance: challenge.provenance,
      inferredFields: challenge.inferredFields,
      headline:
        `${firm.name} - ${challenge.challengeName} (${firm.propfirmId}/${challenge.challengeId}), ` +
        `${fmtMoney(challenge.spec.accountSize, currency)} ${challenge.productType} account ` +
        `[provenance: ${challenge.provenance}]`,
    };
  }
  const inline = input.spec as Record<string, unknown>;
  const name = typeof inline.name === "string" ? inline.name : "inline spec";
  return {
    spec: inline as unknown as ChallengeSpecInput,
    firmId: null,
    firmName: null,
    provenance: "inline",
    inferredFields: [],
    headline: `${name} (inline spec)`,
  };
}

interface ParametricTraderInput {
  winRate: number;
  avgWinR: number;
  avgLossR?: number | undefined;
  winStdR?: number | undefined;
  lossStdR?: number | undefined;
  tradesPerDay: number;
  tradesPerDayModel?: "fixed" | "poisson" | undefined;
}

function parametricProfile(
  trader: ParametricTraderInput,
  riskMode: "percent-of-balance" | "percent-of-initial" | "fixed-amount" | undefined,
  riskValue: number,
): TraderProfileInput {
  return {
    kind: "parametric",
    winRate: trader.winRate,
    avgWinR: trader.avgWinR,
    avgLossR: trader.avgLossR,
    winStdR: trader.winStdR,
    lossStdR: trader.lossStdR,
    tradesPerDay: trader.tradesPerDay,
    tradesPerDayModel: trader.tradesPerDayModel,
    risk: { mode: riskMode, value: riskValue },
  } as TraderProfileInput;
}

interface SimOptionInput {
  seed?: number | string | undefined;
  paths?: number | undefined;
  attemptCap?: number | undefined;
  simulateFunded?: boolean | undefined;
  fundedHorizonDays?: number | undefined;
  includeHistograms?: boolean | undefined;
}

function simOptions(input: SimOptionInput): SimOptionsInput {
  return {
    seed: input.seed,
    paths: input.paths,
    attemptCap: input.attemptCap,
    simulateFunded: input.simulateFunded,
    fundedHorizonDays: input.fundedHorizonDays,
    // Compact transport by default; core's own default is true.
    includeHistograms: input.includeHistograms ?? false,
  } as SimOptionsInput;
}

/* ------------------------------------------------------------------------ *
 * 1. list_firms
 * ------------------------------------------------------------------------ */

const listFirmsSchema = z.object({
  productType: z
    .enum(["futures", "cfd"])
    .optional()
    .describe("Optional filter to one instrument class. Omit to list every firm."),
});

export async function handleListFirms(input: unknown): Promise<ToolResult> {
  return safely(async () => {
    const args = parseInput(listFirmsSchema, input);
    const directory = await fetchDirectory();

    const rows = directory
      .filter(
        (firm) =>
          !args.productType ||
          (firm.productTypes?.some((p) => /future/i.test(p)) ? "futures" : "cfd") === args.productType,
      )
      .map((firm) => {
        const adapted = adaptFirm(firm);
        const adaptedIds = new Set(adapted.map((c) => c.challengeId));
        const challenges = adapted
          .filter((c) => !args.productType || c.productType === args.productType)
          .map((c) => {
            const spec = c.spec as { accountSize: number; currency?: string; fees?: { price?: number } };
            const lastVerified = (c.spec as { sources?: { lastVerified?: string }[] }).sources?.[0]
              ?.lastVerified;
            return {
              challengeId: c.challengeId,
              name: c.challengeName,
              productType: c.productType,
              accountSize: spec.accountSize,
              currency: spec.currency ?? "USD",
              price: spec.fees?.price,
              provenance: c.provenance,
              inferredFields: c.inferredFields.length > 0 ? c.inferredFields : undefined,
              lastVerified,
            };
          });
        const notSimulatable = firm.challenges
          .filter((raw) => !adaptedIds.has(raw.challengeId))
          .map((raw) => raw.challengeId);
        return {
          firmId: firm.propfirmId,
          name: firm.name,
          challenges,
          notSimulatable: notSimulatable.length > 0 ? notSimulatable : undefined,
        };
      })
      .filter((firm) => firm.challenges.length > 0 || firm.notSimulatable !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));

    const lines: string[] = [];
    lines.push(
      `${rows.length} firm(s) in the live LuxAlgo directory` +
        (args.productType ? ` with ${args.productType} challenges` : "") +
        " (alphabetical - data, not endorsement or ranking):",
    );
    for (const firm of rows) {
      lines.push(`${firm.firmId} - ${firm.name}`);
      for (const c of firm.challenges) {
        lines.push(
          `  - ${c.challengeId}: ${c.name} - ${fmtMoney(c.accountSize, c.currency)} ${c.productType}` +
            (c.price !== undefined ? `, ${fmtMoney(c.price, c.currency)}` : "") +
            ` [${c.provenance}]` +
            (c.lastVerified !== undefined ? `, source verified ${c.lastVerified}` : ""),
        );
      }
      if (firm.notSimulatable !== undefined) {
        lines.push(
          `  - not simulatable (ambiguous rule text; pass an inline spec instead): ` +
            firm.notSimulatable.join(", "),
        );
      }
    }
    lines.push(
      "Provenance 'directory+inferred' means some rule semantics were inferred from free text - " +
        "get_challenge_rules lists exactly which. Each firm's own page is authoritative.",
    );
    lines.push(DISCLAIMER);

    return ok(lines.join("\n"), {
      firms: rows,
      engineVersion: ENGINE_VERSION,
      disclaimer: DISCLAIMER,
    });
  });
}

/* ------------------------------------------------------------------------ *
 * 2. get_challenge_rules
 * ------------------------------------------------------------------------ */

const getChallengeRulesSchema = z.object({
  firmId: z.string().min(1).describe("Directory firm id or firm name from list_firms, e.g. 'ftmo'."),
  challengeId: z.string().min(1).describe("Directory challenge id from list_firms."),
});

function describeDailyLoss(rule: NonNullable<ChallengeSpecOutputLike["dailyLoss"]>): string {
  const limit = rule.pct !== undefined ? `${rule.pct}%` : `${rule.amount ?? "?"} (currency)`;
  const ofWhat = rule.limitBasis === "anchor" ? "of the daily anchor" : "of the initial balance";
  return (
    `${limit} ${ofWhat}, anchored to ${rule.basis}, ` +
    `${rule.includesOpenPnl ? "including" : "excluding"} open P&L, evaluated ${rule.evaluation}`
  );
}

/** Loose structural view of a parsed dataset challenge (core output types). */
interface ChallengeSpecOutputLike {
  dailyLoss: {
    pct?: number | undefined;
    amount?: number | undefined;
    basis: string;
    limitBasis: string;
    includesOpenPnl: boolean;
    evaluation: string;
  } | null;
}

/** Structural view of an adapted spec: the adapter populates every field the
 *  rendering below reads, even where the input schema marks them optional. */
interface RenderableSpec {
  name: string;
  accountSize: number;
  currency?: string;
  steps: {
    profitTargetPct?: number;
    profitTargetAmount?: number;
    minTradingDays: number;
    maxDays: number | null;
    dailyLoss?: unknown | null;
    maxLoss?: { pct?: number; amount?: number; mode: string };
    consistency?: { maxBestDayProfitPct: number } | null;
  }[];
  dailyLoss: NonNullable<ChallengeSpecOutputLike["dailyLoss"]> | null;
  maxLoss: { pct?: number; amount?: number; mode: string; locksAtInitial: boolean; lockOffsetAmount: number };
  fees: {
    price: number;
    billing: string;
    resetFee: number | null;
    activationFee: number;
    refundableOnPass: boolean;
  };
  funded: {
    profitSplitPct: number;
    payoutFrequency: string;
    firstPayoutMinDays: number;
    notes?: string;
    payoutRules?: {
      minWinningDays: number;
      winningDayMinProfit: number;
      maxPayoutPctOfProfit?: number;
      maxPayoutAmount?: number;
      bufferAmount: number;
      consistencyMaxBestDayPct?: number;
    };
  };
  flagsNotSimulated: string[];
  sources?: { url: string; lastVerified: string; note?: string }[];
}

export async function handleGetChallengeRules(input: unknown): Promise<ToolResult> {
  return safely(async () => {
    const args = parseInput(getChallengeRulesSchema, input);
    const resolved = await resolveSpec({ firmId: args.firmId, challengeId: args.challengeId });
    const challenge = resolved.spec as unknown as RenderableSpec;
    const currency = challenge.currency ?? "USD";

    const lines: string[] = [];
    lines.push(`${resolved.headline}.`);
    const note = inferredNote(resolved);
    if (note !== null) lines.push(note);
    challenge.steps.forEach((step, i) => {
      const target =
        step.profitTargetPct !== undefined
          ? `${step.profitTargetPct}%`
          : fmtMoney(step.profitTargetAmount ?? 0, currency);
      lines.push(
        `Step ${i + 1}: target ${target}, min trading days ${step.minTradingDays}, ` +
          `time limit ${step.maxDays === null ? "none" : `${step.maxDays} trading days`}` +
          (step.maxLoss
            ? `, step max loss ${step.maxLoss.pct ?? step.maxLoss.amount} (${step.maxLoss.mode})`
            : "") +
          (step.dailyLoss === null ? ", no daily loss in this step" : "") +
          (step.consistency != null
            ? `, consistency (simulated): best day <= ${step.consistency.maxBestDayProfitPct}% of total profit`
            : ""),
      );
    });
    lines.push(
      challenge.dailyLoss
        ? `Daily loss: ${describeDailyLoss(challenge.dailyLoss)}.`
        : "Daily loss: none at the challenge level.",
    );
    const maxLoss = challenge.maxLoss;
    const locksViaMode = maxLoss.mode === "trailing-locks-at-initial";
    const lockLevel =
      maxLoss.lockOffsetAmount > 0
        ? `the starting balance + ${fmtMoney(maxLoss.lockOffsetAmount, currency)}`
        : "the starting balance";
    const lockNote =
      maxLoss.locksAtInitial && !locksViaMode
        ? `, locks once the floor reaches ${lockLevel}`
        : locksViaMode && maxLoss.lockOffsetAmount > 0
          ? `, lock level offset: the floor locks at ${lockLevel}`
          : "";
    lines.push(
      `Max loss: ${maxLoss.pct !== undefined ? `${maxLoss.pct}%` : fmtMoney(maxLoss.amount ?? 0, currency)}, ` +
        `${MAX_LOSS_MODE_TEXT[maxLoss.mode] ?? maxLoss.mode}${lockNote}.`,
    );
    lines.push(
      `Fees: ${fmtMoney(challenge.fees.price, currency)} ${challenge.fees.billing}` +
        (challenge.fees.resetFee !== null
          ? `, reset ${fmtMoney(challenge.fees.resetFee, currency)}`
          : ", no reset offer") +
        (challenge.fees.activationFee > 0
          ? `, activation ${fmtMoney(challenge.fees.activationFee, currency)}`
          : "") +
        (challenge.fees.refundableOnPass ? ", fee refunded on pass" : "") +
        ".",
    );
    lines.push(
      `Funded: ${challenge.funded.profitSplitPct}% profit split, ${challenge.funded.payoutFrequency} payouts, ` +
        `first payout after ${challenge.funded.firstPayoutMinDays} days.` +
        (challenge.funded.notes ? ` Note: ${challenge.funded.notes}` : ""),
    );
    const payoutRules = challenge.funded.payoutRules;
    if (payoutRules !== undefined) {
      const gates: string[] = [];
      if (payoutRules.minWinningDays > 0) {
        gates.push(
          `${payoutRules.minWinningDays} winning days` +
            (payoutRules.winningDayMinProfit > 0
              ? ` of ${fmtMoney(payoutRules.winningDayMinProfit, currency)}+ each`
              : ""),
        );
      } else if (payoutRules.winningDayMinProfit > 0) {
        gates.push(`a winning day means ${fmtMoney(payoutRules.winningDayMinProfit, currency)}+ profit`);
      }
      const caps: string[] = [];
      if (payoutRules.maxPayoutPctOfProfit !== undefined) {
        caps.push(`${payoutRules.maxPayoutPctOfProfit}% of accrued profit`);
      }
      if (payoutRules.maxPayoutAmount !== undefined) {
        caps.push(fmtMoney(payoutRules.maxPayoutAmount, currency));
      }
      if (caps.length > 0) gates.push(`each payout capped at ${caps.join(" and ")}`);
      if (payoutRules.bufferAmount > 0) {
        gates.push(`a ${fmtMoney(payoutRules.bufferAmount, currency)} profit buffer stays in the account`);
      }
      if (payoutRules.consistencyMaxBestDayPct !== undefined) {
        gates.push(
          `funded consistency: best day <= ${payoutRules.consistencyMaxBestDayPct}% of the window's profit`,
        );
      }
      lines.push(
        `Payout gating (simulated): ${gates.length > 0 ? gates.join(", ") : "payouts on request (no gating conditions)"}.`,
      );
    }
    lines.push(
      challenge.flagsNotSimulated.length > 0
        ? `Declared but NOT simulated (real odds are somewhat worse): ${challenge.flagsNotSimulated.join(", ")}.`
        : "No declared unsimulated rules for this entry.",
    );
    for (const source of challenge.sources ?? []) {
      lines.push(
        `Source: ${source.url} (last verified ${source.lastVerified})${source.note ? ` - ${source.note}` : ""}`,
      );
    }
    lines.push(
      "The firm's page is authoritative - rules may have changed. Full machine-readable spec follows; " +
        "pass it (modified if you like) as `spec` to the simulation tools.",
    );
    lines.push(JSON.stringify(resolved.spec, null, 2));
    lines.push(DISCLAIMER);

    return ok(lines.join("\n"), {
      challenge: resolved.spec as unknown as Record<string, unknown>,
      provenance: resolved.provenance,
      inferredFields: resolved.inferredFields,
      flagsNotSimulated: challenge.flagsNotSimulated,
      engineVersion: ENGINE_VERSION,
      disclaimer: DISCLAIMER,
    });
  });
}

/* ------------------------------------------------------------------------ *
 * 3. simulate_challenge
 * ------------------------------------------------------------------------ */

const simulateChallengeSchema = z.object({
  ...specRefFields,
  ...parametricTraderFields,
  riskMode: riskModeField,
  riskValue: riskValueField,
  ...simOptionFields,
  includeHistograms: includeHistogramsField,
});

export async function handleSimulateChallenge(input: unknown): Promise<ToolResult> {
  return safely(async () => {
    const args = parseInput(simulateChallengeSchema, input);
    const resolved = await resolveSpec(args);
    const profile = parametricProfile(args, args.riskMode, args.riskValue);
    const result = simulate(resolved.spec, profile, simOptions(args));
    const note = inferredNote(resolved);
    const summary = simulationSummary(resolved.headline, result);
    return ok(note === null ? summary : `${note}\n${summary}`, {
      ...(result as unknown as Record<string, unknown>),
      provenance: resolved.provenance,
      inferredFields: resolved.inferredFields,
    });
  });
}

/* ------------------------------------------------------------------------ *
 * 4. optimal_risk
 * ------------------------------------------------------------------------ */

const optimalRiskSchema = z.object({
  ...specRefFields,
  ...parametricTraderFields,
  riskMode: riskModeField,
  min: z
    .number()
    .positive()
    .optional()
    .describe(
      "Grid start, in the risk units of riskMode (percent units for percent modes, currency for " +
        "'fixed-amount'). Default 0.1 (= 0.1% per trade for percent modes).",
    ),
  max: z
    .number()
    .positive()
    .optional()
    .describe("Grid end, same units as min. Default 3 (= 3% per trade for percent modes)."),
  step: z
    .number()
    .positive()
    .optional()
    .describe(
      "Grid step, same units. Default 0.1. The sweep runs one full simulation per grid point, so " +
        "(max - min) / step + 1 simulations in total - keep the grid coarse or paths low for a first pass.",
    ),
  ...simOptionFields,
});

export async function handleOptimalRisk(input: unknown): Promise<ToolResult> {
  return safely(async () => {
    const args = parseInput(optimalRiskSchema, input);
    const resolved = await resolveSpec(args);
    const grid = { min: args.min, max: args.max, step: args.step };
    // riskValue is swept by optimalRisk (it overrides risk.value per grid point);
    // seed a valid placeholder so the profile validates.
    const placeholderRisk = args.min ?? 0.1;
    const profile = parametricProfile(args, args.riskMode, placeholderRisk);
    const options = simOptions(args);
    const sweep = optimalRisk(resolved.spec, profile, options, grid);

    // The sweep itself returns no assumptions block (charter: every tool result
    // must carry flags + disclaimer), so run one simulation at the EV-optimal
    // risk to obtain the flags that apply to every grid point.
    const atBestEv = simulate(
      resolved.spec,
      parametricProfile(args, args.riskMode, sweep.bestByEv.risk),
      options,
    );
    const currency = atBestEv.assumptions.spec.currency;
    const riskUnits = args.riskMode === "fixed-amount" ? currency : "% per trade";

    const lines: string[] = [];
    lines.push(`Risk sweep for ${resolved.headline} (${sweep.points.length} grid points).`);
    const note = inferredNote(resolved);
    if (note !== null) lines.push(note);
    lines.push(
      `Best per-attempt pass probability: risk ${sweep.bestByPassProbability.risk} ${riskUnits} -> ` +
        `pass ${fmtPct(sweep.bestByPassProbability.perAttemptPassProbability)}, ` +
        `EV ${fmtMoney(sweep.bestByPassProbability.evTotal, currency)}`,
    );
    lines.push(
      `Best EV: risk ${sweep.bestByEv.risk} ${riskUnits} -> ` +
        `EV ${fmtMoney(sweep.bestByEv.evTotal, currency)}, ` +
        `pass ${fmtPct(sweep.bestByEv.perAttemptPassProbability)}, ` +
        `P(EV > 0) ${fmtPct(sweep.bestByEv.pEvPositive)}`,
    );
    lines.push(
      sweep.diverges
        ? "These argmaxes DIFFER: the risk that maximizes the chance of passing is not the risk that " +
            "maximizes expected value. Present both to the user - choosing between them is a preference " +
            "(cheapest path to funded vs best long-run economics), not a calculation."
        : "For these inputs the same risk maximizes both pass probability and EV.",
    );
    lines.push(flagsLine(atBestEv.assumptions.flags));
    lines.push(
      `Seed ${String(atBestEv.meta.seed)}, ${atBestEv.meta.paths} paths per grid point (common random ` +
        `numbers), engine v${ENGINE_VERSION}.`,
    );
    lines.push(DISCLAIMER);

    return ok(lines.join("\n"), {
      grid: {
        min: args.min ?? 0.1,
        max: args.max ?? 3,
        step: args.step ?? 0.1,
        riskMode: args.riskMode ?? "percent-of-balance",
        riskUnits,
      },
      points: sweep.points,
      bestByPassProbability: sweep.bestByPassProbability,
      bestByEv: sweep.bestByEv,
      diverges: sweep.diverges,
      assumptions: {
        flags: atBestEv.assumptions.flags,
        disclaimer: DISCLAIMER,
        note: "Flags computed at the EV-optimal risk; they apply to every grid point.",
      },
      provenance: resolved.provenance,
      inferredFields: resolved.inferredFields,
      meta: { seed: atBestEv.meta.seed, paths: atBestEv.meta.paths, engineVersion: ENGINE_VERSION },
    });
  });
}

/* ------------------------------------------------------------------------ *
 * 5. compare_challenges
 * ------------------------------------------------------------------------ */

const compareChallengesSchema = z.object({
  challenges: z
    .array(
      z
        .object(specRefFields)
        .describe("One challenge: either firmId + challengeId (dataset) or an inline spec."),
    )
    .min(1)
    .max(12)
    .describe(
      "The challenges to simulate this trader across (1-12 entries; 2+ for a meaningful comparison). " +
        "Mix dataset references and inline specs freely.",
    ),
  ...parametricTraderFields,
  riskMode: riskModeField,
  riskValue: riskValueField,
  ...simOptionFields,
});

export async function handleCompareChallenges(input: unknown): Promise<ToolResult> {
  return safely(async () => {
    const args = parseInput(compareChallengesSchema, input);
    const resolvedList = await Promise.all(args.challenges.map((entry) => resolveSpec(entry)));
    const entries: CompareEntry[] = resolvedList.map((resolved) => ({
      ...(resolved.firmId !== null ? { firmId: resolved.firmId } : {}),
      ...(resolved.firmName !== null ? { firmName: resolved.firmName } : {}),
      spec: resolved.spec,
    }));
    const inferredByKey = new Map(
      resolvedList.map((r) => [
        `${r.firmId ?? ""}|${(r.spec as { challengeId?: string }).challengeId ?? ""}`,
        r,
      ]),
    );
    const profile = parametricProfile(args, args.riskMode, args.riskValue);
    const options = simOptions({ ...args, includeHistograms: false });
    // `results` is in the same order as `rows` (sorted by EV, best first).
    const { rows, results } = compare(entries, profile, options);

    const assumptionsByChallenge = results.map((r, i) => {
      const resolved = inferredByKey.get(`${rows[i]?.firmId ?? ""}|${r.assumptions.spec.challengeId}`);
      return {
        firmId: rows[i]?.firmId ?? null,
        challengeId: r.assumptions.spec.challengeId,
        name: r.assumptions.spec.name,
        flags: r.assumptions.flags,
        provenance: resolved?.provenance ?? "inline",
        inferredFields: resolved?.inferredFields ?? [],
      };
    });
    const seed = results[0]?.meta.seed ?? 42;
    const paths = results[0]?.meta.paths ?? 0;

    const lines: string[] = [];
    lines.push(
      `Simulated the same trader across ${rows.length} challenge(s) with identical options and seed. ` +
        "Rows are sorted by expected value FOR THESE INPUTS - this is not a ranking of firms, and it " +
        "reorders for a different trader profile.",
    );
    rows.forEach((row, i) => {
      const currency = results[i]?.assumptions.spec.currency ?? "USD";
      lines.push(
        `${i + 1}. ${row.firmName ? `${row.firmName} - ` : ""}${row.name}` +
          `${row.firmId ? ` (${row.firmId}/${row.challengeId})` : " (inline)"}: ` +
          `EV ${fmtMoney(row.evTotal, currency)}, P(EV>0) ${fmtPct(row.pEvPositive)}, ` +
          `pass/attempt ${fmtPct(row.perAttemptPassProbability)}, P(funded) ${fmtPct(row.fundedProbability)}, ` +
          `expected attempts ${fmtNum(row.expectedAttempts)}, expected cost ${fmtMoney(row.expectedCost, currency)}` +
          (row.daysToFundedP50 !== null ? `, median days to funded ${fmtNum(row.daysToFundedP50, 0)}` : "") +
          (row.flagsNotSimulated.length > 0 ? ` [not simulated: ${row.flagsNotSimulated.join(", ")}]` : ""),
      );
    });
    lines.push(
      "Challenges with more unsimulated flags have optimistic numbers - compare flags alongside EV. Run " +
        "simulate_challenge on interesting rows for full detail.",
    );
    if (resolvedList.some((r) => r.inferredFields.length > 0)) {
      lines.push(
        "Some rule semantics were inferred from directory free text - see " +
          "assumptionsByChallenge[].inferredFields and verify against the firms' pages.",
      );
    }
    lines.push(`Seed ${String(seed)}, ${paths} paths per challenge, engine v${ENGINE_VERSION}.`);
    lines.push(DISCLAIMER);

    return ok(lines.join("\n"), {
      note: "Rows sorted by EV for the caller's inputs - not a ranking or endorsement of any firm.",
      rows,
      assumptionsByChallenge,
      disclaimer: DISCLAIMER,
      meta: { seed, paths, engineVersion: ENGINE_VERSION },
    });
  });
}

/* ------------------------------------------------------------------------ *
 * 6. bootstrap_simulate
 * ------------------------------------------------------------------------ */

const NEWS_IMPACTS = ["low", "medium", "high"] as const;
const NEWS_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"] as const;

const TRADE_LOG_FORMAT_DOC =
  "Accepted formats, auto-detected: the generic CSV template (header: open time,close time,symbol," +
  "direction,quantity,entry price,exit price,stop loss,pnl,fees,r), plain timestamped CSV/TSV logs " +
  "(open time + R columns), real platform exports: TradingView strategy-tester list of trades " +
  "(both generations), MT4/MT5 account statements (CSV or pasted HTML), MT5 deals tables, and " +
  "ThinkOrSwim account statements, plus broker trade-history JSON in the @luxalgo/broker-sdk shape " +
  '(a bare fills array, {"trades": [...]}, or one snapshot account; fills replay FIFO into round ' +
  "trips with price-based P&L, disclosed). Timestamps WITHOUT an explicit offset are read as UTC. Files that " +
  "carry P&L but no risk information need importRisk to become R-multiples; ambiguous rule readings " +
  "are refused with diagnostics rather than guessed, and skipped rows are reported as warnings.";

const bootstrapSimulateSchema = z.object({
  ...specRefFields,
  rSeries: z
    .array(z.number())
    .min(10)
    .optional()
    .describe(
      "The trader's real trades as R-multiples in chronological order: each trade's P&L divided by the " +
        "amount risked on it (+1.8 = won 1.8x risk, -1 = lost exactly the risk, -1.4 = stop slipped 40%). " +
        "At least 10 trades; 100+ strongly recommended - short series make the simulation overconfident " +
        "in the sample. Mutually exclusive with rSeriesText, tradeLogText, and tradeLogTexts.",
    ),
  rSeriesText: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The same series as pasted text: a JSON array, CSV, or whitespace/newline separated numbers, with " +
        "an optional 'R' suffix per value (e.g. \"1.8R, -1R, 0.4, 2.1\"). Parsed with the library's " +
        "parseRSeries; unparseable tokens are reported back. Mutually exclusive with rSeries, " +
        "tradeLogText, and tradeLogTexts.",
    ),
  tradeLogText: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The trader's trades as one pasted TIMESTAMPED log instead of a bare series. " +
        TRADE_LOG_FORMAT_DOC +
        " Timestamps unlock two things a bare series cannot do: tradesPerDay is derived from the log " +
        "when not given, and newsFilter can compare odds with and without trading around news. " +
        "Mutually exclusive with rSeries, rSeriesText, and tradeLogTexts.",
    ),
  tradeLogTexts: z
    .array(z.string().min(1))
    .min(2)
    .max(5)
    .optional()
    .describe(
      "PORTFOLIO MODE: 2 to 5 timestamped trade logs (same format as tradeLogText), one per strategy or " +
        "account. They are merged into one chronological series and the combined account is simulated, " +
        "which preserves cross-strategy loss clustering (exactly what daily and max loss limits punish). " +
        "Overlap across the histories is ALWAYS analyzed and attached as " +
        "structuredContent.portfolioOverlap with an audit-risk verdict; see analyze_portfolio_overlap " +
        "for the methodology. Mutually exclusive with rSeries, rSeriesText, and tradeLogText.",
    ),
  importRisk: z
    .string()
    .optional()
    .describe(
      "Risk per trade for imports that carry P&L but no risk data (e.g. TradingView, MT5 deals, broker JSON, " +
        'ThinkOrSwim): cash risked per trade ("25") or a percent of entry value ("1%"). Applies to ' +
        "tradeLogText/tradeLogTexts only, is labeled rSource inferred, and is never applied silently: " +
        "without it such files are refused with needs-risk.",
    ),
  newsFilter: z
    .object({
      preMinutes: z
        .number()
        .min(0)
        .max(1440)
        .optional()
        .describe("Minutes avoided BEFORE each event. Default 30."),
      postMinutes: z
        .number()
        .min(0)
        .max(1440)
        .optional()
        .describe("Minutes avoided AFTER each event. Default 30."),
      impacts: z
        .array(z.enum(NEWS_IMPACTS))
        .min(1)
        .optional()
        .describe(
          "Impact levels to avoid. Default ['high']. The built-in recurring calendar carries high- and " +
            "medium-impact templates only; 'low' matches nothing unless customEventTimes supplies the " +
            "events.",
        ),
      currencies: z
        .array(z.enum(NEWS_CURRENCIES))
        .min(1)
        .optional()
        .describe(
          "Currencies whose events are avoided. Default: all eight built-in currencies " +
            "(USD, EUR, GBP, JPY, AUD, CAD, CHF, NZD).",
        ),
      customEventTimes: z
        .array(z.number())
        .optional()
        .describe(
          "Exact extra event times as epoch MILLISECONDS UTC, merged into the calendar as high-impact " +
            "events. Use these for releases the recurring templates do not cover.",
        ),
    })
    .optional()
    .describe(
      "What-if comparison: what are my odds if I do not OPEN trades around scheduled news? Requires a " +
        "timestamped input (tradeLogText or tradeLogTexts). The simulation runs TWICE with the same " +
        "seed and options, once on the full history and once with every trade opened inside " +
        "[event - preMinutes, event + postMinutes] removed; trades opened earlier but held through an " +
        "event are only counted, not removed. The returned SimResult is the news-AVOIDED scenario; " +
        "structuredContent.newsComparison carries both scenarios' headline numbers, the excluded-trade " +
        "count, and a calendar caveat that MUST be relayed to the user (the calendar is a " +
        "recurring-template approximation of scheduled releases, not a historical feed).",
    ),
  blockMeanLength: z
    .number()
    .positive()
    .optional()
    .describe(
      "Mean block length of the stationary bootstrap (geometrically distributed blocks). Default 5 " +
        "trades. 1 = i.i.d. resampling (destroys streaks - only for comparison); raise toward 10 if the " +
        "trader's edge comes and goes in long regimes.",
    ),
  tradesPerDay: z
    .number()
    .positive()
    .optional()
    .describe(
      "Average trades per simulated trading day. REQUIRED with rSeries/rSeriesText, which carry no " +
        "timestamps. Optional with tradeLogText/tradeLogTexts: when omitted it is derived from the " +
        "log's own timestamps (trades divided by distinct UTC trading days) and the output says so. " +
        "More trades per day means more ways to hit the daily loss limit within a single day.",
    ),
  tradesPerDayModel: parametricTraderFields.tradesPerDayModel,
  riskMode: riskModeField,
  riskValue: riskValueField,
  ...simOptionFields,
  includeHistograms: includeHistogramsField,
});

/** Turn the importRisk argument into a RiskSpec ("25" cash or "1%" of entry value). */
function parseImportRiskArg(raw: string | undefined): RiskSpec | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(trimmed);
  if (pct !== null) {
    const percent = Number(pct[1]);
    if (!Number.isFinite(percent) || percent <= 0)
      throw new Error(`importRisk percent must be positive (got "${raw}")`);
    return { type: "percent-of-entry-value", percent };
  }
  const amount = Number(trimmed);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(
      `importRisk takes cash risked per trade ("25") or a percent of entry value ("1%"), got "${raw}"`,
    );
  }
  return { type: "fixed-cash", amount };
}

/** Import one pasted trade history (any recognized format) or throw a
 *  caller-actionable error carrying the importer's diagnostics. */
function parseTradeLogOrThrow(
  text: string,
  label: string,
  riskSpec?: RiskSpec,
): { entries: TradeLogEntry[]; warnings: string[] } {
  const result = importTradeHistory(text, riskSpec !== undefined ? { riskSpec } : {});
  const errors = result.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message);
  if (!result.ok) {
    throw new Error(
      `${label} contains no parseable trades. ${errors.join(" ") || "No trades were recognized."}`,
    );
  }
  if (result.r.status === "needs-risk") {
    throw new Error(
      `${label} (${result.format.label}) carries P&L but no risk information, so its trades cannot become ` +
        'R-multiples on their own. Pass importRisk: "25" (cash risked per trade) or "1%" (percent of entry ' +
        "value) to convert under that stated assumption.",
    );
  }
  if (result.r.status !== "ready") {
    throw new Error(`${label}: ${errors.join(" ") || "the file's R coverage is incomplete."}`);
  }
  const bridge = toTradeLogEntries(result.trades);
  if (bridge.dropped > 0) {
    throw new Error(
      `${label}: ${bridge.dropped} trade(s) lack a timestamp or R value; refusing a silently thinned sample.`,
    );
  }
  const warnings = [
    `detected ${result.format.label} (${result.format.confidence}); ${result.stats.parsedTrades} trades, R source: ${result.r.source ?? "none"}`,
    ...result.issues.filter((issue) => issue.severity !== "error").map((issue) => issue.message),
  ];
  return { entries: bridge.entries, warnings };
}

/** Compact audit-risk lines for the text summary; the "high" band must read as a warning. */
function overlapTextLines(overlap: OverlapReport): string[] {
  const lines: string[] = [];
  lines.push(
    overlap.auditRisk === "high"
      ? "AUDIT RISK: HIGH. Warning: a prop firm reviewer could treat these accounts as correlated and " +
          `may audit or refuse payouts over it. ${overlap.verdict}`
      : `Audit risk: ${overlap.auditRisk.toUpperCase()}. ${overlap.verdict}`,
  );
  lines.push(overlap.disclosure);
  return lines;
}

export async function handleBootstrapSimulate(input: unknown): Promise<ToolResult> {
  return safely(async () => {
    const args = parseInput(bootstrapSimulateSchema, input);
    const seriesInputs = (
      [
        ["rSeries", args.rSeries],
        ["rSeriesText", args.rSeriesText],
        ["tradeLogText", args.tradeLogText],
        ["tradeLogTexts", args.tradeLogTexts],
      ] as const
    )
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name);
    if (seriesInputs.length > 1) {
      throw new Error(
        `Provide exactly one trade-series input, not ${seriesInputs.join(" + ")}: rSeries or ` +
          "rSeriesText for a bare R-multiple series, tradeLogText for one timestamped log, or " +
          "tradeLogTexts for a 2-5 log portfolio.",
      );
    }
    if (seriesInputs.length === 0) {
      throw new Error(
        "No trade series given. Provide rSeries (an array of R-multiples), rSeriesText (pasted text " +
          'like "1.8R, -1R, 0.4"), tradeLogText (a pasted timestamped CSV/TSV log), or tradeLogTexts ' +
          "(2-5 timestamped logs, portfolio mode), with at least 10 trades.",
      );
    }

    // Resolve the series and, for timestamped inputs, the entries behind it.
    const preLines: string[] = [];
    const parseWarnings: string[] = [];
    let entries: TradeLogEntry[] | null = null;
    let overlap: OverlapReport | null = null;
    let rSeries: number[];
    let tradesPerDay = args.tradesPerDay;
    let derivedTradesPerDay: number | null = null;
    let distinctDays: number | null = null;

    const importRiskSpec = parseImportRiskArg(args.importRisk);
    if (args.tradeLogText !== undefined) {
      const parsed = parseTradeLogOrThrow(args.tradeLogText, "tradeLogText", importRiskSpec);
      parseWarnings.push(...parsed.warnings);
      entries = parsed.entries;
    } else if (args.tradeLogTexts !== undefined) {
      const histories = args.tradeLogTexts.map((text, i) => {
        const parsed = parseTradeLogOrThrow(text, `tradeLogTexts[${i}]`, importRiskSpec);
        parseWarnings.push(...parsed.warnings.map((warning) => `log ${i + 1}: ${warning}`));
        return parsed.entries;
      });
      const merged = mergeTradeLogs(histories);
      entries = merged.entries;
      overlap = analyzeOverlap(histories);
      preLines.push(
        `Portfolio mode: ${histories.length} histories merged into one chronological series of ` +
          `${merged.entries.length} trades (${histories.map((h) => h.length).join(" + ")}).`,
      );
      preLines.push(...overlapTextLines(overlap));
    }

    if (entries !== null) {
      const derived = toBootstrapInputs(entries);
      rSeries = derived.rSeries;
      distinctDays = derived.distinctDays;
      if (tradesPerDay === undefined) {
        tradesPerDay = derived.tradesPerDay;
        derivedTradesPerDay = derived.tradesPerDay;
        preLines.push(
          `Trades/day ${fmtNum(derived.tradesPerDay, 2)} DERIVED from the log's timestamps ` +
            `(${entries.length} trades over ${derived.distinctDays} distinct UTC days); pass ` +
            "tradesPerDay to override.",
        );
      }
    } else {
      rSeries = args.rSeries ?? parseRSeries(args.rSeriesText as string);
      if (tradesPerDay === undefined) {
        throw new Error(
          "tradesPerDay is required with rSeries/rSeriesText: a bare R-multiple series carries no " +
            "timestamps to derive it from. Pass tradesPerDay, or provide the trades as a timestamped " +
            "log (tradeLogText) instead.",
        );
      }
    }
    const effectiveTradesPerDay = tradesPerDay;

    if (args.newsFilter !== undefined && entries === null) {
      throw new Error(
        "newsFilter needs timestamps to match trades against news windows. Provide the trades as " +
          "tradeLogText (one log) or tradeLogTexts (a portfolio), not as a bare R-multiple series.",
      );
    }

    const resolved = await resolveSpec(args);
    const options = simOptions(args);
    const makeProfile = (series: number[], perDay: number): TraderProfileInput =>
      ({
        kind: "bootstrap",
        rSeries: series,
        blockMeanLength: args.blockMeanLength,
        tradesPerDay: perDay,
        tradesPerDayModel: args.tradesPerDayModel,
        risk: { mode: args.riskMode, value: args.riskValue },
      }) as TraderProfileInput;

    let result: SimResult;
    let primarySeries = rSeries;
    let newsFilter: NewsFilterResult | null = null;
    let newsComparison: Record<string, unknown> | null = null;

    if (args.newsFilter !== undefined && entries !== null) {
      const filter = filterTradesAroundNews(entries, args.newsFilter);
      newsFilter = filter;
      if (filter.kept.length < 10) {
        throw new Error(
          `News filtering excluded ${filter.excluded.length} of ${entries.length} trades and left only ` +
            `${filter.kept.length}; at least 10 are needed to bootstrap. Narrow preMinutes/postMinutes, ` +
            "the impacts, or the currencies.",
        );
      }
      const keptInputs = toBootstrapInputs(filter.kept);
      const original = simulate(resolved.spec, makeProfile(rSeries, effectiveTradesPerDay), options);
      const avoidedTradesPerDay = args.tradesPerDay ?? keptInputs.tradesPerDay;
      result = simulate(resolved.spec, makeProfile(keptInputs.rSeries, avoidedTradesPerDay), options);
      primarySeries = keptInputs.rSeries;

      newsComparison = {
        original: {
          passProbability: original.perAttempt.passProbability,
          fundedProbability: original.journey.fundedProbability,
          evTotal: original.ev.evTotal,
        },
        newsAvoided: {
          passProbability: result.perAttempt.passProbability,
          fundedProbability: result.journey.fundedProbability,
          evTotal: result.ev.evTotal,
        },
        excludedTrades: filter.excluded.length,
        heldThroughCount: filter.heldThroughCount,
        eventsInRange: filter.eventsInRange,
        options: filter.options,
        caveat: filter.caveat,
      };

      const currency = result.assumptions.spec.currency;
      const deltaPts = (result.perAttempt.passProbability - original.perAttempt.passProbability) * 100;
      preLines.push(
        "News-avoidance comparison (both runs share the seed and options; the SimResult below is the " +
          "news-AVOIDED scenario):",
      );
      preLines.push(
        `Pass/attempt: original ${fmtPct(original.perAttempt.passProbability)} vs news-avoided ` +
          `${fmtPct(result.perAttempt.passProbability)} (${deltaPts >= 0 ? "+" : ""}${deltaPts.toFixed(1)} ` +
          `points). P(funded): ${fmtPct(original.journey.fundedProbability)} vs ` +
          `${fmtPct(result.journey.fundedProbability)}. EV: ${fmtMoney(original.ev.evTotal, currency)} vs ` +
          `${fmtMoney(result.ev.evTotal, currency)}.`,
      );
      preLines.push(
        `Excluded ${filter.excluded.length} of ${entries.length} trades opened inside news windows ` +
          `(${filter.options.preMinutes} min before / ${filter.options.postMinutes} min after, impacts ` +
          `${filter.options.impacts.join("+")}); ${filter.heldThroughCount} more held through an event; ` +
          `${filter.eventsInRange} calendar events matched the log's date range.`,
      );
      preLines.push(filter.caveat);
    } else {
      result = simulate(resolved.spec, makeProfile(rSeries, effectiveTradesPerDay), options);
    }

    const wins = primarySeries.filter((r) => r > 0).length;
    const meanR = primarySeries.reduce((a, b) => a + b, 0) / primarySeries.length;
    const seriesLine =
      `Bootstrap profile: ${primarySeries.length} real trades resampled in blocks of mean length ` +
      `${args.blockMeanLength ?? 5} (streaks preserved); sample win rate ${fmtPct(wins / primarySeries.length)}, ` +
      `mean ${fmtNum(meanR, 2)}R per trade.`;
    const warningLines = parseWarnings.map((warning) => `Parse warning: ${warning}`);
    const summary = simulationSummary(resolved.headline, result);
    const note = inferredNote(resolved);
    return ok(
      [seriesLine, ...warningLines, ...preLines, ...(note === null ? [] : [note]), summary].join("\n"),
      {
        ...(result as unknown as Record<string, unknown>),
        provenance: resolved.provenance,
        inferredFields: resolved.inferredFields,
        ...(entries !== null
          ? {
              tradeLog: {
                trades: entries.length,
                distinctDays,
                historyCount: args.tradeLogTexts?.length ?? 1,
                derivedTradesPerDay,
                parseWarnings,
              },
            }
          : {}),
        ...(overlap !== null ? { portfolioOverlap: overlap as unknown as Record<string, unknown> } : {}),
        ...(newsFilter !== null && newsComparison !== null ? { newsComparison } : {}),
      },
    );
  });
}

/* ------------------------------------------------------------------------ *
 * 7. analyze_portfolio_overlap
 * ------------------------------------------------------------------------ */

const analyzePortfolioOverlapSchema = z.object({
  tradeLogTexts: z
    .array(z.string().min(1))
    .min(2)
    .max(5)
    .describe(
      "2 to 5 timestamped trade logs, one per account or strategy. " +
        TRADE_LOG_FORMAT_DOC +
        " A close-time column makes overlap use the real holding interval, and a direction column " +
        "makes the analysis much more meaningful: same-direction overlap is what firms actually look " +
        "for, and without directions an overlap can only be counted as direction-unknown.",
    ),
  importRisk: z
    .string()
    .optional()
    .describe(
      "Risk per trade for imports that carry P&L but no risk data (e.g. TradingView, MT5 deals, broker JSON, " +
        'ThinkOrSwim): cash risked per trade ("25") or a percent of entry value ("1%"). Applies to ' +
        "tradeLogText/tradeLogTexts only, is labeled rSource inferred, and is never applied silently: " +
        "without it such files are refused with needs-risk.",
    ),
  toleranceMinutes: z
    .number()
    .min(0)
    .max(240)
    .optional()
    .describe(
      "Minutes of padding around each position's [open, close] interval when matching trades across " +
        "histories. Default 5, maximum 240. Wider tolerance counts near-simultaneous entries as " +
        "overlapping.",
    ),
});

export async function handleAnalyzePortfolioOverlap(input: unknown): Promise<ToolResult> {
  return safely(() => {
    const args = parseInput(analyzePortfolioOverlapSchema, input);
    const parseWarnings: string[] = [];
    const overlapRiskSpec = parseImportRiskArg(args.importRisk);
    const histories = args.tradeLogTexts.map((text, i) => {
      const parsed = parseTradeLogOrThrow(text, `tradeLogTexts[${i}]`, overlapRiskSpec);
      parseWarnings.push(...parsed.warnings.map((warning) => `log ${i + 1}: ${warning}`));
      return parsed.entries;
    });
    const report = analyzeOverlap(
      histories,
      args.toleranceMinutes !== undefined ? { toleranceMinutes: args.toleranceMinutes } : {},
    );
    const totalTrades = histories.reduce((acc, history) => acc + history.length, 0);

    const lines: string[] = [];
    lines.push(
      `Position overlap across ${histories.length} histories (${totalTrades} trades, tolerance ` +
        `${report.toleranceMinutes} min around each position):`,
    );
    for (const pair of report.pairs) {
      const a = histories[pair.a]!;
      const b = histories[pair.b]!;
      lines.push(
        `Log ${pair.a + 1} vs log ${pair.b + 1}: ${pair.overlappingA}/${a.length} trades of log ` +
          `${pair.a + 1} overlap (${fmtPct(pair.shareA)}), ${pair.overlappingB}/${b.length} of log ` +
          `${pair.b + 1} (${fmtPct(pair.shareB)}); ${pair.sameDirection} same-direction, ` +
          `${pair.directionUnknown} direction-unknown.`,
      );
    }
    lines.push(
      `Overall overlap share ${fmtPct(report.overallOverlapShare)} | same-direction share ` +
        `${fmtPct(report.sameDirectionShare)} | trades with no direction column ` +
        `${fmtPct(report.unknownDirectionShare)}.`,
    );
    lines.push(...overlapTextLines(report));
    if (report.unknownDirectionShare > 0) {
      lines.push(
        "Some trades carry no direction, so their overlaps could only be counted as direction-unknown. " +
          "Add a direction/side column (long/short or buy/sell) to measure same-direction overlap, " +
          "which is the signal firms actually look for.",
      );
    }
    lines.push(...parseWarnings.map((warning) => `Parse warning: ${warning}`));

    return ok(lines.join("\n"), {
      ...(report as unknown as Record<string, unknown>),
      histories: histories.map((history, index) => ({ index, trades: history.length })),
      parseWarnings,
      engineVersion: ENGINE_VERSION,
    });
  });
}

/* ------------------------------------------------------------------------ *
 * Tool registry (name + metadata + handler), consumed by server.ts
 * ------------------------------------------------------------------------ */

export const toolDefinitions: readonly ToolDefinition[] = [
  {
    name: "list_firms",
    title: "List prop firms and challenges",
    description:
      "List the prop firms in the live LuxAlgo directory together with every simulatable challenge " +
      "(challengeId, display name, account size, currency, price, and its rule-semantics provenance). " +
      "Call this first to discover the firmId + challengeId pairs accepted by get_challenge_rules, " +
      "simulate_challenge, optimal_risk, compare_challenges and bootstrap_simulate. Challenges whose " +
      "loss-rule semantics cannot be established are listed under notSimulatable instead of being " +
      "guessed. The listing is data, not endorsement: firms are alphabetical - no recommendation or " +
      "ranking is implied, and none should be presented. " +
      PROVENANCE_DOC,
    inputShape: listFirmsSchema.shape,
    handler: handleListFirms,
  },
  {
    name: "get_challenge_rules",
    title: "Get a challenge's full ruleset",
    description:
      "Fetch one directory challenge's complete ruleset (ChallengeSpec), adapted from the live LuxAlgo " +
      "directory: evaluation steps " +
      "(profit targets in percent units of the initial account, minimum trading days, time limits); the " +
      "daily-loss rule with its exact semantics (basis = measured from prior-day balance vs prior-day " +
      "equity; limitBasis = whether a pct limit is a fixed allowance of the initial balance or recomputed " +
      "daily from the anchor; evaluation = breached on an intraday touch vs only at the close; " +
      "includesOpenPnl = whether floating P&L can breach it); the max-loss rule and its drawdown mode (" +
      MAX_LOSS_MODE_DOC +
      "); per-step consistency rules (steps[].consistency.maxBestDayProfitPct - SIMULATED: one outsized " +
      "day effectively raises the target until the best-day share complies); fees (price, one-time vs " +
      "monthly billing, reset fee, activation fee, refundable-on-pass); funded terms (profit split " +
      "percent, payout frequency, first-payout minimum days, and funded.payoutRules - SIMULATED payout " +
      "gating: minWinningDays, winningDayMinProfit, per-payout caps maxPayoutPctOfProfit/maxPayoutAmount, " +
      "bufferAmount, and a windowed consistencyMaxBestDayPct gate); " +
      "flagsNotSimulated (rules the entry declares but the engine does not simulate - material caveats " +
      "to relay to the user); and sources (the firm-page citation when the directory serves one). The " +
      "result also carries `provenance` and `inferredFields` - every rule read from free text instead " +
      "of a structured column is named there; relay them and treat the firm's page as authoritative. " +
      "The returned `challenge` object is exactly the shape the simulation tools accept as inline " +
      "`spec`: copy it, change a rule, and re-simulate to quantify how a rule variation moves pass " +
      "probability and EV. " +
      `${UNITS_DOC} ${PROVENANCE_DOC}`,
    inputShape: getChallengeRulesSchema.shape,
    handler: handleGetChallengeRules,
  },
  {
    name: "simulate_challenge",
    title: "Simulate a trader through a challenge",
    description:
      "Monte Carlo-simulate a trader with the given statistics through a prop-firm challenge and (by " +
      'default) a funded horizon. Answers: "What is my chance of passing per attempt, and of ever ' +
      "getting funded? How many attempts and how much total money should I expect? Is this challenge " +
      'positive expected value for me, and which rule actually kills my attempts?" ' +
      SPEC_CHOICE_DOC +
      " The trader is described by flattened parametric fields (one clean design used across all tools): " +
      "winRate (a FRACTION 0-1), avgWinR/avgLossR and optional winStdR/lossStdR in R-multiples (sizes " +
      "relative to the amount risked per trade), tradesPerDay with a 'fixed' or 'poisson' day model, and " +
      "risk sizing via riskMode + riskValue (percent units for percent modes). If you have the user's raw " +
      "trade series rather than summary stats, prefer bootstrap_simulate - it preserves streaks. " +
      "Returns structuredContent with the full SimResult: perAttempt.passProbability with a Wilson 95% CI " +
      "and per-step pass rates plus a failure breakdown by rule (daily-loss vs max-loss vs time-limit - " +
      "which tells the user WHAT to fix); journey.fundedProbability, attempts and cost distributions " +
      "(cost includes prices, resets, monthly billing, activation, minus refunds), costGivenFunded and " +
      "daysToFunded; perAttempt.avgDaysWhenPassed/avgDaysWhenFailed and perAttempt.stagnationDays (the " +
      "longest run of days without a new equity high per attempt - the dead time between progress, " +
      "which grows sharply as risk per trade shrinks); funded-stage payout distributions " +
      "plus funded.payoutProbability (P(at least one payout | funded)) and funded.daysToFirstPayout - " +
      "with payout gating these can be the deciding numbers, since getting funded is not the same as " +
      "getting paid; ev.evTotal (mean payouts minus costs) with " +
      "evStandardError and pPositive; drawdown stats; and assumptions (the fully-resolved spec/profile/" +
      "options the engine actually ran, plus flags and disclaimer). Histogram arrays are omitted unless " +
      "includeHistograms=true. A compact human summary is returned as text alongside. " +
      `${SIMULATED_RULES_DOC} ${UNITS_DOC} ${SEED_DOC} ${ASSUMPTIONS_DOC} ${PROVENANCE_DOC} ${COMPOSITION_DOC}`,
    inputShape: simulateChallengeSchema.shape,
    handler: handleSimulateChallenge,
  },
  {
    name: "optimal_risk",
    title: "Find pass- and EV-optimal risk per trade",
    description:
      "Sweep risk-per-trade over a grid, run the full journey simulation at every point, and report two " +
      "optima separately: bestByPassProbability (the risk that maximizes a single attempt's chance of " +
      "passing) and bestByEv (the risk that maximizes expected value across attempts, fees and funded " +
      "payouts). They usually differ (diverges=true) - and that divergence is the insight: lower risk " +
      "survives loss limits more often, but EV also weighs the cost of extra attempts and the size of " +
      "funded payouts, which can favor a different risk. Never present one number as THE optimal risk; " +
      "report both optima and the trade-off, and let the user choose. The sweep uses common random " +
      "numbers (the same seed at every grid point), so curves are smooth and the argmax is signal, not " +
      "Monte Carlo noise. Grid units follow riskMode: percent units for percent modes (default grid " +
      "0.1 to 3 in steps of 0.1, i.e. 0.1%-3% per trade), currency per trade for 'fixed-amount' (set " +
      "min/max/step explicitly). Parametric trader only (riskValue is not a parameter here - the grid " +
      "supplies it). Cost scales with grid size: one full simulation per point, so ~30 points at the " +
      "default 10,000 paths takes roughly 10 seconds; use fewer paths or a coarser grid for a first " +
      "pass, then refine around the optima. " +
      `${UNITS_DOC} ${SEED_DOC} ${ASSUMPTIONS_DOC}`,
    inputShape: optimalRiskSchema.shape,
    handler: handleOptimalRisk,
  },
  {
    name: "compare_challenges",
    title: "Compare challenges for one trader",
    description:
      "Simulate the SAME trader across several challenges (directory references and/or inline specs, up " +
      "to 12) under identical options and seed, and return one row per challenge sorted by expected value. " +
      "THIS IS NOT A RANKING: rows are ordered by EV for the caller's specific inputs - trader stats, " +
      "risk sizing, and options - and a different trader profile reorders them. The tool computes data " +
      "for the user's own decision; it implies no endorsement, league table, or recommendation of any " +
      "firm, and results should be presented that way ('best EV for these inputs', never 'best firm'). " +
      "Each row carries perAttemptPassProbability, fundedProbability, expectedAttempts, expectedCost, " +
      "evTotal, pEvPositive, daysToFundedP50, and the challenge's flagsNotSimulated - challenges with " +
      "more unsimulated rules have optimistic numbers, so compare flags alongside EV, not EV alone. " +
      "Consistency rules and funded payout gating ARE simulated (engine v1), so EV already reflects " +
      "them where a ruleset has them. For " +
      "full per-challenge distributions run simulate_challenge on the interesting rows. " +
      `${UNITS_DOC} ${SEED_DOC} ${ASSUMPTIONS_DOC}`,
    inputShape: compareChallengesSchema.shape,
    handler: handleCompareChallenges,
  },
  {
    name: "bootstrap_simulate",
    title: "Simulate from a real trade series",
    description:
      "Simulate a challenge by resampling the trader's OWN R-multiple trade series with a stationary " +
      "block bootstrap instead of a win-rate model. WHY THIS BEATS WIN-RATE MATH: challenge rules are " +
      "breached by streaks, not by averages - a daily-loss limit dies to a cluster of losses inside one " +
      "day, and a trailing drawdown dies to a losing streak right after an equity peak. Real trade series " +
      "are streaky (autocorrelation, volatility clustering, edge that comes and goes), and the stationary " +
      "bootstrap resamples contiguous blocks of the actual series (geometric length, mean " +
      "blockMeanLength, default 5 trades), so the trader's real streak structure survives into every " +
      "simulated day. A parametric model with identical summary statistics shuffles trades independently " +
      "and therefore understates breach risk for streaky traders. Use simulate_challenge when only " +
      "summary stats are available; use this whenever the actual trades are. Provide the series as " +
      "rSeries (array of R-multiples: each trade's P&L divided by the amount risked on it), rSeriesText " +
      "(pasted JSON/CSV/whitespace text, optional 'R' suffix per value), or one of the timestamped-log " +
      "inputs below; exactly one of the four, at least 10 trades, 100+ strongly recommended. Returns " +
      "the same full SimResult as simulate_challenge " +
      "(structuredContent, histograms off by default) plus a text summary that also reports the sample's " +
      "win rate and mean R. " +
      "TIMESTAMPED LOGS: tradeLogText accepts a pasted CSV/TSV trade log with a header row (open time " +
      "and R required; close time and direction optional; loose header names are matched; timestamps " +
      "without an offset are read as UTC). The R-series and, unless tradesPerDay is passed, the " +
      "trades-per-day rate are derived from the log, and parse warnings are surfaced in the text " +
      "output. " +
      "NEWS WINDOWS: with a timestamped input, newsFilter runs the simulation TWICE on the same seed " +
      "and options, once on the full history and once without the trades opened inside configurable " +
      "windows around scheduled releases (a built-in recurring-template calendar of high- and " +
      "medium-impact events across USD, EUR, GBP, JPY, AUD, CAD, CHF, NZD, plus optional custom event " +
      "times). The returned SimResult is the news-avoided scenario; structuredContent.newsComparison " +
      "carries both scenarios' pass probability, funded probability and EV, the excluded-trade count, " +
      "and a calendar caveat that must be relayed verbatim. " +
      "PORTFOLIO MODE: tradeLogTexts (2 to 5 logs) merges several timestamped histories into one " +
      "chronological series and simulates the combined account, so cross-strategy loss clustering " +
      "survives. Overlap across the histories is ALWAYS analyzed and attached as " +
      "structuredContent.portfolioOverlap; the text summary carries the audit-risk verdict, and a " +
      "'high' verdict is an explicit warning that a prop firm may audit or refuse payouts for " +
      "correlated accounts. " +
      `${SIMULATED_RULES_DOC} ${UNITS_DOC} ${SEED_DOC} ${ASSUMPTIONS_DOC} ${COMPOSITION_DOC}`,
    inputShape: bootstrapSimulateSchema.shape,
    handler: handleBootstrapSimulate,
  },
  {
    name: "analyze_portfolio_overlap",
    title: "Audit-risk overlap across trade histories",
    description:
      "Measure position overlap across 2 to 5 timestamped trade histories WITHOUT running any " +
      "simulation. WHY THIS MATTERS: prop firms look for accounts that hold positions in the same " +
      "direction at around the same time (copied or correlated strategies across evaluation and funded " +
      "accounts) and can audit, refuse payouts, or close accounts over it. Enforcement is discretionary " +
      "and no firm publishes thresholds, so this tool reports the measured overlap and maps it to " +
      "openly disclosed heuristic bands instead of pretending a hard rule exists: overall overlap " +
      "share under 10% is labeled low, 10% to 30% elevated, and over 30% high. Each log is pasted " +
      "CSV/TSV text with a header row (open time and R required; close time and direction optional). " +
      "A trade counts as overlapping when its open-to-close interval, padded by toleranceMinutes " +
      "(default 5), intersects a trade of another history in the SAME direction. Direction columns " +
      "make the result much more meaningful: without them a time overlap can only be counted as " +
      "direction-unknown, and known opposite-direction overlap (hedging) is not counted at all. " +
      "Returns per-pair overlap counts and shares, the overall and same-direction overlap shares, the " +
      "share of trades with unknown direction, an auditRisk band (low/elevated/high) with a " +
      "plain-language verdict, and a disclosure stating the bands are heuristics rather than any " +
      "firm's policy; relay the verdict and the disclosure to the user. To simulate the merged " +
      "portfolio as one account, pass the same logs to bootstrap_simulate as tradeLogTexts.",
    inputShape: analyzePortfolioOverlapSchema.shape,
    handler: handleAnalyzePortfolioOverlap,
  },
];
