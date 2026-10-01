# @sorandomains/holder


> Governed testnet migration sealed at ledger 4604192 on 10 September 2026. See the
> [release status](https://docs.soran.domains/reference/release-status) for package and service availability.


Version 0.10.0 targets Stellar SDK17 (`>=17 <18`). ASCII names
and labels are validated before lowercase normalization; Unicode lookalikes are
rejected. Payment and ownership writes target the owning Registry/Registrar/Resolver.
Complete-M display-name writes target Universal Lookup; Lookup 0.10.0 or later provides
the corresponding read interface. Check the release status before enabling the
new capability on a deployment.

Releases older than 0.9.1 (and any built against Lookup 0.6.0 to 0.9.0) default to the retired 5 and 6 September 2026 testnet stacks; upgrade rather than pinning a retired Registry. See [Older versions and retired stacks](../../README.md#older-versions-and-retired-stacks).

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

## Network address records (unreleased native extension)

```ts
await me.setChainAddress("fred.solo", "ethereum", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
await me.setChainAddress("fred.solo", "bitcoin", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
await me.clearChainAddress("fred.solo", "bitcoin");
```

The namespace owner must first enable each network for all holders. Publishing
validates the address, freshly checks the native route/version and policy, then
signs one holder-authorized binary record write. Clearing works while disabled.
No custom text record is read or modified; Stellar continues to use `setPayment`.
`HolderError.codeName === "ChainDisabled"` identifies a disabled network.

All methods require `multichain_version() == 1`; the existing published deployment
presets are not upgraded by installing this SDK. The source change does not deploy
contracts or publish packages. See [network formats and integration rules](../multichain/README.md)
for all 14 supported mainnets, binary formats, and shared codec exports. XRP Ledger
`xrp` preserves full mainnet X-addresses and their destination tags; `xrpl-evm` is a
separate EVM network. Never strip an X-address tag. For Stellar use the dedicated
payment API.


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

Native username claiming uses `claimQuote`, `createClaimIntent`, `buildClaim` and `claim`. The current namespace owner must first enable the public policy. The claimant's G or C wallet authorizes the exact username, complete receiving destination, owner price, policy version and deadline. `recoverClaim` reads the original immutable receipt; it never silently retries an uncertain transaction. Receipt reads, receipt absence and confirmed transaction results are accepted only after a clean Registrar attestation and executable check with RPC ledger context at least as recent as the receipt read or transaction inclusion. Missing or older context stops recovery; retain the original request and transaction hash. This check trusts the configured RPC to report its state and ledger honestly. Later namespace-owner, claim-policy or Resolver changes alone do not invalidate a historical receipt, while tainted or unapproved Registrar code cannot supply authoritative history. On governed deployments, approved code is verified against the namespace-specific Registry pin. `acceptNameTransferWithDestination` and `renewName` cover separately authorized holder lifecycle actions.

Read the [native claim APIs, security boundaries and complete signup flow](https://github.com/SoranDomains/sdk/blob/main/NATIVE-CLAIMS.md). G/no memo, G with ID/Text/Hash, full M/no separate memo and C/no memo remain supported payment destinations. Transaction envelopes still use a G fee payer. A C owner supplies `contractWallet` authorization; see the example below.

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


### Claim and manage a name with a contract wallet

```ts
import { SoranHolder, type ContractWallet, type TxSigner } from "@sorandomains/holder";

// These adapters come from your wallet integration. The C wallet signs Soroban
// authorizations in the format its deployed __check_auth understands.
export function namesForContractWallet(wallet: ContractWallet, feePayer: TxSigner) {
  return new SoranHolder({ signer: feePayer, contractWallet: wallet });
}
```

The C wallet becomes the name's holder. It authorizes the reviewed action; the G payer signs the transaction after the chain verifies the wallet signature and estimates the complete fee. Existing names in older namespaces need their Registrar upgraded before C claiming is available. `buildClaim` stays unsigned; `claim` handles authorization and submission. Sponsored users pass the C adapter to `SoranSponsorship.authorize`; Soran supplies the relayer. See the native guide for fee refresh and recovery.

### Child names

An upgraded namespace can allow one child level, such as `mail.fred.solo`.
The current holder of `fred.solo` controls its children; their destination wallets
receive no ownership rights. Children share the parent's expiry and stop working
when its ownership generation changes. They are not independently transferable.

```ts
const parent = await lookup.nameMetadata("fred.solo");
const previous = await holder.subnameRecord("mail.fred.solo");
await holder.createSubname("mail.fred.solo", receivingAddress, {
  parentGeneration: parent!.generation,
  previousGeneration: previous?.generation ?? null,
});
await holder.setPayment("mail.fred.solo", {
  address: receivingAddress, memo: { type: "id", value: "123" },
});
```

Creation stores a G/C destination with **no memo**. Use a holder-controlled
address initially when the intended destination requires a memo, then publish
its complete instructions atomically with `setPayment`. Existing text, profile,
network-address, payment, reverse and primary methods accept child names.
`setAddress`, claims, renewals and name transfers remain top-level operations.
`parseName` keeps its existing two-label grammar; `parseResolvableName` accepts
both forms and validates every label before lowercasing.

`removeSubname(name, { parentGeneration, generation })` removes the reviewed
incarnation; `touchSubname(name)` maintains its storage.
`touchSubnamePage("fred.solo", page)` maintains an existing listing page and its
parent/count storage. Pages are zero-based groups of 16 labels; use
`Math.floor(offset / 16)` for a listing offset. Page upkeep is permissionless,
charges the signer's network fee, and rejects nonexistent pages. Maintaining a
child alone does not renew its listing page. Raw `subnameRecord`
and bounded `subnames(parent, { offset, limit })` reads include removed and stale
rows, and are not payment answers. Always resolve payment instructions again.
A failed or archived read is an error, never a missing child. The maximum page
size is 16; pages may change between reads and across a Registrar migration.
