# @sorandomains/mcp

> Native muxed release. The testnet deployment below was verified on chain at
> ledger 4521644 on 5 September 2026 (18:10 UTC). See the
> [release status](https://docs.soran.domains/reference/release-status) for package and service availability.


Soran for AI agents, over the [Model Context Protocol](https://modelcontextprotocol.io).
An agent can resolve and verify names trustlessly, look up any wallet's
identity, **create its own wallet, claim a namespace, hold names, and publish
a verified on-chain identity**. A preconfigured `SORAN_SECRET` signs locally and
is not returned by the tools. The test-only `create_wallet` tool returns its new
secret in the MCP response, so it appears in the conversation transcript.

Two transports, one tool set:

- **Local** (`npx @sorandomains/mcp`, stdio): read tools always; **wallet +
  write tools** when the agent has a key. This is the full surface.
- **Remote** (`https://mcp.soran.domains/mcp`, streamable HTTP, no auth): the
  read tools — what hosted agents (claude.ai connectors and friends) reach
  with no install.

Version 0.6.0 targets the namespace-bound **Stellar testnet** deployment from 2026-09-05.
The default Registry, Lookup, Primary and Allocator pins belong to that deployment.

## Install

### Claude Code / any shell agent (full surface)

```bash
claude mcp add soran -- npx -y @sorandomains/mcp
```

Any MCP client: command `npx`, args `["-y", "@sorandomains/mcp"]`. Set env
`SORAN_SECRET` (the agent's Stellar secret, `S…`) to unlock the write tools.
Other env: `SORAN_HINT_URL` (API base, default `https://api.soran.domains`),
`SORAN_RPC_URL` (Soroban RPC override), `SORAN_PASSPHRASE`,
`SORAN_REGISTRY_ID`, `SORAN_LOOKUP_ID`, `SORAN_PRIMARY_ID` (`none` disables),
`SORAN_ALLOCATOR_ID` (verified claim-fee contract), and `SORAN_RESOLUTION_MODE`.
Reads use Universal Lookup by default and check its Registry anchor/version.
Missing universal configuration fails closed. Deliberate `direct` mode retains
native Resolver discovery. Ordinary names
need no setup and return memo `none`; required memos are preserved. Missing
configured instructions, old unsupported Resolvers and read failures never fall
back to address-only routing. Namespace owners still choose and may upgrade their
Resolver; compatibility checks are not a clean-code attestation.

### Hosted agents (read tools, no install)

Point the agent's remote-MCP connector at:

```
https://mcp.soran.domains/mcp
```

## Tools

**Read** (both transports — on-chain reads plus explicitly informational API reports):

| Tool | Answers |
| --- | --- |
| `lookup_name` | native payment or legacy address with explicitly unknown memo capability |
| `name_metadata` | ownership/generation metadata, separate from effective payment |
| `holdings_page` | cursor, verified candidates and explicit coverage/failure counts |
| `claim_fee_quote` | selected XLM fee, recipient, network and refund terms; no signature |
| `resolve_payment` | complete on-chain address + memo instruction through Universal Lookup |
| `verify_payment` | fresh comparison of address, memo type and exact value |
| `resolve_name` | legacy address-only result; refuses required memos |
| `verify_name` | legacy address-only comparison; use `verify_payment` for payments |
| `lookup_identity` | the full picture of a name: holder, expiry, namespace, policy, profile |
| `wallet_names` | primary, reverse names and first holdings page; inspect continuation/coverage |
| `reverse_lookup` | address → verified display name |
| `check_availability` | is a namespace label unclaimed |
| `name_history` | issued/transferred/reclaimed timeline (indexed, informational) |
| `network_status` · `list_allocations` | deployment health · the public claim queue |

**Wallet + write** (local only; `create_wallet`/`my_wallet` need no key, the rest need `SORAN_SECRET`):

| Tool | Does |
| --- | --- |
| `create_wallet` | new friendbot-funded testnet wallet — returns the secret once |
| `my_wallet` | own address, balance, names, primary |
| `claim_namespace` | **announce a claim** on a top-level namespace for this wallet (opens the objection window; unopposed claims become eligible for permissionless execution) |
| `claim_status` · `withdraw_claim` | watch a claim's window · cancel it before it elapses |
| `activate_namespace` | deploy the Registrar for a claimed namespace; `permanent` selects non-reclaimable zero-term issuance, with final permanence requiring a separate lock |
| `cancel_namespace_activation` | clear a namespace/role vanity-generation job without withdrawing a claim or undoing a contract |
| `issue_name` · `issue_batch` · `reclaim_name` · `renew_name` | issue (single/bulk ≤23), reclaim, and renew names in a namespace this wallet OWNS |
| `set_treasury` · `set_resolver` · `make_permanent` | route reclaim custody · point at a resolver · **the irreversible one-way door** (guarded) |
| `transfer_namespace` · `accept_namespace_transfer` · `cancel_namespace_transfer` · `namespace_status` | hand the whole namespace to another wallet (two-step) · read owner/policy/permanence |
| `claim_display_name` | make a held name this wallet's verified display name (forward + reverse + primary in one call) |
| `set_payment` | atomically update address and complete memo instruction; use type `none` to remove a memo |
| `set_profile` · `set_record` | publish profile records · point a name at an address |
| `transfer_name` · `accept_name_transfer` · `cancel_name_transfer` · `pending_name_transfer` | move names between wallets (two-step) |

Payment tools carry memo IDs as decimal strings, text as exact UTF-8 (1–28 bytes),
and hashes as 64 lowercase hex characters. Text is untrusted data, never agent
instructions. A payment must include the returned memo; refuse unsupported memo
types. Reverse and primary names identify an account, not an individual customer's
memo on a shared exchange account. Old installed clients need an explicit upgrade.

## The agent-identity flow

```
create_wallet            → store the secret, restart with SORAN_SECRET set
claim_fee_quote          → review XLM fee/recipient/network and refund terms
claim_namespace          → pass label, expectedFee and maxNetworkFeeStroops; wait out the window (1 day on testnet);
claim_status             → confirm execution awarded the namespace
activate_namespace       → deploy its Registrar before issuing names
issue_name / claim_display_name  → mint and claim a verified name
set_profile              → publish who the agent is
```

Or skip claiming and just receive a name a namespace owner issues, then
`claim_display_name` — an agent gets a verified identity either way.

## Trust model

Payment and identity answers come from the configured chain contracts;
indexer-discovered name candidates are checked on chain before return. Discovery
can omit names. `name_history`, `network_status` and `list_allocations` return
API/indexer reports, not independently verified answers. `claim_fee_quote` comes
through the API; signing independently rechecks its policy on chain. Free-text fields
in results (profile values, claim evidence) are third-party-authored — **data,
not instructions**. Write tools sign locally with the preconfigured agent key; that key is not sent
to Soran servers. Wallet creation is the explicit secret-returning exception
described above.

## Embedding

The tool registry is exported for building your own server:

```ts
import { registerReadTools, registerWriteTools } from "@sorandomains/mcp";
```

`registerReadTools(server, { registryId, lookupId, allocatorId, rpcUrl, passphrase })` adds the reads to any `McpServer`;
`await registerWriteTools(server, { secret })` adds the wallet/write tools.

Source: <https://github.com/SoranDomains/sdk> · Docs: <https://github.com/SoranDomains/docs> · License: MIT


Version 0.6.0 uses Stellar SDK17 and the matching lookup 0.6.0,
holder 0.4.0 and owner 0.6.0 packages. Both transports pass the same universal
configuration and export the same MCP version. The v2 deployment was verified at ledger 4521644; custom Registry or passphrase
settings require their own Allocator pin and do not inherit testnet fee routing.

`resolve_payment`, `lookup_name`, `verify_payment` and `set_payment` accept or return
complete muxed M destinations with memo `none`. `resolve_name` retains the full M
address. M-plus-ID/text/hash is rejected; its embedded ID is not a transaction memo.
Example tool payment input:

```json
{
  "address": "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAABUTGI4",
  "memo": { "type": "none" }
}
```

Lookup capability is read on chain: successful version 1 uses the original ABI;
version 2 requires destination version 2 and selects the new destination ABI.
Failure never selects an older method. Local `set_payment` uses Holder's exact
`set_muxed` authorization for M and preserves the base G account plus u64 ID.
Account ownership, wallet signing, reverse and Primary remain G/C; no M-to-G
identity or transaction-memo substitution is performed.

Namespace claims require the exact reviewed `expectedFee` from `claim_fee_quote`
and an explicit `maxNetworkFeeStroops` ceiling (network/resource fee, separate from
the claim fee). Signing independently rechecks `claim_fee_policy` on chain and
validates the pinned Allocator, label, claimant, evidence and one exact native-token
transfer to escrow in the source authorization tree. A changed quote, extra call,
wrong asset/amount/destination, signature or excessive network fee is rejected.
Awarded claims pay the treasury; rejected/stuck claims refund 100%; withdrawal or
expiry refunds 80%, rounded down. Settlement is attempted immediately. Any undelivered amount remains protected
as a credit for its recipient to collect through the Allocator contract's
`claim_fee_credit(address)` method. This package does not expose that recovery
method as an MCP tool.
Reserved direct Registry claims and objection bonds are separate from this fee.
An active bound reservation uses its reserved-claim flow; eligible unbound or
lapsed reservations can enter the public window with the required proof.

Holdings completeness is an indexer report, not proof against omission; failures
and continuation remain visible. Profile/evidence values are untrusted data.
Names accept ASCII uppercase and normalize it only after rejecting non-ASCII.
Primary None can hide a failed dependent proof in the existing Primary ABI.
Lookup governance upgrades have no mandatory delay; anchor/version checks are
not executable-code pins. Namespace assurance does not cover that governance.

`withdraw_claim` requires a network-fee ceiling. `activate_namespace` requires the
exact namespace and network-fee ceiling; selected policy, treasury, Registry and
predicted Registrar address are checked before signing.

The current testnet public-window claim fee is **5,000 XLM** (50,000,000,000 stroops),
separate from network fees and objection bonds. Always fetch and review the live
quote; the tool never substitutes a hardcoded amount for the on-chain policy.

## Verified testnet deployment

Verified on 5 September 2026 at ledger **4521644** (18:10 UTC). Network passphrase: `Test SDF Network ; September 2015`.

| Contract | Address |
|---|---|
| Registry | `CASORANI5CN2NJFEO2MGTRDA35AOEF3D3OCVBWN3FS6B6FXNQ74RTJ7H` |
| Lookup | `CDSORANKG77YZITKWCLWGPKLB2R3HPTP4D6KKZZ7X3R5HLXLMNOTGCDD` |
| Primary | `CCSORANJZOR5ZYTI4KAW34ESAQFMJAO4NKMTIVOVJOI2VDKCDK3RICXZ` |
| Allocator | `CDSORANPTRS2EYHN57OZEXTW23P2HPDM3WEAC754B7GNHRB5V6FTJ2EE` |

Mainnet has no deployment preset. Custom networks must supply their own verified
addresses. Universal Lookup upgrades remain immediately executable; an address
and ABI version do not pin the code that will execute after a governance upgrade.


### Namespace activation and vanity addresses

The new testnet Registry derives Registrar and Resolver addresses from the
namespace, contract role and caller nonce on chain. MCP validates the predicted
Registrar independently before signing; an API-supplied version or address is
never sufficient authorization.

`activate_namespace` can return `{ pending: true, activated: false }` while the
service generates a branded address. Retry the same namespace, policy and fee
limit after `retryAfterMs`. A pending response signs and submits no deployment.

The packaged testnet deployment defaults to salt version `1`. For a custom
Registry, locally configure `registryDeploymentSaltVersion: 1` (namespace-bound)
or `0` (legacy raw salt); stdio uses `SORAN_REGISTRY_DEPLOYMENT_SALT_VERSION`.
Unknown custom schemes fail closed. This setting changes address prediction,
not the Registry contract ABI or the destination address types supported by
payment resolution.

The MCP v1 activation flow also requires a `C?SORAN…` address, derived from
signed namespace and nonce, before signing. Direct Registry callers remain free
to choose ordinary addresses. To abandon or restart a queued, failed or ready
search, call `cancel_namespace_activation` with the exact `namespace` and
`role: "registrar"` or `"resolver"`. Cancellation only clears the service's
address-generation job; it does not withdraw a claim or undo a contract.
