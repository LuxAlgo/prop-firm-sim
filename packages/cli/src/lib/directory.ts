import { adaptFirm } from "@luxalgo/prop-firm-sim-core/directory";
import type {
  AdaptedChallenge,
  DirectoryFirmRow,
  DirectoryProvenance,
} from "@luxalgo/prop-firm-sim-core/directory";
import { UsageError } from "./errors.js";

/*
  The CLI's access to the live LuxAlgo prop-firm directory, the data behind
  luxalgo.com/prop-firms: one keyless, read-only GET plus the lookup helpers
  the commands share. Mapping rows to simulatable specs stays in the core's
  directory adapter; this module only fetches, resolves, and lists.
*/

export const DEFAULT_DIRECTORY_ORIGIN = "https://app.luxalgo.com";

/** The one endpoint the CLI reads. Override the origin with LUXALGO_APP_ORIGIN. */
export function directoryUrl(): string {
  return `${process.env["LUXALGO_APP_ORIGIN"] ?? DEFAULT_DIRECTORY_ORIGIN}/api/propfirms/list`;
}

const OFFLINE_HINT =
  "Inline spec files work fully offline: pass --spec <path to a ChallengeSpec JSON> instead of a firm reference.";

function unreachableError(url: string, reason: string): Error {
  return new Error(
    `the live LuxAlgo directory is unreachable: ${reason} (GET ${url}). ` +
      `Check your connection, or point LUXALGO_APP_ORIGIN at a reachable origin. ${OFFLINE_HINT}`,
  );
}

interface DirectoryEnvelope {
  data?: { propfirms?: unknown };
  errors?: { message?: unknown }[];
}

/**
 * Fetch every firm row from the live directory API (keyless, read-only).
 * Network failures and non-OK responses throw one readable line that points
 * the user at the fully offline --spec path.
 */
export async function fetchDirectory(): Promise<DirectoryFirmRow[]> {
  const url = directoryUrl();
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw unreachableError(url, err instanceof Error ? err.message : String(err));
  }
  if (!response.ok) {
    throw unreachableError(url, `HTTP ${response.status}`);
  }
  let envelope: DirectoryEnvelope;
  try {
    envelope = (await response.json()) as DirectoryEnvelope;
  } catch {
    throw unreachableError(url, "the response body is not JSON");
  }
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
    const messages = envelope.errors
      .map((e) => (typeof e.message === "string" ? e.message : JSON.stringify(e)))
      .join("; ");
    throw new Error(`the live LuxAlgo directory reported an error: ${messages}. ${OFFLINE_HINT}`);
  }
  const rows = envelope.data?.propfirms;
  if (!Array.isArray(rows)) {
    throw unreachableError(url, 'the response has no "data.propfirms" array');
  }
  return rows as DirectoryFirmRow[];
}

/* ------------------------------------------------------------------ */
/* Lookup                                                             */
/* ------------------------------------------------------------------ */

/** Smallest edit distance, for nearest-match suggestions. Plain DP on tiny inputs. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = row[j]!;
      row[j] = next;
    }
  }
  return row[b.length]!;
}

/** How many firms are listed in full before errors switch to nearest matches. */
const FULL_LIST_MAX = 12;

function describeKnownFirms(rows: readonly DirectoryFirmRow[], query: string): string {
  const label = (row: DirectoryFirmRow): string => `${row.propfirmId} (${row.name})`;
  if (rows.length <= FULL_LIST_MAX) {
    return `Known firms: ${rows.map(label).join(", ")}`;
  }
  const q = query.toLowerCase();
  const substring = rows.filter(
    (row) => row.propfirmId.toLowerCase().includes(q) || row.name.toLowerCase().includes(q),
  );
  const nearest =
    substring.length > 0
      ? substring
      : [...rows].sort(
          (a, b) => editDistance(a.propfirmId.toLowerCase(), q) - editDistance(b.propfirmId.toLowerCase(), q),
        );
  return (
    `Nearest matches: ${nearest.slice(0, 8).map(label).join(", ")} ` +
    `(${rows.length} firms total; see \`prop-firm-sim firms\`)`
  );
}

