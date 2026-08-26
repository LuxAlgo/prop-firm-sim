#!/usr/bin/env node
/*
  Entry point for the prop-firm-sim MCP server binary.

  Default transport is stdio (for process-spawned MCP clients). `--http [port]`
  serves the same six tools over the MCP Streamable HTTP transport on
  POST /mcp, using node:http with the SDK's stateless per-request pattern
  (a fresh server + transport per request; no sessions to leak). The port also
  honors the PROP_FIRM_SIM_MCP_PORT environment variable.

  There are no other endpoints and no outbound network calls of any kind -
  the optional HTTP listener is the only network surface (zero telemetry).
*/

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SERVER_NAME, createServer, serverVersion } from "./server.js";

const DEFAULT_PORT = 3711;

const USAGE = `Usage: prop-firm-sim-mcp [options]

Options:
  (none)         run as an MCP server over stdio (default; for MCP client configs)
  --http [port]  serve MCP over Streamable HTTP on POST /mcp (default port ${DEFAULT_PORT})
  --help, -h     show this help
  --version, -v  print the server version

Environment:
  PROP_FIRM_SIM_MCP_PORT  HTTP port used with --http when no port argument is given
`;

interface CliOptions {
  http: boolean;
  port: number;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function parsePort(raw: string, source: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`Invalid port from ${source}: "${raw}" (expected an integer 1-65535).`);
  }
  return port;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let http = false;
  let port: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg === "--version" || arg === "-v") {
      process.stdout.write(`${SERVER_NAME} ${serverVersion()}\n`);
      process.exit(0);
    } else if (arg === "--http") {
      http = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        port = parsePort(next, "--http argument");
        i++;
      }
    } else {
      fail(`Unknown argument: "${arg}".`);
    }
  }

  if (port === undefined) {
    const envPort = process.env.PROP_FIRM_SIM_MCP_PORT;
    port =
      envPort !== undefined && envPort !== "" ? parsePort(envPort, "PROP_FIRM_SIM_MCP_PORT") : DEFAULT_PORT;
  }

  return { http, port };
}

function writeJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/** Stateless Streamable HTTP: a fresh server + transport per request. */
async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];
  if (path !== "/mcp") {
    writeJsonRpcError(res, 404, -32000, "Not found. The only endpoint is POST /mcp.");
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeJsonRpcError(res, 405, -32000, "Method not allowed. This stateless server only accepts POST /mcp.");
    return;
  }
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    process.stderr.write(`Error handling MCP request: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!res.headersSent) {
      writeJsonRpcError(res, 500, -32603, "Internal server error.");
    }
  }
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));

  if (options.http) {
    const httpServer = createHttpServer((req, res) => {
      void handleHttpRequest(req, res);
    });
    httpServer.listen(options.port, () => {
      process.stderr.write(
        `${SERVER_NAME} v${serverVersion()} listening on http://localhost:${options.port}/mcp ` +
          "(MCP Streamable HTTP, stateless)\n",
      );
    });
    return;
  }

  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdout belongs to the protocol; status goes to stderr.
  process.stderr.write(`${SERVER_NAME} v${serverVersion()} running on stdio\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
