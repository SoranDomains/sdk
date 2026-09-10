import { expectedRegistrarCode } from "./native-code-policy.js";
import { Account, BASE_FEE, Contract, Operation, Transaction, TransactionBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { NativeClaimError, address, bytes32, hex, namespaceNode, sc, unhex } from "./native-codec.js";
import { assertSignedBodyUnchanged, validateEligibilityAuthorization, validateNativeTransaction, type NativeAuthorizationPlan } from "./native-auth.js";

export type NativeSigner = { publicKey(): string | Promise<string>; signTransaction(encoded: string, opts: { networkPassphrase: string }): Promise<string | { signedTxXdr: string }> };
export type NativeContext = {
  registryId: string; passphrase: string; server: rpc.Server; signer: NativeSigner; fee: string; timeoutSecs: number; maxFeeStroops: bigint;
  read(contract: string, method: string, args: xdr.ScVal[]): Promise<unknown>;
  serialize<T>(work: () => Promise<T>): Promise<T>;
};
export type NativeCapability = { supported: false; registrar: string; reason: "legacy-template" | "unsupported-version" } | { supported: true; version: 1; registrar: string; resolver: string; registry: string; namespace: string; owner: string; ownerEpoch: bigint };
/** This published legacy code has owner-only issuance. Missing RPC data is never legacy detection. */
const LEGACY_REGISTRAR_HASH = "ed06b3374ff4342b4a2316fc546505132cd8fd35be6666571cf088710af9bbc6";
/** Historical reads must not trust an upgraded Registrar that can fabricate receipts. Resolver changes do not block this Registrar-only check. */
export async function verifyRegistrarProvenance(context: NativeContext, registrar: string, namespace: string): Promise<void> {
  const node=sc.bytes(unhex(namespace));
  const [attested,tainted,templates,instance]=await Promise.all([
    context.read(context.registryId,"registrar_of",[node]),context.read(context.registryId,"registrar_tainted",[node]),
    expectedRegistrarCode(context,namespace),context.server.getContractInstance(registrar),
  ]);
  if(attested!==registrar||tainted!==false||instance.executable.type!=="contractExecutableWasm")throw new NativeClaimError("Registrar provenance is unavailable or tainted; refusing authoritative claim/receipt reads","unavailable");
  if(templates!==hex(instance.executable.wasmHash.value))throw new NativeClaimError("Registrar executable differs from Registry-approved code","unavailable");
}
export async function nativeCapability(context: NativeContext, namespace: string): Promise<NativeCapability> {
  const node = namespaceNode(namespace), nodeArg = sc.bytes(node);
  const registrar = address(await context.read(context.registryId, "registrar_of", [nodeArg]), "contract", "namespace Registrar");
  const instance = await context.server.getContractInstance(registrar);
  if (instance.executable.type === "contractExecutableWasm" && hex(instance.executable.wasmHash.value) === LEGACY_REGISTRAR_HASH)
    return { supported: false, registrar, reason: "legacy-template" };
  await verifyRegistrarProvenance(context,registrar,hex(node));
  const version = await context.read(registrar, "claim_version", []);
  if (typeof version !== "number" || !Number.isInteger(version)) throw new NativeClaimError("malformed native claim capability", "unavailable");
  if (version !== 1) return { supported: false, registrar, reason: "unsupported-version" };
  const [pair, epoch, owner, anchors] = await Promise.all([
    context.read(context.registryId, "native_contracts", [nodeArg]), context.read(context.registryId, "owner_epoch", [nodeArg]),
    context.read(context.registryId, "owner_of", [nodeArg]), context.read(registrar, "anchors", []),
  ]);
  if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== registrar) throw new NativeClaimError("native contract binding does not match Registrar", "unavailable");
  const resolver = address(pair[1], "contract", "native Resolver");
  if (!Array.isArray(anchors) || anchors.length !== 2 || anchors[0] !== context.registryId || !(anchors[1] instanceof Uint8Array) || hex(anchors[1]) !== hex(node)) throw new NativeClaimError("Registrar anchors differ from selected namespace", "unavailable");
  if (typeof epoch !== "bigint" || epoch < 1n) throw new NativeClaimError("invalid namespace ownership epoch", "unavailable");
  if (await context.read(resolver, "initialization_version", []) !== 1) throw new NativeClaimError("unsupported native Resolver initializer", "unsupported");
  return { supported: true, version: 1, registrar, resolver, registry: context.registryId, namespace, owner: address(owner, "identity", "namespace owner"), ownerEpoch: epoch };
}
export async function requireNative(context: NativeContext, namespace: string): Promise<Extract<NativeCapability, { supported: true }>> {
  const capability = await nativeCapability(context, namespace);
  if (!capability.supported) throw new NativeClaimError(`namespace has no supported native claim interface (${capability.reason})`, "unsupported");
  return capability;
}
export type NativePrepared = { transactionXdr: string; hash: string; networkPassphrase: string; feeStroops: bigint; eligibilityEntryXdr: string | null };
export type NativeWriteOptions = {
  /** Exact native admission authorization from the app. This is not an owner transaction signature. */
  eligibilityAuthorization?: string;
  /** Persist the public recovery reference before wallet signing/broadcast. Rejecting stops submission. */
  onPrepared?: (prepared: NativePrepared) => void | Promise<void>;
};

