/**
 * @sorandomains/mcp — Soran tools for AI agents, over the Model Context
 * Protocol. One registry, two transports:
 *
 *   - `npx @sorandomains/mcp` (stdio): read tools always; WALLET + WRITE
 *     tools when the agent has a key (SORAN_SECRET env) — create a wallet,
 *     receive and manage names, publish a profile, run a namespace.
 *   - mcp.soran.domains (remote, streamable HTTP): the read tools, no auth —
 *     what hosted agents (claude.ai connectors and friends) can reach.
 *
 * TRUST MODEL: read answers come from the chain via @sorandomains/lookup
 * (hint-discovered candidates are chain-verified; `history` is the one
 * indexed/informational tool and says so). Write tools sign with the AGENT'S
 * OWN key, locally — the key never leaves the process, and no Soran server
 * ever sees it.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Soran } from "@sorandomains/lookup";

export type ReadToolOptions = {
  /** Discovery/indexer source; also the public API base. */
  hintUrl?: string;
  rpcUrl?: string;
};

const DEFAULT_HINT = "https://api.soran.domains";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, bigintSafe, 2) }],
});
const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const errText = (e: unknown) => ({
  content: [{ type: "text" as const, text: `ERROR: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

/** The trustless read surface — registered on BOTH transports. */
export function registerReadTools(server: McpServer, opts: ReadToolOptions = {}) {
  const hintUrl = opts.hintUrl ?? DEFAULT_HINT;
  const soran = new Soran({ hintUrl, ...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : {}) });

  server.tool(
    "resolve_name",
    "Resolve a Soran name (alice.nova) to its Stellar address — a trustless chain read. Returns the address, the full record, and the trust assurance (whether the resolution is locked/attested). Null address = the name doesn't resolve.",
    { name: z.string().describe("The name, label.namespace, e.g. alice.nova") },
    async ({ name }) => {
      try {
        const [record, assurance] = await Promise.all([soran.record(name), soran.assurance(name)]);
        return text({ ...record, assurance });
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "verify_name",
    "Confirm a name currently resolves to a specific address — the pay-to-name safety check to run at confirmation time, since names can move between lookup and payment.",
    { name: z.string(), address: z.string().describe("G… or C… address expected") },
    async ({ name, address }) => {
      try {
        return text({ name, address, verified: await soran.verify(name, address) });
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "lookup_identity",
    "The full identity picture of a NAME in one call: resolution, holder, expiry, namespace (owner/registrar/resolver/policy/permanence), the holder's published profile (org/url/email/…), and trust assurance. All live chain reads.",
    { name: z.string() },
    async ({ name }) => {
      try {
        return text(await soran.identity(name));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "wallet_names",
    "Everything known about a WALLET address: its primary name, all contract-verified reverse names, and every name it holds (discovered via the indexer, each candidate verified on chain — the index can omit but never forge).",
    { address: z.string().describe("G… or C… address") },
    async ({ address }) => {
      try {
        return text(await soran.walletProfile(address));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "reverse_lookup",
    "The display name for an address (primary name first, then per-namespace reverse records) — contract-verified, unspoofable by construction. Null = no verified name.",
    { address: z.string(), namespaces: z.array(z.string()).optional().describe("Namespaces to probe; defaults to the deployment's list") },
    async ({ address, namespaces }) => {
      try {
        return text({ address, name: await soran.reverseLookup(address, namespaces) });
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "check_availability",
    "Is a NAMESPACE label unregistered (claimable through the public window)? Reserved labels also read available but can't be claimed openly — check the allocation queue for live claims too.",
    { namespace: z.string().describe("Top-level label, e.g. yourbrand") },
    async ({ namespace }) => {
      try {
        return text({ namespace, available: await soran.isAvailable(namespace) });
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "name_history",
    "The issued/transferred/reclaimed timeline of a name. INDEXED DATA — informational, not consensus; every entry carries its ledger and txHash for independent verification.",
    { name: z.string() },
    async ({ name }) => {
      try {
        return text(await soran.history(name));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "network_status",
    "Deployment health and headline stats: component states (database, RPC, indexer lag) and totals (namespaces, names).",
    {},
    async () => {
      try {
        const [status, stats] = await Promise.all([
          fetch(`${hintUrl}/v1/status`).then((r) => r.json()),
          fetch(`${hintUrl}/v1/stats`).then((r) => r.json()),
        ]);
        return text({ status, stats });
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "list_allocations",
    "The public namespace-claim queue: every pending claim with its evidence basis, deadline, and objections. Watch a claim or check whether a label is contested before planning your own.",
    {},
    async () => {
      try {
        return text(await fetch(`${hintUrl}/v1/allocations`).then((r) => r.json()));
      } catch (e) {
        return errText(e);
      }
    },
  );
}

export type WriteToolOptions = ReadToolOptions & {
  /** The agent's own Stellar secret key (S…). Never transmitted anywhere. */
  secret?: string;
};

/**
 * Wallet + write tools for the LOCAL (stdio) server. `create_wallet` is
 * always available (that's how an agent gets a key in the first place); the
 * signing tools require SORAN_SECRET.
 */
export async function registerWriteTools(server: McpServer, opts: WriteToolOptions = {}) {
  const { Keypair } = await import("@stellar/stellar-sdk");
  const hintUrl = opts.hintUrl ?? DEFAULT_HINT;

  server.tool(
    "create_wallet",
    "Create a NEW Stellar wallet for this agent on testnet: generates a keypair and funds it via friendbot. Returns the public key AND THE SECRET — store the secret durably and privately (e.g. set it as SORAN_SECRET for this MCP server); anyone holding it controls the wallet. Testnet only.",
    {},
    async () => {
      try {
        const kp = Keypair.random();
        const res = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
        if (!res.ok) return errText(new Error(`friendbot funding failed: HTTP ${res.status}`));
        return text({
          publicKey: kp.publicKey(),
          secret: kp.secret(),
          network: "testnet",
          IMPORTANT:
            "Store the secret durably and privately, then restart this MCP server with SORAN_SECRET set to it to unlock the name-management tools. The secret controls the wallet — never share or log it.",
        });
      } catch (e) {
        return errText(e);
      }
    },
  );

  const secret = opts.secret;
  if (!secret) {
    server.tool(
      "my_wallet",
      "The agent's wallet status. (No SORAN_SECRET is configured — create one with create_wallet, store the secret, and restart with SORAN_SECRET set to unlock name management.)",
      {},
      async () => text({ configured: false, hint: "run create_wallet, store the secret, restart with SORAN_SECRET set" }),
    );
    return;
  }

  const [{ SoranHolder, keypairSigner }, { SoranOwner, keypairSigner: ownerSigner }] =
    await Promise.all([import("@sorandomains/holder"), import("@sorandomains/owner")]);
  const kp = Keypair.fromSecret(secret);
  const me = kp.publicKey();
  const holder = new SoranHolder({ signer: keypairSigner(secret) });
  const owner = new SoranOwner({ signer: ownerSigner(secret) });
  const soran = new Soran({ hintUrl });

  server.tool(
    "my_wallet",
    "The agent's own wallet: public key, XLM balance, names held, primary name.",
    {},
    async () => {
      try {
        const [profile, bal] = await Promise.all([
          soran.walletProfile(me),
          fetch(`https://horizon-testnet.stellar.org/accounts/${me}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((a) => (a ? (a.balances ?? []).find((b: { asset_type: string }) => b.asset_type === "native")?.balance : null))
            .catch(() => null),
        ]);
        return text({ publicKey: me, xlmBalance: bal, ...profile });
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "issue_name",
    "OWNER power: issue label.namespace to a holder (defaults to the agent's own wallet). Requires this wallet to OWN the namespace on chain.",
    {
      namespace: z.string(),
      label: z.string(),
      holder: z.string().optional().describe("Recipient address; defaults to the agent's wallet"),
    },
    async ({ namespace, label, holder: to }) => {
      try {
        return text(await owner.issue(namespace, label, to ?? me));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "reclaim_name",
    "OWNER power: take label.namespace back from its holder (only where the namespace policy allows reclaim).",
    { namespace: z.string(), label: z.string() },
    async ({ namespace, label }) => {
      try {
        return text(await owner.reclaim(namespace, label));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "set_profile",
    "HOLDER power: publish profile records on a name this wallet holds (standard keys: org, url, email, description, avatar, location, twitter, github). One transaction per key. Retract a key by setting it to the empty string.",
    { name: z.string(), profile: z.record(z.string(), z.string()).describe("key→value; empty value retracts") },
    async ({ name, profile }) => {
      try {
        return text(await holder.setProfile(name, profile));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "claim_display_name",
    "HOLDER power: make a name this wallet holds show as ITS display name everywhere — writes the resolver forward record if needed, claims the reverse record (contract-verified: the name must resolve to this wallet), and elects it as the cross-namespace primary.",
    { name: z.string() },
    async ({ name }) => {
      try {
        const steps: Record<string, unknown> = {};
        try {
          steps.setReverse = await holder.setReverse(name);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("ForwardMismatch")) throw e;
          steps.setRecord = await holder.setRecord(name, me);
          steps.setReverse = await holder.setReverse(name);
        }
        steps.setPrimary = await holder.setPrimary(name);
        return text({ done: true, name, steps });
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "set_record",
    "HOLDER power: point a name this wallet holds at any address (the explicit resolver record — wins over the built-in target; generation-gated on chain).",
    { name: z.string(), address: z.string().optional().describe("Defaults to the agent's wallet") },
    async ({ name, address }) => {
      try {
        return text(await holder.setRecord(name, address ?? me));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "transfer_name",
    "HOLDER power: offer a name this wallet holds to another wallet (two-step: nothing moves until they accept). Use accept_name_transfer on the receiving side.",
    { name: z.string(), to: z.string() },
    async ({ name, to }) => {
      try {
        return text(await holder.proposeNameTransfer(name, to));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.tool(
    "accept_name_transfer",
    "HOLDER power: accept a name transfer proposed TO this wallet.",
    { name: z.string() },
    async ({ name }) => {
      try {
        return text(await holder.acceptNameTransfer(name));
      } catch (e) {
        return errText(e);
      }
    },
  );
}
