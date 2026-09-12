# @sorandomains/holder


> Governed testnet migration sealed at ledger 4604192 on 10 September 2026. See the
> [release status](https://docs.soran.domains/reference/release-status) for package and service availability.


Version 0.7.0 targets Stellar SDK17 (`>=17 <18`). ASCII names
and labels are validated before lowercase normalization; Unicode lookalikes are
rejected. Payment and ownership writes target the owning Registry/Registrar/Resolver.
Complete-M display-name writes target Universal Lookup; Lookup 0.10.0 provides
the corresponding read interface. Check the release status before enabling the
new capability on a deployment.

Your Soran name, managed with your own key. The third piece of the SDK
trilogy: [`@sorandomains/lookup`](https://www.npmjs.com/package/@sorandomains/lookup)
reads names, [`@sorandomains/owner`](https://www.npmjs.com/package/@sorandomains/owner)
runs a namespace — this package is for the person who **holds** a name.

```bash
npm install @sorandomains/holder @stellar/stellar-sdk
```

```ts
import { SoranHolder, keypairSigner } from "@sorandomains/holder";

const me = new SoranHolder({ signer: keypairSigner(process.env.MY_SECRET!) });

await me.setReverse("alice.nova");   // your address shows as alice.nova
await me.setPrimary("alice.nova");   // ...across every namespace
await me.setProfile("alice.nova", {  // the standard keys every wallet reads
  org: "Alice Co",
  url: "https://alice.dev",
});
```

## Publish payment instructions

Ordinary G/C names resolve without extra setup. `setPayment` discovers the native
Resolver from Registry, checks its Registry and Registrar anchors and payment API
version, then signs one call that updates address and memo in that Resolver:

```ts
const me = new SoranHolder({ signer });
await me.setPayment("alice.nova", {
  address: exchangeDepositAddress,
  memo: { type: "id", value: "18446744073709551615" },
});
// Explicitly remove a required memo:
await me.setPayment("alice.nova", { address: myAddress, memo: { type: "none" } });
```

ID values are canonical unsigned 64-bit decimal strings; text is exact nonempty
UTF-8 up to 28 bytes; hashes are 64 lowercase hex characters. Required memos work
only with G addresses. C addresses permit `none`. A full muxed M address also
requires `none`: its embedded ID belongs to the operation destination, not a
transaction memo. On native Resolver v2, `setPayment` decodes M and signs
`set_muxed(name, holder, baseG, exactU64Id)`; G/C uses `set_payment` as before.
The signed authorization must match the exact selected call, base account and ID.
A signer returning a different transaction body is rejected before submission. The Resolver authorizes the
current holder and updates its records atomically. Failures never retry as separate
address and text writes. Old unsupported Resolvers fail closed; no payment-specific
contract address is configured.

`setText` and `clearText` reserve `payment` for `setPayment`. Configured missing or
empty instructions remain errors. Remove a memo with explicit `none`.
`setRecord` invokes native `set_addr`, which atomically permits ordinary names and
updates an existing valid direct `none` tuple while rejecting muxed routes, required memos or broken
state. A concurrently added memo cannot be replaced by a client-side None rewrite.
`setAddress` retains its Registrar-only semantics and first requires a valid native
direct `none` result. It changes only the built-in target; an explicit Resolver payment
record continues to take precedence. Failed preflight reads never permit a write.

Resolver selection follows the namespace owner's Registry pointer. Compatibility
and anchor checks do not prove custom/upgraded code is trustworthy. Upgraded
Resolvers remain supported. Payment readers must use `resolvePayment` and preserve
the returned memo; old deployed code and direct Registrar reads cannot be upgraded
by installing this SDK. The verified deployment for this release is listed below.

### Publish a muxed destination

```ts
await me.setPayment("customer420.nova", {
  address: "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAABUTGI4",
  memo: { type: "none" },
});
```

This illustrative M address contains the G account shown in Stellar's examples
and ID 420. Publish only the actual route supplied by the recipient. No separate
ID/text/hash memo is permitted. V1 Resolvers cannot store M and fail before signing.
Use `setPayment` to explicitly replace or remove muxed routing; `setAddress` and
`setRecord` remain G/C account-address operations. Namespace/name ownership,
operator and signer addresses remain G/C. Complete-M reverse and Primary elections
use the dedicated methods below and are signed by the M address's base G account.

## Elect a complete M display name

Holder 0.6.0 adds these methods for a Lookup that successfully reports
`muxed_identity_version() == 1`. Contract addresses remain unchanged; publication
and deployment are tracked separately in the release status.

```ts
const me = new SoranHolder({
  signer,
  registryId: deployment.registryId,
  lookupId: deployment.lookupId,
  rpcUrl: deployment.rpcUrl,
  passphrase: deployment.passphrase,
});
const mAddress = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAABUTGI4";
await me.setReverseMuxed("customer420.nova", mAddress);
await me.setPrimaryMuxed("customer420.nova", mAddress); // optional second transaction
```

The name must already forward-resolve to the exact full M address. The signer
must control its underlying G account. An exchange customer who only has a
deposit address cannot sign for the exchange. Elections are keyed by G plus exact
u64 ID; `0` does not alias G, and IDs through `18446744073709551615` retain their
precision. The transaction authorization binds the name, account and ID. A M
route is never replaced with G or a G-plus-memo route.

`setPrimaryMuxed` requires the same current verified M reverse name. The two writes
are separate: cancelling Primary leaves a successful reverse election intact.
Changing/clearing reverse invalidates Primary while its required election does
not match. Claiming or setting a payment destination does not elect either name.
Payment instructions are not changed by any of these display-name methods.

```ts
await me.clearReverseMuxed("nova", mAddress);
await me.clearPrimaryMuxed(mAddress);
```

The testnet preset supplies `lookupId`; changing Registry or passphrase prevents
inheriting an unrelated pin. These calls use Lookup directly, independent of the
older G/C `primaryId`. Existing `setReverse` / `setPrimary` remain G/C methods.
A name transfer or reissue changes generation and requires fresh M elections.
The contract also exposes permissionless `touch_reverse_muxed` and
`touch_primary_muxed` for upkeep; they are not Holder SDK methods.

## What's in the box

| Operation | What it does |
| --- | --- |
| `setPayment` | Atomically publish address and memo in the namespace native Resolver |
| `setRecord` | Change a memo-free native Resolver address atomically; required memos need `setPayment` |
| `setAddress` | Re-point the built-in (Registrar) resolution target |
| `setText` / `setProfile` / `clearText` | Publish text records; `setProfile` writes the standard `PROFILE_KEYS` (one transaction per key); records are overwrite-only on chain — `clearText` retracts by writing the empty value standard readers treat as unset |
| `setReverse` / `clearReverse` | Claim your address→name reverse record — the contract refuses names that don't already resolve to you (`ForwardMismatch`) |
| `setPrimary` / `clearPrimary` | Your G/C cross-namespace display name, re-verified on chain at every read |
| `setReverseMuxed` / `clearReverseMuxed` | Elect or clear a namespace name for the exact M destination |
| `setPrimaryMuxed` / `clearPrimaryMuxed` | Elect or clear the exact M destination's cross-namespace name |
| `proposeNameTransfer` / `acceptNameTransfer` / `cancelNameTransfer` | Two-step, accept-to-move name transfers (policy-gated) |
| `pendingNameTransfer` | Read the pending proposal |
| `registrarOf` / `resolverOf` | Discover the namespace's attested Registrar / resolver pointer |

Authorization is enforced **on chain** — the Resolver checks you hold
the name right now, reverse and primary claims are authorized by the address
itself, and transfers move only when the recipient accepts. No Soran account,
no hosted API in the path.

## Signing

Same `TxSigner` contract as the owner SDK — `keypairSigner(secret)` for
scripts, or wrap a browser wallet:

```ts
const me = new SoranHolder({
  signer: {
    publicKey: () => walletAddress,
    signTransaction: (xdr, opts) => kit.signTransaction(xdr, opts),
  },
});
```

Calls are simulated before signing, so contract rejections surface as typed
`HolderError`s (`code`, `codeName` — e.g. `NotHolder`, `ForwardMismatch`,
`NotTransferable`) before any fee is spent; failures that reached the network
carry `txHash`.

Works in browsers, Node, and workers out of the box — zero Node built-ins of
its own (enforced in CI), with `@stellar/stellar-sdk` as the only peer
dependency.

Docs: <https://github.com/SoranDomains/docs> · License: MIT

Primary writes verify the Primary contract's Registry anchor before signing.
Custom Registry or passphrase settings do not inherit a Primary deployment pin;
supply the matching `primaryId` explicitly.


## Native username claiming

Native username claiming uses `claimQuote`, `createClaimIntent`, `buildClaim` and `claim`. The current namespace owner must first enable the public policy. The claimant's G wallet authorizes the exact username, complete receiving destination, owner price, policy version and deadline. `recoverClaim` reads the original immutable receipt; it never silently retries an uncertain transaction. Receipt reads, receipt absence and confirmed transaction results are accepted only after a clean Registrar attestation and executable check with RPC ledger context at least as recent as the receipt read or transaction inclusion. Missing or older context stops recovery; retain the original request and transaction hash. This check trusts the configured RPC to report its state and ledger honestly. Later namespace-owner, claim-policy or Resolver changes alone do not invalidate a historical receipt, while tainted or unapproved Registrar code cannot supply authoritative history. On governed deployments, approved code is verified against the namespace-specific Registry pin. `acceptNameTransferWithDestination` and `renewName` cover separately authorized holder lifecycle actions.

Read the [native claim APIs, security boundaries and complete signup flow](https://github.com/SoranDomains/sdk/blob/main/NATIVE-CLAIMS.md). G/no memo, G with ID/Text/Hash, full M/no separate memo and C/no memo remain supported payment destinations. Current transaction-signing adapters use classic G accounts.

## Verified testnet deployment

See the [deployment manifest](../../deployments/testnet.json) for confirmed code hashes, transaction receipts and verification scope. Network passphrase: `Test SDF Network ; September 2015`.

| Contract | Address |
|---|---|
| Registry | `CCSORANDPQINYOYB5SVO45WJP2LBBYKC72HHUIRVXB4J6RUZKDAUW7G4` |
| Primary (G/C) | `CCSORAN7Y7ICQK2MBSVCJT3BUN5EHXKDKSTMGVB6QWSYXWMMLG2WIFJ6` |
| Universal Lookup (M elections) | `CDSORANQAJK35UV2HR63CMB6M5NYISHMUBTB6EQY2CZ3Y7HJDIOHRJWA` |

Mainnet has no deployment preset. Custom networks must supply their own verified
addresses. Universal Lookup upgrades remain immediately executable; an address
and ABI version do not pin the code that will execute after a governance upgrade.

## Network fee limits

Available in 0.7.0.

Every write and automatic restoration has a total network-fee limit, including the base and resource fees. The default is **5 XLM** (`50_000_000n` stroops). Set `maxNetworkFeeStroops` on the client only after reviewing a higher storage/rent estimate. This limits each transaction separately; it is not a daily or batch spending budget, and namespace/username prices are separate.

```ts
const client = new SoranHolder({
  signer,
  maxNetworkFeeStroops: 50_000_000n,
});
```

The older `maxNativeFeeStroops` option remains supported: when the new option is omitted, it also supplies the total ceiling. If both are set, native operations use the lower value and other writes use `maxNetworkFeeStroops`. An excessive estimate is rejected before wallet approval. After a possible submission, errors retain the original transaction hash; reconcile it before creating a replacement transaction.

## Governed testnet code and migration recovery

On a governed Registry, native verification reads the exact per-namespace Registrar code pin and its upgrade history. Approved upgrades do not have to match the current factory default. Missing or malformed provenance still prevents signing and receipt confirmation; RPC failure never downgrades verification to a legacy rule.

Historical claim recovery is read-only and binds the original intent to the frozen source Registrar and sealed migration commitments. It never rewrites the intent to a successor Registry or treats an unavailable receipt as permission to submit again. Deployment migration and package publication are separate; check the release status for the active addresses.


## Namespace sponsorship

The next release adds on-chain funding and sponsored actions on Stellar testnet.
`SoranFunding` manages an owner's deposit, spending limits, pause controls and withdrawals.
`SoranSponsorship` builds and checks an exact sponsored action, while `FundingServiceClient`
requests quotes and recovers transaction outcomes from a compatible service.

The Soran service uses fixed quotes based on live Stellar fee estimates. A successful action
charges the agreed amount; Soran retains any difference from the actual network fee.
There is no separate refund transaction or later debit. Failed actions do not debit the
namespace's funding position. A separate username price remains payable by the claimant.

User authorization remains required. A wallet must support Soroban authorization-entry
signing; a transaction-only wallet cannot silently switch to a user-paid transaction.
Always preserve the canonical quote before submission and recover its status after a timeout.
Funding balances and permissions are verified on chain, and terminal outcomes are checked
against trusted Stellar RPC/history providers.
