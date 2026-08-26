/*
  Directory adapter: maps prop-firm rows served by LuxAlgo's public, keyless
  directory API (GET https://app.luxalgo.com/api/propfirms/list - the data
  behind luxalgo.com/prop-firms) into simulatable ChallengeSpec inputs.

  Pure data mapping: no network, no environment access. Callers (the CLI, the
  MCP server, any app) fetch the rows themselves and pass them in.

  Three-tier honesty policy, in order:
  1. Structured rule columns on the row (exact semantics) are used verbatim.
  2. Missing semantics are inferred from the row's free-text fields ONLY when
     one reasonable reading exists; every inferred field is disclosed in
     `inferredFields` and the provenance becomes "directory+inferred".
  3. Ambiguity is refused: a challenge whose max-loss behavior cannot be
     established returns null rather than a guessed simulation.

  When rows carry `sourceUrl`/`lastVerifiedAt`, they pass through as the
  spec's `sources` citation, so results keep pointing at the firm's own page.
*/

import type { ChallengeSpecInput } from "../spec/challenge.js";

/** Max-loss floor behavior. The directory stores locking orthogonally (a
 *  three-value mode plus a lock flag); the spec's fourth mode is composed
 *  from intraday trailing + lock. */
export type DirectoryMaxLossMode =
  "static-initial" | "trailing-realized-eod" | "trailing-intraday-unrealized";

/**
 * One challenge row as served by the directory API. Legacy display fields
 * are always present; the structured rule columns are additive and may be
 * absent or null until the directory backfills them. Unknown extra fields
 * are ignored.
 */
export interface DirectoryChallengeRow {
  challengeId: string;
  challengeName: string;
  accountSize: number;
  /** Number of evaluation steps; 0 means instant funding (one gate step). */
  steps: number;
  profitTarget: number[];
  profitTargetIsPercent: boolean;
  minTradingDays?: number | null;
  dailyLoss?: number | null;
  maxLoss?: number | null;
  /** Legacy free-text semantics, e.g. "Trailing EOD" - heuristics input. */
  dailyLossType?: string | null;
  maxLossType?: string | null;
  /** Legacy shared unit flag for dailyLoss AND maxLoss. */
  lossIsPercent: boolean;
  activationFee?: number | null;
  resetFee?: number | null;
  profitSplitPercent?: number | null;
  payoutFrequency?: string | null;
  isFeeRefundable?: boolean | null;
  price?: number | null;
  interval?: string | null;
  // Structured rule columns (additive; served once backfilled):
  maxLossMode?: DirectoryMaxLossMode | string | null;
  maxLossLocksAtInitial?: boolean | null;
  maxLossLockOffset?: number | null;
  maxLossIsPercent?: boolean | null;
  dailyLossBasis?: string | null;
  dailyLossLimitBasis?: string | null;
  dailyLossIncludesOpenPnl?: boolean | null;
  dailyLossEvaluation?: string | null;
  dailyLossIsPercent?: boolean | null;
  consistencyMaxBestDayPct?: number | null;
  payoutIntervalDays?: number | null;
  payoutMinWinningDays?: number | null;
  payoutWinningDayMinProfit?: number | null;
  payoutMaxPct?: number | null;
  payoutMaxAmount?: number | null;
  payoutBufferAmount?: number | null;
  fundedConsistencyPct?: number | null;
  firstPayoutMinDays?: number | null;
  sourceUrl?: string | null;
  lastVerifiedAt?: string | null;
  [key: string]: unknown;
}

/** One firm as served by the directory API (fields this adapter reads). */
export interface DirectoryFirmRow {
  propfirmId: string;
  name: string;
  productTypes?: string[];
  /** Account currency for the firm's challenges (ISO code); USD when absent. */
  currency?: string | null;
  challenges: DirectoryChallengeRow[];
  [key: string]: unknown;
}

/** Where every simulated rule of an adapted spec came from. */
export type DirectoryProvenance = "directory" | "directory+inferred";

export interface AdaptedChallenge {
  propfirmId: string;
  firmName: string;
  challengeId: string;
  challengeName: string;
  productType: "futures" | "cfd";
  spec: ChallengeSpecInput;
  provenance: DirectoryProvenance;
  /** Spec paths whose values were inferred from free text rather than read
   *  from a structured column - relay these next to any result. */
  inferredFields: string[];
}

