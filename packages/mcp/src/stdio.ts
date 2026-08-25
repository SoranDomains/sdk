#!/usr/bin/env node
/**
 * Soran MCP server over stdio — `npx @sorandomains/mcp`.
 *
 * Env:
 *   SORAN_SECRET    the agent's Stellar secret (S…) — unlocks wallet/write
 *                   tools; without it, reads + create_wallet only.
 *   SORAN_HINT_URL  discovery/API base (default https://api.soran.domains)
 *   SORAN_RPC_URL   Soroban RPC override (default: testnet public RPC)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerReadTools, registerWriteTools } from "./tools.js";

const server = new McpServer({ name: "soran", version: "0.1.0" });
const opts = {
  hintUrl: process.env.SORAN_HINT_URL,
  rpcUrl: process.env.SORAN_RPC_URL,
};
registerReadTools(server, opts);
await registerWriteTools(server, { ...opts, secret: process.env.SORAN_SECRET });

await server.connect(new StdioServerTransport());
console.error(
  `soran MCP ready (stdio) — reads + create_wallet${process.env.SORAN_SECRET ? " + wallet/write tools" : " (set SORAN_SECRET to unlock write tools)"}`,
);