/** Find one firm by propfirmId or by case-insensitive name; throws listing what exists. */
export function resolveFirm(rows: readonly DirectoryFirmRow[], query: string): DirectoryFirmRow {
  const q = query.toLowerCase();
  const firm =
    rows.find((row) => row.propfirmId === query) ??
    rows.find((row) => row.propfirmId.toLowerCase() === q) ??
    rows.find((row) => row.name.toLowerCase() === q);
  if (firm === undefined) {
    throw new UsageError(
      `unknown firm "${query}" in the live LuxAlgo directory (pass a propfirmId or a firm name; ` +
        `names match case-insensitively). ${describeKnownFirms(rows, query)}`,
    );
  }
  return firm;
}

/**
 * Adapt one challenge of a resolved firm. Unknown ids and refused rows (rule
 * text too ambiguous to map, so the adapter declines to guess) both throw a
 * UsageError that lists what the firm actually has.
 */
export function requireAdaptedChallenge(firm: DirectoryFirmRow, challengeId: string): AdaptedChallenge {
  const adapted = adaptFirm(firm);
  const q = challengeId.toLowerCase();
  const hit =
    adapted.find((a) => a.challengeId === challengeId) ??
    adapted.find((a) => a.challengeId.toLowerCase() === q);
  if (hit !== undefined) return hit;

  const simulatable = adapted.map((a) => a.challengeId);
  const knownLine =
    simulatable.length > 0
      ? `Known challenges: ${simulatable.join(", ")}`
      : "No challenge of this firm is simulatable right now";
  const raw = firm.challenges.find(
    (row) => row.challengeId === challengeId || row.challengeId.toLowerCase() === q,
  );
  if (raw !== undefined) {
    throw new UsageError(
      `challenge "${raw.challengeId}" of ${firm.propfirmId} (${firm.name}) is listed in the directory ` +
        `but not simulatable: ambiguous rule text, refused rather than guessed. ${knownLine}. ` +
        `The firm's own page has the full terms.`,
    );
  }
  const refused = firm.challenges.map((row) => row.challengeId).filter((id) => !simulatable.includes(id));
  throw new UsageError(
    `unknown challenge "${challengeId}" for firm "${firm.propfirmId}" (${firm.name}). ${knownLine}` +
      (refused.length > 0 ? `. Not simulatable (ambiguous rule text): ${refused.join(", ")}` : ""),
  );
}

/* ------------------------------------------------------------------ */
/* Listing                                                            */
/* ------------------------------------------------------------------ */

export interface FirmsListingChallenge {
  propfirmId: string;
  firmName: string;
  challengeId: string;
  challengeName: string;
  productType: "futures" | "cfd";
  accountSize: number;
  price: number | null;
  provenance: DirectoryProvenance;
  inferredFields: string[];
}

export interface FirmsListingRefused {
  propfirmId: string;
  firmName: string;
  challengeId: string;
  challengeName: string;
  reason: "ambiguous rule text";
}

export interface FirmsListing {
  challenges: FirmsListingChallenge[];
  /** Served by the directory but refused by the adapter rather than guessed. */
  notSimulatable: FirmsListingRefused[];
}

/** Flatten directory rows into the `firms` listing: adapted challenges plus the refused ones. */
export function buildFirmsListing(
  rows: readonly DirectoryFirmRow[],
  filter?: { productType?: "futures" | "cfd" },
): FirmsListing {
  const challenges: FirmsListingChallenge[] = [];
  const notSimulatable: FirmsListingRefused[] = [];
  for (const firm of rows) {
    // Product type is a firm-level property; this mirrors the core's adaptFirm.
    const productType: "futures" | "cfd" = firm.productTypes?.some((p) => /future/i.test(p))
      ? "futures"
      : "cfd";
    if (filter?.productType !== undefined && productType !== filter.productType) continue;
    const adaptedById = new Map(adaptFirm(firm).map((a) => [a.challengeId, a] as const));
    for (const row of firm.challenges) {
      const adapted = adaptedById.get(row.challengeId);
      if (adapted === undefined) {
        notSimulatable.push({
          propfirmId: firm.propfirmId,
          firmName: firm.name,
          challengeId: row.challengeId,
          challengeName: row.challengeName,
          reason: "ambiguous rule text",
        });
        continue;
      }
      challenges.push({
        propfirmId: firm.propfirmId,
        firmName: firm.name,
        challengeId: adapted.challengeId,
        challengeName: adapted.challengeName,
        productType: adapted.productType,
        accountSize: row.accountSize,
        price: row.price ?? null,
        provenance: adapted.provenance,
        inferredFields: adapted.inferredFields,
      });
    }
  }
  return { challenges, notSimulatable };
}
