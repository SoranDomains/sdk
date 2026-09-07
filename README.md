# Soran SDKs

Read and manage Soran names on Stellar. Payment and identity reads use the
configured on-chain contracts through Soroban RPC. Optional API discovery can
omit results; its coverage reports are not proof of completeness. MCP namespace application and activation
preparation use the API, with locally pinned transaction and fee validation
before signing. Hosted API and MCP responses are service-mediated; integrators
can call Universal Lookup directly for their own on-chain reads.

| Package | Release version | Audience and surface |
| --- | --- | --- |
| [`@sorandomains/lookup`](packages/lookup/) | 0.8.0 | Wallets and apps: Universal Lookup, complete payment instructions, identity metadata and verified holdings pages |
| [`@sorandomains/owner`](packages/owner/) | 0.7.0 | Namespace operators: issuance, lifecycle, policy and owner-authorized operations |
| [`@sorandomains/holder`](packages/holder/) | 0.6.0 | Name holders: records, payment memos, reverse/Primary and transfers |
| [`@sorandomains/mcp`](packages/mcp/) | 0.8.0 | AI agents: hosted read tools and locally signed management tools |

All four packages target `@stellar/stellar-sdk >=17 <18`, tested with 17.0.1.
The native-claim testnet deployment was verified on chain at ledger **4534629**
on 6 September 2026 (12:12 UTC). Universal Lookup was upgraded in place at
ledger **4549326** on 7 September 2026 (08:37 UTC) to add exact muxed reverse
and primary identities. All contract addresses remain the same. The
[current deployment manifest](deployments/testnet.json) records the original
deployment and the subsequent Lookup code upgrade separately. The [release status](https://docs.soran.domains/reference/release-status)
tracks package and service availability separately.
Mainnet has no preset.

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

Namespace owners configure native public admission once, then claimants authorize their own exact claims without the owner approving each user. The owner's application embeds the SDK in its own signup/account settings UI. Optional app approval is a separate bounded admission role. See [native claims and recovery](NATIVE-CLAIMS.md) and the [signup reference](examples/native-signup/README.md). Owner 0.7.0 and Holder 0.6.0 provide these writes; Lookup 0.8.0 keeps Universal Lookup as the read entry point.

The testnet default is a successor Registry. Existing state is not migrated, and identical name spellings in different Registries are separate identities. No automatic fallback is performed. There is no mainnet preset.

See the [current deployment manifest](deployments/testnet.json) and [0.7 release notes](RELEASE-0.7.md). Run `npm ci`, `npm run build`, `npm run typecheck` and `npm test` in each package; Lookup, Owner and Holder also provide `npm run check:browser`.
