/*
  Recurring economic-event calendar + news-window trade filtering: "what are
  my odds if I don't execute trades around news?".

  Design constraints (engine charter): pure, deterministic, no network, no
  timezone database. High-impact releases are strongly recurring (first-Friday
  NFP, Thursday jobless claims, scheduled central-bank days), so the calendar
  is a set of RECURRENCE TEMPLATES expanded over the trade log's date range -
  an approximation of the real calendar, and every result that uses it must
  carry the 'news-calendar-approximate' caveat (exact dates shift around
  holidays; some banks meet on irregular schedules). Release times are stored
  in the release market's clock and converted with algorithmic US/EU DST rules;
  templates outside those zones note their approximation. Callers can also
  supply exact custom event timestamps and skip the templates entirely.
*/

import type { TradeLogEntry } from "./log.js";

export type NewsImpact = "low" | "medium" | "high";
export type NewsCurrency = "USD" | "EUR" | "GBP" | "JPY" | "AUD" | "CAD" | "CHF" | "NZD";

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/* ---------------- deterministic DST-aware clock conversion --------------- */

function utcDate(year: number, month: number, day: number): number {
  return Date.UTC(year, month, day);
}

/** Day-of-month of the nth given weekday (0=Sun..6=Sat) in a month; nth=-1 = last. */
function nthWeekday(year: number, month: number, weekday: number, nth: number): number {
  if (nth > 0) {
    const firstDow = new Date(utcDate(year, month, 1)).getUTCDay();
    return 1 + ((weekday - firstDow + 7) % 7) + (nth - 1) * 7;
  }
  const daysInMonth = new Date(utcDate(year, month + 1, 0)).getUTCDate();
  const lastDow = new Date(utcDate(year, month, daysInMonth)).getUTCDay();
  return daysInMonth - ((lastDow - weekday + 7) % 7);
}

/** US DST: second Sunday of March to first Sunday of November. */
function usDstActive(ms: number): boolean {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const start = utcDate(year, 2, nthWeekday(year, 2, 0, 2)) + 7 * 3_600_000; // 2am ET ≈ 7:00 UTC
  const end = utcDate(year, 10, nthWeekday(year, 10, 0, 1)) + 6 * 3_600_000;
  return ms >= start && ms < end;
}

/** EU DST: last Sunday of March to last Sunday of October (01:00 UTC). */
function euDstActive(ms: number): boolean {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const start = utcDate(year, 2, nthWeekday(year, 2, 0, -1)) + 3_600_000;
  const end = utcDate(year, 9, nthWeekday(year, 9, 0, -1)) + 3_600_000;
  return ms >= start && ms < end;
}

type ReleaseClock = "ET" | "LONDON" | "CET" | "UTC";

/** UTC timestamp of `hour:minute` on a UTC calendar day, in the given clock. */
function atClock(dayStartMs: number, hour: number, minute: number, clock: ReleaseClock): number {
  const naive = dayStartMs + (hour * 60 + minute) * MS_PER_MINUTE;
  switch (clock) {
    case "UTC":
      return naive;
    case "ET":
      return naive + (usDstActive(naive) ? 4 : 5) * 3_600_000;
    case "LONDON":
      return naive - (euDstActive(naive) ? 1 : 0) * 3_600_000;
    case "CET":
      return naive - (euDstActive(naive) ? 2 : 1) * 3_600_000;
  }
}

/* ------------------------------ templates -------------------------------- */

type Recurrence =
  | { kind: "weekly"; weekday: number }
  | { kind: "monthly-nth-weekday"; weekday: number; nth: number; months?: number[] };

export interface NewsEventTemplate {
  id: string;
  label: string;
  currency: NewsCurrency;
  impact: NewsImpact;
  rule: Recurrence;
  hour: number;
  minute: number;
  clock: ReleaseClock;
  /** How rough the recurrence is; surfaced so nobody mistakes this for a feed. */
  note?: string;
}

/**
 * Built-in recurring templates. High-impact releases recur on stable
 * schedules; entries whose real-world schedule is only mostly regular say so
 * in `note`. There are deliberately no built-in low-impact templates (too
 * many, too irregular) - pass customEventTimes for anything not covered.
 */