const FOUR_MODES = [
  "static-initial",
  "trailing-realized-eod",
  "trailing-intraday-unrealized",
  "trailing-locks-at-initial",
] as const;
type SpecMaxLossMode = (typeof FOUR_MODES)[number];

/**
 * Infer the max-loss mode from legacy free text. Only patterns with one
 * reasonable reading return a value; ambiguity returns null so the caller
 * refuses instead of guessing.
 */
export function inferMaxLossMode(text: string | null | undefined): SpecMaxLossMode | null {
  if (!text) return null;
  const t = text.toLowerCase();
  const trailing = /trail/.test(t);
  if (!trailing) {
    if (/static|initial|fixed|balance based|absolute/.test(t)) return "static-initial";
    return null;
  }
  if (/eod|end.?of.?day|close|realized|settle/.test(t)) return "trailing-realized-eod";
  if (/intraday|unrealized|real.?time|live|tick|open p/.test(t)) return "trailing-intraday-unrealized";
  if (/lock|stop.*(initial|start|breakeven)/.test(t)) return "trailing-locks-at-initial";
  return null; // bare "trailing" is exactly the ambiguity we refuse to guess
}

/** Infer payout frequency from legacy free text; null when unclear. */
export function inferPayoutFrequency(
  text: string | null | undefined,
): "weekly" | "biweekly" | "monthly" | "on-demand" | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/bi.?week|14 day|every 2 week|twice a month|fortnight/.test(t)) return "biweekly";
  if (/week/.test(t)) return "weekly";
  if (/month|30 day/.test(t)) return "monthly";
  if (/demand|any ?time|daily|24|instant|day 1|anytime/.test(t)) return "on-demand";
  return null;
}

