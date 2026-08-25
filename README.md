# Soran SDKs

Three packages, three audiences, one trust model — everything runs against the
chain directly, with Soran's servers never in the trust path.

| Package | Audience | Surface |
| --- | --- | --- |
| [`@sorandomains/lookup`](packages/lookup/) | Wallets & apps that **read** names | `resolve`, `record`, `verify`, `assurance`, `reverseLookup`, `primaryOf` — pure chain reads, no keys, no signing code |
| [`@sorandomains/owner`](packages/owner/) | Businesses that **run** a namespace | `issue`, `issueBatch`, `reclaim`, `renew`, `makePermanent`, namespace transfers, `setResolver` — owner-signed transactions |
| [`@sorandomains/holder`](packages/holder/) | People who **hold** a name | records, profile, reverse, primary, name transfers — holder-signed transactions |

The split is deliberate: a wallet should never carry transaction-signing code
it doesn't use, and an issuing backend should get lifecycle tooling without
dragging in hint-fetch plumbing. If you need both, install both — they share
conventions and the testnet deployment preset.

Published from the private development monorepo; the public mirror is
<https://github.com/SoranDomains/sdk>.
