# @sorandomains/holder

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

## What's in the box

| Operation | What it does |
| --- | --- |
| `setRecord` | Point your name's explicit resolver record at any address (generation-gated — stops resolving the moment the name changes hands) |
| `setAddress` | Re-point the built-in (Registrar) resolution target |
| `setText` / `setProfile` | Publish text records; `setProfile` writes the standard `PROFILE_KEYS` (one transaction per key) |
| `setReverse` / `clearReverse` | Claim your address→name reverse record — the contract refuses names that don't already resolve to you (`ForwardMismatch`) |
| `setPrimary` / `clearPrimary` | Your one cross-namespace display name, re-verified on chain at every read |
| `proposeNameTransfer` / `acceptNameTransfer` / `cancelNameTransfer` | Two-step, accept-to-move name transfers (policy-gated) |
| `pendingNameTransfer` | Read the pending proposal |

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
