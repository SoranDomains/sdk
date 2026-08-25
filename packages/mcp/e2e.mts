/* Live e2e: drives the stdio server through a real MCP client — the exact
 * protocol path an agent uses. Phase 1 (no secret): reads + create_wallet.
 * Phase 2 (restart with the created secret): issue to self via a namespace
 * owner, then claim_display_name end to end. Run: npx tsx e2e.mts
 * Needs SORAN_ISSUER_SECRET (a namespace owner) for the issuance step. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let fails = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`);
  if (!ok) fails++;
};
const textOf = (r: { content?: Array<{ type: string; text?: string }> }) =>
  r.content?.find((c) => c.type === "text")?.text ?? "";
const jsonOf = (r: Parameters<typeof textOf>[0]) => JSON.parse(textOf(r));

async function connect(env: Record<string, string>) {
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/stdio.ts"],
      env: { ...process.env as Record<string, string>, ...env },
    }),
  );
  return client;
}

// ---- phase 1: no secret ----
const c1 = await connect({});
const tools1 = (await c1.listTools()).tools.map((t) => t.name);
check("read tools present", ["resolve_name", "lookup_identity", "wallet_names", "network_status"].every((t) => tools1.includes(t)), `${tools1.length} tools`);
check("write tools absent without secret", !tools1.includes("issue_name") && tools1.includes("create_wallet"));

const res = jsonOf(await c1.callTool({ name: "resolve_name", arguments: { name: "alice.nova" } }));
check("resolve_name alice.nova", res.address?.startsWith("GDHNO4WK") && res.assurance?.trustworthy === true, res.address?.slice(0, 8));

const stat = jsonOf(await c1.callTool({ name: "network_status", arguments: {} }));
check("network_status", stat.status?.components?.length >= 3 && stat.stats?.names > 0);

const wallet = jsonOf(await c1.callTool({ name: "create_wallet", arguments: {} }));
check("create_wallet funded", wallet.publicKey?.startsWith("G") && wallet.secret?.startsWith("S"), wallet.publicKey?.slice(0, 8));
await c1.close();

// ---- phase 2: with the new secret ----
const c2 = await connect({ SORAN_SECRET: wallet.secret });
const tools2 = (await c2.listTools()).tools.map((t) => t.name);
check("write tools present with secret", ["issue_name", "set_profile", "claim_display_name", "transfer_name"].every((t) => tools2.includes(t)));

// a namespace owner issues the agent a name (separate server instance = the owner's agent)
const issuer = await connect({ SORAN_SECRET: process.env.SORAN_ISSUER_SECRET! });
const label = `agent-${Date.now().toString(36).slice(-5)}`;
const issued = jsonOf(await issuer.callTool({ name: "issue_name", arguments: { namespace: "acme", label, holder: wallet.publicKey } }));
check("owner agent issues name", typeof issued.hash === "string", `${label}.acme`);

// the agent claims it as its display name (auto setRecord-first path)
const claim = jsonOf(await c2.callTool({ name: "claim_display_name", arguments: { name: `${label}.acme` } }));
check("claim_display_name", claim.done === true && !!claim.steps?.setPrimary, Object.keys(claim.steps ?? {}).join("+"));

const mine = jsonOf(await c2.callTool({ name: "my_wallet", arguments: {} }));
check("my_wallet shows primary", mine.primary === `${label}.acme`, `primary=${mine.primary} xlm=${mine.xlmBalance}`);

const prof = jsonOf(await c2.callTool({ name: "set_profile", arguments: { name: `${label}.acme`, profile: { description: "an AI agent on Soran" } } }));
check("set_profile", Array.isArray(prof) && prof[0]?.key === "description");

// cleanup: clear primary via holder tooling is not exposed — owner reclaims (records die by generation)
const back = jsonOf(await issuer.callTool({ name: "reclaim_name", arguments: { namespace: "acme", label } }));
check("cleanup reclaim", typeof back.hash === "string");
await c2.close(); await issuer.close();

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
