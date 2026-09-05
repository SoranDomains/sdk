/* Permission-boundary confirmation over the MCP protocol: three wallets, three
 * on-chain roles. Each connects to its OWN MCP server (its own SORAN_SECRET).
 * A "PASS" on a boundary case means the contract CORRECTLY REJECTED an
 * unauthorized attempt (surfaced as a typed error through the MCP).
 *   Owner   = tenant wallet, owns acme (reclaimable)
 *   Holder  = fresh wallet, holds one acme name, owns no namespace
 *   Stranger= fresh wallet, holds/owns nothing
 * Run: SORAN_OWNER_SECRET=S… npx tsx roles-test.mts */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Keypair } from "@stellar/stellar-sdk";

const OWNER_SECRET = process.env.SORAN_OWNER_SECRET!;
const NS = "acme";
let fails = 0;
const ok = (n: string, c: boolean, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); if (!c) fails++; };
const j = (r: { content?: Array<{ type: string; text?: string }>; isError?: boolean }) => ({
  err: r.isError === true,
  data: (() => { try { return JSON.parse(r.content?.find((c) => c.type === "text")?.text ?? ""); } catch { return r.content?.[0]?.text ?? ""; } })(),
});
const raw = (r: { content?: Array<{ type: string; text?: string }> }) => r.content?.find((c) => c.type === "text")?.text ?? "";
async function agent(secret: string) {
  const c = new Client({ name: "roles", version: "0.0.0" });
  await c.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/stdio.ts"], env: { ...process.env as Record<string,string>, SORAN_SECRET: secret } }));
  return c;
}
const call = (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args }) as Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>;

// ---- setup ----
const holderKp = Keypair.random(), strangerKp = Keypair.random();
await Promise.all([holderKp, strangerKp].map((k) => fetch(`https://friendbot.stellar.org?addr=${k.publicKey()}`).then((r) => { if (!r.ok) throw new Error("friendbot"); })));
const stamp = Date.now().toString(36).slice(-5);
const heldLabel = `roletest-${stamp}`, heldName = `${heldLabel}.${NS}`;

const owner = await agent(OWNER_SECRET);
const holder = await agent(holderKp.secret());
const stranger = await agent(strangerKp.secret());

// tool availability is by KEY-PRESENCE, not role (self-custody: chain enforces authority)
const ownerTools = (await owner.listTools()).tools.map((t) => t.name);
ok("write tools present for any keyed agent", ownerTools.includes("issue_name") && ownerTools.includes("make_permanent"));

// ---- OWNER role (owns acme) ----
console.log("\n-- OWNER (owns acme) --");
const st = j(await call(owner, "namespace_status", { namespace: NS }));
ok("owner: namespace_status isThisWallet", !st.err && st.data?.isThisWallet === true);
const iss = j(await call(owner, "issue_name", { namespace: NS, label: heldLabel, holder: holderKp.publicKey() }));
ok("owner: issue_name → holder", !iss.err && !!iss.data?.hash, iss.err ? String(iss.data).slice(0, 80) : "");

// ---- HOLDER role (holds heldName, does NOT own acme) ----
console.log("\n-- HOLDER (holds " + heldName + ", not owner) --");
const cd = j(await call(holder, "claim_display_name", { name: heldName }));
ok("holder: claim_display_name own name", !cd.err && cd.data?.done === true, cd.err ? String(cd.data).slice(0, 80) : Object.keys(cd.data?.steps ?? {}).join("+"));
const sp = j(await call(holder, "set_profile", { name: heldName, profile: { description: "held by an agent" } }));
ok("holder: set_profile own name", !sp.err && Array.isArray(sp.data));
// boundary: holder CANNOT do owner powers
const hIssue = j(await call(holder, "issue_name", { namespace: NS, label: `x${stamp}`, holder: holderKp.publicKey() }));
ok("holder: issue_name REJECTED (not owner)", hIssue.err && /authorized by|NotNamespaceOwner/i.test(String(hIssue.data)), String(hIssue.data).slice(0, 70));
const hReclaim = j(await call(holder, "reclaim_name", { namespace: NS, label: heldLabel }));
ok("holder: reclaim_name REJECTED (not owner)", hReclaim.err, String(hReclaim.data).slice(0, 70));
// boundary: holder CANNOT manage a name it doesn't hold
const hForeign = j(await call(holder, "set_record", { name: "alice.nova", address: holderKp.publicKey() }));
ok("holder: set_record on foreign name REJECTED (NotHolder)", hForeign.err, String(hForeign.data).slice(0, 70));

// ---- STRANGER role (nothing) ----
console.log("\n-- STRANGER (owns/holds nothing) --");
const resolve = j(await call(stranger, "resolve_name", { name: "alice.nova" }));
ok("stranger: resolve_name (public read) works", !resolve.err && resolve.data?.address?.startsWith("GDHNO4WK"));
const mine = j(await call(stranger, "my_wallet", {}));
ok("stranger: my_wallet works (empty)", !mine.err && (mine.data?.names?.length ?? 0) === 0);
const sIssue = j(await call(stranger, "issue_name", { namespace: NS, label: `z${stamp}`, holder: strangerKp.publicKey() }));
ok("stranger: issue_name REJECTED (not owner)", sIssue.err, String(sIssue.data).slice(0, 70));
const sProfile = j(await call(stranger, "set_profile", { name: "alice.nova", profile: { url: "x" } }));
ok("stranger: set_profile on foreign name REJECTED (NotHolder)", sProfile.err, String(sProfile.data).slice(0, 70));
// but a stranger CAN claim a namespace (permissionless) — announce + withdraw
const claim = j(await call(stranger, "claim_namespace", { label: `strz${stamp}`, basis: ["role test"] }));
ok("stranger: claim_namespace allowed (permissionless announce)", !claim.err && claim.data?.announced === true, claim.err ? String(claim.data).slice(0, 70) : "");
if (!claim.err) await call(stranger, "withdraw_claim", { label: `strz${stamp}` });

// ---- cleanup: owner reclaims the held name ----
await call(owner, "reclaim_name", { namespace: NS, label: heldLabel });

await Promise.all([owner.close(), holder.close(), stranger.close()]);
console.log(fails === 0 ? "\nALL PASS — every role bounded correctly (owner acts, holder/stranger rejected where unauthorized)" : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
