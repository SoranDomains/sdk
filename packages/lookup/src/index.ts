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
 * @sorandomains/lookup — resolve Soran names on Stellar, trustlessly.
 *
 * Everything here is a READ against the deployed contracts via Soroban RPC
 * simulation: no signer, no fees, no Soran servers in the trust path. A wallet
 * that integrates this resolves `alice.nova` the same way the chain would.
 *
 *   import { Soran } from "@sorandomains/lookup";
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
  hash,
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
   * the search. Default []. With no primary configured and no hintUrl either, reverseLookup then throws a CONFIG SoranError; with a primary configured (the preset default) it answers from the primary alone and returns null when none is elected — nothing else is probed.
   */
  reverseNamespaces?: string[];
  /**
   * How long a namespace→resolver lookup is cached, in ms. The pointer
   * CAN change for a reclaimable namespace (the owner repoints), so a long-lived
   * instance must not cache it forever or it will resolve to a stale resolver.
   * Default 30_000. Set 0 to disable caching (always read the live pointer).
   */
  resolverCacheTtlMs?: number;
  /** Upper bound, in ms, on how long any single CHAIN READ may keep the
   *  caller waiting; on expiry that read rejects with a SoranError of code
   *  "TIMEOUT". Applies per read — a method that fans out (reverseLookup,
   *  details) can take longer in total, and the reverse namespace-list hint
   *  fetch keeps its own fixed 5s bound. Bounds the wait only — the
   *  underlying HTTP request is not cancelled. Unset = no SDK bound. */
  timeoutMs?: number;
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
/** The namespace-level half of `details()`. All live chain reads. */
export type NamespaceDetails = {
  namespace: string;
  /** Registry owner of the namespace node, or null if unallocated. */
  owner: string | null;
  /** The Registry-attested Registrar (issuance authority), if deployed. */
  registrar: string | null;
  /** The owner-set resolver pointer, if any. */
  resolver: string | null;
  /** Has the namespace passed the one-way permanence door? Null when there is
   *  no attested Registrar to ask. */
  permanent: boolean | null;
  /** The Registrar's immutable issuance policy. Null without a Registrar. */
  policy: {
    reclaimable: boolean;
    transferable: boolean;
    tradeable: boolean;
    /** Seconds per issued term; 0n = names never expire. */
    defaultTermSecs: bigint;
    tradeFeeBps: number;
  } | null;
};

/** Everything `details(name)` can answer from live chain state — the on-chain
 *  equivalent of a WHOIS record. Registration DATE is deliberately absent: the
 *  chain stores no issue timestamp; it lives in the name's `issued` event, so
 *  derive it from an indexer or transaction-history source and treat it as
 *  informational, not consensus data. */
export type NameDetails = {
  name: string;
  /** Hex-encoded on-chain node hash. */
  node: string;
  /** Current resolution — explicit resolver record, else the Registrar's
   *  built-in target. Null when the name doesn't (or no longer) resolves. */
  address: string | null;
  /** The resolver that answered (null when the built-in path answered). */
  resolver: string | null;
  /** The Registrar record's holder. Non-null even for an EXPIRED name — check
   *  `expiresAt` before treating the holder as current. Null = never issued. */
  holder: string | null;
  /** Unix seconds; 0n = never expires; null = never issued. */
  expiresAt: bigint | null;
  /** Ownership generation (bumps on issue/reissue/transfer/reclaim). */
  generation: bigint | null;
  namespace: NamespaceDetails;
  assurance: NameAssurance;
};

/** One chain-verified name held by a wallet (from `namesOf`). */
export type NameSummary = {
  name: string;
  namespace: string;
  label: string;
  /** Hex-encoded node hash. */
  node: string;
  /** Chain-verified holder (always the queried address). */
  holder: string;
  /** Unix seconds; 0n = never expires. */
  expiresAt: bigint;
};

/** The standard, discoverable profile schema: the text-record keys every
 *  Soran client agrees to look for. Values are holder-published text records
 *  on the namespace resolver — free-form strings, verified to come from the
 *  name's current holder by the contract's generation gating, but NOT
 *  validated as URLs/emails/handles: render them as untrusted user content. */
export const PROFILE_KEYS = [
  "org",
  "url",
  "email",
  "description",
  "avatar",
  "location",
  "twitter",
  "github",
] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];
export type SoranProfile = Partial<Record<ProfileKey, string>>;

