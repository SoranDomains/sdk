#!/usr/bin/env node
/**
 * Soran MCP server over stdio — `npx @sorandomains/mcp`.
 *
 * Env:
 *   SORAN_SECRET    the agent's Stellar secret (S…) — unlocks wallet/write
 *                   tools; without it, reads + create_wallet only.
 *   SORAN_HINT_URL  discovery/API base (default https://api.soran.domains)
 *   SORAN_RPC_URL   Soroban RPC override (default: testnet public RPC)
 *   SORAN_PASSPHRASE network passphrase, pinned for signing (default testnet)
 *   NOTE: SORAN_HINT_URL is trusted to prepare the claim/activate transactions
 *   the agent signs — point it only at an API you trust (default is the
 *   canonical api.soran.domains). The signer validates each prepared tx
 *   before signing, but a trusted host is still the intended posture.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { registerReadTools, registerWriteTools } from "./tools.js";

// serverInfo.version derives from package.json so it can never drift from the
// published version again (the hardcoded string sat at 0.3.0 through the
// 0.4.0 release). Resolves from dist/ and from src/ (tsx dev) alike.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const server = new McpServer({ name: "soran", version });
const opts = {
  hintUrl: process.env.SORAN_HINT_URL,
  rpcUrl: process.env.SORAN_RPC_URL,
  passphrase: process.env.SORAN_PASSPHRASE,
  registryId: process.env.SORAN_REGISTRY_ID,
  allocatorId: process.env.SORAN_ALLOCATOR_ID,
  lookupId: process.env.SORAN_LOOKUP_ID,
  primaryId: process.env.SORAN_PRIMARY_ID === "none" ? null : process.env.SORAN_PRIMARY_ID,
  resolutionMode: process.env.SORAN_RESOLUTION_MODE as "universal" | "direct" | undefined,
};
registerReadTools(server, opts);
try {
  await registerWriteTools(server, { ...opts, secret: process.env.SORAN_SECRET });
} catch (e) {
  console.error(`soran MCP: write tools unavailable — ${e instanceof Error ? e.message : e}. Serving read tools only.`);
}

await server.connect(new StdioServerTransport());
console.error(
  `soran MCP ready (stdio) — reads + create_wallet${process.env.SORAN_SECRET ? " + wallet/write tools" : " (set SORAN_SECRET to unlock write tools)"}`,
);