function pctOrAmount(value: number, isPercent: boolean): { pct: number } | { amount: number } {
  return isPercent ? { pct: value } : { amount: value };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Map one directory challenge row to a simulatable spec. `firmName` and
 * `productType` come from the parent firm row. Returns null when the
 * max-loss semantics cannot be established from any trusted source - the
 * one rule too consequential to guess.
 */
export function adaptChallenge(
  propfirmId: string,
  firmName: string,
  productType: "futures" | "cfd",
  row: DirectoryChallengeRow,
  currency?: string | null,
): AdaptedChallenge | null {
  const inferredFields: string[] = [];
  const stepCount = Math.max(1, row.steps); // step 0 = instant funding: one gate step

  // --- max loss -----------------------------------------------------------
  if (row.maxLoss == null) return null; // no limit value at all: nothing to simulate
  const maxLossIsPercent = row.maxLossIsPercent ?? row.lossIsPercent;
  let mode = FOUR_MODES.includes(row.maxLossMode as SpecMaxLossMode)
    ? (row.maxLossMode as SpecMaxLossMode)
    : null;
  const structuredMode = mode !== null;
  if (!structuredMode) {
    mode = inferMaxLossMode(row.maxLossType);
    if (mode) inferredFields.push("maxLoss.mode");
  }
  if (!mode) return null;
  // The directory stores locking orthogonally; the spec encodes intraday +
  // lock as its own mode, and the engine ignores locksAtInitial on plain
  // intraday trailing - compose here or the lock is silently dropped.
  if (mode === "trailing-intraday-unrealized" && row.maxLossLocksAtInitial) {
    mode = "trailing-locks-at-initial";
  }
  const maxLoss = {
    ...pctOrAmount(row.maxLoss, maxLossIsPercent),
    mode,
    locksAtInitial: row.maxLossLocksAtInitial ?? false,
    lockOffsetAmount: row.maxLossLockOffset ?? 0,
  };

  // --- daily loss -----------------------------------------------------------
  let dailyLoss: ChallengeSpecInput["dailyLoss"] = null;
  if (row.dailyLoss != null) {
    const dailyLossIsPercent = row.dailyLossIsPercent ?? row.lossIsPercent;
    const structured =
      row.dailyLossBasis != null ||
      row.dailyLossLimitBasis != null ||
      row.dailyLossEvaluation != null ||
      row.dailyLossIncludesOpenPnl != null;
    if (!structured) inferredFields.push("dailyLoss.semantics");
    dailyLoss = {
      ...pctOrAmount(row.dailyLoss, dailyLossIsPercent),
      basis: (row.dailyLossBasis as never) ?? "prior-day-balance",
      limitBasis: (row.dailyLossLimitBasis as never) ?? "initial-balance",
      includesOpenPnl: row.dailyLossIncludesOpenPnl ?? true,
      evaluation: (row.dailyLossEvaluation as never) ?? "intraday",
    };
  }

  // --- steps ----------------------------------------------------------------
  const steps = Array.from({ length: stepCount }, (_, i) => {
    const target = row.profitTarget[i] ?? row.profitTarget.at(-1) ?? 8;
    const consistencyPct = row.consistencyMaxBestDayPct;
    return {
      ...(row.profitTargetIsPercent ? { profitTargetPct: target } : { profitTargetAmount: target }),
      minTradingDays: row.minTradingDays ?? 0,
      maxDays: null,
      ...(consistencyPct ? { consistency: { maxBestDayProfitPct: consistencyPct } } : {}),
    };
  });

  // --- fees -------------------------------------------------------------
  const billing = row.interval && /month/i.test(row.interval) ? "monthly" : "one-time";
  const fees = {
    price: row.price ?? 0,
    billing: billing as "monthly" | "one-time",
    resetFee: row.resetFee ?? null,
    activationFee: row.activationFee ?? 0,
    refundableOnPass: row.isFeeRefundable ?? false,
  };

  // --- funded stage -----------------------------------------------------
  let payoutFrequency = inferPayoutFrequency(row.payoutFrequency);
  if (payoutFrequency && row.payoutFrequency && !row.payoutIntervalDays) {
    inferredFields.push("funded.payoutFrequency");
  }
  if (!payoutFrequency) {
    if (row.payoutFrequency != null) inferredFields.push("funded.payoutFrequency");
    payoutFrequency = "biweekly";
  }
  const hasPayoutRules =
    row.payoutMinWinningDays != null ||
    row.payoutBufferAmount != null ||
    row.payoutMaxPct != null ||
    row.payoutMaxAmount != null ||
    row.fundedConsistencyPct != null;
  const funded = {
    profitSplitPct: row.profitSplitPercent ?? 80,
    payoutFrequency,
    firstPayoutMinDays: row.firstPayoutMinDays ?? 0,
    ...(hasPayoutRules
      ? {
          payoutRules: {
            minWinningDays: row.payoutMinWinningDays ?? 0,
            winningDayMinProfit: row.payoutWinningDayMinProfit ?? 0,
            ...(row.payoutMaxPct ? { maxPayoutPctOfProfit: row.payoutMaxPct } : {}),
            ...(row.payoutMaxAmount ? { maxPayoutAmount: row.payoutMaxAmount } : {}),
            bufferAmount: row.payoutBufferAmount ?? 0,
            ...(row.fundedConsistencyPct ? { consistencyMaxBestDayPct: row.fundedConsistencyPct } : {}),
          },
        }
      : {}),
  };

  const sources =
    row.sourceUrl != null
      ? [
          {
            url: row.sourceUrl,
            lastVerified: row.lastVerifiedAt ? row.lastVerifiedAt.slice(0, 10) : "unverified",
          },
        ]
      : undefined;

  return {
    propfirmId,
    firmName,
    challengeId: row.challengeId,
    challengeName: row.challengeName,
    productType,
    provenance: inferredFields.length > 0 ? "directory+inferred" : "directory",
    inferredFields,
    spec: {
      challengeId: slugify(row.challengeId),
      name: row.challengeName,
      productType,
      accountSize: row.accountSize,
      ...(currency ? { currency } : {}),
      steps,
      dailyLoss,
      maxLoss,
      fees,
      funded,
      flagsNotSimulated: [],
      ...(sources ? { sources } : {}),
    } as ChallengeSpecInput,
  };
}

/**
 * Adapt every challenge of one directory firm row. Challenges whose loss
 * semantics cannot be established are skipped (see adaptChallenge); callers
 * can diff against `firm.challenges` to report what was refused.
 */
export function adaptFirm(firm: DirectoryFirmRow): AdaptedChallenge[] {
  const productType = firm.productTypes?.some((p) => /future/i.test(p)) ? "futures" : "cfd";
  const out: AdaptedChallenge[] = [];
  for (const row of firm.challenges) {
    const adapted = adaptChallenge(firm.propfirmId, firm.name, productType, row, firm.currency);
    if (adapted !== null) out.push(adapted);
  }
  return out;
}
