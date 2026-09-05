# Native muxed SDK release

Release versions: lookup **0.6.0**, holder **0.4.0**, owner **0.6.0**, MCP **0.6.0**.
The native muxed testnet contracts were verified at ledger **4521644** on
5 September 2026 (18:10 UTC). All four declare Stellar SDK `>=17 <18` and
are tested against 17.0.1; old SDK14–16 XDR compatibility is not claimed.

Universal Lookup is now the default read route. Missing verified deployment pins
fail closed with `CONFIG`. `resolutionMode:"direct"` (or explicit `lookupId:null`)
selects native Resolver compatibility mode. Custom Registry/passphrase settings
never inherit Lookup or Primary pins from another deployment. Mainnet remains
unconfigured until a reviewed deployment exists. Do not publish placeholder C IDs.

The presets contain the verified native muxed deployment. App/API/MCP cutover
and npm publication are recorded independently in the public release status.

## Procedure for future validation and publication

The monorepo builds lookup, holder and owner before its locally linked MCP.
This public repository uses exact matching registry versions for MCP; install
those packages only after their publication is verified. Run each package's
`build`, `typecheck`, and `test`, and run `check:browser` for lookup/holder/owner.
Build the worker with a local dry run. Keep the lookup and holder payment helpers
identical when modifying their shared wire format.

Use independent dependency installations for release checks. The public MCP package
uses exact matching npm dependencies; update its registry lockfile only after
lookup, holder, and owner publication is verified. A clean install/build/test must
pass before publishing MCP. The monorepo retains local file links for development
and must not publish that manifest unchanged. Rebuild the hosted worker against
the verified package set and matching Registry, Lookup, Primary, Allocator, RPC,
and passphrase configuration. Both transports use `MCP_VERSION`.

The verified public-window
claim fee is 5,000 testnet XLM; fetch the live quote before signing because the
on-chain fee policy is authoritative. Mainnet is not deployed.

## Compatibility and trust

Universal forward, metadata, text, scoped reverse and Primary reads share one
on-chain entry point. Every SDK invocation checks Lookup's Registry/version and
strictly decodes canonical names, context, exact u64 bigints, addresses and enum
shapes. Failed universal calls never retry directly. `lookup` exposes native payment
and legacy address variants distinctly; strict payment methods reject legacy.
Address-only convenience methods reject required native memos. Original Payment
and Resolution method layouts remain available, but old methods reject M. New
Lookup version 2 uses resolve_v2 and destination_version 2. Successful version 1
keeps old G/C/memo reads. Native Resolver payment_version 2 requires
destination_version 2; unknown or failed capability reads never downgrade.

Native payment records are atomic Resolver instructions. Missing configured records
never become memo None. G accounts support none/id/text/hash; C contracts support
none. IDs are canonical decimal strings, text preserves exact UTF-8 within 1–28
bytes, and hashes are lowercase 32-byte hex. Muxed M input is supported as M plus memo none, stored as on-chain G plus exact
u64 ID. There is no automatic conversion to G plus an ID memo. The recipient must explicitly
support any alternative route. See [address and memo examples](https://docs.soran.domains/concepts/payment-destinations).
Holder writes still discover and call
namespace Resolvers. Primary holder writes verify the Registry anchor before signing.

ASCII validation precedes lowercase conversion across lookup, holder, owner and
MCP. Unicode lookalikes are rejected. Lookup metadata keeps holder/built-in address
separate from effective payment instructions. Namespace assurance preserves the
attested, locked, untainted gates; it does not assess Lookup governance or recipient
ownership. Lookup governance upgrades have no required delay, and reported version
2 is not an executable-code pin. The existing Primary None result cannot distinguish
absence from every downstream proof failure.

Holdings pages expose cursors, ledger coverage/gaps and failed/excluded verification
counts. Coverage is the indexer's report, not proof against omission. Aggregate
`namesOf` fails with `INCOMPLETE` when bounded discovery is partial; wallet profiles
carry the first page and continuation metadata. History remains informational.

MCP claim signing requires a reviewed exact fee quote and an explicit network-fee
ceiling. It independently reads the pinned Allocator fee policy, derives the native
XLM token from the local passphrase, checks the selected label/claimant/evidence and
requires exactly the selected escrow transfer in source authorization. Withdrawals
pin the Allocator/label; activation pins Registry, namespace, treasury, policy,
nonce and predicted Registrar address. The Registry derives its v1 deployment salt
from the namespace node, role byte and nonce on chain. The browser and MCP derive
the address independently from signed arguments and require the Soran prefix in
v1; API-supplied predictions and version claims are not trusted. Generation can
return pending status, and cancellation clears only the off-chain generation job.
MCP caps network fees for both claim and activation signing. Sign-in challenges require the API's sequence 1 (Account sequence 0 before build),
short expiry, bounded fee and exact authentication data key. Claim fees and objection bonds are distinct; settlement is attempted immediately, and undelivered amounts remain protected credits.
