/*
  McpServer wiring: registers the tools from tools.ts. Transport-agnostic -
  index.ts connects a stdio or Streamable HTTP transport. The server performs
  no I/O of its own beyond the transport (zero telemetry).
*/

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolDefinitions } from "./tools.js";

export const SERVER_NAME = "prop-firm-sim";

let cachedVersion: string | null = null;

/** Version of this package, read once from package.json next to dist/. */
export function serverVersion(): string {
  if (cachedVersion === null) {
    try {
      const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
      cachedVersion = (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
    } catch {
      cachedVersion = "0.0.0";
    }
  }
  return cachedVersion;
}

/** Build a fresh McpServer with every tool in the registry registered. */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: serverVersion() });
  for (const tool of toolDefinitions) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
      },
      async (args: unknown): Promise<CallToolResult> => (await tool.handler(args)) as CallToolResult,
    );
  }
  return server;
}
