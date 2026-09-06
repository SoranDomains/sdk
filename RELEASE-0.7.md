# Native username claims — 0.7 release

Lookup 0.7.0, Owner 0.7.0, Holder 0.5.0 and MCP 0.7.0 target the native-claim testnet successor verified at ledger 4534629 on 6 September 2026. Stellar SDK17 (`>=17 <18`) remains the peer. Package and hosted service availability is reported independently in the public release status.

Owner configuration selects Manual/Public mode, pause, native XLM username price/treasury, reservations, wallet limits and optional committed allowlist or bounded native app approval. Public claimants sign their own exact username/destination/economic intent. Admission proof alone cannot authorize their wallet. Resolver initialization and the native claim receipt are atomic with issuance. Existing complete G/memo, M and C destination support remains.

Holder adds quote/build/claim/recovery, transfer acceptance with a destination, independent eligible lease renewal and historical destination preview. Errors preserve uncertain transaction hashes; exact source/auth trees and signed envelope bodies are checked. Terminal RPC status is accepted only with the original transaction/envelope hash and included ledger. Matching historical receipt recovery performs no new transaction.

The default native network-fee ceiling remains 5 XLM, separate from the namespace owner's username price. Initial storage rent may exceed it. Applications must explicitly review any higher ceiling; local MCP operators can configure it, but a tool call cannot silently increase it. No automatic restoration or blind retry is added.

Universal Lookup's V2 ABI remains the common payment read path. The default Registry and companion addresses change; old state is not migrated and identical names in different Registries are separate identities. There is no automatic deployment fallback or mainnet preset. Historical release manifests are preserved as provenance.

The application-owned signup reference imports the public packages and includes recovery tests. It does not supply custodial keys, private membership storage, a wallet provider, or a hosted public signup platform.
