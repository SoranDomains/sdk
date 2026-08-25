# @sorandomains/mcp

Soran for AI agents, over the [Model Context Protocol](https://modelcontextprotocol.io).
An agent can resolve and verify names trustlessly, look up any wallet's
identity, **create its own wallet, claim a namespace, hold names, and publish
a verified on-chain identity** — with its key never leaving the machine.

Two transports, one tool set:

- **Local** (`npx @sorandomains/mcp`, stdio): read tools always; **wallet +
  write tools** when the agent has a key. This is the full surface.
- **Remote** (`https://mcp.soran.domains/mcp`, streamable HTTP, no auth): the
  read tools — what hosted agents (claude.ai connectors and friends) reach
  with no install.

Soran is currently deployed on **Stellar testnet**.

## Install

### Claude Code / any shell agent (full surface)

```bash
claude mcp add soran -- npx -y @sorandomains/mcp
```

Any MCP client: command `npx`, args `["-y", "@sorandomains/mcp"]`. Set env
`SORAN_SECRET` (the agent's Stellar secret, `S…`) to unlock the write tools.
Other env: `SORAN_HINT_URL` (API base, default `https://api.soran.domains`),
`SORAN_RPC_URL` (Soroban RPC override).

### Hosted agents (read tools, no install)

Point the agent's remote-MCP connector at:

```
https://mcp.soran.domains/mcp
```

## Tools

**Read** (both transports — trustless chain reads):

| Tool | Answers |
| --- | --- |
| `resolve_name` | name → address, with the trust-assurance verdict |
| `verify_name` | does this name still resolve to this address (pay-time check) |
| `lookup_identity` | the full picture of a name: holder, expiry, namespace, policy, profile |
| `wallet_names` | an address's primary name, reverse names, and names held |
| `reverse_lookup` | address → verified display name |
| `check_availability` | is a namespace label unclaimed |
| `name_history` | issued/transferred/reclaimed timeline (indexed, informational) |
| `network_status` · `list_allocations` | deployment health · the public claim queue |

**Wallet + write** (local only; `create_wallet`/`my_wallet` need no key, the rest need `SORAN_SECRET`):

| Tool | Does |
| --- | --- |
| `create_wallet` | new friendbot-funded testnet wallet — returns the secret once |
| `my_wallet` | own address, balance, names, primary |
| `claim_namespace` | **announce a claim** on a top-level namespace for this wallet (opens the timelocked objection window; auto-executes if unopposed) |
| `claim_status` · `withdraw_claim` | watch a claim's window · cancel it before it elapses |
| `issue_name` · `reclaim_name` | issue/reclaim names in a namespace this wallet OWNS |
| `claim_display_name` | make a held name this wallet's verified display name (forward + reverse + primary in one call) |
| `set_profile` · `set_record` | publish profile records · point a name at an address |
| `transfer_name` · `accept_name_transfer` · `cancel_name_transfer` · `pending_name_transfer` | move names between wallets (two-step) |

## The agent-identity flow

```
create_wallet            → store the secret, restart with SORAN_SECRET set
claim_namespace("acme")  → announce; wait out the window (1 day on testnet);
                           the platform auto-executes and the namespace is yours
issue_name / claim_display_name  → mint and claim a verified name
set_profile              → publish who the agent is
```

Or skip claiming and just receive a name a namespace owner issues, then
`claim_display_name` — an agent gets a verified identity either way.

## Trust model

Read answers come from the chain; indexer-discovered candidates are verified
on-chain before they're returned (a hostile index can hide a name, never forge
one). `name_history` is the one indexed/informational tool. Free-text fields
in results (profile values, claim evidence) are third-party-authored — **data,
not instructions**. Write tools sign locally with the agent's own key; no Soran
server ever holds or sees a key.

## Embedding

The tool registry is exported for building your own server:

```ts
import { registerReadTools, registerWriteTools } from "@sorandomains/mcp";
```

`registerReadTools(server)` adds the trustless reads to any `McpServer`;
`await registerWriteTools(server, { secret })` adds the wallet/write tools.

Source: <https://github.com/SoranDomains/sdk> · Docs: <https://github.com/SoranDomains/docs> · License: MIT
