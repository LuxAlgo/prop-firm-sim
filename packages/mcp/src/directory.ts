/*
  Live directory access: the ONLY network the MCP server touches. Firm data
  comes from LuxAlgo's public, keyless directory API (the data behind
  luxalgo.com/prop-firms); the origin can be overridden for staging or
  self-hosted mirrors via LUXALGO_APP_ORIGIN. Inline specs keep every tool
  fully usable offline.
*/

import type { DirectoryFirmRow } from "@luxalgo/prop-firm-sim-core/directory";

export const APP_API_ORIGIN = process.env.LUXALGO_APP_ORIGIN ?? "https://app.luxalgo.com";

interface Envelope {
  data?: { propfirms?: DirectoryFirmRow[] };
  errors?: { message: string }[];
}

let cache: { at: number; firms: DirectoryFirmRow[] } | null = null;
const TTL_MS = 5 * 60 * 1000;

/** Fetch (and briefly cache) every firm in the live directory. */
export async function fetchDirectory(): Promise<DirectoryFirmRow[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.firms;
  let response: Response;
  try {
    response = await fetch(new URL("/api/propfirms/list", APP_API_ORIGIN), {
      headers: { accept: "application/json" },
    });
  } catch (err) {
    throw new Error(
      `The LuxAlgo prop-firm directory is unreachable (${APP_API_ORIGIN}): ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        "Inline `spec` objects work fully offline - pass the ruleset directly instead.",
    );
  }
  if (!response.ok) {
    throw new Error(
      `The LuxAlgo prop-firm directory returned ${response.status}. Try again shortly, or pass an ` +
        "inline `spec` (fully offline).",
    );
  }
  const payload = (await response.json()) as Envelope;
  if (payload.errors?.length) throw new Error(payload.errors[0]!.message);
  const firms = payload.data?.propfirms;
  if (!Array.isArray(firms)) throw new Error("Unexpected directory response shape (no propfirms array).");
  cache = { at: Date.now(), firms };
  return firms;
}

/** Test hook: drop the in-process cache. */
export function clearDirectoryCache(): void {
  cache = null;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Find one firm by directory id or (normalized) name. Throws with the known
 * ids when nothing matches, so agents can self-correct.
 */
export function resolveFirm(firms: DirectoryFirmRow[], idOrName: string): DirectoryFirmRow {
  const wanted = normalize(idOrName);
  const firm =
    firms.find((f) => normalize(f.propfirmId) === wanted) ??
    firms.find((f) => normalize(f.name) === wanted) ??
    firms.find((f) => normalize(f.name).includes(wanted) || wanted.includes(normalize(f.name)));
  if (!firm) {
    const known = firms.map((f) => `${f.propfirmId} (${f.name})`).join(", ");
    throw new Error(`Unknown firm '${idOrName}'. Known directory firms: ${known}.`);
  }
  return firm;
}
