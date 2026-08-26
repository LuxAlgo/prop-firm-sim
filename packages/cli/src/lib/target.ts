import { readFileSync } from "node:fs";
import type { ChallengeSpecInput } from "@luxalgo/prop-firm-sim-core";
import type { DirectoryFirmRow, DirectoryProvenance } from "@luxalgo/prop-firm-sim-core/directory";
import { fetchDirectory, requireAdaptedChallenge, resolveFirm } from "./directory.js";
import { UsageError } from "./errors.js";

export interface TargetFlags {
  firm?: string;
  challenge?: string;
  spec?: string;
}

export interface ResolvedTarget {
  spec: ChallengeSpecInput;
  /** Short label for report headers: "ftmo/100k-2step" or the spec file path. */
  ref: string;
  firmName?: string;
  /** Set when the target came from the live directory; absent for --spec files. */
  provenance?: DirectoryProvenance;
  /** Spec paths inferred from disclosed free text; relay them next to results. */
  inferredFields?: string[];
}

export interface TargetIo {
  /** Injectable for tests; defaults to reading the file from disk as UTF-8. */
  readFile?: (path: string) => string;
  /** Injectable for tests; defaults to one GET against the live directory. */
  fetchRows?: () => Promise<readonly DirectoryFirmRow[]>;
}

/**
 * Resolve what to simulate: a live-directory challenge (--firm + --challenge,
 * fetched from LuxAlgo's public keyless directory API) or an inline
 * ChallengeSpec JSON file (--spec, fully offline; nothing is fetched on this
 * path). Unknown firm or challenge references throw listing what exists.
 */
export async function resolveTargetSpec(flags: TargetFlags, io: TargetIo = {}): Promise<ResolvedTarget> {
  const hasDirectoryRef = flags.firm !== undefined || flags.challenge !== undefined;
  if (hasDirectoryRef && flags.spec !== undefined) {
    throw new UsageError("pass either --firm/--challenge or --spec <path>, not both");
  }
  if (flags.spec !== undefined) {
    const readFile = io.readFile ?? ((path: string): string => readFileSync(path, "utf8"));
    let text: string;
    try {
      text = readFile(flags.spec);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new UsageError(`cannot read --spec "${flags.spec}": ${reason}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new UsageError(`--spec "${flags.spec}" is not valid JSON: ${reason}`);
    }
    return { spec: parsed as ChallengeSpecInput, ref: flags.spec };
  }
  if (flags.firm === undefined || flags.challenge === undefined) {
    if (hasDirectoryRef) {
      throw new UsageError("both --firm and --challenge are required to target a directory challenge");
    }
    throw new UsageError(
      "target required: --firm <firmId> --challenge <challengeId> (see `prop-firm-sim firms`), " +
        "or --spec <path to a ChallengeSpec JSON>",
    );
  }
  const rows = await (io.fetchRows ?? fetchDirectory)();
  const firm = resolveFirm(rows, flags.firm);
  const adapted = requireAdaptedChallenge(firm, flags.challenge); // throws listing what exists
  return {
    spec: adapted.spec,
    ref: `${firm.propfirmId}/${adapted.challengeId}`,
    firmName: adapted.firmName,
    provenance: adapted.provenance,
    inferredFields: adapted.inferredFields,
  };
}
