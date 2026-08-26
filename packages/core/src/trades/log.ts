/*
  Timestamped trade logs. A plain R-multiple series is enough to simulate, but
  timestamps unlock the context tools: news-window filtering (what are my odds
  if I don't trade around releases?) and portfolio overlap analysis across
  multiple histories. Parsing is deterministic: date strings are hand-parsed
  and treated as UTC unless they carry an explicit offset - no locale, no
  machine timezone.
*/

export interface TradeLogEntry {
  /** Position open time, epoch milliseconds (UTC). */
  openedAt: number;
  /** Position close time, epoch ms; null when the log has no exit column. */
  closedAt: number | null;
  /** Trade direction when the log provides one. */
  direction: "long" | "short" | null;
  /** Result in R-multiples: P&L divided by the amount risked. */
  r: number;
}

export interface ParsedTradeLog {
  entries: TradeLogEntry[];
  /** Non-fatal issues: skipped lines, assumed-UTC note, and similar. */
  warnings: string[];
}

const MS_PER_MINUTE = 60_000;

/**
 * Parse a timestamp deterministically. Accepts ISO 8601 (with or without
 * offset; fractional seconds are truncated), "YYYY-MM-DD HH:mm[:ss]",
 * MT4/MT5-style "YYYY.MM.DD HH:mm[:ss]", and epoch seconds/milliseconds.
 * Times without an explicit offset are UTC. Returns NaN when unparseable.
 */
export function parseTimestamp(raw: string): number {
  const value = raw.trim().replace(/^"|"$/g, "");
  if (value === "") return Number.NaN;

  if (/^\d{10}(\.\d+)?$/.test(value)) return Number(value) * 1000; // epoch seconds
  if (/^\d{13}$/.test(value)) return Number(value); // epoch ms

  const m = value.match(
    /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (!m) return Number.NaN;
  const [, y, mo, d, h, mi, s, offset] = m;
  let ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    h !== undefined ? Number(h) : 0,
    mi !== undefined ? Number(mi) : 0,
    s !== undefined ? Number(s) : 0,
  );
  if (offset !== undefined && offset !== "Z") {
    const sign = offset.startsWith("-") ? -1 : 1;
    const digits = offset.slice(1).replace(":", "");
    const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
    ms -= sign * offsetMinutes * MS_PER_MINUTE;
  }
  return ms;
}

function parseDirection(raw: string): "long" | "short" | null {
  const value = raw.trim().toLowerCase();
  if (/^(long|buy|b|1)$/.test(value)) return "long";
  if (/^(short|sell|s|-1)$/.test(value)) return "short";
  return null;
}

function parseR(raw: string): number {
  const value = raw.trim().replace(/r$/i, "");
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

const OPEN_HEADERS = /^(opened?(_?at|_?time)?|open ?time|entry(_?time)?|date(_?time)?|time|timestamp)$/i;
const CLOSE_HEADERS = /^(closed?(_?at|_?time)?|close ?time|exit(_?time)?)$/i;
const R_HEADERS = /^(r|r_?multiple|rr|result(_?r)?|pnl_?r)$/i;
const DIRECTION_HEADERS = /^(direction|side|type)$/i;

/**
 * Parse a pasted or uploaded trade log: CSV/TSV/semicolon-separated with a
 * header row. Required columns: an open time and an R-multiple result;
 * optional: close time and direction. Column names are matched loosely
 * (openedAt/entry/time/date, closedAt/exit, r/rMultiple/result, direction/side).
 * Rows that fail to parse are skipped and reported in `warnings`; entries come
 * back sorted by open time.
 */
export function parseTradeLog(text: string): ParsedTradeLog {
  const warnings: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length < 2) {
    return { entries: [], warnings: ["Expected a header row plus at least one trade row."] };
  }

  const delimiter = lines[0]!.includes("\t") ? "\t" : lines[0]!.includes(";") ? ";" : ",";
  const headers = lines[0]!.split(delimiter).map((header) => header.trim().replace(/^"|"$/g, ""));
  const openIdx = headers.findIndex((header) => OPEN_HEADERS.test(header));
  const closeIdx = headers.findIndex((header) => CLOSE_HEADERS.test(header));
  const rIdx = headers.findIndex((header) => R_HEADERS.test(header));
  const directionIdx = headers.findIndex((header) => DIRECTION_HEADERS.test(header));

  if (openIdx === -1 || rIdx === -1) {
    return {
      entries: [],
      warnings: [
        `Could not find the required columns in the header (got: ${headers.join(", ")}). ` +
          "Need an open-time column (openedAt/entry/time/date) and an R column (r/rMultiple/result).",
      ],
    };
  }

  const entries: TradeLogEntry[] = [];
  let sawOffset = false;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(delimiter);
    const openRaw = cells[openIdx] ?? "";
    const openedAt = parseTimestamp(openRaw);
    const r = parseR(cells[rIdx] ?? "");
    if (!Number.isFinite(openedAt) || !Number.isFinite(r)) {
      warnings.push(`Row ${i + 1} skipped: unparseable time or R value ("${lines[i]!.slice(0, 60)}").`);
      continue;
    }
    if (/Z|[+-]\d{2}:?\d{2}\s*$/.test(openRaw.trim())) sawOffset = true;
    const closedAt = closeIdx !== -1 ? parseTimestamp(cells[closeIdx] ?? "") : Number.NaN;
    entries.push({
      openedAt,
      closedAt: Number.isFinite(closedAt) ? closedAt : null,
      direction: directionIdx !== -1 ? parseDirection(cells[directionIdx] ?? "") : null,
      r,
    });
  }

  if (entries.length > 0 && !sawOffset) {
    warnings.push(
      "Timestamps carry no timezone offset, so they were read as UTC. If the log is in another " +
        "timezone, news-window matching can be off by that offset.",
    );
  }

  entries.sort((a, b) => a.openedAt - b.openedAt);
  return { entries, warnings };
}

/**
 * Derive the bootstrap inputs from a timestamped log: the chronological
 * R-multiple series and the average trades per distinct UTC trading day.
 */
export function toBootstrapInputs(entries: readonly TradeLogEntry[]): {
  rSeries: number[];
  tradesPerDay: number;
  distinctDays: number;
} {
  const days = new Set<number>();
  for (const entry of entries) days.add(Math.floor(entry.openedAt / 86_400_000));
  const distinctDays = days.size;
  return {
    rSeries: entries.map((entry) => entry.r),
    tradesPerDay: distinctDays > 0 ? entries.length / distinctDays : 0,
    distinctDays,
  };
}
