# Soran SDKs

Read and manage Soran names on Stellar. Payment and identity reads use the
configured on-chain contracts through Soroban RPC. Optional API discovery can
omit results; its coverage reports are not proof of completeness. MCP namespace application and activation
preparation use the API, with locally pinned transaction and fee validation
before signing. Hosted API and MCP responses are service-mediated; integrators
can call Universal Lookup directly for their own on-chain reads.

| Package | Published version | Audience and surface |
| --- | --- | --- |
| [`@sorandomains/lookup`](packages/lookup/) | 0.11.0 | Wallets and apps: Universal Lookup, nested names, network addresses, complete payment instructions and verified holdings pages |
| [`@sorandomains/owner`](packages/owner/) | 0.12.0 | Namespace operators: issuance, lifecycle, subname and network-address policies |
| [`@sorandomains/holder`](packages/holder/) | 0.10.0 | Name holders: subnames, network addresses, payment memos and lifecycle |
| [`@sorandomains/mcp`](packages/mcp/) | 0.10.0 | AI agents: hosted read tools and locally signed management tools |

All four releases require Node.js 22.12.0 or newer.
All four packages target `@stellar/stellar-sdk >=17 <18`, tested with 17.0.1.
The governed testnet migration was sealed at ledger **4604192** on **10 September 2026**. Universal Lookup and Allocator retain their addresses; Registry, Primary and Nova's Registrar/Resolver use the successor addresses in the [current deployment manifest](deployments/testnet.json). All six active contracts support authorized code upgrades. The migration preserved 37 existing names, 34 original claim receipts and the original namespace claim windows and escrow. The [release status](https://docs.soran.domains/reference/release-status) records matching packages and hosted services. Mainnet has no preset.

Universal Lookup is the default read route. Consume `resolvePayment` results as
the complete address-and-memo pair; address-only methods reject required memos.
The current Soran payment interface supports classic G accounts, G accounts with
ID/text/hash memos, contract C addresses without a memo, and full muxed M
addresses with no separate memo. Muxed account IDs are preserved on chain and are
never silently treated as transaction memos. Reverse and primary lookups
match the complete M address, including its routing ID; the underlying G account
authorizes these separate display-name elections. See [supported addresses and examples](https://docs.soran.domains/concepts/payment-destinations)
and the [public release status](https://docs.soran.domains/reference/release-status).

The packages share conventions and deployment presets. Install only the surfaces
your application needs. The public mirror is [SoranDomains/sdk](https://github.com/SoranDomains/sdk).

Namespace owners configure native public admission once, then claimants authorize their own exact claims without the owner approving each user. The owner's application embeds the SDK in its own signup/account settings UI. Optional app approval is a separate bounded admission role. See [native claims and recovery](NATIVE-CLAIMS.md) and the [signup reference](examples/native-signup/README.md). Owner 0.12.0 and Holder 0.10.0 provide these writes; Lookup 0.11.0 keeps Universal Lookup as the read entry point.

The testnet preset selects this verified successor deployment. Only the explicitly reviewed on-chain migration carries the preserved state across. Identical spellings in unrelated Registries remain separate identities. Historical claim recovery requires the original saved intent and a sealed lineage verified through the trusted Lookup; it never automatically retries the claim.

See the [current deployment manifest](deployments/testnet.json). Run `npm ci`, `npm run build`, `npm run typecheck` and `npm test` in each package; Lookup, Owner and Holder also provide `npm run check:browser`, and Owner and Holder `npm run test:hardening`.

## Older versions and retired stacks

The governed testnet stacks of 5 and 6 September 2026 were sealed by migration. Lookup 0.6.0 to 0.9.0, and the Holder, Owner and MCP releases built against them, default to those retired Registries. Against today's shared Lookup their default (universal) mode fails closed with `CONFIG` ("Lookup has an invalid or different Registry anchor"). `resolutionMode: "direct"`, `lookupId: null` or a hard-coded retired Registry bypasses that check, and the 6 September stack can still answer reads from frozen state that no longer follows the successor. **Upgrade to the current versions in the table above and never use direct mode with a retired Registry.** Deprecating the superseded npm releases is a maintainer action (`npm deprecate`); until it is done, treat any version older than the table as retired.

## October 1 publication

Lookup **0.11.0**, Owner **0.12.0**, Holder **0.10.0** and MCP **0.10.0** were published to npm on **1 October 2026**. The downloaded MCP archive matches the reviewed release bytes; its publication time and integrity are recorded in the [release notes](RELEASE-2026-10-01.md). Existing namespace owners must opt in to their contract upgrades before new capabilities become available.

See [release notes](RELEASE-2026-10-01.md), [source provenance](SYNC.md) and the [test manifest](test-manifest.json). Hosted MCP deployment is separate from this package release.
