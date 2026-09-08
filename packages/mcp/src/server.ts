/*
  McpServer wiring: registers the tools from tools.ts. Transport-agnostic -
  index.ts connects a stdio or Streamable HTTP transport. The server performs
  no I/O of its own beyond the transport (zero telemetry).

  MCP 2026-07-28 is stateless: every request may be served by a fresh
  instance, so createServer() is a cheap factory the SDK's serveStdio() /
  createMcpHandler() call per connection or per request.
*/

import { readFileSync } from "node:fs";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
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
        inputSchema: z.object(tool.inputShape),
      },
      async (args: unknown): Promise<CallToolResult> => (await tool.handler(args)) as CallToolResult,
    );
  }
  return server;
}
