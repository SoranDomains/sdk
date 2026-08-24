/**
 * CHANGELOG (Option A — plaintext reverse records, BREAKING):
 * - This SDK version requires the post-Option-A Resolver ABI:
 *   `set_reverse(addr: Address, name: String)` (the node param is GONE — the
 *   contract derives the node from the name string, validates label syntax,
 *   and enforces the live-name + forward-match gates on-chain) and
 *   `name_of(addr) -> Option<String>` returning the FULL PLAINTEXT NAME
 *   ("alice.nova"), already gated on-chain by generation + forward-match
 *   checks. scValToNative decodes the String straight to a JS string — a
 *   plain string is the only legitimate shape. This SDK does NOT interoperate
 *   with pre-Option-A Resolvers, whose `name_of` returned a 32-byte node hash.
 * - `reverseLookup` is a pure on-chain read: candidate namespaces are probed
 *   IN PARALLEL, with DETERMINISTIC priority — when several Resolvers answer,
 *   the one earliest in the configured order wins.
 * - `hintUrl` is deprecated FOR ANSWERS but still serves one liveness-only
 *   job: when neither the per-call `namespaces` param nor `reverseNamespaces`
 *   is configured, `reverseLookup` fetches a namespace-LIST hint from the hint
 *   service, then probes those namespaces' Resolvers on chain as usual. The
 *   hint cannot forge anything — every candidate answer is still
 *   contract-verified by `name_of`'s on-chain gates.
 * - `reverseVerify` string-compares the contract-verified plaintext instead of
 *   hashing a candidate node and re-checking the forward record client-side.
 * - New `reverseNamespaces` option / per-call param scopes `reverseLookup`
 *   (reverse records live on per-namespace Resolvers, so the SDK must be told
 *   which namespaces to query when no name is known — or given a list hint).
 * - The SDK never built `set_reverse`/`clear_reverse` transactions (writes go
 *   through wallet signing); no transaction-builder changes were needed.
 */

/**
 * CHANGELOG (PrimaryName — ADDITIVE, optional):
 * - New `primaryId` option points the SDK at the platform-deployed PrimaryName
 *   contract (one immutable instance per network; per-network preset lands in
 *   DEPLOYMENTS once deployed — see the TODO there). With no `primaryId`,
 *   behavior is byte-identical to the Option-A-only build.
 * - New `primaryOf(addr)`: a plain `primary_of` read, string-decoded, and
 *   fail-closed — a transport/ABI failure THROWS a SoranError and never
 *   masquerades as "no primary". No SDK-side verification of the answer is
 *   needed: the contract is self-verifying (it re-runs the namespace
 *   Resolver's live `name_of` gates on every read and answers None the moment
 *   the stored name stops passing).
 * - `reverseLookup` now tries the primary FIRST (when `primaryId` is set),
 *   then the configured/hinted namespaces in parallel with priority order
 *   (existing logic). A FAILED primary read falls through to the namespace
 *   probes rather than failing the whole lookup — documented on the method.
 *   Namespace-probe failures still throw, unchanged.
 * - No transaction builders: `set_primary`/`clear_primary` are
 *   address-authorized writes built and signed by wallets; the SDK only reads.
 */

