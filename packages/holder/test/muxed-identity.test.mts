import assert from "node:assert/strict";
import test from "node:test";
import { Account, Address, Keypair, Networks, Operation, SorobanDataBuilder, StrKey, TransactionBuilder, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { SoranHolder, DEPLOYMENTS, encodeMuxedAddress } from "../src/index.js";
const kp = Keypair.random(), G = kp.publicKey(), OTHER = Keypair.random().publicKey(), LOOKUP = DEPLOYMENTS.testnet.lookupId;
const M = encodeMuxedAddress(G, "18446744073709551615");
const signer = { publicKey: () => G, signTransaction: async () => { throw new Error("must not sign"); } };
function reads(holder: SoranHolder, overrides: Record<string, unknown> = {}) {
  Object.assign(holder, { read: async (id: string, fn: string) => {
    assert.equal(id, LOOKUP);
    const values: Record<string, unknown> = { registry: DEPLOYMENTS.testnet.registryId, version: 2, destination_version: 2, muxed_identity_version: 1, ...overrides };
    assert.ok(Object.hasOwn(values, fn)); const value = values[fn]; if (value instanceof Error) throw value; return value;
  } });
}
test("all four M election methods use Lookup and exact G plus u64", async () => {
  const holder = new SoranHolder({ signer }); reads(holder);
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  Object.assign(holder, { invoke: async (id: string, fn: string, args: xdr.ScVal[]) => { assert.equal(id, LOOKUP); calls.push({ fn, args: args.map(scValToNative) }); return { hash: "h", ledger: 1 }; } });
  for (const id of ["0", "9007199254740993", "18446744073709551615"]) {
    const address = encodeMuxedAddress(G, id);
    await holder.setReverseMuxed("ALICE.NOVA", address); await holder.setPrimaryMuxed("ALICE.NOVA", address);
    await holder.clearReverseMuxed("NOVA", address); await holder.clearPrimaryMuxed(address);
    assert.deepEqual(calls.splice(0), [
      { fn: "set_reverse_muxed", args: [G, BigInt(id), "alice.nova"] },
      { fn: "set_primary_muxed", args: [G, BigInt(id), "alice.nova"] },
      { fn: "clear_reverse_muxed", args: ["nova", G, BigInt(id)] },
      { fn: "clear_primary_muxed", args: [G, BigInt(id)] },
    ]);
  }
});
test("wrong signer, malformed M and unavailable Lookup cannot sign", async () => {
  for (const address of [G, encodeMuxedAddress(OTHER, "1"), M.toLowerCase(), M.slice(0, -1)]) {
    const holder = new SoranHolder({ signer }); Object.assign(holder, { read: async () => assert.fail("must reject before chain reads") });
    await assert.rejects(holder.setReverseMuxed("alice.nova", address));
  }
  for (const overrides of [{ registry: LOOKUP }, { version: 1 }, { destination_version: 1 }, { muxed_identity_version: 0 }, { muxed_identity_version: 1n }, { muxed_identity_version: new Error("offline") }]) {
    const holder = new SoranHolder({ signer }); reads(holder, overrides); Object.assign(holder, { invoke: async () => assert.fail("must not sign") });
    await assert.rejects(holder.setReverseMuxed("alice.nova", M));
  }
  for (const options of [{ lookupId: null }, { registryId: LOOKUP }]) await assert.rejects(new SoranHolder({ signer, ...options }).setReverseMuxed("alice.nova", M), /configured Universal Lookup/);
});
function auth(fn: string, args: xdr.ScVal[], nested = false) {
  const call = new xdr.InvokeContractArgs({ contractAddress: new Address(LOOKUP).toScAddress(), functionName: fn, args });
  const root = new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call), subInvocations: [] });
  if (nested) root.subInvocations = [new xdr.SorobanAuthorizedInvocation({ function: root.function, subInvocations: [] })];
  return new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: root });
}
for (const tamper of ["none", "auth-id", "auth-child", "signed-id", "unsigned", "fee", "restore", "bad-seq"] as const) test("M signing protects exact election: " + tamper, async () => {
  const args = [new Address(G).toScVal(), nativeToScVal(18446744073709551615n, { type: "u64" }), nativeToScVal("alice.nova", { type: "string" })];
  const bad = [args[0], nativeToScVal(0n, { type: "u64" }), args[2]];
  let signatures = 0, submitted = 0;
  const holder = new SoranHolder({ fee: tamper === "fee" ? "50000001" : "100", signer: { publicKey: () => G, signTransaction: async (encoded, { networkPassphrase }) => {
    signatures++;
    let tx = TransactionBuilder.fromXDR(encoded, networkPassphrase) as any;
    if (tamper === "signed-id") tx = TransactionBuilder.cloneFrom(tx, { networkPassphrase }).clearOperations().addOperation(Operation.invokeContractFunction({ contract: LOOKUP, function: "set_reverse_muxed", args: bad, auth: [auth("set_reverse_muxed", bad)] })).build();
    if (tamper !== "unsigned") tx.sign(kp);
    return tx.toXDR();
  } } }); reads(holder);
  Object.assign(holder, { server: {
    getAccount: async () => new Account(G, "0"),
    simulateTransaction: async () => {
      const base = { _parsed: true, transactionData: new SorobanDataBuilder(), minResourceFee: tamper === "fee" ? "50000001" : "0", result: { auth: [auth("set_reverse_muxed", tamper === "auth-id" ? bad : args, tamper === "auth-child")], retval: xdr.ScVal.scvVoid() }, events: [], latestLedger: 1 };
      return tamper === "restore" ? { ...base, restorePreamble: { minResourceFee: "1", transactionData: new SorobanDataBuilder() } } : base;
    },
    sendTransaction: async () => { submitted++; if (tamper === "bad-seq") return { status: "ERROR", errorResult: { toXDR: () => "txBadSeq" } }; return { status: "PENDING" }; },
  }, confirm: async () => ({ ledger: 2, returnValue: null }) });
  if (tamper === "none") { assert.equal((await holder.setReverseMuxed("alice.nova", M)).ledger, 2); assert.equal(signatures, 1); assert.equal(submitted, 1); }
  else { await assert.rejects(holder.setReverseMuxed("alice.nova", M)); assert.equal(submitted, tamper === "bad-seq" ? 1 : 0); assert.equal(signatures, ["signed-id", "unsigned", "bad-seq"].includes(tamper) ? 1 : 0); }
});
