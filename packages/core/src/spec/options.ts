import { z } from "zod";

export const SimOptionsSchema = z
  .object({
    paths: z
      .number()
      .int()
      .min(100)
      .max(1_000_000)
      .default(10_000)
      .describe("Number of Monte Carlo paths (independent simulated trader journeys)."),
    seed: z
      .union([z.number().int(), z.string()])
      .default(42)
      .describe("RNG seed. Same spec + profile + options + seed ⇒ byte-identical result."),
    attemptCap: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(25)
      .describe(
        "Maximum challenge attempts per path before the path gives up (censors the attempts distribution).",
      ),
    simulateFunded: z
      .boolean()
      .default(true)
      .describe("Whether to simulate the funded stage (payouts, EV) after passing."),
    fundedHorizonDays: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .default(90)
      .describe("Funded-stage horizon in trading days for the payout/EV simulation."),
    unlimitedStepDayCap: z
      .number()
      .int()
      .min(10)
      .max(5000)
      .default(365)
      .describe(
        "Safety cap (trading days) for steps with no time limit; a step still unresolved at the cap counts as " +
          "an abandoned (failed) attempt and is flagged in the assumptions.",
      ),
    includeHistograms: z
      .boolean()
      .default(true)
      .describe("Include histogram arrays in the result (disable for compact transport)."),
    tracePaths: z
      .number()
      .int()
      .min(0)
      .max(2000)
      .default(0)
      .describe(
        "Record day-by-day equity and the effective loss floor for the FIRST attempt (and funded stretch) " +
          "of this many paths, for visualization. Pure observation: tracing never changes the numbers.",
      ),
  })
  .describe("Simulation options.");

export type SimOptions = z.output<typeof SimOptionsSchema>;
export type SimOptionsInput = z.input<typeof SimOptionsSchema>;
