import { Address, Transaction, TransactionBuilder, authorizeEntry, xdr } from "@stellar/stellar-sdk";
import { NativeClaimError, address, hex, sc, u32 } from "./native-codec.js";

export type NativeInvocation = { contract: string; method: string; args: xdr.ScVal[]; children?: NativeInvocation[] };
/** Derive this plan locally from a validated intent, never from a remote envelope. */
export type NativeAuthorizationPlan = {
  source: string;
  contract: string;
  method: string;
  args: xdr.ScVal[];
  sourceInvocation: NativeInvocation;
  eligibility?: { account: string; invocation: NativeInvocation; latestLedger: number; maxExpirationLedger: number };
  maxFeeStroops: bigint;
};

export function authorizedInvocation(value: NativeInvocation): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
      contractAddress: new Address(address(value.contract, "contract", "invocation contract")).toScAddress(), functionName: value.method, args: value.args,
    })), subInvocations: (value.children ?? []).map(authorizedInvocation),
  });
}
function sameInvocation(actual: xdr.SorobanAuthorizedInvocation, expected: NativeInvocation): boolean {
  return actual.toXDR("base64") === authorizedInvocation(expected).toXDR("base64");
}

export function validateEligibilityAuthorization(entry: xdr.SorobanAuthorizationEntry, expected: NonNullable<NativeAuthorizationPlan["eligibility"]>, requireSigned = true): void {
  if (expected.invocation.method !== "claim" || expected.invocation.args.length !== 1 || (expected.invocation.children?.length ?? 0) !== 0) throw new NativeClaimError("eligibility may authorize only one exact native claim intent", "authorization");
  address(expected.account, "account", "eligibility account");
  u32(expected.latestLedger, "latest ledger"); u32(expected.maxExpirationLedger, "maximum auth expiration ledger");
  if (entry.credentials.type !== "sorobanCredentialsAddress") throw new NativeClaimError("eligibility requires the supported native G address credential", "authorization");
  const credential = entry.credentials.address;
  if (Address.fromScAddress(credential.address).toString() !== expected.account || !sameInvocation(entry.rootInvocation, expected.invocation) || entry.rootInvocation.subInvocations.length !== 0)
    throw new NativeClaimError("eligibility authorization differs from the exact claim intent", "authorization");
  if (requireSigned) {
    if (credential.signatureExpirationLedger <= expected.latestLedger || credential.signatureExpirationLedger > expected.maxExpirationLedger)
      throw new NativeClaimError("eligibility authorization expiry is outside the approved ledger bound", "authorization");
    if (credential.signature.type !== "scvVec" || !credential.signature.vec?.length)
      throw new NativeClaimError("eligibility authorization has no native account signatures", "authorization");
  } else if (credential.signature.type !== "scvVoid" && !(credential.signature.type === "scvVec" && credential.signature.vec?.length === 0)) {
    throw new NativeClaimError("refusing to sign an already signed eligibility credential", "authorization");
  }
}

/** Native account signing callback; hardware/custody integration keeps keys outside the SDK. */
export type EligibilitySigner = Parameters<typeof authorizeEntry>[1];

/** Signs only the expected admission entry. This helper never signs a transaction. */
export async function signEligibilityAuthorization(
  unsignedEntry: xdr.SorobanAuthorizationEntry,
  expected: NonNullable<NativeAuthorizationPlan["eligibility"]>,
  signer: EligibilitySigner,
  expirationLedger: number,
  networkPassphrase: string,
): Promise<xdr.SorobanAuthorizationEntry> {
  validateEligibilityAuthorization(unsignedEntry, expected, false);
  u32(expirationLedger, "expiration ledger");
  if (expirationLedger <= expected.latestLedger || expirationLedger > expected.maxExpirationLedger) throw new NativeClaimError("eligibility expiration is outside the approved range", "authorization");
  if (!networkPassphrase) throw new NativeClaimError("network passphrase is required");
  const signed = await authorizeEntry(unsignedEntry, signer, expirationLedger, networkPassphrase);
  validateEligibilityAuthorization(signed, expected);
  return signed;
}

/** Exact local intent and native role scope; does not relax ordinary SDK authorization. */
export function validateNativeTransaction(tx: Transaction, plan: NativeAuthorizationPlan, requireEligibilitySigned = true): void {
  address(plan.source, "account", "claim transaction source");
  if (tx.source !== plan.source) throw new NativeClaimError(`native transaction source ${tx.source} differs from reviewed source ${plan.source}`, "authorization");
  if (tx.operations.length !== 1) throw new NativeClaimError(`native transaction has ${tx.operations.length} operations; exactly one was reviewed`, "authorization");
  if (tx.memo.type !== "none") throw new NativeClaimError(`native transaction memo type ${tx.memo.type} differs from reviewed none`, "authorization");
  if (BigInt(tx.fee) > plan.maxFeeStroops) throw new NativeClaimError(`native transaction network fee ${tx.fee} stroops exceeds the configured maximum ${plan.maxFeeStroops} stroops`, "authorization");
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction" || op.source && op.source !== plan.source || op.func.type !== "hostFunctionTypeInvokeContract")
    throw new NativeClaimError("unexpected native operation", "authorization");
  const call = op.func.invokeContract;
  if (Address.fromScAddress(call.contractAddress).toString() !== plan.contract || call.functionName.toString() !== plan.method || call.args.length !== plan.args.length || call.args.some((arg, i) => arg.toXDR("base64") !== plan.args[i].toXDR("base64")))
    throw new NativeClaimError("native operation differs from the exact reviewed intent", "authorization");
  const entries = op.auth ?? [];
  if (entries.length !== (plan.eligibility ? 2 : 1)) throw new NativeClaimError("unexpected native authorization count", "authorization");
  const sources = entries.filter(entry => entry.credentials.type === "sorobanCredentialsSourceAccount");
  if (sources.length !== 1 || !sameInvocation(sources[0].rootInvocation, plan.sourceInvocation))
    throw new NativeClaimError("holder or owner authorization differs from exact reviewed intent", "authorization");
  if (plan.eligibility) {
    if (plan.eligibility.account === plan.source) throw new NativeClaimError("eligibility account must be separate from claimant", "authorization");
    const separate = entries.filter(entry => entry.credentials.type !== "sorobanCredentialsSourceAccount");
    if (separate.length !== 1) throw new NativeClaimError("unexpected second authorizer", "authorization");
    validateEligibilityAuthorization(separate[0], plan.eligibility, requireEligibilitySigned);
  }
}

export function assertSignedBodyUnchanged(prepared: Transaction, signedXdr: string, passphrase: string): Transaction {
  const signed = TransactionBuilder.fromXDR(signedXdr, passphrase);
  if (!(signed instanceof Transaction) || hex(signed.hash()) !== hex(prepared.hash())) throw new NativeClaimError("wallet changed the reviewed native transaction body", "authorization");
  if (!signed.signatures.length) throw new NativeClaimError("wallet returned an unsigned transaction", "authorization");
  return signed;
}
