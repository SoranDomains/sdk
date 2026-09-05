/**
 * @sorandomains/holder — the write-side SDK for people who HOLD a Soran name.
 *
 * The third persona: `@sorandomains/lookup` reads names, `@sorandomains/owner`
 * runs a namespace — this package manages YOUR name with YOUR key:
 *
 *   import { SoranHolder, keypairSigner } from "@sorandomains/holder";
 *
 *   const me = new SoranHolder({ signer: keypairSigner(process.env.MY_SECRET!) });
 *   await me.setReverse("alice.nova");        // addresses show as alice.nova
 *   await me.setPrimary("alice.nova");        // ...across every namespace
 *   await me.setProfile("alice.nova", { url: "https://alice.dev", org: "Alice Co" });
 *
 * TRUST MODEL. Every operation is a transaction your own key signs against
 * the contracts over any Soroban RPC — no Soran account, no hosted API in
 * the path. All powers here are HOLDER-authorized on chain: the Resolver
 * checks you hold the name (generation-gated) before accepting records, the
 * reverse and primary claims are authorized by the ADDRESS itself, and name
 * transfers move only when the recipient accepts. Namespace-owner powers
 * (issue, reclaim, renew, permanence) live in `@sorandomains/owner` and this
 * package deliberately cannot exercise them.
 *
 * SIGNING. Same `TxSigner` contract as the owner SDK: `keypairSigner(secret)`
 * for scripts, or wrap a browser wallet:
 *
 *   { publicKey: () => walletAddress, signTransaction: (x, o) => kit.signTransaction(x, o) }
 *
 * Each call is simulated first (typed contract errors before any fee), the
 * envelope is handed to your signer, and unsatisfiable auth is refused
 * before signing. Operations on one instance are serialized so concurrent
 * calls cannot race the account sequence number.
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
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { paymentFromNative, paymentMemoToScVal, validatePaymentDestination, type PaymentDestination } from "./payment.js";
export { PAYMENT_RECORD_KEY, encodePaymentRecord, parsePaymentRecord, validatePaymentDestination, type PaymentMemo, type PaymentDestination } from "./payment.js";

type Invoked = { hash: string; ledger: number; returnValue: unknown };

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

/** Known public deployments. Pass explicit options for anything else. */
export const DEPLOYMENTS = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: Networks.TESTNET as string,
    registryId: "CBSORANXTUFKBZK74AAM2ZM5OX2V7PIXUADM3HGP6WU3IDN7M3YEEDLU",
    primaryId: "CBSORANQVSWYBYGKRZ7RAUGOXDAXMXDXQWJSE42DQZOL4BK75BIEBUQK",
  },
} as const;

// ---------------------------------------------------------------------------
// Signers
// ---------------------------------------------------------------------------

/** Same shape as the owner SDK's signer — wallet-kit compatible. */
export type TxSigner = {
  publicKey(): string | Promise<string>;
  signTransaction(
    xdrBase64: string,
    opts: { networkPassphrase: string },
  ): Promise<string | { signedTxXdr: string }>;
};

/** A TxSigner over a raw secret key — for scripts and backends. */
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
};

const RESOLVER_ERRORS: Record<number, string> = {
  1: "AlreadyInitialized",
  2: "NotInitialized",
  3: "NotHolder",
  4: "NameInactive",
  5: "ForwardMismatch",
  6: "Frozen",
  7: "InvalidAuthority",
  8: "ProvenanceMismatch",
  9: "ProvenanceAlreadyBound",
  10: "InvalidRegistry",
  11: "UpgradeTaintFailed",
  12: "MalformedName",
  13: "PaymentNotConfigured",
  14: "MalformedPayment",
  15: "DestinationMismatch",
  16: "UnsupportedMemoDestination",
  17: "InvalidMemo",
  18: "UsePaymentMethod",
  19: "PaymentContextMismatch",
  20: "PaymentUnavailable",
};

const PRIMARY_ERRORS: Record<number, string> = {
  1: "MalformedName",
  2: "NoResolver",
  3: "NotDisplayName",
  4: "ResolverUnavailable",
  5: "InvalidRegistry",
};

