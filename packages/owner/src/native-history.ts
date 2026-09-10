import { Contract, hash, scValToNative, xdr, type rpc } from "@stellar/stellar-sdk";
import { NativeClaimError, address, bool, bytes32, exactObject, hex, namespaceNode, sc, struct, u32, u64, unhex, utf8 } from "./native-codec.js";
import { claimIntentFromNative, claimIntentToScVal, claimReceiptFromNative, nativeIntentHash, type ClaimIntent, type ClaimReceipt } from "./native-types.js";

/** Use a deployment's trusted stable Lookup, never a value supplied by a claim. */
export type HistoricalRecoveryOptions = { lookupId: string };
export type HistoricalRead = { value: unknown; ledger: number };
export type HistoricalContext = {
  registryId: string;
  passphrase: string;
  server: Pick<rpc.Server, "getLedgerEntries">;
  readWithLedger(contract: string, method: string, args: xdr.ScVal[]): Promise<HistoricalRead>;
};

// A tainted Registrar is not generally trusted. Only this reviewed export
// implementation is eligible, after canonical Lookup confirms sealed migration.
const REVIEWED_SOURCE_HASH = "26e03cd1d7fbfa46fe442406fb1b88022ec8cd8bd9123bed570f971fce596a14";
const PLAN_FIELDS = ["source_registry", "source_registry_hash", "namespace_root", "namespace_count", "ownership_sequence", "primary_source", "primary_source_hash", "primary_target", "primary_target_hash", "primary_root", "primary_count"];
const LEAF_FIELDS = ["label", "owner", "owner_epoch", "source_registrar", "source_registrar_hash", "source_resolver", "source_resolver_hash", "treasury", "policy", "pending_transfer", "registrar_root", "registrar_count", "resolver_root", "resolver_count"];
function fail(message: string): never { throw new NativeClaimError(`historical recovery: ${message}`, "unavailable"); }
export function historicalReadLedger(value: unknown, minimum = 1): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value < 1 || value > 0xffff_ffff)
    return fail("RPC read has missing, invalid or stale ledger context");
  return value;
}
function sameBytes(value: unknown, expected: string, what: string): void {
  if (hex(bytes32(value, what)) !== expected) fail(`${what} differs from the saved intent or migration commitment`);
}
function listOfOne(value: unknown, namespace: string, what: string): void {
  if (!Array.isArray(value) || value.length !== 1) fail(`${what} is incomplete`);
  sameBytes(value[0], namespace, what);
}
function leafScVal(raw: Record<string, unknown>): xdr.ScVal {
  const policy = exactObject(raw.policy, ["reclaimable", "transferable", "tradeable", "default_term_secs", "trade_fee_bps"], "migration policy");
  if (!(raw.label instanceof Uint8Array) || !Array.isArray(raw.pending_transfer) || raw.pending_transfer.length !== 0)
    return fail("invalid namespace label or pending transfer in migration commitment");
  const fields: Record<string, xdr.ScVal> = {
    label: sc.bytes(new Uint8Array(raw.label)), pending_transfer: xdr.ScVal.scvVec([]),
    policy: struct({ reclaimable: sc.bool(bool(policy.reclaimable, "reclaimable")), transferable: sc.bool(bool(policy.transferable, "transferable")), tradeable: sc.bool(bool(policy.tradeable, "tradeable")), default_term_secs: sc.u64(u64(policy.default_term_secs, "default term")), trade_fee_bps: sc.u32(u32(policy.trade_fee_bps, "trade fee")) }),
    owner_epoch: sc.u64(u64(raw.owner_epoch, "owner epoch")),
  };
  for (const key of ["owner", "treasury"]) fields[key] = sc.address(address(raw[key], "identity", key));
  for (const key of ["source_registrar", "source_resolver"]) fields[key] = sc.address(address(raw[key], "contract", key));
  for (const key of ["source_registrar_hash", "source_resolver_hash", "registrar_root", "resolver_root"]) fields[key] = sc.bytes(bytes32(raw[key], key));
  for (const key of ["registrar_count", "resolver_count"]) {
    const count = u32(raw[key], key);
    if (count < 1 || count > 1024) fail("invalid migration record count");
    fields[key] = sc.u32(count);
  }
  return struct(fields);
}
function namespaceLeafHash(network: string, source: string, target: string, leaf: xdr.ScVal): string {
  const pieces = [utf8("soran:registry-migration:v1\0"), unhex(network), sc.address(source).toXDR(), sc.address(target).toXDR(), leaf.toXDR()];
  const bytes = new Uint8Array(pieces.reduce((n, piece) => n + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.length; }
  return hex(hash(bytes));
}
async function executableHash(context: HistoricalContext, contract: string, minimumLedger: number): Promise<string> {
  const key = new Contract(contract).getFootprint();
  const proof = await context.server.getLedgerEntries(key);
  historicalReadLedger(proof?.latestLedger, minimumLedger);
  const entry = proof.entries?.[0];
  if (proof.entries?.length !== 1 || !entry || entry.key.toXDR("base64") !== key.toXDR("base64") || entry.val.type !== "contractData")
    return fail("executable proof is missing or for another contract");
  const data = entry.val.value;
  if (data.contract.toXDR("base64") !== new Contract(contract).address().toScAddress().toXDR("base64") || data.key.type !== "scvLedgerKeyContractInstance" || data.durability !== xdr.ContractDataDurability.persistent || data.val.type !== "scvContractInstance" || data.val.value.executable.type !== "contractExecutableWasm")
    return fail("executable proof is not the requested persistent Wasm instance");
  return hex(data.val.value.executable.wasmHash.value);
}

/**
 * Read a completed claim from its original frozen Registrar after cutover.
 * The canonical Lookup's governance-approved sealed migration is an explicit
 * trust anchor for source history before freeze. Current code hashes cannot
 * independently prove that no malicious upgrade occurred before that review.
 * This function never signs, submits, rewrites an intent or enables a replay.
 * A verified null is historical absence, not permission to submit an old intent.
 */
export async function recoverFrozenClaim(context: HistoricalContext, input: ClaimIntent, options: HistoricalRecoveryOptions): Promise<ClaimReceipt | null> {
  // Snapshot all inputs before the first await, including the trust anchor.
  const encoded = claimIntentToScVal(input), intent = claimIntentFromNative(scValToNative(encoded));
  const lookup = address(exactObject(options, ["lookupId"], "historical recovery options").lookupId, "contract", "trusted Lookup");
  const target = address(context.registryId, "contract", "successor Registry");
  const network = hex(hash(utf8(context.passphrase)));
  if (intent.context.network !== network || intent.context.registry === target)
    fail("requires the saved original network and a different successor Registry");
  // The rollout is deliberately bounded to the reviewed single-Nova migration.
  if (intent.context.namespace !== hex(namespaceNode("nova"))) fail("unsupported migration namespace");
  const request = intent.context, node = sc.bytes(unhex(request.namespace));
  // Establish completed cutover and freeze BEFORE observing receipt absence.
  // A later freeze cannot make an earlier null snapshot authoritative.
  let frozenLedger = 1;
  const beforeReceipt = async (contract: string, method: string): Promise<unknown> => {
    const result = await context.readWithLedger(contract, method, []);
    frozenLedger = historicalReadLedger(result?.ledger, frozenLedger);
    return result.value;
  };
  if (await beforeReceipt(lookup, "registry") !== target) fail("canonical Lookup has not completed the successor cutover");
  const beforeState = exactObject(await beforeReceipt(target, "migration_status"), ["plan", "imported", "completed", "sealed", "primary_initialized"], "migration status");
  if (beforeState.sealed !== true || beforeState.primary_initialized !== true) fail("successor migration is not fully sealed");
  if (await beforeReceipt(request.registrar, "migration_export_frozen") !== true) fail("source Registrar is not frozen before receipt observation");
  const snapshot = await context.readWithLedger(request.registrar, "claim_receipt", [sc.address(intent.claimant), sc.bytes(unhex(request.requestId))]);
  const observed = historicalReadLedger(snapshot?.ledger, frozenLedger);
  const read = async (contract: string, method: string, args: xdr.ScVal[] = []): Promise<unknown> => {
    const result = await context.readWithLedger(contract, method, args);
    historicalReadLedger(result?.ledger, observed);
    return result.value;
  };
  const [lookupRegistry, lookupVersion, version, active, stateRaw, leafRaw, frozen, exportVersion, exportTarget, anchors, attested, sourceHash, sourceRegistryHash] = await Promise.all([
    read(lookup, "registry"), read(lookup, "registry_migration_version"), read(target, "migration_version"), read(target, "migration_active"),
    read(target, "migration_status"), read(target, "migration_namespace", [node]),
    read(request.registrar, "migration_export_frozen"), read(request.registrar, "migration_export_version"), read(request.registrar, "migration_export_target"),
    read(request.registrar, "anchors"), read(request.registry, "registrar_of", [node]),
    executableHash(context, request.registrar, observed), executableHash(context, request.registry, observed),
  ]);
  if (lookupRegistry !== target || lookupVersion !== 1 || version !== 1 || active !== false)
    fail("canonical Lookup has not completed the supported successor cutover");
  const state = exactObject(stateRaw, ["plan", "imported", "completed", "sealed", "primary_initialized"], "migration status");
  if (state.sealed !== true || state.primary_initialized !== true) fail("successor migration is not fully sealed");
  const plan = exactObject(state.plan, PLAN_FIELDS, "migration plan");
  if (plan.source_registry !== request.registry || plan.namespace_count !== 1) fail("migration plan targets another source or namespace set");
  sameBytes(plan.source_registry_hash, sourceRegistryHash, "source Registry executable");
  u64(plan.ownership_sequence, "ownership sequence");
  for (const key of ["primary_source", "primary_target"]) address(plan[key], "contract", key);
  for (const key of ["primary_source_hash", "primary_target_hash", "primary_root"]) bytes32(plan[key], key);
  u32(plan.primary_count, "primary count");
  listOfOne(state.imported, request.namespace, "imported namespaces");
  listOfOne(state.completed, request.namespace, "completed namespaces");
  const leaf = exactObject(leafRaw, LEAF_FIELDS, "migration namespace");
  const epoch = u64(leaf.owner_epoch, "migration owner epoch");
  if (epoch === 0n || epoch > (plan.ownership_sequence as bigint)) fail("migration ownership sequence is inconsistent");
  if (leaf.source_registrar !== request.registrar || !(leaf.label instanceof Uint8Array) || hex(leaf.label) !== hex(utf8("nova")))
    fail("namespace commitment differs from the saved source contracts");
  // Historical Resolver/policy/owner settings need not equal current migration
  // settings: the complete original receipt hash binds their original values.
  if (sourceHash !== REVIEWED_SOURCE_HASH) fail("source Registrar is not the reviewed frozen export implementation");
  sameBytes(leaf.source_registrar_hash, sourceHash, "source Registrar executable");
  sameBytes(plan.namespace_root, namespaceLeafHash(network, request.registry, target, leafScVal(leaf)), "namespace Merkle root");
  if (frozen !== true || exportVersion !== 1 || exportTarget !== target || attested !== request.registrar || !Array.isArray(anchors) || anchors.length !== 2 || anchors[0] !== request.registry)
    fail("source Registrar is not irreversibly frozen for this exact successor");
  sameBytes(anchors[1], request.namespace, "source namespace anchor");
  if (snapshot.value === null) return null;
  const receipt = claimReceiptFromNative(snapshot.value);
  historicalReadLedger(receipt.ledger);
  const name = new Uint8Array(64); name.set(unhex(request.namespace)); name.set(hash(utf8(intent.label)), 32);
  const generation = intent.expectedGeneration === null ? 0n : intent.expectedGeneration + 1n;
  const expiry = intent.termSecs === 0n ? 0n : receipt.timestamp + intent.termSecs;
  if (receipt.operation !== "claim" || receipt.intentHash !== nativeIntentHash("claim", encoded) || receipt.holder !== intent.claimant || receipt.node !== hex(hash(name)) || receipt.generation !== generation || receipt.expiresAt !== expiry || receipt.feeToken !== intent.feeToken || receipt.feeAmount !== intent.feeAmount || receipt.feeRecipient !== (intent.feeAmount > 0n ? intent.feeRecipient : null) || receipt.ledger > observed || receipt.timestamp < request.validAfter || receipt.timestamp > request.deadline)
    fail("source receipt differs from the complete original immutable claim intent");
  return receipt;
}
