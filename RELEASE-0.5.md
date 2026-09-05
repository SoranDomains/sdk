# Namespace-bound deployment SDK release

The published release contains lookup 0.5.2, holder 0.3.1, owner 0.5.1 and MCP 0.5.1,
with Stellar SDK17 compatibility and verified testnet defaults. See
[deployments/testnet.json](deployments/testnet.json) for deployment and code proof.

Lookup routes forward payment, metadata, text, scoped reverse and Primary reads
through the universal on-chain entry point. It checks the Registry anchor and ABI
version, validates exact result shapes and preserves u64 generations as bigint.
Native payment and legacy address results remain distinct. Payment readers never
interpret an unknown legacy memo capability as an explicit memo `none`.

ASCII validation precedes lowercasing in all packages. Holdings pages preserve
cursor, verification failures and indexer coverage; bounded aggregate discovery
fails explicitly when incomplete. Coverage remains an indexer's report, not proof
that it did not omit names. Primary can return no verified name when a dependent
proof fails, as well as when no name is configured.

Holder writes still call the namespace Resolver. Primary writes verify their
Registry anchor. Lookup's provenance flags assess namespace Resolver lock and
attestation; they do not assess Lookup governance or prove ownership of a payment
recipient. Governance upgrades to Lookup require no delay, so an address and
reported ABI version alone do not pin its executable code.

MCP uses the same default Registry, Lookup, Primary and Allocator. Public-window
claim fees are 5,000 testnet XLM at this deployment; a fresh quote and independent
on-chain policy read are required for signing. Claim fees are separate from
objection bonds. Settlement is attempted immediately; undelivered amounts remain
protected credits. An unopposed claim becomes eligible for permissionless execution
and is awarded only after execution confirms. Governance evaluates objections.

Validation includes all package builds, type checks and tests, browser bundles for
the three client SDKs, exact tarball contents, clean installed runtime/type checks,
and read-only testnet anchors, namespace metadata, fee policy and expected
unissued-name rejection. It does not claim a live payment or refund smoke test.


This patch release updates all testnet defaults to the namespace-bound Registry
release verified at ledger 4520986. Lookup, Registrar, Resolver, Primary and
Allocator ABIs remain unchanged. MCP activation now derives the Registrar address
from the namespace, Registrar role and nonce, independently of the API's predicted
address or version. It requires a Soran-branded address in its v1 flow. Custom
Registries require a locally selected deployment salt version; explicit legacy v0
keeps its prior address derivation.

MCP returns a pending result while vanity generation runs and provides scoped
`cancel_namespace_activation` for restarting a queued, failed or ready search.
Cancellation changes only the service's generation job. Initial non-reclaimable,
zero-term issuance is not the final permanence commitment; `make_permanent`
performs the separate irreversible lock.

All four packages are published, with npm's latest tags pointing to these versions.
Downloaded package archives match the reviewed release files byte for byte.
MCP's registry lockfile uses the exact published client SDK versions; its clean
install, vulnerability audit, build, typecheck and tests pass with those dependencies.
The hosted MCP service also reports 0.5.1 and has passed handshake, tool discovery
and read-only on-chain fee checks against this deployment.
