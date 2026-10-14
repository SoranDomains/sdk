import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Account, Address, Keypair, Networks, Operation, SorobanDataBuilder, StrKey, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { SoranHolder, claimIntentFromNative, stringifyNativeIntent } from "@sorandomains/holder";
import { legacyBoundSigner } from "../src/legacy-signing.js";
import { registerWriteTools } from "../src/tools.js";

const key = Keypair.random(), C = (n: number) => StrKey.encodeContract(new Uint8Array(32).fill(n));
const registry = C(1), registrar = C(2), resolver = C(3);
const call = (method = "set_text", args = [xdr.ScVal.scvString("reviewed")]) =>
  new xdr.InvokeContractArgs({ contractAddress: new Address(resolver).toScAddress(), functionName: method, args });
const invocation = (selected = call(), children: xdr.SorobanAuthorizedInvocation[] = []) =>
  new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(selected), subInvocations: children });
const entry = (selected = invocation()) => new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: selected });
function envelope(auth = [entry()], selected = call(), count = 1, source = key.publicKey()) {
  const tx = new TransactionBuilder(new Account(source, "1"), { fee: "100", networkPassphrase: Networks.TESTNET });
  for (let i = 0; i < count; i++) tx.addOperation(Operation.invokeContractFunction({
    contract: Address.fromScAddress(selected.contractAddress).toString(), function: selected.functionName.toString(), args: selected.args, auth,
  }));
  return tx.setTimeout(60).build().toXDR();
}

test("native claim handler retains its separately validated payment and initializer authorization", async () => {
  const original = SoranHolder.prototype.claim;
  let signed = false;
  try {
    // The native SDK has its own exact-plan tests. This routing regression checks
    // that its reviewed child calls are not sent through the legacy-only guard.
    SoranHolder.prototype.claim = async function () {
      const selected = call("claim");
      const encoded = envelope([entry(invocation(selected, [invocation(call("transfer")), invocation(call("initialize_destination"))]))], selected);
      const result = await (this as any).signer.signTransaction(encoded, { networkPassphrase: Networks.TESTNET });
      signed = TransactionBuilder.fromXDR(typeof result === "string" ? result : result.signedTxXdr, Networks.TESTNET).signatures.length === 1;
      return {} as any;
    };
    const handlers = new Map<string, (args: any) => Promise<any>>();
    await registerWriteTools({ tool(name: string, _description: string, _schema: any, handler: any) { handlers.set(name, handler); } } as any,
      { secret: key.secret(), requireConfirmation: false });
    const vector = JSON.parse(readFileSync(new URL("../../holder/test/fixtures/native-claim-v1.json", import.meta.url), "utf8"));
    const intent = claimIntentFromNative(scValToNative(xdr.ScVal.fromXDR(vector.claimIntentXdrHex, "hex")));
    const result = await handlers.get("claim_username")!({ intentJson: stringifyNativeIntent(intent) });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(signed, true);
  } finally { SoranHolder.prototype.claim = original; }
});

