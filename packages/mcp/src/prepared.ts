import { Address, Asset, StrKey, Transaction, TransactionBuilder, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

export type ClaimFee = { allocatorId: string; token: string; amount: string; recipient: string; network: string };
const amount = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= (1n << 127n) - 1n;
const address = (value: unknown): value is string => typeof value === "string" && (StrKey.isValidContract(value) || StrKey.isValidEd25519PublicKey(value));

/** Validate against local network/Allocator configuration, never against a server-selected network. */
export function validateClaimFee(value: unknown, allocatorId: string | undefined, passphrase: string): ClaimFee {
  if (!allocatorId || !StrKey.isValidContract(allocatorId)) throw new Error("claim fee requires a locally configured SORAN_ALLOCATOR_ID");
  const v = value as Partial<ClaimFee> | null;
  if (!v || v.allocatorId !== allocatorId || v.network !== passphrase || v.token !== Asset.native().contractId(passphrase) || !amount(v.amount) || !address(v.recipient)) throw new Error("claim fee quote does not match the local Allocator/network or has invalid fee fields");
  return { allocatorId, token: v.token, amount: v.amount, recipient: v.recipient, network: passphrase };
}
export function sameFee(left: ClaimFee, right: ClaimFee): boolean {
  return (Object.keys(left) as Array<keyof ClaimFee>).every((k) => left[k] === right[k]);
}
const bytes = (s: string) => nativeToScVal(new TextEncoder().encode(s), { type: "bytes" });
const equal = (a: xdr.ScVal, b: xdr.ScVal) => a.toXDR("base64") === b.toXDR("base64");
function exactCall(call: xdr.InvokeContractArgs, contractId: string, fn: string, args: xdr.ScVal[]) {
  if (Address.fromScAddress(call.contractAddress).toString() !== contractId || call.functionName.toString() !== fn || call.args.length !== args.length || call.args.some((arg, i) => !equal(arg, args[i]))) throw new Error("prepared authorization differs from the intended contract call");
}

/** The witness proves allocation eligibility to the contract. It cannot change
 * claimant, label, evidence, or fee. Bound its ABI before accepting server data. */
function validateWitness(value: xdr.ScVal) {
  const w: unknown = scValToNative(value);
  const proof = (v: unknown) => Array.isArray(v) && v.length <= 64 && v.every((p) => p instanceof Uint8Array && p.length === 32);
  if (!Array.isArray(w)) throw new Error("invalid allocation witness");
  if (w[0] === "NotReserved" && w.length === 4 && w[1] instanceof Uint8Array && w[1].length <= 63 && w[2] instanceof Uint8Array && w[2].length <= 63 && proof(w[3])) return;
  if (w[0] === "Unbound" && w.length === 2 && proof(w[1])) return;
  if (w[0] === "Lapsed" && w.length === 4 && address(w[1]) && typeof w[2] === "bigint" && w[2] >= 0n && w[2] <= (1n << 64n) - 1n && proof(w[3])) return;
  throw new Error("invalid allocation witness");
}

/** Validate the full SDK17 transaction and claimant authorization before signing.
 * No signature is added by this function. Network fee includes resource fees. */
export function validateClaimTransaction(encoded: string, source: string, label: string, basis: string[], fee: ClaimFee, maxNetworkFeeStroops: string): Transaction {
  if (typeof encoded !== "string" || encoded.length > 131072) throw new Error("invalid prepared transaction size");
  if (!/^[1-9][0-9]*$/.test(maxNetworkFeeStroops) || BigInt(maxNetworkFeeStroops) > 0xffff_ffffn) throw new Error("invalid maximum network fee");
  const tx = TransactionBuilder.fromXDR(encoded, fee.network);
  if (!(tx instanceof Transaction) || tx.source !== source || tx.signatures.length !== 0 || tx.memo.type !== "none" || BigInt(tx.fee) > BigInt(maxNetworkFeeStroops)) throw new Error("prepared transaction has unexpected source, signatures, memo, or network fee");
  if (tx.operations.length !== 1) throw new Error("prepared transaction must contain one operation");
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction" || (op.source !== undefined && op.source !== source) || op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("prepared transaction is not the expected contract invocation");
  const inv = op.func.invokeContract;
  if (inv.args.length !== 4) throw new Error("announce requires four arguments");
  validateWitness(inv.args[3]);
  const args = [bytes(label), new Address(source).toScVal(), xdr.ScVal.scvVec(basis.map(bytes)), inv.args[3]];
  exactCall(inv, fee.allocatorId, "announce", args);
  if (!op.auth || op.auth.length !== 1 || op.auth[0].credentials.type !== "sorobanCredentialsSourceAccount") throw new Error("prepared claim must authorize only this transaction source");
  const root = op.auth[0].rootInvocation;
  if (root.function.type !== "sorobanAuthorizedFunctionTypeContractFn") throw new Error("unexpected authorization root");
  exactCall(root.function.contractFn, fee.allocatorId, "announce", args);
  if (root.subInvocations.length !== 1) throw new Error("claim authorization must contain exactly the selected fee transfer");
  const transfer = root.subInvocations[0];
  if (transfer.function.type !== "sorobanAuthorizedFunctionTypeContractFn" || transfer.subInvocations.length !== 0) throw new Error("unexpected nested claim authorization");
  exactCall(transfer.function.contractFn, fee.token, "transfer", [new Address(source).toScVal(), new Address(fee.allocatorId).toScVal(), nativeToScVal(BigInt(fee.amount), { type: "i128" })]);
  return tx;
}
