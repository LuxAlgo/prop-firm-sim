/*
  Adapter contract. An adapter owns one export format: detect() is a HARD
  fingerprint (header names plus sample values) that returns detection
  evidence or null, never a fuzzy score; build() converts the claimed
  section into canonical trades. Registry order breaks ties.
*/

import type { TableSection } from "../aliases.js";
import type { CanonicalField, ImportedTrade, ImportIssue, ImportOptions } from "../model.js";

/** A parsed document: one table for CSV, one or more for HTML. */
export interface DocTable {
  rows: string[][];
  /** 1-based source line (CSV) or <tr> ordinal (HTML) per row. */
  rowNumbers: number[];
  /** Candidate header sections, whole table scanned (computed once). */
  sections: TableSection[];
}

export interface ImportDoc {
  kind: "csv" | "html";
  tables: DocTable[];
}

export interface AdapterMatch {
  /** Human-readable detection evidence for the format banner. */
  signals: string[];
  /** Which table and section the adapter claimed. */
  table: number;
  section: TableSection;
}

export interface AdapterContext {
  issues: ImportIssue[];
  options: ImportOptions;
}

export interface AdapterBuildResult {
  trades: ImportedTrade[];
  openTrades: ImportedTrade[];
  header: string[] | null;
  mapping: Partial<Record<CanonicalField, number>>;
  /** Data rows examined and rows skipped, for stats. */
  rows: number;
  skippedRows: number;
  /** "executions" sources may legitimately contain identical trades, so the
   *  orchestrator's dedupe pass skips them. */
  source: "trades" | "events" | "executions";
}

export interface ImportAdapter {
  id: string;
  label: string;
  detect(doc: ImportDoc): AdapterMatch | null;
  build(doc: ImportDoc, match: AdapterMatch, ctx: AdapterContext): AdapterBuildResult;
}

/** Shared helper: normalized header-name set of a section. */
export function normalizedNames(header: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const cell of header) {
    const trimmed = cell
      .trim()
      .toLowerCase()
      .replace(/%/g, "pct")
      .replace(/[^a-z0-9]+/g, "");
    if (trimmed !== "") names.add(trimmed);
  }
  return names;
}