export const NEWS_EVENT_TEMPLATES: readonly NewsEventTemplate[] = [
  {
    id: "usd-nfp",
    label: "US Non-Farm Payrolls",
    currency: "USD",
    impact: "high",
    rule: { kind: "monthly-nth-weekday", weekday: 5, nth: 1 },
    hour: 8,
    minute: 30,
    clock: "ET",
  },
  {
    id: "usd-cpi",
    label: "US CPI",
    currency: "USD",
    impact: "high",
    rule: { kind: "monthly-nth-weekday", weekday: 3, nth: 2 },
    hour: 8,
    minute: 30,
    clock: "ET",
    note: "Real dates drift a few days around mid-month.",
  },
  {
    id: "usd-fomc",
    label: "FOMC rate decision",
    currency: "USD",
    impact: "high",
    rule: { kind: "monthly-nth-weekday", weekday: 3, nth: 3, months: [0, 2, 4, 5, 6, 8, 10, 11] },
    hour: 14,
    minute: 0,
    clock: "ET",
    note: "Eight meetings a year on a shifting schedule; modeled as the third Wednesday of typical meeting months.",
  },
  {
    id: "usd-jobless",
    label: "US Initial Jobless Claims",
    currency: "USD",
    impact: "medium",
    rule: { kind: "weekly", weekday: 4 },
    hour: 8,
    minute: 30,
    clock: "ET",
  },
  {
    id: "usd-retail",
    label: "US Retail Sales",
    currency: "USD",
    impact: "medium",
    rule: { kind: "monthly-nth-weekday", weekday: 2, nth: 3 },
    hour: 8,
    minute: 30,
    clock: "ET",
    note: "Approximate mid-month slot.",
  },
  {
    id: "usd-ism",
    label: "US ISM Manufacturing PMI",
    currency: "USD",
    impact: "medium",
    rule: { kind: "monthly-nth-weekday", weekday: 1, nth: 1 },
    hour: 10,
    minute: 0,
    clock: "ET",
    note: "Released the first business day; modeled as the first Monday.",
  },
  {
    id: "eur-ecb",
    label: "ECB rate decision",
    currency: "EUR",
    impact: "high",
    rule: { kind: "monthly-nth-weekday", weekday: 4, nth: 3, months: [0, 2, 3, 5, 6, 8, 9, 11] },
    hour: 14,
    minute: 15,
    clock: "CET",
    note: "Eight meetings a year every six weeks; modeled as the third Thursday of typical meeting months.",
  },
  {
    id: "eur-hicp",
    label: "Euro area flash CPI",
    currency: "EUR",
    impact: "high",
    rule: { kind: "monthly-nth-weekday", weekday: 2, nth: -1 },
    hour: 11,
    minute: 0,
    clock: "CET",
    note: "Approximate end-of-month slot.",
  },
  {
    id: "gbp-boe",
    label: "Bank of England rate decision",
    currency: "GBP",
    impact: "high",
    rule: { kind: "monthly-nth-weekday", weekday: 4, nth: 1, months: [1, 2, 4, 5, 7, 8, 10, 11] },
    hour: 12,
    minute: 0,
    clock: "LONDON",
    note: "Eight meetings a year; modeled as the first Thursday of typical meeting months.",
  },
  {
    id: "gbp-cpi",
    label: "UK CPI",
    currency: "GBP",
    impact: "high",
    rule: { kind: "monthly-nth-weekday", weekday: 3, nth: 3 },
    hour: 7,
    minute: 0,
    clock: "LONDON",
    note: "Approximate mid-month slot.",
  },
  {
    id: "jpy-boj",
    label: "Bank of Japan decision",
    currency: "JPY",
    impact: "high",
    rule: { kind: "monthly-nth-weekday", weekday: 5, nth: 3, months: [0, 2, 3, 5, 6, 8, 9, 11] },
    hour: 3,
    minute: 0,
    clock: "UTC",
    note: "Announcement time varies; Japan has no DST.",
  },
  {
    id: "aud-rba",
    label: "RBA rate decision",
    currency: "AUD",
    impact: "high",
    rule: { kind: "monthly-nth-weekday", weekday: 2, nth: 1, months: [1, 2, 4, 6, 7, 9, 10, 11] },
    hour: 3,
    minute: 30,
    clock: "UTC",
    note: "Sydney clock approximated as fixed UTC (southern-hemisphere DST not modeled).",
  },
  {
    id: "cad-boc",
    label: "Bank of Canada decision",
    currency: "CAD",
    impact: "high",
    rule: { kind: "monthly-nth-weekday", weekday: 3, nth: 2, months: [0, 2, 3, 5, 6, 8, 9, 11] },
    hour: 9,
    minute: 45,
    clock: "ET",
    note: "Eight decisions a year; modeled as the second Wednesday of typical months.",
  },
  {
    id: "cad-jobs",
    label: "Canada employment",
    currency: "CAD",
    impact: "high",
    rule: { kind: "monthly-nth-weekday", weekday: 5, nth: 1 },
    hour: 8,
    minute: 30,
    clock: "ET",
    note: "Usually the same morning as US NFP.",
  },
  {
    id: "chf-snb",
    label: "SNB rate decision",
    currency: "CHF",
    impact: "high",
    rule: { kind: "monthly-nth-weekday", weekday: 4, nth: 3, months: [2, 5, 8, 11] },
    hour: 9,
    minute: 30,
    clock: "CET",
  },
  {
    id: "nzd-rbnz",
    label: "RBNZ rate decision",
    currency: "NZD",
    impact: "high",
    rule: { kind: "monthly-nth-weekday", weekday: 3, nth: 2, months: [1, 3, 4, 6, 7, 9, 10] },
    hour: 2,
    minute: 0,
    clock: "UTC",
    note: "Wellington clock approximated as fixed UTC.",
  },
];

