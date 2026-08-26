/**
 * Error raised for anything the user typed wrong: bad flags, invalid
 * combinations, unreadable files. The CLI prints its message as a single
 * clean line (no stack trace) and exits with code 1.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface ZodLikeIssue {
  path?: unknown;
  message?: unknown;
}

function isZodLike(err: unknown): err is { issues: ZodLikeIssue[] } {
  return (
    typeof err === "object" &&
    err !== null &&
    Array.isArray((err as { issues?: unknown }).issues) &&
    (err as { issues: unknown[] }).issues.length > 0
  );
}

/**
 * Flatten any thrown value into a single readable line. Zod validation
 * errors (thrown by the core when a spec/profile fails its schema) are
 * reduced to their first issue; everything else keeps its message verbatim,
 * with newlines collapsed.
 */
export function formatErrorMessage(err: unknown): string {
  if (isZodLike(err)) {
    const issues = err.issues;
    const first = issues[0]!;
    const path = Array.isArray(first.path) && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
    const message = typeof first.message === "string" ? first.message : "invalid value";
    const more =
      issues.length > 1 ? ` (+${issues.length - 1} more issue${issues.length > 2 ? "s" : ""})` : "";
    return `invalid input - ${path}${message}${more}`;
  }
  if (err instanceof Error) {
    return err.message.replace(/\s*\n\s*/g, " ").trim();
  }
  return String(err);
}
