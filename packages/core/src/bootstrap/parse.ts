/**
 * Parse a pasted R-multiple series: JSON array, CSV, or whitespace/newline
 * separated. Accepts an optional "R"/"r" suffix per value ("1.8R, -1R").
 * Throws with the offending token on anything unparseable.
 */
export function parseRSeries(text: string): number[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "number" && Number.isFinite(v))) {
      throw new Error("parseRSeries: JSON input must be an array of finite numbers");
    }
    return parsed;
  }

  return trimmed
    .split(/[\s,;]+/)
    .filter((token) => token.length > 0)
    .map((token) => {
      const value = Number(token.replace(/[Rr]$/, ""));
      if (!Number.isFinite(value)) {
        throw new Error(`parseRSeries: cannot parse "${token}" as an R-multiple`);
      }
      return value;
    });
}