/** One contract-verified reverse name (from `reverseNames`). */
export type ReverseName = {
  name: string;
  namespace: string;
  /** Is this the address's declared cross-namespace primary? */
  primary: boolean;
};

/** The `identity()` aggregate: everything a profile page renders about a
 *  NAME. `details` and `profile` are fail-closed; the three display-name
 *  enrichments degrade to null on read failure (documented on the method). */
export type NameIdentity = {
  details: NameDetails;
  profile: SoranProfile;
  /** The holder's cross-namespace primary name, or null. */
  holderPrimary: string | null;
  /** The pay-to address's contract-verified display name on this
   *  namespace's resolver, or null. */
  addressDisplayName: string | null;
  /** The namespace OWNER's primary name — who runs this namespace, as a
   *  human-readable identity, or null when they haven't declared one. */
  namespaceOwnerPrimary: string | null;
};

/** The `walletProfile()` aggregate: everything a wallet renders about an
 *  ADDRESS. `names` is null (not []) when no `hintUrl` is configured —
 *  enumeration needs a discovery source. */
export type WalletProfile = {
  address: string;
  primary: string | null;
  reverseNames: ReverseName[];
  names: NameSummary[] | null;
  /** Profile records of the primary name; {} when there is no primary. */
  profile: SoranProfile;
};

/** Indexed lifecycle history (from `history()`): INFORMATIONAL, not
 *  consensus — served by the hint host's indexer, not read from chain. Every
 *  entry carries its ledger and txHash for independent verification. */
export type NameHistory = {
  name: string;
  issuedAt: string;
  issuedLedger: number;
  events: Array<{ action: string; ledger: number; txHash: string; at: string }>;
};

/** Machine-readable failure category, so UIs can branch without parsing
 *  message strings: INVALID_INPUT (bad name/label/address from the caller),
 *  CONFIG (bad or missing constructor options), RPC (network/transport),
 *  SIMULATION (the node rejected the read), ARCHIVED (entry exists but its
 *  rent lapsed), ABI (a contract answered with an unexpected shape),
 *  TIMEOUT (the configured `timeoutMs` elapsed). */
export type SoranErrorCode =
  | "INVALID_INPUT"
  | "CONFIG"
  | "RPC"
  | "SIMULATION"
  | "ARCHIVED"
  | "ABI"
  | "TIMEOUT";