export interface NewsEvent {
  templateId: string;
  label: string;
  currency: NewsCurrency;
  impact: NewsImpact;
  /** Release time, epoch ms UTC. */
  at: number;
}

export interface NewsFilterOptions {
  /** Minutes of avoidance before each event. Default 30. */
  preMinutes?: number;
  /** Minutes of avoidance after each event. Default 30. */
  postMinutes?: number;
  /** Impact levels to avoid. Default ["high"]. */
  impacts?: NewsImpact[];
  /** Currencies to avoid. Default: every built-in currency. */
  currencies?: NewsCurrency[];
  /** Exact extra event times (epoch ms UTC) merged in as impact "high". */
  customEventTimes?: number[];
}

/** Expand the built-in templates into concrete events over [startMs, endMs]. */
export function expandRecurringEvents(
  startMs: number,
  endMs: number,
  options: Pick<NewsFilterOptions, "impacts" | "currencies"> = {},
): NewsEvent[] {
  const impacts = new Set<NewsImpact>(options.impacts ?? ["high"]);
  const currencies = options.currencies !== undefined ? new Set(options.currencies) : null;
  const events: NewsEvent[] = [];

  const startDay = new Date(startMs - MS_PER_DAY);
  const endDay = new Date(endMs + MS_PER_DAY);
  const firstYear = startDay.getUTCFullYear();
  const lastYear = endDay.getUTCFullYear();

  for (const template of NEWS_EVENT_TEMPLATES) {
    if (!impacts.has(template.impact)) continue;
    if (currencies !== null && !currencies.has(template.currency)) continue;

    for (let year = firstYear; year <= lastYear; year++) {
      for (let month = 0; month < 12; month++) {
        if (template.rule.kind === "monthly-nth-weekday") {
          const { weekday, nth, months } = template.rule;
          if (months !== undefined && !months.includes(month)) continue;
          const day = nthWeekday(year, month, weekday, nth);
          const at = atClock(utcDate(year, month, day), template.hour, template.minute, template.clock);
          if (at >= startMs - MS_PER_DAY && at <= endMs + MS_PER_DAY) {
            events.push({
              templateId: template.id,
              label: template.label,
              currency: template.currency,
              impact: template.impact,
              at,
            });
          }
        } else {
          // weekly: every matching weekday of the month
          const daysInMonth = new Date(utcDate(year, month + 1, 0)).getUTCDate();
          for (let day = 1; day <= daysInMonth; day++) {
            if (new Date(utcDate(year, month, day)).getUTCDay() !== template.rule.weekday) continue;
            const at = atClock(utcDate(year, month, day), template.hour, template.minute, template.clock);
            if (at >= startMs - MS_PER_DAY && at <= endMs + MS_PER_DAY) {
              events.push({
                templateId: template.id,
                label: template.label,
                currency: template.currency,
                impact: template.impact,
                at,
              });
            }
          }
        }
      }
    }
  }

  events.sort((a, b) => a.at - b.at);
  return events;
}

