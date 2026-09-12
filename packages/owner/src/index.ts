import { recoverFrozenClaim, historicalReadLedger, type HistoricalRead, type HistoricalRecoveryOptions } from "./native-history.js";
import type { ClaimIntent } from "./native-types.js";
export type { HistoricalRecoveryOptions } from "./native-history.js";
/**
 * @sorandomains/owner — the write-side SDK for Soran namespace owners.
 *
 * Everything a namespace owner does after winning a namespace, programmatically:
 *
 *   import { SoranOwner, keypairSigner } from "@sorandomains/owner";
 *
 *   const owner = new SoranOwner({ signer: keypairSigner(process.env.OWNER_SECRET!) });
 *   await owner.issue("acme", "alice", "GDHN…");          // alice.acme now resolves
 *   await owner.issueBatch("acme", csvRows);              // up to 23 per transaction
 *
 * TRUST MODEL. This SDK talks to the contracts directly over any Soroban RPC
 * node — no Soran account, no hosted API, no third party in the path. Every
 * operation here is authorized on chain: the Registrar and Registry check
 * `require_auth` against the namespace owner's address, so the only credential
 * that matters is the signer you supply. Soran's servers cannot perform any of
 * these operations for you or against you.
 *
 * WHO CAN CALL WHAT. All operations below are namespace-OWNER powers except
 * `acceptNamespaceTransfer`, which the proposed NEW owner signs. Name-holder
 * powers (transferring an individual name, pointing it at a new address,
 * electing a primary name) are the holder's alone — they live in the contracts'
 * holder-authorized entry points and live in `@sorandomains/holder`; this
 * package deliberately cannot exercise them.
 *
 * SIGNING. Supply a `TxSigner`: `keypairSigner(secret)` for backends, or wrap a
 * browser wallet (Freighter / Stellar Wallets Kit expose exactly this
 * `signTransaction(xdr, { networkPassphrase })` shape). The SDK builds and
 * simulates each transaction, hands you the envelope to sign, and submits it.
 * Operations on one SoranOwner instance are serialized so concurrent calls
 * cannot race the account sequence number.
 *
 * READS. For resolution, reverse lookup, and assurance checks use the read-only
 * companion package `@sorandomains/lookup` — wallets and apps should depend on
 * that one only. The few reads here (policy, pending transfers, records) exist
 * to support write flows.
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  StrKey,
  SorobanDataBuilder,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

type Invoked = {
  hash: string;
  ledger: number;
  returnValue: unknown;
  /** The transaction's own contract events — ground truth for what happened. */
  events: xdr.ContractEvent[];
};

/** Contract events from a transaction's meta, across meta versions (v3 puts
 *  them on sorobanMeta; v4 nests them per-operation and in tx events). */
function extractContractEvents(meta: xdr.TransactionMeta | undefined): xdr.ContractEvent[] {
  try {
    if (!meta) return [];
    // (SDK17/js-xdr v5) TransactionMeta discriminates on `.type`; the arm value
    // is `.value`; struct fields (sorobanMeta, operations, events) are properties.
    if (meta.type === "v3") return meta.value.sorobanMeta?.events ?? [];
    if (meta.type === "v4") {
      const v4 = meta.value;
      return [
        ...v4.operations.flatMap((op) => op.events),
        ...v4.events.map((te) => te.event),
      ];
    }
    return [];
  } catch {
    return [];
  }
}

/** The (label, holder) pairs from a transaction's Registrar `issued` events. */
function decodeIssuedEvents(
  events: xdr.ContractEvent[],
  registrarId: string,
): Array<{ label: string; holder: string }> {
  const out: Array<{ label: string; holder: string }> = [];
  for (const ev of events) {
    try {
      const cid = ev.contractId; // (SDK17) property, ContractId | null
      if (!cid) continue;
      if (Address.contract(cid.toBytes() as unknown as Buffer).toString() !== registrarId) continue;
      const body = ev.body.value; // ContractEventBody → ContractEventV0
      const topics = body.topics;
      if (topics.length < 1 || scValToNative(topics[0]) !== "issued") continue;
      const data = scValToNative(body.data) as [unknown, unknown];
      if (!(data?.[0] instanceof Uint8Array) || typeof data?.[1] !== "string") continue;
      out.push({ label: new TextDecoder().decode(data[0]), holder: data[1] });
    } catch {
      /* not an issued event — skip */
    }
  }
  return out;
}

import { NativeClaimError, address as nativeAddress, bool as nativeBool, bytes32 as nativeBytes32, hex as nativeHex, sc as nativeSc, utf8 as nativeUtf8, namespaceNode as nativeNamespaceNode } from "./native-codec.js";
import { requireNative, nativeCapability, sendNative, type NativeContext, type NativeWriteOptions, type NativeCapability } from "./native-transport.js";
import { claimSettingsToScVal, claimConfigFromNative, claimLabelToScVal, claimUsageFromNative, approvalUsageFromNative, type ClaimSettings, type ClaimConfig, type ClaimUsage, type ApprovalUsage } from "./native-types.js";
export * from "./native-types.js";
export * from "./native-allowlist.js";
export { NativeClaimError, namespaceNode as nativeNamespaceNode, paymentDestinationToScVal } from "./native-codec.js";
export { validateNativeTransaction, authorizedInvocation, type NativeAuthorizationPlan } from "./native-auth.js";
export type { NativeCapability, NativePrepared, NativeWriteOptions } from "./native-transport.js";

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

/** Known public deployments. Pass explicit options for anything else. */
export const DEPLOYMENTS = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: Networks.TESTNET as string,
    // The governed Registry. The Registrar for a namespace is discovered on
    // chain via `registrar_of(node)` — never configured by hand.
    registryId: "CCSORANDPQINYOYB5SVO45WJP2LBBYKC72HHUIRVXB4J6RUZKDAUW7G4",
  },
} as const;

/** Explicit historical deployment access. Names in different Registries are separate identities; never a fallback. */
export const LEGACY_DEPLOYMENTS = {
  testnet20260905: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: Networks.TESTNET as string,
    // The immutable Registry. The Registrar for a namespace is discovered on
    // chain via `registrar_of(node)` — never configured by hand.
    registryId: "CASORANI5CN2NJFEO2MGTRDA35AOEF3D3OCVBWN3FS6B6FXNQ74RTJ7H",
  },
} as const;

// ---------------------------------------------------------------------------
// Signers
// ---------------------------------------------------------------------------

/**
 * Anything that can sign a base64 transaction envelope. Browser wallets
 * match `signTransaction`'s shape (the signed XDR string and `{ signedTxXdr }`
 * object returns are both accepted); wrap their address getter as `publicKey`:
 *
 *   { publicKey: () => walletAddress, signTransaction: (x, o) => kit.signTransaction(x, o) }
 */
