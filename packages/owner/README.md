# @sorandomains/owner


> Governed testnet migration sealed at ledger 4604192 on 10 September 2026. See the
> [release status](https://docs.soran.domains/reference/release-status) for package and service availability.


Version 0.12.0 targets Stellar SDK17 (`>=17 <18`). ASCII names
and labels are validated before lowercase normalization; Unicode lookalikes are
rejected. Writes continue to target the owning Registry/Registrar/Resolver. Universal
Lookup is the read entry point in `@sorandomains/lookup` 0.10.0 or later.

Releases older than 0.11.0 (and any built against Lookup 0.6.0 to 0.9.0) default to the retired 5 and 6 September 2026 testnet stacks; upgrade rather than pinning a retired Registry. See [Older versions and retired stacks](../../README.md#older-versions-and-retired-stacks).

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

## Network address policy (unreleased native extension)

```ts
await owner.setChainPolicy("solo", ["bitcoin", "ethereum", "base", "xrp"]);
const enabled = await owner.chainPolicy("solo");
await owner.setChainPolicy("solo", []); // disable all generic network records
```

The current namespace owner sets one live policy for every existing and future
holder. The default policy is empty. Disabled records are hidden and cannot be
updated, but remain stored for re-enablement or removal by their holder. Duplicate
or unknown IDs are rejected. Each write freshly verifies the native route/version
and current namespace owner before signing the exact policy transaction. The owner
chooses available networks; holders choose their own destinations.

All methods require `multichain_version() == 1`; the existing published deployment
presets are not upgraded by installing this SDK. The source change does not deploy
contracts or publish packages. See [network formats and integration rules](../multichain/README.md)
for all 14 supported mainnets, binary formats, and shared codec exports. XRP Ledger
`xrp` preserves full mainnet X-addresses and their destination tags; `xrpl-evm` is a
separate EVM network. Never strip an X-address tag. For Stellar use the dedicated
payment API.


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

## Namespace contract updates

The current namespace owner can update each governed child contract separately:

```ts
const status = await client.contractUpgradeStatus("acme", "resolver", approvedResolverHash);
// status: { owner, contractId, currentHash, approved, governed }
const direction = contractUpgradeDirection("resolver", status.currentHash, approvedResolverHash);
if (status.approved && status.governed && (direction === "forward" || direction === "unreviewed-target")) {
  await client.upgradeResolver("acme", approvedResolverHash, {
    onPrepared: ({ hash, feeStroops }) => savePendingUpdate({ hash, feeStroops }),
  });
}
await client.upgradeRegistrar("acme", approvedRegistrarHash);
```

Registry approval says a hash may be installed on any namespace; it does not say the move is safe. Governance keeps superseded releases approved, so the chain itself accepts a downgrade (and a reinstall of the installed hash). The SDK therefore refuses, before preparing or signing anything: a reinstall of the installed hash, always; a **superseded** release (`CONTRACT_RELEASES[role].superseded`, a downgrade that drops later fixes); and the latest known release over installed code the SDK cannot place (it may be newer). `contractUpgradeDirection(role, currentHash, targetHash)` returns `"forward"`, `"same"`, `"backward"`, `"unrecognized-current"` or `"unreviewed-target"` (a release newer than this SDK, whose direction it cannot judge: only a reviewed hash from a trusted release record should reach it). A deliberate rollback passes `{ allowDowngrade: true }` to `upgradeRegistrar`/`upgradeResolver` after reviewing the older release for that namespace; it never overrides a reinstall. Keep an application-side allow-list of reviewed `from -> to` pairs, as the Soran console does; `CONTRACT_RELEASES` is a tested mirror of that catalog and lags any release newer than the SDK.

Use exact lowercase 32-byte hex hashes from a reviewed release. Registry governance must approve the implementation for its Registrar or Resolver role first. Approval permits an update; it does not upgrade existing namespace contracts. Each owner-signed transaction changes code at the existing contract address, executes immediately, and pays its own simulated network fee. Storage compatibility is a property of the selected release, not a guarantee for every approved implementation.

`contractUpgradeStatus` is read-only and checks both actual executables against the Registry's per-namespace code pins, clean attestations, Registrar anchors, and Resolver provenance/authority. It does not depend on claim configuration, claim-interface version or fee-token settings. A verified unsupported policy or revoked target is reported through `governed`/`approved`; missing or inconsistent evidence throws. This review is a snapshot: the write rechecks authorization and simulation before signing, and the contracts enforce current approval and ownership on chain.

Both update methods require the current owner's account as the transaction source and use the native transaction's exact operation, authorization-tree and fee checks. They never fall back to the legacy tainting upgrade path or restore archived storage automatically. Active migrations and frozen exports must be resolved before updating. If submission is interrupted, reconcile the error's original `txHash` before retrying. Signature quorum is validated by the network; contract-wallet owner authorization is not supported by these account-source helpers.

### Namespace-wide child-name policy

On a Registrar with `subname_version() == 1`, the current namespace owner can
call `setSubnamePolicy(namespace, policy)` with `enabled`, `creation-disabled`
or `suspended`. The default is `creation-disabled`. Changes apply to all parent
holders, including usernames claimed before the change. `creation-disabled`
blocks new children while existing ones still work; `suspended` blocks child
resolution and record edits, preserves records, and permits their removal.

`subnamePolicy`, `subnameRecord` and `subnames(parent, { offset, limit })` provide
strict on-chain reads. Raw child records and pages include inactive/stale rows;
they do not establish payment readiness. The parent holder, not a separate
child wallet, controls `mail.fred.solo`, and its expiry and ownership generation
are tied to `fred.solo`. Child destinations may differ from the parent holder.
