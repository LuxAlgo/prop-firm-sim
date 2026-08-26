/*
  Timestamp parsing for imported files. Builds on the trade-log parser's
  formats (ISO 8601, year-first dotted, epoch seconds/ms) and adds the export
  formats that need file-level decisions: ambiguous slash dates (03/04/2025),
  12-hour AM/PM times, IBKR's compact yyyyMMdd;HHmmss, and split Date + Time
  cells. The month/day order of ambiguous dates is decided ONCE per file from
  provable values (any component > 12); when nothing proves it, month-first
  is assumed WITH a warning and a dateOrder override exists. All times are
  read as UTC unless the value carries an explicit offset.
*/

import { parseTimestamp } from "../trades/log.js";
import { cleanCell } from "./csv.js";
import { addIssue, type DateOrder, type ImportIssue } from "./model.js";

const AMBIGUOUS_DATE =
  /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
const COMPACT_DATETIME = /^(\d{4})(\d{2})(\d{2})[;, ](\d{2})(\d{2})(\d{2})$/;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const TIME_ONLY = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/;

function expandYear(raw: string): number {
  const value = Number(raw);
  if (raw.length === 4) return value;
  return value < 70 ? 2000 + value : 1900 + value;
}

function toUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  if (month < 1 || month > 12 || day < 1 || day > 31) return Number.NaN;
  if (hour > 23 || minute > 59 || second > 59) return Number.NaN;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return Number.NaN; // overflowed (e.g. Feb 31): refuse, never silently roll over
  }
  return ms;
}

function apply12Hour(hourRaw: number, ampm: string | undefined): number {
  if (ampm === undefined) return hourRaw;
  if (hourRaw < 1 || hourRaw > 12) return Number.NaN;
  const pm = ampm.toLowerCase() === "pm";
  if (pm) return hourRaw === 12 ? 12 : hourRaw + 12;
  return hourRaw === 12 ? 0 : hourRaw;
}

/** Evidence about a file's slash-date convention. */
export interface DateOrderScan {
  order: DateOrder | null;
  /** True when at least one value proved the order (a component above 12). */
  provable: boolean;
  /** True when values proved BOTH orders (the file self-contradicts). */
  conflict: boolean;
  /** True when ambiguous dates (both components 12 or below) exist at all. */
  sawAmbiguous: boolean;
  mdyVotes: number;
  dmyVotes: number;
}

/** Scan raw time cells and decide the file's month/day order from provable
 *  values. Deterministic: votes are counted, never sampled. */
export function scanDateOrder(samples: Iterable<string>): DateOrderScan {
  let mdyVotes = 0;
  let dmyVotes = 0;
  let sawAmbiguous = false;
  for (const raw of samples) {
    const m = AMBIGUOUS_DATE.exec(cleanCell(raw));
    if (m === null) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmyVotes++;
    else if (b > 12 && a <= 12) mdyVotes++;
    else if (a <= 12 && b <= 12) sawAmbiguous = true;
  }
  const conflict = mdyVotes > 0 && dmyVotes > 0;
  let order: DateOrder | null = null;
  if (mdyVotes > dmyVotes) order = "MDY";
  else if (dmyVotes > mdyVotes) order = "DMY";
  return { order, provable: mdyVotes + dmyVotes > 0, conflict, sawAmbiguous, mdyVotes, dmyVotes };
}

/** A timestamp parser bound to one file's date-order decision. */
export interface BoundTimestampParser {
  parse: (raw: string) => number;
  order: DateOrder;
  /** True when the order was assumed (nothing proved it) rather than decided. */
  assumed: boolean;
}

/**
 * Decide the file's date order (explicit override beats provable evidence
 * beats the month-first default) and return a parser bound to it. Emits the
 * required diagnostics: an assumption warning when ambiguous dates exist and
 * nothing proves the order, and a conflict warning when the file proves both.
 */
export function buildTimestampParser(
  samples: Iterable<string>,
  override: DateOrder | undefined,
  issues: ImportIssue[],
): BoundTimestampParser {
  const scan = scanDateOrder(samples);
  let order: DateOrder;
  let assumed = false;
  if (override !== undefined) {
    order = override;
  } else if (scan.conflict) {
    order = scan.mdyVotes >= scan.dmyVotes ? "MDY" : "DMY";
    addIssue(
      issues,
      "warning",
      "date-order-conflict",
      `The file contains dates that prove BOTH month-first (${scan.mdyVotes}) and day-first ` +
        `(${scan.dmyVotes}) ordering. The majority reading (${order === "MDY" ? "month-first" : "day-first"}) ` +
        "was used; rows that do not parse under it are skipped. Pass dateOrder to force one reading.",
    );
  } else if (scan.order !== null) {
    order = scan.order;
  } else {
    order = "MDY";
    if (scan.sawAmbiguous) {
      assumed = true;
      addIssue(
        issues,
        "warning",
        "date-order-assumed",
        "Dates like 03/04/2026 are ambiguous and nothing in the file proves the order. Month-first " +
          '(MM/DD) was assumed. Pass dateOrder: "DMY" if these are day-first dates.',
      );
    }
  }
  return { parse: (raw: string) => parseImportTimestamp(raw, order), order, assumed };
}

/**
 * Parse one timestamp cell under a decided date order. Returns epoch ms
 * (UTC unless the value carries an offset) or NaN. Never throws.
 */
export function parseImportTimestamp(raw: string, order: DateOrder): number {
  const s = cleanCell(raw);
  if (s === "") return Number.NaN;

  const core = parseTimestamp(s);
  if (Number.isFinite(core)) return core;

  const compact = COMPACT_DATETIME.exec(s);
  if (compact !== null) {
    return toUtc(
      Number(compact[1]),
      Number(compact[2]),
      Number(compact[3]),
      Number(compact[4]),
      Number(compact[5]),
      Number(compact[6]),
    );
  }
  const compactDate = COMPACT_DATE.exec(s);
  if (compactDate !== null) {
    const month = Number(compactDate[2]);
    const day = Number(compactDate[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return toUtc(Number(compactDate[1]), month, day, 0, 0, 0);
    }
    return Number.NaN;
  }

  const m = AMBIGUOUS_DATE.exec(s);
  if (m !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = expandYear(m[3]!);
    const month = order === "MDY" ? a : b;
    const day = order === "MDY" ? b : a;
    const hour = apply12Hour(m[4] !== undefined ? Number(m[4]) : 0, m[7]);
    if (Number.isNaN(hour)) return Number.NaN;
    return toUtc(
      year,
      month,
      day,
      hour,
      m[5] !== undefined ? Number(m[5]) : 0,
      m[6] !== undefined ? Number(m[6]) : 0,
    );
  }

  return Number.NaN;
}

/** Merge split Date + Time cells into one parseable string. */
export function mergeDateTimeCells(dateRaw: string, timeRaw: string): string {
  const date = cleanCell(dateRaw);
  const time = cleanCell(timeRaw);
  if (date === "") return time;
  if (time === "") return date;
  return `${date} ${time}`;
}

/** True when a cell parses as a bare clock time (a time PART, no date). */
export function isTimeOnlyCell(raw: string): boolean {
  return TIME_ONLY.test(cleanCell(raw));
}
