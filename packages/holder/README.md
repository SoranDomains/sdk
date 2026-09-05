# @sorandomains/holder

Version 0.3.0 targets Stellar SDK17 (`>=17 <18`). ASCII names
and labels are validated before lowercase normalization; Unicode lookalikes are
rejected. Writes continue to target the owning Registry/Registrar/Resolver. Universal
Lookup is the read entry point in `@sorandomains/lookup` 0.5.0.

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
only with G addresses. C addresses permit `none`. The Resolver authorizes the
current holder and updates its records atomically. Failures never retry as separate
address and text writes. Old unsupported Resolvers fail closed; no payment-specific
contract address is configured.

`setText` and `clearText` reserve `payment` for `setPayment`. Configured missing or
empty instructions remain errors. Remove a memo with explicit `none`.
`setRecord` invokes native `set_addr`, which atomically permits ordinary names and
updates an existing valid `none` tuple while rejecting required memos or broken
state. A concurrently added memo cannot be replaced by a client-side None rewrite.
`setAddress` retains its Registrar-only semantics and first requires a valid native
`none` result. It changes only the built-in target; an explicit Resolver payment
record continues to take precedence. Failed preflight reads never permit a write.

Resolver selection follows the namespace owner's Registry pointer. Compatibility
and anchor checks do not prove custom/upgraded code is trustworthy. Upgraded
Resolvers remain supported. Payment readers must use `resolvePayment` and preserve
the returned memo; old deployed code and direct Registrar reads cannot be upgraded
by installing this SDK. The verified deployment used by this release is listed below.

## What's in the box

| Operation | What it does |
| --- | --- |
| `setPayment` | Atomically publish address and memo in the namespace native Resolver |
| `setRecord` | Change a memo-free native Resolver address atomically; required memos need `setPayment` |
| `setAddress` | Re-point the built-in (Registrar) resolution target |
| `setText` / `setProfile` / `clearText` | Publish text records; `setProfile` writes the standard `PROFILE_KEYS` (one transaction per key); records are overwrite-only on chain — `clearText` retracts by writing the empty value standard readers treat as unset |
| `setReverse` / `clearReverse` | Claim your address→name reverse record — the contract refuses names that don't already resolve to you (`ForwardMismatch`) |
| `setPrimary` / `clearPrimary` | Your one cross-namespace display name, re-verified on chain at every read |
| `proposeNameTransfer` / `acceptNameTransfer` / `cancelNameTransfer` | Two-step, accept-to-move name transfers (policy-gated) |
| `pendingNameTransfer` | Read the pending proposal |
| `registrarOf` / `resolverOf` | Discover the namespace's attested Registrar / resolver pointer |

Everything is holder-authorized **on chain** — the Resolver checks you hold
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

## Verified testnet deployment

Verified on 2026-09-05 at ledger 4515471. Network passphrase: `Test SDF Network ; September 2015`.

| Contract | Address |
|---|---|
| Registry | `CBSORANXTUFKBZK74AAM2ZM5OX2V7PIXUADM3HGP6WU3IDN7M3YEEDLU` |
| Primary | `CBSORANQVSWYBYGKRZ7RAUGOXDAXMXDXQWJSE42DQZOL4BK75BIEBUQK` |

Mainnet has no deployment preset. Custom networks must supply their own verified
addresses. Universal Lookup upgrades remain immediately executable; an address
and ABI version do not pin the code that will execute after a governance upgrade.