test("legacy signer rejects child calls, extra roots, changed args and multiple operations before signing", async () => {
  let signed = 0;
  const guarded = legacyBoundSigner({ publicKey: () => key.publicKey(), signTransaction: async encoded => { signed++; return encoded; } });
  const transfer = invocation(call("transfer"));
  for (const encoded of [
    envelope([entry(invocation(call(), [transfer]))]),
    envelope([entry(), entry(transfer)]),
    envelope([entry(invocation(call("set_text", [xdr.ScVal.scvString("unreviewed")]))) ]),
    envelope([entry()], call(), 2),
    envelope([entry()], call(), 1, Keypair.random().publicKey()),
    envelope([]),
    envelope([entry(invocation(call("touch_subname")))], call("touch_subname")),
  ]) await assert.rejects(guarded.signTransaction(encoded, { networkPassphrase: Networks.TESTNET }));
  assert.equal(signed, 0);
  for (const encoded of [envelope(), envelope([], call("touch_subname")), envelope([], call("touch_subname_page"))])
    await guarded.signTransaction(encoded, { networkPassphrase: Networks.TESTNET });
  const restore = new TransactionBuilder(new Account(key.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.restoreFootprint({})).setSorobanData(new SorobanDataBuilder().build()).setTimeout(60).build();
  await guarded.signTransaction(restore.toXDR(), { networkPassphrase: Networks.TESTNET });
  assert.equal(signed, 4);
});

// Exercise the normal installed packages through real MCP handlers and SDK
// simulate/assemble/sign/send. Only the RPC transport is replaced. In particular,
// these are NOT imports of ../../holder/src or temporary links to fixed source.
for (const tool of ["set_profile", "renew_name"] as const) {
  for (const hostile of [false, true]) test(`${tool}: installed SDK ${hostile ? "refuses nested transfer" : "still signs the clean call"}`, async () => {
    const server = rpc.Server.prototype as any;
    const originals = { getAccount: server.getAccount, simulateTransaction: server.simulateTransaction, sendTransaction: server.sendTransaction, getTransaction: server.getTransaction };
    const oldSign = Keypair.prototype.sign;
    let signatures = 0, submitted = 0;
    const ok = (retval: xdr.ScVal, auth: xdr.SorobanAuthorizationEntry[] = []) => ({ _parsed: true, transactionData: new SorobanDataBuilder(), minResourceFee: "1000", result: { retval, auth }, events: [], latestLedger: 100 });
    try {
      Keypair.prototype.sign = function (data) { signatures++; return oldSign.call(this, data); };
      server.getAccount = async (address: string) => new Account(address, "5");
      server.simulateTransaction = async (tx: any) => {
        const selected = tx.operations[0].func.invokeContract, fn = selected.functionName.toString();
        if (fn === "resolver_of") return ok(nativeToScVal(resolver, { type: "address" }));
        if (fn === "registrar_of") return ok(nativeToScVal(registrar, { type: "address" }));
        if (fn === "owner_of") return ok(nativeToScVal(key.publicKey(), { type: "address" }));
        if (fn === "claim_version") return ok(nativeToScVal(0, { type: "u32" }));
        if (fn === "set_text" || fn === "renew") {
          const children = hostile ? [invocation(new xdr.InvokeContractArgs({ contractAddress: new Address(C(4)).toScAddress(), functionName: "transfer", args: [
            nativeToScVal(key.publicKey(), { type: "address" }), nativeToScVal(Keypair.random().publicKey(), { type: "address" }), nativeToScVal(1000n, { type: "i128" })] }))] : [];
          return ok(fn === "renew" ? nativeToScVal(1n, { type: "u64" }) : xdr.ScVal.scvVoid(), [entry(invocation(selected, children))]);
        }
        throw new Error(`Unexpected RPC read: ${fn}`);
      };
      server.sendTransaction = async (tx: any) => { submitted++; return { status: "PENDING", hash: Buffer.from(tx.hash()).toString("hex"), latestLedger: 100 }; };
      server.getTransaction = async () => ({ status: "SUCCESS", ledger: 101, returnValue: tool === "renew_name" ? nativeToScVal(1n, { type: "u64" }) : xdr.ScVal.scvVoid() });
      const handlers = new Map<string, (args: any) => Promise<any>>();
      await registerWriteTools({ tool(name: string, _description: string, _schema: any, handler: any) { handlers.set(name, handler); } } as any,
        { secret: key.secret(), requireConfirmation: false, registryId: registry });
      const result = await handlers.get(tool)!(tool === "set_profile" ? { name: "alice.solo", profile: { org: "Alice" } } : { namespace: "solo", label: "alice", extendSecs: 60 });
      if (hostile) {
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /unexpected nested authorization/);
        assert.equal(signatures, 0); assert.equal(submitted, 0);
      } else {
        assert.equal(result.isError, undefined, result.content[0].text);
        assert.equal(signatures, 1); assert.equal(submitted, 1);
      }
    } finally { Object.assign(server, originals); Keypair.prototype.sign = oldSign; }
  });
}
