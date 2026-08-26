/** Formatting helpers shared by every renderer. Pure string functions. */

export interface RenderOptions {
  /** Emit ANSI styling (dim/bold). Off by default so rendered text is plain. */
  color?: boolean;
}

export function dim(text: string, opts?: RenderOptions): string {
  return opts?.color ? `\u001b[2m${text}\u001b[22m` : text;
}

export function bold(text: string, opts?: RenderOptions): string {
  return opts?.color ? `\u001b[1m${text}\u001b[22m` : text;
}

/** "0.234" → "23.4%". NaN/undefined/null → "n/a". */
export function fmtPct(fraction: number | null | undefined, decimals = 1): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "n/a";
  return `${(fraction * 100).toFixed(decimals)}%`;
}

/** Wilson interval → "95% CI 22.6–24.2%". */
export function fmtCi(ci: { low: number; high: number }): string {
  return `95% CI ${(ci.low * 100).toFixed(1)}–${(ci.high * 100).toFixed(1)}%`;
}

/**
 * Currency with thousands separators and the spec's currency code:
 * 2268.4 → "2,268 USD". Small magnitudes keep cents; `sign` forces a leading
 * "+" on positives (for EV lines).
 */
export function fmtMoney(
  value: number | null | undefined,
  currency: string,
  opts?: { sign?: boolean },
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  const decimals = Math.abs(value) < 100 && !Number.isInteger(value) ? 2 : 0;
  const text = value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const signed = opts?.sign && value > 0 ? `+${text}` : text;
  return `${signed} ${currency}`;
}

/** Plain number, at most `maxDecimals`, trailing zeros trimmed. NaN → "n/a". */
export function fmtNum(value: number | null | undefined, maxDecimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  const fixed = value.toFixed(maxDecimals);
  return maxDecimals > 0 ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** Integer with thousands separators (for path counts). */
export function fmtInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Word-wrap `text` to `width` columns, prefixing every line with `indent`. */
export function wrap(text: string, width = 98, indent = ""): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (indent.length + candidate.length > width && line.length > 0) {
      lines.push(indent + line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line.length > 0) lines.push(indent + line);
  return lines.join("\n");
}

export interface TableColumn {
  header: string;
  align?: "left" | "right";
}

/**
 * Render an aligned, borderless table: headers, then rows, columns separated
 * by two spaces. Cell values must be pre-formatted strings.
 */
export function renderTable(columns: TableColumn[], rows: string[][], indent = ""): string {
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const pad = (text: string, i: number): string => {
    const width = widths[i] ?? text.length;
    return columns[i]?.align === "right" ? text.padStart(width) : text.padEnd(width);
  };
  const headerLine = indent + columns.map((col, i) => pad(col.header, i)).join("  ");
  const rowLines = rows.map((row) => indent + columns.map((_, i) => pad(row[i] ?? "", i)).join("  "));
  return [headerLine, ...rowLines].map((line) => line.replace(/\s+$/, "")).join("\n");
}
