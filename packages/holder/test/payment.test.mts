import assert from "node:assert/strict";
import test from "node:test";
import { Account, Keypair, StrKey, hash, scValToNative } from "@stellar/stellar-sdk";
import { SoranHolder, HolderError, DEPLOYMENTS, type PaymentMemo } from "../src/index.js";
import { parsePaymentRecord, encodePaymentRecord } from "../src/payment.js";
const G = Keypair.random().publicKey();
const C = StrKey.encodeContract(Buffer.alloc(32, 1));
const REGISTRAR = StrKey.encodeContract(Buffer.alloc(32, 2));
const nsNode = new Uint8Array(hash(Uint8Array.from([...new Uint8Array(32), ...hash(new TextEncoder().encode("nova"))])));
const REGISTRY = DEPLOYMENTS.testnet.registryId;
const signer = { publicKey: () => G, signTransaction: async () => { throw new Error("unexpected signer"); } };
function nativeRead(overrides: Record<string, unknown> = {}) {
  return async (id: string, fn: string) => {
    if (Object.hasOwn(overrides, fn)) {
      const value = overrides[fn];
      if (value instanceof Error) throw value;
      return value;
    }
    if (fn === "resolver_of") { assert.equal(id, REGISTRY); return C; }
    if (fn === "registrar_of") { assert.equal(id, REGISTRY); return REGISTRAR; }
    if (fn === "anchors") { assert.equal(id, REGISTRAR); return [REGISTRY, nsNode]; }
    assert.equal(id, C);
    if (fn === "registry") return REGISTRY;
    if (fn === "authority") return REGISTRAR;
    if (fn === "payment_version") return 1;
    if (fn === "resolve_payment") return { address: G, memo: ["None"] };
    throw new Error(`unexpected ${fn}`);
  };
}
const memos: PaymentMemo[] = [{ type: "none" }, { type: "id", value: "18446744073709551615" }, { type: "text", value: "a|b " }, { type: "hash", value: "ab".repeat(32) }];
for (const memo of memos) test(`setPayment ${memo.type} sends one native Resolver invocation`, async () => {
  const s = new SoranHolder({ signer });
  let count = 0;
  Object.assign(s, {
    read: nativeRead(),
    invoke: async (id: string, fn: string, args: unknown[], errors: Record<number, string>) => {
      count++; assert.equal(id, C); assert.equal(fn, "set_payment");
      const values = args.map((a) => scValToNative(a as never));
      assert.deepEqual(values.slice(0, 3), ["alice.nova", G, G]);
      const expected = memo.type === "none" ? ["None"] : memo.type === "id" ? ["Id", BigInt(memo.value)] : memo.type === "text" ? ["Text", memo.value] : ["Hash", Buffer.from(memo.value, "hex")];
      if (memo.type === "hash") assert.deepEqual(Array.from((values[3] as unknown[])[1] as Uint8Array), Array.from(expected[1] as Uint8Array));
      else assert.deepEqual(values[3], expected);
      assert.equal(errors[18], "UsePaymentMethod"); assert.equal(errors[17], "InvalidMemo");
      return { hash: "hash", ledger: 1, returnValue: null };
    },
  });
  assert.deepEqual(await s.setPayment("ALICE.NOVA", { address: G, memo }), { hash: "hash", ledger: 1 });
  assert.equal(count, 1);
  assert.deepEqual(parsePaymentRecord(encodePaymentRecord({ address: G, memo })), { address: G, memo });
});
test("invalid memo is rejected before discovery", async () => {
  const s = new SoranHolder({ signer });
  Object.assign(s, { read: async () => { throw new Error("must not read"); } });
  await assert.rejects(s.setPayment("alice.nova", { address: G, memo: { type: "id", value: "18446744073709551616" } }), /u64/);
});
test("all address writers reject missing native support and wrong Registry/Registrar wiring", async () => {
  for (const overrides of [{ resolver_of: null }, { registrar_of: null }, { registry: C }, { authority: C }, { anchors: [C, nsNode] }, { anchors: [REGISTRY, new Uint8Array(32)] }, { payment_version: 0 }, { payment_version: 1n }, { payment_version: new Error("old ABI") }, { registry: new Error("archived") }]) {
    const s = new SoranHolder({ signer });
    let invoked = 0;
    Object.assign(s, { read: nativeRead(overrides), invoke: async () => { invoked++; throw new Error("must not invoke"); } });
    for (const run of [() => s.setPayment("alice.nova", { address: G, memo: { type: "none" } }), () => s.setRecord("alice.nova", G), () => s.setAddress("alice.nova", G)])
      await assert.rejects(run());
    assert.equal(invoked, 0);
  }
});
test("native write failure never retries as separate writes", async () => {
  const s = new SoranHolder({ signer });
  const failure = new HolderError("PaymentUnavailable", C, "set_payment", 20, "PaymentUnavailable");
  const calls: string[] = [];
  Object.assign(s, { read: nativeRead(), invoke: async (_id: string, fn: string) => { calls.push(fn); throw failure; } });
  await assert.rejects(s.setPayment("alice.nova", { address: G, memo: { type: "none" } }), (e) => e === failure);
  assert.deepEqual(calls, ["set_payment"]);
});
test("raw payment text edits and clearText cannot bypass native helper", async () => {
  const s = new SoranHolder({ signer });
  await assert.rejects(s.setText("alice.nova", "payment", "bad"), /setPayment/);
  await assert.rejects(s.clearText("alice.nova", "payment"), /setPayment/);
});
test("real invocation pipeline surfaces rejected native write before signing", async () => {
  let signed = 0; let submitted = 0;
  const s = new SoranHolder({ signer: { publicKey: () => G, signTransaction: async () => { signed++; throw new Error("must not sign"); } } });
  Object.assign(s, {
    read: nativeRead(),
    server: {
      getAccount: async () => new Account(G, "0"),
      simulateTransaction: async (tx: { operations: Array<{ func: { invokeContract: { functionName: { toString(): string }; args: unknown[] } } }> }) => {
        assert.equal(tx.operations.length, 1);
        const op = tx.operations[0].func.invokeContract;
        assert.equal(op.functionName.toString(), "set_payment");
        assert.deepEqual(scValToNative(op.args[3] as never), ["Id", 18446744073709551615n]);
        return { error: "Error(Contract, #20)" };
      },
      sendTransaction: async () => { submitted++; throw new Error("must not submit"); },
    },
  });
  await assert.rejects(s.setPayment("alice.nova", { address: G, memo: { type: "id", value: "18446744073709551615" } }),
    (e: unknown) => e instanceof HolderError && e.code === 20 && e.codeName === "PaymentUnavailable");
  assert.equal(signed, 0); assert.equal(submitted, 0);
});
test("setRecord always uses atomic native set_addr, never a client None rewrite", async () => {
  for (const required of [false, true]) {
    const s = new SoranHolder({ signer });
    const writes: string[] = [];
    const failure = new HolderError("UsePaymentMethod", C, "set_addr", 18, "UsePaymentMethod");
    Object.assign(s, {
      read: nativeRead({ resolve_payment: new Error("setRecord must not pre-read payment") }),
      invoke: async (id: string, fn: string, args: unknown[]) => {
        writes.push(fn); assert.equal(id, C); assert.equal(fn, "set_addr");
        assert.deepEqual(args.slice(1).map((v) => scValToNative(v as never)), [G, G]);
        // Model the on-chain state at execution, including a required memo
        // published after discovery but before this invocation.
        if (required) throw failure;
        return { hash: "hash", ledger: 1 };
      },
    });
    if (required) await assert.rejects(s.setRecord("alice.nova", G), (e) => e === failure);
    else assert.equal((await s.setRecord("alice.nova", G)).hash, "hash");
    assert.deepEqual(writes, ["set_addr"]);
  }
});
test("setAddress permits only complete None and keeps Registrar-only semantics", async () => {
  const s = new SoranHolder({ signer });
  const writes: string[] = [];
  Object.assign(s, { read: nativeRead(), invoke: async (id: string, fn: string) => {
    assert.equal(id, REGISTRAR); writes.push(fn); return { hash: "hash", ledger: 1 };
  } });
  await s.setAddress("alice.nova", G);
  assert.deepEqual(writes, ["set_address"]);
  for (const result of [{ address: G, memo: ["Id", 1n] }, null, { address: G, memo: ["None"], extra: true }, new Error("missing configured payment")]) {
    Object.assign(s, { read: nativeRead({ resolve_payment: result }) });
    await assert.rejects(s.setAddress("alice.nova", G));
  }
  assert.deepEqual(writes, ["set_address"]);
});
test("a memo published after setAddress preflight remains intact", async () => {
  const s = new SoranHolder({ signer });
  const destination = Keypair.random().publicKey();
  let payment = { address: G, memo: ["None"] as unknown[] };
  const read = nativeRead();
  Object.assign(s, {
    read: async (id: string, fn: string) => {
      if (fn !== "resolve_payment") return read(id, fn);
      const snapshot = payment;
      payment = { address: G, memo: ["Id", 42n] };
      return snapshot;
    },
    invoke: async (id: string, fn: string, args: unknown[]) => {
      assert.equal(id, REGISTRAR); assert.equal(fn, "set_address");
      assert.equal(scValToNative(args[1] as never), destination);
      return { hash: "hash", ledger: 1 };
    },
  });
  await s.setAddress("alice.nova", destination);
  assert.deepEqual(payment, { address: G, memo: ["Id", 42n] });
});