/**
 * @sorandomains/sdk — resolve Soran names on Stellar, trustlessly.
 *
 * Everything here is a READ against the deployed contracts via Soroban RPC
 * simulation: no signer, no fees, no Soran servers in the trust path. A wallet
 * that integrates this resolves `alice.nova` the same way the chain would.
 *
 *   import { Soran } from "@sorandomains/sdk";
 *   const soran = new Soran({ network: "testnet" });
 *   await soran.resolve("alice.nova");        // → "GDHN…" | null
 *   await soran.verify("alice.nova", "GDHN…"); // → true (pay-to-name safety)
 *   await soran.reverseVerify("GDHN…", "alice.nova"); // → true
 *
 * ## Resolution algorithm (canonical)
 * 1. Split `label.namespace`; both parts must be canonical ([a-z0-9-], 1–63).
 * 2. nsNode   = sha256(ZERO32 ‖ sha256(namespace))       — Registry namehash
 * 3. nameNode = sha256(nsNode ‖ sha256(label))           — Registrar subnode
 * 4. resolver = Registry.resolver_of(nsNode)              — owner's opt-in
 * 5. address  = Resolver.addr(nameNode)                   — generation-checked
 *    on chain: expired, reissued, or transferred names return null by contract
 *    logic, not by SDK guesswork.
 * A namespace with no resolver set is not publicly resolvable (the owner can
 * also run closed resolution via their Registrar; pass `registrars` to use it).
 *
 * ## Reverse resolution (address → name)
 * Reverse records store the PLAINTEXT name on chain (Option A). The Resolver's
 * `name_of(addr)` answers with the full name only while the name is still live
 * (generation match) AND its forward record resolves back to the address:
 * every reverse answer is self-contained and contract-verified, with
 * no hint service in the trust path. `reverseVerify(addr, name)` is a pure
 * string comparison against that verified answer. Because reverse records live
 * on per-namespace Resolvers, `reverseLookup(addr)` needs to know which
 * namespaces to probe — pass `reverseNamespaces` or the per-call param, or set
 * `hintUrl` to let the SDK fetch a namespace-LIST hint (liveness only; every
 * answer is still contract-verified).
 *
 * ## Primary name (optional, cross-namespace)
 * The platform-deployed PrimaryName contract lets an address declare ONE
 * display name across all namespaces. It adds no new trust: a primary is only
 * a pointer to a name the namespace's own Resolver already verifies —
 * `primary_of(addr)` re-runs the Resolver's live `name_of` gates on every read
 * and answers None the moment the stored name stops verifying, so the SDK's
 * answer is already contract-verified and needs no extra client-side check.
 * When `primaryId` is configured, `reverseLookup` asks PrimaryName FIRST and
 * falls back to the per-namespace probes only when there is no primary (or
 * when the primary read itself fails — see `reverseLookup`). Per-namespace
 * reverse records and `reverseVerify` are unchanged.
 *
 * READ COST: each `primary_of` simulation performs two
 * cross-contract calls (resolver_of + name_of) on chain. Wallets rendering
 * address lists are expected to apply brief CLIENT-side caching (seconds —
 * the same discipline as `resolverCacheTtlMs`) for batch rendering.
 * Correctness never depends on any cache: the contract re-verifies on every
 * read, so a stale cache can only delay noticing a change, never fabricate a
 * wrong name.
 */

import {
  Account,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

/** Known public deployments. Override any field via SoranOptions. */
export const DEPLOYMENTS = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: Networks.TESTNET as string,
    // The immutable Registry pins the approved Registrar/Resolver Wasm; the SDK
    // reads resolver_of/owner_of from it, so pointing at the current Registry is
    // enough. Updated by the platform on every redeploy.
    registryId: "CAUEHYVLLNNDZ4H5QWCPBDWEONRI44SI3XYSEACB4U3HYILIVQGQAMNI",
    // Platform-deployed PrimaryName (soran-primary), anchored to the Registry
    // above — immutable, unpinned, one instance per network. Integrators get the
    // primary-name step by default; omit/override via SoranOptions.primaryId.
    // Updated by the platform on every redeploy.
    primaryId: "CAZMXB6UBXKL4DGC2GUC5VKHIZMF47CIZXZFAZPYLM2RP6ZJZNSIIYS2",
  },
  // mainnet: populated at mainnet launch
} as const;

/**
 * Structural type of a deployment preset. `primaryId` is optional because the
 * preset is only filled in once the PrimaryName contract is actually deployed
 * on that network (see the TODO in DEPLOYMENTS).
 */
type DeploymentPreset = {
  rpcUrl: string;
  passphrase: string;
  registryId: string;
  primaryId?: string;
};