/**
 * A failed holder operation. `code`/`codeName` carry the contract's typed
 * error (e.g. 3/"NotHolder" from the Resolver, 5/"ForwardMismatch" on a
 * reverse claim for a name that doesn't point back at you); null for
 * transport failures. `txHash` is set when a transaction reached the network
 * — always re-check a hash before retrying.
 */
export class HolderError extends Error {
  constructor(
    message: string,
    readonly contractId: string | null = null,
    readonly fn: string | null = null,
    readonly code: number | null = null,
    readonly codeName: string | null = null,
    readonly txHash: string | null = null,
  ) {
    super(message);
    this.name = "HolderError";
  }
}

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
): HolderError {
  const code = parseContractCode(raw);
  const codeName = code !== null ? (names[code] ?? null) : null;
  const label = codeName ? ` (${codeName})` : "";
  return new HolderError(
    `${fn} failed${code !== null ? `: contract error #${code}${label}` : `: ${raw}`}`,
    contractId,
    fn,
    code,
    codeName,
    txHash,
  );
}

// ---------------------------------------------------------------------------
// Hashing + arguments (mirror the on-chain scheme exactly)
// ---------------------------------------------------------------------------

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// Soroban Symbol constraint — text-record keys live in this alphabet.
const SYMBOL_RE = /^[A-Za-z0-9_]{1,32}$/;

export function normalizeLabel(value: string): string {
  if (typeof value !== "string" || /[^\x00-\x7f]/.test(value)) throw new HolderError("label must contain ASCII characters only");
  const normalized = value.toLowerCase();
  assertLabel(normalized);
  return normalized;
}

function assertLabel(label: string): void {
  if (label.length < 1 || label.length > 63 || !LABEL_RE.test(label)) {
    throw new HolderError(
      `invalid label "${label}" — 1-63 chars of a-z, 0-9, and non-edge hyphens`,
    );
  }
}

/** Split and validate `label.namespace`, lowercasing first. Throws
 *  HolderError — @sorandomains/lookup exports the same helper throwing its
 *  own SoranError; import from the package whose errors you handle. */
export function parseName(name: string): { label: string; namespace: string } {
  if (typeof name !== "string" || /[^\x00-\x7f]/.test(name)) throw new HolderError("name must contain ASCII characters only");
  const parts = name.toLowerCase().split(".");
  if (parts.length !== 2) throw new HolderError(`expected "label.namespace", got "${name}"`);
  const [label, namespace] = parts;
  assertLabel(label);
  assertLabel(namespace);
  return { label, namespace };
}

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
/** Browser-safe hex (SDK17: hash()/XDR bytes are Uint8Array, whose toString()
 *  ignores a radix — and this package forbids a bare `Buffer` in the bundle). */
function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function namehash(namespace: string): Uint8Array {
  const labelHash = new Uint8Array(hash(utf8(namespace) as Buffer));
  return new Uint8Array(hash(concatBytes(new Uint8Array(32), labelHash) as Buffer));
}
function nameNode(label: string, namespace: string): Uint8Array {
  const labelHash = new Uint8Array(hash(utf8(label) as Buffer));
  return new Uint8Array(hash(concatBytes(namehash(namespace), labelHash) as Buffer));
}

const labelArg = (label: string) => nativeToScVal(utf8(label), { type: "bytes" });
const addrArg = (address: string) => nativeToScVal(address, { type: "address" });
const bytesArg = (b: Uint8Array) => nativeToScVal(b, { type: "bytes" });

const SIM_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

// ---------------------------------------------------------------------------
// Results + options
// ---------------------------------------------------------------------------

export type Submitted = { hash: string; ledger: number };

/** The standard profile keys shared with @sorandomains/lookup's profile(). */
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

