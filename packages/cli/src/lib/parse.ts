import type { RiskSizing } from "@luxalgo/prop-firm-sim-core";
import { UsageError } from "./errors.js";

export const RISK_MODES = ["percent-of-balance", "percent-of-initial", "fixed-amount"] as const;
export type RiskMode = (typeof RISK_MODES)[number];

export function parseRiskMode(raw: string | undefined): RiskMode | undefined {
  if (raw === undefined) return undefined;
  if ((RISK_MODES as readonly string[]).includes(raw)) return raw as RiskMode;
  throw new UsageError(`--risk-mode must be one of ${RISK_MODES.join(", ")} (got "${raw}")`);
}

/**
 * Parse the --risk flag. "0.5%" and plain "0.5" both mean 0.5% (of the
 * current balance unless --risk-mode says otherwise); under
 * --risk-mode fixed-amount the value is a currency amount ("250", "$1,250").
 */
export function parseRiskFlag(raw: string, mode?: string): RiskSizing {
  const resolvedMode = parseRiskMode(mode) ?? "percent-of-balance";
  let text = raw.trim();
  const isPercent = text.endsWith("%");
  if (isPercent) text = text.slice(0, -1).trim();
  text = text.replace(/^\$/, "").replace(/,/g, "");
  const value = Number(text);
  if (text.length === 0 || !Number.isFinite(value) || value <= 0) {
    throw new UsageError(
      `--risk must be a positive number like "0.5%" or "0.5"` +
        `${resolvedMode === "fixed-amount" ? ", or a currency amount for fixed-amount sizing" : ""}` +
        ` (got "${raw}")`,
    );
  }
  if (isPercent && resolvedMode === "fixed-amount") {
    throw new UsageError(
      `--risk "${raw}" is a percentage, but --risk-mode fixed-amount expects a currency amount (e.g. --risk 500)`,
    );
  }
  return { mode: resolvedMode, value };
}

export interface ChallengeRef {
  firmId: string;
  challengeId: string;
}

/** Parse "ftmo/100k-2step" into { firmId, challengeId }. */
export function parseRef(raw: string): ChallengeRef {
  const parts = raw.split("/");
  const [firmId, challengeId] = parts;
  if (parts.length !== 2 || !firmId || !challengeId) {
    throw new UsageError(
      `invalid challenge reference "${raw}" - expected <firmId>/<challengeId>, e.g. ftmo/100k-2step`,
    );
  }
  return { firmId, challengeId };
}

export interface NumberBounds {
  min?: number;
  max?: number;
  integer?: boolean;
}

/** Parse a numeric flag value with a clean, flag-named error message. */
export function parseNumberFlag(flag: string, raw: string, bounds: NumberBounds = {}): number {
  const value = Number(raw.trim());
  const describe =
    (bounds.integer ? "an integer" : "a number") +
    (bounds.min !== undefined && bounds.max !== undefined
      ? ` between ${bounds.min} and ${bounds.max}`
      : bounds.min !== undefined
        ? ` ≥ ${bounds.min}`
        : "");
  if (
    raw.trim().length === 0 ||
    !Number.isFinite(value) ||
    (bounds.integer && !Number.isInteger(value)) ||
    (bounds.min !== undefined && value < bounds.min) ||
    (bounds.max !== undefined && value > bounds.max)
  ) {
    throw new UsageError(`${flag} must be ${describe} (got "${raw}")`);
  }
  return value;
}

/** --seed accepts a number or any string; digits become a numeric seed. */
export function parseSeedFlag(raw: string): number | string {
  return /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
}