export type SoranOptions = {
  /** "testnet" today; "mainnet" after launch. */
  network?: keyof typeof DEPLOYMENTS;
  /** Override the RPC endpoint (any Soroban RPC works — run your own). */
  rpcUrl?: string;
  /** Override the network passphrase. */
  passphrase?: string;
  /** Override the immutable Registry id. */
  registryId?: string;
  /**
   * Optional id of the platform-deployed PrimaryName contract (one immutable
   * instance per network). Pass `null` to opt out even when the network preset
   * ships one. When set, `primaryOf(addr)` is enabled and
   * `reverseLookup` asks PrimaryName before the per-namespace probes. Validated
   * with StrKey.isValidContract at construction (fail-closed: a malformed id is
   * a config bug, surfaced immediately). Omit to disable the feature entirely;
   * a per-network preset lands in DEPLOYMENTS once deployed (see the TODO
   * there). The contract is self-verifying — `primary_of` re-runs the
   * namespace Resolver's live `name_of` gates on every read — so no extra
   * SDK-side verification of the answer is ever needed.
   */
  primaryId?: string | null;
  /**
   * Optional per-namespace Registrar ids for namespaces that run closed
   * (registrar-side) resolution instead of a public Resolver.
   */
  registrars?: Record<string, string>;
  /**
   * Optional hint-service base URL, used ONLY as a namespace-LIST hint for
   * `reverseLookup` when neither the per-call `namespaces` param nor the
   * `reverseNamespaces` option is configured (the SDK fetches the service's
   * namespace list and probes those Resolvers on chain).
   *
   * Deprecated FOR ANSWERS since the Option-A upgrade: reverse answers are
   * self-contained on chain (`name_of` returns the plaintext name, verified by
   * the contract's generation + forward-match gates), so the hint is never in
   * the trust path. It can only fix LIVENESS (which namespaces to probe); the
   * worst a lying hint can do is omit a namespace and hide a name — never
   * forge one.
   */
  hintUrl?: string;
  /**
   * Namespaces whose Resolvers `reverseLookup(addr)` queries, in order.
   * Reverse records live on per-namespace Resolvers and the chain cannot
   * enumerate them, so without a known name there is no on-chain way to
   * discover which Resolver holds an address's record — the caller must scope
   * the search. Default [] (reverseLookup then returns null).
   */
  reverseNamespaces?: string[];
  /**
   * How long a namespace→resolver lookup is cached, in ms. The pointer
   * CAN change for a reclaimable namespace (the owner repoints), so a long-lived
   * instance must not cache it forever or it will resolve to a stale resolver.
   * Default 30_000. Set 0 to disable caching (always read the live pointer).
   */
  resolverCacheTtlMs?: number;
};

export type NameRecord = {
  name: string;
  address: string | null;
  node: string; // hex
  resolver: string | null; // resolver contract id used, if any
};

/**
 * The trust verdict on a name's resolution. `resolve()` returns the
 * address the OWNER's current resolver points at — which, for a reclaimable
 * namespace, the owner can repoint at will (that is holder sovereignty, not a
 * bug). Before a high-value pay-to-name, also check `assurance()`: `trustworthy`
 * is true only when the resolver pointer is locked to the Registry-attested,
 * never-upgraded resolver, so the mapping cannot be silently changed underneath
 * the payer.
 */
export type NameAssurance = {
  /** resolver_of === attested_resolver_of (the provenance-bound resolver). */
  resolverAttested: boolean;
  /** The attested resolver has upgraded at least once (permanence-barring). */
  resolverTainted: boolean;
  /** The resolver pointer is locked and can no longer be changed. */
  resolverLocked: boolean;
  /** Locked ∧ attested ∧ not tainted — the resolution is immutable. */
  trustworthy: boolean;
};

/** Thrown when a chain read cannot be completed (RPC/simulation failure), so a
 *  transient error is never silently mistaken for "unregistered" / "no address". */
export class SoranError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoranError";
  }
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// Simulation needs a source account object but never touches it on-chain for
// reads — any well-formed address with a zero sequence works.
const SIM_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

// Upper bound on the namespace-list hint fetch: the hint is
// liveness-only, so a slow/offline hint service must degrade reverseLookup to
// null quickly rather than hang the caller.
const HINT_TIMEOUT_MS = 5_000;
const HINT_MAX_BODY_BYTES = 4_096; // the namespace list is tiny; anything bigger is not a hint
/** Client-side cap on hint-supplied namespace lists — the
 * server endpoint caps at 12, but the hint is untrusted; never fan out more
 * probes than the designed bound. */
