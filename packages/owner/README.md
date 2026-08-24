# @sorandomains/owner

Run your Soran namespace on Stellar, programmatically. Issue names to your
users, manage their lifecycle, transfer the namespace, and — when you are
ready — walk the one-way permanence door. Every operation is a transaction
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
| `makePermanent` | The one-way door — irreversible, guarded by `{ confirmIrreversible: true }` |
| `proposeNamespaceTransfer` / `acceptNamespaceTransfer` / `cancelNamespaceTransfer` | Two-step, accept-to-move namespace transfer |
| `setResolver` | Point the namespace at a resolver (frozen once permanent) |
| `policy` / `isPermanent` / `nameState` / `pendingNamespaceTransfer` / `namespaceOwner` | Reads that support the write flows |

Name-**holder** powers (transferring an individual name, re-pointing it,
electing a primary name) are deliberately absent: the contracts grant them to
holders, not owners, and they will ship in a holder-side module.

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