export class SoranError extends Error {
  constructor(
    message: string,
    readonly code: SoranErrorCode = "RPC",
  ) {
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
// namesOf: candidate-list hint cap (100 names ≈ 20KB JSON) and how many
// candidates are chain-verified per call (2 simulations each).
const NAMES_HINT_MAX_BODY_BYTES = 65_536;
const NAMES_VERIFY_CAP = 40;
const HISTORY_MAX_BODY_BYTES = 32_768;

export class Soran {
  private server: rpc.Server;
  private passphrase: string;
  private registryId: string;
  private primaryId?: string;
  private registrars: Record<string, string>;
  private hintUrl?: string;
  private reverseNamespaces: string[];
  private resolverCache = new Map<string, { value: string | null; at: number }>();
  private registrarCache = new Map<string, { value: string | null; at: number }>();
  private timeoutMs?: number;
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
    // The preset PrimaryName is anchored to the preset Registry — never let it
    // leak onto a custom registryId, where it could only mis-verify.
    const presetPrimary =
      opts.registryId && opts.registryId !== base.registryId ? undefined : base.primaryId;
    this.primaryId = opts.primaryId === null ? undefined : (opts.primaryId ?? presetPrimary);
    // Fail-closed at construction (same discipline as reverseNamespaces): a
    // malformed contract id is a config bug, surfaced immediately — not at
    // first use, deep inside a wallet's render path.
    if (this.primaryId !== undefined && !StrKey.isValidContract(this.primaryId)) {
      throw new SoranError(
        `invalid primaryId "${this.primaryId}" — expected a C… contract strkey`,
        "CONFIG",
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
    if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
      throw new SoranError(`timeoutMs must be a positive number (got ${opts.timeoutMs})`, "CONFIG");
    }
    this.timeoutMs = opts.timeoutMs;
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
      if (addr) return { name, address: addr, node: hex(nameNode), resolver: resolverId };
      // No explicit resolver record (records are holder-set and optional):
      // fall back to the Registrar's BUILT-IN resolution target — `issue`
      // initializes it to the holder, so freshly issued names resolve before
      // their holder ever touches the resolver. Same trust base: the Registrar
      // consulted is the one the immutable Registry itself attests for the
      // namespace, and its `resolve` is expiry-gated on chain.
      const attested = await this.attestedRegistrarOf(namespace);
      if (attested) {
        const builtIn = (await this.read(attested, "resolve", [
          nativeToScVal(utf8(label), { type: "bytes" }),
        ])) as string | null;
        return { name, address: builtIn ?? null, node: hex(nameNode), resolver: builtIn ? null : resolverId };
      }
      return { name, address: null, node: hex(nameNode), resolver: resolverId };
    }
    // Closed resolution via a known Registrar (owner opt-out of public resolver).
    const registrarId = this.registrars[namespace] ?? (await this.attestedRegistrarOf(namespace));
    if (registrarId) {
      const addr = (await this.read(registrarId, "resolve", [
        nativeToScVal(utf8(label), { type: "bytes" }),
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
    if (
      namespaces === undefined &&
      this.reverseNamespaces.length === 0 &&
      !this.hintUrl &&
      !this.primaryId
    ) {
      throw new SoranError(
        "reverseLookup has no way to answer: configure primaryId, reverseNamespaces, or hintUrl — or pass `namespaces` per call",
        "CONFIG",
      );
    }
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
        "ABI",
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
    const resolver = await this.resolverOf(ns); // shared pointer cache
    return { owner, resolver };
  }

  /** Is a namespace label unregistered (claimable through the public window)? */
  /**
   * The full live picture of a name in one call — resolution, ownership clock,
   * namespace policy and permanence, and trust assurance. Every field is a
   * trustless chain read; nothing comes from an indexer. Expect about a dozen
   * RPC simulations per call (the assurance reads are deliberately fresh, not
   * cached — they are a trust verdict), so cache the result briefly when
   * rendering detail pages.
   *
   * Fail-closed: if the namespace's Registrar storage is archived (rent
   * lapsed), the whole call throws SoranError "ARCHIVED" rather than serving
   * a partial picture.
   *
   * Registration date is not on chain — see {@link NameDetails}.
   */
  async details(name: string): Promise<NameDetails> {
    const { label, namespace } = parseName(name);
    // Warm the two pointer caches first so the fan-out below reuses them
    // instead of re-simulating the same Registry reads.
    const registrarId = await this.attestedRegistrarOf(namespace);
    const [rec, ns, assur] = await Promise.all([
      this.record(name),
      this.namespace(namespace),
      this.assurance(name),
    ]);
    let holder: string | null = null;
    let expiresAt: bigint | null = null;
    let generation: bigint | null = null;
    let permanent: boolean | null = null;
    let policy: NamespaceDetails["policy"] = null;
    if (registrarId) {
      const [rawRec, rawPerm, rawPol] = await Promise.all([
        this.read(registrarId, "record_of", [
          nativeToScVal(utf8(label), { type: "bytes" }),
        ]) as Promise<{
          holder: string;
          address: string;
          expires_at: bigint;
          generation: bigint;
        } | null>,
        this.read(registrarId, "is_permanent", []) as Promise<boolean | null>,
        this.read(registrarId, "policy", []) as Promise<{
          reclaimable: boolean;
          transferable: boolean;
          tradeable: boolean;
          default_term_secs: bigint;
          trade_fee_bps: number;
        } | null>,
      ]);
      if (rawRec) {
        holder = String(rawRec.holder);
        expiresAt = BigInt(rawRec.expires_at);
        generation = BigInt(rawRec.generation);
      }
      permanent = rawPerm ?? null;
      if (rawPol) {
        policy = {
          reclaimable: rawPol.reclaimable,
          transferable: rawPol.transferable,
          tradeable: rawPol.tradeable,
          defaultTermSecs: BigInt(rawPol.default_term_secs),
          tradeFeeBps: Number(rawPol.trade_fee_bps),
        };
      }
    }
    return {
      name: rec.name,
      node: rec.node,
      address: rec.address,
      resolver: rec.resolver,
      holder,
      expiresAt,
      generation,
      namespace: {
        namespace,
        owner: ns?.owner ?? null,
        registrar: registrarId,
        resolver: ns?.resolver ?? null,
        permanent,
        policy,
      },
      assurance: assur,
    };
  }

  // ---- identity & enumeration (0.4.0) ----

  /**
   * The name's standard profile — the {@link PROFILE_KEYS} text records its
   * holder has published, read from the namespace resolver and generation-
   * gated on chain (records from a prior holder never surface). Keys with no
   * record are simply absent. About one simulation per key (the resolver
   * pointer is fetched once up front and cached); fail-closed — a transient
   * read failure throws rather than answering "no profile".
   *
   * Values are holder-authored free text: treat them as untrusted content
   * (escape them; don't auto-link without scheme checks).
   */
  async profile(name: string): Promise<SoranProfile> {
    // One resolver_of read up front — the parallel text() calls below would
    // otherwise each fire their own before the cache is populated.
    await this.resolverOf(parseName(name).namespace);
    const values = await Promise.all(PROFILE_KEYS.map((k) => this.text(name, k)));
    const out: SoranProfile = {};
    PROFILE_KEYS.forEach((k, i) => {
      const v = values[i];
      // Empty string = retracted: text records are overwrite-only on chain
      // (no delete), so holders clear a record by writing "" — treat it as
      // unset rather than surfacing a present-but-empty key.
      if (v !== null && v !== "") out[k] = v;
    });
    return out;
  }

  /**
   * ALL of an address's contract-verified reverse names — one per namespace
   * that has one — with the cross-namespace primary flagged (and included
   * even when its namespace wasn't in the probe list). Same candidate
   * sources, fail-closed probe semantics, and CONFIG guard as `reverseLookup`;
   * a failed PRIMARY read degrades (the probes still answer), matching
   * `reverseLookup`'s documented primary-step behavior. Invalid addresses
   * return [].
   */
  async reverseNames(address: string, namespaces?: string[]): Promise<ReverseName[]> {
    if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) return [];
    if (
      namespaces === undefined &&
      this.reverseNamespaces.length === 0 &&
      !this.hintUrl &&
      !this.primaryId
    ) {
      throw new SoranError(
        "reverseNames has no way to answer: configure primaryId, reverseNamespaces, or hintUrl — or pass `namespaces` per call",
        "CONFIG",
      );
    }
    let primary: string | null = null;
    try {
      primary = await this.primaryOf(address);
    } catch {
      /* degrade to probes-only, like reverseLookup's primary step */
    }
    let candidates: string[];
    if (namespaces !== undefined) candidates = namespaces;
    else if (this.reverseNamespaces.length > 0) candidates = this.reverseNamespaces;
    else candidates = await this.namespaceHint();
    const labels = candidates.map((ns) => {
      const l = ns.toLowerCase();
      assertLabel(l);
      return l;
    });
    const settled = await Promise.allSettled(
      labels.map(async (ns) => {
        const resolverId = await this.resolverOf(ns);
        if (!resolverId) return null;
        return this.nameOf(resolverId, address);
      }),
    );
    const out: ReverseName[] = [];
    const seen = new Set<string>();
    settled.forEach((res, i) => {
      if (res.status === "rejected") throw res.reason; // fail-closed, like reverseLookup
      if (!res.value || seen.has(res.value)) return;
      seen.add(res.value);
      // The answer's own namespace, not the probed label — an owner may point
      // several namespaces at one shared resolver instance.
      out.push({
        name: res.value,
        namespace: parseName(res.value).namespace,
        primary: res.value === primary,
      });
    });
    if (primary && !seen.has(primary)) {
      // The primary lives on a namespace outside the probe list — it is still
      // a contract-verified answer, so include it rather than hide it.
      out.unshift({ name: primary, namespace: parseName(primary).namespace, primary: true });
    }
    return out;
  }

  /**
   * Every name a wallet holds — DISCOVERED via the hint host's indexer, then
   * every candidate VERIFIED on chain (`holder_of_node`, which the contract
   * expiry-gates itself): the hint can omit names, but it can never forge
   * one into the result. Requires `hintUrl` (on-chain storage is not
   * enumerable — a CONFIG error explains this); throws INVALID_INPUT for a
   * malformed address. At most 40 candidates are verified per call (~2
   * simulations each); `truncated` in the hint payload is not surfaced —
   * treat a 40-name result as possibly partial.
   *
   * Enumeration is BEST-EFFORT by construction: a candidate whose chain
   * reads fail (transient RPC trouble, or a dormant namespace whose entries
   * are archived) is SKIPPED, not fatal — one cold name must not blank a
   * wallet's whole holdings view, and a hostile hint must not be able to
   * inject a failing candidate as a denial of service. Per-name reads
   * (`details`, `nameState`) give the precise per-name error instead.
   */
  async namesOf(address: string): Promise<NameSummary[]> {
    if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) {
      throw new SoranError(`invalid address "${address}"`, "INVALID_INPUT");
    }
    if (!this.hintUrl) {
      throw new SoranError(
        "namesOf needs a discovery source: set hintUrl — chain storage is not enumerable; every candidate is still verified on chain",
        "CONFIG",
      );
    }
    const payload = await this.hintFetch(
      `/v1/names/by-holder/${address}`,
      NAMES_HINT_MAX_BODY_BYTES,
    );
    if (payload === null) {
      throw new SoranError("names-by-holder hint unavailable — retry, or query the chain per name", "RPC");
    }
    const list = (payload as { names?: unknown } | null)?.names;
    if (!Array.isArray(list)) return [];
    // Untrusted candidates: keep only well-formed name ids, dedupe, cap.
    const seen = new Set<string>();
    const candidates: Array<{ name: string; label: string; namespace: string }> = [];
    for (const entry of list) {
      const raw = (entry as { name?: unknown } | null)?.name;
      if (typeof raw !== "string") continue;
      const nm = raw.toLowerCase();
      if (seen.has(nm)) continue;
      const parts = nm.split(".");
      if (parts.length !== 2) continue;
      const [label, namespace] = parts;
      if (!LABEL_RE.test(label) || label.length > 63) continue;
      if (!LABEL_RE.test(namespace) || namespace.length > 63) continue;
      seen.add(nm);
      candidates.push({ name: nm, label, namespace });
      if (candidates.length >= NAMES_VERIFY_CAP) break;
    }
    const verified = await Promise.allSettled(
      candidates.map(async (c) => {
        const registrarId = await this.attestedRegistrarOf(c.namespace);
        if (!registrarId) return null;
        const nameNode = await this.node(c.name);
        const [holder, rec] = await Promise.all([
          this.read(registrarId, "holder_of_node", [bytes(nameNode)]) as Promise<string | null>,
          this.read(registrarId, "record_of", [
            nativeToScVal(utf8(c.label), { type: "bytes" }),
          ]) as Promise<{ holder: string; expires_at: bigint } | null>,
        ]);
        // Both reads must agree the queried address holds the name — the
        // holder check on record_of ties the expiry to the SAME incarnation
        // (a reissue between the two simulations shows a different holder and
        // drops the candidate; a renew-only race is benign). Never fabricate
        // an expiry from a missing record.
        if (holder !== address || !rec || String(rec.holder) !== address) return null;
        return {
          name: c.name,
          namespace: c.namespace,
          label: c.label,
          node: hex(nameNode),
          holder: address,
          expiresAt: BigInt(rec.expires_at),
        } satisfies NameSummary;
      }),
    );
    // Rejections (archived entries, transient RPC failures) skip the
    // candidate — see the doc above. The hint cannot forge; failures cannot
    // amplify.
    return verified.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
  }

  /**
   * Indexed lifecycle history of a name — issued / transferred / reclaimed,
   * with ledger + txHash per entry. INFORMATIONAL, NOT CONSENSUS: this is
   * the one method that answers from the hint host's indexer rather than the
   * chain (the contracts store no timestamps). Verify entries independently
   * by their txHash when it matters. Requires `hintUrl`; a hint outage
   * throws RPC rather than pretending the name has no history.
   */
  async history(name: string): Promise<NameHistory> {
    const { label, namespace } = parseName(name);
    if (!this.hintUrl) {
      throw new SoranError(
        "history needs an indexer source: set hintUrl — the chain stores no timestamps",
        "CONFIG",
      );
    }
    const payload = await this.hintFetch(
      `/v1/names/${namespace}/${label}/history`,
      HISTORY_MAX_BODY_BYTES,
    );
    if (payload === null) {
      throw new SoranError("history unavailable from the hint service (outage, or name unknown to the indexer)", "RPC");
    }
    const raw = payload as {
      name?: unknown; issuedAt?: unknown; issuedLedger?: unknown; events?: unknown;
    };
    // Hostile-hint bounds: cap the list, clamp numbers to sane ledgers, and
    // bound string lengths — this is untrusted UI input by definition.
    const events = Array.isArray(raw.events)
      ? raw.events.slice(0, 100).flatMap((e) => {
          const ev = e as { action?: unknown; ledger?: unknown; txHash?: unknown; at?: unknown };
          if (typeof ev.action !== "string" || typeof ev.txHash !== "string") return [];
          const ledger = Number(ev.ledger ?? 0);
          return [{
            action: ev.action.slice(0, 64),
            ledger: Number.isSafeInteger(ledger) && ledger >= 0 ? ledger : 0,
            txHash: ev.txHash.slice(0, 64),
            at: String(ev.at ?? "").slice(0, 40),
          }];
        })
      : [];
    return {
      name: `${label}.${namespace}`,
      issuedAt: String(raw.issuedAt ?? ""),
      issuedLedger: Number(raw.issuedLedger ?? 0),
      events,
    };
  }

  /**
   * Everything a profile page shows about a NAME, in one call: the
   * {@link details} aggregate, the holder's published {@link profile}, and
   * three identity enrichments — the holder's primary name, the pay-to
   * address's contract-verified display name, and the namespace OWNER's
   * primary name (who runs this namespace, as a name instead of a G-address).
   *
   * Trust boundaries: `details` and `profile` are fail-closed (they throw on
   * read failure); the three enrichments DEGRADE to null on failure — they
   * decorate the page, and a transient failure should not blank it. Cost:
   * roughly twenty parallel simulations; cache briefly.
   */
  async identity(name: string): Promise<NameIdentity> {
    const { namespace } = parseName(name);
    const details = await this.details(name); // also warms the pointer caches
    const [profile, holderPrimary, addressDisplayName, namespaceOwnerPrimary] =
      await Promise.all([
        this.profile(name),
        details.holder ? this.primaryOf(details.holder).catch(() => null) : Promise.resolve(null),
        (async () => {
          if (!details.address) return null;
          const resolverId = await this.resolverOf(namespace);
          if (!resolverId) return null;
          return this.nameOf(resolverId, details.address);
        })().catch(() => null),
        details.namespace.owner
          ? this.primaryOf(details.namespace.owner).catch(() => null)
          : Promise.resolve(null),
      ]);
    return { details, profile, holderPrimary, addressDisplayName, namespaceOwnerPrimary };
  }

  /**
   * Everything a wallet shows about an ADDRESS, in one call: its primary
   * name, all its contract-verified reverse names, the names it holds
   * (hint-discovered + chain-verified; null without `hintUrl`), and the
   * profile records of its primary name.
   *
   * Degrade semantics: `reverseNames`' CONFIG case (no probe sources) and
   * `namesOf`'s CONFIG case degrade to []/null here rather than failing the
   * whole profile — a wallet with only `primaryId` configured still gets the
   * primary + its profile. Probe/read failures still throw (fail-closed).
   */
  async walletProfile(address: string): Promise<WalletProfile> {
    if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) {
      throw new SoranError(`invalid address "${address}"`, "INVALID_INPUT");
    }
    const [primary, reverseNames, names] = await Promise.all([
      this.primaryOf(address),
      this.reverseNames(address).catch((e) => {
        if (e instanceof SoranError && e.code === "CONFIG") return [] as ReverseName[];
        throw e;
      }),
      this.hintUrl ? this.namesOf(address) : Promise.resolve(null),
    ]);
    const profile = primary ? await this.profile(primary) : {};
    return { address, primary, reverseNames, names, profile };
  }

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
        "ABI",
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
  /** Fetch JSON from the UNTRUSTED hint host: refuse redirects (it must not
   *  steer us to another origin), bound the wait, and cap the body BEFORE
   *  buffering so an oversized response can never be read into memory.
   *  Returns null on ANY failure — callers decide whether that degrades
   *  (liveness-only hints) or throws (explicit indexed queries). */
  private async hintFetch(path: string, maxBytes: number): Promise<unknown | null> {
    if (!this.hintUrl) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), HINT_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.hintUrl}${path}`, { signal: ctl.signal, redirect: "error" });
      if (!res.ok) return null;
      if (Number(res.headers.get("content-length") ?? 0) > maxBytes) return null;
      const reader = res.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      return JSON.parse(new TextDecoder().decode(concat(...chunks)));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async namespaceHint(): Promise<string[]> {
    // Hint outage → liveness degradation (empty candidates), never a wrong answer.
    const payload = await this.hintFetch("/v1/showcase", HINT_MAX_BODY_BYTES);
    if (payload === null) return [];
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

  /** The Registry-attested Registrar for a namespace — the built-in
   *  resolution authority. Cached with the same TTL discipline as resolver
   *  pointers (the Registry deploys exactly one attested Registrar per node,
   *  but a cheap TTL keeps the two caches uniform). */
  private async attestedRegistrarOf(namespace: string): Promise<string | null> {
    if (this.cacheTtlMs > 0) {
      const hit = this.registrarCache.get(namespace);
      if (hit && Date.now() - hit.at < this.cacheTtlMs) return hit.value;
    }
    const nsNode = await this.namehash(namespace);
    const registrar = ((await this.read(this.registryId, "registrar_of", [bytes(nsNode)])) ??
      null) as string | null;
    if (this.cacheTtlMs > 0) {
      if (this.registrarCache.size >= 1024) {
        const oldest = this.registrarCache.keys().next().value;
        if (oldest !== undefined) this.registrarCache.delete(oldest);
      }
      this.registrarCache.set(namespace, { value: registrar, at: Date.now() });
    }
    return registrar;
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
  /** Bound a promise by the configured timeoutMs (wait bound only — the
   *  underlying request keeps running; it just stops blocking the caller). */
  private async withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
    if (!this.timeoutMs) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gate = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new SoranError(
              `${what} timed out after ${this.timeoutMs}ms (wait bound only — the request itself was not cancelled)`,
              "TIMEOUT",
            ),
          ),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([work, gate]);
    } finally {
      clearTimeout(timer);
    }
  }

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
      sim = await this.withTimeout(this.server.simulateTransaction(tx), `${fn} on ${contractId}`);
    } catch (e) {
      if (e instanceof SoranError) throw e; // keep TIMEOUT/typed codes intact
      throw new SoranError(
        `read ${fn} on ${contractId} failed: ${e instanceof Error ? e.message : String(e)}`,
        // A failure BEFORE the network was reached (bad contract id, bad arg
        // encoding) is a configuration bug, not a transient transport error.
        e instanceof TypeError || String(e).includes("Invalid contract") ? "CONFIG" : "RPC",
      );
    }
    if (!rpc.Api.isSimulationSuccess(sim)) {
      const detail = (sim as { error?: unknown }).error ?? "unknown";
      throw new SoranError(`simulate ${fn} on ${contractId} failed: ${String(detail)}`, "SIMULATION");
    }
    // An entry needing restore is ARCHIVED (rent lapsed), not absent — "null"
    // here would tell a wallet a dormant-but-owned name doesn't resolve. A
    // failure to read must stay distinguishable from a successful None.
    if (rpc.Api.isSimulationRestore(sim)) {
      throw new SoranError(
        `read ${fn} on ${contractId}: the on-chain entry is archived (rent lapsed) — it exists but needs restoring before it can be read`,
        "ARCHIVED",
      );
    }
    if (!sim.result?.retval) return null; // genuine None
    return scValToNative(sim.result.retval);
  }
}

// ---- helpers ----

/** Split and validate `label.namespace`, lowercasing first. Throws SoranError
 *  (code "INVALID_INPUT") — @sorandomains/holder exports the same helper
 *  throwing its own HolderError; import from the package whose errors you
 *  handle. */
export function parseName(name: string): { label: string; namespace: string } {
  const parts = name.toLowerCase().split(".");
  if (parts.length !== 2)
    throw new SoranError(`expected "label.namespace", got "${name}"`, "INVALID_INPUT");
  const [label, namespace] = parts;
  assertLabel(label);
  assertLabel(namespace);
  return { label, namespace };
}

function assertLabel(l: string) {
  if (!LABEL_RE.test(l) || l.length > 63)
    throw new SoranError(`invalid label "${l}"`, "INVALID_INPUT");
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
  return nativeToScVal(b, { type: "bytes" });
}
/** sha256 via the Stellar SDK's bundled pure-JS implementation — identical
 *  bytes everywhere, with zero Node built-ins of our own, so browser
 *  bundlers need no polyfills for this package. */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(hash(data as Buffer));
}
