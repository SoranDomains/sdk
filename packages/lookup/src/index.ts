/** Read Soran names through Universal Lookup by default. Set resolutionMode:
 * "direct" only for a deliberately selected native Resolver integration.
 * Payment tuples are strict; legacy addresses never establish memo safety.
 * Lookup governance may replace its code immediately. */

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

import { destinationFromNative, paymentFromNative, validatePaymentDestination, type PaymentDestination } from "./payment.js";
import { lookupFromNative, type LookupResult } from "./lookup.js";
import { nameFromNative, namespaceFromNative, type NameMetadata, type NamespaceMetadata } from "./views.js";
export type { NameMetadata, NamespaceMetadata, NamespacePolicy } from "./views.js";
export { encodeMuxedAddress, decodeMuxedAddress, PAYMENT_RECORD_KEY, encodePaymentRecord, parsePaymentRecord, validatePaymentDestination, type PaymentMemo, type PaymentDestination } from "./payment.js";
export type { LookupResult, NativePaymentResolution, LegacyAddressResolution } from "./lookup.js";

/** Known public deployments. Override any field via SoranOptions. */
export const DEPLOYMENTS = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: Networks.TESTNET as string,
    // Native muxed testnet deployment verified at ledger 4521644 (2026-09-05 18:10 UTC).
    registryId: "CASORANI5CN2NJFEO2MGTRDA35AOEF3D3OCVBWN3FS6B6FXNQ74RTJ7H",
    lookupId: "CDSORANKG77YZITKWCLWGPKLB2R3HPTP4D6KKZZ7X3R5HLXLMNOTGCDD",
    primaryId: "CCSORANJZOR5ZYTI4KAW34ESAQFMJAO4NKMTIVOVJOI2VDKCDK3RICXZ",
    allocatorId: "CDSORANPTRS2EYHN57OZEXTW23P2HPDM3WEAC754B7GNHRB5V6FTJ2EE",
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
  lookupId?: string;
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
  /** Reviewed Universal Lookup deployment. Uses a matching network preset if
   * present; missing configuration fails closed. null deliberately selects
   * direct native mode. Registry/version checks do not pin executable code. */
  lookupId?: string | null;
  /** Universal is the default. Direct native discovery requires explicit opt-in.
   * lookupId:null is also an explicit direct-mode compatibility opt-out. */
  resolutionMode?: "universal" | "direct";
  /** Optional Primary anchor. In universal mode this must match Lookup.primary;
   * direct mode reads this deployment after checking its Registry. null disables
   * Primary. Custom Registry/passphrase configurations inherit no Primary pin. */
  primaryId?: string | null;
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
  resolver: string | null; // originating Resolver contract id, if any
};

/**
 * The trust verdict on a name's resolution. `resolve()` returns the
 * address the OWNER's current resolver points at — which, for a reclaimable
 * namespace, the owner can repoint at will (that is holder sovereignty, not a
 * bug). Before a high-value pay-to-name, also check `assurance()`: `trustworthy`
 * is true only when the resolver pointer is locked to the Registry-attested,
 * never-upgraded resolver. This protects the implementation and pointer;
 * holders can still update their own payment instructions.
 */