const HINT_MAX_NAMESPACES = 12;

export class Soran {
  private server: rpc.Server;
  private passphrase: string;
  private registryId: string;
  private primaryId?: string;
  private registrars: Record<string, string>;
  private hintUrl?: string;
  private reverseNamespaces: string[];
  private resolverCache = new Map<string, { value: string | null; at: number }>();
  private cacheTtlMs: number;

  constructor(opts: SoranOptions = {}) {
    const base: DeploymentPreset = DEPLOYMENTS[opts.network ?? "testnet"];
    // Plain HTTP only for a local node — a production consumer
    // over http:// would let an on-path attacker forge every read this SDK makes.
    const rpcUrl = opts.rpcUrl ?? base.rpcUrl;
    this.server = new rpc.Server(rpcUrl, { allowHttp: /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(rpcUrl) });
    this.passphrase = opts.passphrase ?? base.passphrase;
    this.registryId = opts.registryId ?? base.registryId;
    // `null` = explicit opt-out (the preset ships a primaryId, so merely omitting
    // it keeps the feature on); `undefined` inherits the preset.
    this.primaryId = opts.primaryId === null ? undefined : (opts.primaryId ?? base.primaryId);
    // Fail-closed at construction (same discipline as reverseNamespaces): a
    // malformed contract id is a config bug, surfaced immediately — not at
    // first use, deep inside a wallet's render path.
    if (this.primaryId !== undefined && !StrKey.isValidContract(this.primaryId)) {
      throw new SoranError(
        `invalid primaryId "${this.primaryId}" — expected a C… contract strkey`,
      );
    }
    this.registrars = opts.registrars ?? {};
    // Liveness-only namespace-list hint endpoint; absent means "no fallback —
    // reverseLookup without candidates returns null" (fail-closed).
    this.hintUrl = opts.hintUrl?.replace(/\/+$/, "") || undefined;
    // Fail-closed at construction: a malformed namespace label is a config bug,
    // not a runtime condition to skip silently. Lowercased to match parseName.
    this.reverseNamespaces = (opts.reverseNamespaces ?? []).map((ns) => {
      const l = ns.toLowerCase();
      assertLabel(l);
      return l;
    });
    this.cacheTtlMs = Math.max(0, opts.resolverCacheTtlMs ?? 30_000);
  }

  // ---- hashing (mirrors the contracts byte-for-byte) ----

  /** Registry namehash of a top-level namespace: sha256(ZERO32 ‖ sha256(ns)). */
  async namehash(namespace: string): Promise<Uint8Array> {
    const labelHash = await sha256(utf8(namespace));
    return sha256(concat(new Uint8Array(32), labelHash));
  }

  /** Full node of `label.namespace`: sha256(nsNode ‖ sha256(label)). */
  async node(name: string): Promise<Uint8Array> {
    const { label, namespace } = parseName(name);
    const nsNode = await this.namehash(namespace);
    return sha256(concat(nsNode, await sha256(utf8(label))));
  }

  // ---- resolution ----

  /** The address `label.namespace` pays to, or null. Trustless chain read. */
  async resolve(name: string): Promise<string | null> {
    return (await this.record(name)).address;
  }

  /** Full resolution record (address + node + which resolver answered). */
  async record(name: string): Promise<NameRecord> {
    const { label, namespace } = parseName(name);
    const nameNode = await this.node(name);

    const resolverId = await this.resolverOf(namespace);
    if (resolverId) {
      const addr = (await this.read(resolverId, "addr", [bytes(nameNode)])) as string | null;
      return { name, address: addr ?? null, node: hex(nameNode), resolver: resolverId };
    }
    // Closed resolution via a known Registrar (owner opt-out of public resolver).
    const registrarId = this.registrars[namespace];
    if (registrarId) {
      const addr = (await this.read(registrarId, "resolve", [
        nativeToScVal(Buffer.from(label, "utf8"), { type: "bytes" }),
      ])) as string | null;
      return { name, address: addr ?? null, node: hex(nameNode), resolver: null };
    }
    return { name, address: null, node: hex(nameNode), resolver: null };
  }

