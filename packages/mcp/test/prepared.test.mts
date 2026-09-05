import assert from "node:assert/strict";
import test from "node:test";
import { Account, Address, Asset, Contract, Keypair, Memo, Networks, Operation, StrKey, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { validateClaimFee, validateClaimTransaction, sameFee } from "../src/prepared.js";
const G = Keypair.random().publicKey(), other = Keypair.random().publicKey();
const allocator = StrKey.encodeContract(new Uint8Array(32).fill(4));
const token = Asset.native().contractId(Networks.TESTNET);
const fee = { allocatorId: allocator, token, amount: "10000000", recipient: other, network: Networks.TESTNET };
const bytes = (s: string) => xdr.ScVal.scvBytes(new TextEncoder().encode(s));
const basis = ["dns: acme.example"];
const witness = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("NotReserved"), bytes(""), xdr.ScVal.scvBytes(new Uint8Array([255])), xdr.ScVal.scvVec([])]);
const args = [bytes("acme"), new Address(G).toScVal(), xdr.ScVal.scvVec(basis.map(bytes)), witness];
function call(id: string, fn: string, args: xdr.ScVal[]) { return new xdr.InvokeContractArgs({ contractAddress: new Address(id).toScAddress(), functionName: fn, args }); }
function invocation(c: xdr.InvokeContractArgs, subInvocations: xdr.SorobanAuthorizedInvocation[] = []) { return new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(c), subInvocations }); }
function build(opts: { source?: string; opSource?: string; contract?: string; callArgs?: xdr.ScVal[]; authArgs?: xdr.ScVal[]; sub?: xdr.SorobanAuthorizedInvocation[]; extraAuth?: boolean; memo?: boolean; networkFee?: string; signed?: boolean; extraOp?: boolean; fn?: string; noAuth?: boolean } = {}) {
  const transfer = invocation(call(token, "transfer", [new Address(G).toScVal(), new Address(allocator).toScVal(), nativeToScVal(BigInt(fee.amount), { type: "i128" })]));
  const root = invocation(call(allocator, "announce", opts.authArgs ?? args), opts.sub ?? [transfer]);
  const auth = new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: root });
  const tx = new TransactionBuilder(new Account(opts.source ?? G, "1"), { fee: opts.networkFee ?? "1000", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract: opts.contract ?? allocator, function: opts.fn ?? "announce", args: opts.callArgs ?? args, auth: opts.noAuth ? [] : opts.extraAuth ? [auth, auth] : [auth], source: opts.opSource }));
  if (opts.memo) tx.addMemo(Memo.text("unexpected"));
  if (opts.extraOp) tx.addOperation(new Contract(allocator).call("withdraw", bytes("acme")));
  const built = tx.setTimeout(60).build();
  if (opts.signed) built.sign(Keypair.random());
  return built.toXDR();
}
const check = (encoded: string, limit = "10000") => validateClaimTransaction(encoded, G, "acme", basis, fee, limit);
test("SDK17 prepared fee validator accepts exact source escrow authorization without signing", () => {
  const tx = check(build()); assert.equal(tx.signatures.length, 0); assert.equal(tx.operations.length, 1);
  assert.equal(validateClaimFee(fee, allocator, Networks.TESTNET).amount, fee.amount);
  assert.equal(sameFee(fee, { ...fee }), true);
  assert.equal(sameFee(fee, { ...fee, amount: "1" }), false);
});
test("fee quote rejects unpinned deployments, other assets/networks and malformed amounts", () => {
  assert.throws(() => validateClaimFee(fee, undefined, Networks.TESTNET));
  for (const patch of [{ allocatorId: token }, { token: allocator }, { network: Networks.PUBLIC }, { amount: "0" }, { amount: "01" }, { amount: (1n << 127n).toString() }, { amount: 42 }, { recipient: "Gbad" }]) assert.throws(() => validateClaimFee({ ...fee, ...patch }, allocator, Networks.TESTNET));
});
test("prepared claim rejects wrong source/target/arguments/fees/signatures and extra operations", () => {
  for (const opts of [{ source: other }, { opSource: other }, { contract: token }, { fn: "transfer" }, { extraOp: true }, { signed: true }, { memo: true }, { networkFee: "10001" }, { noAuth: true }, { extraAuth: true }, { callArgs: [bytes("else"), ...args.slice(1)] }, { callArgs: [args[0], new Address(other).toScVal(), ...args.slice(2)] }, { callArgs: [args[0], args[1], xdr.ScVal.scvVec([bytes("different evidence")]), args[3]] }, { authArgs: [bytes("else"), ...args.slice(1)] }]) assert.throws(() => check(build(opts)), JSON.stringify(opts));
  for (const limit of ["0", "01", "-1", "4294967296"]) assert.throws(() => check(build(), limit));
});
test("prepared claim rejects fee auth wrong token/amount/recipient and arbitrary nested calls", () => {
  const feeArgs = [new Address(G).toScVal(), new Address(allocator).toScVal(), nativeToScVal(BigInt(fee.amount), { type: "i128" })];
  const good = invocation(call(token, "transfer", feeArgs));
  for (const sub of [[], [good, good], [invocation(call(allocator, "transfer", feeArgs))], [invocation(call(token, "approve", feeArgs))], [invocation(call(token, "transfer", [feeArgs[0], new Address(other).toScVal(), feeArgs[2]]))], [invocation(call(token, "transfer", [feeArgs[0], feeArgs[1], nativeToScVal(10000001n, { type: "i128" })]))], [invocation(call(token, "transfer", feeArgs), [good])]]) assert.throws(() => check(build({ sub })));
});
test("prepared claim rejects malformed or unbounded allocation witness", () => {
  for (const w of [bytes("bad"), xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other")]), xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Unbound"), xdr.ScVal.scvVec([bytes("short")])])]) assert.throws(() => check(build({ callArgs: [...args.slice(0, 3), w] })));
});
