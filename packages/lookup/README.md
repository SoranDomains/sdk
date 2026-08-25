# @sorandomains/lookup

Resolve Soran names (`alice.nova`) on Stellar — **trustlessly, straight from the
chain**. No Soran servers in the trust path: every call is a read-only Soroban
RPC simulation against the deployed contracts. Point it at any RPC you trust,
including your own.

```ts
import { Soran } from "@sorandomains/lookup";

const soran = new Soran({ network: "testnet" });

await soran.resolve("alice.nova");
// "GDHNO4WK…"  (null if unissued, expired, or namespace has no public resolver)
```

## Wallet integration in three calls

```ts
// 1. Send-to-name: swap the address field for a name field.
const dest = await soran.resolve(input);          // "alice.nova" → G…
if (!dest) throw new Error("name doesn't resolve");

// 2. Safety re-check at confirm time (names can move between keystrokes
//    and confirmation — expired, transferred, reissued):
if (!(await soran.verify(input, dest))) throw new Error("resolution changed");

// 3. Show names instead of addresses in history (verified, never spoofable):
const name = await soran.reverseLookup(sender);   // contract-verified plaintext, straight from the Resolver
// or, if you already have a candidate:
const ok = await soran.reverseVerify(sender, "alice.nova");
```

## API

| Call | Returns | Notes |
|---|---|---|
| `resolve(name)` | `string \| null` | The address the name pays to |
| `record(name)` | `{ name, address, node, resolver }` | Full resolution record |
| `verify(name, addr)` | `boolean` | Pay-to-name safety check |
| `text(name, key)` | `string \| null` | Text records (`url`, `avatar`, …) |
| `reverseVerify(addr, name)` | `boolean` | Trustless reverse check: the Resolver's `name_of` enforces the reverse record's freshness **and** the forward match on chain |
| `reverseLookup(addr, namespaces?)` | `string \| null` | Primary name first (if `primaryId` set), then a pure on-chain read across candidate namespaces, probed in parallel with deterministic priority; `hintUrl` may supply only the namespace LIST — a lying hint can hide a name, never forge one |
| `primaryOf(addr)` | `string \| null` | Cross-namespace primary display name (requires `primaryId`); already contract-verified — the PrimaryName contract re-checks the namespace Resolver's live `name_of` on every read. Read failures throw, never masquerade as "no primary" |
| `assurance(name)` | `{ resolverAttested, resolverTainted, resolverLocked, trustworthy }` | Opt-in trust check on the namespace's resolver (attested by the Registry, never upgraded, locked by permanence). `resolve()` follows the owner's pointer regardless — use this before trusting a resolution for high-value display/payment |
| `details(name)` | `NameDetails` | The full live picture in one call: resolution, holder, expiry, generation, namespace owner/registrar/resolver, policy, permanence, assurance. Registration *date* is deliberately absent — the chain stores no timestamps (see `history`) |
| `namespace(ns)` | `{ owner, resolver } \| null` | Namespace-level record |
| `isAvailable(ns)` | `boolean` | Unregistered → claimable via the public window |
| `namehash(ns)` / `node(name)` | `Uint8Array` | The exact on-chain hashing, exposed |

### Identity & enumeration

| Call | Returns | Trust |
|---|---|---|
| `namesOf(addr)` | `NameSummary[]` | Every name a wallet holds — candidates discovered via `hintUrl`'s indexer, then EACH verified on chain (`holder_of_node`, contract expiry-gated). The hint can omit, never forge. Best-effort: failing/archived candidates are skipped |
| `reverseNames(addr, namespaces?)` | `ReverseName[]` | ALL contract-verified reverse names, with the cross-namespace primary flagged |
| `profile(name)` | `SoranProfile` | The standard `PROFILE_KEYS` text records (`org`, `url`, `email`, `description`, `avatar`, `location`, `twitter`, `github`) — generation-gated on chain; values are holder-authored free text, render as untrusted |
| `identity(name)` | `NameIdentity` | One-call name page: `details` + `profile` + holder primary + verified display name + the namespace owner's primary name |
| `walletProfile(addr)` | `WalletProfile` | One-call wallet page: primary + reverse names + verified holdings + the primary's profile |
| `history(name)` | `NameHistory` | Issued/transferred/reclaimed timeline — **indexed, informational** (the chain stores no timestamps); every entry carries `ledger` + `txHash` for independent verification. Needs `hintUrl` |

