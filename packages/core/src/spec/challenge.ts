import { z } from "zod";
import { SlugSchema, SourceRefSchema } from "./common.js";

/*
  The entire credibility of this project is in modeling rule semantics
  precisely. Every enum below is an explicit, documented behavior of the
  engine - if a firm rule cannot be expressed here, the spec must
  flag it in `flagsNotSimulated` rather than approximate it silently.
*/

export const ProductTypeSchema = z
  .enum(["futures", "cfd", "equities"])
  .describe("Instrument class the challenge is traded on.");

export const MaxLossModeSchema = z
  .enum([
    "static-initial",
    "trailing-realized-eod",
    "trailing-intraday-unrealized",
    "trailing-locks-at-initial",
  ])
  .describe(
    "How the max-loss threshold behaves. " +
      "'static-initial': measured from the initial balance and never moves (classic CFD two-step). " +
      "'trailing-realized-eod': the threshold ratchets up with end-of-day balance highs; intraday highs do not move it. " +
      "'trailing-intraday-unrealized': the threshold trails the peak unrealized equity intraday and never stops trailing " +
      "(futures-style; the single most-miscalculated rule in the industry: it reduces pass probability dramatically). " +
      "'trailing-locks-at-initial': trails peak unrealized equity intraday until the threshold reaches the initial balance, then freezes (common futures variant).",
  );

export const DailyLossBasisSchema = z
  .enum(["prior-day-balance", "prior-day-equity"])
  .describe(
    "Anchor today's loss is measured from: the prior day's closing balance, or the prior day's closing equity " +
      "(differs only when positions are held overnight).",
  );

export const DailyLimitBasisSchema = z
  .enum(["initial-balance", "anchor"])
  .describe(
    "What a percentage daily-loss limit is a percentage OF. 'initial-balance': a fixed currency allowance " +
      "(e.g. always 5% of the starting account). 'anchor': recomputed daily from the day's anchor balance/equity.",
  );

export const DailyLossEvaluationSchema = z
  .enum(["intraday", "end-of-day"])
  .describe(
    "'intraday': the account fails the moment equity touches the daily floor. " +
      "'end-of-day': only the day's closing balance is checked against the floor.",
  );

const pctOrAmount = { pct: true, amount: true };
function requireExactlyOne(
  val: { pct?: number | undefined; amount?: number | undefined },
  ctx: z.RefinementCtx,
) {
  const set = Number(val.pct !== undefined) + Number(val.amount !== undefined);
  if (set !== 1) {
    ctx.addIssue({
      code: "custom",
      message: "exactly one of `pct` or `amount` must be set",
      path: Object.keys(pctOrAmount),
    });
  }
}

export const DailyLossRuleSchema = z
  .object({
    pct: z
      .number()
      .positive()
      .max(100)
      .optional()
      .describe("Daily loss limit in percent units (5 = 5%). See `limitBasis` for what it is a percent of."),
    amount: z
      .number()
      .positive()
      .optional()
      .describe("Daily loss limit as a fixed currency amount (alternative to `pct`)."),
    basis: DailyLossBasisSchema.default("prior-day-balance"),
    limitBasis: DailyLimitBasisSchema.default("initial-balance"),
    includesOpenPnl: z
      .boolean()
      .default(true)
      .describe(
        "Whether floating (unrealized) P&L counts toward the daily loss, i.e. breach can happen intra-position.",
      ),
    evaluation: DailyLossEvaluationSchema.default("intraday"),
  })
  .superRefine(requireExactlyOne)
  .describe("Daily loss rule. The daily floor is: anchor − limit, reset at each trading-day boundary.");

export const MaxLossRuleSchema = z
  .object({
    pct: z
      .number()
      .positive()
      .max(100)
      .optional()
      .describe("Max loss in percent units of the initial account size (10 = 10%)."),
    amount: z
      .number()
      .positive()
      .optional()
      .describe("Max loss as a fixed currency amount (alternative to `pct`)."),
    mode: MaxLossModeSchema,
    locksAtInitial: z
      .boolean()
      .default(false)
      .describe(
        "For 'trailing-realized-eod': the floor freezes once it reaches the initial balance (plus " +
          "`lockOffsetAmount`), the common futures funded-account variant. Implied true for " +
          "'trailing-locks-at-initial'; ignored for the other modes.",
      ),
    lockOffsetAmount: z
      .number()
      .min(0)
      .default(0)
      .describe(
        "Currency offset above the initial balance where a locking floor freezes (e.g. 100 for firms that " +
          "lock at start + $100). Only meaningful when the floor locks.",
      ),
  })
  .superRefine(requireExactlyOne)
  .describe("Max (overall) loss rule. `mode` decides whether and how the floor trails the account's peak.");

