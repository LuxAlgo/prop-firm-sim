import { z } from "zod";

export const RiskSizingSchema = z
  .object({
    mode: z
      .enum(["percent-of-balance", "percent-of-initial", "fixed-amount"])
      .default("percent-of-balance")
      .describe(
        "'percent-of-balance': risk compounds with the current balance. " +
          "'percent-of-initial': a constant currency risk derived from the initial account size (how most prop " +
          "traders size, since loss limits are fixed in currency). 'fixed-amount': explicit currency risked per 1R.",
      ),
    value: z
      .number()
      .positive()
      .describe("Percent units for percent modes (0.5 = 0.5%); currency amount for 'fixed-amount'."),
  })
  .describe("How much one R (one unit of risk) is worth per trade.");

const tradesPerDayFields = {
  tradesPerDay: z.number().positive().describe("Average trades per simulated trading day."),
  tradesPerDayModel: z
    .enum(["fixed", "poisson"])
    .default("fixed")
    .describe(
      "'fixed': the same integer count every day. 'poisson': daily count drawn Poisson(tradesPerDay); " +
        "days can then have zero trades, which do not count as trading days.",
    ),
};

export const ParametricProfileSchema = z
  .object({
    kind: z.literal("parametric"),
    winRate: z
      .number()
      .min(0)
      .max(1)
      .describe("Probability a trade is a winner, as a fraction (0.52 = 52%)."),
    avgWinR: z.number().positive().describe("Average winner size in R (multiples of the per-trade risk)."),
    avgLossR: z
      .number()
      .positive()
      .default(1)
      .describe("Average loser size in R, as a positive number (1 = losers lose exactly the risked amount)."),
    winStdR: z
      .number()
      .min(0)
      .default(0)
      .describe(
        "Optional standard deviation of winner size in R (lognormal around avgWinR). 0 = constant winners.",
      ),
    lossStdR: z
      .number()
      .min(0)
      .default(0)
      .describe(
        "Optional standard deviation of loser size in R (lognormal around avgLossR). 0 = constant losers.",
      ),
    ...tradesPerDayFields,
    risk: RiskSizingSchema,
  })
  .describe("Win-rate / R-multiple trader model: Bernoulli(winRate) × (avgWinR | −avgLossR).");

export const BootstrapProfileSchema = z
  .object({
    kind: z.literal("bootstrap"),
    rSeries: z
      .array(z.number())
      .min(10)
      .describe(
        "Historical per-trade outcomes in R, in chronological order (e.g. from your own trade log). " +
          "Resampled with a stationary block bootstrap so streaks are preserved.",
      ),
    blockMeanLength: z
      .number()
      .positive()
      .default(5)
      .describe("Mean block length of the stationary bootstrap (geometric blocks). 1 = i.i.d. resampling."),
    ...tradesPerDayFields,
    risk: RiskSizingSchema,
  })
  .describe("Bootstrap trader model: resamples your real R-multiples, preserving streakiness.");

export const TraderProfileSchema = z
  .discriminatedUnion("kind", [ParametricProfileSchema, BootstrapProfileSchema])
  .describe(
    "Trader statistics driving the simulation. All outcomes are expressed in R (multiples of per-trade risk).",
  );

export type RiskSizing = z.output<typeof RiskSizingSchema>;
export type ParametricProfile = z.output<typeof ParametricProfileSchema>;
export type BootstrapProfile = z.output<typeof BootstrapProfileSchema>;
export type TraderProfile = z.output<typeof TraderProfileSchema>;
export type TraderProfileInput = z.input<typeof TraderProfileSchema>;

/**
 * Broker-statistics shape accepted by {@link fromBrokerStats}: the common
 * output of FIFO round-trip analysis over a real trade history. `avgLoss` may
 * be negative (average of losing PnLs) or positive (average loss magnitude).
 */
export interface BrokerStats {
  winRate: number;
  avgWin: number;
  avgLoss: number;
}

/**
 * Build a parametric TraderProfile from broker round-trip statistics, without
 * this package depending on any specific broker library. Losses are normalized
 * to 1R, winners to avgWin/|avgLoss| R.
 */
export function fromBrokerStats(
  stats: BrokerStats,
  opts: {
    risk: z.input<typeof RiskSizingSchema>;
    tradesPerDay: number;
    tradesPerDayModel?: "fixed" | "poisson";
  },
): ParametricProfile {
  if (!(stats.winRate >= 0 && stats.winRate <= 1)) {
    throw new Error("fromBrokerStats: winRate must be a fraction in [0, 1] (e.g. 0.52 for 52%)");
  }
  const avgLossAbs = Math.abs(stats.avgLoss);
  if (!(stats.avgWin > 0) || !(avgLossAbs > 0)) {
    throw new Error("fromBrokerStats: avgWin and avgLoss must be non-zero");
  }
  return ParametricProfileSchema.parse({
    kind: "parametric",
    winRate: stats.winRate,
    avgWinR: stats.avgWin / avgLossAbs,
    avgLossR: 1,
    tradesPerDay: opts.tradesPerDay,
    ...(opts.tradesPerDayModel ? { tradesPerDayModel: opts.tradesPerDayModel } : {}),
    risk: opts.risk,
  });
}