export async function prepareNative(context: NativeContext, plan: NativeAuthorizationPlan, options: NativeWriteOptions = {}): Promise<{ transaction: Transaction; prepared: NativePrepared }> {
  const source = address(await context.signer.publicKey(), "account", "transaction signer");
  if (source !== plan.source) throw new NativeClaimError("wallet changed since the intent was reviewed", "authorization");
  const raw = new TransactionBuilder(await context.server.getAccount(source), { fee: context.fee, networkPassphrase: context.passphrase })
    .addOperation(new Contract(plan.contract).call(plan.method, ...plan.args)).setTimeout(context.timeoutSecs).build();
  const simulate = async (tx: Transaction) => {
    const result = await context.server.simulateTransaction(tx, undefined, undefined, false);
    if (rpc.Api.isSimulationRestore(result)) throw new NativeClaimError("native operation requires storage restoration; review and restore separately before resuming this intent", "unavailable");
    if (rpc.Api.isSimulationError(result)) throw new NativeClaimError(`${plan.method}: ${result.error}`, "failed");
    if (!rpc.Api.isSimulationSuccess(result) || !result.result) throw new NativeClaimError("native simulation returned no result", "unavailable");
    return result;
  };
  let transaction = rpc.assembleTransaction(raw, await simulate(raw)).build();
  validateNativeTransaction(transaction, plan, false);
  if (options.eligibilityAuthorization) {
    if (options.eligibilityAuthorization.length > 32768) throw new NativeClaimError("eligibility authorization is too large", "authorization");
    if (!plan.eligibility) throw new NativeClaimError("this native operation does not require an app approver", "authorization");
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(options.eligibilityAuthorization, "base64");
    validateEligibilityAuthorization(signed, plan.eligibility);
    const op = transaction.operations[0];
    if (op.type !== "invokeHostFunction") throw new NativeClaimError("unexpected prepared operation");
    const auth = (op.auth ?? []).map(entry => entry.credentials.type === "sorobanCredentialsSourceAccount" ? entry : signed);
    transaction = TransactionBuilder.cloneFrom(transaction, { networkPassphrase: context.passphrase }).clearOperations().addOperation(Operation.invokeHostFunction({ func: op.func, auth })).build();
    transaction = rpc.assembleTransaction(transaction, await simulate(transaction)).build();
    validateNativeTransaction(transaction, plan);
  }
  const op = transaction.operations[0];
  if (op.type !== "invokeHostFunction") throw new NativeClaimError("unexpected native operation");
  const approval = (op.auth ?? []).find(entry => entry.credentials.type !== "sorobanCredentialsSourceAccount");
  return { transaction, prepared: { transactionXdr: transaction.toXDR(), hash: hex(transaction.hash()), networkPassphrase: context.passphrase, feeStroops: BigInt(transaction.fee), eligibilityEntryXdr: approval?.toXDR("base64") ?? null } };
}

/** No automatic transaction retry, implicit restoration or hash-losing error path. */
export async function sendNative(context: NativeContext, plan: NativeAuthorizationPlan, options: NativeWriteOptions = {}): Promise<{ hash: string; ledger: number; value: unknown }> {
  const { transaction, prepared } = await prepareNative(context, plan, options);
  validateNativeTransaction(transaction, plan);
  await options.onPrepared?.(prepared);
  if (await context.signer.publicKey() !== plan.source) throw new NativeClaimError("wallet changed before signing", "authorization");
  const result = await context.signer.signTransaction(prepared.transactionXdr, { networkPassphrase: context.passphrase });
  const signed = assertSignedBodyUnchanged(transaction, typeof result === "string" ? result : result.signedTxXdr, context.passphrase);
  try {
    const sent = await context.server.sendTransaction(signed);
    if (sent.hash !== prepared.hash) throw new NativeClaimError("RPC returned a different transaction hash", "pending", prepared.hash);
    if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") throw new NativeClaimError(`transaction was not accepted (${sent.status}); reconcile the original receipt and hash`, "pending", prepared.hash);
    for (let attempt = 0; attempt < context.timeoutSecs + 5; attempt++) {
      const receipt = await context.server.getTransaction(prepared.hash);
      if (receipt.status === "SUCCESS" || receipt.status === "FAILED") {
        // Status alone cannot identify the reviewed transaction or establish inclusion.
        validateNativeTerminalReceipt(receipt, prepared.hash, context.passphrase);
        if (receipt.status === "SUCCESS") return { hash: prepared.hash, ledger: receipt.ledger, value: receipt.returnValue ? scValToNative(receipt.returnValue) : null };
        throw new NativeClaimError("native transaction failed on chain", "failed", prepared.hash);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new NativeClaimError("transaction outcome is unknown; recover the original receipt and hash before replacing the request", "pending", prepared.hash);
  } catch (error) {
    if (error instanceof NativeClaimError && error.txHash) throw error;
    throw new NativeClaimError(`submission/confirmation interrupted: ${String(error)}; reconcile the original receipt`, "pending", prepared.hash);
  }
}

/** Bind terminal RPC context before classifying success or failure. An incomplete response remains uncertain. */
export function validateNativeTerminalReceipt(receipt: rpc.Api.GetSuccessfulTransactionResponse | rpc.Api.GetFailedTransactionResponse, expectedHash: string, passphrase: string): void {
  try {
    if (receipt.txHash !== expectedHash || !Number.isInteger(receipt.ledger) || receipt.ledger <= 0 || receipt.ledger > 0xffff_ffff || !receipt.envelopeXdr) throw new Error("missing or mismatched hash/ledger/envelope");
    const included = TransactionBuilder.fromXDR(receipt.envelopeXdr, passphrase);
    if (!(included instanceof Transaction) || hex(included.hash()) !== expectedHash) throw new Error("different included envelope");
  } catch {
    throw new NativeClaimError("terminal RPC response does not prove inclusion of the original reviewed transaction; reconcile its hash", "pending", expectedHash);
  }
}
