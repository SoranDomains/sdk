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
 * holder-authorized entry points and will ship in a holder-side module; this
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
    if (meta.switch() === 3) return meta.v3().sorobanMeta()?.events() ?? [];
    if (meta.switch() === 4) {
      const v4 = meta.v4();
      return [
        ...v4.operations().flatMap((op) => op.events()),
        ...v4.events().map((te) => te.event()),
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
      const cid = ev.contractId();
      if (!cid) continue;
      if (Address.contract(cid as unknown as Buffer).toString() !== registrarId) continue;
      const body = ev.body().v0();
      const topics = body.topics();
      if (topics.length < 1 || scValToNative(topics[0]) !== "issued") continue;
      const data = scValToNative(body.data()) as [unknown, unknown];
      if (!(data?.[0] instanceof Uint8Array) || typeof data?.[1] !== "string") continue;
      out.push({ label: new TextDecoder().decode(data[0]), holder: data[1] });
    } catch {
      /* not an issued event — skip */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

/** Known public deployments. Pass explicit options for anything else. */
export const DEPLOYMENTS = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: Networks.TESTNET as string,
    // The immutable Registry. The Registrar for a namespace is discovered on
    // chain via `registrar_of(node)` — never configured by hand.
    registryId: "CAUEHYVLLNNDZ4H5QWCPBDWEONRI44SI3XYSEACB4U3HYILIVQGQAMNI",
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
const addrArg = (address: string) => nativeToScVal(address, { type: "address" });
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
  }

  // ---- discovery -----------------------------------------------------------

  /** The namespace's on-chain attested Registrar id. Cached per instance. */
  async registrarOf(namespace: string): Promise<string> {
    assertLabel(namespace);
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
    assertLabel(namespace);
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
    assertLabel(label);
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
    for (const e of entries) assertLabel(e.label);
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
    assertLabel(label);
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
    assertLabel(label);
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
    assertLabel(namespace);
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
    assertLabel(namespace);
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
    assertLabel(namespace);
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
    assertLabel(namespace);
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
    assertLabel(label);
    const registrarId = await this.registrarOf(namespace);
    return this.readRecord(registrarId, label);
  }

  /** The pending namespace transfer on the Registry, or null. */
  async pendingNamespaceTransfer(namespace: string): Promise<unknown | null> {
    assertLabel(namespace);
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
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) return null;
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
        if (/txBadSeq|bad_seq/i.test(String(e))) {
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
      const cred = entry.credentials();
      if (cred.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) continue;
      let required: string;
      try {
        required = Address.fromScAddress(cred.address().address()).toString();
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
    let sim = await this.server.simulateTransaction(tx);
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
      sim = await this.server.simulateTransaction(tx);
    }
    if (rpc.Api.isSimulationError(sim)) {
      throw typedError(contractId, fn, sim.error, errNames);
    }
    const prepared = rpc.assembleTransaction(tx, sim).build();
    this.assertSatisfiableAuth(prepared, pub, contractId, fn);
    // The hash is fixed before signatures — compute it now so every failure
    // past this point can carry it (the "re-check before retrying" contract).
    const txHash = prepared.hash().toString("hex");
    const signed = await this.signEnvelope(prepared.toXDR());
    const envelope = TransactionBuilder.fromXDR(signed, this.passphrase);
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
      throw new OwnerError(
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
        meta && meta.switch() === 3
          ? (meta.v3().sorobanMeta()?.diagnosticEvents() ?? [])
          : meta && meta.switch() === 4
            ? meta.v4().diagnosticEvents()
            : []
      );
      outer: for (const d of diags) {
        const body = d.event().body().v0();
        for (const v of [...body.topics(), body.data()]) {
          if (v.switch() === xdr.ScValType.scvError()) {
            const err = v.error();
            if (err.switch() === xdr.ScErrorType.sceContract()) {
              code = err.contractCode();
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
      resultCode = got.resultXdr?.result().switch().name ?? resultCode;
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
