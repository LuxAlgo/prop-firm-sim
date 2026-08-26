import { z } from "zod";
import { FirmFileSchema } from "./challenge.js";

/**
 * JSON Schema for `data/firms/*.json`, generated from the zod spec so the
 * published schema can never drift from what the engine validates.
 * Written to `data/schema/firm.schema.json` by `pnpm schema:generate`.
 */
export function buildFirmFileJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(FirmFileSchema, { target: "draft-7", io: "input" }) as Record<
    string,
    unknown
  >;
  return {
    title: "Prop Firm Sim firm rules file",
    ...schema,
  };
}