export const ConsistencyRuleSchema = z
  .object({
    maxBestDayProfitPct: z
      .number()
      .positive()
      .max(100)
      .describe(
        "The best single day's profit may be at most this percent of total profit when the step is passed " +
          "(50 = a 50% consistency rule). Until satisfied, the trader must keep trading past the target.",
      ),
  })
  .describe(
    "Consistency rule, simulated: passing requires total profit of at least bestDay ÷ (pct/100), so one " +
      "outsized day effectively raises the target.",
  );

export const StepSpecSchema = z
  .object({
    profitTargetPct: z
      .number()
      .positive()
      .optional()
      .describe("Profit target in percent units of the initial account size (8 = 8%)."),
    profitTargetAmount: z
      .number()
      .positive()
      .optional()
      .describe("Profit target as a fixed currency amount (alternative to `profitTargetPct`)."),
    minTradingDays: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Minimum number of days with at least one trade before the step can be passed."),
    maxDays: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe("Trading-day limit for the step; null = unlimited time."),
    dailyLoss: DailyLossRuleSchema.nullable()
      .optional()
      .describe(
        "Per-step override of the challenge-level daily loss rule. Omit to inherit; null = no daily loss in this step.",
      ),
    maxLoss: MaxLossRuleSchema.optional().describe("Per-step override of the challenge-level max loss rule."),
    consistency: ConsistencyRuleSchema.nullable()
      .optional()
      .describe("Consistency rule for this step. Omit or null = none."),
  })
  .superRefine((val, ctx) => {
    const set = Number(val.profitTargetPct !== undefined) + Number(val.profitTargetAmount !== undefined);
    if (set !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of `profitTargetPct` or `profitTargetAmount` must be set",
        path: ["profitTargetPct", "profitTargetAmount"],
      });
    }
  })
  .describe("One evaluation step. Each step starts on a fresh account at the initial balance.");

export const BillingSchema = z
  .enum(["one-time", "monthly"])
  .describe(
    "'one-time': the price buys one attempt (failed attempts are re-bought or reset). " +
      "'monthly': the price is a recurring subscription while evaluating (common for futures firms).",
  );

export const FeeSpecSchema = z
  .object({
    price: z
      .number()
      .min(0)
      .describe("Challenge price in account currency. Under 'monthly' billing: price per month."),
    billing: BillingSchema.default("one-time"),
    resetFee: z
      .number()
      .min(0)
      .nullable()
      .default(null)
      .describe(
        "Discounted fee to reset a failed attempt. null = no reset offer (a failed one-time attempt costs full price again; " +
          "a failed monthly attempt rides on the subscription).",
      ),
    activationFee: z
      .number()
      .min(0)
      .default(0)
      .describe("One-time fee charged when the funded account is activated."),
    refundableOnPass: z
      .boolean()
      .default(false)
      .describe("Whether the (one-time) challenge fee is refunded once funded (credited back in cost/EV)."),
  })
  .describe("Fees. Everything that goes into expected total cost.");

export const PayoutFrequencySchema = z
  .enum(["weekly", "biweekly", "monthly", "on-demand"])
  .describe("How often funded profits can be withdrawn.");

export const FundedSpecSchema = z
  .object({
    profitSplitPct: z
      .number()
      .min(0)
      .max(100)
      .describe("Trader's share of funded profits in percent units (80 = 80%)."),
    payoutFrequency: PayoutFrequencySchema,
    firstPayoutMinDays: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Minimum calendar days on the funded account before the first payout."),
    dailyLoss: DailyLossRuleSchema.nullable()
      .optional()
      .describe(
        "Funded-account override of the daily loss rule. Omit to inherit the challenge rule; null = none.",
      ),
    maxLoss: MaxLossRuleSchema.optional().describe(
      "Funded-account override of the max loss rule. Omit to inherit.",
    ),
    payoutRules: z
      .object({
        minWinningDays: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Winning days required in the current payout window before a payout is allowed."),
        winningDayMinProfit: z
          .number()
          .min(0)
          .default(0)
          .describe("Minimum profit for a day to count as a winning day (0 = any positive day)."),
        maxPayoutPctOfProfit: z
          .number()
          .positive()
          .max(100)
          .optional()
          .describe("Each payout may withdraw at most this percent of the account's current profit."),
        maxPayoutAmount: z.number().positive().optional().describe("Hard currency cap per payout request."),
        bufferAmount: z
          .number()
          .min(0)
          .default(0)
          .describe(
            "Profit buffer that must remain in the account; only profit above it is withdrawable " +
              "(common on futures funded accounts).",
          ),
        consistencyMaxBestDayPct: z
          .number()
          .positive()
          .max(100)
          .optional()
          .describe(
            "Funded consistency gate: the best day in the current payout window may be at most this percent " +
              "of the window's profit for a payout to be allowed (evaluated per payout window).",
          ),
      })
      .optional()
      .describe(
        "Payout gating, simulated: winning-day minimums, per-payout caps, profit buffers and funded " +
          "consistency. Omit for simple 'withdraw the profit' terms.",
      ),
    notes: z
      .string()
      .optional()
      .describe("Free-text funded-stage details that are not simulated (e.g. split scaling)."),
  })
  .describe("Funded-stage terms used for the payout/EV simulation.");