  /** A text record (e.g. "url", "avatar") for a name, or null. */
  async text(name: string, key: string): Promise<string | null> {
    const { namespace } = parseName(name);
    const resolverId = await this.resolverOf(namespace);
    if (!resolverId) return null;
    const nameNode = await this.node(name);
    return ((await this.read(resolverId, "text", [
      bytes(nameNode),
      nativeToScVal(key, { type: "symbol" }),
    ])) as string | null) ?? null;
  }

  /** Does `name` currently resolve to `address`? The pay-to-name safety check. */
  async verify(name: string, address: string): Promise<boolean> {
    return (await this.resolve(name)) === address;
  }

  /**
   * The trust verdict on a name's resolver. `resolve()` reflects the
   * owner's CURRENT pointer, which for a reclaimable namespace the owner may
   * repoint. For a high-value pay-to-name, gate on `trustworthy` here: it is
   * true only when the resolver pointer is locked to the Registry-attested,
   * never-upgraded resolver — i.e. the mapping is immutable and cannot be
   * changed underneath the payer between the check and the payment.
   */
  async assurance(name: string): Promise<NameAssurance> {
    const { namespace } = parseName(name);
    const nsNode = await this.namehash(namespace);
    const [locked, tainted, live, attested] = await Promise.all([
      this.read(this.registryId, "resolver_locked", [bytes(nsNode)]),
      this.read(this.registryId, "resolver_tainted", [bytes(nsNode)]),
      this.read(this.registryId, "resolver_of", [bytes(nsNode)]),
      this.read(this.registryId, "attested_resolver_of", [bytes(nsNode)]),
    ]);
    const resolverLocked = locked === true;
    const resolverTainted = tainted === true;
    const resolverAttested = live != null && attested != null && live === attested;
    return {
      resolverAttested,
      resolverTainted,
      resolverLocked,
      trustworthy: resolverLocked && resolverAttested && !resolverTainted,
    };
  }

  // ---- reverse (address → name) ----

