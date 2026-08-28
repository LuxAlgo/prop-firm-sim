/*
  Adapter registry. Order matters and breaks ties: signature adapters run
  first (each detect() is a hard fingerprint, never a fuzzy score) and the
  generic fallback is invoked by the orchestrator only when none claims the
  file. Broker JSON leads because it claims only kind:"json" documents,
  which no table adapter reads. ThinkOrSwim next because its fingerprint is
  document-level. The statement adapter runs BEFORE the deals adapter on
  purpose: an MT5 history report carries both a Positions and a Deals
  section, and Positions must win (its S/L column yields calculated R); a
  tester report has no Positions section, so it still lands on Deals.
*/

import { brokerJsonAdapter } from "./broker-json.js";
import { genericCsvAdapter } from "./generic.js";
import { metatraderAdapter } from "./metatrader.js";
import { mt5DealsAdapter } from "./mt5-deals.js";
import { thinkorswimAdapter } from "./thinkorswim.js";
import { tradingviewAdapter } from "./tradingview.js";
import type { ImportAdapter } from "./types.js";

export const SIGNATURE_ADAPTERS: readonly ImportAdapter[] = [
  brokerJsonAdapter,
  thinkorswimAdapter,
  tradingviewAdapter,
  metatraderAdapter,
  mt5DealsAdapter,
];

export const ALL_ADAPTERS: readonly ImportAdapter[] = [...SIGNATURE_ADAPTERS, genericCsvAdapter];

/** Adapter ids and labels, for CLI/MCP help and refusal messages. */
export function listImportAdapters(): Array<{ id: string; label: string }> {
  return ALL_ADAPTERS.map((adapter) => ({ id: adapter.id, label: adapter.label }));
}

export {
  brokerJsonAdapter,
  genericCsvAdapter,
  metatraderAdapter,
  mt5DealsAdapter,
  thinkorswimAdapter,
  tradingviewAdapter,
};
export type {
  AdapterBuildResult,
  AdapterContext,
  AdapterMatch,
  DocTable,
  ImportAdapter,
  ImportDoc,
} from "./types.js";