export type HolderOptions = {
  /** Signs every transaction: the name HOLDER's account (or, for
   *  `acceptNameTransfer`, the proposed new holder's). */
  signer: TxSigner;
  /** Named deployment preset; defaults to "testnet". Override the individual
   *  fields below as a SET for custom deployments. */
  network?: keyof typeof DEPLOYMENTS;
  rpcUrl?: string;
  passphrase?: string;
  registryId?: string;
  /** PrimaryName contract; the preset supplies one. `null` disables
   *  setPrimary/clearPrimary. */
  primaryId?: string | null;
  allowHttp?: boolean;
  /** Transaction time bound, seconds (integer 1-300, default 60). */
  timeoutSecs?: number;
  /** Base fee bid, stroops (default 100; resource fees are added on top). */
  fee?: string;
};

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class SoranHolder {
  private server: rpc.Server;
  private passphrase: string;
  private registryId: string;
  private primaryId: string | null;
  private signer: TxSigner;
  private timeoutSecs: number;
  private fee: string;
  private queue: Promise<unknown> = Promise.resolve();
  private registrars = new Map<string, { value: string; at: number }>();
  private resolvers = new Map<string, { value: string; at: number }>();
  private static POINTER_TTL_MS = 30_000;

  constructor(opts: HolderOptions) {
    if (!opts?.signer) throw new HolderError("HolderOptions.signer is required");
    const d = DEPLOYMENTS[opts.network ?? "testnet"];
    if (!d) throw new HolderError(`unknown network "${opts.network}"`);
    this.server = new rpc.Server(opts.rpcUrl ?? d.rpcUrl, { allowHttp: opts.allowHttp ?? false });
    this.passphrase = opts.passphrase ?? d.passphrase;
    this.registryId = opts.registryId ?? d.registryId;
    // The preset PrimaryName is anchored to the preset Registry — never let
    // it leak onto a custom registryId, where it could only mis-verify.
    const presetPrimary = (opts.registryId && opts.registryId !== d.registryId) || (opts.passphrase && opts.passphrase !== d.passphrase) ? null : d.primaryId;
    this.primaryId = opts.primaryId === null ? null : (opts.primaryId ?? presetPrimary ?? null);
    this.signer = opts.signer;
    const t = opts.timeoutSecs ?? 60;
    if (!Number.isInteger(t) || t < 1 || t > 300) {
      throw new HolderError(`timeoutSecs must be an integer between 1 and 300 (got ${t})`);
    }
    this.timeoutSecs = t;
    this.fee = opts.fee ?? BASE_FEE;
  }

  // ---- resolution targets --------------------------------------------------

  /** Atomically update the forward address and complete payment instruction.
   * Use memo {type:"none"} to explicitly publish a memo-free destination.
   * The native Resolver updates its own records atomically. This method never
   * retries as separate set_addr/set_text calls. */
  async setPayment(name: string, destination: PaymentDestination): Promise<Submitted> {
    const { label, namespace } = parseName(name);
    let payment: PaymentDestination;
    try { payment = validatePaymentDestination(destination); }
    catch (e) { throw new HolderError(String(e)); }
    const { resolver } = await this.paymentResolverOf(namespace);
    const holder = await this.signer.publicKey();
    const r = await this.invoke(resolver, "set_payment", [
      nativeToScVal(`${label}.${namespace}`, { type: "string" }), addrArg(holder),
      addrArg(payment.address), paymentMemoToScVal(payment.memo),
    ], RESOLVER_ERRORS);
    return { hash: r.hash, ledger: r.ledger };
  }


  /**
   * Re-point where YOUR name pays to on its BUILT-IN path (the Registrar's
   * record — what resolvers fall back to when no explicit record is set).
   * Holder-authorized, live names only; deliberately never blocked by
   * namespace permanence — where your own name resolves is always yours.
   */
  async setAddress(name: string, address: string): Promise<Submitted> {
    const { label, namespace } = parseName(name);
    const registrarId = await this.assertMemoFree(name);
    const r = await this.invoke(
      registrarId,
      "set_address",
      [labelArg(label), addrArg(address)],
      REGISTRAR_ERRORS,
    );
    return { hash: r.hash, ledger: r.ledger };
  }

  /**
   * Set YOUR name's explicit record on the namespace resolver — the answer
   * `lookup.resolve()` prefers over the built-in target. Generation-gated:
   * the Resolver verifies you hold the name right now (NotHolder otherwise),
   * and your record stops resolving the moment the name changes hands.
   * Native set_addr checks the current payment state atomically: ordinary
   * names and explicit None can change address; required memos require setPayment.
   * No client preflight is converted into a later setPayment(None).
   */
  async setRecord(name: string, address: string): Promise<Submitted> {
    const { label, namespace } = parseName(name);
    const { resolver: resolverId } = await this.paymentResolverOf(namespace);
    const pub = await this.signer.publicKey();
    const r = await this.invoke(
      resolverId,
      "set_addr",
      [bytesArg(nameNode(label, namespace)), addrArg(pub), addrArg(address)],
      RESOLVER_ERRORS,
    );
    return { hash: r.hash, ledger: r.ledger };
  }

  /**
   * A text record on YOUR name (`url`, `avatar`, any Symbol-legal key ≤32
   * chars of [A-Za-z0-9_]). Use {@link PROFILE_KEYS} for records every
   * Soran-aware wallet knows to look for.
   *
   * PERMANENCE NOTE: the contract stores text records overwrite-only — there
   * is no on-chain delete. The retraction convention is an EMPTY VALUE
   * ({@link clearText}): the entry remains on chain (empty), and standard
   * readers (lookup's `profile()`) treat empty as unset. Publish
   * accordingly — treat every value as permanent-ish public data.
   */
  async setText(name: string, key: string, value: string): Promise<Submitted> {
    const { label, namespace } = parseName(name);
    if (key === "payment") throw new HolderError("payment records must be written atomically with setPayment");
    if (!SYMBOL_RE.test(key)) {
      throw new HolderError(`invalid text-record key "${key}" — 1-32 chars of A-Za-z0-9_`);
    }
    const resolverId = await this.resolverOf(namespace);
    const pub = await this.signer.publicKey();
    const r = await this.invoke(
      resolverId,
      "set_text",
      [
        bytesArg(nameNode(label, namespace)),
        addrArg(pub),
        nativeToScVal(key, { type: "symbol" }),
        nativeToScVal(value, { type: "string" }),
      ],
      RESOLVER_ERRORS,
    );
    return { hash: r.hash, ledger: r.ledger };
  }

  /**
   * Retract a text record by overwriting it with the empty string — the
   * chain keeps the (empty) entry, and standard readers treat empty as
   * unset. There is no true on-chain delete for text records.
   */
  async clearText(name: string, key: string): Promise<Submitted> {
    return this.setText(name, key, "");
  }

  /**
   * Publish several profile records in one call. Soroban allows one contract
   * invocation per transaction, so this signs and submits ONE TRANSACTION
   * PER KEY, sequentially, and returns the per-key results. On a mid-batch
   * failure it throws with the already-set keys named in the message —
   * records already written stay written (they are individually valid).
   */
  async setProfile(
    name: string,
    profile: Record<string, string>,
  ): Promise<Array<Submitted & { key: string }>> {
    const entries = Object.entries(profile);
    if (entries.length === 0) throw new HolderError("setProfile: empty profile");
    for (const [key] of entries) {
      if (!SYMBOL_RE.test(key)) {
        throw new HolderError(`invalid text-record key "${key}" — 1-32 chars of A-Za-z0-9_`);
      }
    }
    const done: Array<Submitted & { key: string }> = [];
    for (const [key, value] of entries) {
      try {
        const r = await this.setText(name, key, value);
        done.push({ key, ...r });
      } catch (e) {
        const set = done.map((d) => d.key).join(", ") || "none";
        throw new HolderError(
          `setProfile stopped at "${key}" (${e instanceof Error ? e.message : String(e)}); keys already set: ${set}`,
          e instanceof HolderError ? e.contractId : null,
          e instanceof HolderError && e.fn ? e.fn : "set_text",
          e instanceof HolderError ? e.code : null,
          e instanceof HolderError ? e.codeName : null,
          e instanceof HolderError ? e.txHash : null,
        );
      }
    }
    return done;
  }

  // ---- reverse + primary ---------------------------------------------------

  /**
   * Claim `name` as YOUR ADDRESS's reverse record on its namespace resolver
   * — what `lookup.reverseLookup` finds. Authorized by the address itself,
   * and the contract enforces that the name's forward record already
   * resolves to you (ForwardMismatch otherwise): a reverse claim on a name
   * that doesn't point back at you is spoofing, and the chain refuses it.
   *
   * NOTE the forward proof must be the RESOLVER's OWN record — the
   * Registrar's built-in target (which `lookup.resolve` also honors for
   * fresh names) does not count. On a freshly issued name, call
   * `setRecord(name, yourAddress)` first, then `setReverse(name)`.
   */
  async setReverse(name: string): Promise<Submitted> {
    const { namespace } = parseName(name);
    const resolverId = await this.resolverOf(namespace);
    const pub = await this.signer.publicKey();
    let r: Invoked;
    try {
      r = await this.invoke(
        resolverId,
        "set_reverse",
        [addrArg(pub), nativeToScVal(name.toLowerCase(), { type: "string" })],
        RESOLVER_ERRORS,
      );
    } catch (e) {
      if (e instanceof HolderError && e.codeName === "ForwardMismatch") {
        throw new HolderError(
          `${e.message} — the resolver only accepts its OWN forward record as proof; if this name still resolves via the Registrar's built-in target, call setRecord(name, yourAddress) first, then retry setReverse`,
          e.contractId,
          e.fn,
          e.code,
          e.codeName,
          e.txHash,
        );
      }
      throw e;
    }
    return { hash: r.hash, ledger: r.ledger };
  }

  /** Remove your reverse record on a namespace's resolver. */
  async clearReverse(namespace: string): Promise<Submitted> {
    assertLabel(normalizeLabel(namespace));
    const resolverId = await this.resolverOf(normalizeLabel(namespace));
    const pub = await this.signer.publicKey();
    const r = await this.invoke(resolverId, "clear_reverse", [addrArg(pub)], RESOLVER_ERRORS);
    return { hash: r.hash, ledger: r.ledger };
  }

  /**
   * Declare `name` as YOUR one cross-namespace primary display name. The
   * PrimaryName contract verifies the claim against the namespace resolver
   * on every read, so a primary can never outlive the name it points at.
   * Requires a reverse record first in practice (NotDisplayName otherwise).
   */
  async setPrimary(name: string): Promise<Submitted> {
    if (!this.primaryId) {
      throw new HolderError(
        "setPrimary needs the PrimaryName contract — configure primaryId (the testnet preset supplies one)",
      );
    }
    parseName(name); // validate shape before spending anything
    if (await this.read(this.primaryId, "registry", []) !== this.registryId) throw new HolderError("Primary is anchored to a different Registry");
    const pub = await this.signer.publicKey();
    const r = await this.invoke(
      this.primaryId,
      "set_primary",
      [addrArg(pub), nativeToScVal(name.toLowerCase(), { type: "string" })],
      PRIMARY_ERRORS,
    );
    return { hash: r.hash, ledger: r.ledger };
  }

  /** Withdraw your primary-name declaration. */
  async clearPrimary(): Promise<Submitted> {
    if (!this.primaryId) {
      throw new HolderError(
        "clearPrimary needs the PrimaryName contract — configure primaryId (the testnet preset supplies one)",
      );
    }
    if (await this.read(this.primaryId, "registry", []) !== this.registryId) throw new HolderError("Primary is anchored to a different Registry");
    const pub = await this.signer.publicKey();
    const r = await this.invoke(this.primaryId, "clear_primary", [addrArg(pub)], PRIMARY_ERRORS);
    return { hash: r.hash, ledger: r.ledger };
  }

  // ---- name transfers ------------------------------------------------------

  /**
   * Offer YOUR name to `to`. Two-step by contract design: nothing moves
   * until the recipient accepts, so a typo'd address cannot burn the name.
   * Policy-gated (NotTransferable on namespaces that forbid it) and live
   * names only.
   */
  async proposeNameTransfer(name: string, to: string): Promise<Submitted> {
    const { label, namespace } = parseName(name);
    const registrarId = await this.registrarOf(namespace);
    const r = await this.invoke(
      registrarId,
      "propose_transfer",
      [labelArg(label), addrArg(to)],
      REGISTRAR_ERRORS,
    );
    return { hash: r.hash, ledger: r.ledger };
  }

  /** Accept a name offered to you. Signer must be the PROPOSED holder. */
  async acceptNameTransfer(name: string): Promise<Submitted> {
    const { label, namespace } = parseName(name);
    const registrarId = await this.registrarOf(namespace);
    const r = await this.invoke(
      registrarId,
      "accept_transfer",
      [labelArg(label)],
      REGISTRAR_ERRORS,
    );
    return { hash: r.hash, ledger: r.ledger };
  }

  /** Withdraw a pending transfer of your name. */
  async cancelNameTransfer(name: string): Promise<Submitted> {
    const { label, namespace } = parseName(name);
    const registrarId = await this.registrarOf(namespace);
    const r = await this.invoke(
      registrarId,
      "cancel_transfer",
      [labelArg(label)],
      REGISTRAR_ERRORS,
    );
    return { hash: r.hash, ledger: r.ledger };
  }

  /** The pending transfer proposal on a name, or null. */
  async pendingNameTransfer(
    name: string,
  ): Promise<{ from: string; to: string; expiresAt: bigint } | null> {
    const { label, namespace } = parseName(name);
    const registrarId = await this.registrarOf(namespace);
    const raw = (await this.read(registrarId, "pending_transfer", [labelArg(label)])) as {
      from: string;
      to: string;
      expires: bigint;
    } | null;
    if (!raw) return null;
    return { from: String(raw.from), to: String(raw.to), expiresAt: BigInt(raw.expires) };
  }

  // ---- discovery -----------------------------------------------------------

  /** The namespace's Registry-attested Registrar. Cached briefly. */
  async registrarOf(namespace: string): Promise<string> {
    namespace = normalizeLabel(namespace);
    assertLabel(namespace);
    const hit = this.registrars.get(namespace);
    if (hit && Date.now() - hit.at < SoranHolder.POINTER_TTL_MS) return hit.value;
    const id = (await this.read(this.registryId, "registrar_of", [
      bytesArg(namehash(namespace)),
    ])) as string | null;
    if (!id) {
      throw new HolderError(
        `namespace "${namespace}" has no attested Registrar on this Registry`,
        this.registryId,
        "registrar_of",
      );
    }
    this.registrars.set(namespace, { value: id, at: Date.now() });
    return id;
  }

  /** The namespace's resolver pointer. Cached briefly. */
  async resolverOf(namespace: string): Promise<string> {
    namespace = normalizeLabel(namespace);
    assertLabel(namespace);
    const hit = this.resolvers.get(namespace);
    if (hit && Date.now() - hit.at < SoranHolder.POINTER_TTL_MS) return hit.value;
    const id = (await this.read(this.registryId, "resolver_of", [
      bytesArg(namehash(namespace)),
    ])) as string | null;
    if (!id) {
      throw new HolderError(
        `namespace "${namespace}" has no public resolver — records/reverse and SDK payment-address edits are unavailable`,
        this.registryId,
        "resolver_of",
      );
    }
    this.resolvers.set(namespace, { value: id, at: Date.now() });
    return id;
  }

  // ---- internals (same pipeline discipline as @sorandomains/owner) --------

  private async paymentResolverOf(namespace: string): Promise<{ resolver: string; registrar: string }> {
    const nsNode = namehash(namespace);
    const args = [bytesArg(nsNode)];
    const [resolver, registrar] = await Promise.all([
      this.read(this.registryId, "resolver_of", args),
      this.read(this.registryId, "registrar_of", args),
    ]);
    if (typeof resolver !== "string" || !StrKey.isValidContract(resolver))
      throw new HolderError("namespace has no valid native payment Resolver");
    if (typeof registrar !== "string" || !StrKey.isValidContract(registrar))
      throw new HolderError("namespace has no valid Registrar");
    const [anchor, authority, version, anchors] = await Promise.all([
      this.read(resolver, "registry", []),
      this.read(resolver, "authority", []),
      this.read(resolver, "payment_version", []),
      this.read(registrar, "anchors", []),
    ]);
    if (anchor !== this.registryId) throw new HolderError("payment Resolver is anchored to a different Registry", resolver, "registry");
    if (authority !== registrar) throw new HolderError("payment Resolver authority does not match the namespace Registrar", resolver, "authority");
    if (!Array.isArray(anchors) || anchors.length !== 2 || anchors[0] !== this.registryId ||
        !(anchors[1] instanceof Uint8Array) || anchors[1].length !== nsNode.length ||
        !nsNode.every((byte, index) => anchors[1][index] === byte))
      throw new HolderError("Registrar anchors do not match this Registry and namespace", registrar, "anchors");
    if (version !== 1) throw new HolderError("unsupported native payment Resolver version", resolver, "payment_version");
    return { resolver, registrar };
  }

  private async assertMemoFree(name: string): Promise<string> {
    const { label, namespace } = parseName(name);
    const { resolver, registrar } = await this.paymentResolverOf(namespace);
    const raw = await this.read(resolver, "resolve_payment", [nativeToScVal(`${label}.${namespace}`, { type: "string" })]);
    let payment: PaymentDestination;
    try { payment = paymentFromNative(raw); }
    catch (e) { throw new HolderError(`invalid payment result: ${String(e)}`, resolver, "resolve_payment"); }
    if (payment.memo.type !== "none") throw new HolderError("this name requires a memo; use setPayment to update address and memo together");
    // Registrar-only write below cannot alter a Resolver's explicit addr/memo.
    // A concurrent set_payment installs its own addr, preserving its memo routing.
    return registrar;
  }

  private async read(contractId: string, fn: string, args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(new Account(SIM_SOURCE, "0"), {
      fee: BASE_FEE,
      networkPassphrase: this.passphrase,
    })
      .addOperation(new Contract(contractId).call(fn, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw typedError(contractId, fn, sim.error, {});
    if (rpc.Api.isSimulationRestore(sim)) {
      throw new HolderError(
        `${fn}: the on-chain entry is archived (rent lapsed) — any write restores it automatically`,
        contractId,
        fn,
      );
    }
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval)
      throw new HolderError(`${fn}: missing simulation return value`, contractId, fn);
    const v = scValToNative(sim.result.retval);
    return v === undefined ? null : v;
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

  private async sourceAccount(pub: string, fn: string): Promise<Account> {
    try {
      return await this.server.getAccount(pub);
    } catch {
      throw new HolderError(
        `${fn}: signer account ${pub} does not exist on this network — fund it (testnet: friendbot) before writing`,
        null,
        fn,
      );
    }
  }

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
        continue;
      }
      throw new HolderError(
        required === pub
          ? `${fn}: the network requires a separate auth-entry signature from ${pub}, which this SDK does not produce yet — make the authorized account the transaction source`
          : `${fn}: this operation must be authorized by ${required}, but the signer is ${pub} — use that account's signer`,
        contractId,
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
        if (/txBadSeq|bad_seq/i.test(String(e))) {
          return await this.attempt(contractId, fn, args, errNames);
        }
        throw e;
      }
    });
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
    for (let round = 0; rpc.Api.isSimulationRestore(sim); round++) {
      if (round >= 2) {
        throw new HolderError(
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
    this.assertSatisfiableAuth(prepared, pub, contractId, fn);
    const txHash = toHex(prepared.hash()); // (SDK17) hash() is Uint8Array
    const signed = await this.signEnvelope(prepared.toXDR());
    const envelope = TransactionBuilder.fromXDR(signed, this.passphrase);
    let sent: Awaited<ReturnType<rpc.Server["sendTransaction"]>>;
    try {
      sent = await this.server.sendTransaction(envelope);
    } catch (e) {
      throw new HolderError(
        `${fn}: submit failed after signing (${String(e)}) — transaction ${txHash} may or may not have reached the network; check the hash before retrying`,
        contractId,
        fn,
        null,
        null,
        txHash,
      );
    }
    if (sent.status === "ERROR") {
      throw new HolderError(
        `${fn}: submit rejected: ${JSON.stringify(sent.errorResult ?? sent.status)}`,
        contractId,
        fn,
        null,
        null,
        txHash,
      );
    }
    if (sent.status === "TRY_AGAIN_LATER") {
      throw new HolderError(
        `${fn}: the network did not accept the transaction (TRY_AGAIN_LATER) — it was NOT queued; safe to retry shortly`,
        contractId,
        fn,
        null,
        null,
        txHash,
      );
    }
    try {
      const { ledger, returnValue } = await this.confirm(txHash, contractId, fn, errNames);
      return { hash: txHash, ledger, returnValue };
    } catch (e) {
      if (e instanceof HolderError) throw e;
      throw new HolderError(
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
    const fee = (Number(this.fee) + Number(pre.minResourceFee)).toString();
    const tx = new TransactionBuilder(await this.sourceAccount(pub, "restore_footprint"), {
      fee,
      networkPassphrase: this.passphrase,
    })
      .setSorobanData(pre.transactionData.build())
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(this.timeoutSecs)
      .build();
    const signed = await this.signEnvelope(tx.toXDR());
    const sent = await this.server.sendTransaction(
      TransactionBuilder.fromXDR(signed, this.passphrase),
    );
    if (sent.status === "ERROR") {
      throw new HolderError(
        `restore_footprint: submit rejected: ${JSON.stringify(sent.errorResult ?? sent.status)}`,
        null,
        "restore_footprint",
        null,
        null,
        sent.hash,
      );
    }
    await this.confirm(sent.hash, "", "restore_footprint", {});
  }

  private async confirm(
    hash_: string,
    contractId: string,
    fn: string,
    errNames: Record<number, string>,
  ): Promise<{ ledger: number; returnValue: unknown }> {
    const tries = this.timeoutSecs + 5;
    let got = await this.server.getTransaction(hash_);
    for (let i = 0; i < tries && got.status === "NOT_FOUND"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      got = await this.server.getTransaction(hash_);
    }
    if (got.status === "NOT_FOUND") {
      throw new HolderError(
        `${fn}: transaction ${hash_} not confirmed within ${tries}s — it may still be included; check the hash before retrying`,
        contractId || null,
        fn,
        null,
        null,
        hash_,
      );
    }
    if (got.status !== "SUCCESS") {
      throw this.decodeFailure(got, contractId, fn, errNames, hash_);
    }
    let returnValue: unknown = null;
    try {
      if (got.returnValue) returnValue = scValToNative(got.returnValue);
    } catch {
      /* void return */
    }
    return { ledger: got.ledger, returnValue };
  }

  private decodeFailure(
    got: {
      status: string;
      resultXdr?: xdr.TransactionResult;
      resultMetaXdr?: xdr.TransactionMeta;
      diagnosticEventsXdr?: xdr.DiagnosticEvent[];
    },
    contractId: string,
    fn: string,
    errNames: Record<number, string>,
    hash_: string,
  ): HolderError {
    let code: number | null = null;
    try {
      const meta = got.resultMetaXdr;
      const diags: xdr.DiagnosticEvent[] =
        got.diagnosticEventsXdr ??
        (meta && meta.type === "v3"
          ? (meta.value.sorobanMeta?.diagnosticEvents ?? [])
          : meta && meta.type === "v4"
            ? meta.value.diagnosticEvents
            : []);
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
      /* diagnostics unavailable */
    }
    let resultCode = `tx status ${got.status}`;
    try {
      resultCode = got.resultXdr?.result.type ?? resultCode;
    } catch {
      /* keep plain status */
    }
    if (code !== null) {
      const codeName = errNames[code] ?? null;
      return new HolderError(
        `${fn} failed at inclusion: contract error #${code}${codeName ? ` (${codeName})` : ""} (${resultCode})`,
        contractId,
        fn,
        code,
        codeName,
        hash_,
      );
    }
    return new HolderError(`${fn} failed at inclusion (${resultCode})`, contractId, fn, null, null, hash_);
  }
}
