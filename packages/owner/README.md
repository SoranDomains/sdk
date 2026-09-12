# @sorandomains/owner


> Governed testnet migration sealed at ledger 4604192 on 10 September 2026. See the
> [release status](https://docs.soran.domains/reference/release-status) for package and service availability.


Version 0.8.0 targets Stellar SDK17 (`>=17 <18`). ASCII names
and labels are validated before lowercase normalization; Unicode lookalikes are
rejected. Writes continue to target the owning Registry/Registrar/Resolver. Universal
Lookup is the read entry point in `@sorandomains/lookup` 0.10.0.

Ownership, issuer, holder and treasury inputs remain G/C account or contract
addresses. Muxed M addresses are payment destinations only: issue the name to its
actual G/C holder, then that holder can call Holder `setPayment` to publish M.

Run your Soran namespace on Stellar, programmatically. Issue names to your
users, manage their lifecycle and transfer the namespace. Every operation is a transaction
your own key signs and any Soroban RPC node submits: no Soran account, no
hosted API in the path.

```bash
npm install @sorandomains/owner @stellar/stellar-sdk
```

```ts
import { SoranOwner, keypairSigner } from "@sorandomains/owner";

const owner = new SoranOwner({ signer: keypairSigner(process.env.OWNER_SECRET!) });

// alice.acme now resolves — one call, owner-signed, on chain
await owner.issue("acme", "alice", "GDHN…USER");

// or up to 23 names in one transaction, with per-label outcomes
const batch = await owner.issueBatch("acme", rows);
for (const o of batch.outcomes) if (!o.issued) console.warn(o.label, o.reason);
```

## What's in the box

| Operation | What it does |
| --- | --- |
| `issue` / `issueBatch` | Issue `label.namespace` to a holder (batch: ≤23/tx, per-label outcome report) |
| `reclaim` | Take a name back — only where the namespace policy allows it |
| `renew` | Extend a finite-term name; returns the new expiry |
| `setTreasury` | Route reclaim custody to a treasury address |
| `makePermanent` | Legacy deployment operation; unavailable on governed testnet contracts |
| `proposeNamespaceTransfer` / `acceptNamespaceTransfer` / `cancelNamespaceTransfer` | Two-step, accept-to-move namespace transfer |
| `setResolver` | Point the namespace at a resolver (frozen once permanent) |
| `policy` / `isPermanent` / `nameState` / `pendingNamespaceTransfer` / `namespaceOwner` / `registrarOf` / `assertOwner` | Reads that support the write flows |

Name-**holder** powers (transferring an individual name, re-pointing it,
electing a primary name) are deliberately absent: the contracts grant them to
holders, not owners — they live in
[`@sorandomains/holder`](https://www.npmjs.com/package/@sorandomains/holder).

## Signing

Backends use `keypairSigner(secret)`. Browser apps pass the wallet itself —
Freighter and Stellar Wallets Kit already match the `TxSigner` shape:

```ts
const owner = new SoranOwner({
  signer: {
    publicKey: () => walletAddress,
    signTransaction: (xdr, opts) => kit.signTransaction(xdr, opts),
  },
});
```

The SDK simulates each call first, so policy violations and permission errors
surface as typed `OwnerError`s (`code`, `codeName`) before anything is signed
or any fee is spent. Failed operations that reached the network carry
`txHash` — always re-check a hash before retrying.

## Resolution is the other package

Wallets and apps that only read names should depend on
[`@sorandomains/lookup`](https://www.npmjs.com/package/@sorandomains/lookup) —
trustless resolve, reverse lookup, and ownership assurance, with no signing
code at all.

Docs: <https://github.com/SoranDomains/docs> · License: MIT


## Native username claiming

`claimPolicy` and `nativeClaimCapability` read the current on-chain setup. Configure it with `configureClaims`, `setClaimsEnabled`/`pauseClaims`, `reserveNames`, `releaseReservations` and `assignReserved`. Manual mode retains ordinary owner issuance; Public mode routes ordinary issuance through the public claim rules, while explicit reserved assignment remains an owner power. The default disabled policy is not an open registration service.

Read the [native claim APIs, security boundaries and complete signup flow](https://github.com/SoranDomains/sdk/blob/main/NATIVE-CLAIMS.md). G/no memo, G with ID/Text/Hash, full M/no separate memo and C/no memo remain supported payment destinations. Current transaction-signing adapters use classic G accounts.

## Verified testnet deployment

See the [deployment manifest](../../deployments/testnet.json) for confirmed code hashes, transaction receipts and verification scope. Network passphrase: `Test SDF Network ; September 2015`.

| Contract | Address |
|---|---|
| Registry | `CCSORANDPQINYOYB5SVO45WJP2LBBYKC72HHUIRVXB4J6RUZKDAUW7G4` |

Mainnet has no deployment preset. Custom networks must supply their own verified
addresses. Universal Lookup upgrades remain immediately executable; an address
and ABI version do not pin the code that will execute after a governance upgrade.

## Network fee limits

Available in 0.8.0.

Every write and automatic restoration has a total network-fee limit, including the base and resource fees. The default is **5 XLM** (`50_000_000n` stroops). Set `maxNetworkFeeStroops` on the client only after reviewing a higher storage/rent estimate. This limits each transaction separately; it is not a daily or batch spending budget, and namespace/username prices are separate.

```ts
const client = new SoranOwner({
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
