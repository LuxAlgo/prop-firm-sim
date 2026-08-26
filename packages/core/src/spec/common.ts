import { z } from "zod";

/** Kebab-case identifier used for firm and challenge ids ("example-firm", "100k-2step"). */
export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case: lowercase letters, digits and single hyphens")
  .describe('Kebab-case identifier, e.g. "100k-2step".');

/** ISO date (YYYY-MM-DD). */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)")
  .describe("ISO date (YYYY-MM-DD).");

/**
 * Public citation for a rule set. Firm rules files should cite the firm's own
 * public page - the firm's page is always authoritative over any encoding of it.
 */
export const SourceRefSchema = z
  .object({
    url: z.url().describe("Public URL on the firm's own site documenting these rules."),
    lastVerified: IsoDateSchema.describe(
      "Date a human last verified the entry against this URL. Bumped only on human-reviewed merges.",
    ),
    note: z.string().optional().describe("Optional note, e.g. which section of the page applies."),
  })
  .describe("Public citation with a human-verified date.");

export type SourceRef = z.output<typeof SourceRefSchema>;
