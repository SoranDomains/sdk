# Soran SDKs

Read and manage Soran names on Stellar. Payment and identity reads use the
configured on-chain contracts through Soroban RPC. Optional API discovery can
omit results; its coverage reports are not proof of completeness. MCP claim
preparation uses the API, with locally pinned transaction and fee validation
before signing. Hosted API and MCP responses are service-mediated; integrators
can call Universal Lookup directly for their own on-chain reads.

| Package | Release version | Audience and surface |
| --- | --- | --- |
| [`@sorandomains/lookup`](packages/lookup/) | 0.6.0 | Wallets and apps: Universal Lookup, complete payment instructions, identity metadata and verified holdings pages |
| [`@sorandomains/owner`](packages/owner/) | 0.6.0 | Namespace operators: issuance, lifecycle, policy and owner-authorized operations |
| [`@sorandomains/holder`](packages/holder/) | 0.4.0 | Name holders: records, payment memos, reverse/Primary and transfers |
| [`@sorandomains/mcp`](packages/mcp/) | 0.6.0 | AI agents: hosted read tools and locally signed management tools |

All four packages target `@stellar/stellar-sdk >=17 <18`, tested with 17.0.1.
The native muxed testnet deployment was verified on chain at ledger **4521644**
on 5 September 2026 (18:10 UTC). Package presets and address tables pin that
deployment. The [release status](https://docs.soran.domains/reference/release-status)
tracks package and service availability separately.
Mainnet has no preset.

Universal Lookup is the default read route. Consume `resolvePayment` results as
the complete address-and-memo pair; address-only methods reject required memos.
The current Soran payment interface supports classic G accounts, G accounts with
ID/text/hash memos, contract C addresses without a memo, and full muxed M
addresses with no separate memo. Muxed account IDs are preserved on chain and are
never silently treated as transaction memos. See [supported addresses and examples](https://docs.soran.domains/concepts/payment-destinations)
and the [public release status](https://docs.soran.domains/reference/release-status).

The packages share conventions and deployment presets. Install only the surfaces
your application needs. The public mirror is [SoranDomains/sdk](https://github.com/SoranDomains/sdk).

See the [deployment manifest](deployments/testnet.json) for contract IDs, code hashes, and verification evidence, and [release notes](RELEASE-0.6.md) for compatibility details.

Run `npm ci`, `npm run build`, `npm run typecheck`, and `npm test` in each package. Lookup, holder, and owner also provide `npm run check:browser`. MCP uses exact matching registry package versions.