export interface NewsFilterResult {
  /** Trades opened outside every avoidance window, in time order. */
  kept: TradeLogEntry[];
  /** Trades opened inside an avoidance window (with the matching event). */
  excluded: { entry: TradeLogEntry; event: NewsEvent }[];
  /** Trades opened before a window but still held through the event. */
  heldThroughCount: number;
  /** Concrete events that fell inside the log's date range. */
  eventsInRange: number;
  options: Required<Omit<NewsFilterOptions, "customEventTimes">> & { customEventTimes: number[] };
  /** Honesty note to surface next to any result built from `kept`. */
  caveat: string;
}

export const NEWS_CALENDAR_CAVEAT =
  "News windows use a recurring-template calendar (plus any custom times), not a historical feed: " +
  "exact release dates drift around holidays and irregular meeting schedules, so treat the with/" +
  "without-news comparison as an estimate and re-check load-bearing conclusions against a real calendar.";

/**
 * Split a timestamped trade log into kept vs news-window trades. A trade is
 * excluded when it was OPENED inside [event − preMinutes, event + postMinutes];
 * trades opened earlier but held through an event are only counted (a slippage
 * concern, not an execution choice).
 */
export function filterTradesAroundNews(
  entries: readonly TradeLogEntry[],
  options: NewsFilterOptions = {},
): NewsFilterResult {
  const preMinutes = options.preMinutes ?? 30;
  const postMinutes = options.postMinutes ?? 30;
  const impacts = options.impacts ?? ["high"];
  const currencies =
    options.currencies ?? (["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"] as NewsCurrency[]);
  const customEventTimes = options.customEventTimes ?? [];

  if (entries.length === 0) {
    return {
      kept: [],
      excluded: [],
      heldThroughCount: 0,
      eventsInRange: 0,
      options: { preMinutes, postMinutes, impacts, currencies, customEventTimes },
      caveat: NEWS_CALENDAR_CAVEAT,
    };
  }

  const startMs = entries[0]!.openedAt;
  const endMs = entries.reduce(
    (max, entry) => Math.max(max, entry.closedAt ?? entry.openedAt),
    entries[0]!.openedAt,
  );
  const events = expandRecurringEvents(startMs, endMs, { impacts, currencies });
  for (const at of customEventTimes) {
    events.push({ templateId: "custom", label: "Custom event", currency: "USD", impact: "high", at });
  }
  events.sort((a, b) => a.at - b.at);

  const pre = preMinutes * MS_PER_MINUTE;
  const post = postMinutes * MS_PER_MINUTE;
  const kept: TradeLogEntry[] = [];
  const excluded: { entry: TradeLogEntry; event: NewsEvent }[] = [];
  let heldThroughCount = 0;

  for (const entry of entries) {
    const hit = events.find((event) => entry.openedAt >= event.at - pre && entry.openedAt <= event.at + post);
    if (hit !== undefined) {
      excluded.push({ entry, event: hit });
      continue;
    }
    if (
      entry.closedAt !== null &&
      events.some((event) => entry.openedAt < event.at - pre && entry.closedAt! > event.at)
    ) {
      heldThroughCount++;
    }
    kept.push(entry);
  }

  const eventsInRange = events.filter(
    (event) => event.at >= startMs - pre && event.at <= endMs + post,
  ).length;
  return {
    kept,
    excluded,
    heldThroughCount,
    eventsInRange,
    options: { preMinutes, postMinutes, impacts, currencies, customEventTimes },
    caveat: NEWS_CALENDAR_CAVEAT,
  };
}
