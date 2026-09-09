# @sorandomains/lookup

> Native claim testnet deployment verified at ledger 4534629 on 6 September 2026 (12:12 UTC). See the
> [release status](https://docs.soran.domains/reference/release-status) for package and service availability.


Read Soran names on Stellar through the on-chain Universal Lookup contract. The SDK
is optional: wallets, explorers and other contracts can call the same ABI directly.
Reads use your configured Soroban RPC. No hosted Soran service supplies payment answers.

```ts
import { Soran } from "@sorandomains/lookup";
const soran = new Soran({ network: "testnet" });
const payment = await soran.resolvePayment("Alice.Nova");
// Preserve BOTH payment.address and payment.memo when building a payment.
if (!(await soran.verifyPayment("alice.nova", payment))) throw new Error("Instructions changed");
```

This release uses Universal Lookup **by default**. The testnet preset pins the verified
native muxed deployment listed below. A network without a Lookup pin fails with
`CONFIG`; it never silently uses direct Resolver calls. Mainnet has no preset until
its reviewed deployment exists. A custom Registry or passphrase does not inherit
Lookup or Primary pins from another deployment. Verify the deployment anchors, Lookup version and code hashes together. Older
testnet clients need the matching new package and deployment pins.

Explicit compatibility mode remains available with `resolutionMode: "direct"`
(or `lookupId: null`). Direct mode discovers native Resolvers from Registry and
checks their Registry, Registrar authority and payment API version. It has no
old-address fallback. The universal-only `lookup`, `namespaceMetadata` and
`nameMetadata` methods require universal mode.

## Name status and history reads

Lookup 0.9 adds capability-checked methods for the corresponding on-chain read extension:

```ts
const status = await soran.nameStatus("alice.nova");
// status.state.kind: namespaceMissing | registrarMissing | unregistered | active | expired
// Active/expired states include record.holder, generation and expiresAt.

const rows = await soran.primaryNames([walletA, walletB]);
const scoped = await soran.reverseMany("nova", [walletA, muxedWallet]);
// Each row: { address, kind, ledger, timestamp, ... }
// kind is name (with name), none, or error (with errorCode/errorName).
```

`nameStatus` describes registration, not claimability or payment readiness. Names
can be reserved or restricted by policy, and active names can have unavailable
payment instructions. The status is from the returned ledger and timestamp.

`primaryBatch` and `reverseBatch` each make one contract batch read after checking
deployment capabilities. The initial limit is **two identities**. The limit is an
input bound, not a guarantee that every combination of dependency calls fits a
transaction. Existing contracts can make even two populated rows exceed memory.

For history screens, `primaryNames` and `reverseMany` accept up to **256 identities**.
They try bounded batches and switch to individual reads after a leading host
budget error. The individual reads still use the same on-chain batch methods.
Each row retains its ledger/timestamp, because separate simulations can observe
different ledgers. Order and duplicates are preserved. RPC, restoration, ABI and
other errors reject; they never become `none`. A single read that exceeds budget
also rejects. These helpers do not enumerate names owned by an address.

G/C and full muxed identities remain distinct. A G address plus transaction memo
does not identify a separate reverse-election identity. Disabling G/C Primary in
client options rejects a mixed Primary batch; M-only Primary reads remain available.

## Payment instructions

```ts
const result = await soran.lookup("alice.nova");
if (result.kind === "nativePayment") {
  useCompletePayment(result.payment); // { address, memo }
} else {
  showLegacyAddress(result.address); // memoCapability is "unknown"
}
```

Both variants include canonical name, Registrar, optional Resolver and exact bigint
generation. `legacyAddress` does not establish that no memo is needed.
`resolvePayment`, `verifyPayment`, `resolve`, `record`, `verify` and payment fields
in `details`/`identity` reject legacy results with `LEGACY_MEMO_UNKNOWN`.
Address-only methods also reject a native required memo with `PAYMENT_REQUIRED`.

Payment memos are `{type:"none"}`, `{type:"id",value:"canonical u64 decimal"}`,
`{type:"text",value:"exact UTF-8 text"}` or `{type:"hash",value:"64 lowercase hex"}`.
Text is nonempty and at most 28 UTF-8 bytes. IDs remain strings, never JS numbers.
G addresses support all four; C addresses support `none` only. Muxed M addresses
are self-contained payment destinations with `memo: { type: "none" }`. Their exact
64-bit operation ID stays embedded in the M address; never strip it to G or turn
it into a transaction memo. Additional contract-specific routing arguments remain
outside this ABI. A classic transaction has one memo; separate payments requiring
different memos.

Ordinary native records with no current-generation configuration marker return the
ordinary address with memo `none`. A persistent Resolver marker prevents lost
configured payment instructions from becoming this default. Missing configured,
malformed, stale, archived and unreadable instructions fail closed. Holders remove
memos explicitly with the holder SDK's `setPayment(..., {memo:{type:"none"}})`.
The SDK reads `Lookup.version()` successfully before selecting `resolve` (v1) or
`resolve_v2` (v2). V2 also requires `destination_version() == 2`. Direct mode
selects on a successful native `payment_version()` result of 1 or 2. Unknown,
failed and malformed capabilities are errors; no read error retries through an
older ABI, Registrar address, or direct Resolver. V1 G/C/memo results remain
compatible. Older clients reject the new Lookup version, and raw old Resolver
methods reject muxed destinations instead of returning the base G account.

Rechecking catches stale client data but cannot prevent a holder changing instructions
before a later classic payment settles. Resolver permanence does not freeze holder
records. A payment recipient can be an exchange or another party; a memo-bearing
payment route is not proof the name holder owns that recipient account. Reverse
and Primary results identify an account, not a customer's memo on a pooled account.

### Muxed example

```ts
import { encodeMuxedAddress } from "@sorandomains/lookup";
const address = encodeMuxedAddress(
  "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
  "420",
);
// MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAABUTGI4
const instruction = { address, memo: { type: "none" as const } };
```

This is an illustrative destination, not a request to send funds. `resolve` and
`record` return the full M address when no separate memo is required. A G-plus-ID
memo is a different instruction even if its numeric value matches. Your payment
transport and recipient must support muxed routing. Ownership and signer inputs
remain G/C. Lookup 0.8.0 adds separate complete-M reverse and Primary reads in
universal mode, requiring `muxed_identity_version() == 1` on Lookup. Check
[release status](https://docs.soran.domains/reference/release-status) for verified
publication and deployment before using that extension.

```ts
const inNova = await soran.reverse("nova", address);
const primary = await soran.primaryOf(address);
```

The underlying G account authorizes each M election through Holder
`setReverseMuxed` / `setPrimaryMuxed`. If a custodian controls G, the custodian
must sign; a deposit customer cannot sign merely because they received an M
address. The exact u64 ID is part of the key, including `"0"` and
`"18446744073709551615"`. No G, memo or other-ID fallback is performed.
Changing a payment to M can invalidate its earlier G/C election. M does not
become a separate signer or owner.

## Read API

| Method | Result and semantics |
|---|---|
| `lookup(name)` | Discriminated `LookupResult`: native payment or legacy address with unknown memo capability |
| `resolvePayment(name)` / `verifyPayment(name,payment)` | Complete atomic instructions / fresh exact comparison |
| `resolve(name)` / `record(name)` / `verify(name,address)` | Native memo-free address convenience methods |
| `namespaceMetadata(namespace)` | Namespace owner, routing, policy, provenance flags and permanence, or `null` |
| `nameMetadata(name)` | Holder, built-in address, exact generation/expiry, active/no-expiry flags, or `null`; built-in address is metadata, not effective payment |
| `text(name,key)` | Holder-authored text or `null`; Symbol key and 4096-byte response limits |
| `reverse(namespace,address)` | One namespace's verified canonical display name or `null` |
| `primaryOf(address)` | G/C configured Primary result; complete-M Primary uses Lookup storage independently of `primaryId` |
| `reverseVerify(address,name)` | Scoped reverse comparison |
| `reverseLookup(address,namespaces?)` | Primary first, then ordered bounded namespace probes |
| `reverseNames(address,namespaces?)` | Verified names among candidate namespaces; not global enumeration |
| `assurance(name)` | Attested, locked and untainted Resolver provenance; `trustworthy` requires all three |
| `namespace(namespace)` / `isAvailable(namespace)` | Namespace owner/Resolver subset / absence check |
| `details(name)` | Metadata plus complete effective payment; rejects mixed generations/routing across reads |
| `profile(name)` / `identity(name)` | Standard text fields / full identity view; text is untrusted content |
| `namesOfPage(address,{cursor?,limit?})` | Bounded verified holdings page, continuation and completeness details |
| `namesOf(address)` | Compatibility aggregate, up to 1000 candidates; throws `INCOMPLETE` when partial |
| `walletProfile(address)` | Primary, reverse names and profile; G/C includes first holdings page, M returns `holdings:null` and no owned names |
| `history(name)` | Bounded indexed, informational timeline with ledger/transaction references |
| `namehash(namespace)` / `node(name)` | On-chain hashing helpers |

Universal mode routes forward, metadata, text, scoped reverse and Primary reads
through Lookup. Each invocation checks its Registry anchor and numeric ABI version
`1` or `2`; decoded results have strict names, shapes, addresses, enums and exact bigint
u64s. Separate simulations are not an atomic snapshot of all metadata fields.

Input names/labels must be ASCII before case conversion. ASCII uppercase is
canonicalized to lowercase. Unicode lookalikes, including characters that would
lowercase into ASCII, are rejected. Leading/trailing whitespace is not removed.
On-chain reverse/Primary answers must already be canonical lowercase names.

For G/C, a successful `primaryOf` returning `null` means Primary supplied no verified name.
The existing Primary ABI also collapses failed dependent proof reads into `None`,
so this cannot distinguish absence from every downstream failure. Lookup errors
such as `PrimaryNotConfigured` still throw. `reverseLookup` and `reverseNames`
can recover from a Primary failure by probing the candidate namespaces through
Lookup. Direct mode verifies the configured G/C Primary's Registry anchor before reading.

M reads use `reverse_muxed` / `primary_name_muxed` on Lookup with the exact decoded
G and u64 ID. Direct mode rejects M identity with `CONFIG`. Missing or proven stale
M elections return null; malformed records, unknown capabilities and unavailable
dependencies fail. An M Primary must match a valid current M reverse snapshot,
including Registrar, Resolver and generation. A transferred/reissued name needs
a new election. `primaryId` affects only G/C Primary; M needs the matching Lookup.

## Discovery and completeness

```ts
const page = await soran.namesOfPage(address, { limit: 40 });
render(page.names);
showCoverage(page.coverage, page.verification);
if (page.hasMore) showNextPage(page.nextCursor!);
```

`namesOfPage` uses the optional indexer `hintUrl` for candidate discovery and
checks each candidate's current holder and active state on chain. Results contain
`nextCursor`, `hasMore`, `complete`, indexer `coverage`, and verification counts
(`candidates`, `verified`, `excluded`, `failed`). A failed candidate is distinct from
a proven stale/nonheld one. Pages are limited to 100 candidates with bounded concurrency.

Coverage includes processed/head ledgers and explicit gaps. It is the indexer's
report, not a proof it omitted nothing. `complete` is true only for a final page
whose indexer reports complete coverage and whose candidate checks did not fail.
`namesOf` refuses partial aggregates instead of silently claiming all holdings.
`walletProfile.names` is the first verified page; use `walletProfile.holdings` to
continue. `namesOf` and `namesOfPage` accept G/C holder addresses, not M routing
IDs. An M wallet profile does not return the base G account's holdings. Indexer
history remains informational and is not on-chain ownership proof.

## Configuration and trust

```ts
new Soran({
  network: "testnet",
  registryId: verifiedRegistryId,
  lookupId: verifiedLookupId,
  rpcUrl: trustedRpcUrl,
  passphrase: networkPassphrase,
  primaryId: verifiedPrimaryId, // optional extra anchor check; null disables Primary
  reverseNamespaces: ["nova"],
  hintUrl: discoveryApiUrl,
  timeoutMs: 10_000,
});
```

The RPC, network/passphrase and deployed addresses are trusted configuration. Lookup
uses Registry routes and supports only reviewed implementations. Native compatibility
checks do not prove custom or upgraded namespace code is honest. Namespace owners
choose Resolvers and holders choose payment instructions.

Lookup governance can execute approved upgrades immediately: there is **no mandatory
upgrade delay**. Registry/version checks validate reported wiring and ABI; they do
not pin the executable code or constrain upgraded code. Review the current Wasm,
governance and upgrade state. Namespace `assurance().trustworthy` covers Resolver
provenance only; it does not cover Lookup governance, recipient identity or RPC honesty.

V2 adds `destination_version`, `resolve_v2` and strict `resolve_destination`.
`ResolutionV2.result` is `NativePayment(PaymentDestination) | LegacyAddress(Address)`,
where `PaymentDestination` is `Direct(Payment) | Muxed({account: Address, id: u64})`.
The Muxed account must be G. The SDK reconstructs the canonical full M address.
`encodeMuxedAddress(account, id)` and `decodeMuxedAddress(address)` preserve IDs as
canonical decimal strings, including `0` and `18446744073709551615`. They never
establish that a recipient supports an alternative G-plus-memo route.

The original direct contract ABI includes `registry`, `version`, `primary`, `resolve`,
`resolve_payment`, `resolve_address`, `namespace_metadata`, `name_metadata`, `text`,
`reverse` and `primary_name`. Send canonical lowercase strings. `ResolutionResult`
is `NativePayment(Payment) | LegacyAddress(Address)` and `PaymentMemo` is
`None | Id(u64) | Text(String) | Hash(BytesN<32>)`. Strict helpers reject legacy
(error 12), required memos in address-only reads (error 13), and muxed destinations in the original methods (error 22).

Failures are `SoranError` with `code`: `INVALID_INPUT`, `CONFIG`, `RPC`, `SIMULATION`,
`ARCHIVED`, `ABI`, `TIMEOUT`, `PAYMENT_REQUIRED`, `LEGACY_MEMO_UNKNOWN`, `INCOMPLETE`.
Recognized top-level Lookup contract failures also have `contractCode` and
`contractError`. Unknown formats stay unclassified; nested diagnostic strings are
not promoted to top-level errors. Do not branch on prose messages.

Supports Node, browsers and workers. This release is tested against Stellar SDK17
and declares peer `>=17 <18`. It does not claim untested SDK14–16 compatibility.


## Native username claiming

Version 0.7.0 selects the native-claim successor testnet deployment while retaining the existing Universal Lookup V2 payment API. Ownership, payment routes and account identity remain distinct. A username with the same spelling in another Registry is a separate record.

Read the [native claim APIs, security boundaries and complete signup flow](https://github.com/SoranDomains/sdk/blob/main/NATIVE-CLAIMS.md). G/no memo, G with ID/Text/Hash, full M/no separate memo and C/no memo remain supported payment destinations. Current transaction-signing adapters use classic G accounts.

## Verified testnet deployment

Verified on 6 September 2026 at ledger **4534629** (12:12 UTC). Network passphrase: `Test SDF Network ; September 2015`.

| Contract | Address |
|---|---|
| Registry | `CBSORANPM664QXYMYRZKLQDQE2TXFSK4GBMC6EIRSRTAUZRZCRZRFNMK` |
| Lookup | `CDSORANQAJK35UV2HR63CMB6M5NYISHMUBTB6EQY2CZ3Y7HJDIOHRJWA` |
| Primary | `CASORAN755O3GCQTRAHKDXLLCSDLNKAQWAP6MWABRSFVSHLJOEKAC7AB` |
| Allocator | `CCSORANYFHUJUWETEQ7UWIDN4JTPV7NN5G6YUSSBZI57X7EQWVA63VMJ` |

Mainnet has no deployment preset. Custom networks must supply their own verified
addresses. Universal Lookup upgrades remain immediately executable; an address
and ABI version do not pin the code that will execute after a governance upgrade.