  /**
   * Trustlessly verify that `address`'s on-chain reverse record IS `name`.
   * The Resolver's `name_of` already enforces the generation gate and the
   * forward-match proof on chain, so a matching plaintext answer is
   * fully verified — no client-side node hashing or forward re-check needed.
   * This is what a wallet shows a checkmark on.
   */
  async reverseVerify(address: string, name: string): Promise<boolean> {
    if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) return false;
    // Cheap client-side shape check (throws SoranError on malformed names).
    const { namespace } = parseName(name);
    const resolverId = await this.resolverOf(namespace);
    if (!resolverId) return false;
    const claimed = await this.nameOf(resolverId, address);
    return claimed === name.toLowerCase();
  }

  /**
   * Pure on-chain reverse read: ask each candidate namespace's Resolver for
   * `name_of(address)` and return the winning answer, or null. The contract
   * enforces the generation + forward-match gates, so any non-null
   * answer is already verified — a stale or spoofed record returns null from
   * the contract itself, never a wrong name from a hint service.
   *
   * ORDERING (PrimaryName feature, optional): when `primaryId` is configured,
   * the PrimaryName contract is asked FIRST. Its answer wins over per-namespace
   * records by design — it is the address's declared cross-namespace display
   * name — and it is already contract-verified (`primary_of` re-runs the
   * namespace Resolver's live `name_of` gates on every read), so NO extra
   * SDK-side verification is applied to it.
   *
   * DELIBERATE DEGRADATION: if the primary read itself FAILS (transport/ABI),
   * the error is swallowed HERE and the lookup falls through to the namespace
   * probes rather than failing outright. Rationale: the primary is an
   * optional, additive convenience layered on top of the namespace probes,
   * which are the pre-existing baseline — a PrimaryName outage must not break
   * a flow that worked before the feature existed. This is the ONE place a
   * failed read may surface as null; namespace-probe failures still throw
   * (fail-closed). Callers that must distinguish "no primary" from "primary
   * unreadable" call `primaryOf` directly, which never swallows read failures.
   *
   * Candidate scoping for the namespace probes, in priority order:
   *   1. `namespaces` (per call) — an explicit list, even empty, wins outright
   *      (passing [] intentionally disables the namespace probes; the primary
   *      step above still runs — scoping controls namespaces, not the
   *      cross-namespace pointer).
   *   2. the `reverseNamespaces` constructor option.
   *   3. a namespace-LIST hint fetched over `hintUrl` — see
   *      `namespaceHint` for why this cannot forge an answer.
   *
   * All candidates are probed IN PARALLEL, but the result is DETERMINISTIC:
   * walking the settled results in the configured order, the first non-null
   * answer wins, and the first chain-read failure throws (matching the old
   * sequential fail-closed semantics exactly — a transient RPC error is never
   * silently reported as "no reverse record").
   */
  async reverseLookup(address: string, namespaces?: string[]): Promise<string | null> {
    if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) return null;
    // 1. Primary name first (optional cross-namespace feature). A failed read
    //    falls through to the namespace probes by design — see the doc comment.
    if (this.primaryId) {
      try {
        const primary = await this.primaryOf(address);
        if (primary) return primary;
      } catch {
        // PrimaryName unreachable or ABI-mismatched → degrade to the
        // pre-feature baseline (namespace probes), never fail the lookup.
      }
    }
    // 2. Namespace probes (unchanged fail-closed logic).
    let candidates: string[];
    if (namespaces !== undefined) candidates = namespaces;
    else if (this.reverseNamespaces.length > 0) candidates = this.reverseNamespaces;
    else candidates = await this.namespaceHint();
    // Same fail-closed validation as the constructor: a malformed namespace
    // label is a caller bug, surfaced as a typed SoranError, not skipped.
    // Validated for ALL candidates up front, before any network I/O fires.
    const labels = candidates.map((ns) => {
      const l = ns.toLowerCase();
      assertLabel(l);
      return l;
    });
    // Fire every probe in parallel. Each chain is independent: resolve the
    // namespace's Resolver pointer, then ask it for the reverse record.
    const settled = await Promise.allSettled(
      labels.map(async (l) => {
        const resolverId = await this.resolverOf(l);
        if (!resolverId) return null; // namespace has no public Resolver — nothing to ask
        return this.nameOf(resolverId, address);
      }),
    );
    // Deterministic priority: scan in configured order. A rejection at index i
    // is thrown before any later answer is considered — identical to what the
    // sequential loop would have done (fail-closed: never mistake a failed
    // read for "no reverse record").
    for (const s of settled) {
      if (s.status === "rejected") throw s.reason;
      if (s.value) return s.value;
    }
    return null;
  }

  // ---- primary name (optional, cross-namespace) ----

  /**
   * The address's declared cross-namespace primary display name, or null.
   * Requires the `primaryId` option (or a network preset); returns null when
   * the feature is not configured, and null for a malformed address (it cannot
   * have a primary).
   *
   * A plain `primary_of` read against the pinned ABI — `Option<String>`,
   * string-decoded by scValToNative exactly like `nameOf`. The answer is
   * SELF-VERIFYING: the contract re-runs the namespace Resolver's live
   * `name_of` gates on every read and answers None the moment the stored name
   * stops passing, so no SDK-side re-check is applied or needed.
   *
   * FAIL-CLOSED (unlike the reverseLookup primary step, which degrades by
   * design): a transport/ABI failure THROWS a SoranError via `read` — it never
   * masquerades as "no primary". A non-string return is likewise a typed ABI
   * mismatch, matching nameOf's discipline.
   *
   * COST NOTE: every call costs two cross-contract calls
   * in simulation (resolver_of + name_of inside the contract). For batch
   * rendering, callers are expected to cache briefly client-side (seconds —
   * the same discipline as `resolverCacheTtlMs`). Correctness never depends
   * on any cache: the contract re-verifies on every read.
   */
  async primaryOf(address: string): Promise<string | null> {
    if (!this.primaryId) return null; // feature not configured on this network
    if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) return null;
    const raw = (await this.read(this.primaryId, "primary_of", [
      nativeToScVal(address, { type: "address" }),
    ])) as unknown;
    if (raw == null) return null; // genuine None: no (still-verifying) primary
    if (typeof raw !== "string") {
      throw new SoranError(
        `primary_of on ${this.primaryId} returned a non-string value — ABI mismatch ` +
          `(this SDK expects the PrimaryName contract whose primary_of returns Option<String>)`,
      );
    }
    return raw;
  }

  // ---- namespace-level reads ----

  /** { owner, resolver } of a namespace, or null if unregistered. */
  async namespace(ns: string): Promise<{ owner: string; resolver: string | null } | null> {
    assertLabel(ns);
    const nsNode = await this.namehash(ns);
    const owner = (await this.read(this.registryId, "owner_of", [bytes(nsNode)])) as string | null;
    if (!owner) return null;
    const resolver = (await this.read(this.registryId, "resolver_of", [bytes(nsNode)])) as string | null;
    return { owner, resolver: resolver ?? null };
  }

  /** Is a namespace label unregistered (claimable through the public window)? */
  async isAvailable(ns: string): Promise<boolean> {
    return (await this.namespace(ns)) === null;
  }

  // ---- internals ----

  /**
   * Read `name_of(addr)` from a Resolver (Option A final ABI: the return is
   * `Option<String>`, which scValToNative decodes straight to a JS string —
   * no UTF-8/Bytes decoding path needed). Anything that is not a string is an
   * ABI mismatch (the Resolver is not the post-Option-A build), so fail closed
   * with a typed error rather than guess at an encoding.
   */
  private async nameOf(resolverId: string, address: string): Promise<string | null> {
    const raw = (await this.read(resolverId, "name_of", [
      nativeToScVal(address, { type: "address" }),
    ])) as unknown;
    if (raw == null) return null;
    if (typeof raw !== "string") {
      throw new SoranError(
        `name_of on ${resolverId} returned a non-string value — ABI mismatch ` +
          `(this SDK requires the post-Option-A Resolver, whose name_of returns Option<String>)`,
      );
    }
    return raw;
  }

  /**
   * Namespace-LIST hint, used only when `reverseLookup` was
   * given no candidate namespaces at all. Fetches the hint service's namespace
   * list and returns the labels to probe ON CHAIN.
   *
   * TRUST NOTE — a list hint cannot forge anything. It never carries an
   * answer; it only says WHICH namespaces to ask. Every candidate answer still
   * comes from the Resolver's `name_of`, which enforces the generation +
   * forward-match gates on chain. The hint therefore fixes LIVENESS
   * only: the worst a lying hint can do is omit a namespace (hiding a name →
   * null) or list junk labels (filtered below) — never produce a wrong name.
   * A hint outage likewise degrades the lookup to null, never to a misread.
   *
   * Payload: the public API's existing `GET {hintUrl}/v1/showcase` endpoint,
   * `{ namespaces: [{ label, displayName, policy, logo, names }] }` — no new
   * API surface needed. Note it is capped (most-active 12) and eventually
   * consistent; acceptable for a liveness hint, and why explicit
   * `reverseNamespaces` remains the precise option.
   */
  private async namespaceHint(): Promise<string[]> {
    if (!this.hintUrl) return [];
    let payload: unknown;
    try {
      // Bound the wait: a hung hint must not hang a wallet's history render.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), HINT_TIMEOUT_MS);
      try {
        // The hint
        // host is UNTRUSTED: refuse redirects (it must not steer us to another
        // origin) and cap the body BEFORE buffering so an oversized response can
        // never be read into memory.
        const res = await fetch(`${this.hintUrl}/v1/showcase`, { signal: ctl.signal, redirect: "error" });
        if (!res.ok) return [];
        if (Number(res.headers.get("content-length") ?? 0) > HINT_MAX_BODY_BYTES) return [];
        const reader = res.body?.getReader();
        if (!reader) return [];
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > HINT_MAX_BODY_BYTES) {
            await reader.cancel();
            return [];
          }
          chunks.push(value);
        }
        payload = JSON.parse(new TextDecoder().decode(concat(...chunks)));
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return []; // hint outage → liveness degradation to null, never a wrong answer
    }
    // Untrusted input: keep only well-formed labels. A hostile hint injecting
    // junk must not abort the lookup (a throwing assertLabel here would be a
    // DoS), so malformed entries are dropped — again, liveness-only damage.
    const list = (payload as { namespaces?: unknown } | null)?.namespaces;
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
      const label =
        typeof entry === "string" ? entry : (entry as { label?: unknown } | null)?.label;
      if (typeof label !== "string") continue;
      const l = label.toLowerCase();
      if (!LABEL_RE.test(l) || l.length > 63 || seen.has(l)) continue;
      seen.add(l);
      out.push(l);
      // Client-side cap: the "12 most-active" bound lives
      // only on the server endpoint — a hostile/buggy hint could otherwise
      // make us fire thousands of parallel RPC probes. Liveness-only either
      // way; every candidate answer is still contract-verified on chain.
      if (out.length >= HINT_MAX_NAMESPACES) break;
    }
    return out;
  }

  private async resolverOf(namespace: string): Promise<string | null> {
    // Honour the TTL: a cached resolver pointer past its TTL must be
    // re-read, because the owner of a reclaimable namespace can repoint it.
    if (this.cacheTtlMs > 0) {
      const hit = this.resolverCache.get(namespace);
      if (hit && Date.now() - hit.at < this.cacheTtlMs) return hit.value;
    }
    const nsNode = await this.namehash(namespace);
    const resolver = ((await this.read(this.registryId, "resolver_of", [bytes(nsNode)])) ??
      null) as string | null;
    if (this.cacheTtlMs > 0) {
      // Bound the cache so a long-lived instance resolving many
      // namespaces can't grow it without limit (TTL gates freshness, not size).
      if (this.resolverCache.size >= 1024) {
        const oldest = this.resolverCache.keys().next().value;
        if (oldest !== undefined) this.resolverCache.delete(oldest);
      }
      this.resolverCache.set(namespace, { value: resolver, at: Date.now() });
    }
    return resolver;
  }

  /**
   * Read-only contract call via RPC simulation — no signer, no fee, no state.
   *
   * Distinguish a successful None from a FAILURE. A simulation that
   * cannot be completed (RPC down, contract missing, host error) THROWS a
   * SoranError — it must never be silently returned as null, which a caller
   * would read as "the name doesn't resolve" and, in a pay-to-name flow, act on.
   * Only a successful simulation whose return value is void yields null.
   */
  private async read(contractId: string, fn: string, args: xdr.ScVal[]): Promise<unknown> {
    let sim: Awaited<ReturnType<typeof this.server.simulateTransaction>>;
    try {
      // Build inside the try too: an invalid contract id / arg encoding must
      // surface as a typed SoranError, not a bare throw the caller can't classify.
      const tx = new TransactionBuilder(new Account(SIM_SOURCE, "0"), {
        fee: "100",
        networkPassphrase: this.passphrase,
      })
        .addOperation(new Contract(contractId).call(fn, ...args))
        .setTimeout(30)
        .build();
      sim = await this.server.simulateTransaction(tx);
    } catch (e) {
      throw new SoranError(`read ${fn} on ${contractId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!rpc.Api.isSimulationSuccess(sim)) {
      const detail = (sim as { error?: unknown }).error ?? "unknown";
      throw new SoranError(`simulate ${fn} on ${contractId} failed: ${String(detail)}`);
    }
    if (!sim.result?.retval) return null; // genuine None
    return scValToNative(sim.result.retval);
  }
}

// ---- helpers ----

export function parseName(name: string): { label: string; namespace: string } {
  const parts = name.toLowerCase().split(".");
  if (parts.length !== 2) throw new SoranError(`expected "label.namespace", got "${name}"`);
  const [label, namespace] = parts;
  assertLabel(label);
  assertLabel(namespace);
  return { label, namespace };
}

function assertLabel(l: string) {
  if (!LABEL_RE.test(l) || l.length > 63) throw new SoranError(`invalid label "${l}"`);
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function hex(b: Uint8Array | Buffer): string {
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function bytes(b: Uint8Array): xdr.ScVal {
  return nativeToScVal(Buffer.from(b), { type: "bytes" });
}
/** WebCrypto in browsers, node:crypto in Node — no bundler shims needed. */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  if (globalThis.crypto?.subtle) {
    return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource));
  }
  const { createHash } = await import("node:crypto");
  return new Uint8Array(createHash("sha256").update(data).digest());
}
