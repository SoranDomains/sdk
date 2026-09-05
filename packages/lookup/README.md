# @sorandomains/lookup

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
2026-09-05 deployment; no extra contract configuration is needed. A network without a Lookup pin fails with
`CONFIG`; it never silently uses direct Resolver calls. Mainnet has no preset until
its reviewed deployment exists. A custom Registry or passphrase does not inherit
Lookup or Primary pins from another deployment. The deployment anchors, Lookup version and code hashes were verified at ledger
4520986. Older testnet clients require this package update to follow the new Registry.

Explicit compatibility mode remains available with `resolutionMode: "direct"`
(or `lookupId: null`). Direct mode discovers native Resolvers from Registry and
checks their Registry, Registrar authority and payment API version. It has no
old-address fallback. The universal-only `lookup`, `namespaceMetadata` and
`nameMetadata` methods require universal mode.

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
G addresses support all four; C addresses support `none` only. M addresses and
contract-specific routing arguments are outside this ABI. A classic transaction
has one memo; separate payments requiring different memos.

Ordinary native records with no current-generation configuration marker return the
ordinary address with memo `none`. A persistent Resolver marker prevents lost
configured payment instructions from becoming this default. Missing configured,
malformed, stale, archived and unreadable instructions fail closed. Holders remove
memos explicitly with the holder SDK's `setPayment(..., {memo:{type:"none"}})`.
No read error retries through an old ABI, Registrar address, or direct Resolver.

Rechecking catches stale client data but cannot prevent a holder changing instructions
before a later classic payment settles. Resolver permanence does not freeze holder
records. A payment recipient can be an exchange or another party; a memo-bearing
payment route is not proof the name holder owns that recipient account. Reverse
and Primary results identify an account, not a customer's memo on a pooled account.

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
| `primaryOf(address)` | Universal Lookup's configured Primary result; `primaryId:null` disables it |
| `reverseVerify(address,name)` | Scoped reverse comparison |
| `reverseLookup(address,namespaces?)` | Primary first, then ordered bounded namespace probes |
| `reverseNames(address,namespaces?)` | Verified names among candidate namespaces; not global enumeration |
| `assurance(name)` | Attested, locked and untainted Resolver provenance; `trustworthy` requires all three |
| `namespace(namespace)` / `isAvailable(namespace)` | Namespace owner/Resolver subset / absence check |
| `details(name)` | Metadata plus complete effective payment; rejects mixed generations/routing across reads |
| `profile(name)` / `identity(name)` | Standard text fields / full identity view; text is untrusted content |
| `namesOfPage(address,{cursor?,limit?})` | Bounded verified holdings page, continuation and completeness details |
| `namesOf(address)` | Compatibility aggregate, up to 1000 candidates; throws `INCOMPLETE` when partial |
| `walletProfile(address)` | Primary, reverse names, first holdings page and profile; inspect `holdings` for continuation/coverage |
| `history(name)` | Bounded indexed, informational timeline with ledger/transaction references |
| `namehash(namespace)` / `node(name)` | On-chain hashing helpers |

Universal mode routes forward, metadata, text, scoped reverse and Primary reads
through Lookup. Each invocation checks its Registry anchor and numeric ABI version
`1`; decoded results have strict names, shapes, addresses, enums and exact bigint
u64s. Separate simulations are not an atomic snapshot of all metadata fields.

Input names/labels must be ASCII before case conversion. ASCII uppercase is
canonicalized to lowercase. Unicode lookalikes, including characters that would
lowercase into ASCII, are rejected. Leading/trailing whitespace is not removed.
On-chain reverse/Primary answers must already be canonical lowercase names.

A successful `primaryOf` returning `null` means Primary supplied no verified name.
The existing Primary ABI also collapses failed dependent proof reads into `None`,
so this cannot distinguish absence from every downstream failure. Lookup errors
such as `PrimaryNotConfigured` still throw. `reverseLookup` and `reverseNames`
can recover from a Primary failure by probing the candidate namespaces through
Lookup. Direct mode verifies the configured Primary's Registry anchor before reading.

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
continue. Indexer history remains informational and is not on-chain ownership proof.

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

Direct contract ABI includes `registry`, `version`, `primary`, `resolve`,
`resolve_payment`, `resolve_address`, `namespace_metadata`, `name_metadata`, `text`,
`reverse` and `primary_name`. Send canonical lowercase strings. `ResolutionResult`
is `NativePayment(Payment) | LegacyAddress(Address)` and `PaymentMemo` is
`None | Id(u64) | Text(String) | Hash(BytesN<32>)`. Strict helpers reject legacy
(error 12) and required memos in address-only reads (error 13).

Failures are `SoranError` with `code`: `INVALID_INPUT`, `CONFIG`, `RPC`, `SIMULATION`,
`ARCHIVED`, `ABI`, `TIMEOUT`, `PAYMENT_REQUIRED`, `LEGACY_MEMO_UNKNOWN`, `INCOMPLETE`.
Recognized top-level Lookup contract failures also have `contractCode` and
`contractError`. Unknown formats stay unclassified; nested diagnostic strings are
not promoted to top-level errors. Do not branch on prose messages.

Supports Node, browsers and workers. This release is tested against Stellar SDK17
and declares peer `>=17 <18`. It does not claim untested SDK14–16 compatibility.

## Verified testnet deployment

Verified on 2026-09-05 at ledger 4520986. Network passphrase: `Test SDF Network ; September 2015`.

| Contract | Address |
|---|---|
| Registry | `CDSORANCV3IFF3MKHJ7KI4MKEJOJZFMTDVAZCD5XFOR4WTGNXJJNOKQE` |
| Lookup | `CDSORANO7K4FSBR2MLV4PNELJ6UXCDNG4MJZSH6HCVZZZQN5B5GMOP64` |
| Primary | `CCSORANOADXKLSW5CUANBW5WZFVCNZ5KZ4KNMIUWOZOES3LXYRUYZ56X` |
| Allocator | `CASORANSKKNXDJYXPZK7OJFIJQL5EMVO7VLYJJSWTCZLT26WWATBI4HY` |

Mainnet has no deployment preset. Custom networks must supply their own verified
addresses. Universal Lookup upgrades remain immediately executable; an address
and ABI version do not pin the code that will execute after a governance upgrade.
