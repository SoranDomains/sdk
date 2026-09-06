# Native username claims

SDK versions in this source: Holder `0.5.1`, Owner/MCP `0.7.0`, Lookup `0.7.0`. The release uses the native-claim successor Registry/Resolver/Registrar; its exact verified deployment is recorded in the package preset and [release manifest](https://github.com/SoranDomains/sdk/blob/main/deployments/testnet.json). Public package and service availability is recorded separately in the [release status](https://docs.soran.domains/reference/release-status).

## Application-owned signup

The owner's application uses the SDK in its own signup/account settings UI. No widget, iframe or mandatory Soran/Studio destination is introduced. A returning login does not issue another name. Private app identity stays separate from transferable username ownership. See [the source reference](examples/native-signup/README.md) for public recovery state, account linking and exact transaction review.

`SoranHolder` keeps its existing `TxSigner` constructor, with explicit `registryId`, `rpcUrl`, `passphrase` and optional `maxNativeFeeStroops` (default 50,000,000 stroops/5 XLM total network fee cap). The claimant and transaction source are the same G account. Destination support is independent: G/none, G/ID/Text/Hash, M/none retaining its full u64 ID, or C/none. A C destination is not proof of a C-wallet signing adapter.

```ts
const quote = await holder.claimQuote("alice.acme");
const intent = createClaimIntent(quote, {
  address: connectedWallet,
  memo: { type: "none" },
}, { requestId: publicRandomHex32, deadline: quote.now + 300n });
// Present the complete destination, fee and policy, then persist this immutable intent.
const result = await holder.claim(intent, {
  onPrepared: tx => savePublicRecoveryReference(intent, tx.hash),
});
// result.transaction is null for historical recovery without another transaction.
```

Amounts are bigint stroops, timestamps/epochs/generations are bigint, and public byte identifiers are lowercase 64-character hex. `createClaimIntent` copies exact on-chain quote terms; it does not reserve the label. Any price/destination/wallet/business deadline/epoch change requires a new intent, after proving the original cannot still apply. Use `stringifyNativeIntent`/`parseNativeClaimIntent` for lossless public persistence.

## Native policy and reservations

`SoranOwner.claimPolicy(namespace)` returns `ClaimConfig | null`. `nativeClaimCapability` explicitly identifies the known legacy Wasm; unknown/malformed/unavailable reads fail closed. Native reads verify Registry attestation, clean Registrar provenance and current executable against immutable templates. Historical receipt reads use the Registrar-only proof, so merely repointing a Resolver does not fabricate or erase a past result.

Owner methods are `configureClaims`, `setClaimsEnabled`/`pauseClaims`, `nativeClaimFeeToken`, `nativeClaimUsage`, `nativeApprovalUsage`, `reserveNames`, `releaseReservations`, `isReserved` and `assignReserved`. Current Registry owner authorizes writes. Configuration uses `ClaimSettings` with Manual/Public mode, enabled flag, Open/Allowlist/Approval admission, canonical native XLM token/fee/G treasury, lifetime wallet limit and optional approval budgets. Zero wallet limit means unlimited. Approval allowance is a cumulative ceiling, not a balance that resets on rotation. Public claiming starts absent/disabled; stale ownership settings need explicit new-owner configuration.

Both `SoranOwner` and `SoranHolder` accept `maxNativeFeeStroops`; the unchanged default is 50,000,000 stroops (5 XLM), and the maximum configurable value is the transaction fee field's 4,294,967,295 stroops. This caps the complete prepared **network fee**, including Soroban resources/storage rent. It is separate from the username price paid to the namespace treasury. First-use storage/code lifetime costs can exceed the default: preparation then stops before wallet signing. Do not automatically raise the cap or assume that a free claim has negligible rent. An application may offer an explicit reviewed cap; each write's `onPrepared` callback exposes `feeStroops` and may reject to stop signing. `buildClaim` offers the same estimate without signing or submitting. Local MCP uses the same default. Its operator can explicitly set `WriteToolOptions.maxNativeFeeStroops` or the canonical decimal environment value `SORAN_MAX_NATIVE_FEE_STROOPS`; an agent tool call cannot raise that local setting. The cap is a limit, not an amount automatically spent; actual confirmed fees may be lower than the envelope maximum.

`claimSettingsToScVal` (alias `claimPolicyInputToScVal`) and `claimLabelToScVal` encode exactly the contract's typed arguments, enabling a UI's independent wallet guard. `buildClaimAllowlist({network,registry,namespace,registrar}, accounts)` needs the complete G wallet list. Network and namespace are hex hashes; `nativeNamespaceNode(label)` returns namespace bytes. Retain/distribute the returned root/proof bundle. A new subset is a replacement list, not an additive edit.

Reservations are atomic batches of 1–23 distinct labels. Reservation creates no holder or route. Assignment requires a reserved label and uses its holder's default route; its reservation remains. Release never revokes a holder. This SDK does not yet expose cross-account `issue_reserved_with_destination` co-signing; custom routes may be written by the actual holder with `setPayment` after assignment. The raw contract ABI supports a separately authenticated atomic reserved path, but it is not advertised here as a tested SDK flow.

## Optional app approval

Open registration requires no approval service. A stable cohort can use a committed allowlist. Only an operator choosing dynamic restricted admission needs the app approval service. The backend decides private app eligibility; on-chain authorization verifies its attestation, not the independent truth of the app account.

`holder.buildClaim(intent,{proof?})` returns the prepared transaction, total network fee, exact local authorization plan and optional unsigned `eligibilityEntryXdr`. It signs/submits nothing. `signClaimEligibility` is a backend helper that signs only the configured separate native G admission entry. Its `ClaimApprovalContext` requires independently read/pinned network, Registry, Registrar, namespace, Resolver, current owner/ownership epoch, claim configuration and explicit ledger-expiration bounds. Never copy that trusted context from the applicant. Authenticate membership and a freshly bound wallet first. Owner, treasury and claimant keys must not sign app eligibility.

The helper returns a native authorization entry, not a transaction signature. Supply it as `holder.claim(intent,{eligibilityAuthorization})`. The SDK independently rechecks the current policy and exact role, intent, child-free approval and expiry; it does not generally permit second signers in existing methods. Native G-account signer/threshold enforcement remains on chain. There is no C-account eligibility adapter or delegated-authorizer tree in this first SDK scope.

Credential nonces/ledger expiry and business request IDs/timestamp deadlines are separate. Native approvals from this SDK are capped to 60 future ledgers as well as the signed on-chain business lifetime. Signer rotation, quotas and compromise cannot be treated as risk-free: an attacker controlling the eligibility key and their own wallets may claim available names within configured limits; revocation cannot undo completed permanent claims.

## Recovery, transfer and renewal

`recoverClaim(intent)` or `claimReceipt(namespace,claimant,requestId)` reads an authoritative historical receipt. Matching history returns `status:"replayed"` and `transaction:null`; it does not charge, issue or overwrite a later route. Intent-based recovery validates commitment, operation, holder, name node, generation, fee, lease and original request time bounds. Direct `claimReceipt` reads authenticate the Registrar, requested holder and inclusion ledger; without the original intent they cannot validate that intent’s commitment or terms. History is distinct from current ownership; use Universal Lookup to check that before linking a name to a private app account.

Holder `0.5.1` retains the ledger of each receipt read and checks Registrar attestation, irreversible taint and executable provenance afterward. Every proof observation must be at that ledger or later. The same protection covers null receipts, replay decisions and confirmed transaction results. Missing or stale ledger context is an error, not evidence of successful recovery. These checks trust the selected RPC to report its state and ledger honestly; they are not a cryptographic proof from an untrusted RPC. Later owner or Resolver changes alone do not invalidate clean Registrar history.

Native methods never automatically retry an uncertain transaction or silently sign a restoration. `onPrepared` runs before wallet signing/broadcast for public journaling. Error `txHash` survives submission/confirmation interruption and malformed confirmed results. SUCCESS/FAILED classification requires the RPC hash, included envelope hash and positive confirmed ledger to match the reviewed transaction; mismatched or incomplete terminal replies remain pending. A null receipt, RPC timeout or empty local history is not proof of failure. Reconcile original receipt plus transaction before replacing an operation. Archived state fails with an explicit restoration requirement; review that separate transaction and cost.

`acceptNameTransferWithDestination(TransferIntent)` binds sender/recipient, proposal expiry, current generation/name expiry and complete route. It requires the recipient's G signature, increments generation and initializes the exact destination atomically while preserving expiry. `renewName(RenewIntent)` is holder-authorized and independent of new-claim pause/eligibility/settings: the contract enforces immutable term, early renewal window, expected generation/expiry and signed result bounds. No separate username renewal fee is introduced; network/storage costs remain. `renewalPreview(name)` reads an exact-generation historical destination (possibly `active:false`), without making inactive payment lookup succeed.

Canonical encoders/parsers for Claim, Transfer and Renew intents and the exact `nativeIntentHash` are exported. No general arbitrary-contract signing API or signing-key storage is added.

## Validation boundary

SDK suites exercise canonical types, all destination encodings, exact authorization trees, actual wallet-envelope signing with disposable in-memory keys, adversarial mock RPC responses, lost-response recovery, lifecycle isolation and independent Rust ToXdr vectors. `validation/check-native-abi.mjs` compares used methods against the isolated Rust contract source. These SDK tests alone are not a live deployment or a full browser/provider certification. The contract team's compiled-Wasm/real native authorization results and the eventual deployed integration matrix remain separate release evidence.

Local consumer builds must use one Stellar SDK17 peer instance. Bundlers/tests that resolve multiple independently linked SDK copies can fail XDR class identity checks; deduplicate the peer or pass serialized XDR across a process boundary. This is a dependency setup requirement, not permission to bypass transaction validation.