/**
 * Rules that are recorded for completeness but NOT simulated. When present
 * they are surfaced in the result's assumption flags, never silently ignored.
 */
export const ConstraintsSpecSchema = z
  .object({
    maxLeverage: z.number().positive().optional(),
    newsTrading: z.boolean().optional().describe("Whether trading around news events is allowed."),
    copyTrading: z.boolean().optional(),
    autoTrading: z.boolean().optional().describe("Whether automated/algorithmic trading is allowed."),
    weekendHolding: z.boolean().optional(),
    overnightHolding: z.boolean().optional(),
    stopLossRequired: z.boolean().optional(),
    maxContractSize: z
      .union([z.number(), z.string(), z.record(z.string(), z.number())])
      .optional()
      .describe("Contract/lot size cap, free-form (number, text, or per-instrument map)."),
  })
  .describe("Informational trading constraints. Recorded and flagged, not simulated.")
  .optional();

export const ChallengeSpecSchema = z
  .object({
    challengeId: SlugSchema,
    name: z.string().min(1).describe('Display name, e.g. "100K 2-Step".'),
    productType: ProductTypeSchema.optional().describe(
      "Instrument class; may be omitted on inline specs or inherited from the firm entry.",
    ),
    accountSize: z.number().positive().describe("Initial account balance in account currency."),
    currency: z
      .string()
      .length(3)
      .default("USD")
      .describe("ISO currency code all amounts are denominated in."),
    steps: z
      .array(StepSpecSchema)
      .min(1)
      .describe("Evaluation steps in order. Passing the last step means funded."),
    dailyLoss: DailyLossRuleSchema.nullable().describe(
      "Challenge-level daily loss rule applied to every step unless a step overrides it. null = no daily loss rule.",
    ),
    maxLoss: MaxLossRuleSchema.describe(
      "Challenge-level max loss rule applied to every step unless a step overrides it.",
    ),
    fees: FeeSpecSchema,
    funded: FundedSpecSchema,
    constraints: ConstraintsSpecSchema,
    flagsNotSimulated: z
      .array(z.string().min(1))
      .default([])
      .describe(
        "Honesty channel: rule ids this entry has that the engine does not simulate " +
          '(e.g. "consistency-rule-40pct", "scaling-plan"). Surfaced in every result.',
      ),
    sources: z
      .array(SourceRefSchema)
      .optional()
      .describe("Public citations. Optional for inline specs; firm files require at least one."),
  })
  .describe("A complete, simulatable challenge ruleset.");

export const FirmFileSchema = z
  .object({
    firmId: SlugSchema,
    name: z.string().min(1),
    website: z.url().describe("The firm's public site root."),
    productType: ProductTypeSchema.describe("Default instrument class for this firm's challenges."),
    notes: z.string().optional(),
    challenges: z
      .array(
        ChallengeSpecSchema.extend({
          sources: z.array(SourceRefSchema).min(1).describe("Public citations. Required in firm files."),
        }),
      )
      .min(1),
  })
  .describe("One firm's community-maintained challenge specs, with citations. Data, not endorsement.");

export type ProductType = z.output<typeof ProductTypeSchema>;
export type MaxLossMode = z.output<typeof MaxLossModeSchema>;
export type DailyLossRule = z.output<typeof DailyLossRuleSchema>;
export type MaxLossRule = z.output<typeof MaxLossRuleSchema>;
export type ConsistencyRule = z.output<typeof ConsistencyRuleSchema>;
export type PayoutRules = NonNullable<z.output<typeof FundedSpecSchema>["payoutRules"]>;
export type StepSpec = z.output<typeof StepSpecSchema>;
export type FeeSpec = z.output<typeof FeeSpecSchema>;
export type FundedSpec = z.output<typeof FundedSpecSchema>;
export type ChallengeSpec = z.output<typeof ChallengeSpecSchema>;
export type ChallengeSpecInput = z.input<typeof ChallengeSpecSchema>;
export type FirmFile = z.output<typeof FirmFileSchema>;
export type FirmFileInput = z.input<typeof FirmFileSchema>;