export type NameAssurance = {
  /** resolver_of === attested_resolver_of (the provenance-bound resolver). */
  resolverAttested: boolean;
  /** The attested resolver has upgraded at least once (permanence-barring). */
  resolverTainted: boolean;
  /** The resolver pointer is locked and can no longer be changed. */
  resolverLocked: boolean;
  /** Locked ∧ attested ∧ not tainted — implementation/pointer immutability,
   * not immutability of holder-controlled payment records. */
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
  /** Current destination. Always carry `payment` alongside this field when
   * present. Native payment read failures abort this metadata call. */
  address: string | null;
  /** Complete native payment tuple. Never drop its memo. */
  payment: PaymentDestination | null;
  /** True when the complete payment tuple requires a memo. */
  paymentRequired: boolean;
  /** The native Resolver that answered the payment read. */
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

/** Coverage is an indexer report, not proof that discovery cannot omit names. */
export type IndexCoverage = { source: "indexed"; complete: boolean; processedLedger: number | null; headLedger: number | null;
  gaps: Array<{ contractId: string; fromLedger: number; toLedger: number; reason: string }> };
export type NamesPage = { names: NameSummary[]; nextCursor: string | null; hasMore: boolean;
  complete: boolean; coverage: IndexCoverage | null; verification: { candidates: number; verified: number; excluded: number; failed: number } };
export type PageOptions = { cursor?: string; limit?: number };

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
  /** First verified page and explicit discovery/verification completeness. */
  holdings: NamesPage | null;
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
 *  TIMEOUT (the configured `timeoutMs` elapsed), PAYMENT_REQUIRED (an address-only
 *  call would drop a required memo), LEGACY_MEMO_UNKNOWN (a strict payment call
 *  received a legacy address without native memo capability). */
export type SoranErrorCode =
  | "INVALID_INPUT"
  | "CONFIG"
  | "RPC"
  | "SIMULATION"
  | "ARCHIVED"
  | "ABI"
  | "TIMEOUT"
  | "PAYMENT_REQUIRED"
  | "LEGACY_MEMO_UNKNOWN"
  | "INCOMPLETE";

export class SoranError extends Error {
  constructor(
    message: string,
    readonly code: SoranErrorCode = "RPC",
    readonly contractCode: number | null = null,
    readonly contractError: string | null = null,
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
const HISTORY_MAX_BODY_BYTES = 32_768;

export class Soran {
  private server: rpc.Server;
  private passphrase: string;
  private registryId: string;
  private primaryId?: string;
  private lookupId?: string;
  private resolutionMode: "universal" | "direct";
  private primaryDisabled: boolean;
  private explicitPrimaryId?: string;
  private hintUrl?: string;
  private reverseNamespaces: string[];
  private resolverCache = new Map<string, { value: string | null; at: number }>();
  private registrarCache = new Map<string, { value: string | null; at: number }>();
  private timeoutMs?: number;
  private cacheTtlMs: number;

  constructor(opts: SoranOptions = {}) {
    const base: DeploymentPreset = DEPLOYMENTS[opts.network ?? "testnet"];
    if (!base) throw new SoranError("unknown or undeployed network", "CONFIG");
    // Plain HTTP only for a local node — a production consumer
    // over http:// would let an on-path attacker forge every read this SDK makes.
    const rpcUrl = opts.rpcUrl ?? base.rpcUrl;
    this.server = new rpc.Server(rpcUrl, { allowHttp: /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(rpcUrl) });
    this.passphrase = opts.passphrase ?? base.passphrase;
    this.registryId = opts.registryId ?? base.registryId;
    this.resolutionMode = opts.resolutionMode ?? (opts.lookupId === null ? "direct" : "universal");
    if (!["universal", "direct"].includes(this.resolutionMode)) throw new SoranError("invalid resolutionMode", "CONFIG");
    if ((this.resolutionMode === "direct" && typeof opts.lookupId === "string") || (this.resolutionMode === "universal" && opts.lookupId === null))
      throw new SoranError("lookupId conflicts with resolutionMode", "CONFIG");
    const customNetwork = (opts.registryId !== undefined && opts.registryId !== base.registryId) ||
      (opts.passphrase !== undefined && opts.passphrase !== base.passphrase);
    this.lookupId = this.resolutionMode === "direct" ? undefined : (opts.lookupId ?? (customNetwork ? undefined : base.lookupId));
    this.primaryDisabled = opts.primaryId === null;
    this.explicitPrimaryId = opts.primaryId ?? undefined;
    if (this.lookupId !== undefined && (typeof this.lookupId !== "string" || !StrKey.isValidContract(this.lookupId))) {
      throw new SoranError("invalid lookupId — expected a C… contract strkey", "CONFIG");
    }
    // `null` = explicit opt-out (the preset ships a primaryId, so merely omitting
    // it keeps the feature on); `undefined` inherits the preset.
    // The preset PrimaryName is anchored to the preset Registry — never let it
    // leak onto a custom registryId, where it could only mis-verify.
    const presetPrimary =
      customNetwork ? undefined : base.primaryId;
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
    // Liveness-only namespace-list hint endpoint; absent means "no fallback —
    // reverseLookup without candidates returns null" (fail-closed).
    this.hintUrl = opts.hintUrl?.replace(/\/+$/, "") || undefined;
    // Fail-closed at construction: a malformed namespace label is a config bug,
    // not a runtime condition to skip silently. Lowercased to match parseName.
    this.reverseNamespaces = (opts.reverseNamespaces ?? []).map((ns) => {
      const l = normalizeLabel(ns);
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
    namespace = normalizeLabel(namespace);
    const labelHash = await sha256(utf8(namespace));
    return sha256(concat(new Uint8Array(32), labelHash));
  }

  /** Full node of `label.namespace`: sha256(nsNode ‖ sha256(label)). */
  async node(name: string): Promise<Uint8Array> {
    const { label, namespace } = parseName(name);
    const nsNode = await this.namehash(namespace);
    return sha256(concat(nsNode, await sha256(utf8(label))));
  }

  /** Fresh universal namespace context; None means an unallocated namespace. */
  async namespaceMetadata(namespace: string): Promise<NamespaceMetadata | null> {
    namespace = normalizeLabel(namespace);
    const raw = await this.universalRead("namespace_metadata", [nativeToScVal(namespace, { type: "string" })]);
    try { return namespaceFromNative(raw, namespace, hex(await this.namehash(namespace))); }
    catch (e) { throw new SoranError(`invalid namespace metadata: ${String(e)}`, "ABI"); }
  }

  /** Ownership metadata is distinct from the effective payment destination. */
  async nameMetadata(name: string): Promise<NameMetadata | null> {
    const { label, namespace } = parseName(name);
    const canonical = `${label}.${namespace}`;
    const raw = await this.universalRead("name_metadata", [nativeToScVal(canonical, { type: "string" })]);
    try { return nameFromNative(raw, canonical, hex(await this.node(canonical))); }
    catch (e) { throw new SoranError(`invalid name metadata: ${String(e)}`, "ABI"); }
  }

  /** A verified account display name scoped to one namespace. */
  async reverse(namespace: string, address: string): Promise<string | null> {
    namespace = normalizeLabel(namespace);
    if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) throw new SoranError("invalid address", "INVALID_INPUT");
    if (this.resolutionMode === "universal") {
      const raw = await this.universalRead("reverse", [nativeToScVal(namespace, { type: "string" }), nativeToScVal(address, { type: "address" })]);
      return this.canonicalResult(raw, namespace);
    }
    const resolverId = await this.resolverOf(namespace);
    return resolverId ? this.canonicalResult(await this.nameOf(resolverId, address), namespace) : null;
  }

  private canonicalResult(raw: unknown, namespace?: string): string | null {
    if (raw === null) return null;
    try {
      if (typeof raw !== "string") throw new Error("non-string name");
      const parsed = parseName(raw);
      if (`${parsed.label}.${parsed.namespace}` !== raw || (namespace !== undefined && parsed.namespace !== namespace)) throw new Error("noncanonical or wrong-namespace name");
      return raw;
    } catch (e) { throw new SoranError(`invalid display name: ${String(e)}`, "ABI"); }
  }

  private async universalContext(): Promise<{ id: string; version: 1 | 2 }> {
    if (this.resolutionMode !== "universal" || !this.lookupId)
      throw new SoranError("Universal Lookup is not deployed/configured for this network; supply a verified lookupId or explicitly select resolutionMode: direct", "CONFIG");
    const [anchor, version] = await Promise.all([this.read(this.lookupId, "registry", []), this.read(this.lookupId, "version", [])]);
    if (typeof anchor !== "string" || !StrKey.isValidContract(anchor) || anchor !== this.registryId) throw new SoranError("Lookup has an invalid or different Registry anchor", "CONFIG");
    if (version !== 1 && version !== 2) throw new SoranError("unsupported universal Lookup version", "ABI");
    if (version === 2 && await this.read(this.lookupId, "destination_version", []) !== 2)
      throw new SoranError("unsupported Lookup destination version", "ABI");
    return { id: this.lookupId, version };
  }

  private async universalRead(fn: string, args: xdr.ScVal[]): Promise<unknown> {
    const { id } = await this.universalContext();
    return this.read(id, fn, args);
  }

  // ---- resolution ----

  /** Resolve through the explicitly configured universal contract. A legacy
   * address has unknown memo capability and must never be used as proof of None.
   * No direct Resolver fallback occurs after an error. */
  async lookup(name: string): Promise<LookupResult> {
    if (this.resolutionMode !== "universal") throw new SoranError("lookup requires universal mode", "CONFIG");
    if (typeof name !== "string") throw new SoranError("name must be a string", "INVALID_INPUT");
    const { label, namespace } = parseName(name);
    const canonical = `${label}.${namespace}`;
    const { id, version } = await this.universalContext();
    const raw = await this.read(id, version === 2 ? "resolve_v2" : "resolve", [nativeToScVal(canonical, { type: "string" })]);
    try { return lookupFromNative(raw, canonical, version); }
    catch (e) { throw new SoranError(`invalid universal lookup result: ${String(e)}`, "ABI"); }
  }

  /** Complete instructions through Lookup when configured, otherwise from the
   * namespace's native Resolver. Ordinary
   * names return None; unsupported ABI, corrupt state and read failures throw.
   * No address-only or Registrar fallback is permitted. */
  async resolvePayment(name: string): Promise<PaymentDestination> {
    return (await this.paymentRecord(name)).payment;
  }

  private async paymentRecord(name: string): Promise<{ payment: PaymentDestination; resolver: string; generation?: bigint; registrar?: string }> {
    if (this.resolutionMode === "universal") {
      const result = await this.lookup(name);
      if (result.kind === "legacyAddress")
        throw new SoranError("legacy address has unknown memo capability; native payment instructions are required", "LEGACY_MEMO_UNKNOWN");
      return { payment: result.payment, resolver: result.resolver, generation: result.generation, registrar: result.registrar };
    }
    const { label, namespace } = parseName(name);
    const nsNode = await this.namehash(namespace);
    // Payment discovery is always fresh, independent of metadata/reverse caches.
    const [resolver, registrar] = await Promise.all([
      this.read(this.registryId, "resolver_of", [bytes(nsNode)]),
      this.read(this.registryId, "registrar_of", [bytes(nsNode)]),
    ]);
    if (typeof resolver !== "string" || !StrKey.isValidContract(resolver))
      throw new SoranError("namespace has no valid native payment Resolver", "CONFIG");
    if (typeof registrar !== "string" || !StrKey.isValidContract(registrar))
      throw new SoranError("namespace has no valid Registrar", "CONFIG");
    const [anchor, authority, version, anchors] = await Promise.all([
      this.read(resolver, "registry", []),
      this.read(resolver, "authority", []),
      this.read(resolver, "payment_version", []),
      this.read(registrar, "anchors", []),
    ]);
    if (anchor !== this.registryId) throw new SoranError("payment Resolver is anchored to a different Registry", "CONFIG");
    if (authority !== registrar) throw new SoranError("payment Resolver authority does not match the namespace Registrar", "CONFIG");
    if (!Array.isArray(anchors) || anchors.length !== 2 || anchors[0] !== this.registryId ||
        !(anchors[1] instanceof Uint8Array) || anchors[1].length !== nsNode.length ||
        !nsNode.every((byte, index) => anchors[1][index] === byte))
      throw new SoranError("Registrar anchors do not match this Registry and namespace", "CONFIG");
    if (version !== 1 && version !== 2) throw new SoranError("unsupported native payment Resolver version", "ABI");
    if (version === 2 && await this.read(resolver, "destination_version", []) !== 2)
      throw new SoranError("unsupported Resolver destination version", "ABI");
    const raw = await this.read(resolver, version === 2 ? "resolve_destination" : "resolve_payment", [nativeToScVal(`${label}.${namespace}`, { type: "string" })]);
    try { return { payment: version === 2 ? destinationFromNative(raw) : paymentFromNative(raw), resolver }; }
    catch (e) { throw new SoranError(`invalid payment result: ${String(e)}`, "ABI"); }
  }

  /** Recheck every destination field at confirmation, including the memo. This
   * is a fresh read, not a guarantee against subsequent holder changes. */
  async verifyPayment(name: string, expected: PaymentDestination): Promise<boolean> {
    let want: PaymentDestination;
    try { want = validatePaymentDestination(expected); }
    catch (e) { throw new SoranError(String(e), "INVALID_INPUT"); }
    const got = await this.resolvePayment(name);
    return got.address === want.address && got.memo.type === want.memo.type &&
      (got.memo.type === "none" || (want.memo.type !== "none" && got.memo.value === want.memo.value));
  }

  /** Address-only lookup. Accepts only the native Resolver's atomic None
   * result; a required memo must be consumed through resolvePayment. */
  async resolve(name: string): Promise<string | null> {
    return (await this.record(name)).address;
  }

  /** Address-only record; the complete native payment read must prove None. */
  async record(name: string): Promise<NameRecord> {
    const { payment, resolver } = await this.paymentRecord(name);
    if (payment.memo.type !== "none") throw new SoranError("this name requires a memo; use resolvePayment", "PAYMENT_REQUIRED");
    return { name, address: payment.address, node: hex(await this.node(name)), resolver };
  }

  /** A text record (e.g. "url", "avatar") for a name, or null. */
  async text(name: string, key: string): Promise<string | null> {
    const { label, namespace } = parseName(name);
    if (!/^[A-Za-z0-9_]{1,32}$/.test(key)) throw new SoranError("invalid text record key", "INVALID_INPUT");
    if (this.resolutionMode === "universal") {
      const raw = await this.universalRead("text", [nativeToScVal(`${label}.${namespace}`, { type: "string" }), nativeToScVal(key, { type: "symbol" })]);
      if (raw === null) return null;
      if (typeof raw !== "string" || utf8(raw).length > 4096) throw new SoranError("invalid text result", "ABI");
      return raw;
    }
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
   * never-upgraded resolver. Holder-controlled records can still change;
   * this verdict does not bind a later payment to a prior lookup.
   */
  async assurance(name: string): Promise<NameAssurance> {
    const { namespace } = parseName(name);
    if (this.resolutionMode === "universal") {
      const meta = await this.namespaceMetadata(namespace);
      return { resolverAttested: meta?.resolverAttested ?? false, resolverLocked: meta?.resolverLocked ?? false,
        resolverTainted: meta?.resolverTainted ?? false, trustworthy: !!meta && meta.resolverAttested && meta.resolverLocked && !meta.resolverTainted };
    }
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
    const claimed = await this.reverse(namespace, address);
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
    if (!this.primaryDisabled && (this.resolutionMode === "universal" || this.primaryId)) {
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
      (this.primaryDisabled || (this.resolutionMode === "direct" && !this.primaryId))
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
      const l = normalizeLabel(ns);
      return l;
    });
    // Fire every probe in parallel. Each chain is independent: resolve the
    // namespace's Resolver pointer, then ask it for the reverse record.
    const settled = await Promise.allSettled(
      labels.map(async (l) => {
        return this.reverse(l, address);
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
    if (this.primaryDisabled) return null;
    if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) return null;
    if (this.resolutionMode === "universal") {
      if (this.explicitPrimaryId) {
        const selected = await this.universalRead("primary", []);
        if (selected !== this.explicitPrimaryId) throw new SoranError("Lookup Primary does not match configured primaryId", "CONFIG");
      }
      const raw = await this.universalRead("primary_name", [nativeToScVal(address, { type: "address" })]);
      return this.canonicalResult(raw);
    }
    if (!this.primaryId) return null;
    if (await this.read(this.primaryId, "registry", []) !== this.registryId) throw new SoranError("Primary is anchored to a different Registry", "CONFIG");
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
    return this.canonicalResult(raw);
  }

  // ---- namespace-level reads ----

  /** { owner, resolver } of a namespace, or null if unregistered. */
  async namespace(ns: string): Promise<{ owner: string; resolver: string | null } | null> {
    ns = normalizeLabel(ns);
    if (this.resolutionMode === "universal") {
      const meta = await this.namespaceMetadata(ns);
      return meta ? { owner: meta.owner, resolver: meta.resolver } : null;
    }
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
    if (this.resolutionMode === "universal") {
      const [meta, ns, paymentRecord] = await Promise.all([this.nameMetadata(name), this.namespaceMetadata(namespace), this.paymentRecord(name)]);
      if (!meta || !ns || meta.generation !== paymentRecord.generation || meta.registrar !== paymentRecord.registrar ||
          ns.registrar !== meta.registrar || ns.resolver !== paymentRecord.resolver)
        throw new SoranError("name metadata changed during lookup", "SIMULATION");
      return { name: `${label}.${namespace}`, node: meta.node, address: paymentRecord.payment.address, payment: paymentRecord.payment,
        paymentRequired: paymentRecord.payment.memo.type !== "none", resolver: paymentRecord.resolver,
        holder: meta.holder, expiresAt: meta.expiresAt, generation: meta.generation,
        namespace: { namespace, owner: ns.owner, registrar: ns.registrar, resolver: ns.resolver, permanent: ns.permanent, policy: ns.policy },
        assurance: { resolverAttested: ns.resolverAttested, resolverLocked: ns.resolverLocked, resolverTainted: ns.resolverTainted,
          trustworthy: ns.resolverAttested && ns.resolverLocked && !ns.resolverTainted } };
    }
    // Warm the two pointer caches first so the fan-out below reuses them
    // instead of re-simulating the same Registry reads.
    const registrarId = await this.attestedRegistrarOf(namespace);
    let payment: PaymentDestination | null = null;
    let paymentRequired = false;
    const metadataRecord = async (): Promise<NameRecord> => {
      const result = await this.paymentRecord(name);
      payment = result.payment;
      paymentRequired = payment.memo.type !== "none";
      return { name, address: payment.address, node: hex(await this.node(name)), resolver: result.resolver };
    };
    const [rec, ns, assur] = await Promise.all([
      metadataRecord(),
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
      payment,
      paymentRequired,
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
    if (this.resolutionMode === "direct") await this.resolverOf(parseName(name).namespace);
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
      (this.primaryDisabled || (this.resolutionMode === "direct" && !this.primaryId))
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
      const l = normalizeLabel(ns);
      return l;
    });
    const settled = await Promise.allSettled(
      labels.map(async (ns) => {
        return this.reverse(ns, address);
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

  /** One bounded discovery page, with every included holding verified on chain.
   * Follow nextCursor; complete also requires the indexer's reported coverage
   * and successful candidate checks. An indexer can still omit names. */
  async namesOfPage(address: string, options: PageOptions = {}): Promise<NamesPage> {
    if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) throw new SoranError("invalid holder address", "INVALID_INPUT");
    if (!this.hintUrl) throw new SoranError("namesOfPage requires a discovery hintUrl", "CONFIG");
    const limit = options.limit ?? 40;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (options.cursor !== undefined && (typeof options.cursor !== "string" || options.cursor.length < 1 || options.cursor.length > 2048)))
      throw new SoranError("invalid page limit/cursor", "INVALID_INPUT");
    const query = `?limit=${limit}${options.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : ""}`;
    const payload = await this.hintFetch(`/v1/names/by-holder/${address}${query}`, 131072);
    if (!payload || typeof payload !== "object") throw new SoranError("holdings discovery unavailable", "RPC");
    const raw = payload as Record<string, unknown>;
    if (raw.holder !== address || !Array.isArray(raw.names) || raw.names.length > limit || typeof raw.hasMore !== "boolean" ||
        !(raw.nextCursor === null || (typeof raw.nextCursor === "string" && raw.nextCursor.length > 0 && raw.nextCursor.length <= 2048)) || raw.hasMore !== (raw.nextCursor !== null))
      throw new SoranError("invalid holdings discovery page", "ABI");
    const coverage = decodeCoverage(raw.coverage);
    const seen = new Set<string>();
    let excluded = 0, failed = 0;
    const names: NameSummary[] = [];
    // Eight workers bound RPC fan-out even when a page contains 100 candidates.
    let index = 0;
    const workers = Array.from({ length: Math.min(8, raw.names.length) }, async () => {
      while (index < (raw.names as unknown[]).length) {
        const entry = (raw.names as unknown[])[index++];
        try {
          const input = (entry as { name?: unknown } | null)?.name;
          if (typeof input !== "string") throw new Error("invalid candidate");
          const { label, namespace } = parseName(input);
          const name = `${label}.${namespace}`;
          if (seen.has(name)) { excluded++; continue; }
          seen.add(name);
          let expiresAt: bigint;
          if (this.resolutionMode === "universal") {
            const meta = await this.nameMetadata(name);
            if (!meta || !meta.active || meta.holder !== address) { excluded++; continue; }
            expiresAt = meta.expiresAt;
          } else {
            const registrarId = await this.attestedRegistrarOf(namespace);
            if (!registrarId) { excluded++; continue; }
            const [holder, value] = await Promise.all([
              this.read(registrarId, "holder_of_node", [bytes(await this.node(name))]),
              this.read(registrarId, "record_of", [nativeToScVal(utf8(label), { type: "bytes" })]),
            ]);
            const rec = value as { holder?: unknown; expires_at?: unknown } | null;
            if (holder !== address || !rec || rec.holder !== address) { excluded++; continue; }
            if (typeof rec.expires_at !== "bigint" || rec.expires_at < 0n || rec.expires_at > 18446744073709551615n) throw new Error("invalid expiry");
            expiresAt = rec.expires_at;
          }
          names.push({ name, namespace, label, node: hex(await this.node(name)), holder: address, expiresAt });
        } catch { failed++; }
      }
    });
    await Promise.all(workers);
    names.sort((a, b) => a.name.localeCompare(b.name, "en"));
    return { names, nextCursor: raw.nextCursor as string | null, hasMore: raw.hasMore,
      complete: !raw.hasMore && coverage?.complete === true && failed === 0, coverage,
      verification: { candidates: raw.names.length, verified: names.length, excluded, failed } };
  }

  /** Compatibility array API. It follows at most ten 100-name pages and throws
   * INCOMPLETE if discovery/verification is partial; use namesOfPage for UI. */
  async namesOf(address: string): Promise<NameSummary[]> {
    const names = new Map<string, NameSummary>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await this.namesOfPage(address, { cursor, limit: 100 });
      for (const name of page.names) names.set(name.name, name);
      if (page.verification.failed || page.coverage?.complete !== true) throw new SoranError("holdings discovery or verification is incomplete; use namesOfPage", "INCOMPLETE");
      if (!page.hasMore) return [...names.values()];
      if (!page.nextCursor || cursors.has(page.nextCursor)) throw new SoranError("repeated holdings cursor", "ABI");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new SoranError("holdings exceed the bounded aggregate; use namesOfPage", "INCOMPLETE");
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
        "history needs an indexer source: set hintUrl",
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
          return this.reverse(namespace, details.address);
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
   * With no discovery URL, holdings is null. Missing reverse probe sources
   * degrade to an empty candidate result; chain failures still throw. Holdings
   * is the first page with explicit continuation/coverage, not all holdings.
   */
  async walletProfile(address: string): Promise<WalletProfile> {
    if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) {
      throw new SoranError(`invalid address "${address}"`, "INVALID_INPUT");
    }
    const [primary, reverseNames, holdings] = await Promise.all([
      this.primaryOf(address),
      this.reverseNames(address).catch((e) => {
        if (e instanceof SoranError && e.code === "CONFIG") return [] as ReverseName[];
        throw e;
      }),
      this.hintUrl ? this.namesOfPage(address) : Promise.resolve(null),
    ]);
    const profile = primary ? await this.profile(primary) : {};
    return { address, primary, reverseNames, names: holdings?.names ?? null, holdings, profile };
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
      if (/[^\x00-\x7f]/.test(label)) continue;
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
      const known = contractId === this.lookupId ? lookupError(String(detail)) : null;
      throw new SoranError(`simulate ${fn} on ${contractId} failed: ${String(detail)}`, "SIMULATION", known?.code ?? null, known?.name ?? null);
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
    if (!sim.result?.retval) throw new SoranError(`read ${fn}: missing simulation return value`, "ABI");
    try { return scValToNative(sim.result.retval); }
    catch (e) { throw new SoranError(`cannot decode ${fn} result: ${String(e)}`, "ABI"); }
  }
}

// ---- helpers ----

/** Split and validate `label.namespace`, lowercasing first. Throws SoranError
 *  (code "INVALID_INPUT") — @sorandomains/holder exports the same helper
 *  throwing its own HolderError; import from the package whose errors you
 *  handle. */
export function parseName(name: string): { label: string; namespace: string } {
  if (typeof name !== "string" || /[^\x00-\x7f]/.test(name)) throw new SoranError("name must contain ASCII characters only", "INVALID_INPUT");
  const parts = name.toLowerCase().split(".");
  if (parts.length !== 2)
    throw new SoranError(`expected "label.namespace", got "${name}"`, "INVALID_INPUT");
  const [label, namespace] = parts;
  assertLabel(label);
  assertLabel(namespace);
  return { label, namespace };
}

/** Normalize ASCII case only; Unicode lookalikes are never aliases. */
export function normalizeLabel(value: string): string {
  if (typeof value !== "string" || /[^\x00-\x7f]/.test(value)) throw new SoranError("label must contain ASCII characters only", "INVALID_INPUT");
  const normalized = value.toLowerCase();
  assertLabel(normalized);
  return normalized;
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

/** Numeric Lookup ABI names; unknown/future errors remain unclassified. */
export const LOOKUP_ERRORS: Readonly<Record<number, string>> = Object.freeze({
  1: "InvalidRegistry", 2: "InvalidGovernance", 3: "NotInitialized", 4: "MalformedName", 5: "NamespaceNotFound",
  6: "RegistrarMissing", 7: "NameInactive", 8: "ContextMismatch", 9: "UnsupportedImplementation", 10: "DependencyUnavailable",
  11: "InvalidPayment", 12: "LegacyMemoUnknown", 13: "MemoRequired", 14: "UpgradePending", 15: "NoPendingUpgrade",
  16: "UpgradeNotReady", 17: "UpgradeHashMismatch", 18: "TimestampOverflow", 19: "PrimaryNotConfigured", 20: "InvalidPrimary", 21: "ReadTooLarge", 22: "MuxedDestination",
});
function lookupError(detail: string): { code: number; name: string } | null {
  // Match only the RPC's leading contract failure, never an inner trace/log.
  const match = /^(?:HostError: )?Error\(Contract, #(\d+)\)(?:\s|$)/.exec(detail);
  const code = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(code) && LOOKUP_ERRORS[code] ? { code, name: LOOKUP_ERRORS[code] } : null;
}

function decodeCoverage(raw: unknown): IndexCoverage | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const ledger = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
  if (c.source !== "indexed" || typeof c.complete !== "boolean" || !ledger(c.processedLedger) || !ledger(c.headLedger) || !Array.isArray(c.gaps) || c.gaps.length > 1000) return null;
  const gaps: IndexCoverage["gaps"] = [];
  for (const item of c.gaps) {
    const g = item as Record<string, unknown> | null;
    if (!g || typeof g.contractId !== "string" || g.contractId.length > 128 || typeof g.reason !== "string" || g.reason.length > 512 ||
      typeof g.fromLedger !== "number" || !ledger(g.fromLedger) || typeof g.toLedger !== "number" || !ledger(g.toLedger) || g.toLedger < g.fromLedger) return null;
    gaps.push({ contractId: g.contractId, fromLedger: g.fromLedger, toLedger: g.toLedger, reason: g.reason });
  }
  return { source: "indexed", complete: c.complete && gaps.length === 0 && c.processedLedger !== null && c.headLedger !== null && c.processedLedger >= c.headLedger,
    processedLedger: c.processedLedger, headLedger: c.headLedger, gaps };
}
