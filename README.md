# Soran SDKs

Read and manage Soran names on Stellar. Payment and identity reads use the configured
on-chain contracts through Soroban RPC. Optional API discovery can omit results;
its coverage reports are not proof of completeness. MCP claim preparation uses the
API, with locally pinned transaction and fee validation before signing.

| Package | Version | Purpose |
|---|---|---|
| [`@sorandomains/lookup`](packages/lookup/) | 0.5.2 | Universal Lookup, complete payment instructions, identity metadata and verified holdings pages |
| [`@sorandomains/holder`](packages/holder/) | 0.3.1 | Holder-authorized records, payment memos, reverse/Primary and transfers |
| [`@sorandomains/owner`](packages/owner/) | 0.5.1 | Namespace issuance, lifecycle, policy and owner operations |
| [`@sorandomains/mcp`](packages/mcp/) | 0.5.1 | Read and locally signed management tools for AI agents |

All four packages target `@stellar/stellar-sdk >=17 <18`, tested with 17.0.1.

```ts
import { Soran } from "@sorandomains/lookup";
const soran = new Soran({ network: "testnet" });
const payment = await soran.resolvePayment("alice.nova");
// Preserve payment.address and payment.memo together.
```

The testnet preset uses the fresh deployment verified on 2026-09-05 at ledger
4520986. See the [public deployment manifest](deployments/testnet.json) for all six
contract IDs, Wasm hashes, deployment transactions and fee configuration. Mainnet
has no preset. The manifest records code at verification time; Lookup governance
can upgrade its implementation without a required delay.

Universal Lookup is the default. Native payment instructions include an explicit
memo. Legacy address results have unknown memo capability and strict payment
methods reject them. A failed universal read never falls back to direct Resolver
reads. Existing direct integrations require explicit `resolutionMode: "direct"`
or `lookupId: null`. Custom Registry/network settings do not inherit unrelated pins.

The SDK is optional: any integrator can call the on-chain Lookup ABI. See the
[lookup package](packages/lookup/) for result types, trust assumptions and
configuration, and the [protocol documentation](https://github.com/SoranDomains/docs).

This repository mirrors the published package source: lookup 0.5.2, holder 0.3.1,
owner 0.5.1 and MCP 0.5.1. MCP's manifest and verified registry lockfile use the
exact matching published SDK versions. Run `npm ci`, `npm run build`, `npm run typecheck` and `npm test`
in each package. Lookup, holder and owner also provide `npm run check:browser`.


Namespace deployment addresses are bound on chain to the namespace, contract role
and nonce. MCP activation independently checks the signed arguments and branded
address before signing. Address generation can return a pending state for retry;
`cancel_namespace_activation` clears an off-chain generation job without changing
a namespace claim or deployed contract.