export type TxSigner = {
  publicKey(): string | Promise<string>;
  signTransaction(
    xdrBase64: string,
    opts: { networkPassphrase: string },
  ): Promise<string | { signedTxXdr: string }>;
};

/** A TxSigner over a raw secret key — for backends and scripts. */
export function keypairSigner(secret: string): TxSigner {
  const kp = Keypair.fromSecret(secret);
  return {
    publicKey: () => kp.publicKey(),
    signTransaction: async (xdrBase64, { networkPassphrase }) => {
      const tx = TransactionBuilder.fromXDR(xdrBase64, networkPassphrase);
      tx.sign(kp);
      return tx.toXDR();
    },
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Registrar contract error codes, by number. */
const REGISTRAR_ERRORS: Record<number, string> = {
  1: "AlreadyInitialized",
  2: "NotInitialized",
  3: "NameTaken",
  4: "NameNotFound",
  5: "NotReclaimable",
  6: "NotTransferable",
  7: "AlreadyPermanent",
  8: "BatchTooLarge",
  9: "NotNamespaceOwner",
  10: "BadLabel",
  11: "PermanentName",
  12: "FiniteTermPolicy",
  13: "PermanentlyLocked",
  14: "NameExpired",
  15: "NoPendingTransfer",
  16: "TransferExpired",
  17: "StaleTransfer",
  18: "InvalidPolicy",
  19: "ExpiryOverflow",
  20: "InvalidRegistry",
  21: "InvalidClaimConfig",
  22: "ClaimsNotConfigured",
  23: "ClaimsPaused",
  24: "StaleClaimPolicy",
  25: "ClaimIntentMismatch",
  26: "ClaimIntentExpired",
  27: "ReservedName",
  28: "NameNotReserved",
  29: "PublicIssuanceRequired",
  30: "WalletClaimLimit",
  31: "InvalidEligibility",
  32: "ApprovalAllowanceReached",
  33: "ApprovalRateReached",
  34: "RequestIdConflict",
  35: "CounterOverflow",
  36: "InvalidNativeBinding",
  37: "UnsupportedClaimant",
  38: "DuplicateLabel",
  39: "RenewalTooEarly",
  40: "RenewalLeaseLimit",
  41: "DestinationInitializationFailed",
  42: "FeeSettlementFailed",
  43: "MigrationInProgress",
  44: "MigrationAlreadyStarted",
  45: "MigrationNotActive",
  46: "MigrationMismatch",
  47: "MigrationDuplicate",
  48: "MigrationIncomplete",
  49: "MigrationUnavailable",
  50: "MigrationUnsupported",
  51: "PermanentLockDisabled",
};

/** Registry contract error codes, by number. */
const REGISTRY_ERRORS: Record<number, string> = {
  1: "AlreadyInitialized",
  2: "NotInitialized",
  3: "NodeTaken",
  4: "NodeNotFound",
  5: "BadProof",
  6: "NotOwner",
  7: "ReservedLabel",
  8: "BadLabel",
  9: "ReservationActive",
  10: "ReservationLapsed",
  11: "NoPendingTransfer",
  12: "TransferExpired",
  13: "ResolverFrozen",
  14: "ResolverRequired",
  15: "UnapprovedResolver",
  16: "UnapprovedRegistrar",
  17: "ResolverAuthorityMismatch",
  18: "RegistrarAlreadyDeployed",
  19: "UnattestedRegistrar",
  20: "RegistrarTainted",
  21: "UnattestedResolver",
  22: "ResolverTainted",
  23: "ResolverAlreadyDeployed",
  24: "InvalidPolicy",
  25: "ProvenanceMismatch",
  26: "AnchorMismatch",
  27: "InvalidAllocator",
  28: "StaleEra",
  29: "OwnershipEpochUnavailable",
  30: "OwnershipEpochOverflow",
  31: "MigrationInProgress",
  32: "MigrationAlreadyStarted",
  33: "MigrationNotActive",
  34: "MigrationMismatch",
  35: "MigrationIncomplete",
  36: "MigrationDuplicate",
  37: "MigrationUnsupported",
  38: "MigrationUnavailable",
  39: "UpgradePolicyMismatch",
  40: "UpgradeNotApproved",
  41: "PermanentLockDisabled",
};

/**
 * A failed owner operation. When the contract itself rejected the call,
 * `code`/`codeName` carry its typed error (e.g. code 9 / "NotNamespaceOwner"
 * from the Registrar); both are null for transport-level failures. `txHash` is
 * set when a transaction reached the network before failing or timing out —
 * always re-check an operation with a hash before retrying it.
 */
export class OwnerError extends Error {
  constructor(
    message: string,
    readonly contractId: string | null = null,
    readonly fn: string | null = null,
    readonly code: number | null = null,
    readonly codeName: string | null = null,
    readonly txHash: string | null = null,
  ) {
    super(message);
    this.name = "OwnerError";
  }
}

/** `Error(Contract, #N)` in a simulation/result message → N, else null. */
function parseContractCode(message: string): number | null {
  const m = /Error\(Contract, #(\d+)\)/.exec(message);
  return m ? Number(m[1]) : null;
}

function typedError(
  contractId: string,
  fn: string,
  raw: string,
  names: Record<number, string>,
  txHash: string | null = null,
): OwnerError {
  const code = parseContractCode(raw);
  const codeName = code !== null ? (names[code] ?? null) : null;
  const label = codeName ? ` (${codeName})` : "";
  return new OwnerError(
    `${fn} failed${code !== null ? `: contract error #${code}${label}` : `: ${raw}`}`,
    contractId,
    fn,
    code,
    codeName,
    txHash,
  );
}

// ---------------------------------------------------------------------------
// Hashing + arguments (must mirror the on-chain scheme exactly)
// ---------------------------------------------------------------------------

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Contract label rules: 1–63 bytes of a-z 0-9, `-` neither first nor last. */
export function normalizeLabel(value: string): string {
  if (typeof value !== "string" || /[^\x00-\x7f]/.test(value)) throw new OwnerError("label must contain ASCII characters only");
  const normalized = value.toLowerCase();
  assertLabel(normalized);
  return normalized;
}

function assertLabel(label: string): void {
  if (label.length < 1 || label.length > 63 || !LABEL_RE.test(label)) {
    throw new OwnerError(
      `invalid label "${label}" — 1-63 chars of a-z, 0-9, and non-edge hyphens`,
    );
  }
}

/** Registry namehash of a top-level namespace: sha256(ZERO32 ‖ sha256(ns)). */
// Byte helpers with zero Node built-ins of our own — browser bundlers get no
// bare `Buffer` references from this package. (`hash` accepts Uint8Array at
// runtime; its Buffer parameter type is cast around.)
const utf8 = (str: string): Uint8Array => new TextEncoder().encode(str);
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function namehash(namespace: string): Uint8Array {
  const labelHash = new Uint8Array(hash(utf8(namespace) as Buffer));
  return new Uint8Array(hash(concatBytes(new Uint8Array(32), labelHash) as Buffer));
}

const labelArg = (label: string) =>
  nativeToScVal(utf8(label), { type: "bytes" });
const addrArg = (address: string) => {
  if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address))
    throw new OwnerError("ownership and operator addresses must be G or C; muxed M is a payment destination only");
  return nativeToScVal(address, { type: "address" });
};
const nodeArg = (node: Uint8Array) => nativeToScVal(node, { type: "bytes" });

function toHex(v: unknown): string {
  if (!(v instanceof Uint8Array)) {
    throw new OwnerError(
      `expected 32 bytes from the contract, got ${typeof v} — ABI drift; refusing to fabricate a node id`,
    );
  }
  return Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Simulation-only reads need a well-formed source account that never signs.
const SIM_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** One transaction issues at most this many names (contract MAX_BATCH). */
export const MAX_BATCH = 23;

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type Submitted = { hash: string; ledger: number };

export type IssueResult = Submitted & {
  /** The issued name's 32-byte node, hex — what resolvers key records by. */
  node: string;
};

export type IssueOutcome = {
  label: string;
  holder: string;
  issued: boolean;
  /** Best-effort reason a name was not issued: already held by someone else
   *  ("taken") or refused in-batch ("skipped" — e.g. a duplicate label earlier
   *  in the same batch won). Absent when `issued` is true. */
  reason?: "taken" | "skipped";
};

export type IssueBatchResult = Submitted & {
  /** How many names the contract reports it issued in this transaction. */
  issuedCount: number;
  /** Per-label outcome. With `outcomeSource: "events"` (the normal case) each
   *  outcome is read from the transaction's own `issued` events — exact, no
   *  clocks, no re-reads. */
  outcomes: IssueOutcome[];
  /** Where the outcomes came from: "events" (the transaction's own contract
   *  events — authoritative), or "reread" (post-transaction state reads —
   *  correct unless a concurrent writer touched the same labels). */
  outcomeSource: "events" | "reread";
  /** False if `issuedCount` and the outcomes disagree — with "events" this
   *  cannot happen short of a node serving damaged meta; with "reread" it
   *  usually means a concurrent writer. `issuedCount` is the contract's own
   *  answer; investigate before assuming either side. */
  countMatches: boolean;
};

export type NamespacePolicy = {
  reclaimable: boolean;
  transferable: boolean;
  tradeable: boolean;
  /** Seconds per issued term. 0n = names never expire. */
  defaultTermSecs: bigint;
  tradeFeeBps: number;
};

export type NameState = {
  holder: string;
  /** Where the name currently resolves (holder-controlled; may differ). */
  address: string;
  /** 0n = never expires. */
  expiresAt: bigint;
  generation: bigint;
};

export type OwnerOptions = {
  /** Maximum total network fee per transaction, including restoration. Default 5 XLM.
   * If omitted, an explicit maxNativeFeeStroops also supplies this ceiling. */
  maxNetworkFeeStroops?: bigint;
  /** Optional additional native-operation ceiling; the lower configured limit wins. */
  maxNativeFeeStroops?: bigint;
  /** Signs every transaction. The namespace owner's account — or, for
   *  `acceptNamespaceTransfer`, the proposed new owner's. */
  signer: TxSigner;
  /** Named deployment preset (rpcUrl + passphrase + registryId together).
   *  Defaults to "testnet". Explicit fields below override preset pieces —
   *  but override rpcUrl/passphrase/registryId as a SET for a custom
   *  deployment; mixing one network's registry with another's passphrase
   *  cannot work. */
  network?: keyof typeof DEPLOYMENTS;
  rpcUrl?: string;
  passphrase?: string;
  registryId?: string;
  /** Allow http:// RPC (local dev only). */
  allowHttp?: boolean;
  /** Transaction time bound, seconds (default 60). */
  timeoutSecs?: number;
  /** Base fee bid, stroops (default 100; resource fees are added on top). */
  fee?: string;
};

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class SoranOwner {
  private maxNativeFeeStroops: bigint;
  private maxNetworkFeeStroops: bigint;
  private server: rpc.Server;
  private passphrase: string;
  private registryId: string;
  private signer: TxSigner;
  private timeoutSecs: number;
  private fee: string;
  // One in-flight write at a time per instance: concurrent builds would fetch
  // the same account sequence and the loser fails txBAD_SEQ.
  private queue: Promise<unknown> = Promise.resolve();
  // Registrar pointers are re-read after a short TTL: the attestation is
  // one-per-node, but "forever" caching would survive process-lifetime edge
  // cases (archival + redeploy) that a cheap re-read absorbs.
  private registrars = new Map<string, { value: string; at: number }>();
  private static REGISTRAR_TTL_MS = 30_000;

  constructor(opts: OwnerOptions) {
    this.maxNetworkFeeStroops = opts?.maxNetworkFeeStroops ?? opts?.maxNativeFeeStroops ?? 50_000_000n;
    const nativeLimit = opts?.maxNativeFeeStroops ?? this.maxNetworkFeeStroops;
    for (const limit of [this.maxNetworkFeeStroops, nativeLimit]) {
      if (typeof limit !== "bigint" || limit <= 0n || limit > 4_294_967_295n)
        throw new OwnerError("maximum network fee must be a bigint between 1 and 4294967295 stroops");
    }
    this.maxNativeFeeStroops = nativeLimit < this.maxNetworkFeeStroops ? nativeLimit : this.maxNetworkFeeStroops;
    if (!opts?.signer) throw new OwnerError("OwnerOptions.signer is required");
    const d = DEPLOYMENTS[opts.network ?? "testnet"];
    if (!d) throw new OwnerError(`unknown network "${opts.network}"`);
    const rpcUrl = opts.rpcUrl ?? d.rpcUrl;
    this.server = new rpc.Server(rpcUrl, { allowHttp: opts.allowHttp ?? false });
    this.passphrase = opts.passphrase ?? d.passphrase;
    this.registryId = opts.registryId ?? d.registryId;
    this.signer = opts.signer;
    const t = opts.timeoutSecs ?? 60;
    if (!Number.isInteger(t) || t < 1 || t > 300) {
      throw new OwnerError(
        `timeoutSecs must be an integer between 1 and 300 (got ${t}) — 0/unbounded would leave transactions valid forever while confirmation polling gives up`,
      );
    }
    this.timeoutSecs = t;
    this.fee = opts.fee ?? BASE_FEE;
    if (!/^[1-9][0-9]*$/.test(this.fee) || BigInt(this.fee) > 4_294_967_295n)
      throw new OwnerError("base network fee must be canonical decimal stroops between 1 and 4294967295");
  }

  // ---- discovery -----------------------------------------------------------

  /** The namespace's on-chain attested Registrar id. Cached per instance. */
  private nativeConfirmed<T>(result: {hash:string;value:unknown}, decode:(raw:unknown)=>T): T {
    try { return decode(result.value); } catch(error) { throw new NativeClaimError(`transaction confirmed but its result could not be verified: ${String(error)}`, "pending", result.hash); }
  }
  private nativeContext(): NativeContext {
    return { registryId: this.registryId, passphrase: this.passphrase, server: this.server, signer: this.signer, fee: this.fee, timeoutSecs: this.timeoutSecs, maxFeeStroops: this.maxNativeFeeStroops,
      read: (id, method, args) => this.read(id, method, args), serialize: work => this.serialize(work) };
  }

  /** Read the original frozen-source receipt after a fully sealed migration. Never submits. */
  recoverHistoricalClaim(intent: ClaimIntent, options: HistoricalRecoveryOptions) {
    return recoverFrozenClaim({ registryId: this.registryId, passphrase: this.passphrase, server: this.server,
      readWithLedger: (id, method, args) => this.readWithLedger(id, method, args) }, intent, options);
  }

  /** Native successor capability. A failed RPC read never means open or legacy. */
  nativeClaimCapability(namespace: string): Promise<NativeCapability> { return nativeCapability(this.nativeContext(), normalizeLabel(namespace)); }
  async claimPolicy(namespace: string): Promise<ClaimConfig | null> {
    const cap = await requireNative(this.nativeContext(), normalizeLabel(namespace));
    const raw = await this.read(cap.registrar, "claim_config", []);
    return raw === null ? null : claimConfigFromNative(raw);
  }
  async nativeClaimFeeToken(namespace: string): Promise<string> {
    const cap = await requireNative(this.nativeContext(), normalizeLabel(namespace));
    return nativeAddress(await this.read(cap.registrar, "native_fee_token", []), "contract", "native XLM token");
  }
  private async nativeOwnerWrite(namespace: string, method: string, args: xdr.ScVal[], options: NativeWriteOptions = {}) {
    return this.serialize(async () => {
      const context = this.nativeContext();
      const cap = await requireNative(context, normalizeLabel(namespace));
      const source = nativeAddress(await this.signer.publicKey(), "account", "owner transaction source");
      if (cap.owner !== source) throw new NativeClaimError("the current namespace owner must authorize this change", "authorization");
      return sendNative(context, { source, contract: cap.registrar, method, args, sourceInvocation: { contract: cap.registrar, method, args }, maxFeeStroops: context.maxFeeStroops }, options);
    });
  }
  async configureClaims(namespace: string, settings: ClaimSettings, options: NativeWriteOptions = {}): Promise<Submitted & { config: ClaimConfig }> {
    const encoded = claimSettingsToScVal(settings);
    const cap = await requireNative(this.nativeContext(), normalizeLabel(namespace));
    const token = nativeAddress(await this.read(cap.registrar, "native_fee_token", []), "contract", "native fee token");
    if (settings.feeToken !== token) throw new NativeClaimError("username fee must use this network's canonical XLM token");
    if (settings.admission.type === "approval" && settings.admission.account === cap.owner) throw new NativeClaimError("eligibility account must be separate from namespace owner");
    const result = await this.nativeOwnerWrite(namespace, "configure_claims", [encoded], options);
    return { hash: result.hash, ledger: result.ledger, config: this.nativeConfirmed(result, claimConfigFromNative) };
  }
  async setClaimsEnabled(namespace: string, enabled: boolean, options: NativeWriteOptions = {}): Promise<Submitted & { config: ClaimConfig }> {
    const result = await this.nativeOwnerWrite(namespace, "set_claim_enabled", [nativeSc.bool(nativeBool(enabled,"claim enabled"))], options);
    return { hash: result.hash, ledger: result.ledger, config: this.nativeConfirmed(result, claimConfigFromNative) };
  }
  pauseClaims(namespace: string, options: NativeWriteOptions = {}) { return this.setClaimsEnabled(namespace, false, options); }
  private async updateReservations(namespace: string, labels: readonly string[], reserved: boolean, options: NativeWriteOptions) {
    if (!Array.isArray(labels) || labels.length < 1 || labels.length > 23) throw new NativeClaimError("reservation batches must contain 1–23 labels");
    const normalized = labels.map(normalizeLabel);
    if (new Set(normalized).size !== normalized.length) throw new NativeClaimError("duplicate reservation label");
    const result = await this.nativeOwnerWrite(namespace, "set_reserved", [xdr.ScVal.scvVec(normalized.map(claimLabelToScVal)), nativeSc.bool(reserved)], options);
    if (typeof result.value !== "number" || result.value !== normalized.length) throw new NativeClaimError("confirmed reservation result differs from batch; inspect the transaction before retrying", "pending", result.hash);
    return { hash: result.hash, ledger: result.ledger, updated: result.value };
  }
  reserveNames(namespace: string, labels: readonly string[], options: NativeWriteOptions = {}) { return this.updateReservations(namespace, labels, true, options); }
  releaseReservations(namespace: string, labels: readonly string[], options: NativeWriteOptions = {}) { return this.updateReservations(namespace, labels, false, options); }
  async isReserved(namespace: string, label: string): Promise<boolean> {
    const cap = await requireNative(this.nativeContext(), normalizeLabel(namespace));
    return nativeBool(await this.read(cap.registrar,"is_reserved",[claimLabelToScVal(normalizeLabel(label))]),"reservation");
  }
  /** Privileged reserved assignment publishes the holder's default route; no custom destination is implied. */
  async assignReserved(namespace: string, label: string, holder: string, options: NativeWriteOptions = {}): Promise<IssueResult> {
    const result = await this.nativeOwnerWrite(namespace,"issue_reserved",[claimLabelToScVal(normalizeLabel(label)),nativeSc.address(nativeAddress(holder,"identity","reserved holder"))],options);
    return { hash: result.hash, ledger: result.ledger, node: this.nativeConfirmed(result, raw => nativeHex(nativeBytes32(raw,"issued name node"))) };
  }
  async nativeClaimUsage(namespace: string, holder: string): Promise<ClaimUsage> {
    const cap = await requireNative(this.nativeContext(),normalizeLabel(namespace));
    return claimUsageFromNative(await this.read(cap.registrar,"claim_usage",[nativeSc.address(nativeAddress(holder,"identity","holder"))]));
  }
  async nativeApprovalUsage(namespace: string): Promise<ApprovalUsage> {
    const cap = await requireNative(this.nativeContext(),normalizeLabel(namespace));
    return approvalUsageFromNative(await this.read(cap.registrar,"approval_usage",[]));
  }

  async registrarOf(namespace: string): Promise<string> {
    namespace = normalizeLabel(namespace);
    const hit = this.registrars.get(namespace);
    if (hit && Date.now() - hit.at < SoranOwner.REGISTRAR_TTL_MS) return hit.value;
    const id = (await this.read(this.registryId, "registrar_of", [
      nodeArg(namehash(namespace)),
    ])) as string | null;
    if (!id) {
      throw new OwnerError(
        `namespace "${namespace}" has no attested Registrar yet — deploy one (console, or Registry.deploy_registrar) before issuing`,
        this.registryId,
        "registrar_of",
      );
    }
    this.registrars.set(namespace, { value: id, at: Date.now() });
    return id;
  }

  /** The namespace's current owner on the Registry, or null if unallocated. */
  async namespaceOwner(namespace: string): Promise<string | null> {
    namespace = normalizeLabel(namespace);
    return (await this.read(this.registryId, "owner_of", [
      nodeArg(namehash(namespace)),
    ])) as string | null;
  }

  /**
   * Throw unless the configured signer is the namespace's current owner.
   * Cheap preflight for scripts — write operations are owner-checked on chain
   * regardless, so skipping this only trades a clearer error for one read.
   */
  async assertOwner(namespace: string): Promise<void> {
    const [owner, pub] = await Promise.all([
      this.namespaceOwner(namespace),
      Promise.resolve(this.signer.publicKey()),
    ]);
    if (owner !== pub) {
      throw new OwnerError(
        owner
          ? `signer ${pub} is not the owner of "${namespace}" (owner is ${owner})`
          : `namespace "${namespace}" is not allocated on this Registry`,
      );
    }
  }

  // ---- registrar: issuance -------------------------------------------------

  /** Issue `label.namespace` to `holder`. Owner-signed; term set by policy. */
  async issue(namespace: string, label: string, holder: string): Promise<IssueResult> {
    label = normalizeLabel(label);
    const registrarId = await this.registrarOf(namespace);
    const r = await this.invoke(
      registrarId,
      "issue",
      [labelArg(label), addrArg(holder)],
      REGISTRAR_ERRORS,
    );
    return { hash: r.hash, ledger: r.ledger, node: toHex(r.returnValue) };
  }

  /**
   * Issue up to {@link MAX_BATCH} names in ONE owner-signed transaction.
   *
   * The contract skips (rather than aborts on) labels that are already held,
   * so a batch is safe to re-run after a partial failure. The SDK re-reads
   * every record after inclusion and reports a per-label outcome — always
   * check `outcomes`, not just the count.
   */
  async issueBatch(
    namespace: string,
    entries: ReadonlyArray<{ label: string; holder: string }>,
  ): Promise<IssueBatchResult> {
    if (entries.length === 0) throw new OwnerError("issueBatch: empty batch");
    if (entries.length > MAX_BATCH) {
      throw new OwnerError(
        `issueBatch: ${entries.length} entries exceeds the contract cap of ${MAX_BATCH} per transaction — split the batch`,
      );
    }
    entries = entries.map(e => ({ ...e, label: normalizeLabel(e.label) }));
    const registrarId = await this.registrarOf(namespace);

    const r = await this.invoke(
      registrarId,
      "issue_batch",
      [
        xdr.ScVal.scvVec(entries.map((e) => labelArg(e.label))),
        xdr.ScVal.scvVec(entries.map((e) => addrArg(e.holder))),
      ],
      REGISTRAR_ERRORS,
    );
    const issuedCount = Number(r.returnValue ?? 0);

    // Ground truth: the contract publishes one `issued` event per name it
    // actually issued IN THIS transaction. Matching events to entries needs no
    // clock, no re-read, and cannot be confused by concurrent writers.
    const issuedEvents = decodeIssuedEvents(r.events, registrarId);
    // Empty events with a nonzero contract count means the node's meta was
    // unusable — fall back to re-reads. Zero-issued batches legitimately have
    // zero events, and the events path handles them exactly.
    if (issuedEvents.length > 0 || issuedCount === 0) {
      const unconsumed = [...issuedEvents];
      const outcomes: IssueOutcome[] = entries.map((e) => {
        const at = unconsumed.findIndex((ev) => ev.label === e.label && ev.holder === e.holder);
        if (at >= 0) {
          unconsumed.splice(at, 1);
          return { label: e.label, holder: e.holder, issued: true };
        }
        return { label: e.label, holder: e.holder, issued: false, reason: "skipped" as const };
      });
      // Best-effort reasons: distinguish "someone else holds it" from
      // in-batch skips. Purely informational — never let it fail the call.
      try {
        const post = await this.readRecords(
          registrarId,
          outcomes.filter((o) => !o.issued),
        );
        let j = 0;
        for (const o of outcomes) {
          if (o.issued) continue;
          const rec = post[j++];
          if (rec && rec.holder !== o.holder) o.reason = "taken";
        }
      } catch {
        /* reasons stay "skipped" */
      }
      return {
        hash: r.hash,
        ledger: r.ledger,
        issuedCount,
        outcomes,
        outcomeSource: "events",
        countMatches: outcomes.filter((o) => o.issued).length === issuedCount,
      };
    }

    // Fallback (a node serving no usable meta): infer from post-state reads.
    // Correct unless a concurrent writer touched the same labels; reads that
    // fail leave the entry marked not-issued rather than failing the batch —
    // the transaction itself SUCCEEDED and its result must survive.
    let post: Array<NameState | null> = entries.map(() => null);
    try {
      post = await this.readRecords(registrarId, entries);
    } catch {
      /* keep nulls */
    }
    const seen = new Set<string>();
    const outcomes: IssueOutcome[] = entries.map((e, i) => {
      const after = post[i];
      const firstForLabel = !seen.has(e.label);
      seen.add(e.label);
      const issued = firstForLabel && after !== null && after.holder === e.holder;
      const reason: IssueOutcome["reason"] =
        after !== null && after.holder !== e.holder ? "taken" : "skipped";
      return { label: e.label, holder: e.holder, issued, ...(issued ? {} : { reason }) };
    });
    return {
      hash: r.hash,
      ledger: r.ledger,
      issuedCount,
      outcomes,
      outcomeSource: "reread",
      countMatches: outcomes.filter((o) => o.issued).length === issuedCount,
    };
  }

  // ---- registrar: lifecycle ------------------------------------------------

  /**
   * Take `label.namespace` back from its holder. Only on namespaces whose
   * policy is reclaimable — the contract answers NotReclaimable both when the
   * policy never allowed it and after `make_permanent` removed it forever.
   */
  async reclaim(namespace: string, label: string): Promise<Submitted> {
    label = normalizeLabel(label);
    const registrarId = await this.registrarOf(namespace);
    const r = await this.invoke(registrarId, "reclaim", [labelArg(label)], REGISTRAR_ERRORS);
    return { hash: r.hash, ledger: r.ledger };
  }

  /** Extend a finite-term name. Returns the new expiry (unix seconds). */
  async renew(
    namespace: string,
    label: string,
    extendSecs: number | bigint,
  ): Promise<Submitted & { expiresAt: bigint }> {
    label = normalizeLabel(label);
    const registrarId = await this.registrarOf(namespace);
    const r = await this.invoke(
      registrarId,
      "renew",
      [labelArg(label), nativeToScVal(extendSecs, { type: "u64" })],
      REGISTRAR_ERRORS,
    );
    return { hash: r.hash, ledger: r.ledger, expiresAt: BigInt(r.returnValue as bigint) };
  }

  /** Route future reclaims' custody to a treasury address (or back to you). */
  async setTreasury(namespace: string, newTreasury: string): Promise<Submitted> {
    const registrarId = await this.registrarOf(namespace);
    const r = await this.invoke(
      registrarId,
      "set_treasury",
      [addrArg(newTreasury)],
      REGISTRAR_ERRORS,
    );
    return { hash: r.hash, ledger: r.ledger };
  }

  /**
   * The one-way door. Locks reclaim off and freezes the Registrar's code —
   * every name in the namespace becomes permanently its holder's, and there is
   * NO PATH BACK, for you or anyone. The contract additionally requires that
   * the policy has always issued permanent terms (FiniteTermPolicy otherwise)
   * and that the Registrar/Resolver provenance is clean.
   */
  async makePermanent(
    namespace: string,
    opts: { confirmIrreversible: boolean },
  ): Promise<Submitted> {
    if (opts?.confirmIrreversible !== true) {
      throw new OwnerError(
        "makePermanent is IRREVERSIBLE — pass { confirmIrreversible: true } to proceed",
      );
    }
    const registrarId = await this.registrarOf(namespace);
    const r = await this.invoke(registrarId, "make_permanent", [], REGISTRAR_ERRORS);
    return { hash: r.hash, ledger: r.ledger };
  }

  // ---- registry: namespace transfer + resolver -----------------------------

  /**
   * Offer the whole namespace to `to`. Nothing moves until the recipient
   * accepts; re-proposing replaces the pending offer, cancel withdraws it.
   */
  async proposeNamespaceTransfer(namespace: string, to: string): Promise<Submitted> {
    namespace = normalizeLabel(namespace);
    const r = await this.invoke(
      this.registryId,
      "propose_transfer",
      [nodeArg(namehash(namespace)), addrArg(to)],
      REGISTRY_ERRORS,
    );
    return { hash: r.hash, ledger: r.ledger };
  }

  /** Accept a namespace offered to you. Signer must be the PROPOSED owner. */
  async acceptNamespaceTransfer(namespace: string): Promise<Submitted> {
    namespace = normalizeLabel(namespace);
    const r = await this.invoke(
      this.registryId,
      "accept_transfer",
      [nodeArg(namehash(namespace))],
      REGISTRY_ERRORS,
    );
    return { hash: r.hash, ledger: r.ledger };
  }

  /** Withdraw a pending namespace transfer. Current owner only. */
  async cancelNamespaceTransfer(namespace: string): Promise<Submitted> {
    namespace = normalizeLabel(namespace);
    const r = await this.invoke(
      this.registryId,
      "cancel_transfer",
      [nodeArg(namehash(namespace))],
      REGISTRY_ERRORS,
    );
    return { hash: r.hash, ledger: r.ledger };
  }

  /**
   * Point the namespace at a resolver contract, or clear it with null.
   * Refused (ResolverFrozen) once the namespace is permanent.
   */
  async setResolver(namespace: string, resolver: string | null): Promise<Submitted> {
    namespace = normalizeLabel(namespace);
    const r = await this.invoke(
      this.registryId,
      "set_resolver",
      [nodeArg(namehash(namespace)), resolver === null ? xdr.ScVal.scvVoid() : addrArg(resolver)],
      REGISTRY_ERRORS,
    );
    return { hash: r.hash, ledger: r.ledger };
  }

  // ---- reads that support write flows --------------------------------------

  /** The namespace's immutable issuance policy. */
  async policy(namespace: string): Promise<NamespacePolicy> {
    const registrarId = await this.registrarOf(namespace);
    const p = (await this.read(registrarId, "policy", [])) as {
      reclaimable: boolean;
      transferable: boolean;
      tradeable: boolean;
      default_term_secs: bigint;
      trade_fee_bps: number;
    };
    return {
      reclaimable: p.reclaimable,
      transferable: p.transferable,
      tradeable: p.tradeable,
      defaultTermSecs: BigInt(p.default_term_secs),
      tradeFeeBps: Number(p.trade_fee_bps),
    };
  }

  /** Has the namespace passed the one-way door? */
  async isPermanent(namespace: string): Promise<boolean> {
    const registrarId = await this.registrarOf(namespace);
    return (await this.read(registrarId, "is_permanent", [])) as boolean;
  }

  /** Current state of `label.namespace`, or null if never issued. */
  async nameState(namespace: string, label: string): Promise<NameState | null> {
    label = normalizeLabel(label);
    const registrarId = await this.registrarOf(namespace);
    return this.readRecord(registrarId, label);
  }

  /** The pending namespace transfer on the Registry, or null. */
  async pendingNamespaceTransfer(namespace: string): Promise<unknown | null> {
    namespace = normalizeLabel(namespace);
    return this.read(this.registryId, "pending_transfer", [nodeArg(namehash(namespace))]);
  }

  // ---- internals -----------------------------------------------------------

  private async readRecord(registrarId: string, label: string): Promise<NameState | null> {
    const rec = (await this.read(registrarId, "record_of", [labelArg(label)])) as {
      holder: string;
      address: string;
      expires_at: bigint;
      generation: bigint;
    } | null;
    if (!rec) return null;
    return {
      holder: String(rec.holder),
      address: String(rec.address),
      expiresAt: BigInt(rec.expires_at),
      generation: BigInt(rec.generation),
    };
  }

  private readRecords(
    registrarId: string,
    entries: ReadonlyArray<{ label: string }>,
  ): Promise<Array<NameState | null>> {
    return Promise.all(entries.map((e) => this.readRecord(registrarId, e.label)));
  }

  /** Simulation-only contract read — no signature, no fee, no state change. */
  private async read(contractId: string, fn: string, args: xdr.ScVal[]): Promise<unknown> {
    return (await this.simulateRead(contractId, fn, args)).value;
  }

  private async readWithLedger(contractId: string, fn: string, args: xdr.ScVal[]): Promise<HistoricalRead> {
    const result = await this.simulateRead(contractId, fn, args);
    return { value: result.value, ledger: historicalReadLedger(result.ledger) };
  }

  private async simulateRead(contractId: string, fn: string, args: xdr.ScVal[]): Promise<{ value: unknown; ledger: unknown }> {
    const tx = new TransactionBuilder(new Account(SIM_SOURCE, "0"), {
      fee: BASE_FEE,
      networkPassphrase: this.passphrase,
    })
      .addOperation(new Contract(contractId).call(fn, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw typedError(contractId, fn, sim.error, {});
    }
    // An archived entry is NOT absence: reads cannot restore (no signer),
    // so surface the state honestly instead of reporting "does not exist".
    if (rpc.Api.isSimulationRestore(sim)) {
      throw new OwnerError(
        `${fn}: the on-chain entry is archived (rent lapsed) — any write operation restores it automatically, or restore/touch it first`,
        contractId,
        fn,
      );
    }
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) throw new OwnerError(`${fn}: missing simulation return value`, contractId, fn);
    const v = scValToNative(sim.result.retval);
    return { value: v === undefined ? null : v, ledger: sim.latestLedger };
  }

  private assertNetworkFee(fee: string, fn: string): void {
    if (!/^[1-9][0-9]*$/.test(fee) || BigInt(fee) > this.maxNetworkFeeStroops)
      throw new OwnerError(`${fn}: network fee ${fee} stroops exceeds the configured maximum ${this.maxNetworkFeeStroops} stroops`, null, fn);
  }

  private async signEnvelope(xdrBase64: string): Promise<string> {
    const signed = await this.signer.signTransaction(xdrBase64, {
      networkPassphrase: this.passphrase,
    });
    return typeof signed === "string" ? signed : signed.signedTxXdr;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The signer's live account (sequence source) — with an actionable error
   *  when the account has never been funded on this network. */
  private async sourceAccount(pub: string, fn: string): Promise<Account> {
    try {
      return await this.server.getAccount(pub);
    } catch {
      throw new OwnerError(
        `${fn}: signer account ${pub} does not exist on this network — fund it (testnet: friendbot) before writing`,
        null,
        fn,
      );
    }
  }

  private invoke(
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
    errNames: Record<number, string>,
  ): Promise<Invoked> {
    return this.serialize(async () => {
      try {
        return await this.attempt(contractId, fn, args, errNames);
      } catch (e) {
        // A stale sequence (another process moved the account) is safe to
        // retry once with a fresh sequence — nothing was included.
        if (!(e instanceof OwnerError && e.txHash) && /txBadSeq|bad_seq/i.test(String(e))) {
          return await this.attempt(contractId, fn, args, errNames);
        }
        throw e;
      }
    });
  }

  /**
   * Simulation RECORDS auth requirements without verifying them: a call the
   * signer is not authorized for still simulates cleanly, then fails on
   * chain — after spending the fee. Refuse before signing when the recorded
   * auth demands an address the envelope signature cannot satisfy.
   */
  private assertSatisfiableAuth(
    prepared: { operations: unknown[] },
    pub: string,
    contractId: string,
    fn: string,
  ): void {
    const op = prepared.operations[0] as { auth?: xdr.SorobanAuthorizationEntry[] };
    for (const entry of op?.auth ?? []) {
      const cred = entry.credentials;
      if (cred.type !== "sorobanCredentialsAddress") continue;
      let required: string;
      try {
        required = Address.fromScAddress(cred.address.address).toString();
      } catch {
        continue; // unreadable credential — let the chain be the judge
      }
      throw new OwnerError(
        required === pub
          ? `${fn}: the network requires a separate auth-entry signature from ${pub}, which this SDK does not produce yet — make the authorized account the transaction source`
          : `${fn}: this operation must be authorized by ${required}, but the signer is ${pub} — use that account's signer`,
        contractId,
        fn,
      );
    }
  }

  private async attempt(
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
    errNames: Record<number, string>,
  ): Promise<Invoked> {
    const pub = await this.signer.publicKey();
    const contract = new Contract(contractId);
    const build = (source: Account) =>
      new TransactionBuilder(source, { fee: this.fee, networkPassphrase: this.passphrase })
        .addOperation(contract.call(fn, ...args))
        .setTimeout(this.timeoutSecs)
        .build();

    let tx = build(await this.sourceAccount(pub, fn));
    // (SDK17/P28) useUpgradedAuth=false keeps legacy V1 SorobanCredentials rather
    // than CAP-71 address-bound V2 — valid against P27 (pre-vote) and P28 (post),
    // and keeps assertSatisfiableAuth's `sorobanCredentialsAddress` check exact.
    let sim = await this.server.simulateTransaction(tx, undefined, undefined, false);
    // Archived entries (e.g. a dormant Registrar's instance) need restoring
    // before the call can run. Each restore is its own owner-signed
    // transaction; two rounds cover an entry archiving mid-flow, and beyond
    // that something is wrong enough to surface instead of looping.
    for (let round = 0; rpc.Api.isSimulationRestore(sim); round++) {
      if (round >= 2) {
        throw new OwnerError(
          `${fn}: entries still need restoring after ${round} restore transactions — retry later`,
          contractId,
          fn,
        );
      }
      await this.restore(sim, pub);
      tx = build(await this.sourceAccount(pub, fn));
      sim = await this.server.simulateTransaction(tx, undefined, undefined, false);
    }
    if (rpc.Api.isSimulationError(sim)) {
      throw typedError(contractId, fn, sim.error, errNames);
    }
    const prepared = rpc.assembleTransaction(tx, sim).build();
    this.assertNetworkFee(prepared.fee, fn);
    this.assertSatisfiableAuth(prepared, pub, contractId, fn);
    // The hash is fixed before signatures — compute it now so every failure
    // past this point can carry it (the "re-check before retrying" contract).
    const txHash = toHex(prepared.hash()); // (SDK17) hash() is Uint8Array
    const signed = await this.signEnvelope(prepared.toXDR());
    const envelope = TransactionBuilder.fromXDR(signed, this.passphrase);
    if (toHex(envelope.hash()) !== txHash) throw new OwnerError("signer changed the reviewed transaction body", contractId, fn);
    let sent: Awaited<ReturnType<rpc.Server["sendTransaction"]>>;
    try {
      sent = await this.server.sendTransaction(envelope);
    } catch (e) {
      throw new OwnerError(
        `${fn}: submit failed after signing (${String(e)}) — transaction ${txHash} may or may not have reached the network; check the hash before retrying`,
        contractId,
        fn,
        null,
        null,
        txHash,
      );
    }
    if (sent.status === "ERROR") {
      throw new OwnerError(
        `${fn}: submit rejected: ${JSON.stringify(sent.errorResult ?? sent.status)}`,
        contractId,
        fn,
        null,
        null,
        txHash,
      );
    }
    if (sent.status === "TRY_AGAIN_LATER") {
      throw new OwnerError(
        `${fn}: the network did not accept the transaction (TRY_AGAIN_LATER) — it was NOT queued; safe to retry shortly`,
        contractId,
        fn,
        null,
        null,
        txHash,
      );
    }
    // PENDING queues it; DUPLICATE means this exact transaction is already
    // in flight — either way, confirmation is the same wait.
    try {
      const { ledger, returnValue, events } = await this.confirm(txHash, contractId, fn, errNames);
      return { hash: txHash, ledger, returnValue, events };
    } catch (e) {
      if (e instanceof OwnerError) throw e;
      throw new OwnerError(
        `${fn}: confirmation interrupted (${String(e)}) — transaction ${txHash} may still be included; check the hash before retrying`,
        contractId,
        fn,
        null,
        null,
        txHash,
      );
    }
  }

  private async restore(
    sim: rpc.Api.SimulateTransactionRestoreResponse,
    pub: string,
  ): Promise<void> {
    const pre = sim.restorePreamble;
    if (!/^(0|[1-9][0-9]*)$/.test(pre.minResourceFee))
      throw new OwnerError("invalid restoration resource fee", null, "restore_footprint");
    const quoted = BigInt(pre.minResourceFee);
    const data = pre.transactionData.build();
    const encoded = BigInt(data.resourceFee.toString());
    if (encoded < 0n) throw new OwnerError("invalid encoded restoration resource fee", null, "restore_footprint");
    const resourceFee = quoted > encoded ? quoted : encoded;
    this.assertNetworkFee((BigInt(this.fee) + resourceFee).toString(), "restore_footprint");
    const tx = new TransactionBuilder(await this.sourceAccount(pub, "restore_footprint"), {
      // SDK 17 adds Soroban resourceFee itself; supply the base only once.
      fee: this.fee,
      networkPassphrase: this.passphrase,
    })
      .setSorobanData(new SorobanDataBuilder(data).setResourceFee(resourceFee.toString()).build())
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(this.timeoutSecs)
      .build();
    this.assertNetworkFee(tx.fee, "restore_footprint");
    const txHash = toHex(tx.hash());
    const signed = await this.signEnvelope(tx.toXDR());
    const envelope = TransactionBuilder.fromXDR(signed, this.passphrase);
    if (toHex(envelope.hash()) !== txHash) throw new OwnerError("signer changed the reviewed restoration body", null, "restore_footprint");
    let sent: Awaited<ReturnType<rpc.Server["sendTransaction"]>>;
    try { sent = await this.server.sendTransaction(envelope); }
    catch (error) {
      throw new OwnerError(`restoration submission is uncertain (${String(error)}); check ${txHash} before retrying`, null, "restore_footprint", null, null, txHash);
    }
    if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
      throw new OwnerError(
        `restore_footprint: submit rejected: ${JSON.stringify(sent.errorResult ?? sent.status)}`,
        null,
        "restore_footprint",
        null,
        null,
        txHash,
      );
    }
    try { await this.confirm(txHash, "", "restore_footprint", {}); }
    catch (error) {
      if (error instanceof OwnerError) throw error;
      throw new OwnerError(`restoration confirmation is uncertain (${String(error)}); check ${txHash} before retrying`, null, "restore_footprint", null, null, txHash);
    }
  }

  // Poll past the tx time bound (timeoutSecs) so we never declare failure
  // while the transaction is still valid and pending inclusion.
  private async confirm(
    hash: string,
    contractId: string,
    fn: string,
    errNames: Record<number, string>,
  ): Promise<{ ledger: number; returnValue: unknown; events: xdr.ContractEvent[] }> {
    const tries = this.timeoutSecs + 5;
    let got = await this.server.getTransaction(hash);
    for (let i = 0; i < tries && got.status === "NOT_FOUND"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      got = await this.server.getTransaction(hash);
    }
    if (got.status === "NOT_FOUND") {
      throw new OwnerError(
        `${fn}: transaction ${hash} not confirmed within ${tries}s — it may still be included; check the hash before retrying`,
        contractId || null,
        fn,
        null,
        null,
        hash,
      );
    }
    if (got.status !== "SUCCESS") {
      throw this.decodeFailure(got, contractId, fn, errNames, hash);
    }
    let returnValue: unknown = null;
    try {
      if (got.returnValue) returnValue = scValToNative(got.returnValue);
    } catch {
      /* void return */
    }
    return { ledger: got.ledger, returnValue, events: extractContractEvents(got.resultMetaXdr) };
  }

  /**
   * A transaction that simulated cleanly but FAILED at inclusion (a race: the
   * state changed between simulation and apply). The contract's typed error
   * travels in the diagnostic events, not the result XDR — recover it so the
   * race cases report the same typed codes the simulation path does.
   */
  private decodeFailure(
    got: { status: string; resultXdr?: xdr.TransactionResult; resultMetaXdr?: xdr.TransactionMeta; diagnosticEventsXdr?: xdr.DiagnosticEvent[] },
    contractId: string,
    fn: string,
    errNames: Record<number, string>,
    hash: string,
  ): OwnerError {
    let code: number | null = null;
    try {
      const meta = got.resultMetaXdr;
      const diags: xdr.DiagnosticEvent[] = got.diagnosticEventsXdr ?? (
        meta && meta.type === "v3"
          ? (meta.value.sorobanMeta?.diagnosticEvents ?? [])
          : meta && meta.type === "v4"
            ? meta.value.diagnosticEvents
            : []
      );
      outer: for (const d of diags) {
        const body = d.event.body.value;
        for (const v of [...body.topics, body.data]) {
          if (v.type === "scvError") {
            const err = v.error;
            if (err.type === "sceContract") {
              code = err.contractCode;
              break outer;
            }
          }
        }
      }
    } catch {
      /* diagnostics unavailable — fall through to the result code */
    }
    let resultCode = `tx status ${got.status}`;
    try {
      resultCode = got.resultXdr?.result.type ?? resultCode;
    } catch {
      /* keep the plain status */
    }
    if (code !== null) {
      const codeName = errNames[code] ?? null;
      return new OwnerError(
        `${fn} failed at inclusion: contract error #${code}${codeName ? ` (${codeName})` : ""} (${resultCode}) — the state changed between simulation and inclusion`,
        contractId,
        fn,
        code,
        codeName,
        hash,
      );
    }
    return new OwnerError(`${fn} failed at inclusion (${resultCode})`, contractId, fn, null, null, hash);
  }
}

export * from "./funding-types.js";
export { FundingReader, type FundingOptions } from "./funding-reader.js";
export { SoranFunding } from "./funding-owner.js";
export { SoranSponsorship, sponsorPlan, validateSponsorTransaction, type SponsorRequest, type SponsorPlan } from "./funding-user.js";
export { FundingServiceClient } from "./funding-service.js";

export { TestnetSponsorHistory, type SponsorHistory, type FundingReceipt } from "./funding-history.js";