## Options

```ts
new Soran({
  network: "testnet",              // deployment preset (mainnet at launch)
  rpcUrl: "https://your-rpc",      // bring your own RPC
  registryId: "C…",                // override the immutable Registry
  primaryId: "C…",                 // PrimaryName contract id (the testnet preset
                                   // supplies one — pass `null` to DISABLE the feature)
  registrars: { nova: "C…" },      // closed (registrar-side) resolution opt-in
  reverseNamespaces: ["nova"],     // which Resolvers reverseLookup probes (in order)
  resolverCacheTtlMs: 30_000,      // how long a namespace→resolver pointer is cached (0 = off)
  hintUrl: "https://your-deployment-api", // OPTIONAL discovery/indexer source: the
                                   // namespace-list hint for reverseLookup, the
                                   // candidate list for namesOf (each candidate
                                   // chain-verified), and the history() timeline.
                                   // It can omit; it can never forge
  timeoutMs: 10_000,               // per-chain-read wait bound → SoranError "TIMEOUT"
                                   // (unset = no SDK-imposed bound)
});
```

## Errors

Every failure is a `SoranError` with a machine-readable `code` — branch on it,
not on message text: `INVALID_INPUT`, `CONFIG`, `RPC`, `SIMULATION`,
`ARCHIVED` (the entry exists but its rent lapsed), `ABI`, `TIMEOUT`. A `null`
return always means a *successful* read that found nothing.

## Primary name (optional, cross-namespace)

An address may additionally declare ONE **primary name** on the
platform-deployed, immutable `PrimaryName` contract — a single display name
that works across namespaces (a user holding both `alice.nova` and
`alice.stellar` picks one to show everywhere). The primary adds no new trust:
it is only a pointer to a name, and the contract re-runs that namespace's own
Resolver `name_of` gates on **every** read, answering `None` the moment the
stored name stops verifying — so the SDK's `primaryOf(addr)` answer is already
contract-verified and needs no client-side re-check. Per-namespace reverse
records are unchanged and keep working exactly as before; when `primaryId` is
configured, `reverseLookup` simply asks PrimaryName first and falls back to
the per-namespace probes when there is no primary (a *failed* primary read
also degrades to the namespace probes rather than failing the lookup — the
optional pointer must not break the pre-existing baseline). Because each
`primary_of` read costs two cross-contract calls in simulation, wallets
rendering address lists are expected to apply brief client-side caching
(seconds, the same discipline as `resolverCacheTtlMs`) for batch rendering —
correctness never depends on any cache, since the contract re-verifies on
every read. Writes (`set_primary` / `clear_primary`) are address-authorized
transactions built and signed by wallets; the SDK only reads.

## Trust model

- **Forward resolution** is verified by the contracts themselves: records are
  bound to the name's ownership *generation*, so expired, reissued, or
  transferred names stop resolving on chain — the SDK never has to guess.
- **Reverse resolution** is self-contained and contract-verified: reverse
  records store the PLAINTEXT name, and the Resolver's `name_of` answers only
  while the name is live (generation match) *and* its forward record points
  back to the address — so a reverse answer needs no hint service and no
  client-side re-check. Because reverse records live on per-namespace
  Resolvers, `reverseLookup` probes candidate namespaces (`reverseNamespaces`
  or the per-call param, in parallel with deterministic priority); an optional
  `hintUrl` can supply just the namespace **list** — a liveness hint that can
  hide a name by omission, but can never forge one.
- The only trusted inputs are the RPC endpoint you choose and the immutable
  Registry id (published, verifiable on-network).

Works in browsers, Node, and workers out of the box — this package ships zero
Node built-ins of its own (enforced in CI by a browser-bundle check), with
`@stellar/stellar-sdk` as the only peer dependency.
